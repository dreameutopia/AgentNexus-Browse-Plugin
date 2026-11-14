/**
 * 插件目录对账（启动与提交前校验）
 *
 * 背景：IndexedDB 是权威源，但它可能被旧版本写入、被外部工具篡改、或在宿主
 * 升级后变得不兼容。任何一条坏记录都不应该让整个插件系统（甚至对话装配）
 * 失效。本模块把“单包可信性”与“依赖图可用性”分开：
 *
 *   - reconcilePackages：启动时逐包复核，不信任的记录标记 quarantined 并保留
 *     记录（可诊断、可卸载），其余插件照常进入目录；
 *   - assertCatalogConsistent：提交快照前验证结构性不变量，保证后台应用目录
 *     时不会因为重复 key/ref 抛错。
 *
 * 纯函数、零 I/O，便于在后台、测试和 CLI 中复用。
 */
import { satisfies } from 'semver';
import {
  canonicalContributionPath,
  invariant,
  persistedPackages,
  pluginKey,
  validatePluginKey,
  type InstalledPlugin,
} from './contracts';
import { computeAvailability } from './dependencies';
import { isPublicHostTool } from './host-tools';
import { codeOfReason } from './operations';

export interface ReconcileIssue {
  key: string;
  code: string;
  detail: string;
}

export interface ReconcileResult {
  packages: InstalledPlugin[];
  issues: ReconcileIssue[];
  changed: boolean;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `https://host` 形式的源，用于引用/执行地址匹配 */
function networkOriginOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function isNetworkOrigin(value: unknown): boolean {
  return typeof value === 'string' && networkOriginOf(value) === value;
}

/** 单包结构性校验：身份、引擎兼容、能力声明、贡献 ref 归属与全类型唯一 */
function packageProblems(
  plugin: InstalledPlugin,
  appVersion: string,
  pluginApiVersion: string,
): string[] {
  const problems: string[] = [];
  try {
    validatePluginKey(plugin.key);
  } catch {
    problems.push(`CATALOG_CORRUPT: invalid plugin key "${plugin.key}"`);
  }
  const manifest = plugin.manifest as any;
  try {
    if (pluginKey(plugin.manifest) !== plugin.key)
      problems.push(
        `CATALOG_CORRUPT: manifest identity ${pluginKey(plugin.manifest)} does not match ${plugin.key}`,
      );
  } catch {
    problems.push('CATALOG_CORRUPT: unreadable manifest identity');
  }
  if (!/^[a-f0-9]{64}$/.test(plugin.digest ?? ''))
    problems.push('CATALOG_CORRUPT: missing or invalid release digest');
  if (
    typeof plugin.enabled !== 'boolean' ||
    !Number.isSafeInteger(plugin.epoch) ||
    plugin.epoch < 0 ||
    !Number.isFinite(plugin.installedAt)
  )
    problems.push('CATALOG_CORRUPT: invalid installed runtime flags');
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    typeof manifest.id !== 'string' ||
    typeof manifest.displayName !== 'string' ||
    typeof manifest.version !== 'string' ||
    !manifest.dependencies ||
    typeof manifest.dependencies !== 'object' ||
    !manifest.capabilities ||
    typeof manifest.capabilities !== 'object' ||
    !manifest.engines ||
    typeof manifest.engines !== 'object'
  ) {
    problems.push('CATALOG_CORRUPT: incomplete manifest record');
    return problems;
  }
  try {
    if (
      !satisfies(appVersion, manifest.engines.agentnexus) ||
      !satisfies(pluginApiVersion, manifest.engines.pluginApi)
    )
      problems.push(
        `INCOMPATIBLE_HOST: host ${appVersion} / pluginApi ${pluginApiVersion} outside "${manifest.engines.agentnexus}" / "${manifest.engines.pluginApi}"`,
      );
  } catch {
    problems.push('INCOMPATIBLE_HOST: invalid engine range');
  }

