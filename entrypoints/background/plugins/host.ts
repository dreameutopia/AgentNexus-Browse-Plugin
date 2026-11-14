import { z } from 'zod';
import { PluginService } from '@/utils/plugins/service';
import { PluginRepository } from '@/utils/plugins/repository';
import {
  applyPluginSnapshot,
  getPluginSnapshot,
  replacePluginSnapshot,
  setPluginExecutor,
} from '@/utils/plugins/catalog';
import { decode64, toBase64 } from '@/utils/plugins/codec';
import { verifyPackage } from '@/utils/plugins/package';
import {
  PLUGIN_API_VERSION,
  PLUGIN_PROTOCOL,
  invariant,
  isPluginRef,
  LIMITS,
  persistedPackages,
  PluginError,
  type InstalledPlugin,
  type PluginPreview,
  type PluginSnapshot,
} from '@/utils/plugins/contracts';
import { computeAvailability } from '@/utils/plugins/dependencies';
import {
  reconcilePackages,
  assertCatalogConsistent,
  type ReconcileIssue,
} from '@/utils/plugins/reconcile';
import {
  describeOperationError,
  stageOf,
  type PluginOperationAction,
  type PluginOperationRecord,
  type PluginOperationSource,
} from '@/utils/plugins/operations';
import {
  downloadCandidate,
  fetchCatalog,
  githubRelease,
  searchGithub,
} from '@/utils/plugins/github';
import { PluginExecutionGateway } from './execution';

const requestSchema = z
  .object({
    type: z.literal(PLUGIN_PROTOCOL),
    operation: z.string().max(32),
    payload: z.unknown(),
  })
  .strict();
const mutation = z
  .object({
    key: z.string().max(256),
    generation: z.number().int().nonnegative(),
  })
  .strict();
const secretKey = (key: string, slot: string) => `plugin-secret:${key}/${slot}`;

interface RollbackEntry {
  generation: number;
  dump: Awaited<ReturnType<PluginRepository['dump']>>;
}
interface HostRuntime {
  repository: PluginRepository;
  service: PluginService;
  gateway: PluginExecutionGateway;
  rollbacks: Map<string, RollbackEntry>;
  changed(snapshot: PluginSnapshot): Promise<void>;
}
interface OperationMeta {
  action: PluginOperationAction;
  pluginKey?: string;
  pluginName?: string;
  fromVersion?: string;
  toVersion?: string;
  source?: PluginOperationSource;
  digest?: string;
  note?: string;
}

let runtime: HostRuntime | undefined;
let initialization: Promise<void> | undefined;
let ready = false;

/**
 * 启动插件宿主。
 *
 * 关键约束：监听器同步注册；引导失败不永久缓存——下一次请求会重新尝试。
 * 这样 IndexedDB 暂时不可用、worker 被回收、或某个坏包导致目录应用失败时，
 * 插件管理页仍然可以打开并卸载问题插件，而不是整个插件系统一起失效。
 */
export function initPluginHost(): Promise<void> {
  const host = getRuntime();
  if (ready) return Promise.resolve();
  return (initialization ??= bootstrapHost(host).catch((error) => {
    initialization = undefined;
    throw error;
  }));
}

