import { canonicalize } from 'json-canonicalize';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { satisfies } from 'semver';
import { readArchive, safePath } from './archive';
import { strictJson } from './json';
import { checkSchema } from './schema';
import { base32, decode64, sha256, toBase64 } from './codec';
import { isPublicHostTool } from './host-tools';
import { decodeSkillText, encodeSkillBytes, isSkillResourcePath, validateSkillBinaries } from '../skills/skill-resources';
import {
  agentSchema,
  canonicalContributionPath,
  LIMITS,
  PluginError,
  invariant,
  manifestSchema,
  pluginKey,
  PLUGIN_API_VERSION,
  resolveRef,
  toolSchema,
  validatePluginKey,
  type PluginManifest,
  type VerifiedPlugin,
} from './contracts';

const integritySchema = z
  .object({
    version: z.literal(1),
    files: z
      .array(
        z
          .object({
            path: z
              .string()
              .min(1)
              .max(240)
              .refine((value) => {
                try {
                  safePath(value);
                  return true;
                } catch {
                  return false;
                }
              }, 'Unsafe archive path'),
            size: z.number().int().nonnegative().max(LIMITS.file),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
const signatureSchema = z
  .object({
    algorithm: z.literal('Ed25519'),
    publicKey: z.string().max(64),
    signature: z.string().max(128),
  })
  .strict();
const encoder = new TextEncoder();
/** 把 Zod 的原始 issues 收敛成稳定的错误码 + 带字段路径的 detail */
function parseOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  code: string,
  label: string,
): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new PluginError(
      code,
      `${label}: ${result.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  return result.data;
}
/** 规范包布局允许出现的根文件 */
const ROOT_FILES = new Set([
  'plugin.json',
  'integrity.json',
  'signature.json',
  'README.md',
  'LICENSE',
  'LICENSE.md',
]);
/**
 * 强制规范布局（Plugin API 1.2）：
 *
 *   plugin.json / integrity.json / signature.json / README.md / LICENSE
 *   assets/**
 *   tools/<tool-id>.json
 *   skills/<skill-id>/SKILL.md + 资源文件
 *   agents/<agent-id>.json
 *
 * 同时承担“全类型贡献 ID 唯一”校验：tools/skills/agents 共享同一个 ref 命名
 * 空间，任一 local ID 重复都会让引用、权限上限和日志无法区分，故整包拒绝。
 */
export function validatePackageLayout(
  files: Map<string, Uint8Array>,
  manifest: PluginManifest,
): void {
  const declared = new Set<string>();
  const owners = new Map<string, string>();
  for (const kind of ['tools', 'skills', 'agents'] as const) {
    for (const entry of manifest.contributes[kind]) {
      const expected = canonicalContributionPath(kind, entry.id);
      invariant(
        entry.path === expected,
        'INVALID_LAYOUT',
        `${kind}/${entry.id}: expected "${expected}", received "${entry.path}"`,
      );
      const previous = owners.get(entry.id);
      invariant(
        !previous,
        'DUPLICATE_CONTRIBUTION',
        `${previous}/${entry.id} and ${kind}/${entry.id} share local id "${entry.id}"`,
      );
      owners.set(entry.id, kind);
      declared.add(expected);
    }
  }
  const skillRoots = manifest.contributes.skills.map(
    (entry) => `skills/${entry.id}/`,
  );
  for (const path of files.keys()) {
    if (ROOT_FILES.has(path) || declared.has(path)) continue;
    if (path.startsWith('assets/')) continue;
    if (path.startsWith('skills/')) {
      invariant(
        skillRoots.some((root) => path.startsWith(root)),
        'UNEXPECTED_PACKAGE_FILE',
        `${path} is not inside a declared skill directory`,
      );
      continue;
    }
    throw new PluginError(
      'UNEXPECTED_PACKAGE_FILE',
      `${path} is outside the canonical tools/, skills/, agents/, assets/ layout`,
    );
  }
}
export async function verifyPackage(
  bytes: Uint8Array,
  appVersion: string,
): Promise<VerifiedPlugin> {
  const files = readArchive(bytes);
  const text = (path: string) => {
    const file = files.get(path);
    invariant(file, 'MISSING_FILE', path);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(file);
    } catch {
      throw new PluginError('INVALID_UTF8', path);
    }
  };
  const integrity = parseOrThrow(
      integritySchema,
      strictJson(text('integrity.json')),
      'INVALID_INTEGRITY',
      'integrity.json',
    ),
    signature = parseOrThrow(
      signatureSchema,
      strictJson(text('signature.json')),
      'INVALID_SIGNATURE',
      'signature.json',
    );
  const paths = integrity.files.map((f) => f.path);
  invariant(
    new Set(paths).size === paths.length &&
      paths.join('\n') === [...paths].sort().join('\n'),
    'INVALID_INTEGRITY',
  );
  invariant(
    files.size === paths.length + 2 &&
      !paths.includes('signature.json') &&
      !paths.includes('integrity.json'),
    'UNLISTED_FILE',
  );
  for (const entry of integrity.files) {
    const data = files.get(entry.path);
    invariant(
      data &&
        data.length === entry.size &&
        (await sha256(data)) === entry.sha256,
      'INTEGRITY_MISMATCH',
      entry.path,
    );
  }
  const publicBytes = decode64(signature.publicKey),
    signed = decode64(signature.signature);
  invariant(
    publicBytes.length === 32 && signed.length === 64,
    'INVALID_SIGNATURE',
  );
  const publicKey = await crypto.subtle.importKey(
    'raw',
    publicBytes as BufferSource,
    'Ed25519',
    false,
    ['verify'],
  );
  invariant(
    await crypto.subtle.verify(
      'Ed25519',
      publicKey,
      signed as BufferSource,
      encoder.encode('AgentNexusPlugin/v1\n' + canonicalize(integrity)),
    ),
    'INVALID_SIGNATURE',
  );
  const manifest = parseOrThrow(
      manifestSchema,
      strictJson(text('plugin.json')),
      'MANIFEST_INVALID',
      'plugin.json',
    ),
    key = pluginKey(manifest);
  invariant(
    manifest.publisher.id === `ed25519:${base32(publicBytes)}`,
    'IDENTITY_MISMATCH',
  );
  // 声明的宿主工具必须在公开白名单内；否则插件可通过持久化数据把内部工具
  // 并入智能体工具上限（启动对账会复用同一判断）。
  for (const ref of manifest.capabilities.hostTools)
    invariant(isPublicHostTool(ref), 'HOST_TOOL_NOT_PUBLIC', ref);
  invariant(
    satisfies(appVersion, manifest.engines.agentnexus) &&
      satisfies(PLUGIN_API_VERSION, manifest.engines.pluginApi),
    'INCOMPATIBLE_HOST',
    `host ${appVersion} not in "${manifest.engines.agentnexus}" or pluginApi ${PLUGIN_API_VERSION} not in "${manifest.engines.pluginApi}"`,
  );
  validatePackageLayout(files, manifest);
  for (const dep of Object.keys(manifest.dependencies)) {
    validatePluginKey(dep);
    invariant(dep !== key, 'DEPENDENCY_CYCLE');
  }
  /**
   * 插件智能体的引用边界（按产品要求收紧）：
   *   - 工具：builtin/<公开宿主工具> 或本插件 ./<tool-id>；
   *   - Skill：只能是本插件 ./<skill-id>（不引用系统 Skill，也不跨插件）；
   *   - Skill 的 allowed-tools 与智能体工具同一边界，避免 Skill 成为跨插件扩权通道。
   * 跨插件完整 ref 一律拒绝，即使 manifest 声明了 dependencies。
   */
  const resolveOwnOrBuiltin = (value: string, kind: string): string => {
    if (value.startsWith('builtin/')) return resolveRef(value, key);
    invariant(
      value.startsWith('./'),
      'CROSS_PLUGIN_REFERENCE',
      `${kind}: "${value}" — use ./<local-id> or builtin/<host-tool>`,
    );
    return resolveRef(value, key);
  };
  const resolveOwnSkill = (value: string): string => {
    invariant(
      value.startsWith('./'),
      'CROSS_PLUGIN_REFERENCE',
      `skills: "${value}" — plugin agents may only reference skills in this plugin`,
    );
    return resolveRef(value, key);
  };
  const referencedTools = new Set<string>();
  const renderReferences = (body: string): string =>
    body.replace(/\{\{tool:([^}]+)\}\}/g, (_, local: string) => {
      invariant(
        local.startsWith('builtin/') || !local.includes('/'),
        'CROSS_PLUGIN_REFERENCE',
        `{{tool:${local}}} — use a local tool name or builtin/<host-tool>`,
      );
      const ref = resolveRef(
        local.startsWith('builtin/') ? local : `./${local}`,
        key,
      );
      referencedTools.add(ref);
      return ref.startsWith('builtin/') ? ref.slice(8) : ref;
    });
  invariant(
    Object.values(manifest.contributes).some((g) => g.length),
    'EMPTY_PLUGIN',
  );
  const tools = manifest.contributes.tools.map((entry) => {
    const tool = parseOrThrow(
      toolSchema,
      strictJson(text(entry.path)),
      'MANIFEST_INVALID',
      entry.path,
    );
    checkSchema(tool.inputSchema);
    if (tool.outputSchema) checkSchema(tool.outputSchema);
    if (tool.executor.type === 'host-alias')
      invariant(
        manifest.capabilities.hostTools.includes(tool.executor.target) &&
          /^builtin\/[a-zA-Z0-9_-]+$/.test(tool.executor.target),
        'UNDECLARED_HOST_TOOL',
      );
    else {
      const url = new URL(tool.executor.url);
      invariant(
        url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.hash &&
          manifest.capabilities.network.includes(url.origin),
        'UNDECLARED_NETWORK',
      );
      invariant(
        !tool.executor.secretSlot ||
          manifest.capabilities.secretSlots.includes(tool.executor.secretSlot),
        'UNDECLARED_SECRET',
      );
    }
    return {
      ...tool,
      id: entry.id,
      ref: `${key}/${entry.id}`,
      path: entry.path,
    };
  });
  const skills = manifest.contributes.skills.map((entry) => {
    const raw = text(entry.path).replace(/\r\n/g, '\n'),
      match = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(raw);
    invariant(
      match && entry.path.endsWith(`/${entry.id}/SKILL.md`),
      'INVALID_SKILL',
      entry.path,
    );
    const document = parseDocument(match[1], {
      uniqueKeys: true,
      maxAliasCount: 0,
    } as any);
    invariant(!document.errors.length, 'INVALID_FRONTMATTER');
    const data = document.toJS({ maxAliasCount: 0 });
    invariant(
      data &&
        data.name === entry.id &&
        typeof data.description === 'string' &&
        data.description.length > 0 &&
        data.description.length <= 1024 &&
        match[2].trim(),
      'INVALID_SKILL',
    );
    invariant(
      data['allowed-tools'] === undefined ||
        typeof data['allowed-tools'] === 'string',
      'INVALID_SKILL_TOOLS',
    );
    const root = entry.path.slice(0, -'SKILL.md'.length);
    const resources: Record<string, string> = Object.create(null);
    const binaries: Record<string, string> = Object.create(null);
    let resourceTotal = 0;
    for (const [path, bytes] of files) {
      // SKILL.md 本身是入口正文，不重复计入资源清单
      if (path === entry.path || !path.startsWith(root)) continue;
      const relative = path.slice(root.length);
      invariant(isSkillResourcePath(relative), 'INVALID_SKILL_RESOURCE', path);
      resourceTotal += bytes.length;
      invariant(
        resourceTotal * 4 <= LIMITS.snapshot * 3,
        'SKILL_RESOURCE_LIMIT',
        entry.path,
      );
      const content = decodeSkillText(bytes);
      if (content === undefined) binaries[relative] = encodeSkillBytes(bytes);
      else resources[relative] = content;
    }
    return {
      id: entry.id,
      ref: `${key}/${entry.id}`,
      path: entry.path,
      name: data.name,
      description: data.description,
      body: renderReferences(match[2]),
      files: resources,
      ...(Object.keys(binaries).length ? { resourceBytes: validateSkillBinaries(binaries, resources) } : {}),
      allowedTools: (
        data['allowed-tools']?.split(/\s+/).filter(Boolean) ?? []
      ).map((ref: string) => resolveOwnOrBuiltin(ref, 'skill.allowed-tools')),
      category: 'general',
      tags: [],
    };
  });
  const agents = manifest.contributes.agents.map((entry) => {
    const agent = parseOrThrow(
      agentSchema,
      strictJson(text(entry.path)),
      'MANIFEST_INVALID',
      entry.path,
    );
    return {
      ...agent,
      system: renderReferences(agent.system),
      id: entry.id,
      ref: `${key}/${entry.id}`,
      path: entry.path,
      tools: agent.tools.map((ref) => resolveOwnOrBuiltin(ref, 'agent.tools')),
      skills: agent.skills.map(resolveOwnSkill),
    };
  });
  for (const ref of [
    ...skills.flatMap((s) => s.allowedTools),
    ...agents.flatMap((a) => a.tools),
  ])
    if (ref.startsWith('builtin/'))
      invariant(
        manifest.capabilities.hostTools.includes(ref),
        'UNDECLARED_HOST_TOOL',
        ref,
      );
  for (const ref of [
    ...skills.flatMap((s) => s.allowedTools),
    ...agents.flatMap((a) => a.tools),
  ])
    if (ref.startsWith(`${key}/`))
      invariant(
        tools.some((t) => t.ref === ref),
        'MISSING_TOOL_REFERENCE',
        ref,
      );
  for (const ref of agents.flatMap((a) => a.skills))
    if (ref.startsWith(`${key}/`))
      invariant(
        skills.some((s) => s.ref === ref),
        'MISSING_SKILL_REFERENCE',
        ref,
      );
  // 提示词里的 {{tool:...}} 同样必须是已声明能力或本插件工具——模板引用不能
  // 绕过 allowed-tools / tools 的同一套边界。
  for (const ref of referencedTools) {
    if (ref.startsWith('builtin/'))
      invariant(
        manifest.capabilities.hostTools.includes(ref),
        'UNDECLARED_HOST_TOOL',
        `prompt reference ${ref}`,
      );
    else
      invariant(
        tools.some((tool) => tool.ref === ref),
        'MISSING_TOOL_REFERENCE',
        `prompt reference ${ref}`,
      );
  }
  const verified = {
    key,
    digest: await sha256(bytes),
    manifest,
    tools,
    skills,
    agents,
  };
  invariant(
    new TextEncoder().encode(JSON.stringify(verified)).length <=
      LIMITS.snapshot,
    'CATALOG_SIZE_LIMIT',
  );
  return verified;
}