  // —— 能力声明：篡改后的记录同样必须满足验包期的边界 ——
  const capabilities = manifest.capabilities as any,
    hostTools: string[] = Array.isArray(capabilities.hostTools)
      ? capabilities.hostTools
      : [],
    network: string[] = Array.isArray(capabilities.network)
      ? capabilities.network
      : [],
    secretSlots: string[] = Array.isArray(capabilities.secretSlots)
      ? capabilities.secretSlots
      : [];
  if (!Array.isArray(capabilities.hostTools))
    problems.push('CATALOG_CORRUPT: capabilities.hostTools is not an array');
  else
    for (const ref of hostTools)
      if (!isPublicHostTool(ref))
        problems.push(`HOST_TOOL_NOT_PUBLIC: ${String(ref)}`);
  if (!Array.isArray(capabilities.network))
    problems.push('CATALOG_CORRUPT: capabilities.network is not an array');
  else
    for (const origin of network)
      if (!isNetworkOrigin(origin))
        problems.push(`UNDECLARED_NETWORK: ${String(origin)}`);
  if (!Array.isArray(capabilities.secretSlots))
    problems.push('CATALOG_CORRUPT: capabilities.secretSlots is not an array');

  const contributes = manifest.contributes as any;
  for (const group of ['tools', 'skills', 'agents'] as const)
    if (!Array.isArray(contributes?.[group]))
      problems.push(`CATALOG_CORRUPT: contributes.${group} is not an array`);
  const declaredIds = new Map<string, string>();
  for (const group of ['tools', 'skills', 'agents'] as const)
    if (Array.isArray(contributes?.[group]))
      for (const entry of contributes[group])
        if (entry && typeof entry.id === 'string')
          declaredIds.set(`${plugin.key}/${entry.id}`, `${group}/${entry.id}`);

  const refs = new Map<string, string>(),
    toolRefs = new Set<string>(),
    skillRefs = new Set<string>();
  const groups: Array<
    [
      'tools' | 'skills' | 'agents',
      string,
      Array<any> | undefined,
    ]
  > = [
    ['tools', 'tool', plugin.tools],
    ['skills', 'skill', plugin.skills],
    ['agents', 'agent', plugin.agents],
  ];
  for (const [group, kind, items] of groups) {
    if (!Array.isArray(items)) {
      problems.push(`CATALOG_CORRUPT: ${kind} list is not an array`);
      continue;
    }
    for (const item of items) {
      // 早期 1.2 记录可能没有把 path 复制进贡献对象，回退到 manifest 声明。
      const declared = contributes?.[group];
      const declaredPath = Array.isArray(declared)
        ? declared.find((entry: any) => entry && entry.id === item?.id)?.path
        : undefined;
      const path = item?.path ?? declaredPath;
      const label = typeof item?.id === 'string' ? item.id : '<missing>';
      if (
        typeof item?.id !== 'string' ||
        path !== canonicalContributionPath(group, item.id)
      ) {
        problems.push(
          `INVALID_LAYOUT: ${kind} "${label}" is not at ${canonicalContributionPath(group, label)}`,
        );
        continue;
      }
      const ref: unknown = item.ref;
      if (typeof ref !== 'string' || ref !== `${plugin.key}/${item.id}`) {
        problems.push(
          `CATALOG_CORRUPT: ${kind} ref "${String(ref)}" is not owned by ${plugin.key}`,
        );
        continue;
      }
      const previous = refs.get(ref);
      if (previous)
        problems.push(
          `CATALOG_CORRUPT: duplicate ref "${ref}" (${previous}/${kind})`,
        );
      else refs.set(ref, kind);

      if (group === 'tools') {
        toolRefs.add(ref);
        if (typeof item.description !== 'string' || !item.description)
          problems.push(`CATALOG_CORRUPT: ${kind} "${label}" has no description`);
        if (
          !item.inputSchema ||
          typeof item.inputSchema !== 'object' ||
          Array.isArray(item.inputSchema)
        )
          problems.push(`CATALOG_CORRUPT: ${kind} "${label}" has no inputSchema`);
        const executor = item.executor;
        if (!executor || typeof executor !== 'object')
          problems.push(`CATALOG_CORRUPT: ${kind} "${label}" has no executor`);
        else if (executor.type === 'host-alias') {
          if (!isPublicHostTool(executor.target))
            problems.push(`HOST_TOOL_NOT_PUBLIC: ${String(executor.target)}`);
        } else if (executor.type === 'mcp') {
          const origin = networkOriginOf(executor.url);
          if (!origin)
            problems.push(`UNDECLARED_NETWORK: ${String(executor.url)}`);
          else if (!network.includes(origin))
            problems.push(`UNDECLARED_NETWORK: ${origin}`);
          if (
            executor.secretSlot !== undefined &&
            !secretSlots.includes(executor.secretSlot)
          )
            problems.push(`UNDECLARED_SECRET: ${String(executor.secretSlot)}`);
        } else
          problems.push(`INVALID_EXECUTOR: ${kind} "${label}"`);
      } else if (group === 'skills') {
        skillRefs.add(ref);
        if (
          typeof item.name !== 'string' ||
          !item.name ||
          typeof item.description !== 'string' ||
          !item.description ||
          typeof item.body !== 'string'
        )
          problems.push(`CATALOG_CORRUPT: ${kind} "${label}" is incomplete`);
        if (!Array.isArray(item.allowedTools))
          problems.push(
            `CATALOG_CORRUPT: ${kind} "${label}" allowedTools is not an array`,
          );
      } else if (
        typeof item.name !== 'string' ||
        !item.name ||
        typeof item.system !== 'string' ||
        !item.system ||
        !Array.isArray(item.tools) ||
        !Array.isArray(item.skills)
      )
        problems.push(`CATALOG_CORRUPT: ${kind} "${label}" is incomplete`);
    }
  }