function getRuntime(): HostRuntime {
  if (runtime) return runtime;
  const repository = new PluginRepository();
  // 先声明运行时容器，changed 闭包在异步回调中通过它访问最新 gateway；
  // 所有字段在注册监听器前完成赋值。
  const host = {} as HostRuntime;
  const changed = async (snapshot: PluginSnapshot) => {
    try {
      await applyPluginSnapshot(snapshot);
      host.gateway.reconcile(snapshot);
    } catch (error) {
      // 目录应用失败不能反向把已经提交的安装报成失败；留下精确日志，管理页
      // 仍可基于权威快照执行卸载/回滚。
      const described = describeOperationError(error);
      await appendOperations(repository, [
        {
          id: crypto.randomUUID(),
          at: Date.now(),
          action: 'startup',
          status: 'failure',
          stage: 'apply',
          errorCode: described.code,
          errorDetail: boundedDetail(
            `${described.detail} (generation ${snapshot.generation})`,
          ),
          durationMs: 0,
          generationBefore: getPluginSnapshot().generation,
          generationAfter: snapshot.generation,
        },
      ]);
      // 仍然广播：页面刷新可能从同样的权威快照恢复；若不广播，页面会一直
      // 停留在旧 generation，直到用户手动重开。
    }
    // Notification is a hint; clients re-read the committed authoritative generation.
    await chrome.runtime
      .sendMessage({
        type: `${PLUGIN_PROTOCOL}.changed`,
        generation: snapshot.generation,
      })
      .catch(() => undefined);
  };
  const service = new PluginService(repository, __APP_VERSION__, changed);
  const gateway = new PluginExecutionGateway(
    service,
    async (key, slot) =>
      (await chrome.storage.local.get(secretKey(key, slot)))[
        secretKey(key, slot)
      ],
  );
  setPluginExecutor((ref, args, context) =>
    gateway.execute(ref, args, context),
  );
  Object.assign(host, {
    repository,
    service,
    gateway,
    rollbacks: new Map(),
    changed,
  });
  runtime = host;
  registerMessageListener(host);
  return host;
}

/** 启动对账：逐包复核 → 隔离坏包 → 原子应用目录，任何单包问题都不阻断其余插件 */
async function bootstrapHost(host: HostRuntime): Promise<void> {
  const state = await host.repository.read();
  const reconciled = reconcilePackages(
    state.packages,
    __APP_VERSION__,
    PLUGIN_API_VERSION,
  );
  const issues: ReconcileIssue[] = [...reconciled.issues];

  // 安装记录存在但归档丢失：无法保证可执行，也不能假装工具可用。
  for (const plugin of reconciled.packages) {
    if (plugin.quarantined) continue;
    const release = await host.repository.release(
      plugin.key,
      plugin.manifest.version,
    );
    if (!release || release.digest !== plugin.digest) {
      const reason = `RELEASE_MISSING: ${plugin.key}@${plugin.manifest.version}`;
      if (plugin.quarantined !== reason)
        issues.push({
          key: plugin.key,
          code: 'RELEASE_MISSING',
          detail: reason,
        });
      plugin.quarantined = reason;
    } else if (plugin.quarantined?.startsWith('RELEASE_MISSING:')) {
      // 归档通过备份恢复/自愈补齐：解除隔离并记录一次恢复事件。
      delete plugin.quarantined;
      issues.push({
        key: plugin.key,
        code: 'RELEASE_RESTORED',
        detail: `${plugin.key}@${plugin.manifest.version}`,
      });
    }
  }

  let packages: InstalledPlugin[];
  try {
    packages = computeAvailability(reconciled.packages);
  } catch (error) {
    const detail = `CATALOG_CORRUPT: ${
      error instanceof Error ? error.message : String(error)
    }`;
    issues.push({ key: '*', code: 'CATALOG_CORRUPT', detail });
    // 依赖图重算本身失败时，必须隔离而不是只标 blocked——否则下一次
    // service.snapshot() 会再次抛错，把整个插件系统锁死。
    packages = reconciled.packages.map((plugin) => ({
      ...plugin,
      quarantined: plugin.quarantined ?? detail,
    }));
  }

  let generation = state.generation;
  if (
    JSON.stringify(persistedPackages(packages)) !==
    JSON.stringify(state.packages)
  )
    generation = (await host.repository.commit(state.generation, packages))
      .generation;

  let snapshot: PluginSnapshot = { generation, packages };
  try {
    replacePluginSnapshot(snapshot);
    host.gateway.reconcile(snapshot);
  } catch (error) {
    const described = describeOperationError(error);
    issues.push({
      key: '*',
      code: described.code,
      detail: `catalog apply failed: ${described.detail}`,
    });
    const quarantined = packages.map((plugin) => ({
      ...plugin,
      quarantined: `CATALOG_APPLY_FAILED: ${described.detail}`,
    }));
    generation = (
      await host.repository.commit(generation, quarantined)
    ).generation;
    snapshot = { generation, packages: quarantined };
    try {
      replacePluginSnapshot(snapshot);
      host.gateway.reconcile(snapshot);
    } catch (second) {
      // 管理页仍需可用；工具暂时不注册，日志里有完整原因。
      console.error('[Plugins] Catalog still unavailable after quarantine', second);
    }
  }

  ready = true;
  // 只记录本次新出现/原因变化的隔离项；持续隔离由插件的 blocked 状态展示，
  // 避免每次 worker 启动都重复刷日志。
  if (issues.length)
    await logStartupIssues(host, issues, state.generation, snapshot.generation);
}

