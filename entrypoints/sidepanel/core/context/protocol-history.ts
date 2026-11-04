import type { ChatMessage } from '../../utils/ai/ai-chat-api';
import type { ChatMessageRecord } from '../types';
import { imageStore, isImageRef } from '../images/image-store';

// This URI is storage-only. It must never reach a provider. Images remain in
// the content-addressed image database, not duplicated in every chat snapshot.
const PREFIX = 'agentnexus-image:';
const encoded = new WeakMap<ChatMessage, ChatMessage>();
const restored = new WeakMap<ChatMessageRecord, { source: ChatMessage[]; messages: ChatMessage[] }>();

function validMessages(value: unknown): value is ChatMessage[] {
  if (!Array.isArray(value)) return false;
  return value.every(message => {
    if (!message || !['system', 'user', 'assistant', 'tool'].includes(message.role)) return false;
    if (message.role === 'tool' && typeof message.tool_call_id !== 'string') return false;
    const contentValid = typeof message.content === 'string' || (Array.isArray(message.content) && message.content.every((part: any) => {
      if (part?.type === 'text') return typeof part.text === 'string';
      const url = part?.image_url?.url;
      return part?.type === 'image_url' && typeof url === 'string' && (!url.startsWith(PREFIX) || isImageRef(url.slice(PREFIX.length)));
    }));
    const callsValid = message.tool_calls === undefined || (Array.isArray(message.tool_calls) && message.tool_calls.every((call: any) =>
      call && typeof call.id === 'string' && call.type === 'function' && typeof call.function?.name === 'string' &&
      typeof call.function?.arguments === 'string' && (call.geminiThoughtSignature === undefined || typeof call.geminiThoughtSignature === 'string')));
    return contentValid && callsValid;
  });
}

export function hasProtocolCheckpoint(record: ChatMessageRecord): boolean {
  return validMessages(record.modelContext) && record.modelContext.length > 0 &&
    record.modelContext[0].role === 'system' && typeof record.modelContext[0].content === 'string' &&
    record.modelContext[0].content.startsWith('<conversation-memory>');
}

function sourceOf(record: ChatMessageRecord): ChatMessage[] | undefined {
  return hasProtocolCheckpoint(record) ? record.modelContext : validMessages(record.modelMessages) ? record.modelMessages : undefined;
}

export function protocolImageRefs(messages: readonly ChatMessage[] = []): string[] {
  const refs = new Set<string>();
  if (!Array.isArray(messages)) return [];
  for (const message of messages) {
    if (!message) continue;
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const url = part?.image_url?.url;
      if (typeof url === 'string' && url.startsWith(PREFIX) && isImageRef(url.slice(PREFIX.length))) refs.add(url.slice(PREFIX.length));
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
          const ref = imageStore.findRefByDataUrl(part.image_url.url) ?? await imageStore.putFromDataUrl(part.image_url.url);
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
    const source = sourceOf(record);
    if (!source) {
      if (record.modelMessages !== undefined) console.warn('[ProtocolHistory] Invalid history; using legacy transcript:', record.id);
      restored.delete(record);
      continue;
    }
    const messages = structuredClone(source);
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
    restored.set(record, { source, messages });
  }
}

export function readProtocolHistory(record: ChatMessageRecord): ChatMessage[] | undefined {
  const cached = restored.get(record);
  const source = sourceOf(record);
  const ready = cached?.source === source ? cached?.messages : undefined;
  if (!source) return undefined;
  // Pure text/new in-memory records need no asynchronous image hydration.
  const messages = structuredClone(ready ?? source);
  if (!ready) for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    message.content = message.content.map(part => {
      const url = part.image_url?.url;
      if (!url?.startsWith(PREFIX)) return part;
      const dataUrl = imageStore.peekDataUrl(url.slice(PREFIX.length));
      if (dataUrl) return { ...part, image_url: { ...part.image_url!, url: dataUrl } };
      console.warn('[ProtocolHistory] Image not hydrated; retaining text and marking missing evidence');
      return { type: 'text', text: '[Historical image unavailable; do not infer its contents or reuse its GUI coordinates.]' };
    });
  }
  if (record.modelPartial?.role === 'assistant' && typeof record.modelPartial.content === 'string' && validMessages([record.modelPartial])) {
    messages.push(structuredClone(record.modelPartial));
    for (const call of record.modelPartial.tool_calls ?? []) messages.push({
      role: 'tool', tool_call_id: call.id, name: call.function.name,
      content: JSON.stringify({ success: false, error: 'Run interrupted before the tool completed; no successful result is available.' }),
    });
  }
  return messages;
}
