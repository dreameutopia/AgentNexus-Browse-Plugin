/** Durable decimal Skill identities. IndexedDB readwrite transactions serialize every context. */
// ID 1 曾分配给内置 Bilibili 视频总结技能；该技能已迁移到官方插件，
// 编号刻意保留空缺，不重排其余内置技能（重排会破坏已持久化的技能引用）。
export const BUILTIN_SKILL_IDS = Object.freeze({
    'web-research-report': '2', 'xlsx-creator': '3',
    'skill-create': '4', 'skill-edit': '5',
    'website-task-learn': '6',
} as const);
/** 网站任务学习技能的稳定 ID（仅由学习页程序化选中，不进入全局默认注入） */
export const WEBSITE_TASK_LEARN_SKILL_ID = BUILTIN_SKILL_IDS['website-task-learn'];
export const BUILTIN_SKILL_MAX_ID = 1000;
export const isSkillId = (id: unknown): id is string => typeof id === 'string' && /^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id));
export const isBuiltinSkillId = (id: string): boolean => isSkillId(id) && Number(id) <= BUILTIN_SKILL_MAX_ID;
let database: Promise<IDBDatabase> | undefined;
// Committed identity bindings are immutable; avoid rereading them for every tool operation.
const committed = new Map<string, string>();
function open(): Promise<IDBDatabase> {
    return database ??= new Promise((resolve, reject) => {
        let abandoned = false;
        const request = indexedDB.open('AgentNexusSkillIdentities', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('identities');
        request.onerror = () => { if (!abandoned) { database = undefined; reject(request.error); } };
        request.onblocked = () => { abandoned = true; database = undefined; reject(new Error('[SKILL_ID_STORAGE_BLOCKED] Close older extension pages and retry the Skill operation')); };
        request.onsuccess = () => {
            if (abandoned) { request.result.close(); return; }
            const reset = () => { request.result.close(); database = undefined; committed.clear(); };
            request.result.onversionchange = reset;
            request.result.onclose = reset;
            resolve(request.result);
        };
    });
}
export async function allocateSkillIdentity(key: string, preferred?: string): Promise<string> {
    if (!key || key.length > 2048)
        throw new Error('Invalid Skill identity key');
    const cached = committed.get(key);
    if (cached) return cached;
    const db = await open();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('identities', 'readwrite'), store = tx.objectStore('identities');
        let result = '';
        const read = (key: string) => new Promise<any>((done, fail) => { const request = store.get(key); request.onsuccess = () => done(request.result); request.onerror = () => fail(request.error); });
        tx.oncomplete = () => { committed.set(key, result); resolve(result); };
        tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Skill identity transaction failed'));
        void (async () => {
            const current = await read('key:' + key);
            if (isSkillId(current) && !isBuiltinSkillId(current)) {
                result = current;
                return;
            }
            let next = await read('next');
            if (!Number.isSafeInteger(next) || next < 1001)
                next = 1001;
            const preferredOwner = preferred && isSkillId(preferred) && !isBuiltinSkillId(preferred) ? await read('id:' + preferred) : undefined;
            if (preferred && isSkillId(preferred) && !isBuiltinSkillId(preferred) && (!preferredOwner || preferredOwner === key))
                result = preferred;
            else {
                for (let attempts = 0; attempts < 10000; attempts++, next++) {
                    if (!Number.isSafeInteger(next))
                        throw new Error('Skill ID space exhausted');
                    if (!await read('id:' + next)) {
                        result = String(next);
                        break;
                    }
                }
                if (!result)
                    throw new Error('Skill ID allocation exhausted');
            }
            store.put(result, 'key:' + key);
            store.put(key, 'id:' + result);
            store.put(Math.max(next, Number(result) + 1), 'next');
        })().catch(error => { try {
            tx.abort();
        }
        catch { } reject(error); });
    });
}
export function builtinSkillId(name: string): string {
    const id = Object.hasOwn(BUILTIN_SKILL_IDS, name) ? BUILTIN_SKILL_IDS[name as keyof typeof BUILTIN_SKILL_IDS] : undefined;
    if (!id)
        throw new Error('Bundled Skill must be registered in BUILTIN_SKILL_IDS: ' + name);
    return id;
}
