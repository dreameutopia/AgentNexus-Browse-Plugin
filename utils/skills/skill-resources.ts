import { isWorkspacePath } from '@/utils/python-workspace/paths';
import { arrayBufferToBase64 } from '@/utils/shared/base64';
import { SKILL_IMPORT_MAX_FILES, SKILL_RESOURCE_MAX_FILE_BYTES, SKILL_RESOURCE_MAX_TOTAL_BYTES, type SkillRecord } from './skill-types';

export function isSkillResourcePath(path: string): boolean {
  return isWorkspacePath(path) && !/^[a-z]:/i.test(path) &&
    !path.split('/').some(part => part === '__proto__');
}

export { arrayBufferToBase64 as encodeSkillBytes };

export function decodeSkillBytes(encoded: string): Uint8Array<ArrayBuffer> {
  if (encoded.length > Math.ceil(SKILL_RESOURCE_MAX_FILE_BYTES / 3) * 4) {
    throw new Error('Skill binary resource exceeds the file size limit');
  }
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
    total += decodeSkillBytes(content).length;
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

export function skillResourceBlob(skill: SkillRecord, path: string): Blob {
  if (!isSkillResourcePath(path)) throw new Error(`Invalid skill resource path: ${JSON.stringify(path)}`);
  if (Object.hasOwn(skill.files, path)) return new Blob([skill.files[path]]);
  if (skill.resourceBytes && Object.hasOwn(skill.resourceBytes, path)) {
    return new Blob([decodeSkillBytes(skill.resourceBytes[path])]);
  }
  throw new Error(`Skill resource does not exist: ${JSON.stringify(path)}`);
}
