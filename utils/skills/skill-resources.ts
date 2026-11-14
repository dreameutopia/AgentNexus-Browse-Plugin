import { isWorkspacePath } from '@/utils/python-workspace/paths';
import { arrayBufferToBase64 } from '@/utils/shared/base64';
import { SKILL_IMPORT_MAX_FILES, SKILL_RESOURCE_MAX_FILE_BYTES, SKILL_RESOURCE_MAX_TOTAL_BYTES, type SkillRecord } from './skill-types';

export function isSkillResourcePath(path: string): boolean {
  return isWorkspacePath(path) && !/^[a-z]:/i.test(path) &&
    !path.split('/').some(part => part === '__proto__');
}

export { arrayBufferToBase64 as encodeSkillBytes };

/** Validate the encoded manifest without allocating decoded resources on every restore. */
function binarySize(encoded: string): number {
  if (encoded.length > Math.ceil(SKILL_RESOURCE_MAX_FILE_BYTES / 3) * 4) {
    throw new Error('Skill binary resource exceeds the file size limit');
  }
  if (encoded.length % 4 !== 0) throw new Error('Invalid skill binary resource encoding');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const end = encoded.length - padding;
  for (let i = 0; i < end; i++) {
    const code = encoded.charCodeAt(i);
    if (!(code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 || code === 43 || code === 47))
      throw new Error('Invalid skill binary resource encoding');
  }
  const size = encoded.length / 4 * 3 - padding;
  if (size > SKILL_RESOURCE_MAX_FILE_BYTES) throw new Error('Skill binary resource exceeds the file size limit');
  return size;
}

export function decodeSkillBytes(encoded: string): Uint8Array<ArrayBuffer> {
  binarySize(encoded);
  const raw = atob(encoded);
  if (raw.length > SKILL_RESOURCE_MAX_FILE_BYTES) throw new Error('Skill binary resource exceeds the file size limit');
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function decodeSkillText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

export function validateSkillBinaries(value: unknown, files: Record<string, string>): Record<string, string> {
  if (value === undefined) value = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid skill resource manifest');
  const binaries = Object.entries(value);
  if (binaries.length + Object.keys(files).length > SKILL_IMPORT_MAX_FILES) throw new Error('Too many skill resources');
  const paths = new Set([...Object.keys(files), ...binaries.map(([path]) => path)]);
  let total = Object.values(files).reduce((size, content) => size + new Blob([content]).size, 0);
  if (total > SKILL_RESOURCE_MAX_TOTAL_BYTES) throw new Error('Skill resources exceed the total size limit');
  for (const [path, content] of binaries) {
    if (!isSkillResourcePath(path) || Object.hasOwn(files, path) || typeof content !== 'string') {
      throw new Error(`Invalid or conflicting skill resource: ${JSON.stringify(path)}`);
    }
    total += binarySize(content);
    if (total > SKILL_RESOURCE_MAX_TOTAL_BYTES) throw new Error('Skill resources exceed the total size limit');
  }
  for (const path of paths) {
    for (let slash = path.lastIndexOf('/'); slash >= 0; slash = path.lastIndexOf('/', slash - 1)) {
      if (paths.has(path.slice(0, slash))) throw new Error(`File and directory conflict: ${JSON.stringify(path)}`);
    }
  }
  return Object.fromEntries(binaries);
}

export function skillResourcePaths(skill: Pick<SkillRecord, 'files' | 'resourceBytes'>): string[] {
  return [...new Set([...Object.keys(skill.files), ...Object.keys(skill.resourceBytes ?? {})])].sort();
}

export function validateSkillFolders(raw: unknown, files: Record<string, string>, resourceBytes: Record<string, string> = {}): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > SKILL_IMPORT_MAX_FILES || !raw.every(path => typeof path === 'string' && isSkillResourcePath(path))) throw new Error('Invalid Skill directory manifest');
  const paths = new Set([...Object.keys(files), ...Object.keys(resourceBytes)]);
  const folders: string[] = [...new Set<string>(raw)];
  for (const folder of folders) {
    if (paths.has(folder)) throw new Error('File and directory conflict: ' + folder);
    for (let slash = folder.lastIndexOf('/'); slash >= 0; slash = folder.lastIndexOf('/', slash - 1)) if (paths.has(folder.slice(0, slash))) throw new Error('Directory parent is a file: ' + folder);
  }
  return folders;
}

export function skillResourceBlob(skill: SkillRecord, path: string): Blob {
  if (!isSkillResourcePath(path)) throw new Error(`Invalid skill resource path: ${JSON.stringify(path)}`);
  if (Object.hasOwn(skill.files, path)) return new Blob([skill.files[path]]);
  if (skill.resourceBytes && Object.hasOwn(skill.resourceBytes, path)) {
    return new Blob([decodeSkillBytes(skill.resourceBytes[path])]);
  }
  throw new Error(`Skill resource does not exist: ${JSON.stringify(path)}`);
}
