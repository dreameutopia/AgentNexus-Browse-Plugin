import { isSkillId } from '@/utils/skills/skill-identity';
import { withNamedLock } from '@/utils/shared/async-lock';
/** Extra Skill associations for built-in, custom and plugin agents; never rewrites package contributions. */
const KEY = 'agentNexusAgentSkillLinks';
let links: Record<string, string[]> = Object.create(null);
let restoreVersion = 0;
const listeners = new Set<() => void>();
export const onAgentSkillLinksChange = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const notify = () => listeners.forEach(listener => { try {
    listener();
}
catch (error) {
    console.warn('[AgentSkillLinks] Listener failed', error);
} });
export const linkedSkillIds = (agentId: string): string[] => [...(links[agentId] ?? [])];
export async function restoreAgentSkillLinks(): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage?.local)
        return;
    const version = ++restoreVersion;
    const value = (await chrome.storage.local.get(KEY))[KEY];
    if (version !== restoreVersion) return;
    const previous = JSON.stringify(links);
    links = Object.create(null);
    if (value && typeof value === 'object' && !Array.isArray(value))
        for (const [id, refs] of Object.entries(value)) {
            if (Array.isArray(refs))
                links[id] = [...new Set(refs.filter((ref): ref is string => isSkillId(ref)))];
        }
    if (previous !== JSON.stringify(links))
        notify();
}
export async function replaceAgentSkillLinks(agentId: string, ids: readonly string[]): Promise<void> { return writeLinks(agentId, () => [...new Set(ids.filter(isSkillId))]); }
/** Commit new Skill records and their agent association in the same Chrome storage write. */
export async function withAgentSkillAssociation<T>(agentId: string, skillId: string, commit: (patch: Record<string, unknown>) => Promise<T>): Promise<T> {
    if (!agentId || !isSkillId(skillId)) throw new Error('[SKILL_ASSOCIATION_INVALID] Missing agent or numeric Skill ID');
    return commitLinks(agentId, previous => [...new Set([...previous, skillId])], commit);
}
async function writeLinks(agentId: string | undefined, update: (previous: string[]) => string[]): Promise<void> {
    if (!agentId) throw new Error('[SKILL_ASSOCIATION_INVALID] Missing agent ID');
    return commitLinks(agentId, update, patch => chrome.storage.local.set(patch));
}
async function commitLinks<T>(agentId: string, update: (previous: string[]) => string[], commit: (patch: Record<string, unknown>) => Promise<T>): Promise<T> {
    return withNamedLock(KEY, async () => {
        await restoreAgentSkillLinks();
        const next = Object.assign(Object.create(null), links, { [agentId]: update(links[agentId] ?? []) });
        const result = await commit({ [KEY]: next });
        restoreVersion++;
        links = next;
        notify();
        return result;
    });
}
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged)
    chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes[KEY])
        void restoreAgentSkillLinks().catch(error => console.warn('[AgentSkillLinks] Restore failed', error)); });
