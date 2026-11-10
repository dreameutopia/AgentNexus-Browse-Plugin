import { strFromU8, Unzip, UnzipInflate } from 'fflate';

export class ZipReadError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(detail ? code + ': ' + detail : code);
    this.name = 'ZipReadError';
  }
}

function invariant(condition: unknown, code: string, detail?: string): asserts condition {
  if (!condition) throw new ZipReadError(code, detail);
}

interface ZipPolicy {
  archive: number;
  expanded: number;
  files: number;
  allowEmpty?: boolean;
  accept: (path: string, size: number) => boolean;
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
export function readBoundedZip(bytes: Uint8Array, policy: ZipPolicy): Map<string, Uint8Array> {
  invariant(
    bytes.byteLength >= 22 && bytes.byteLength <= policy.archive,
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
    (count > 0 || policy.allowEmpty) &&
      count <= policy.files &&
      view.getUint16(end + 8, true) === count &&
      central + centralSize === end,
    'ZIP_LIMIT',
  );
  const expected = new Map<string, { size: number; crc: number; accept: boolean }>();
  const ranges: Array<[number, number]> = [];
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let cursor = central,
    declared = 0;
  for (let i = 0; i < count; i++) {
    invariant(
      cursor + 46 <= end && view.getUint32(cursor, true) === 0x02014b50,
      'INVALID_ZIP',
    );
    const flags = view.getUint16(cursor + 8, true),
      method = view.getUint16(cursor + 10, true),
      crc = view.getUint32(cursor + 16, true),
      compressed = view.getUint32(cursor + 20, true),
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
      path = flags & 2048 ? decoder.decode(nameBytes) : strFromU8(nameBytes, true);
    invariant(!expected.has(path), 'ZIP_LIMIT_OR_DUPLICATE', path);
    const accept = policy.accept(path, size);
    invariant(
      !accept || (declared += size) <= policy.expanded,
      'ZIP_EXPANSION_LIMIT',
      path,
    );
    invariant(
      offset + 30 <= central &&
        view.getUint32(offset, true) === 0x04034b50 &&
        view.getUint16(offset + 8, true) === method &&
        view.getUint16(offset + 6, true) === flags,
      'INVALID_LOCAL_HEADER',
    );
    const localLen = view.getUint16(offset + 26, true);
    const dataEnd = offset + 30 + localLen + view.getUint16(offset + 28, true) + compressed;
    invariant(
      localLen === len &&
        dataEnd <= central &&
        nameBytes.every((byte, index) => bytes[offset + 30 + index] === byte),
      'ZIP_PATH_MISMATCH',
    );
    invariant((flags & 8) || (
      view.getUint32(offset + 14, true) === crc &&
      view.getUint32(offset + 18, true) === compressed &&
      view.getUint32(offset + 22, true) === size
    ), 'ZIP_LOCAL_SIZE_MISMATCH', path);
    ranges.push([offset, dataEnd]);
    expected.set(path, { size, crc, accept });
    cursor += 46 + len + extra + comment;
  }
  invariant(cursor === end, 'INVALID_ZIP');
  ranges.sort((a, b) => a[0] - b[0]);
  invariant(ranges.every(([start], index) => index === 0 || start >= ranges[index - 1][1]), 'ZIP_OVERLAPPING_ENTRIES');
  const files = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  let acceptedCount = 0;
  let total = 0;
  let failure: unknown;
  const unzip = new Unzip((file) => {
    try {
      const entry = expected.get(file.name);
      invariant(entry && !seen.has(file.name), 'ZIP_UNLISTED_ENTRY');
      seen.add(file.name);
      if (!entry.accept) return;
      acceptedCount++;
      const chunks: Uint8Array[] = [];
      let size = 0;
      file.ondata = (err, data, final) => {
        try {
          if (err) throw err;
          size += data.length;
          total += data.length;
          invariant(
            size <= entry.size && total <= policy.expanded,
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
  invariant(seen.size === expected.size && files.size === acceptedCount, 'ZIP_INCOMPLETE');
  return files;
}
