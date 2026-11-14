import { allocateSkillIdentity } from '@/utils/skills/skill-identity';
import { toolRegistry, type ToolExecutionContext } from '@/tools/registry';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import type { AgentConfig } from '@/utils/agents/agent-types';
import { isPluginRef, type PluginSnapshot } from './contracts';
import { assertCatalogConsistent } from './reconcile';
import { isPublicHostTool } from './host-tools';

let numericSkillIds = new Map<string, string>();
let snapshot: PluginSnapshot = { generation: -1, packages: [] };
const listeners = new Set<() => void>();
type Executor = (
  ref: string,
  args: unknown,
  context?: ToolExecutionContext,
) => Promise<ToolResult>;
let execute: Executor = async () =>
  createErrorResponse('PLUGIN_HOST_UNAVAILABLE');
export function setPluginExecutor(executor: Executor): void {
  execute = executor;
}
export function getPluginSnapshot(): PluginSnapshot {
  return structuredClone(snapshot);
}
export function onPluginsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function pluginBindings(): Record<
  string,
  { digest: string; epoch: number }
> {
  return Object.fromEntries(
    snapshot.packages
      .filter((p) => p.enabled && !p.blocked)
      .map((p) => [p.key, { digest: p.digest, epoch: p.epoch }]),
  );
}
function installSnapshot(next: PluginSnapshot, ids: Map<string, string>): void {
  const cloned = structuredClone(next);
  // 先验证再替换注册表：一次坏快照不能留下“工具已替换一半”的中间态。
  assertCatalogConsistent(cloned.packages);
  const tools = cloned.packages
    .filter((p) => p.enabled && !p.blocked)
    .flatMap((p) =>
      p.tools.map((t) => ({
        name: t.ref,
        metadata: {
          name: t.ref,
          displayName: t.id,
          description: t.description,
          category: 'external-plugins',
          version: p.manifest.version,
          requiresApproval: true,
          plugin: {
            key: p.key,
            version: p.manifest.version,
            publisher: p.manifest.publisher.displayName,
            digest: p.digest,
          },
        },
        openaiSchema: {
          type: 'function' as const,
          function: {
            name: t.ref,
            description: t.description,
            parameters: t.inputSchema as any,
          },
        },
        execute: (args: unknown, context?: ToolExecutionContext) =>
          execute(t.ref, args, context),
      })),
    );
  toolRegistry.replaceExternal(tools);
  numericSkillIds = ids;
  snapshot = cloned;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn('[Plugins] Catalog listener failed', error);
    }
  }
}
/** 单调递增的常规应用：旧 generation 的迟到快照直接丢弃 */
let catalogTail: Promise<unknown> = Promise.resolve();
function mutateCatalog(work: () => Promise<void>): Promise<void> { const next = catalogTail.then(work, work); catalogTail = next.catch(() => undefined); return next; }
export async function applyPluginSnapshot(next: PluginSnapshot): Promise<void> {
  return mutateCatalog(async () => {
  if (next.generation < snapshot.generation) return;
  const ids = await allocatePluginSkillIds(next);
  if (next.generation > snapshot.generation) installSnapshot(next, ids);
  await (await import('./managed-skills')).reconcilePluginSkills(next);
  });
}
/**
 * 强制替换（仅启动引导与“宿主 generation 回退”场景使用）。
 * 用户清空扩展数据/重装宿主后，IndexedDB generation 会从 0 重新开始；
 * 页面若继续按单调规则丢弃，会永久停留在旧快照。
 */
export async function replacePluginSnapshot(next: PluginSnapshot): Promise<void> { return mutateCatalog(async () => { installSnapshot(next, await allocatePluginSkillIds(next)); await (await import('./managed-skills')).reconcilePluginSkills(next); }); }
async function allocatePluginSkillIds(next: PluginSnapshot): Promise<Map<string, string>> {
  // Reserve restored local IDs before allocating any new plugin identities.
  await (await import('@/utils/skills/skill-store')).restoreCustomSkillsFromStorage(true);
  const ids = new Map<string, string>();
  for (const pkg of next.packages) for (const skill of pkg.skills) ids.set(skill.ref, await allocateSkillIdentity('plugin:' + skill.ref));
  return ids;
}
export function pluginAgents(): AgentConfig[] {
  return snapshot.packages
    .filter((p) => p.enabled && !p.blocked)
    .flatMap((p) =>
      p.agents.map((a) => ({
        ...a,
        id: a.ref,
        plugin: {
          key: p.key,
          version: p.manifest.version,
          displayName: p.manifest.displayName,
          publisher: p.manifest.publisher.displayName,
        },
        tools: a.tools.map((ref) =>
          ref.startsWith('builtin/') ? ref.slice(8) : ref,
        ),
        skills: a.skills.flatMap(ref => { const id = ref.startsWith('builtin/') ? ref.slice(8) : numericSkillIds.get(ref); return id ? [id] : []; }),
      })),
    );
}
export function pluginAgent(ref: string): AgentConfig | null {
  return isPluginRef(ref)
    ? (pluginAgents().find((a) => a.id === ref) ?? null)
    : null;
}
/** A plugin agent cannot expand its host privileges by loading an unrelated system skill. */
export function pluginToolCeiling(key?: string): string[] | undefined {
  if (!key) return undefined;
  const owner = snapshot.packages.find(
    (p) => p.key === key && p.enabled && !p.blocked,
  );
  if (!owner) return [];
  // 与导入期边界一致：插件智能体只能使用已声明的公开宿主工具 + 本插件工具；
  // 不再把依赖插件的工具并入上限，避免旧状态绕过 1.2 的引用限制。
  return [
    ...owner.manifest.capabilities.hostTools
      .filter(isPublicHostTool)
      .map((ref) => ref.slice('builtin/'.length)),
    ...owner.tools.map((tool) => tool.ref),
  ];
}
