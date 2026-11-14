import { satisfies } from 'semver';
import { invariant, type InstalledPlugin } from './contracts';

/** 依赖链深度上限：超过后标记 blocked，而不是让整个目录重算失败 */
const MAX_DEPENDENCY_DEPTH = 32;

function versionSatisfies(version: string, range: string): boolean {
  try {
    return satisfies(version, range);
  } catch {
    return false;
  }
}

/**
 * 计算插件可用性（纯函数）。
 *
 * 1.2 的引用边界已在验包期限定为「本插件 + builtin」，因此这里只需要处理
 * 插件声明依赖（manifest.dependencies）：
 *   - 缺失、版本不满足、被禁用或自身被隔离的依赖 → 依赖者 blocked；
 *   - 环与过深链路标记为稳定原因，不抛错；
 *   - `blocked` 始终是派生值，`quarantined` 永远不会被它覆盖。
 */
export function computeAvailability(
  packages: InstalledPlugin[],
): InstalledPlugin[] {
  const byKey = new Map(packages.map((p) => [p.key, p]));
  invariant(byKey.size === packages.length, 'DUPLICATE_PLUGIN');
  const visiting = new Set<string>(),
    checked = new Set<string>(),
    reasons = new Map<string, string>();
  function visit(key: string, depth = 0): boolean {
    if (depth > MAX_DEPENDENCY_DEPTH) {
      reasons.set(key, `DEPENDENCY_DEPTH: exceeds ${MAX_DEPENDENCY_DEPTH}`);
      return false;
    }
    if (visiting.has(key)) {
      reasons.set(key, 'DEPENDENCY_CYCLE');
      return false;
    }
    if (checked.has(key)) return !reasons.has(key);
    const plugin = byKey.get(key);
    if (!plugin) return false;
    // 启动对账隔离：安装本身不可信，不能因为依赖者声明了它就被当作可用。
    if (plugin.quarantined) {
      reasons.set(key, plugin.quarantined);
      return false;
    }
    if (!plugin.enabled) return false;
    visiting.add(key);
    for (const [dep, range] of Object.entries(plugin.manifest.dependencies)) {
      const target = byKey.get(dep);
      if (
        !target ||
        !versionSatisfies(target.manifest.version, range) ||
        !visit(dep, depth + 1)
      )
        // 环/深度原因更精确，优先保留
        if (!reasons.has(key))
          reasons.set(key, `DEPENDENCY_BLOCKED: ${dep} ${range}`);
    }
    visiting.delete(key);
    checked.add(key);
    return !reasons.has(key);
  }
  for (const plugin of packages) if (plugin.enabled) visit(plugin.key);
  return packages.map((plugin) => ({
    ...plugin,
    blocked: plugin.quarantined ?? reasons.get(plugin.key),
  }));
}
