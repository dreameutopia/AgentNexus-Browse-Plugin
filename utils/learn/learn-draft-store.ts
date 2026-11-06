/** Durable, id-addressed learning outbox. No read-and-delete, TTL, or shared overwrite slot. */
import { LEARN_DRAFT_STORAGE_KEY, type SkillDraft, type LearnDraftTransfer, type LearnDraftEditorState } from './learn-types';
import { asSkillDraft } from './learn-validate';
import { SKILL_IMPORT_MAX_TOTAL_CHARS } from '@/utils/skills/skill-types';

export const LEARN_TRANSFER_PREFIX = 'agentNexusLearnTransfer:';
export const LEARN_TRANSFER_MARKER = 'x-agentnexus-learn-transfer';
export const isLearnTransferId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9-]{1,100}$/.test(id);
type Failure = { ok: false; error: string };
const failure = (error: unknown): Failure => ({ ok: false, error: error instanceof Error ? error.message : String(error) });
const localWrites = new Map<string, Promise<unknown>>();

function area() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) throw new Error('chrome.storage.local unavailable');
  return chrome.storage.local;
}

async function locked<T>(id: string, work: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(`learn-transfer-write:${id}`, work);
  const previous = localWrites.get(id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  localWrites.set(id, next);
  try { return await next; } finally { if (localWrites.get(id) === next) localWrites.delete(id); }
}

function valid(value: unknown): value is LearnDraftTransfer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as LearnDraftTransfer;
  return p.version === 2 && isLearnTransferId(p.id) && typeof p.sourceChatId === 'string' &&
    Number.isFinite(p.createdAt) && p.createdAt >= 0 && !!asSkillDraft(p.draft) && p.draft.allowedTools.length > 0 &&
    ['pending', 'saved', 'discarded'].includes(p.status) && (p.status !== 'saved' || typeof p.savedSkillId === 'string') &&
    (p.recoveryDismissed === undefined || typeof p.recoveryDismissed === 'boolean');
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function write(payload: LearnDraftTransfer): Promise<void> {
  const plain = JSON.parse(JSON.stringify(payload)) as LearnDraftTransfer;
  const key = LEARN_TRANSFER_PREFIX + plain.id;
  await area().set({ [key]: plain });
  const stored = (await area().get(key))[key];
  if (JSON.stringify(stored) !== JSON.stringify(plain)) throw new Error('学习成果写入后回读不一致，尚未完成交接');
}

/** Stable per source + content: retry the same receipt instead of creating duplicates. */
export async function saveLearnDraft(draft: SkillDraft, sourceChatId = ''): Promise<{ ok: true; id: string } | Failure> {
  try {
    const plain = JSON.parse(JSON.stringify(draft)) as SkillDraft;
    if (!asSkillDraft(plain) || !plain.allowedTools.length) throw new Error('学习草稿形态不完整');
    const source = sourceChatId || crypto.randomUUID();
    const id = await digest(source + '\n' + JSON.stringify(plain));
    return await locked(id, async () => {
      const existing = await readLearnDraft(id);
      if (existing.status === 'ok') return { ok: true as const, id };
      if (existing.status !== 'none') throw new Error(existing.status === 'error' ? existing.error : '已有交接记录异常，保留原数据');
      await write({ version: 2, id, sourceChatId, createdAt: Date.now(), draft: plain, status: 'pending' });
      return { ok: true as const, id };
    });
  } catch (error) { return failure(error); }
}

export async function readLearnDraft(id: string): Promise<
  { status: 'ok'; transfer: LearnDraftTransfer } | { status: 'none' | 'invalid' } | { status: 'error'; error: string }
> {
  if (!isLearnTransferId(id)) return { status: 'invalid' };
  try {
    const value = (await area().get(LEARN_TRANSFER_PREFIX + id))[LEARN_TRANSFER_PREFIX + id];
    if (value === undefined) return { status: 'none' };
    return valid(value) && value.id === id ? { status: 'ok', transfer: value } : { status: 'invalid' };
  } catch (error) { return { status: 'error', error: failure(error).error }; }
}

export type LearnRecoveryStatus = 'available' | 'saved' | 'ignored';

/** Pure lookup: reopening a transcript must not recreate a saved/dismissed handoff. */
export async function readLearnRecovery(draft: SkillDraft, sourceChatId: string): Promise<
  { ok: true; status: LearnRecoveryStatus; transferId: string } | Failure
> {
  try {
    if (!sourceChatId || !asSkillDraft(draft)) throw new Error('缺少学习会话或有效草稿');
    const transferId = await digest(sourceChatId + '\n' + JSON.stringify(JSON.parse(JSON.stringify(draft))));
    const result = await readLearnDraft(transferId);
    if (result.status === 'error') throw new Error(result.error);
    if (result.status === 'invalid') throw new Error('学习成果交接记录异常，已保留原数据');
    if (result.status === 'ok' && result.transfer.sourceChatId !== sourceChatId) throw new Error('学习成果与会话不匹配，已保留原数据');
    const status: LearnRecoveryStatus = result.status === 'ok'
      ? result.transfer.status === 'saved' ? 'saved'
        : result.transfer.status === 'discarded' || result.transfer.recoveryDismissed ? 'ignored' : 'available'
      : 'available';
    return { ok: true, status, transferId };
  } catch (error) { return failure(error); }
}

/** One atomic receipt, including memory-only recovery. Never delete a draft or invalidate an open editor. */
export async function dismissLearnRecovery(draft: SkillDraft, sourceChatId: string): Promise<{ ok: true } | Failure> {
  try {
    const plain = JSON.parse(JSON.stringify(draft)) as SkillDraft;
    if (!sourceChatId || !asSkillDraft(plain) || !plain.allowedTools.length) throw new Error('缺少学习会话或有效草稿');
    const id = await digest(sourceChatId + '\n' + JSON.stringify(plain));
    return await locked(id, async () => {
      const result = await readLearnDraft(id);
      if (result.status === 'error' || result.status === 'invalid') throw new Error('无法读取交接记录，未忽略本次学习');
      if (result.status === 'ok' && result.transfer.sourceChatId !== sourceChatId) throw new Error('学习成果与会话不匹配，未忽略本次学习');
      const payload: LearnDraftTransfer = result.status === 'ok' ? result.transfer
        : { version: 2, id, sourceChatId, createdAt: Date.now(), draft: plain, status: 'pending' };
      if (!payload.recoveryDismissed) { payload.recoveryDismissed = true; await write(payload); }
      return { ok: true as const };
    });
  } catch (error) { return failure(error); }
}

/** Copy legacy data before using it; never delete or expire the only old copy. */
async function migrateLegacy(): Promise<void> {
  const old = (await area().get(LEARN_DRAFT_STORAGE_KEY))[LEARN_DRAFT_STORAGE_KEY];
  if (old === undefined) return;
  if (!old || !asSkillDraft(old.draft) || !Number.isFinite(old.createdAt)) throw new Error('旧学习成果数据异常，已保留原数据');
  const id = 'legacy-' + await digest(JSON.stringify(old));
  await locked(id, async () => {
    const existing = await readLearnDraft(id);
    if (existing.status === 'none') await write({ version: 2, id, sourceChatId: '', createdAt: Math.max(0, old.createdAt), draft: old.draft, status: 'pending' });
    else if (existing.status !== 'ok') throw new Error('旧成果迁移回读失败');
  });
}

export async function listLearnDrafts(includeDismissed = false): Promise<{ ok: true; transfers: LearnDraftTransfer[]; invalidIds: string[] } | Failure> {
  try {
    let legacyInvalid = false;
    try { await migrateLegacy(); } catch { legacyInvalid = true; }
    const storage = area() as chrome.storage.LocalStorageArea & { getKeys?: () => Promise<string[]> };
    const keys = typeof storage.getKeys === 'function' ? await storage.getKeys() : Object.keys(await storage.get(null));
    const selected = keys.filter(key => key.startsWith(LEARN_TRANSFER_PREFIX));
    const values = selected.length ? await storage.get(selected) : {};
    const transfers: LearnDraftTransfer[] = [], invalidIds: string[] = legacyInvalid ? ['legacy'] : [];
    for (const key of selected) {
      const value = values[key];
      if (!valid(value) || key !== LEARN_TRANSFER_PREFIX + value.id) invalidIds.push(key.slice(LEARN_TRANSFER_PREFIX.length));
      else if (value.status === 'pending' && (includeDismissed || !value.recoveryDismissed)) transfers.push(value);
    }
    transfers.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return { ok: true, transfers, invalidIds };
  } catch (error) { return failure(error); }
}

async function update(id: string, change: (payload: LearnDraftTransfer) => void, savedSkillId?: string): Promise<{ ok: true } | Failure> {
  try {
    return await locked(id, async () => {
      const result = await readLearnDraft(id);
      if (result.status !== 'ok') throw new Error('学习成果不可读取，保留当前编辑并重试');
      if (result.transfer.status !== 'pending') {
        if (savedSkillId && result.transfer.status === 'saved' && result.transfer.savedSkillId === savedSkillId) return { ok: true as const };
        throw new Error('学习成果状态已变化，请保留当前编辑副本');
      }
      change(result.transfer); await write(result.transfer);
      return { ok: true as const };
    });
  } catch (error) { return failure(error); }
}

export function saveLearnDraftEditor(id: string, state: LearnDraftEditorState) {
  if (!isLearnDraftEditorState(state)) return Promise.resolve(failure('草稿编辑副本形态异常或过大，已保留原成果'));
  return update(id, payload => { payload.editorState = state; });
}

export function isLearnDraftEditorState(value: unknown): value is LearnDraftEditorState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as LearnDraftEditorState;
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.every(item => typeof item === 'string');
  if (!state.form || !['name', 'description', 'category', 'customCategory', 'body', 'raw'].every(key => typeof (state.form as Record<string, unknown>)[key] === 'string') || !strings(state.form.tags)) return false;
  if (!['simple', 'advanced'].includes(state.editorMode) || !strings(state.preservedFrontmatterLines)) return false;
  if (!state.resourceFiles || typeof state.resourceFiles !== 'object' || Array.isArray(state.resourceFiles) || !Object.values(state.resourceFiles).every(item => typeof item === 'string')) return false;
  if (typeof state.selectedFile !== 'string') return false;
  try { return JSON.stringify(state).length <= SKILL_IMPORT_MAX_TOTAL_CHARS + 100_000; } catch { return false; }
}
export function completeLearnDraft(id: string, savedSkillId: string) {
  if (!savedSkillId) return Promise.resolve(failure('缺少已保存的技能 ID'));
  return update(id, payload => { payload.status = 'saved'; payload.savedSkillId = savedSkillId; }, savedSkillId);
}

