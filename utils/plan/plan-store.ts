/**
 * 会话计划存储（Plan Store）
 *
 * 用途：plan_tool 的会话级任务计划——Agent 执行长难任务时的步骤清单与执行
 * 状态。与既有两套存储的分工：
 *   - 笔记（utils/notes-database）：跨会话的外部记忆（重点见解 / 来源 / 最终
 *     结果），知识的沉淀；
 *   - 会话转录（core/context/chat-database）：消息与工具调用记录；
 *   - 计划（本文件）：本会话「要做哪些步骤、做到哪了」的执行状态单一事实源，
 *     按会话隔离，随会话删除级联清理，不跨会话共享。
 *
 * 数据模型：
 *   PlanSession { chatId, items: PlanItem[], nextItemId, createdAt, updatedAt }
 *   PlanItem    { id（会话内自增数字串），step, status, message?, updatedAt }
 *   id 只增不复用：删除某项后其余项的 id 保持不变，模型持有的引用永不漂移。
 *
 * 持久化与多上下文一致性（多窗口各自持有独立内存态，是本层的核心难点）：
 *   - 内存 Map 为运行时权威态（单上下文内同步操作无竞态）；
 *   - localStorage 同步缓存（sidepanel 重开即时回显）+ chrome.storage.local
 *     异步权威（localStorage 被「清除浏览数据」抹掉后的恢复源）；
 *   - 持久化走「读-合并-写」：写前先把两侧现存值经 mergeExternal 并入内存
 *     （per-session「updatedAt 较新者胜」LWW），防多窗口并发写互相覆盖；
 *   - 删除墓碑（dropped）：dropPlan 记录删除时间，合并时尊重较新的删除，
 *     防其它上下文的陈旧副本复活已删计划；墓碑超 TTL 自动清理；
 *   - 外部变更订阅（subscribeStorageKey + 写指纹跳过自事件）：其它窗口写入
 *     即时并入内存并通知 UI，当前展示的计划实时跟随；
 *   - 写入去抖合并（edit 高频不产生写风暴），pagehide 时立即 flush，
 *     持久化经 Promise 队列串行化（防异步读-写交错）；
 *   - LRU 上限：最多保留 MAX_SESSIONS 个会话的计划（按 updatedAt 淘汰）。
 *
 * 变更通知：onPlanChange(chatId, session | null)，UI（PlanBoard）据此实时刷新；
 * 单个监听器抛错只告警，绝不影响其余监听与写主流程。
 */

import { LocalWriteFingerprint, subscribeStorageKey } from '../shared/storage-sync';

// ──── 类型 ────

export type PlanItemStatus = 'pending' | 'in_progress' | 'done' | 'failed';

export interface PlanItem {
  /** 会话内唯一 id（数字字符串，创建顺序自增；删除后不复用） */
  id: string;
  /** 步骤内容（已 trim + 长度钳制） */
  step: string;
  status: PlanItemStatus;
  /** 状态标注：done = 简要成果；failed = 失败原因（必填约束由 plan-tool 校验） */
  message?: string;
  updatedAt: number;
}

export interface PlanSession {
  chatId: string;
  items: PlanItem[];
  /** 下一个分配的项 id 对应数字（仅递增） */
  nextItemId: number;
  createdAt: number;
  updatedAt: number;
}

// ──── 防护上限 ────

/** 单个计划允许的最大步骤数（create/add 合计；超出部分丢弃并在工具层反馈） */
export const PLAN_MAX_ITEMS = 30;
/** 单条步骤文本长度上限 */
export const PLAN_STEP_MAX_CHARS = 300;
/** 状态标注信息长度上限 */
export const PLAN_MESSAGE_MAX_CHARS = 500;
/** 持久化保留的会话计划数上限（LRU，按 updatedAt 淘汰） */
const MAX_SESSIONS = 40;
/** chrome.storage 写入去抖间隔（ms） */
const PERSIST_DEBOUNCE_MS = 400;
/** 删除墓碑保留时长（跨窗口合并尊重删除；超时清理防无限增长） */
const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** chrome.storage.local 与 localStorage 共用的存储键（两侧数据同构） */
const PLAN_STORAGE_KEY = 'agentNexusSessionPlans';

/** 持久化载荷结构版本（v2：会话表 + 删除墓碑；读取时兼容裸会话表的 v1 形态） */
const STORAGE_SCHEMA_VERSION = 2;

