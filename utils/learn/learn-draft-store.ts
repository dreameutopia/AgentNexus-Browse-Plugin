/**
 * 站点学习草稿的跨页传递（一次性、带 TTL）
 *
 * 流程：sidepanel 学习完成 → 写入本存储 → 打开 hub.html#new-skill →
 *      hub 挂载时 takeLearnDraft() 读取并立即删除 → 预填表单。
 *
 * 为什么不能走 URL：技能正文可达 15000 字符，query/hash 会超出 URL 长度
 * 限制且必然泄漏到标签页历史与可能的日志里。storage 是本扩展各上下文共享的
 * 权威源（与技能库、智能体库同一套跨上下文同步通道），体积无压力。
 *
 * 三重防残留：
 *   1. 读取即删除（one-shot）——正常路径下不会留下孤儿；
 *   2. TTL 过期（LEARN_DRAFT_TTL_MS）——hub 打开太晚时按「已过期」处理，
 *      而不是把一份陈旧草稿静默预填给用户；
 *   3. abort / 重置时显式 clearLearnDraft()——用户终止学习后草稿立即作废。
 *
 * 降级策略：storage 不可用（隐私模式 / 配额 / 扩展上下文异常）时返回 false /
 * null，由调用方走「内存草稿 + 提示本次有效」的兜底，绝不抛错中断主流程。
 */

import { LEARN_DRAFT_STORAGE_KEY, LEARN_DRAFT_TTL_MS } from './learn-types';
import type { LearnDraftPayload, SkillDraft } from './learn-types';

/**
 * takeLearnDraft 的结果形态（判别联合）。
 *
 * 三种失败各自对应不同的用户提示，不能折叠成 null：
 *   - 'none'    hash 信号在但存储里没有草稿（已被消费 / 被 abort 清除）——
 *               重复触发时静默即可，提示「过期」反而制造困惑；
 *   - 'expired' 写入超过 TTL——明确告知「已过期」，用户知道成果为何没带过来；
 *   - 'invalid' storage 是共享可写区，任何上下文都可能写入脏数据——
 *               提示「数据异常」引导手动创建，与过期区分开。
 */
export type LearnDraftTakeResult =
  | { status: 'ok'; draft: SkillDraft }
  | { status: 'none' }
  | { status: 'expired' }
  | { status: 'invalid' };

/** storage 不可用时的统一告警（只告警一次，避免每次读写都刷屏） */
let warnedUnavailable = false;
function warnUnavailable(operation: string, error: unknown): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.warn(
    `[LearnDraftStore] chrome.storage 不可用（${operation}），草稿跨页传递降级为仅本次会话有效:`,
    error,
  );
}

/** chrome.storage.local 是否可用（扩展上下文外 / 被禁用时为 false） */
function storageAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local;
}

/**
 * 写入草稿（覆盖式：同一时刻只应存在一份待确认草稿）。
 * @returns 是否写入成功；失败时调用方需保留内存草稿并提示用户
 */
export async function saveLearnDraft(draft: SkillDraft): Promise<boolean> {
  if (!storageAvailable()) {
    warnUnavailable('save', 'chrome.storage.local 缺失');
    return false;
  }
  try {
    const payload: LearnDraftPayload = { draft, createdAt: Date.now() };
    await chrome.storage.local.set({ [LEARN_DRAFT_STORAGE_KEY]: payload });
    return true;
  } catch (error) {
    warnUnavailable('save', error);
    return false;
  }
}

/**
 * 探测是否存在待消费草稿（peek，不消费、不删除）。
 * 用途：管理中心正在编辑技能时收到交付信号——不能直接 take（读取即删的
 * 语义会把草稿吞掉却无人接住），先探测存在性、挂起为「待导入」信号，
 * 由用户结束编辑的那一刻真正接手。
 */
export async function hasLearnDraft(): Promise<boolean> {
  if (!storageAvailable()) return false;
  try {
    const stored = await chrome.storage.local.get(LEARN_DRAFT_STORAGE_KEY);
    const payload = stored?.[LEARN_DRAFT_STORAGE_KEY];
    return payload !== undefined && payload !== null;
  } catch (error) {
    warnUnavailable('peek', error);
    return false;
  }
}

/**
 * 读取并删除草稿（one-shot）。
 *
 * 无论后续判定如何，读到即删：过期与脏数据同样要清，否则每次打开 hub
 * 都会重复命中同一份死草稿。结果带状态判别，由调用方给出准确提示。
 */
export async function takeLearnDraft(): Promise<LearnDraftTakeResult> {
  if (!storageAvailable()) {
    warnUnavailable('take', 'chrome.storage.local 缺失');
    return { status: 'none' };
  }
  let payload: unknown;
  try {
    const stored = await chrome.storage.local.get(LEARN_DRAFT_STORAGE_KEY);
    payload = stored?.[LEARN_DRAFT_STORAGE_KEY];
    // 无论后续判定如何，读到即删：one-shot 语义
    await chrome.storage.local.remove(LEARN_DRAFT_STORAGE_KEY);
  } catch (error) {
    warnUnavailable('take', error);
    return { status: 'none' };
  }

  if (payload === undefined || payload === null) {
    return { status: 'none' };
  }
  if (!isDraftPayload(payload)) {
    console.warn('[LearnDraftStore] 草稿载荷形态非法，已清除:', payload);
    return { status: 'invalid' };
  }
  if (Date.now() - payload.createdAt > LEARN_DRAFT_TTL_MS) {
    console.warn('[LearnDraftStore] 草稿已过期，已清除（用户需在 hub 手动填写）');
    return { status: 'expired' };
  }
  return { status: 'ok', draft: payload.draft };
}

/** 显式清除（用户终止学习 / 重新开始学习时调用，保证不残留上一次的草稿） */
export async function clearLearnDraft(): Promise<void> {
  if (!storageAvailable()) return;
  try {
    await chrome.storage.local.remove(LEARN_DRAFT_STORAGE_KEY);
  } catch (error) {
    warnUnavailable('clear', error);
  }
}

/** 载荷形态校验（storage 是共享可写区，任何上下文都可能写入脏数据） */
function isDraftPayload(value: unknown): value is LearnDraftPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<LearnDraftPayload>;
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) return false;
  const draft = record.draft as Partial<SkillDraft> | undefined;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return false;
  return (
    typeof draft.name === 'string' &&
    draft.name.length > 0 &&
    typeof draft.description === 'string' &&
    typeof draft.body === 'string' &&
    draft.body.length > 0 &&
    typeof draft.category === 'string' &&
    Array.isArray(draft.allowedTools) &&
    draft.allowedTools.length > 0 &&
    (draft.mode === 'text' || draft.mode === 'vision') &&
    Array.isArray(draft.tags)
  );
}
