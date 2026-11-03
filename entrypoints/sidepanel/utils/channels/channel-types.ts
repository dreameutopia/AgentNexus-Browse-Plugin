/**
 * 渠道 + 模型 领域类型与常量（单一事实源）
 *
 * 领域模型（解耦后的配置结构）：
 *   AppSettings  —— 全局应用设置：interactTimeout、对话循环轮次与工具失败
 *                   阈值、全局请求参数（重试 / 采样温度）、新建模型的默认
 *                   上下文阈值、当前生效模型引用（activeModelRef）
 *   ChannelConfig—— 渠道：一个上游服务接入点，独立持有 协议驱动 / baseUrl /
 *                   apiKey，并挂载多个模型（重试与采样是全局参数，不按渠道单独配置）
 *   ModelConfig  —— 模型：渠道内的具体模型，独立持有 展示名 / 视觉能力声明 /
 *                   启停状态 / 上下文窗口阈值
 *
 * 引用约定：
 *   - 会话与全局默认一律用 ModelRef { channelId, modelId }（稳定 id 引用），
 *     模型名/渠道名是可变展示属性，绝不作为引用；
 *   - 密钥只存在 ChannelConfig.apiKey（本地配置存储），请求层拿到的是
 *     运行期解析出的端点快照（ModelEndpoint），二者不交叉。
 *
 * 本模块零外部依赖（仅类型导入），可被 UI / 存储 / 装配层任意引用而无环。
 */

import type { ProviderType } from '../stream/types';

// ==================== 领域类型 ====================

/** 渠道内的模型配置 */
export interface ModelConfig {
  /** 稳定 id（uuid；会话与默认模型引用的组成部分） */
  id: string;
  /** 发送给提供商的模型名（wire name，如 "gpt-4o"；同时作为展示名，渠道名在 UI 侧另行标注） */
  name: string;
  /**
   * 用户显式声明的视觉能力。
   * 视觉能力无法从模型名可靠推断（同名模型经不同中转/协议能力不一），
   * 由用户逐模型声明；输入区图片准入与选择器眼睛标识均以此为准。
   */
  vision: boolean;
  /** 是否启用（禁用仅从可选列表隐藏，配置保留） */
  enabled: boolean;
  /** AI 上下文字符阈值（该模型的上下文窗口预算，8192~1048576） */
  contextThreshold: number;
}

/** 模型引用（稳定 id 对；会话持久化与全局默认均使用它） */
export interface ModelRef {
  channelId: string;
  modelId: string;
}

/** 渠道（一个独立的协议 + 端点 + 凭据接入点，可挂载多个模型） */
export interface ChannelConfig {
  /** 稳定 id（uuid） */
  id: string;
  /** 渠道展示名（如 "OpenAI 官方"、"公司中转"） */
  name: string;
  /** 协议驱动 id（见 stream/driver-registry） */
  protocol: ProviderType;
  /** API 服务基础 URL */
  baseUrl: string;
  /** API 密钥（本地协议可为空串；请求层只经端点快照透传，绝不落日志） */
  apiKey: string;
  /** 是否启用（禁用后其模型整体退出可选列表，配置保留） */
  enabled: boolean;
  /** 渠道下的模型列表 */
  models: ModelConfig[];
  createdAt: number;
  updatedAt: number;
}

/**
 * 全局应用设置（独立于渠道的跨域配置）。
 * 重试与采样温度是**全局请求参数**（对所有渠道的所有请求生效），
 * 不按渠道单独配置——渠道编辑器不再提供这三项输入。
 */
export interface AppSettings {
  /** interact 询问弹窗最长等待时长（分钟，1~120） */
  interactTimeoutMinutes: number;
  /** 文本对话的最大工具循环轮次（1~100；装配时覆盖 runtime 的文本轮次上限） */
  textMaxIterations: number;
  /** 视觉对话的最大工具循环轮次（1~100；装配时覆盖 runtime 的视觉轮次上限） */
  visionMaxIterations: number;
  /**
   * 连续「整轮工具全部失败」触发延续确认的轮数阈值（1~50，默认 5）。
   * 单轮失败交模型自纠；连续全败说明环境性阻塞，达到该阈值时升级为
   * 用户决策（确认继续 / 停止），避免重复撞墙烧 token。
   */
  maxConsecutiveFailedToolRounds: number;
  /** 全局自动重试次数（0~10；失败后指数退避重试） */
  retryCount: number;
  /** 全局重试间隔基数（秒，指数退避；1~120） */
  retryInterval: number;
  /** 全局采样温度（0~2；单次请求可覆盖，如压缩固定低温度） */
  temperature: number;
  /** 新建模型时采用的默认上下文阈值（已有模型各自持有 contextThreshold） */
  defaultContextThreshold: number;
  /** 当前生效模型（新会话与一次性调用方的默认选择；null = 未配置） */
  activeModelRef: ModelRef | null;
}

/** 渠道域持久化文档形态（为未来扩展预留包裹层） */
export interface ChannelState {
  channels: ChannelConfig[];
}

// ==================== 数值边界（校验 / 钳制 / UI 三处共用，永不漂移） ====================

export const RETRY_COUNT_MIN = 0;
export const RETRY_COUNT_MAX = 10;
export const RETRY_COUNT_DEFAULT = 2;

export const RETRY_INTERVAL_MIN = 1;
export const RETRY_INTERVAL_MAX = 120;
export const RETRY_INTERVAL_DEFAULT = 2;