/** v2 持久化载荷 */
interface StoredPlansPayload {
  v: number;
  sessions: Record<string, PlanSession>;
  /** 删除墓碑：chatId → 删除时间戳（ms） */
  dropped: Record<string, number>;
}

// ──── 内存态 ────

const sessions = new Map<string, PlanSession>();

/** 删除墓碑：chatId → 删除时间（跨上下文合并时防复活；见文件头说明） */
const droppedTombstones = new Map<string, number>();

/**
 * 当前活跃会话 id：App.vue watch activeChatId 注入。
 * plan_tool 的首选会话上下文来自工具执行链显式传入（并发运行时各自隔离），
 * 此值仅作为无上下文调用方的防御性兜底，不承担并发正确性。
 */
let activeChatId = '';

// ──── 变更通知 ────

type PlanChangeListener = (chatId: string, session: PlanSession | null) => void;
const listeners = new Set<PlanChangeListener>();

/** 订阅计划变更（任意会话的增删改都会触发；返回退订函数） */
export function onPlanChange(listener: PlanChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(chatId: string, session: PlanSession | null): void {
  for (const listener of listeners) {
    try {
      listener(chatId, session);
    } catch (error) {
      console.warn('[PlanStore] 计划变更监听器执行失败:', error);
    }
  }
}

// ──── 归一化（外部输入 → 合规值，绝不抛错） ────

const PLAN_STATUSES: readonly PlanItemStatus[] = ['pending', 'in_progress', 'done', 'failed'];

export function isPlanItemStatus(value: unknown): value is PlanItemStatus {
  return typeof value === 'string' && (PLAN_STATUSES as string[]).includes(value);
}

/** 截断到上限；非字符串返回空串 */
function clampText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

/** 宽容解析时间戳（非有限数回落给定默认值，防脏数据污染 LWW 比较） */
function clampTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

// ──── 查询 ────

/**
 * 读取指定会话的计划项（返回浅拷贝数组：调用方修改不会污染内存权威态）。
 */
export function getPlan(chatId: string): PlanItem[] {
  const session = sessions.get(chatId);
  return session ? session.items.map(item => ({ ...item })) : [];
}

/** 当前活跃会话 id（兜底绑定；见 activeChatId 注释） */
export function getActivePlanChatId(): string {
  return activeChatId;
}

/** App 层同步活跃会话（watch activeChatId 调用） */
export function setActivePlanChat(chatId: string): void {
  activeChatId = typeof chatId === 'string' ? chatId : '';
}

// ──── 写入（写后统一走 schedulePersist + notify） ────

function ensureSession(chatId: string): PlanSession {
  let session = sessions.get(chatId);
  if (!session) {
    const now = Date.now();
    session = { chatId, items: [], nextItemId: 1, createdAt: now, updatedAt: now };
    sessions.set(chatId, session);
    // 重建计划即撤销对该会话的删除意图：清本地墓碑，
    // 防后续合并把刚建立的计划当「删除后的陈旧副本」误杀
    droppedTombstones.delete(chatId);
  }
  return session;
}

/** 步骤数组归一化：非字符串/空白剔除、clamp、精确文本去重保序；返回 [items, droppedCount] */
function normalizeSteps(steps: readonly unknown[], limit: number): [PlanItem[], number] {
  const seen = new Set<string>();
  const items: PlanItem[] = [];
  let dropped = 0;
  for (const raw of steps) {
    if (items.length >= limit) {
      dropped += 1;
      continue;
    }
    const step = clampText(raw, PLAN_STEP_MAX_CHARS);
    if (!step || seen.has(step)) {
      dropped += 1;
      continue;
    }
    seen.add(step);
    items.push({ id: '', step, status: 'pending', updatedAt: Date.now() });
  }
  return [items, dropped];
}

/** 为新项分配 id（nextItemId 仅递增）并登记进会话 */
function appendItems(session: PlanSession, items: PlanItem[]): PlanItem[] {
  const assigned: PlanItem[] = [];
  for (const item of items) {
    if (session.items.length >= PLAN_MAX_ITEMS) break;
    item.id = String(session.nextItemId);
    session.nextItemId += 1;
    session.items.push(item);
    assigned.push(item);
  }
  return assigned;
}

/**
 * 建立计划（每会话一份）：整体替换既有计划。
 * 防御：先归一化后销毁——steps 全部非法（空/非字符串/重复至无可取项）时
 * 不触碰既有计划，避免一次无效 create 清空有效数据。
 * @returns 新计划全量项 + 是否替换了既有计划
 */
export function createPlan(
  chatId: string,
  steps: readonly unknown[],
): { items: PlanItem[]; replaced: boolean; droppedCount: number } {
  const [normalized, dropped] = normalizeSteps(steps, PLAN_MAX_ITEMS);
  // 无可用步骤 → 早退（既有计划保持原样，调用方给参数错误反馈）
  if (normalized.length === 0) {
    return { items: [], replaced: false, droppedCount: dropped };
  }
  const replaced = sessions.has(chatId);
  const session = ensureSession(chatId);
  session.items = [];
  const items = appendItems(session, normalized);
  session.updatedAt = Date.now();
  schedulePersist();
  notify(chatId, session);
  return { items: items.map(item => ({ ...item })), replaced, droppedCount: dropped };
}

/**
 * 追加计划项（计划不存在时自动建立——「边干边发现新步骤」不应被强制先重建）。
 * 防御：无有效追加项时不创建空会话计划、不触碰既有数据。
 */
export function addPlanItems(
  chatId: string,
  steps: readonly unknown[],
): { items: PlanItem[]; created: boolean; droppedCount: number } {
  const existing = sessions.get(chatId);
  const remaining = PLAN_MAX_ITEMS - (existing?.items.length ?? 0);
  // normalizeSteps 的 dropped 已含全部未接受原因（上限截断 / 非法 / 重复）
  const [normalized, dropped] = normalizeSteps(steps, Math.max(remaining, 0));
  if (normalized.length === 0) {
    // 早退：不创建空会话；created 语义 = 「若可写入是否会是新建」，供提示文案选择
    return { items: [], created: !existing, droppedCount: dropped };
  }
  const session = ensureSession(chatId);
  const items = appendItems(session, normalized);
  session.updatedAt = Date.now();
  schedulePersist();
  notify(chatId, session);
  return { items: items.map(item => ({ ...item })), created: !existing, droppedCount: dropped };
}

/**
 * 编辑单个计划项（状态与/或标注信息）。
 *
 * 标注跟随状态：status 变化且未显式携带 message 时，旧标注随旧状态作废
 * （防止 failed 的原因残挂在改回 pending / 重标 done 的项上误导阅读）；
 * 显式传空串 message = 主动清除标注；同状态重标不丢原标注（幂等）。
 *
 * @returns 更新后的项；id 不存在返回 null（调用方给可读错误）
 */
export function editPlanItem(
  chatId: string,
  id: string,
  patch: { status?: PlanItemStatus; message?: string },
): PlanItem | null {
  const session = sessions.get(chatId);
  if (!session) return null;
  const item = session.items.find(entry => entry.id === id);
  if (!item) return null;
  if (patch.status !== undefined && patch.status !== item.status) {
    item.status = patch.status;
    // 状态已变且未携带新标注 → 旧标注作废
    if (patch.message === undefined) delete item.message;
  }
  if (patch.message !== undefined) {
    const message = clampText(patch.message, PLAN_MESSAGE_MAX_CHARS);
    if (message) item.message = message;
    else delete item.message;
  }
  item.updatedAt = Date.now();
  session.updatedAt = item.updatedAt;
  schedulePersist();
  notify(chatId, session);
  return { ...item };
}

/**
 * 批量删除计划项。
 * @returns 实际删除数（未知 id 由调用方对照反馈，不在此静默吞掉）
 */
export function deletePlanItems(chatId: string, ids: readonly string[]): number {
  const session = sessions.get(chatId);
  if (!session) return 0;
  const idSet = new Set(ids);
  const before = session.items.length;
  session.items = session.items.filter(item => !idSet.has(item.id));
  const deleted = before - session.items.length;
  if (deleted > 0) {
    session.updatedAt = Date.now();
    schedulePersist();
    notify(chatId, session);
  }
  return deleted;
}

/**
 * 删除整个会话计划（会话删除时的级联清理；返回是否存在过计划）。
 * 落删除墓碑：即使本上下文没有该会话的计划（会话可能只在其它窗口建过），
 * 也持久化删除意图，防其它窗口的陈旧副本在下次合并时复活它。
 */
export function dropPlan(chatId: string): boolean {
  const existed = sessions.delete(chatId);
  droppedTombstones.set(chatId, Date.now());
  schedulePersist();
  if (existed) notify(chatId, null);
  return existed;
}

// ──── 跨上下文合并（多窗口一致性核心） ────

type StoredPayloadView = { sessions: Record<string, unknown>; dropped: Record<string, number> };

/**
 * 解析持久化载荷（宽容两形态）：
 *   - v2：{ v, sessions, dropped }；
 *   - v1 / 外部注入：裸会话表 Record<chatId, session>（无 v 与 sessions 标记）。
 * 结构不可识别返回 null。
 */
function parseStoredPayload(raw: unknown): StoredPayloadView | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  if (candidate['v'] === undefined && candidate['sessions'] === undefined) {
    return { sessions: candidate, dropped: {} };
  }
  const sessionsRaw = candidate['sessions'];
  if (!sessionsRaw || typeof sessionsRaw !== 'object') return null;
  const droppedRaw = candidate['dropped'];
  const dropped: Record<string, number> = {};
  if (droppedRaw && typeof droppedRaw === 'object') {
    for (const [chatId, ts] of Object.entries(droppedRaw as Record<string, unknown>)) {
      if (chatId && typeof ts === 'number' && Number.isFinite(ts)) dropped[chatId] = ts;
    }
  }
  return { sessions: sessionsRaw as Record<string, unknown>, dropped };
}

