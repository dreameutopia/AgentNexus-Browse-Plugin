import { isWorkspacePath } from '@/utils/python-workspace/paths';
import { SKILL_IMPORT_MAX_FILES, SKILL_IMPORT_MAX_FILE_CHARS, SKILL_IMPORT_MAX_TOTAL_CHARS, type SkillRecord } from './skill-types';

export function isSkillResourcePath(path: string): boolean {
  return isWorkspacePath(path) && !/^[a-z]:/i.test(path) &&
    !path.split('/').some(part => part === '__proto__');
}

export function encodeSkillBytes(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  }
  return btoa(chunks.join(''));
}

export function decodeSkillBytes(encoded: string): Uint8Array<ArrayBuffer> {
  if (encoded.length > Math.ceil(SKILL_IMPORT_MAX_FILE_CHARS / 3) * 4) {
    throw new Error('Skill binary resource exceeds the file size limit');
  }
  const raw = atob(encoded);
  if (raw.length > SKILL_IMPORT_MAX_FILE_CHARS) throw new Error('Skill binary resource exceeds the file size limit');
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

export function validateSkillBinaries(value: unknown, files: Record<string, string>): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid skill resource manifest');
  const binaries = Object.entries(value);
  if (binaries.length + Object.keys(files).length > SKILL_IMPORT_MAX_FILES) throw new Error('Too many skill resources');
  const paths = new Set([...Object.keys(files), ...binaries.map(([path]) => path)]);
  let total = Object.values(files).reduce((size, content) => size + new Blob([content]).size, 0);
  for (const [path, content] of binaries) {
    if (!isSkillResourcePath(path) || Object.hasOwn(files, path) || typeof content !== 'string') {
      throw new Error(`Invalid or conflicting skill resource: ${JSON.stringify(path)}`);
    }
    for (const other of paths) {
      if (other.startsWith(path + '/') || path.startsWith(other + '/')) {
        throw new Error(`File and directory conflict: ${JSON.stringify(path)}`);
      }
    }
    total += decodeSkillBytes(content).length;
    if (total > SKILL_IMPORT_MAX_TOTAL_CHARS) throw new Error('Skill resources exceed the total size limit');
  }
  return Object.fromEntries(binaries);
}

export function skillResourcePaths(skill: Pick<SkillRecord, 'files' | 'resourceBytes'>): string[] {
  return [...new Set([...Object.keys(skill.files), ...Object.keys(skill.resourceBytes ?? {})])].sort();
}

export function skillResourceBlob(skill: SkillRecord, path: string): Blob {
  if (!isSkillResourcePath(path)) throw new Error(`Invalid skill resource path: ${JSON.stringify(path)}`);
  if (Object.hasOwn(skill.files, path)) return new Blob([skill.files[path]]);
  if (skill.resourceBytes && Object.hasOwn(skill.resourceBytes, path)) {
    return new Blob([decodeSkillBytes(skill.resourceBytes[path])]);
  }
  throw new Error(`Skill resource does not exist: ${JSON.stringify(path)}`);
}
