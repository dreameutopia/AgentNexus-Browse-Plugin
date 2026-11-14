import { gt, lt } from 'semver';
import { verifyPackage } from './package';
import { computeAvailability } from './dependencies';
import { assertCatalogConsistent } from './reconcile';
import { PluginRepository, type PluginState } from './repository';
import {
  invariant,
  type GithubSource,
  type InstalledPlugin,
  type PluginPreview,
  type PluginSnapshot,
} from './contracts';

export class PluginService {
  constructor(
    readonly repository: PluginRepository,
    readonly appVersion: string,
    private readonly changed: (
      snapshot: PluginSnapshot,
    ) => Promise<void> = async () => {},
  ) {}
  async snapshot(): Promise<PluginSnapshot> {
    const state = await this.repository.read();
    let packages: InstalledPlugin[];
    try {
      packages = computeAvailability(state.packages);
    } catch (error) {
      // 依赖图重算失败时返回“全部隔离”的只读视图，保证管理页仍能打开并
      // 卸载问题插件；下一次启动对账会修复持久状态。
      const detail = `CATALOG_CORRUPT: ${
        error instanceof Error ? error.message : String(error)
      }`;
      packages = state.packages.map((plugin) => ({
        ...plugin,
        quarantined: plugin.quarantined ?? detail,
        blocked: detail,
      }));
    }
    return { generation: state.generation, packages };
  }
  /**
   * 提交后广播：仓库只持久化“事实”，blocked 必须在这里重新派生，
   * 否则依赖被禁用的插件会在本次变更里被错误注册为可用。
   */
  private async publish(state: PluginState): Promise<PluginSnapshot> {
    let packages: InstalledPlugin[];
    try {
      packages = computeAvailability(state.packages);
    } catch (error) {
      // 已经提交的状态不能因为派生计算失败被报成“操作失败”；返回隔离视图，
      // 让管理页仍可诊断/卸载，下一次启动对账会修复持久状态。
      const detail = `CATALOG_CORRUPT: ${
        error instanceof Error ? error.message : String(error)
      }`;
      packages = state.packages.map((plugin) => ({
        ...plugin,
        quarantined: plugin.quarantined ?? detail,
        blocked: detail,
      }));
    }
    const snapshot = { generation: state.generation, packages };
    await this.changed(snapshot);
    return snapshot;
  }
  async preview(
    bytes: Uint8Array,
    source?: GithubSource,
    rollback = false,
  ): Promise<PluginPreview> {
    const plugin = await verifyPackage(bytes, this.appVersion),
      state = await this.snapshot(),
      previous = state.packages.find((p) => p.key === plugin.key);
    const known = await this.repository.release(
      plugin.key,
      plugin.manifest.version,
    );
    invariant(
      !known || known.digest === plugin.digest,
      'VERSION_CONTENT_CONFLICT',
    );
    if (previous) {
      invariant(
        previous.manifest.version !== plugin.manifest.version ||
          previous.digest === plugin.digest,
        'VERSION_CONTENT_CONFLICT',
      );
      invariant(
        !lt(plugin.manifest.version, previous.manifest.version) ||
          (rollback && known?.digest === plugin.digest),
        'DOWNGRADE_REJECTED',
      );
      invariant(
        !source ||
          !previous.source ||
          source.repositoryId === previous.source.repositoryId,
        'SOURCE_CHANGE_REJECTED',
      );
    }
    const changes = previous
      ? [`${previous.manifest.version} → ${plugin.manifest.version}`]
      : ['New plugin'];
    if (previous && gt(plugin.manifest.version, previous.manifest.version))
      changes.push(
        'Review all changed tool contracts and permissions before updating.',
      );
    changes.push(
      ...plugin.manifest.capabilities.network.map((x) => `Network: ${x}`),
      ...plugin.manifest.capabilities.hostTools.map((x) => `System tool: ${x}`),
    );
    return {
      plugin,
      previousVersion: previous?.manifest.version,
      generation: state.generation,
      source: previous?.source ?? source,
      changes,
    };
  }
  /** 先验包再安装（内部/测试入口）；后台已持有预览时直接走 installPreviewed。 */
  async install(
    bytes: Uint8Array,
    expected: number,
    approvedDigest: string,
    source?: GithubSource,
    rollback = false,
  ): Promise<PluginSnapshot> {
    return this.installPreviewed(
      await this.preview(bytes, source, rollback),
      bytes,
      expected,
      approvedDigest,
    );
  }
  /**
   * 使用已验签的预览落库，避免同一份包在一次安装里被重复 SHA-256 + 验签。
   *
   * `expected` 与 `approvedDigest` 来自用户确认的预览；这里再次比对，保证
   * 预览与待落库字节没有在调用链中被替换。
   */
  async installPreviewed(
    preview: PluginPreview,
    bytes: Uint8Array,
    expected: number,
    approvedDigest: string,
  ): Promise<PluginSnapshot> {
    invariant(
      preview.generation === expected &&
        preview.plugin.digest === approvedDigest,
      'STALE_PREVIEW',
    );
    const state = await this.snapshot(),
      old = state.packages.find((p) => p.key === preview.plugin.key);
    // 同摘要幂等短路只适用于健康安装；隔离中的同包需要走完整安装流程，
    // 以便补写 release 归档并清除 quarantined，否则永远无法自愈。
    if (old?.digest === preview.plugin.digest && !old.quarantined) {
      if (!old.source && preview.source) {
        const next = await this.repository.commit(
          expected,
          state.packages.map((p) =>
            p.key === old.key ? { ...p, source: preview.source } : p,
          ),
        );
        return this.publish(next);
      }
      return state;
    }
    const item: InstalledPlugin = {
      ...preview.plugin,
      enabled: old?.enabled ?? true,
      epoch: (old?.epoch ?? Date.now()) + 1,
      installedAt: Date.now(),
      source: preview.source,
    };
    const packages = computeAvailability([
      ...state.packages.filter((p) => p.key !== item.key),
      item,
    ]);
    // 提交前验证目录结构，避免落库后应用快照才暴露重复 ref/key。
    assertCatalogConsistent(packages);
    invariant(
      !packages.find((p) => p.key === item.key)?.blocked,
      'DEPENDENCY_BLOCKED',
    );
    for (const p of state.packages)
      if (p.enabled && !p.blocked)
        invariant(
          !packages.find((x) => x.key === p.key)?.blocked,
          'BREAKS_DEPENDENT',
          p.key,
        );
    const next = await this.repository.commit(expected, packages, {
      id: `${item.key}@${item.manifest.version}`,
      key: item.key,
      version: item.manifest.version,
      digest: item.digest,
      bytes,
    });
    return this.publish(next);
  }
  async setEnabled(
    key: string,
    enabled: boolean,
    expected: number,
  ): Promise<PluginSnapshot> {
    const state = await this.snapshot();
    const target = state.packages.find((p) => p.key === key);
    invariant(target, 'PLUGIN_NOT_FOUND');
    if (enabled)
      invariant(
        !target.quarantined,
        'PLUGIN_QUARANTINED',
        `${key}: ${target.quarantined}`,
      );
    const packages = computeAvailability(
      state.packages.map((p) =>
        p.key === key ? { ...p, enabled, epoch: p.epoch + 1 } : p,
      ),
    );
    assertCatalogConsistent(packages);
    if (enabled)
      invariant(
        !packages.find((p) => p.key === key)?.blocked,
        'DEPENDENCY_BLOCKED',
      );
    const next = await this.repository.commit(expected, packages);
    return this.publish(next);
  }
  async uninstall(key: string, expected: number): Promise<PluginSnapshot> {
    const state = await this.snapshot();
    invariant(
      state.packages.some((p) => p.key === key),
      'PLUGIN_NOT_FOUND',
    );
    const packages = computeAvailability(
      state.packages.filter((p) => p.key !== key),
    );
    assertCatalogConsistent(packages);
    const next = await this.repository.commit(
      expected,
      packages,
      undefined,
      key,
    );
    return this.publish(next);
  }
}