/**
 * 把外部持久化数据合并进内存（per-session「updatedAt 较新者胜」LWW + 删除
 * 墓碑双向尊重），返回内容实际变化的会话 id 列表（供调用方通知 UI）。
 * 内存为单上下文运行时权威：只有「外部更新」才覆盖本地，绝不回退本地新写入。
 */
function mergeExternal(raw: unknown): string[] {
  const parsed = parseStoredPayload(raw);
  if (!parsed) return [];
  const now = Date.now();
  const affected = new Set<string>();

  // 1) 墓碑合并（较新者胜）：外部删除比本地会话新 → 删除本地会话
  for (const [chatId, ts] of Object.entries(parsed.dropped)) {
    if (now - ts > TOMBSTONE_TTL_MS) continue; // 过期墓碑忽略
    const localTs = droppedTombstones.get(chatId);
    if (localTs !== undefined && localTs >= ts) continue;
    droppedTombstones.set(chatId, ts);
    const local = sessions.get(chatId);
    if (local && local.updatedAt <= ts) {
      sessions.delete(chatId);
      affected.add(chatId);
    }
  }

  // 2) 会话合并（LWW）：外部比本地新才采纳
  for (const [chatId, rawSession] of Object.entries(parsed.sessions)) {
    if (!chatId) continue;
    const external = deserializePlan(chatId, rawSession);
    if (!external) continue;
    const tombstone = droppedTombstones.get(chatId);
    // 会话在墓碑之后重建（updatedAt 更新）才有效；更早的副本视为已删
    if (tombstone !== undefined && external.updatedAt <= tombstone) continue;
    const local = sessions.get(chatId);
    if (!local || external.updatedAt > local.updatedAt) {
      sessions.set(chatId, external);
      affected.add(chatId);
    }
  }

  // 3) 墓碑反向作废：本地会话比墓碑新（删除后重建）→ 清除本地墓碑
  for (const [chatId, session] of sessions) {
    const ts = droppedTombstones.get(chatId);
    if (ts !== undefined && session.updatedAt > ts) droppedTombstones.delete(chatId);
  }

  return [...affected];
}