async function logStartupIssues(
  host: HostRuntime,
  issues: ReconcileIssue[],
  generationBefore: number,
  generationAfter: number,
): Promise<void> {
  const records: PluginOperationRecord[] = issues
    .slice(0, 100)
    .map((issue) => ({
      id: crypto.randomUUID(),
      at: Date.now(),
      action: 'startup',
      status: 'failure',
      stage: stageOf(issue.code),
      pluginKey: issue.key === '*' ? undefined : issue.key,
      errorCode: issue.code,
      errorDetail: boundedDetail(issue.detail),
      durationMs: 0,
      generationBefore,
      generationAfter,
    }));
  await appendOperations(host.repository, records);
}

/** 日志 detail 上限：保留足够诊断信息，同时避免异常消息撑大快照 */
function boundedDetail(value: string): string {
  return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
}

async function appendOperations(
  repository: PluginRepository,
  records: PluginOperationRecord[],
): Promise<void> {
  try {
    await repository.appendOperations(records);
  } catch (error) {
    // 日志故障不能反向影响插件操作。
    console.warn('[Plugins] Failed to persist operation log', error);
  }
}

async function ensureReady(): Promise<void> {
  if (!ready) await initPluginHost();
}

function registerMessageListener(host: HostRuntime): void {
  // Register synchronously before startup awaits, so opening hub during worker startup is safe.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== PLUGIN_PROTOCOL) return;
    const url = sender.url ? new URL(sender.url) : undefined;
    const extension = new URL(chrome.runtime.getURL('/'));
    if (
      sender.id !== chrome.runtime.id ||
      !url ||
      url.protocol !== extension.protocol ||
      url.host !== extension.host ||
      !['/hub.html', '/sidepanel.html'].includes(url.pathname)
    ) {
      sendResponse({
        ok: false,
        code: 'PLUGIN_SENDER_REJECTED',
        error:
          'Only trusted management and conversation pages can access plugins',
      });
      return;
    }
    void (async () => {
      await ensureReady();
      const request = requestSchema.parse(message);
      return dispatch(host, request, url);
    })().then(
      (value) => sendResponse({ ok: true, value }),
      (error) => {
        const described = describeOperationError(error);
        sendResponse({
          ok: false,
          code: described.code,
          error:
            described.code === 'PLUGIN_OPERATION_FAILED'
              ? described.detail
              : `${described.code}: ${described.detail}`,
          stage: stageOf(described.code),
        });
      },
    );
    return true;
  });
}

