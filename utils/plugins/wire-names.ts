import type { OpenAITool } from '@/common/openai-types';
import { invariant, isPluginRef } from './contracts';

/** Request-local bijection, applied before any provider-specific adapter. Canonical history is untouched. */
export function wireNames(tools: OpenAITool[] = [], messages: any[] = []) {
  invariant(
    tools.length <= 200,
    'TOOL_REQUEST_LIMIT',
    'Select at most 200 tools for one request',
  );
  const refs = new Set(tools.map((t) => t.function.name).filter(isPluginRef));
  for (const m of messages) {
    if (isPluginRef(m.name ?? '')) refs.add(m.name);
    for (const c of m.tool_calls ?? [])
      if (isPluginRef(c.function?.name ?? '')) refs.add(c.function.name);
  }
  const reserved = new Set(
      tools.map((t) => t.function.name).filter((n) => !isPluginRef(n)),
    ),
    forward = new Map<string, string>(),
    reverse = new Map<string, string>();
  let index = 0;
  for (const ref of [...refs].sort()) {
    let alias: string;
    do {
      alias = `anp_${index++}`;
    } while (reserved.has(alias));
    forward.set(ref, alias);
    reverse.set(alias, ref);
  }
  const encode = (name: string) => forward.get(name) ?? name,
    decode = (name: string) => reverse.get(name) ?? name;
  function native(value: any, decoding: boolean, depth = 0): any {
    invariant(depth <= 32, 'NATIVE_REPLAY_DEPTH');
    if (Array.isArray(value))
      return value.map((v) => native(v, decoding, depth + 1));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        k === 'name' && typeof v === 'string'
          ? (decoding ? decode : encode)(v)
          : native(v, decoding, depth + 1),
      ]),
    );
  }
  const replacePrompt = (s: string) => {
    for (const [ref, alias] of [...forward].sort(
      (a, b) => b[0].length - a[0].length,
    ))
      s = s.split(ref).join(alias);
    return s;
  };
  const call = (c: any, decoding = false) => ({
    ...c,
    function: {
      ...c.function,
      name: (decoding ? decode : encode)(c.function?.name ?? ''),
    },
  });
  const message = (m: any, decoding = false) => ({
    ...m,
    ...(m.name ? { name: (decoding ? decode : encode)(m.name) } : {}),
    ...(m.nativeReplay
      ? {
          nativeReplay: {
            ...m.nativeReplay,
            items: native(m.nativeReplay.items, decoding),
          },
        }
      : {}),
    ...(m.tool_calls
      ? { tool_calls: m.tool_calls.map((c: any) => call(c, decoding)) }
      : {}),
    ...(!decoding && typeof m.content === 'string'
      ? { content: replacePrompt(m.content) }
      : {}),
  });
  return {
    tools: tools.map((t) => ({
      ...t,
      function: { ...t.function, name: encode(t.function.name) },
    })),
    messages: messages.map((m) => message(m)),
    decodeCall: (c: any) => call(c, true),
    decodeMessage: (m: any) => message(m, true),
  };
}