// ──── 持久化 ────

let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** 持久化串行队列（读-合并-写为异步，队列防两次持久化交错读写） */
let persistChain: Promise<void> = Promise.resolve();

/** 本上下文写入指纹（跨上下文变更订阅跳过自事件） */
const planWriteFingerprint = new LocalWriteFingerprint();

/** 去抖持久化：内存态 → localStorage（同步缓存）+ chrome.storage（权威） */
function schedulePersist(): void {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void enqueuePersist();
  }, PERSIST_DEBOUNCE_MS);
}

/** 入队一次持久化（串行执行；失败只告警不阻断后续） */
function enqueuePersist(): Promise<void> {
  persistChain = persistChain
    .then(() => persistNow())
    .catch(error => console.warn('[PlanStore] 持久化失败:', error));
  return persistChain;
}

/** 构建当前持久化载荷（LRU 裁剪 + 墓碑修剪） */
function buildPayload(): StoredPlansPayload {
  return {
    v: STORAGE_SCHEMA_VERSION,
    sessions: lruSnapshot(),
    dropped: pruneTombstones(),
  };
}

/** 同步写 localStorage 缓存（失败仅告警，不影响内存权威态） */
function writeLocalStorageSync(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(buildPayload()));
    }
  } catch (error) {
    console.warn('[PlanStore] 写入 localStorage 缓存失败:', error);
  }
}

