import { satisfies } from 'semver';
import type { InstalledPlugin } from './contracts';
import { invariant, ownerOf } from './contracts';

export function computeAvailability(
  packages: InstalledPlugin[],
): InstalledPlugin[] {
  const byKey = new Map(packages.map((p) => [p.key, p]));
  invariant(byKey.size === packages.length, 'DUPLICATE_PLUGIN');
  const visiting = new Set<string>(),
    checked = new Set<string>(),
    reasons = new Map<string, string>();
  function visit(key: string, depth = 0): boolean {
    invariant(depth <= 32, 'DEPENDENCY_DEPTH');
    if (visiting.has(key)) {
      reasons.set(key, 'DEPENDENCY_CYCLE');
      return false;
    }
    if (checked.has(key)) return !reasons.has(key);
    const p = byKey.get(key);
    if (!p?.enabled) return false;
    visiting.add(key);
    for (const [dep, range] of Object.entries(p.manifest.dependencies)) {
      const target = byKey.get(dep);
      if (
        !target ||
        !satisfies(target.manifest.version, range) ||
        !visit(dep, depth + 1)
      )
        reasons.set(key, `DEPENDENCY_BLOCKED: ${dep} ${range}`);
    }
    for (const ref of [
      ...p.agents.flatMap((a) => [...a.tools, ...a.skills]),
      ...p.skills.flatMap((s) => s.allowedTools),
    ]) {
      if (!ref.startsWith('ed25519:') || ownerOf(ref) === key) continue;
      const target = byKey.get(ownerOf(ref));
      const available =
        target?.enabled &&
        !reasons.has(target.key) &&
        satisfies(
          target.manifest.version,
          p.manifest.dependencies[target.key] ??
            p.manifest.optionalDependencies[target.key] ??
            '<0.0.0',
        );
      if (
        !available ||
        ![...target!.tools, ...target!.skills].some((t) => t.ref === ref)
      )
        reasons.set(key, `REFERENCE_BLOCKED: ${ref}`);
    }
    visiting.delete(key);
    checked.add(key);
    return !reasons.has(key);
  }
  for (const p of packages) if (p.enabled) visit(p.key);
  // Optional links can point to plugins visited later; propagate blocked references to fixed point.
  for (let pass = 0; pass < packages.length; pass++) {
    let changed = false;
    for (const p of packages)
      if (p.enabled && !reasons.has(p.key))
        for (const dep of Object.keys(p.manifest.dependencies))
          if (reasons.has(dep)) {
            reasons.set(p.key, `DEPENDENCY_BLOCKED: ${dep}`);
            changed = true;
          }
    if (!changed) break;
  }
  return packages.map((p) => ({ ...p, blocked: reasons.get(p.key) }));
}
