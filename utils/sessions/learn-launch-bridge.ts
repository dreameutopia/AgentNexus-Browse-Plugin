/**
 * 网站任务学习启动桥（学习页 ↔ 侧边栏）
 *
 * 学习页是独立扩展页面，真正的会话只能由侧边栏创建并运行。跨上下文约束：
 *   1. 消息会被所有扩展上下文收到，只有第一个 sendResponse 生效 ——
 *      因此只有「目标窗口的侧边栏」应答，其它窗口/后台一律不应答；
 *   2. 侧边栏未打开时无人应答 —— 调用方必须把它与「侧边栏拒绝」区分开；
 *   3. 学习工具必须作用于用户打开学习页之前的目标标签页，不能作用于学习页
 *      自身 —— 学习页在启动前先激活来源标签页，再发启动请求。
 *
 * 本模块是这套协议的单一出口：消息类型、载荷校验、来源标签页存取、
 * 预检与启动请求全部收敛在这里。
 */

import type { ConversationTag } from './conversation-tags';
import { LEARN_CONVERSATION_TAG } from './conversation-tags';
import { sendExtensionMessage } from './session-bridge';

/** 学习页 ↔ 侧边栏消息类型（单一事实源） */
export const LEARN_BRIDGE_MSG = {
  /** 预检：侧边栏是否在场、当前会话是否在运行 */
  PREFLIGHT: 'agentnexus:learn-preflight',
  /** 启动：在侧边栏新建普通会话并发送学习请求 */
  START: 'agentnexus:learn-start',
} as const;

/** 来源标签页存储键（chrome.storage.session；浏览器会话级，不跨重启保留） */
export const LEARN_ORIGIN_STORAGE_KEY = 'learn.originTab';

/** 来源标签页有效期：超过该时长的记录视为失效，避免用陈旧页面启动学习 */
const LEARN_ORIGIN_TTL_MS = 60 * 60 * 1000;

/** 学习目标 / 注意事项长度上限（与输入框 maxlength 同一口径） */
export const LEARN_GOAL_MAX_CHARS = 4_000;
export const LEARN_NOTES_MAX_CHARS = 6_000;

/** 学习页记录的目标标签页 */
export interface LearnOriginTab {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  recordedAt: number;
}

/** 启动载荷（学习页 → 侧边栏） */
export interface LearnLaunchPayload {
  /** 目标窗口 id：只允许该窗口的侧边栏应答 */
  windowId: number;
  /** 学习目标 */
  goal: string;
  /** 用户对学习过程的要求/注意事项 */
  notes: string;
  /** 选中的智能体稳定名（agent-store 的存储键） */
  agentName: string;
  /** 来源页面（仅作为上下文提示，工具仍以侧边栏绑定窗口为准） */
  originUrl?: string;
  originTitle?: string;
}

/** 失败码：学习页据此给出可直接执行的下一步提示（单一事实源） */
export const LEARN_FAILURE_CODES = [
  'sidepanel-unavailable',
  'busy',
  'invalid-request',
  'agent-unavailable',
  'skill-unavailable',
  'model-unavailable',
  'origin-unavailable',
  'send-failed',
] as const;

export type LearnBridgeFailureCode = (typeof LEARN_FAILURE_CODES)[number];

export type LearnBridgeResponse =
  | { ok: true }
  | { ok: false; code: LearnBridgeFailureCode };

/** 由学习页写入的启动标签（侧边栏在创建会话时原子写入） */
export const LEARN_LAUNCH_TAGS: readonly ConversationTag[] = Object.freeze([
  LEARN_CONVERSATION_TAG,
]);

/** chrome.runtime / storage.session 不可用时的统一降级 */
function runtimeAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
}

function sessionStorageArea(): chrome.storage.StorageArea | null {
  try {
    return chrome.storage?.session ?? null;
  } catch {
    return null;
  }
}

function isFinitePositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function clampText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * 是否是可作为学习目标的页面。
 *
 * 学习工具最终会作用在真实网页上，因此只接受浏览器可访问的页面协议：
 * http / https / file。扩展页、chrome://、about:blank、devtools 等既无法
 * 被页面工具正常读取，也不构成「网站任务」，记录它们只会让预检通过后
 * 在实际执行时失败——在来源记录阶段就拒绝，学习页会提示用户先打开目标网站。
 */
export function isLearnableUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:' || protocol === 'file:';
  } catch {
    return false;
  }
}

/**
 * 记录打开学习页之前的目标标签页。
 *
 * 只记录非扩展页面：用户可能恰好停在 hub/notes 等扩展页，此时继续向前
 * 找最近一个普通网页标签页；一个都没有则返回 null（学习页会提示用户
 * 回到目标网站重新打开）。
 */
export async function rememberLearnOrigin(): Promise<LearnOriginTab | null> {
  if (!runtimeAvailable() || !chrome.windows?.getCurrent || !chrome.tabs?.query) return null;
  try {
    const currentWindow = await chrome.windows.getCurrent();
    const windowId = currentWindow?.id;
    if (!isFinitePositiveInt(windowId)) return null;
    const tabs = await chrome.tabs.query({ windowId });
    // 只记录真实网页：扩展页 / 浏览器内部页不构成可学习目标（见 isLearnableUrl）
    const candidates = tabs.filter(
      tab => isFinitePositiveInt(tab.id) && isLearnableUrl(tab.url),
    );
    const activeTab = candidates.find(tab => tab.active) ?? candidates.at(-1);
    if (!activeTab || !isFinitePositiveInt(activeTab.id)) return null;
    const origin: LearnOriginTab = {
      tabId: activeTab.id,
      windowId,
      url: typeof activeTab.url === 'string' ? activeTab.url.slice(0, 2048) : '',
      title: typeof activeTab.title === 'string' ? activeTab.title.slice(0, 500) : '',
      recordedAt: Date.now(),
    };
    const area = sessionStorageArea();
    if (!area) return null;
    await area.set({ [LEARN_ORIGIN_STORAGE_KEY]: origin });
    return origin;
  } catch (error) {
    console.warn('[LearnBridge] 记录目标标签页失败:', error);
    return null;
  }
}

/** 读取并校验来源标签页（过期/形态不符一律返回 null） */
export async function readLearnOrigin(): Promise<LearnOriginTab | null> {
  const area = sessionStorageArea();
  if (!area) return null;
  try {
    const stored = await area.get(LEARN_ORIGIN_STORAGE_KEY);
    const raw = stored[LEARN_ORIGIN_STORAGE_KEY];
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as Partial<LearnOriginTab>;
    if (!isFinitePositiveInt(value.tabId) || !isFinitePositiveInt(value.windowId)) return null;
    const recordedAt = typeof value.recordedAt === 'number' ? value.recordedAt : 0;
    if (!Number.isFinite(recordedAt) || Date.now() - recordedAt > LEARN_ORIGIN_TTL_MS) return null;
    const url = typeof value.url === 'string' ? value.url.slice(0, 2048) : '';
    // 来源记录可能来自旧版本或被导航到内部页，非网页目标一律视为无效
    if (!isLearnableUrl(url)) return null;
    return {
      tabId: value.tabId,
      windowId: value.windowId,
      url,
      title: typeof value.title === 'string' ? value.title.slice(0, 500) : '',
      recordedAt,
    };
  } catch {
    return null;
  }
}

export async function clearLearnOrigin(): Promise<void> {
  const area = sessionStorageArea();
  if (!area) return;
  try {
    await area.remove(LEARN_ORIGIN_STORAGE_KEY);
  } catch {
    /* 清理失败不影响本次操作 */
  }
}

/**
 * 校验来源标签页仍然存在，并返回其**当前**窗口（标签页可能被拖到别的窗口）。
 * 已关闭 / 已失效返回 null。
 */