/**
 * 立即持久化（读-合并-写）：
 *   1. 读两侧现存值并入内存（LWW，防多窗口并发写互相覆盖旧数据）；
 *   2. 构建快照（LRU 裁剪 + 墓碑修剪）并写回两侧。
 * 内存权威态不受任何持久化失败影响。
 */
async function persistNow(): Promise<void> {
  // ── 读 + 合并 ──
  try {
    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(PLAN_STORAGE_KEY);
        if (raw) {
          const affected = mergeExternal(JSON.parse(raw));
          for (const chatId of affected) notify(chatId, sessions.get(chatId) ?? null);
        }
      } catch (error) {
        console.warn('[PlanStore] 持久化前读取 localStorage 缓存失败:', error);
      }
    }
  } catch {
    /* localStorage 整体不可用时跳过合并 */
  }
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        const result = await chrome.storage.local.get(PLAN_STORAGE_KEY);
        const stored = result?.[PLAN_STORAGE_KEY];
        if (stored) {
          const affected = mergeExternal(stored);
          for (const chatId of affected) notify(chatId, sessions.get(chatId) ?? null);
        }
      } catch (error) {
        console.warn('[PlanStore] 持久化前读取 chrome.storage 失败:', error);
      }
    }
  } catch {
    /* chrome.storage 整体不可用时跳过合并 */
  }

  // ── 写 ──
  writeLocalStorageSync();
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const payload = buildPayload();
      // 先登记指纹再写：onChanged 自事件按指纹跳过（指纹与写入值同源一致）
      planWriteFingerprint.mark(payload);
      await chrome.storage.local
        .set({ [PLAN_STORAGE_KEY]: payload })
        .catch(error => console.warn('[PlanStore] 写入 chrome.storage 失败:', error));
    }
  } catch (error) {
    console.warn('[PlanStore] chrome.storage 不可用，本次仅写 localStorage:', error);
  }
}

/** LRU 快照：超出上限时按 updatedAt 淘汰最旧会话（仅影响持久化，不动内存） */
function lruSnapshot(): Record<string, PlanSession> {
  const all = Array.from(sessions.values());
  if (all.length <= MAX_SESSIONS) {
    return Object.fromEntries(all.map(session => [session.chatId, session]));
  }
  const keep = new Set(
    all
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS)
      .map(session => session.chatId),
  );
  return Object.fromEntries(
    all.filter(session => keep.has(session.chatId)).map(session => [session.chatId, session]),
  );
}

/** 墓碑修剪：超 TTL 的删除意图不再需要（该会话早已无人记得），防无限增长 */
function pruneTombstones(): Record<string, number> {
  const now = Date.now();
  const result: Record<string, number> = {};
  for (const [chatId, ts] of droppedTombstones) {
    if (now - ts <= TOMBSTONE_TTL_MS) result[chatId] = ts;
    else droppedTombstones.delete(chatId);
  }
  return result;
}

/**
 * 反序列化单条会话计划（逐项防御：坏项丢弃告警，绝不影响同会话其余项）。
 * 结构性缺失（chatId / items 非法）返回 null。
 */