  // manifest 声明了但快照里没有的贡献 = 记录被截断；不能静默少注册能力。
  for (const [ref, label] of declaredIds)
    if (!refs.has(ref))
      problems.push(
        `CATALOG_CORRUPT: declared ${label} is missing from the installed snapshot`,
      );

  // —— 引用边界：篡改记录不能指向其他插件、未声明宿主工具或不存在的贡献 ——
  const checkRefs = (
    values: unknown,
    kind: 'tool' | 'skill',
    owner: Set<string>,
  ): void => {
    if (!Array.isArray(values)) return;
    for (const ref of values) {
      if (typeof ref !== 'string') {
        problems.push(`CATALOG_CORRUPT: non-string ${kind} reference`);
        continue;
      }
      if (ref.startsWith('builtin/')) {
        if (!isPublicHostTool(ref) || !hostTools.includes(ref))
          problems.push(`UNDECLARED_HOST_TOOL: ${ref}`);
        continue;
      }
      if (!ref.startsWith(`${plugin.key}/`)) {
        problems.push(`CROSS_PLUGIN_REFERENCE: ${ref}`);
        continue;
      }
      if (!owner.has(ref))
        problems.push(
          `MISSING_${kind === 'tool' ? 'TOOL' : 'SKILL'}_REFERENCE: ${ref}`,
        );
    }
  };
  for (const skill of plugin.skills ?? []) checkRefs(skill.allowedTools, 'tool', toolRefs);
  for (const agent of plugin.agents ?? []) {
    checkRefs(agent.tools, 'tool', toolRefs);
    checkRefs(agent.skills, 'skill', skillRefs);
  }
  return problems;
}

/**
 * 启动对账：去重 → 逐包复核 → 计算依赖可用性。
 *
 * 不抛错：任何异常都收敛为 quarantined 原因，保证调用方一定拿到一份可应用的
 * 快照。返回的 issues 只包含“本次新出现或原因变化”的隔离项，避免每次启动
 * 重复刷日志。
 */
