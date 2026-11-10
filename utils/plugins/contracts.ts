import { z } from 'zod';
import { valid, validRange } from 'semver';

export const PLUGIN_PROTOCOL = 'agentnexus.plugins.v1';
export const PLUGIN_API_VERSION = '1.0.0';
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
  constructor(
    public readonly code: string,
    detail = code,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'PluginError';
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
        network: z.array(z.string().url().max(512)).max(20).default([]),
        hostTools: z.array(ref).max(100).default([]),
        secretSlots: z.array(slug).max(10).default([]),
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
    optionalDependencies: z.record(range).default({}),
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
export const agentSchema = z
  .object({
    name: z.string().min(1).max(32),
    description: z.string().max(1024).default(''),
    system: z.string().min(1).max(20_000),
    tools: z.array(ref).max(200),
    skills: z.array(ref).max(20).default([]),
    category: z.string().max(24).default('general'),
    tags: z.array(z.string().max(16)).max(8).default([]),
  })
  .strict();
export type PluginManifest = z.infer<typeof manifestSchema>;
export type PluginTool = z.infer<typeof toolSchema> & {
  id: string;
  ref: string;
};
export interface PluginSkill {
  id: string;
  ref: string;
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
  blocked?: string;
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
export function resolveRef(
  value: string,
  key: string,
  dependencies: Record<string, string>,
): string {
  if (value.startsWith('./')) {
    invariant(
      slug.safeParse(value.slice(2)).success ||
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.slice(2)),
      'INVALID_REF',
    );
    return `${key}/${value.slice(2)}`;
  }
  if (/^builtin\/[a-zA-Z0-9_-]+$/.test(value)) return value;
  const owner = ownerOf(value);
  validatePluginKey(owner);
  invariant(
    value.split('/').length === 3 &&
      value.length <= 256 &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.split('/')[2]),
    'INVALID_REF',
    value,
  );
  invariant(
    owner === key || Object.hasOwn(dependencies, owner),
    'UNDECLARED_DEPENDENCY',
    owner,
  );
  return value;
}
