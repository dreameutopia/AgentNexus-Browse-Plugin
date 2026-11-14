import { invariant } from './contracts';

/** Parse JSON without silently accepting duplicate keys or prototype-related keys. */
export function strictJson(text: string): unknown {
  let at = 0;
  const ws = () => {
    while (at < text.length && ' \r\n\t'.includes(text[at])) at++;
  };
  function string(): string {
    const start = at++;
    let escaped = false;
    while (at < text.length) {
      const c = text[at++];
      if (c === '"' && !escaped) {
        const parsed: string = JSON.parse(text.slice(start, at));
        for (let i = 0; i < parsed.length; i++) {
          const code = parsed.charCodeAt(i);
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = parsed.charCodeAt(++i);
            invariant(next >= 0xdc00 && next <= 0xdfff, 'INVALID_UNICODE');
          } else invariant(code < 0xdc00 || code > 0xdfff, 'INVALID_UNICODE');
        }
        return parsed;
      }
      escaped = c === '\\' && !escaped;
    }
    invariant(false, 'INVALID_JSON', 'unclosed string');
  }
  function value(depth: number): unknown {
    invariant(depth <= 32, 'JSON_DEPTH');
    ws();
    const c = text[at];
    if (c === '"') return string();
    if (c === '{') {
      at++;
      ws();
      const result = Object.create(null);
      const keys = new Set<string>();
      if (text[at] === '}') {
        at++;
        return result;
      }
      while (true) {
        ws();
        invariant(text[at] === '"', 'INVALID_JSON');
        const key = string();
        invariant(
          !keys.has(key) &&
            !['__proto__', 'prototype', 'constructor'].includes(key),
          'DUPLICATE_OR_UNSAFE_KEY',
          key,
        );
        keys.add(key);
        ws();
        invariant(text[at++] === ':', 'INVALID_JSON');
        result[key] = value(depth + 1);
        ws();
        const end = text[at++];
        if (end === '}') return result;
        invariant(end === ',', 'INVALID_JSON');
      }
    }
    if (c === '[') {
      at++;
      ws();
      const out: unknown[] = [];
      if (text[at] === ']') {
        at++;
        return out;
      }
      while (true) {
        out.push(value(depth + 1));
        ws();
        const end = text[at++];
        if (end === ']') return out;
        invariant(end === ',', 'INVALID_JSON');
      }
    }
    const match =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        text.slice(at),
      );
    invariant(match, 'INVALID_JSON');
    at += match[0].length;
    const out = JSON.parse(match[0]);
    invariant(
      typeof out !== 'number' || Number.isFinite(out),
      'INVALID_JSON_NUMBER',
    );
    return out;
  }
  const result = value(0);
  ws();
  invariant(at === text.length, 'INVALID_JSON');
  return result;
}
