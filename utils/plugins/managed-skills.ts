import type { PluginSnapshot } from './contracts';
import { withNamedLock } from '@/utils/shared/async-lock';
import { composeSkillDocument } from '@/utils/skills/skill-authoring';
import { allocateSkillIdentity, isSkillId, isBuiltinSkillId } from '@/utils/skills/skill-identity';
import { getSkillById, setCustomSkill, restoreCustomSkillsFromStorage } from '@/utils/skills/skill-store';
export const MANAGED_SKILLS_KEY = 'agentNexusManagedPluginSkills';
export interface PendingPluginSkill {
    ref: string;
    id: string;
    name: string;
    pluginKey: string;
    pluginName: string;
    acceptedDigest: string;
    version: string;
    pending?: {
        digest: string;
        version: string;
        input: Parameters<typeof setCustomSkill>[0];
    };
}
type State = Record<string, PendingPluginSkill>;
const lock = <T>(work: () => Promise<T>): Promise<T> => withNamedLock(MANAGED_SKILLS_KEY, work);
async function read(): Promise<State> {
    const value = (await chrome.storage.local.get(MANAGED_SKILLS_KEY))[MANAGED_SKILLS_KEY];
    const state: State = Object.create(null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return state;
    for (const [ref, raw] of Object.entries(value)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const item = raw as PendingPluginSkill;
        if (item.ref !== ref || !isSkillId(item.id) || isBuiltinSkillId(item.id) || ![item.name,item.pluginKey,item.pluginName,item.version,item.acceptedDigest].every(field=>typeof field==='string')) continue;
        // chrome.storage.get already returns an isolated structured clone.
        const copy = item;
        const pending = copy.pending;
        if (pending && (typeof pending.digest !== 'string' || typeof pending.version !== 'string' || !pending.input || pending.input.id !== item.id || pending.input.managedIdentity !== 'plugin:'+ref || !pending.input.files || typeof pending.input.files['SKILL.md'] !== 'string')) delete copy.pending;
        state[ref] = copy;
    }
    return state;
}
async function digest(value: unknown): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Package installation never overwrites accepted local experience. Changed upstream content is staged. */
export async function reconcilePluginSkills(snapshot: PluginSnapshot): Promise<void> {
    await lock(async () => {
        await restoreCustomSkillsFromStorage(true);
        const state = await read();
        const knownPackagesValue = (await chrome.storage.local.get(MANAGED_SKILLS_KEY + ':packages'))[MANAGED_SKILLS_KEY + ':packages'];
        const knownPackages = new Set<string>(Array.isArray(knownPackagesValue) ? knownPackagesValue.filter((key): key is string => typeof key === 'string') : Object.values(state).map(item => item.pluginKey));
        for (const pkg of snapshot.packages.filter(pkg => !pkg.quarantined))
            for (const skill of pkg.skills) {
                const id = await allocateSkillIdentity('plugin:' + skill.ref);
                const metadata = { name: skill.name, description: skill.description, allowed_tools: skill.allowedTools.map(ref => ref.startsWith('builtin/') ? ref.slice(8) : ref), category: skill.category, tags: skill.tags };
                const files = { ...skill.files, 'SKILL.md': composeSkillDocument(metadata, skill.body) };
                const hash = await digest([metadata, skill.body, Object.entries(files).sort(), Object.entries(skill.resourceBytes ?? {}).sort()]);
                const input: Parameters<typeof setCustomSkill>[0] = {
                    id, managedIdentity: 'plugin:' + skill.ref, name: skill.name, files, resourceBytes: skill.resourceBytes ?? {},
                    origin: { pluginKey: pkg.key, ref: skill.ref, version: pkg.manifest.version, digest: hash },
                };
                const existing = state[skill.ref];
                if (existing) {
                    existing.name = skill.name;
                    existing.pluginName = pkg.manifest.displayName;
                }
                if (!existing && (knownPackages.has(pkg.key) || getSkillById(id))) {
                    state[skill.ref] = { ref: skill.ref, id, name: skill.name, pluginKey: pkg.key, pluginName: pkg.manifest.displayName, acceptedDigest: '', version: '', pending: { digest: hash, version: pkg.manifest.version, input } };
                }
                else if (!existing) {
                    const result = await setCustomSkill(input);
                    if (!result.ok)
                        throw new Error('Managed plugin Skill import failed: ' + result.reason);
                    state[skill.ref] = { ref: skill.ref, id, name: skill.name, pluginKey: pkg.key, pluginName: pkg.manifest.displayName, acceptedDigest: hash, version: pkg.manifest.version };
                }
                else if (existing.acceptedDigest !== hash) {
                    existing.pending = { digest: hash, version: pkg.manifest.version, input };
                }
                else {
                    delete existing.pending;
                }
            }
        await chrome.storage.local.set({ [MANAGED_SKILLS_KEY]: state, [MANAGED_SKILLS_KEY + ':packages']: [...new Set([...knownPackages, ...snapshot.packages.map(pkg => pkg.key)])] });
    });
}
export type PluginSkillUpdateSummary = Omit<PendingPluginSkill, 'pending'> & { pending: { digest: string; version: string }; localUpdatedAt: number | null };
export async function pendingPluginSkillUpdateSummaries(): Promise<PluginSkillUpdateSummary[]> {
    await restoreCustomSkillsFromStorage();
    return Object.values(await read()).filter(item => item.pending).map(({ pending, ...item }) => ({ ...item, pending: { digest: pending!.digest, version: pending!.version }, localUpdatedAt: getSkillById(item.id)?.updatedAt ?? null }));
}
export async function pendingPluginSkillUpdates(ref?: string): Promise<Array<PendingPluginSkill & {
    localUpdatedAt: number | null;
    localContent: string;
    incomingContent: string;
    resourceChanges: Array<{
        path: string;
        kind: string;
        oldText: string;
        newText: string;
    }>;
}>> {
    await restoreCustomSkillsFromStorage();
    return Object.values(await read()).filter(item => item?.pending?.input && typeof item.id === 'string' && (ref === undefined || item.ref === ref)).map(item => ({ ...item, localUpdatedAt: getSkillById(item.id)?.updatedAt ?? null, localContent: getSkillById(item.id)?.files['SKILL.md'] ?? '', incomingContent: item.pending!.input.files['SKILL.md'] ?? '', resourceChanges: resourceChanges(getSkillById(item.id), item.pending!.input) }));
}
export async function approvePluginSkillUpdate(ref: string, expectedDigest: string, expectedLocalUpdatedAt: number | null): Promise<void> {
    await lock(async () => {
        const state = await read(), item = state[ref];
        if (!item?.pending || item.pending.digest !== expectedDigest)
            throw new Error('待批准的技能版本已变化，请刷新后重新审阅');
        await restoreCustomSkillsFromStorage(true);
        const local = getSkillById(item.id);
        if ((local?.updatedAt ?? null) !== expectedLocalUpdatedAt)
            throw new Error('本地 Skill 在审阅后发生变化，请刷新后重新审阅');
        const result = await setCustomSkill({ ...item.pending.input, enabled: local?.enabled ?? true, expectedUpdatedAt: local?.updatedAt });
        if (!result.ok)
            throw new Error('Skill update failed: ' + result.reason);
        item.acceptedDigest = item.pending.digest;
        item.version = item.pending.version;
        delete item.pending;
        await chrome.storage.local.set({ [MANAGED_SKILLS_KEY]: state });
    });
}
function resourceChanges(local: ReturnType<typeof getSkillById>, incoming: Parameters<typeof setCustomSkill>[0]) {
    const oldFiles = { ...local?.files, ...local?.resourceBytes }, nextFiles = { ...incoming.files, ...incoming.resourceBytes };
    return [...new Set([...Object.keys(oldFiles), ...Object.keys(nextFiles)])].filter(path => path !== 'SKILL.md' && oldFiles[path] !== nextFiles[path]).sort().map(path => ({
        path, kind: !Object.hasOwn(oldFiles, path) ? 'added' : !Object.hasOwn(nextFiles, path) ? 'removed' : 'changed',
        oldText: local?.resourceBytes?.[path] ? '[binary: ' + oldFiles[path].length + ' base64 characters]' : (oldFiles[path] ?? '').slice(0, 20000),
        newText: incoming.resourceBytes?.[path] ? '[binary: ' + nextFiles[path].length + ' base64 characters]' : (nextFiles[path] ?? '').slice(0, 20000),
    }));
}
