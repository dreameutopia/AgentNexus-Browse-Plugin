import type { NativeReplay, ProviderType, StreamRequestConfig, UnifiedChatMessage } from '../types';

/** Stable non-secret identity. Changing model or endpoint cannot replay opaque
 * reasoning state from a different deployment that happens to share a name. */
export function replayScope(provider: ProviderType, baseUrl: string, model: string, credentialScope = ''): string {
  return fingerprint([provider, baseUrl.replace(/\/+$/, ''), model, credentialScope]);
}

const fallbackCredentials = new Map<string, string>();
export async function credentialScope(apiKey?: string): Promise<string> {
  if (!apiKey) return '';
  if (globalThis.crypto?.subtle) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    } catch { /* Keep credentials in memory only when secure hashing is unavailable. */ }
  }
  let scope = fallbackCredentials.get(apiKey);
  if (!scope) {
    if (fallbackCredentials.size >= 128) fallbackCredentials.delete(fallbackCredentials.keys().next().value!);
    scope = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    fallbackCredentials.set(apiKey, scope);
  }
  return scope;
}

function fingerprint(value: unknown): string {
  const hashes = [2166136261, 2654435769, 2246822507, 3266489909];
  const multipliers = [16777619, 2246822519, 3266489917, 668265263];
  for (const char of JSON.stringify(value)) {
    for (let i = 0; i < hashes.length; i++) hashes[i] = Math.imul(hashes[i] ^ char.charCodeAt(0), multipliers[i]);
  }
  return `replay-v1-${hashes.map(hash => (hash >>> 0).toString(16).padStart(8, '0')).join('')}`;
}

export function staticReplayPrefix(config: StreamRequestConfig): string {
  return fingerprint([config.model, config.messages.filter(m => m.role === 'system').map(m => m.content), config.tools ?? []]);
}

const inputPrefixes = new WeakMap<StreamRequestConfig, { before: Map<UnifiedChatMessage, string>; final: string }>();
function prefixes(config: StreamRequestConfig) {
  let cached = inputPrefixes.get(config);
  if (cached) return cached;
  // One pass per request, not one serialization of the entire history for each
  // thinking block. A separator preserves message boundaries.
  const state = [2166136261, 2654435769, 2246822507, 3266489909];
  const primes = [16777619, 2246822519, 3266489917, 668265263];
  const digest = () => state.map(hash => (hash >>> 0).toString(16).padStart(8, '0')).join('');
  const before = new Map<UnifiedChatMessage, string>();
  for (const message of config.messages) {
    before.set(message, digest());
    for (const char of JSON.stringify(message) + '\u001e') for (let i = 0; i < state.length; i++) state[i] = Math.imul(state[i] ^ char.charCodeAt(0), primes[i]);
  }
  cached = { before, final: digest() }; inputPrefixes.set(config, cached); return cached;
}
export function inputReplayPrefix(config: StreamRequestConfig): string { return prefixes(config).final; }

export function nativeItems(message: UnifiedChatMessage, config: StreamRequestConfig, provider: ProviderType): Record<string, any>[] | undefined {
  const replay = message.nativeReplay;
  if (!replay || replay.provider !== provider || (replay.model && replay.model !== config.model) ||
      (replay.model !== undefined && typeof replay.model !== 'string') || (replay.scope !== undefined && typeof replay.scope !== 'string') ||
      (replay.scope && replay.scope !== config.replayScope) || !Array.isArray(replay.items) ||
      !replay.items.every(item => item && typeof item === 'object' && !Array.isArray(item))) return undefined;
  if (provider === 'openai-responses' && replay.items.some(item => item?.type === 'message' && item.role !== 'assistant')) return undefined;
  let items = replay.items.filter(Boolean);
  // Claude's newer thinking signatures are bound to the preceding system/tools
  // and conversation. A client compaction/configuration change invalidates them.
  // Keep ordinary text/tool blocks; originals remain intact in the transcript.
  if (provider === 'claude' && ((replay.requestPrefix && replay.requestPrefix !== staticReplayPrefix(config)) ||
      (replay.inputPrefix && replay.inputPrefix !== prefixes(config).before.get(message)))) {
    items = items.filter(item => !['thinking', 'redacted_thinking'].includes(item.type));
  }
  return structuredClone(items);
}

export function setNativeItems(message: UnifiedChatMessage, provider: ProviderType, items: NativeReplay['items']): void {
  message.nativeReplay = { provider, items };
}

/** Do not let a malformed SSE index allocate a billion-entry sparse array. */
export function nativePartIndex(value: unknown, fallback = 0): number {
  const index = typeof value === 'number' ? value : Number(value);
  return value !== undefined && value !== null && Number.isInteger(index) && index >= 0 && index < 65536 ? index : fallback;
}
