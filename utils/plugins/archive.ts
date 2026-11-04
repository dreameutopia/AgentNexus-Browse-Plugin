import { Unzip, UnzipInflate } from 'fflate';
import { invariant, LIMITS } from './contracts';

export function safePath(path: string): void {
  invariant(
    path.length <= 240 &&
      /^[a-zA-Z0-9_./-]+$/.test(path) &&
      !path.startsWith('/') &&
      !path.endsWith('/') &&
      path.split('/').length <= LIMITS.depth &&
      path
        .split('/')
        .every(
          (p) =>
            p &&
            p !== '.' &&
            p !== '..' &&
            !p.endsWith('.') &&
            !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p),
        ),
    'UNSAFE_PATH',
    path,
  );
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Preflight central directory, then enforce actual streaming expansion limits. No unzipSync. */
export function readArchive(bytes: Uint8Array): Map<string, Uint8Array> {
  invariant(
    bytes.byteLength >= 22 && bytes.byteLength <= LIMITS.archive,
    'ARCHIVE_LIMIT',
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--)
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === bytes.length
    ) {
      end = i;
      break;
    }
  invariant(
    end >= 0 &&
      view.getUint16(end + 4, true) === 0 &&
      view.getUint16(end + 6, true) === 0,
    'INVALID_ZIP',
  );
  const count = view.getUint16(end + 10, true),
    centralSize = view.getUint32(end + 12, true),
    central = view.getUint32(end + 16, true);
  invariant(
    count > 0 &&
      count <= LIMITS.files &&
      view.getUint16(end + 8, true) === count &&
      central + centralSize === end,
    'ZIP_LIMIT',
  );
  const expected = new Map<string, { size: number; crc: number }>();
  const folded = new Set<string>();
  let cursor = central,
    declared = 0;
  for (let i = 0; i < count; i++) {
    invariant(
      cursor + 46 <= end && view.getUint32(cursor, true) === 0x02014b50,
      'INVALID_ZIP',
    );
    const flags = view.getUint16(cursor + 8, true),
      method = view.getUint16(cursor + 10, true),
      size = view.getUint32(cursor + 24, true);
    const len = view.getUint16(cursor + 28, true),
      extra = view.getUint16(cursor + 30, true),
      comment = view.getUint16(cursor + 32, true);
    const mode = view.getUint32(cursor + 38, true) >>> 16,
      offset = view.getUint32(cursor + 42, true);
    invariant(
      cursor + 46 + len + extra + comment <= end &&
        !(flags & 1) &&
        [0, 8].includes(method) &&
        (mode & 0xf000) !== 0xa000 &&
        view.getUint16(cursor + 34, true) === 0,
      'UNSUPPORTED_ZIP',
    );
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + len),
      path = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    safePath(path);
    invariant(
      !folded.has(path.toLowerCase()) &&
        size <= LIMITS.file &&
        (declared += size) <= LIMITS.expanded,
      'ZIP_LIMIT_OR_DUPLICATE',
      path,
    );
    folded.add(path.toLowerCase());
    invariant(
      offset + 30 <= central &&
        view.getUint32(offset, true) === 0x04034b50 &&
        view.getUint16(offset + 8, true) === method &&
        view.getUint16(offset + 6, true) === flags,
      'INVALID_LOCAL_HEADER',
    );
    const localLen = view.getUint16(offset + 26, true);
    invariant(
      localLen === len &&
        new TextDecoder().decode(
          bytes.subarray(offset + 30, offset + 30 + localLen),
        ) === path,
      'ZIP_PATH_MISMATCH',
    );
    expected.set(path, { size, crc: view.getUint32(cursor + 16, true) });
    cursor += 46 + len + extra + comment;
  }
  invariant(cursor === end, 'INVALID_ZIP');
  const files = new Map<string, Uint8Array>();
  let total = 0;
  let failure: unknown;
  const unzip = new Unzip((file) => {
    try {
      const entry = expected.get(file.name);
      invariant(entry && !files.has(file.name), 'ZIP_UNLISTED_ENTRY');
      const chunks: Uint8Array[] = [];
      let size = 0;
      file.ondata = (err, data, final) => {
        try {
          if (err) throw err;
          size += data.length;
          total += data.length;
          invariant(
            size <= entry.size && total <= LIMITS.expanded,
            'ZIP_EXPANSION_LIMIT',
          );
          chunks.push(data);
          if (final) {
            invariant(size === entry.size, 'ZIP_SIZE_MISMATCH');
            const out = new Uint8Array(size);
            let at = 0;
            for (const chunk of chunks) {
              out.set(chunk, at);
              at += chunk.length;
            }
            invariant(crc32(out) === entry.crc, 'ZIP_CRC_MISMATCH');
            files.set(file.name, out);
          }
        } catch (error) {
          failure = error;
          file.terminate();
        }
      };
      file.start();
    } catch (error) {
      failure = error;
      file.terminate();
    }
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    unzip.push(
      bytes.subarray(offset, offset + 4096),
      offset + 4096 >= bytes.length,
    );
    if (failure) throw failure;
  }
  invariant(files.size === expected.size, 'ZIP_INCOMPLETE');
  return files;
}
