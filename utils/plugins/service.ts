import { gt, lt } from 'semver';
import { verifyPackage } from './package';
import { computeAvailability } from './dependencies';
import { PluginRepository } from './repository';
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
    return {
      generation: state.generation,
      packages: computeAvailability(state.packages),
    };
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
  async install(
    bytes: Uint8Array,
    expected: number,
    approvedDigest: string,
    source?: GithubSource,
    rollback = false,
  ): Promise<PluginSnapshot> {
    const preview = await this.preview(bytes, source, rollback);
    invariant(
      preview.generation === expected &&
        preview.plugin.digest === approvedDigest,
      'STALE_PREVIEW',
    );
    const state = await this.snapshot(),
      old = state.packages.find((p) => p.key === preview.plugin.key);
    if (old?.digest === preview.plugin.digest) {
      if (!old.source && preview.source) {
        const next = await this.repository.commit(
          expected,
          state.packages.map((p) =>
            p.key === old.key ? { ...p, source: preview.source } : p,
          ),
        );
        await this.changed(next);
        return next;
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
    await this.changed(next);
    return next;
  }
  async setEnabled(
    key: string,
    enabled: boolean,
    expected: number,
  ): Promise<PluginSnapshot> {
    const state = await this.snapshot();
    invariant(
      state.packages.some((p) => p.key === key),
      'PLUGIN_NOT_FOUND',
    );
    const packages = computeAvailability(
      state.packages.map((p) =>
        p.key === key ? { ...p, enabled, epoch: p.epoch + 1 } : p,
      ),
    );
    if (enabled)
      invariant(
        !packages.find((p) => p.key === key)?.blocked,
        'DEPENDENCY_BLOCKED',
      );
    const next = await this.repository.commit(expected, packages);
    await this.changed(next);
    return next;
  }
  async uninstall(key: string, expected: number): Promise<PluginSnapshot> {
    const state = await this.snapshot();
    invariant(
      state.packages.some((p) => p.key === key),
      'PLUGIN_NOT_FOUND',
    );
    const next = await this.repository.commit(
      expected,
      computeAvailability(state.packages.filter((p) => p.key !== key)),
      undefined,
      key,
    );
    await this.changed(next);
    return next;
  }
}
