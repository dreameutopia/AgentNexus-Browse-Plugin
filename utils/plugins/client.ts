import { PLUGIN_PROTOCOL, PluginError, type PluginSnapshot } from './contracts';
import { applyPluginSnapshot, setPluginExecutor } from './catalog';

export async function pluginRequest<T = any>(
  operation: string,
  payload: unknown = {},
): Promise<T> {
  const response = await chrome.runtime.sendMessage({
    type: PLUGIN_PROTOCOL,
    operation,
    payload,
  });
  if (!response?.ok)
    throw new PluginError(
      response?.code ?? 'PLUGIN_HOST_UNAVAILABLE',
      response?.error ?? 'No response from plugin host',
    );
  return response.value as T;
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
export async function refresh(): Promise<void> {
  applyPluginSnapshot(await pluginRequest<PluginSnapshot>('snapshot'));
}
export function encodeBytes(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192)
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(out);
}