function deserializePlan(chatId: string, raw: unknown): PlanSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<PlanSession>;
  if (!Array.isArray(candidate.items)) return null;
  const now = Date.now();
  const session: PlanSession = {
    chatId,
    items: [],
    nextItemId: 1,
    createdAt: clampTimestamp(candidate.createdAt, now),
    updatedAt: clampTimestamp(candidate.updatedAt, now),
  };
  let maxNumericId = 0;
  for (const rawItem of candidate.items) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const item = rawItem as Partial<PlanItem>;
    if (typeof item.id !== 'string' || !/^\d+$/.test(item.id)) continue;
    const step = clampText(item.step, PLAN_STEP_MAX_CHARS);
    if (!step) continue;
    const status = isPlanItemStatus(item.status) ? item.status : 'pending';
    const message = clampText(item.message, PLAN_MESSAGE_MAX_CHARS) || undefined;
    if (session.items.length >= PLAN_MAX_ITEMS) {
      console.warn(`[PlanStore] 会话 ${chatId} 的持久化计划超过 ${PLAN_MAX_ITEMS} 项，多余项已丢弃`);
      break;
    }
    session.items.push({
      id: item.id,
      step,
      status,
      ...(message !== undefined ? { message } : {}),
      updatedAt: clampTimestamp(item.updatedAt, now),
    });
    const numericId = Number(item.id);
    if (Number.isFinite(numericId) && numericId > maxNumericId) maxNumericId = numericId;
  }
  // nextItemId 取持久化值与最大既有 id+1 的较大者（防外部写入回退导致 id 复用）
  const storedNext = clampTimestamp(candidate.nextItemId, 1);
  session.nextItemId = Math.max(storedNext, maxNumericId + 1, 1);
  return session;
}

/** 模块加载时同步恢复 localStorage 缓存（即时回显；失败静默——权威源在对账） */
(() => {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(PLAN_STORAGE_KEY);
    if (!raw) return;
    mergeExternal(JSON.parse(raw));
  } catch (error) {
    console.warn('[PlanStore] 从 localStorage 恢复计划失败:', error);
  }
})();

/**
 * chrome.storage 权威源对账（App 挂载时 await 一次）。
 * LWW 合并：内存已有且更新的会话不受影响；外部较新的采纳并通知 UI
 * （覆盖「恢复完成晚于活跃会话打开」的时序窗口）。
 */
export async function restorePlansFromStorage(): Promise<void> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    const result = await chrome.storage.local.get(PLAN_STORAGE_KEY);
    const stored = result?.[PLAN_STORAGE_KEY];
    if (stored && typeof stored === 'object') {
      const affected = mergeExternal(stored);
      if (affected.length > 0) {
        console.log(`[PlanStore] 从 chrome.storage 恢复 ${affected.length} 个会话的计划`);
        for (const chatId of affected) notify(chatId, sessions.get(chatId) ?? null);
      }
    }
  } catch (error) {
    console.warn('[PlanStore] chrome.storage 恢复计划失败:', error);
  }
}

/**
 * 幂等水合：确保本上下文已从 chrome.storage 权威源恢复过一次。
 *
 * 面向 background worker 冷启动场景：会话引擎与 plan_tool 都在 worker 执行，
 * 而 worker 无 localStorage（模块加载时的同步恢复读不到缓存），跨上下文订阅
 * 又只能收到「之后的写入」——不先水合，worker 重启后的首轮会把既有计划误判
 * 为「不存在」（add 的自动建立分支会整体覆盖旧计划，edit 报目标不存在）。
 * 会话引擎在每次运行准备阶段调用；首次调用后复用同一 Promise，不重复读
 * storage。sidepanel App 挂载时的 restorePlansFromStorage 直调不受影响。
 */
let planHydrationPromise: Promise<void> | null = null;
export function ensurePlansHydrated(): Promise<void> {
  planHydrationPromise ??= restorePlansFromStorage();
  return planHydrationPromise;
}

// 跨上下文变更订阅：其它窗口写入 → LWW 合并进内存并通知 UI（自事件被指纹跳过）
subscribeStorageKey(PLAN_STORAGE_KEY, planWriteFingerprint, newValue => {
  const affected = mergeExternal(newValue);
  for (const chatId of affected) notify(chatId, sessions.get(chatId) ?? null);
});

// pagehide（sidepanel 关闭/导航）时立即 flush：去抖窗口内的最后变更不丢失。
// 时序要点：pagehide 后异步任务（chrome.storage 读-合并-写）大概率来不及完成，
// 因此先同步完成 localStorage 侧的读-合并-写（同源即时可恢复），再把权威源
// 持久化入队尽力而为（扩展后台存活时仍会完成）。
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    // 同步侧：先并入 localStorage 现存值（防覆盖其它窗口刚写入的数据）再落盘
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(PLAN_STORAGE_KEY);
        if (raw) mergeExternal(JSON.parse(raw));
      }
    } catch (error) {
      console.warn('[PlanStore] pagehide 合并 localStorage 失败:', error);
    }
    writeLocalStorageSync();
    // 异步侧：权威源持久化（含读-合并-写；页面销毁时未完成也不影响已同步的缓存）
    void enqueuePersist();
  });
}
