import { isSkillId } from './skill-identity';
import { chatDatabase } from '@/entrypoints/sidepanel/core/context/chat-database';
import { saveWorkspace, withWorkspaceLock, type WorkspaceCommitGuard } from '@/utils/python-workspace/store';
import { indexWorkspaceEntries, workspaceRoot, type WorkspaceEntry } from '@/utils/python-workspace/paths';
import { isSkillResourcePath, skillResourceBlob, skillResourcePaths } from './skill-resources';
import { SKILL_IMPORT_MAX_FILES, SKILL_RESOURCE_MAX_FILE_BYTES, SKILL_RESOURCE_MAX_TOTAL_BYTES, type SkillRecord } from './skill-types';
/** Copy only requested resources. Preserve every existing workspace file, including modified copies. */
export async function copySkillToWorkspace(chatId: string, skill: SkillRecord, selectors: unknown, signal?: AbortSignal, authorizeCommit: WorkspaceCommitGuard = commit => commit()) {
    signal?.throwIfAborted();
    if (!isSkillId(skill.id))
        throw new Error('Skill must have a registered numeric ID');
    if (!Array.isArray(selectors) || !selectors.length || selectors.length > SKILL_IMPORT_MAX_FILES || !selectors.every(path => typeof path === 'string' && (path === '.' || isSkillResourcePath(path))))
        throw new Error('paths must be exact skill-relative files/directories, or "."');
    const selected = new Set<string>(), folders = new Set<string>();
    const resourcePaths = skillResourcePaths(skill);
    for (const selector of selectors) {
        const matches = (path: string) => selector === '.' || path === selector || path.startsWith(selector + '/');
        const files = resourcePaths.filter(matches), dirs = (skill.folders ?? []).filter(matches);
        if (!files.length && !dirs.length)
            throw new Error('Skill resource does not exist: ' + selector);
        files.forEach(path => selected.add(path));
        dirs.forEach(path => folders.add(path));
    }
    if (selected.size + folders.size > SKILL_IMPORT_MAX_FILES)
        throw new Error('Too many skill resources');
    let bytes = 0;
    const resources: WorkspaceEntry[] = [...selected].map(path => {
        const blob = skillResourceBlob(skill, path);
        bytes += blob.size;
        if (blob.size > SKILL_RESOURCE_MAX_FILE_BYTES || bytes > SKILL_RESOURCE_MAX_TOTAL_BYTES)
            throw new Error('Skill resources exceed copy limits');
        return { path, blob, mtime: Date.now() };
    });
    return withWorkspaceLock(chatId, async () => {
        signal?.throwIfAborted();
        const snapshot = await chatDatabase.readWorkspace(chatId, signal);
        const entries = indexWorkspaceEntries(workspaceRoot(chatId), snapshot?.entries ?? []);
        const occupied = (base: string) => [...resources.map(file => file.path), ...folders].some(relative => {
            const path = base ? base + '/' + relative : relative;
            if (entries.has(path))
                return true;
            for (let end = path.lastIndexOf('/'); end >= 0; end = path.lastIndexOf('/', end - 1)) {
                const parent = entries.get(path.slice(0, end));
                if (parent?.blob || parent?.link)
                    return true;
            }
            return false;
        });
        let workspacePath = '';
        if (occupied('')) {
            workspacePath = skill.id;
            for (let copy = 2; occupied(workspacePath); copy++) {
                const root = entries.get(skill.id);
                if (root?.blob || root?.link || copy > 10000)
                    throw new Error('Skill ID workspace directory is occupied or exhausted');
                workspacePath = skill.id + '/copy-' + copy;
            }
        }
        const files = resources.map(resource => ({ ...resource, path: workspacePath ? workspacePath + '/' + resource.path : resource.path }));
        const directories = [...folders].map(path => workspacePath ? workspacePath + '/' + path : path);
        for (const entry of [...files, ...directories.map(path => ({ path, blob: null }))]) {
            entries.set(entry.path, entry);
            for (let end = entry.path.lastIndexOf('/'); end >= 0; end = entry.path.lastIndexOf('/', end - 1)) {
                const path = entry.path.slice(0, end);
                if (!entries.has(path))
                    entries.set(path, { path, blob: null });
            }
        }
        await authorizeCommit(() => saveWorkspace(chatId, snapshot?.revision, [...entries.values()], signal));
        return { workspacePath: workspacePath || '.', files: files.map(file => file.path), directories };
    }, signal);
}
