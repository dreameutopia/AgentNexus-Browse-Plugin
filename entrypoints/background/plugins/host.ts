import { z } from 'zod';
import { PluginService } from '@/utils/plugins/service';
import { PluginRepository } from '@/utils/plugins/repository';
import {
  applyPluginSnapshot,
  setPluginExecutor,
} from '@/utils/plugins/catalog';
import { decode64, toBase64, verifyPackage } from '@/utils/plugins/package';
import {
  PLUGIN_PROTOCOL,
  invariant,
  LIMITS,
  PluginError,
  type PluginSnapshot,
} from '@/utils/plugins/contracts';
import {
  downloadCandidate,
  fetchCatalog,
  githubRelease,
  searchGithub,
} from '@/utils/plugins/github';
import { PluginExecutionGateway, PUBLIC_HOST_TOOLS } from './execution';

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
let initialization: Promise<void> | undefined;
export function initPluginHost(): Promise<void> {
  return (initialization ??= startPluginHost());
}
function startPluginHost(): Promise<void> {
  const repository = new PluginRepository();
  const changed = async (snapshot: PluginSnapshot) => {
    applyPluginSnapshot(snapshot);
    gateway.reconcile(snapshot);
    // Notification is a hint; clients re-read the committed authoritative generation.
    await chrome.runtime
      .sendMessage({
        type: `${PLUGIN_PROTOCOL}.changed`,
        generation: snapshot.generation,
      })
      .catch(() => undefined);
  };
  const host = new PluginService(repository, __APP_VERSION__, changed);
  const gateway = new PluginExecutionGateway(
    host,
    async (key, slot) =>
      (await chrome.storage.local.get(secretKey(key, slot)))[
        secretKey(key, slot)
      ],
  );
  setPluginExecutor((ref, args, context) =>
    gateway.execute(ref, args, context),
  );
  const ready = host.snapshot().then(applyPluginSnapshot);
  const rollbacks = new Map<
    string,
    { generation: number; dump: Awaited<ReturnType<PluginRepository['dump']>> }
  >();
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
      await ready;
      const request = requestSchema.parse(message),
        p: any = request.payload;
      switch (request.operation) {
        case 'snapshot':
          return host.snapshot();
        case 'backup-export': {
          const dump = await repository.dump();
          let total = 0;
          return dump.state.packages.map((p) => {
            const r = dump.releases.find(
              (r) => r.key === p.key && r.digest === p.digest,
            );
            invariant(r, 'RELEASE_NOT_FOUND');
            total += Math.ceil(r.bytes.length / 3) * 4;
            invariant(
              total <= LIMITS.backup,
              'BACKUP_LIMIT',
              'Export large plugin archives individually',
            );
            return toBase64(r.bytes);
          });
        }
        case 'backup-restore': {
          const input = z
            .object({
              archives: z
                .array(z.string().max(Math.ceil(LIMITS.archive / 3) * 4))
                .max(500),
              strategy: z.enum(['fill', 'replace']),
            })
            .strict()
            .parse(p);
          invariant(
            input.archives.reduce((n, a) => n + a.length, 0) <= LIMITS.backup,
            'BACKUP_LIMIT',
          );
          const dump = await repository.dump(),
            records = [...dump.releases],
            packages =
              input.strategy === 'fill' ? [...dump.state.packages] : [];
          const keys = new Set<string>();
          for (const data of input.archives) {
            const bytes = decode64(data),
              plugin = await verifyPackage(bytes, __APP_VERSION__);
            checkHostTools(plugin.manifest.capabilities.hostTools);
            invariant(!keys.has(plugin.key), 'DUPLICATE_PLUGIN');
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
          const next = await repository.restore(
              dump.state.generation,
              packages,
              records,
            ),
            token = crypto.randomUUID();
          if (rollbacks.size >= 4)
            rollbacks.delete(rollbacks.keys().next().value!);
          rollbacks.set(token, { generation: next.generation, dump });
          await changed(next);
          return token;
        }
        case 'backup-rollback': {
          const input = z
              .object({ token: z.string().uuid() })
              .strict()
              .parse(p),
            saved = rollbacks.get(input.token);
          invariant(saved, 'ROLLBACK_EXPIRED');
          const next = await repository.restore(
            saved.generation,
            saved.dump.state.packages,
            saved.dump.releases,
          );
          rollbacks.delete(input.token);
          await changed(next);
          return true;
        }
        case 'export': {
          const input = z
              .object({ key: z.string().max(256) })
              .strict()
              .parse(p),
            plugin = (await host.snapshot()).packages.find(
              (x) => x.key === input.key,
            );
          invariant(plugin, 'PLUGIN_NOT_FOUND');
          const release = await repository.release(
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
              .parse(p),
            dump = await repository.dump();
          return dump.releases
            .filter((r) => r.key === input.key)
            .map((r) => ({ version: r.version, digest: r.digest }));
        }
        case 'rollback-preview': {
          const input = z
              .object({ key: z.string().max(256), version: z.string().max(64) })
              .strict()
              .parse(p),
            release = await repository.release(input.key, input.version);
          invariant(release, 'RELEASE_NOT_FOUND');
          return host.preview(release.bytes, undefined, true);
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
          const release = await repository.release(input.key, input.version);
          invariant(release, 'RELEASE_NOT_FOUND');
          return host.install(
            release.bytes,
            input.generation,
            input.digest,
            undefined,
            true,
          );
        }
        case 'preview': {
          const input = z
            .object({ data: z.string().max(Math.ceil(LIMITS.archive / 3) * 4) })
            .strict()
            .parse(p);
          const preview = await host.preview(decode64(input.data));
          checkHostTools(preview.plugin.manifest.capabilities.hostTools);
          return preview;
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
          const bytes = decode64(input.data);
          const preview = await host.preview(bytes, undefined, input.rollback);
          checkHostTools(preview.plugin.manifest.capabilities.hostTools);
          return host.install(
            bytes,
            input.generation,
            input.digest,
            undefined,
            input.rollback,
          );
        }
        case 'enable': {
          const input = mutation.extend({ enabled: z.boolean() }).parse(p);
          return host.setEnabled(input.key, input.enabled, input.generation);
        }
        case 'uninstall': {
          const input = mutation.parse(p);
          const result = await host.uninstall(input.key, input.generation);
          const keys = Object.keys(await chrome.storage.local.get(null)).filter(
            (k) => k.startsWith(`plugin-secret:${input.key}/`),
          );
          if (keys.length) await chrome.storage.local.remove(keys);
          return result;
        }
        case 'execute': {
          const input = z
            .object({
              ref: z.string().max(256),
              args: z.unknown(),
              bindings: z.record(
                z
                  .object({
                    digest: z.string().regex(/^[a-f0-9]{64}$/),
                    epoch: z.number().int(),
                  })
                  .strict(),
              ),
              approved: z.literal(true),
              chatId: z.string().max(128).optional(),
            })
            .strict()
            .parse(p);
          return gateway.execute(input.ref, input.args, {
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
          const plugin = (await host.snapshot()).packages.find(
            (x) => x.key === input.key,
          );
          invariant(
            plugin?.manifest.capabilities.secretSlots.includes(input.slot),
            'UNDECLARED_SECRET',
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
              .parse(p),
            existing = input.key
              ? (await host.snapshot()).packages.find(
                  (x) => x.key === input.key,
                )
              : undefined;
          const candidate = await githubRelease(
              input.repository,
              existing?.manifest.version,
              existing?.source?.repositoryId,
            ),
            bytes = await downloadCandidate(candidate),
            preview = await host.preview(bytes, candidate.source);
          invariant(
            preview.plugin.manifest.version === candidate.version &&
              (!existing || existing.key === preview.plugin.key),
            'GITHUB_IDENTITY_MISMATCH',
          );
          checkHostTools(preview.plugin.manifest.capabilities.hostTools);
          return { preview, candidate };
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
          const old = (await host.snapshot()).packages.find(
              (x) => x.key === input.key,
            ),
            candidate = await githubRelease(
              input.repository,
              old?.manifest.version,
              old?.source?.repositoryId,
            ),
            bytes = await downloadCandidate(candidate),
            preview = await host.preview(bytes, candidate.source);
          invariant(
            preview.plugin.key === input.key &&
              preview.plugin.digest === input.digest,
            'STALE_PREVIEW',
          );
          checkHostTools(preview.plugin.manifest.capabilities.hostTools);
          return host.install(
            bytes,
            input.generation,
            input.digest,
            candidate.source,
          );
        }
        case 'catalog': {
          const input = z
              .object({ url: z.string().url(), publicKey: z.string().max(64) })
              .strict()
              .parse(p),
            storageKey = `plugin-catalog:${input.publicKey}:${input.url}`;
          const minimum =
              (await chrome.storage.local.get(storageKey))[storageKey] ?? 0,
            result = await fetchCatalog(input.url, input.publicKey, minimum);
          await chrome.storage.local.set({ [storageKey]: result.sequence });
          return result.plugins;
        }
        case 'check-updates': {
          // 自动更新检查：6 小时节流；单插件失败（无新版/仓库失效）不中断
          // 批次；GitHub 限流（403/429）中止剩余检查。结果只含更高版本。
          const throttle = 'plugin-updates:lastCheck',
            last = (await chrome.storage.local.get(throttle))[throttle];
          if (typeof last === 'number' && Date.now() - last < 6 * 3600_000)
            return [];
          const updates: { key: string; version: string; digest: string }[] =
            [];
          try {
            for (const p of (await host.snapshot()).packages) {
              if (!p.source) continue;
              try {
                const candidate = await githubRelease(
                  `https://github.com/${p.source.owner}/${p.source.repo}`,
                  p.manifest.version,
                  p.source.repositoryId,
                );
                updates.push({
                  key: p.key,
                  version: candidate.version!,
                  digest: candidate.digest!,
                });
              } catch (error) {
                if (
                  error instanceof Error &&
                  /HTTP 40[13]|HTTP 429/.test(error.message)
                )
                  break;
              }
            }
          } finally {
            await chrome.storage.local.set({ [throttle]: Date.now() });
          }
          return updates;
        }
        default:
          throw new PluginError('UNKNOWN_PLUGIN_OPERATION');
      }
    })().then(
      (value) => sendResponse({ ok: true, value }),
      (error) =>
        sendResponse({
          ok: false,
          code:
            error instanceof PluginError
              ? error.code
              : 'PLUGIN_OPERATION_FAILED',
          error:
            error instanceof Error ? error.message : 'Plugin operation failed',
        }),
    );
    return true;
  });
  return ready;
}
function checkHostTools(refs: string[]): void {
  for (const ref of refs)
    invariant(
      ref.startsWith('builtin/') && PUBLIC_HOST_TOOLS.has(ref.slice(8)),
      'HOST_TOOL_NOT_PUBLIC',
      ref,
    );
}
