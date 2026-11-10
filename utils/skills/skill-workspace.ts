import { stageWorkspaceResources } from '@/utils/python-workspace/store';
import type { WorkspaceEntry } from '@/utils/python-workspace/paths';
import { isSkillResourcePath, skillResourceBlob, skillResourcePaths } from './skill-resources';
import { SKILL_IMPORT_MAX_FILES, SKILL_RESOURCE_MAX_FILE_BYTES, SKILL_RESOURCE_MAX_TOTAL_BYTES, type SkillRecord } from './skill-types';

async function sha256(blob: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function copySkillToWorkspace(
  chatId: string,
  skill: SkillRecord,
  selectors: unknown,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!Array.isArray(selectors) || !selectors.length || selectors.length > SKILL_IMPORT_MAX_FILES ||
      !selectors.every(path => typeof path === 'string' && (path === '.' || isSkillResourcePath(path)))) {
    throw new Error('paths must contain skill-relative file or directory paths, or "." for the whole skill');
  }
  const paths = skillResourcePaths(skill);
  const folders = (skill.folders ?? []).filter(isSkillResourcePath);
  if (paths.length + folders.length > SKILL_IMPORT_MAX_FILES) throw new Error('Skill has too many workspace resources');
  const matched = new Set<string>();
  const selectedFolders = new Set<string>();
  for (const selector of selectors) {
    const includes = (path: string) => selector === '.' || path === selector || path.startsWith(selector + '/');
    const files = paths.filter(includes);
    const directories = folders.filter(includes);
    if (!files.length && !directories.length) throw new Error(`Skill resource not found: ${JSON.stringify(selector)}`);
    for (const path of files) matched.add(path);
    for (const path of directories) selectedFolders.add(path);
  }

  const files: Array<{ path: string; blob: Blob; hash: string }> = [];
  let total = 0;
  for (const path of paths) {
    signal?.throwIfAborted();
    const blob = skillResourceBlob(skill, path);
    total += blob.size;
    if (blob.size > SKILL_RESOURCE_MAX_FILE_BYTES || total > SKILL_RESOURCE_MAX_TOTAL_BYTES) {
      throw new Error('Skill resources exceed the workspace import size limit');
    }
    files.push({ path, blob, hash: await sha256(blob) });
  }
  const id = await sha256(new Blob([skill.id]));
  const revision = await sha256(new Blob([JSON.stringify([
    files.map(({ path, hash }) => [path, hash]), [...folders].sort(),
  ])]));
  const workspacePath = `skills/${id.slice(0, 32)}/${revision.slice(0, 32)}`;
  const resources: WorkspaceEntry[] = files.filter(file => matched.has(file.path)).map(({ path, blob, hash }) => ({
    path: workspacePath + '/' + path, blob, importId: 'skill:' + revision + ':' + hash,
  }));
  const directories = [...selectedFolders].sort().map(path => workspacePath + '/' + path);
  await stageWorkspaceResources(chatId, [...resources, ...directories.map(path => ({ path, blob: null }))], signal);
  return { workspacePath, files: resources.map(entry => entry.path), directories };
}
