import { z } from 'zod';
import { valid, validRange } from 'semver';

export const PLUGIN_PROTOCOL = 'agentnexus.plugins.v1';
/**
 * 宿主公共插件 API 版本。
 *
 * 1.2.0：强制规范包布局（tools/、skills/、agents/）、全类型贡献 ID 唯一、
 * 智能体仅可引用 builtin 与本插件资源。旧布局包会在导入/更新时被明确拒绝，
 * 不会以“兼容”名义进入目录。
 */
export const PLUGIN_API_VERSION = '1.2.0';

/** 规范贡献入口路径（Plugin API 1.2），导入与启动对账共用同一口径 */
export const canonicalContributionPath = (
  kind: 'tools' | 'skills' | 'agents',
  id: string,
): string =>
  kind === 'skills' ? `skills/${id}/SKILL.md` : `${kind}/${id}.json`;
export const LIMITS = Object.freeze({
  archive: 10 * 1024 ** 2,
  expanded: 30 * 1024 ** 2,
  file: 5 * 1024 ** 2,
  files: 500,
  depth: 12,
  result: 1024 ** 2,
  args: 128 * 1024,
  snapshot: 24 * 1024 ** 2,
  backup: 32 * 1024 ** 2,
});
export class PluginError extends Error {
  /** 可读的精准原因（操作日志与 UI 诊断直接使用，不再从 message 反解析） */
  public readonly detail: string;
  constructor(
    public readonly code: string,
    detail = code,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'PluginError';
    this.detail = detail;
  }
}
export function invariant(
  value: unknown,
  code: string,
  detail?: string,
): asserts value {
  if (!value) throw new PluginError(code, detail);
}
const slug = z
  .string()
  .max(48)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
export const publisherPattern = /^ed25519:[a-z2-7]{52}$/;
const text = z.string().min(1).max(1024);
const ref = z.string().min(1).max(256);
const range = z
  .string()
  .max(64)
  .refine(
    (v) => !!validRange(v) && v !== '*',
    'Explicit version range required',
  );
export const versionSchema = z
  .string()
  .max(64)
  .refine(
    (v) => !!valid(v) && !v.includes('+'),
    'Use SemVer without build metadata',
  );
/** 网络能力必须声明为 https 源（origin），导入期与执行期才能做精确比对 */
const networkOrigin = z
  .string()
  .max(512)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.origin === value
      );
    } catch {
      return false;
    }
  }, 'Use an https origin without path, credentials, query or hash');
const uniqueList = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z
    .array(item)
    .max(max)
    .refine(
      (items) => new Set(items as unknown[]).size === items.length,
      'Duplicate entries are not allowed',
    );
const entry = z.object({ id: slug, path: z.string().min(1).max(240) }).strict();
export const manifestSchema = z
  .object({
    $schema: z.string().max(256).optional(),
    manifestVersion: z.literal(1),
    publisher: z
      .object({
        id: z.string().regex(publisherPattern),
        displayName: z.string().min(1).max(64),
      })
      .strict(),
    id: slug,
    displayName: z.string().min(1).max(64),
    description: text.optional(),
    version: versionSchema,
    engines: z.object({ agentnexus: range, pluginApi: range }).strict(),
    license: z.string().max(128),
    repository: z.string().url().max(512).optional(),
    capabilities: z
      .object({
        network: uniqueList(networkOrigin, 20).default([]),
        hostTools: uniqueList(ref, 100).default([]),
        secretSlots: uniqueList(slug, 10).default([]),
      })
      .strict(),
    contributes: z
      .object({
        tools: z.array(entry).max(100).default([]),
        skills: z
          .array(
            entry.extend({
              id: z
                .string()
                .max(64)
                .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
            }),
          )
          .max(50)
          .default([]),
        agents: z.array(entry).max(50).default([]),
      })
      .strict(),
    dependencies: z.record(range).default({}),
  })
  .strict();
export const toolSchema = z
  .object({
    description: text,
    inputSchema: z.record(z.unknown()),
    outputSchema: z.record(z.unknown()).optional(),
    executor: z.discriminatedUnion('type', [
      z.object({ type: z.literal('host-alias'), target: ref }).strict(),
      z
        .object({
          type: z.literal('mcp'),
          url: z.string().url().max(512),
          remoteName: z.string().min(1).max(128),
          secretSlot: slug.optional(),
        })
        .strict(),
    ]),
  })
  .strict();
/**
 * 插件智能体头像：只接受 emoji 或远端/data 图片。
 * 不接受扩展内相对路径——插件包内的 assets 不会成为宿主可解析的页面资源，
 * 允许它会让配置看起来合法、实际渲染成空白。
 */
const avatarSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('image'),
      src: z
        .string()
        .min(1)
        .max(1_500_000)
        .refine(
          (value) =>
            value.startsWith('https://') || value.startsWith('data:image/'),
          'Avatar image must be an https: or data:image URL',
        ),
    })
    .strict(),
  z.object({ type: z.literal('emoji'), value: z.string().min(1).max(16) }).strict(),
]);
export const agentSchema = z
  .object({
    name: z.string().min(1).max(32),
    description: z.string().max(1024).default(''),
    system: z.string().min(1).max(20_000),
    tools: z.array(ref).max(200),
    skills: z.array(ref).max(20).default([]),
    category: z.string().max(24).default('general'),
    tags: z.array(z.string().max(16)).max(8).default([]),
    avatar: avatarSchema.optional(),
    capabilities: z
      .object({
        richComponents: z
          .array(z.string().max(40).regex(/^[a-z][a-z0-9-]*$/))
          .max(16)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PluginManifest = z.infer<typeof manifestSchema>;
export type PluginTool = z.infer<typeof toolSchema> & {
  id: string;
  ref: string;
  /** 包内规范入口路径，用于启动对账复核 1.2 布局 */
  path: string;
};
export interface PluginSkill {
  id: string;
  ref: string;
  path: string;
  name: string;
  description: string;
  body: string;
  files: Record<string, string>;
  resourceBytes?: Record<string, string>;
  allowedTools: string[];
  category: string;
  tags: string[];
}
export type PluginAgent = z.infer<typeof agentSchema> & {
  id: string;
  ref: string;
  /** 包内规范入口路径，用于启动对账复核 1.2 布局 */
  path: string;
};
export interface VerifiedPlugin {
  key: string;
  digest: string;
  manifest: PluginManifest;
  tools: PluginTool[];
  skills: PluginSkill[];
  agents: PluginAgent[];
}
export interface GithubSource {
  repositoryId: number;
  owner: string;
  repo: string;
}
export interface InstalledPlugin extends VerifiedPlugin {
  enabled: boolean;
  epoch: number;
  installedAt: number;
  source?: GithubSource;
  /** 运行时阻塞原因（依赖缺失、引用失效等，由目录可用性计算派生） */
  blocked?: string;
  /**
   * 启动对账隔离原因（宿主不兼容、快照损坏、安装包缺失等）。
   * 与 blocked 分开持久化：blocked 每次由依赖图重算，quarantined 是“这份安装
   * 本身不可信”的持久结论，重算不能把它覆盖掉。quarantined 的插件不注册任何
   * 工具/Skill/智能体，但保留记录供用户诊断和卸载。
   */
  quarantined?: string;
}
/**
 * 持久化视图：`blocked` 是依赖图每次重算的派生值，不写入 IndexedDB，
 * 避免陈旧状态与“同一次启动因派生字段不同而重复提交”。
 */
export function persistedPackages(
  packages: InstalledPlugin[],
): InstalledPlugin[] {
  return packages.map((plugin) => {
    const copy = { ...plugin };
    delete copy.blocked;
    return copy;
  });
}
export interface PluginSnapshot {
  generation: number;
  packages: InstalledPlugin[];
}
export interface PluginPreview {
  plugin: VerifiedPlugin;
  previousVersion?: string;
  generation: number;
  source?: GithubSource;
  changes: string[];
}
export const pluginKey = (m: PluginManifest) => `${m.publisher.id}/${m.id}`;
export function isPluginRef(value: string): boolean {
  return value.startsWith('ed25519:');
}
export function ownerOf(ref: string): string {
  return ref.split('/').slice(0, 2).join('/');
}
export function validatePluginKey(key: string): void {
  const parts = key.split('/');
  invariant(
    parts.length === 2 &&
      publisherPattern.test(parts[0]) &&
      slug.safeParse(parts[1]).success,
    'INVALID_ID',
    key,
  );
}
/**
 * 解析插件内引用。Plugin API 1.2 只允许两种形态：
 *   - `./<local-id>`：本插件的工具/技能/智能体；
 *   - `builtin/<host-tool>`：显式公开的宿主工具。
 * 跨插件引用在验包期即被拒绝，因此这里不再接受带依赖声明的完整 ref。
 */
export function resolveRef(value: string, key: string): string {
  if (value.startsWith('./')) {
    const local = value.slice(2);
    invariant(
      slug.safeParse(local).success ||
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(local),
      'INVALID_REF',
      value,
    );
    return `${key}/${local}`;
  }
  invariant(
    /^builtin\/[a-z][a-z0-9_]*$/.test(value),
    'INVALID_REF',
    `${value} — use ./<local-id> or builtin/<host-tool>`,
  );
  return value;
}
