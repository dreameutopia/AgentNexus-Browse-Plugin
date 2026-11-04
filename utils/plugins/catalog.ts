import { toolRegistry, type ToolExecutionContext } from '@/tools/registry';
import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import type { AgentConfig } from '@/utils/agents/agent-types';
import type { SkillRecord } from '@/utils/skills/skill-types';
import { isPluginRef, type PluginSnapshot } from './contracts';

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
export function applyPluginSnapshot(next: PluginSnapshot): void {
  if (next.generation <= snapshot.generation) return;
  const cloned = structuredClone(next);
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
  snapshot = cloned;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn('[Plugins] Catalog listener failed', error);
    }
  }
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
        skills: a.skills.map((ref) =>
          ref.startsWith('builtin/') ? ref.slice(8) : ref,
        ),
      })),
    );
}
export function pluginSkills(): SkillRecord[] {
  return snapshot.packages.flatMap((p) =>
    p.skills.map((s) => ({
      ...s,
      id: s.ref,
      source: 'plugin' as const,
      plugin: {
        key: p.key,
        version: p.manifest.version,
        displayName: p.manifest.displayName,
        publisher: p.manifest.publisher.displayName,
      },
      enabled: p.enabled && !p.blocked,
      updatedAt: p.installedAt,
      allowedTools: s.allowedTools.map((ref) =>
        ref.startsWith('builtin/') ? ref.slice(8) : ref,
      ),
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
  const dependencies = new Set([
    key,
    ...Object.keys(owner.manifest.dependencies),
    ...Object.keys(owner.manifest.optionalDependencies),
  ]);
  return [
    ...owner.manifest.capabilities.hostTools.map((ref) =>
      ref.slice('builtin/'.length),
    ),
    ...snapshot.packages
      .filter((p) => p.enabled && !p.blocked && dependencies.has(p.key))
      .flatMap((p) => p.tools.map((t) => t.ref)),
  ];
}