export async function resolveLiveLearnOrigin(
  origin: LearnOriginTab,
): Promise<LearnOriginTab | null> {
  if (!runtimeAvailable() || !chrome.tabs?.get) return null;
  try {
    const tab = await chrome.tabs.get(origin.tabId);
    if (!tab || !isFinitePositiveInt(tab.id)) return null;
    const windowId = isFinitePositiveInt(tab.windowId) ? tab.windowId : origin.windowId;
    const url = typeof tab.url === 'string' ? tab.url.slice(0, 2048) : origin.url;
    // 标签页被导航到设置页 / 扩展页 / about:blank 后不再构成可学习目标
    if (!isLearnableUrl(url)) return null;
    return {
      tabId: tab.id,
      windowId,
      url,
      title: typeof tab.title === 'string' ? tab.title.slice(0, 500) : origin.title,
      recordedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

/** 把目标标签页切回前台（先聚焦窗口，再激活标签页） */
export async function focusLearnOrigin(origin: LearnOriginTab): Promise<boolean> {
  if (!runtimeAvailable() || !chrome.windows?.update || !chrome.tabs?.update) return false;
  try {
    await chrome.windows.update(origin.windowId, { focused: true });
    await chrome.tabs.update(origin.tabId, { active: true });
    return true;
  } catch (error) {
    console.warn('[LearnBridge] 切回目标标签页失败:', error);
    return false;
  }
}

/** 校验启动载荷（任何非法输入都返回 null，由调用方统一回 invalid-request） */
export function normalizeLearnLaunchPayload(input: unknown): LearnLaunchPayload | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Partial<LearnLaunchPayload>;
  if (!isFinitePositiveInt(raw.windowId)) return null;
  const goal = clampText(raw.goal, LEARN_GOAL_MAX_CHARS);
  if (!goal) return null;
  const notes = clampText(raw.notes, LEARN_NOTES_MAX_CHARS);
  const agentName = clampText(raw.agentName, 200);
  if (!agentName) return null;
  return {
    windowId: raw.windowId,
    goal,
    notes,
    agentName,
    originUrl: typeof raw.originUrl === 'string' ? raw.originUrl.slice(0, 2048) : undefined,
    originTitle: typeof raw.originTitle === 'string' ? raw.originTitle.slice(0, 500) : undefined,
  };
}

/** 归一化侧边栏应答；无应答一律视为「侧边栏未打开」 */
function normalizeResponse(response: unknown): LearnBridgeResponse {
  if (!response || typeof response !== 'object') {
    return { ok: false, code: 'sidepanel-unavailable' };
  }
  const value = response as { ok?: unknown; code?: unknown };
  if (value.ok === true) return { ok: true };
  const code = value.code;
  if (typeof code === 'string' && (LEARN_FAILURE_CODES as readonly string[]).includes(code)) {
    return { ok: false, code: code as LearnBridgeFailureCode };
  }
  return { ok: false, code: 'send-failed' };
}

/** 预检：侧边栏是否在场、当前会话是否在运行 */
export async function preflightLearnSession(windowId: number): Promise<LearnBridgeResponse> {
  if (!isFinitePositiveInt(windowId)) return { ok: false, code: 'invalid-request' };
  const response = await sendExtensionMessage<LearnBridgeResponse>(
    { type: LEARN_BRIDGE_MSG.PREFLIGHT, windowId },
    3_000,
  );
  return normalizeResponse(response);
}

/** 启动：请求目标窗口的侧边栏新建普通会话并发送学习请求 */
export async function startLearnSession(payload: LearnLaunchPayload): Promise<LearnBridgeResponse> {
  const normalized = normalizeLearnLaunchPayload(payload);
  if (!normalized) return { ok: false, code: 'invalid-request' };
  const response = await sendExtensionMessage<LearnBridgeResponse>(
    { type: LEARN_BRIDGE_MSG.START, payload: normalized },
    10_000,
  );
  return normalizeResponse(response);
}