export const TEMPERATURE_MIN = 0;
export const TEMPERATURE_MAX = 2;
export const TEMPERATURE_DEFAULT = 0.7;

export const CONTEXT_THRESHOLD_MIN = 8 * 1024;
export const CONTEXT_THRESHOLD_MAX = 1024 * 1024;
export const CONTEXT_THRESHOLD_DEFAULT = 256 * 1024;

/**
 * interact 询问弹窗等待时长的合法边界（分钟）。
 * 默认 20 分钟；范围 1-120。
 */
export const INTERACT_TIMEOUT_MIN_MINUTES = 1;
export const INTERACT_TIMEOUT_MAX_MINUTES = 120;
export const INTERACT_TIMEOUT_DEFAULT_MINUTES = 20;

/**
 * 对话循环轮次上限的合法边界（文本 / 视觉共用；校验 / 钳制 / UI 三处共用）。
 * 默认值与 runtime 装配层的 DEFAULT_TEXT_LIMITS / DEFAULT_VISION_LIMITS 对齐。
 */
export const ITERATIONS_MIN = 1;
export const ITERATIONS_MAX = 100;
export const TEXT_MAX_ITERATIONS_DEFAULT = 20;
export const VISION_MAX_ITERATIONS_DEFAULT = 10;

/**
 * 连续「整轮工具全部失败」阈值的合法边界（校验 / 钳制 / UI 三处共用）。
 * 默认 5 轮；范围 1-50。
 */
export const FAILED_TOOL_ROUNDS_MIN = 1;
export const FAILED_TOOL_ROUNDS_MAX = 50;
export const FAILED_TOOL_ROUNDS_DEFAULT = 5;

// ==================== 归一化与工具函数（防御性编程的公共件） ====================

/**
 * 数值钳制：非有限数 / 越界一律收敛到合法区间。
 * 存储层不保证字段形状（外部写入、备份导入皆可能），所有数值进入业务前
 * 必须过这一道，保证下游拿到的恒为有限正数。
 */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 整数钳制（重试次数 / 阈值等必须为整数的字段） */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clampNumber(value, min, max, fallback));
}

/** 可选字符串归一：非字符串 → fallback，字符串去首尾空白 */
export function normalizeText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.trim();
}

/**
 * 模型引用归一：只有「两个非空字符串 id」才是合法引用。
 * 任何其它形态（缺字段 / 空串 / 非对象）一律返回 null——
 * 调用方据 null 走回落链，绝不把脏引用带进解析。
 */
export function normalizeModelRef(value: unknown): ModelRef | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const channelId = typeof raw.channelId === 'string' ? raw.channelId.trim() : '';
  const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : '';
  if (!channelId || !modelId) return null;
  return { channelId, modelId };
}

/** 引用 → 稳定字符串键（UI key / 选择签名 / 集合成员判定共用） */
export function modelRefKey(ref: ModelRef): string {
  return `${ref.channelId}/${ref.modelId}`;
}

/** 生成稳定 id（优先 crypto.randomUUID，降级时间戳+随机数，兼容非安全上下文） */
export function generateId(prefix: string): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${uuid}`;
}

// ==================== 默认值 ====================

export const DEFAULT_APP_SETTINGS: AppSettings = {
  interactTimeoutMinutes: INTERACT_TIMEOUT_DEFAULT_MINUTES,
  textMaxIterations: TEXT_MAX_ITERATIONS_DEFAULT,
  visionMaxIterations: VISION_MAX_ITERATIONS_DEFAULT,
  maxConsecutiveFailedToolRounds: FAILED_TOOL_ROUNDS_DEFAULT,
  retryCount: RETRY_COUNT_DEFAULT,
  retryInterval: RETRY_INTERVAL_DEFAULT,
  temperature: TEMPERATURE_DEFAULT,
  defaultContextThreshold: CONTEXT_THRESHOLD_DEFAULT,
  activeModelRef: null,
};

/** 构造一个「空渠道」骨架（id 与时间戳即时生成） */
export function createEmptyChannel(protocol: ProviderType): ChannelConfig {
  const now = Date.now();
  return {
    id: generateId('ch'),
    name: '',
    protocol,
    baseUrl: '',
    apiKey: '',
    enabled: true,
    models: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** 构造一个「空模型」骨架（上下文阈值取全局默认，可由调用方覆盖） */
export function createEmptyModel(defaultContextThreshold?: number): ModelConfig {
  const threshold = clampInt(
    defaultContextThreshold,
    CONTEXT_THRESHOLD_MIN,
    CONTEXT_THRESHOLD_MAX,
    CONTEXT_THRESHOLD_DEFAULT,
  );
  return {
    id: generateId('mdl'),
    name: '',
    vision: false,
    enabled: true,
    contextThreshold: threshold,
  };
}

// ==================== 深拷贝（防御外部持有引用后原地篡改） ====================

/** 模型深拷贝（渠道拷贝的内部构件，不对外导出以收窄可变面） */
function cloneModel(model: ModelConfig): ModelConfig {
  return { ...model };
}

export function cloneChannel(channel: ChannelConfig): ChannelConfig {
  return { ...channel, models: channel.models.map(cloneModel) };
}

export function cloneChannelState(state: ChannelState): ChannelState {
  return { channels: state.channels.map(cloneChannel) };
}

export function cloneAppSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    activeModelRef: settings.activeModelRef ? { ...settings.activeModelRef } : null,
  };
}