/** Abort affects only its source; other pending handoffs are never globally cleared. */
export async function clearLearnDraft(sourceChatId?: string): Promise<void> {
  if (!sourceChatId) return;
  const result = await listLearnDrafts(true);
  if (!result.ok) throw new Error(result.error);
  for (const item of result.transfers.filter(item => item.sourceChatId === sourceChatId)) {
    const changed = await update(item.id, payload => { payload.status = 'discarded'; });
    if (!changed.ok) throw new Error(changed.error);
  }
}

/** Browser releases this origin-wide lock on close/reload; no unreliable expiry leases. */
export function claimLearnDraftEditor(): Promise<{ ok: true; release: () => void } | Failure> {
  if (typeof navigator === 'undefined' || !navigator.locks) return Promise.resolve(failure('当前环境不支持安全的跨标签编辑锁'));
  return new Promise(resolve => {
    void navigator.locks.request('agentnexus-learn-editor', { ifAvailable: true }, async lock => {
      if (!lock) { resolve(failure('另一管理中心标签页正在编辑学习成果，请先保存或关闭该编辑')); return; }
      await new Promise<void>(release => resolve({ ok: true, release }));
    }).catch(error => resolve(failure(error)));
  });
}

export function watchLearnDrafts(listener: () => void): () => void {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => {};
  const changed = (changes: Record<string, chrome.storage.StorageChange>, name: string) => {
    if (name === 'local' && Object.keys(changes).some(key => {
      if (key === LEARN_DRAFT_STORAGE_KEY) return true;
      if (!key.startsWith(LEARN_TRANSFER_PREFIX)) return false;
      return changes[key].oldValue?.status !== changes[key].newValue?.status ||
        changes[key].oldValue?.recoveryDismissed !== changes[key].newValue?.recoveryDismissed || !changes[key].oldValue;
    })) listener();
  };
  chrome.storage.onChanged.addListener(changed);
  return () => chrome.storage.onChanged.removeListener(changed);
}