async function dispatch(
  host: HostRuntime,
  request: { operation: string; payload?: unknown },
  url: URL,
): Promise<unknown> {
  const p: any = request.payload ?? {};
  switch (request.operation) {
    case 'snapshot':
      return host.service.snapshot();
    case 'backup-export': {
      const dump = await host.repository.dump();
      let total = 0;
      return dump.state.packages.map((plugin) => {
        const release = dump.releases.find(
          (r) => r.key === plugin.key && r.digest === plugin.digest,
        );
        invariant(
          release,
          'RELEASE_NOT_FOUND',
          `${plugin.key}@${plugin.manifest.version}`,
        );
        total += Math.ceil(release.bytes.length / 3) * 4;
        invariant(
          total <= LIMITS.backup,
          'BACKUP_LIMIT',
          'Export large plugin archives individually',
        );
        return toBase64(release.bytes);
      });
    }
    case 'backup-restore': {
      const input = z
        .object({
          archives: z
            .array(z.string().max(Math.ceil(LIMITS.archive / 3) * 4))
            .min(1)
            .max(500),
          strategy: z.enum(['fill', 'replace']),
        })
        .strict()
        .parse(p);
      invariant(
        input.archives.reduce((n, a) => n + a.length, 0) <= LIMITS.backup,
        'BACKUP_LIMIT',
      );
      const meta: OperationMeta = {
        action: 'backup-restore',
        source: 'backup',
      };
      return recordOperation(host, meta, async () => {
        const dump = await host.repository.dump(),
          records = [...dump.releases],
          packages =
            input.strategy === 'fill' ? [...dump.state.packages] : [];
        const keys = new Set<string>();
        for (const data of input.archives) {
          const bytes = decode64(data),
            plugin = await verifyPackage(bytes, __APP_VERSION__);
          invariant(!keys.has(plugin.key), 'DUPLICATE_PLUGIN', plugin.key);
          keys.add(plugin.key);
          const existingRelease = records.find(
            (r) =>
              r.key === plugin.key && r.version === plugin.manifest.version,
          );
          invariant(
            !existingRelease || existingRelease.digest === plugin.digest,
            'VERSION_CONTENT_CONFLICT',
          );
          if (!existingRelease)
            records.push({
              id: `${plugin.key}@${plugin.manifest.version}`,
              key: plugin.key,
              version: plugin.manifest.version,
              digest: plugin.digest,
              bytes,
            });
          if (
            input.strategy === 'fill' &&
            packages.some((x) => x.key === plugin.key)
          )
            continue;
          packages.push({
            ...plugin,
            enabled: false,
            installedAt: Date.now(),
            epoch: Date.now(),
          });
        }
        assertCatalogConsistent(packages);
        const next = await host.repository.restore(
            dump.state.generation,
            packages,
            records,
          ),
          token = crypto.randomUUID();
        if (host.rollbacks.size >= 4)
          host.rollbacks.delete(host.rollbacks.keys().next().value!);
        host.rollbacks.set(token, { generation: next.generation, dump });
        await host.changed(next);
        return token;
      });
    }
    case 'backup-rollback': {
      const input = z.object({ token: z.string().uuid() }).strict().parse(p);
      const meta: OperationMeta = {
        action: 'backup-rollback',
        source: 'backup',
      };
      return recordOperation(host, meta, async () => {
        const saved = host.rollbacks.get(input.token);
        invariant(saved, 'ROLLBACK_EXPIRED');
        const next = await host.repository.restore(
          saved.generation,
          saved.dump.state.packages,
          saved.dump.releases,
        );
        host.rollbacks.delete(input.token);
        await host.changed(next);
        return true;
      });
    }
    case 'export': {
      const input = z
        .object({ key: z.string().max(256) })
        .strict()
        .parse(p);
      const plugin = (await host.service.snapshot()).packages.find(
        (x) => x.key === input.key,
      );
      invariant(plugin, 'PLUGIN_NOT_FOUND');
      const release = await host.repository.release(
        plugin.key,
        plugin.manifest.version,
      );
      invariant(release, 'RELEASE_NOT_FOUND');
      return toBase64(release.bytes);
    }
    case 'versions': {
      const input = z
        .object({ key: z.string().max(256) })
        .strict()
        .parse(p);
      const dump = await host.repository.dump();
      return dump.releases
        .filter((r) => r.key === input.key)
        .map((r) => ({ version: r.version, digest: r.digest }));
    }
    case 'rollback-preview': {
      const input = z
        .object({ key: z.string().max(256), version: z.string().max(64) })
        .strict()
        .parse(p);
      const meta: OperationMeta = {
        action: 'rollback',
        source: 'rollback',
        pluginKey: input.key,
        toVersion: input.version,
      };
      return recordOperation(
        host,
        meta,
        async () => {
          const release = await host.repository.release(
            input.key,
            input.version,
          );
          invariant(release, 'RELEASE_NOT_FOUND');
          const preview = await host.service.preview(
            release.bytes,
            undefined,
            true,
          );
          applyPreviewMeta(meta, preview);
          return preview;
        },
        { logSuccess: false },
      );
    }
    case 'rollback-install': {
      const input = z
        .object({
          key: z.string().max(256),
          version: z.string().max(64),
          generation: z.number().int().nonnegative(),
          digest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(p);
      const meta: OperationMeta = {
        action: 'rollback',
        source: 'rollback',
        pluginKey: input.key,
        toVersion: input.version,
        digest: input.digest,
      };
      return recordOperation(host, meta, async () => {
        const current = (await host.service.snapshot()).packages.find(
          (plugin) => plugin.key === input.key,
        );
        invariant(current, 'PLUGIN_NOT_FOUND', input.key);
        meta.pluginName = current.manifest.displayName;
        meta.fromVersion = current?.manifest.version;
        const release = await host.repository.release(
          input.key,
          input.version,
        );
        invariant(
          release,
          'RELEASE_NOT_FOUND',
          `${input.key}@${input.version}`,
        );
        const preview = await host.service.preview(
          release.bytes,
          undefined,
          true,
        );
        applyPreviewMeta(meta, preview);
        return host.service.installPreviewed(
          preview,
          release.bytes,
          input.generation,
          input.digest,
        );
      });
    }
    case 'preview': {
      const input = z
        .object({ data: z.string().max(Math.ceil(LIMITS.archive / 3) * 4) })
        .strict()
        .parse(p);
      const meta: OperationMeta = { action: 'preview', source: 'file' };
      return recordOperation(
        host,
        meta,
        async () => {
          const preview = await host.service.preview(decode64(input.data));
          applyPreviewMeta(meta, preview);
          return preview;
        },
        { logSuccess: false },
      );
    }
    case 'install': {
      const input = z
        .object({
          data: z.string().max(Math.ceil(LIMITS.archive / 3) * 4),
          generation: z.number().int().nonnegative(),
          digest: z.string().regex(/^[a-f0-9]{64}$/),
          rollback: z.boolean().optional(),
        })
        .strict()
        .parse(p);
      const meta: OperationMeta = { action: 'install', source: 'file' };
      return recordOperation(host, meta, async () => {
        const bytes = decode64(input.data);
        const preview = await host.service.preview(
          bytes,
          undefined,
          input.rollback,
        );
        applyPreviewMeta(meta, preview);
        meta.action = input.rollback
          ? 'rollback'
          : preview.previousVersion
            ? 'update'
            : 'install';
        if (input.rollback) meta.source = 'rollback';
        return host.service.installPreviewed(
          preview,
          bytes,
          input.generation,
          input.digest,
        );
      });
    }
    case 'enable': {
      const input = mutation.extend({ enabled: z.boolean() }).parse(p);
      const meta: OperationMeta = {
        action: input.enabled ? 'enable' : 'disable',
        pluginKey: input.key,
      };
      return recordOperation(host, meta, async () => {
        const target = (await host.service.snapshot()).packages.find(
          (plugin) => plugin.key === input.key,
        );
        meta.pluginName = target?.manifest.displayName;
        meta.fromVersion = target?.manifest.version;
        meta.toVersion = target?.manifest.version;
        return host.service.setEnabled(
          input.key,
          input.enabled,
          input.generation,
        );
      });
    }
    case 'uninstall': {
      const input = mutation.parse(p);
      const meta: OperationMeta = {
        action: 'uninstall',
        pluginKey: input.key,
      };
      return recordOperation(host, meta, async () => {
        const target = (await host.service.snapshot()).packages.find(
          (plugin) => plugin.key === input.key,
        );
        meta.pluginName = target?.manifest.displayName;
        meta.fromVersion = target?.manifest.version;
        const result = await host.service.uninstall(
          input.key,
          input.generation,
        );
        try {
          const keys = Object.keys(
            await chrome.storage.local.get(null),
          ).filter((k) => k.startsWith(`plugin-secret:${input.key}/`));
          if (keys.length) await chrome.storage.local.remove(keys);
        } catch (error) {
          // 凭据清理失败不应把已完成的卸载报成失败；下次卸载/重置仍会清理。
          console.warn('[Plugins] Failed to clear plugin secrets', error);
        }
        return result;
      });
    }
    case 'execute': {
      const input = z
        .object({
          ref: z
            .string()
            .max(256)
            .refine(isPluginRef, 'Must reference a plugin contribution'),
          args: z.unknown(),
          bindings: z.record(
            z
              .object({
                digest: z.string().regex(/^[a-f0-9]{64}$/),
                epoch: z.number().int().nonnegative(),
              })
              .strict(),
          ),
          approved: z.boolean().optional(),
          chatId: z.string().max(128).optional(),
        })
        .strict()
        .parse(p);
      return host.gateway.execute(input.ref, input.args, {
        pluginBindings: input.bindings,
        pluginApproved: input.approved,
        chatId: input.chatId,
      });
    }
    case 'secret': {
      invariant(url.pathname === '/hub.html', 'MANAGEMENT_ONLY');
      const input = z
        .object({
          key: z.string().max(256),
          slot: z.string().max(48),
          value: z.string().max(8192),
        })
        .strict()
        .parse(p);
      const plugin = (await host.service.snapshot()).packages.find(
        (x) => x.key === input.key,
      );
      invariant(plugin, 'PLUGIN_NOT_FOUND', input.key);
      invariant(
        plugin.manifest.capabilities.secretSlots.includes(input.slot),
        'UNDECLARED_SECRET',
        input.slot,
      );
      if (input.value)
        await chrome.storage.local.set({
          [secretKey(input.key, input.slot)]: input.value,
        });
      else
        await chrome.storage.local.remove(secretKey(input.key, input.slot));
      return true;
    }
    case 'search':
      return searchGithub(
        z
          .object({ query: z.string().max(100) })
          .strict()
          .parse(p).query,
      );
    case 'github-preview': {
      const input = z
        .object({
          repository: z.string().url(),
          key: z.string().max(256).optional(),
        })
        .strict()
        .parse(p);
      const meta: OperationMeta = {
        action: 'preview',
        source: 'github',
        pluginKey: input.key,
      };
      return recordOperation(
        host,
        meta,
        async () => {
          const existing = input.key
            ? (await host.service.snapshot()).packages.find(
                (x) => x.key === input.key,
              )
            : undefined;
          meta.pluginName = existing?.manifest.displayName;
          meta.fromVersion = existing?.manifest.version;
          const candidate = await githubRelease(
              input.repository,
              existing?.manifest.version,
              existing?.source?.repositoryId,
            ),
            bytes = await downloadCandidate(candidate),
            preview = await host.service.preview(bytes, candidate.source);
          invariant(
            preview.plugin.manifest.version === candidate.version &&
              (!existing || existing.key === preview.plugin.key),
            'GITHUB_IDENTITY_MISMATCH',
          );
          applyPreviewMeta(meta, preview);
          return { preview, candidate };
        },
        { logSuccess: false },
      );
    }
    case 'github-install': {
      const input = z
        .object({
          repository: z.string().url(),
          key: z.string().max(256),
          generation: z.number().int().nonnegative(),
          digest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(p);
      const meta: OperationMeta = {
        action: 'install',
        source: 'github',
        pluginKey: input.key,
        digest: input.digest,
      };
      return recordOperation(host, meta, async () => {
        const old = (await host.service.snapshot()).packages.find(
          (x) => x.key === input.key,
        );
        meta.pluginName = old?.manifest.displayName;
        meta.fromVersion = old?.manifest.version;
        const candidate = await githubRelease(
            input.repository,
            old?.manifest.version,
            old?.source?.repositoryId,
          ),
          bytes = await downloadCandidate(candidate),
          preview = await host.service.preview(bytes, candidate.source);
        invariant(
          preview.plugin.key === input.key &&
            preview.plugin.digest === input.digest,
          'STALE_PREVIEW',
        );
        applyPreviewMeta(meta, preview);
        meta.action = preview.previousVersion ? 'update' : 'install';
        return host.service.installPreviewed(
          preview,
          bytes,
          input.generation,
          input.digest,
        );
      });
    }
    case 'catalog': {
      const input = z
        .object({ url: z.string().url(), publicKey: z.string().max(64) })
        .strict()
        .parse(p),
        storageKey = `plugin-catalog:${input.publicKey}:${input.url}`;
      const stored = (await chrome.storage.local.get(storageKey))[storageKey],
        minimum =
          typeof stored === 'number' &&
          Number.isSafeInteger(stored) &&
          stored >= 0
            ? stored
            : 0,
        result = await fetchCatalog(input.url, input.publicKey, minimum);
      await chrome.storage.local.set({ [storageKey]: result.sequence });
      return result.plugins;
    }
    case 'operations': {
      invariant(url.pathname === '/hub.html', 'MANAGEMENT_ONLY');
      const input = z
        .object({
          pluginKey: z.string().max(256).optional(),
          action: z
            .enum([
              'preview',
              'install',
              'update',
              'enable',
              'disable',
              'uninstall',
              'rollback',
              'backup-restore',
              'backup-rollback',
              'update-check',
              'startup',
            ])
            .optional(),
          status: z.enum(['success', 'failure']).optional(),
          limit: z.number().int().min(1).max(200).default(100),
        })
        .strict()
        .parse(p);
      return host.repository.listOperations(input);
    }
    case 'operations-clear': {
      invariant(url.pathname === '/hub.html', 'MANAGEMENT_ONLY');
      z.object({}).strict().parse(p);
      await host.repository.clearOperations();
      return true;
    }
    case 'check-updates': {
      // 自动更新检查：6 小时节流；单插件失败（无新版/仓库失效）不中断
      // 批次；GitHub 限流（403/429）中止剩余检查。结果只含更高版本。
      const throttle = 'plugin-updates:lastCheck',
        last = (await chrome.storage.local.get(throttle))[throttle];
      if (typeof last === 'number' && Date.now() - last < 6 * 3600_000)
        return [];
      const meta: OperationMeta = {
        action: 'update-check',
        source: 'auto',
      };
      return recordOperation(host, meta, async () => {
        const updates: { key: string; version: string; digest: string }[] = [],
          failures: string[] = [];
        try {
          for (const plugin of (await host.service.snapshot()).packages) {
            if (!plugin.source) continue;
            try {
              const candidate = await githubRelease(
                `https://github.com/${plugin.source.owner}/${plugin.source.repo}`,
                plugin.manifest.version,
                plugin.source.repositoryId,
              );
              updates.push({
                key: plugin.key,
                version: candidate.version!,
                digest: candidate.digest!,
              });
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              // 没有新版本是正常结果，不是失败；只把真正的错误写进日志备注。
              if (/NO_UPDATE_AVAILABLE|NO_PLUGIN_RELEASE/.test(message))
                continue;
              failures.push(`${plugin.key}: ${message}`);
              if (/HTTP 40[13]|HTTP 429/.test(message)) break;
            }
          }
        } finally {
          await chrome.storage.local.set({ [throttle]: Date.now() });
        }
        const notes = updates.map(
          (update) => `${update.key}@${update.version}`,
        );
        if (failures.length)
          notes.push(`failed: ${failures.slice(0, 10).join('; ')}`);
        if (notes.length) meta.note = boundedDetail(notes.join(' | '));
        return updates;
      });
    }
    default:
      throw new PluginError('UNKNOWN_PLUGIN_OPERATION');
  }
}

function applyPreviewMeta(meta: OperationMeta, preview: PluginPreview): void {
  meta.pluginKey = preview.plugin.key;
  meta.pluginName = preview.plugin.manifest.displayName;
  meta.fromVersion = preview.previousVersion;
  meta.toVersion = preview.plugin.manifest.version;
  meta.digest = preview.plugin.digest;
}

/**
 * 生命周期操作统一埋点。meta 在操作过程中可被补全（例如 preview 之后才知道
 * 插件 key/版本），失败时记录的是补全后的精确上下文。
 */
async function recordOperation<T>(
  host: HostRuntime,
  meta: OperationMeta,
  fn: () => Promise<T>,
  options: { logSuccess?: boolean } = {},
): Promise<T> {
  const started = Date.now();
  const generationBefore = getPluginSnapshot().generation;
  try {
    const value = await fn();
    if (options.logSuccess !== false)
      await appendOperations(host.repository, [
        {
          id: crypto.randomUUID(),
          at: Date.now(),
          status: 'success',
          ...meta,
          durationMs: Date.now() - started,
          generationBefore,
          generationAfter: getPluginSnapshot().generation,
        },
      ]);
    return value;
  } catch (error) {
    const described = describeOperationError(error);
    await appendOperations(host.repository, [
      {
        id: crypto.randomUUID(),
        at: Date.now(),
        status: 'failure',
        stage: stageOf(described.code),
        ...meta,
        durationMs: Date.now() - started,
        generationBefore,
        generationAfter: getPluginSnapshot().generation,
        errorCode: described.code,
        errorDetail: boundedDetail(described.detail),
      },
    ]);
    throw error;
  }
}
