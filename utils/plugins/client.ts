import { PLUGIN_PROTOCOL, PluginError, type PluginSnapshot } from './contracts';
import {
  applyPluginSnapshot,
  getPluginSnapshot,
  replacePluginSnapshot,
  setPluginExecutor,
} from './catalog';

export async function pluginRequest<T = any>(
  operation: string,
  payload: unknown = {},
  options: { timeoutMs?: number } = {},
): Promise<T> {
  let request: Promise<any>;
  try {
    request = chrome.runtime.sendMessage({
      type: PLUGIN_PROTOCOL,
      operation,
      payload,
    });
  } catch (error) {
    throw new PluginError(
      'PLUGIN_HOST_UNAVAILABLE',
      error instanceof Error ? error.message : String(error),
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = options.timeoutMs
      ? await Promise.race([
          request,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new PluginError(
                    'PLUGIN_HOST_TIMEOUT',
                    `${operation} timed out after ${options.timeoutMs}ms`,
                  ),
                ),
              options.timeoutMs,
            );
          }),
        ])
      : await request;
    if (!response?.ok)
      throw new PluginError(
        response?.code ?? 'PLUGIN_HOST_UNAVAILABLE',
        response?.error ?? 'No response from plugin host',
      );
    return response.value as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
let start: Promise<void> | undefined;
let listening = false;
export function startPluginClient(): Promise<void> {
  return (start ??= (async () => {
    setPluginExecutor((ref, args, context) =>
      pluginRequest('execute', {
        ref,
        args,
        bindings: context?.pluginBindings,
        approved: context?.pluginApproved,
        chatId: context?.chatId,
      }),
    );
    if (!listening) {
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === `${PLUGIN_PROTOCOL}.changed`)
          void refresh().catch((error) =>
            console.warn('[Plugins] Refresh failed', error),
          );
      });
      listening = true;
    }
    await refresh();
  })().catch((error) => {
    start = undefined;
    throw error;
  }));
}
export async function refresh(timeoutMs = 15_000): Promise<void> {
  const current = getPluginSnapshot().generation;
  let next = await pluginRequest<PluginSnapshot>('snapshot', {}, { timeoutMs });
  // generation 回退有两种可能：宿主数据被清空/重装（真实回退），或这次响应
  // 早于另一个页面的提交、只是迟到（假回退）。再读一次权威快照区分：
  // 仍低于当前值才强制替换，避免把较新的目录覆盖成旧数据。
  if (next.generation < current)
    next = await pluginRequest<PluginSnapshot>('snapshot', {}, { timeoutMs });
  const latest = getPluginSnapshot().generation;
  if (next.generation < latest) await replacePluginSnapshot(next);
  else await applyPluginSnapshot(next);
}
/**
 * 目录刷新是“增强能力”，不是对话启动的前置条件。
 * 宿主暂时不可用时保留上一次快照，返回 false 让调用方记录降级状态即可。
 */
export async function tryRefreshPluginCatalog(
  timeoutMs = 8000,
): Promise<boolean> {
  try {
    await refresh(timeoutMs);
    return true;
  } catch (error) {
    console.warn('[Plugins] Catalog refresh failed; keeping last snapshot', error);
    return false;
  }
}
