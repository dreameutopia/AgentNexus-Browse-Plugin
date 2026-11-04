import { invariant } from './contracts';

export function publicHttps(value: string): URL {
  const url = new URL(value);
  invariant(
    url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.hostname.includes(':') &&
      !/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(
        url.hostname,
      ) &&
      !/^\d+(?:\.\d+){3}$/.test(url.hostname),
    'NETWORK_TARGET_REJECTED',
    url.hostname,
  );
  return url;
}
export async function limitedDownload(
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
  allowRedirects = false,
): Promise<Uint8Array> {
  publicHttps(url);
  const timeout = AbortSignal.timeout(30_000),
    combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(url, {
    signal: combined,
    credentials: 'omit',
    redirect: allowRedirects ? 'follow' : 'error',
    referrerPolicy: 'no-referrer',
  });
  invariant(
    response.ok && response.body,
    'DOWNLOAD_FAILED',
    `HTTP ${response.status}`,
  );
  if (allowRedirects) publicHttps(response.url);
  invariant(
    Number(response.headers.get('content-length') ?? 0) <= maxBytes,
    'DOWNLOAD_LIMIT',
  );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      invariant(length <= maxBytes, 'DOWNLOAD_LIMIT');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return bytes;
}
