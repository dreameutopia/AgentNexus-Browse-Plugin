import { readBoundedZip, ZipReadError } from '../shared/bounded-zip';
import { invariant, LIMITS } from './contracts';

export function safePath(path: string): void {
  invariant(
    path.length <= 240 &&
      /^[a-zA-Z0-9_./-]+$/.test(path) &&
      !path.startsWith('/') &&
      !path.endsWith('/') &&
      path.split('/').length <= LIMITS.depth &&
      path.split('/').every(part =>
        part && part !== '.' && part !== '..' && !part.endsWith('.') &&
        !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      ),
    'UNSAFE_PATH',
    path,
  );
}

export function readArchive(bytes: Uint8Array): Map<string, Uint8Array> {
  const folded = new Set<string>();
  try {
    return readBoundedZip(bytes, {
      ...LIMITS,
      accept(path, size) {
        safePath(path);
        const lower = path.toLowerCase();
        invariant(!folded.has(lower) && size <= LIMITS.file, 'ZIP_LIMIT_OR_DUPLICATE', path);
        folded.add(lower);
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ZipReadError) invariant(false, error.code, error.detail);
    throw error;
  }
}
