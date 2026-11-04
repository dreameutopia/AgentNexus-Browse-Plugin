import { canonicalize } from 'json-canonicalize';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { satisfies } from 'semver';
import { readArchive } from './archive';
import { strictJson } from './json';
import { checkSchema } from './schema';
import {
  agentSchema,
  LIMITS,
  invariant,
  manifestSchema,
  pluginKey,
  PLUGIN_API_VERSION,
  resolveRef,
  toolSchema,
  validatePluginKey,
  type VerifiedPlugin,
} from './contracts';

export function base32(bytes: Uint8Array): string {
  let bits = 0,
    value = 0,
    out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += 'abcdefghijklmnopqrstuvwxyz234567'[(value >>> (bits -= 5)) & 31];
    }
  }
  if (bits)
    out += 'abcdefghijklmnopqrstuvwxyz234567'[(value << (5 - bits)) & 31];
  return out;
}
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192)
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(out);
}
export function decode64(value: string): Uint8Array {
  invariant(
    /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0,
    'INVALID_BASE64',
  );
  const out = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  invariant(toBase64(out) === value, 'NONCANONICAL_BASE64');
  return out;
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', bytes as BufferSource),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
const integritySchema = z
  .object({
    version: z.literal(1),
    files: z
      .array(
        z
          .object({
            path: z.string(),
            size: z.number().int().nonnegative(),
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
export async function verifyPackage(
  bytes: Uint8Array,
  appVersion: string,
): Promise<VerifiedPlugin> {
  const files = readArchive(bytes);
  const text = (path: string) => {
    const file = files.get(path);
    invariant(file, 'MISSING_FILE', path);
    return new TextDecoder('utf-8', { fatal: true }).decode(file);
  };
  const integrity = integritySchema.parse(strictJson(text('integrity.json'))),
    signature = signatureSchema.parse(strictJson(text('signature.json')));
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
  const manifest = manifestSchema.parse(strictJson(text('plugin.json'))),
    key = pluginKey(manifest);
  invariant(
    manifest.publisher.id === `ed25519:${base32(publicBytes)}`,
    'IDENTITY_MISMATCH',
  );
  invariant(
    satisfies(appVersion, manifest.engines.agentnexus) &&
      satisfies(PLUGIN_API_VERSION, manifest.engines.pluginApi),
    'INCOMPATIBLE_HOST',
  );
  for (const dep of [
    ...Object.keys(manifest.dependencies),
    ...Object.keys(manifest.optionalDependencies),
  ]) {
    validatePluginKey(dep);
    invariant(dep !== key, 'DEPENDENCY_CYCLE');
  }
  const resolve = (ref: string) =>
    resolveRef(ref, key, {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    });
  const renderReferences = (body: string) =>
    body.replace(/\{\{tool:([^}]+)\}\}/g, (_, local: string) => {
      const ref = resolve(local.includes('/') ? local : `./${local}`);
      return ref.startsWith('builtin/') ? ref.slice(8) : ref;
    });
  for (const group of Object.values(manifest.contributes))
    invariant(
      new Set(group.map((x) => x.id)).size === group.length &&
        new Set(group.map((x) => x.path)).size === group.length,
      'DUPLICATE_CONTRIBUTION',
    );
  invariant(
    Object.values(manifest.contributes).some((g) => g.length),
    'EMPTY_PLUGIN',
  );
  const tools = manifest.contributes.tools.map((entry) => {
    const tool = toolSchema.parse(strictJson(text(entry.path)));
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
    return { ...tool, id: entry.id, ref: `${key}/${entry.id}` };
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
    const root = entry.path.slice(0, -'SKILL.md'.length),
      resources = Object.create(null);
    for (const path of files.keys())
      if (path.startsWith(root))
        resources[path.slice(root.length)] = text(path);
    return {
      id: entry.id,
      ref: `${key}/${entry.id}`,
      name: data.name,
      description: data.description,
      body: renderReferences(match[2]),
      files: resources,
      allowedTools: (
        data['allowed-tools']?.split(/\s+/).filter(Boolean) ?? []
      ).map(resolve),
      category: 'general',
      tags: [],
    };
  });
  const agents = manifest.contributes.agents.map((entry) => {
    const agent = agentSchema.parse(strictJson(text(entry.path)));
    return {
      ...agent,
      system: renderReferences(agent.system),
      id: entry.id,
      ref: `${key}/${entry.id}`,
      tools: agent.tools.map(resolve),
      skills: agent.skills.map(resolve),
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
