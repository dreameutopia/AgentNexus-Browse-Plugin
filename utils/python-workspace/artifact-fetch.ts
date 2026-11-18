import { WORKSPACE_MAX_FILE_BYTES } from './paths';

export class ArtifactSizeLimitError extends Error {
  constructor() {
    super('Resource exceeds the workspace file size limit');
  }
}

/** Bound downloads before and while reading, including responses without Content-Length. */
export async function fetchArtifactBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  const parsed = new URL(url);
  if (!['https:', 'http:', 'data:', 'blob:'].includes(parsed.protocol)) {
    throw new Error('Unsupported resource URL protocol');
  }
  const response = await fetch(url, { signal, credentials: 'include' });
  return readArtifactResponse(response, WORKSPACE_MAX_FILE_BYTES, signal);
}

/** Enforce a caller's inclusive byte limit even when Content-Length is missing. */
export async function readArtifactResponse(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Blob> {
  if (!response.ok) throw new Error('Resource fetch failed: HTTP ' + response.status);
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new ArtifactSizeLimitError();
  }
  const reader = response.body?.getReader();
  if (!reader) return new Blob([], { type: response.headers.get('content-type') || 'application/octet-stream' });
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ArtifactSizeLimitError();
      chunks.push(new Uint8Array(value));
    }
    return new Blob(chunks, { type: response.headers.get('content-type') || 'application/octet-stream' });
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