export function reconcilePackages(
  packages: InstalledPlugin[],
  appVersion: string,
  pluginApiVersion: string,
): ReconcileResult {
  const issues: ReconcileIssue[] = [];
  const seen = new Set<string>();
  const unique: InstalledPlugin[] = [];

  for (const raw of Array.isArray(packages) ? packages : []) {
    if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string') {
      issues.push({
        key: '*',
        code: 'CATALOG_CORRUPT',
        detail: 'Skipped a non-object plugin record',
      });
      continue;
    }
    if (seen.has(raw.key)) {
      issues.push({
        key: raw.key,
        code: 'DUPLICATE_PLUGIN',
        detail: `Duplicate installed record for ${raw.key}; kept the first one`,
      });
      continue;
    }
    seen.add(raw.key);
    unique.push({ ...raw });
  }

  for (const plugin of unique) {
    const problems = packageProblems(plugin, appVersion, pluginApiVersion);
    const reason = problems.join('; ');
    if (reason) {
      if (plugin.quarantined !== reason) {
        issues.push({
          key: plugin.key,
          code: codeOfReason(problems[0]),
          detail: reason,
        });
      }
      plugin.quarantined = reason;
    } else if (
      plugin.quarantined &&
      // 归档缺失由 host 的 release 复核负责解除（归档可能被备份恢复补回），
      // 这里先保留原因，避免每次启动都“清除 → 重新隔离”造成日志噪声。
      !plugin.quarantined.startsWith('RELEASE_MISSING:')
    ) {
      // 宿主升级或备份恢复后重新满足条件：自动解除隔离。
      delete plugin.quarantined;
    }
  }

  let next: InstalledPlugin[];
  try {
    next = computeAvailability(unique);
  } catch (error) {
    const detail = `CATALOG_CORRUPT: ${safeMessage(error)}`;
    issues.push({ key: '*', code: 'CATALOG_CORRUPT', detail });
    next = unique.map((plugin) => ({
      ...plugin,
      quarantined: plugin.quarantined ?? detail,
      blocked: detail,
    }));
  }

  return {
    packages: next,
    issues,
    // blocked 是派生值，不参与持久化差异比较；否则每次启动都会多提交一次。
    changed:
      JSON.stringify(persistedPackages(next)) !==
      JSON.stringify(persistedPackages(packages)),
  };
}

/**
 * 提交前结构性断言：重复 pluginKey 或重复全限定 ref 会让目录应用失败。
 *
 * 必须在 repository.commit 之前调用——安装已经持久化后再失败会造成
 * “UI 报错但状态已生效”的不一致。
 */
export function assertCatalogConsistent(packages: InstalledPlugin[]): void {
  const keys = new Set<string>();
  const refs = new Map<string, string>();
  for (const plugin of packages) {
    // 已隔离的安装不贡献任何工具/技能/智能体；它的结构问题不应阻止其余目录
    // 应用，也不应阻止用户在管理页卸载它。
    if (plugin.quarantined) continue;
    invariant(
      typeof plugin?.key === 'string' && !keys.has(plugin.key),
      'CATALOG_CONFLICT',
      `duplicate plugin key "${plugin?.key}"`,
    );
    keys.add(plugin.key);
    const groups: Array<[string, Array<{ id: string; ref: string }> | undefined]> =
      [
        ['tool', plugin.tools],
        ['skill', plugin.skills],
        ['agent', plugin.agents],
      ];
    for (const [kind, items] of groups) {
      for (const item of items ?? []) {
        invariant(
          item && typeof item.id === 'string',
          'CATALOG_CONFLICT',
          `invalid ${kind} contribution in ${plugin.key}`,
        );
        const ref = `${plugin.key}/${item.id}`;
        invariant(
          item.ref === ref,
          'CATALOG_CONFLICT',
          `${kind} ref "${item.ref}" is not owned by ${plugin.key}`,
        );
        invariant(
          !refs.has(ref),
          'CATALOG_CONFLICT',
          `duplicate ref "${ref}" (${refs.get(ref)}/${kind})`,
        );
        refs.set(ref, kind);
      }
    }
  }
}
