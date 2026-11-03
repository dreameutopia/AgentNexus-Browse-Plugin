import type { ChatMessage } from '../../utils/ai/ai-chat-api';
import type { ChatMessageRecord } from '../types';
import { imageStore, isImageRef } from '../images/image-store';

// This URI is storage-only. It must never reach a provider. Images remain in
// the content-addressed image database, not duplicated in every chat snapshot.
const PREFIX = 'agentnexus-image:';
const encoded = new WeakMap<ChatMessage, ChatMessage>();
const restored = new WeakMap<ChatMessageRecord, ChatMessage[]>();

export function protocolImageRefs(messages: readonly ChatMessage[] = []): string[] {
  const refs = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const url = part.image_url?.url;
      if (url?.startsWith(PREFIX) && isImageRef(url.slice(PREFIX.length))) refs.add(url.slice(PREFIX.length));
    }
  }
  return [...refs];
}

export async function storeProtocolMessages(messages: readonly ChatMessage[]): Promise<ChatMessage[]> {
  const result: ChatMessage[] = [];
  for (const message of messages) {
    let snapshot = encoded.get(message);
    if (!snapshot) {
      snapshot = structuredClone(message);
      if (Array.isArray(snapshot.content)) {
        for (const part of snapshot.content) {
          if (!part.image_url?.url.startsWith('data:')) continue;
          const ref = await imageStore.putFromDataUrl(part.image_url.url);
          // Storage failure: retain the original data URL. Losing the screenshot
          // is worse than a larger record; the image store already reports it.
          if (ref) part.image_url.url = `${PREFIX}${ref}`;
        }
      }
      encoded.set(message, snapshot);
    }
    result.push(snapshot);
  }
  return result;
}

/** A per-record snapshot avoids silently losing old images to the 128-entry LRU. */
export async function prepareProtocolHistory(records: readonly ChatMessageRecord[]): Promise<void> {
  for (const record of records) {
    if (!Array.isArray(record.modelMessages)) continue;
    const messages = structuredClone(record.modelMessages);
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      for (let i = 0; i < message.content.length; i++) {
        const part = message.content[i];
        if (!part.image_url?.url.startsWith(PREFIX)) continue;
        const ref = part.image_url.url.slice(PREFIX.length);
        const url = isImageRef(ref) ? await imageStore.getDataUrl(ref) : null;
        if (url) part.image_url.url = url;
        else {
          console.warn('[ProtocolHistory] Historical image unavailable:', ref);
          message.content[i] = { type: 'text', text: '[Historical image unavailable; do not infer its contents or reuse its GUI coordinates.]' };
        }
      }
    }
    restored.set(record, messages);
  }
}

export function readProtocolHistory(record: ChatMessageRecord): ChatMessage[] | undefined {
  const ready = restored.get(record);
  if (ready) return structuredClone(ready);
  if (!Array.isArray(record.modelMessages)) return undefined;
  // Pure text/new in-memory records need no asynchronous image hydration.
  if (protocolImageRefs(record.modelMessages).length === 0) return structuredClone(record.modelMessages);
  return undefined;
}
