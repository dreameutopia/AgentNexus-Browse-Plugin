/**
 * 渠道 / 应用设置 —— 语义校验与存储归一化
 *
 * 两层防御的分工：
 *   1. 结构层（utils/config/validators.ts）：只判「是不是这份数据」（宽容进），
 *      避免合法数据因个别字段缺失落入恢复阶梯；
 *   2. 语义层（本模块）：保存前的完整校验（严格出）+ 读取后的字段级归一化，
 *      数值钳制、id 去重、脏类型收敛全部集中于此——存储里的任何脏数据
 *      在进入业务内存前都必须先过 normalize*，业务代码因此可以假设
 *      内存中的配置字段类型全部正确。
 *
 * 校验错误返回已翻译的可读文案（经 i18n t()），由设置界面直接展示。
 */

import { t } from '@/utils/i18n/core';
import { driverRegistry } from '../stream/driver-registry';
import {
  clampInt,
  clampNumber,
  CONTEXT_THRESHOLD_MAX,
  CONTEXT_THRESHOLD_MIN,
  CONTEXT_THRESHOLD_DEFAULT,
  DEFAULT_APP_SETTINGS,
  FAILED_TOOL_ROUNDS_DEFAULT,
  FAILED_TOOL_ROUNDS_MAX,
  FAILED_TOOL_ROUNDS_MIN,
  INTERACT_TIMEOUT_MAX_MINUTES,
  INTERACT_TIMEOUT_MIN_MINUTES,
  INTERACT_TIMEOUT_DEFAULT_MINUTES,
  ITERATIONS_MAX,
  ITERATIONS_MIN,
  normalizeModelRef,
  normalizeText,
  RETRY_COUNT_MAX,
  RETRY_COUNT_MIN,
  RETRY_COUNT_DEFAULT,
  RETRY_INTERVAL_MAX,
  RETRY_INTERVAL_MIN,
  RETRY_INTERVAL_DEFAULT,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
  TEMPERATURE_DEFAULT,
  TEXT_MAX_ITERATIONS_DEFAULT,
  VISION_MAX_ITERATIONS_DEFAULT,
  type AppSettings,
  type ChannelConfig,
  type ChannelState,
  type ModelConfig,
} from './channel-types';

// ==================== 存储归一化（宽容进：脏数据收敛，不丢弃可用部分） ====================

/** 归一单个模型：非对象 / id / name 缺失的条目直接丢弃（无法构成可用模型） */
function normalizeModel(raw: unknown): ModelConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const id = normalizeText(value.id);
  const name = normalizeText(value.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    vision: value.vision === true,
    // 缺省按启用处理：老数据/备份导入没有该字段时不应把模型整体隐藏
    enabled: value.enabled !== false,
    contextThreshold: clampInt(
      value.contextThreshold,
      CONTEXT_THRESHOLD_MIN,
      CONTEXT_THRESHOLD_MAX,
      CONTEXT_THRESHOLD_DEFAULT,
    ),
  };
}

/** 归一单个渠道：非对象 / id / protocol 缺失的条目丢弃；模型按条归一并按 id 去重 */
function normalizeChannel(raw: unknown): ChannelConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const id = normalizeText(value.id);
  const protocol = normalizeText(value.protocol);
  if (!id || !protocol) return null;

  const seenModelIds = new Set<string>();
  const models: ModelConfig[] = [];
  if (Array.isArray(value.models)) {
    for (const rawModel of value.models) {
      const model = normalizeModel(rawModel);
      if (!model || seenModelIds.has(model.id)) continue;
      seenModelIds.add(model.id);
      models.push(model);
    }
  }

  return {
    id,
    // 渠道名允许为空：展示层按协议标签兜底，不因缺名丢弃整个渠道
    name: normalizeText(value.name),
    // 协议值原样保留（未知协议由 UI 标记为不可用，解析层 tryGet 兜底，不丢数据）
    protocol: protocol as ChannelConfig['protocol'],
    baseUrl: normalizeText(value.baseUrl),
    apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
    enabled: value.enabled !== false,
    models,
    createdAt: typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now(),
  };
}

/** 归一渠道域文档：非对象 / 无 channels 数组 → 空态；渠道按 id 去重保序 */
export function normalizeChannelState(raw: unknown): ChannelState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { channels: [] };
  }
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.channels)) return { channels: [] };
  const seen = new Set<string>();
  const channels: ChannelConfig[] = [];
  for (const rawChannel of value.channels) {
    const channel = normalizeChannel(rawChannel);
    if (!channel || seen.has(channel.id)) continue;
    seen.add(channel.id);
    channels.push(channel);
  }
  return { channels };
}

/** 归一应用设置：逐字段钳制/收敛，activeModelRef 经 normalizeModelRef 三态化 */
export function normalizeAppSettings(raw: unknown): AppSettings {
  const base = DEFAULT_APP_SETTINGS;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...base, activeModelRef: null };
  }
  const value = raw as Record<string, unknown>;
  // 兼容旧结构：历史数据把重试/温度/阈值放在 defaults 子对象里，
  // 读取时先取顶层、缺失回落 defaults——存储归一层即完成结构迁移
  const legacyDefaults =
    typeof value.defaults === 'object' && value.defaults !== null && !Array.isArray(value.defaults)
      ? (value.defaults as Record<string, unknown>)
      : {};
  const pick = (topLevel: unknown, legacy: unknown): unknown =>
    topLevel === undefined ? legacy : topLevel;
  return {
    interactTimeoutMinutes: clampInt(
      value.interactTimeoutMinutes,
      INTERACT_TIMEOUT_MIN_MINUTES,
      INTERACT_TIMEOUT_MAX_MINUTES,
      INTERACT_TIMEOUT_DEFAULT_MINUTES,
    ),
    textMaxIterations: clampInt(
      value.textMaxIterations,
      ITERATIONS_MIN,
      ITERATIONS_MAX,
      TEXT_MAX_ITERATIONS_DEFAULT,
    ),
    visionMaxIterations: clampInt(
      value.visionMaxIterations,
      ITERATIONS_MIN,
      ITERATIONS_MAX,
      VISION_MAX_ITERATIONS_DEFAULT,
    ),
    maxConsecutiveFailedToolRounds: clampInt(
      value.maxConsecutiveFailedToolRounds,
      FAILED_TOOL_ROUNDS_MIN,
      FAILED_TOOL_ROUNDS_MAX,
      FAILED_TOOL_ROUNDS_DEFAULT,
    ),
    retryCount: clampInt(
      pick(value.retryCount, legacyDefaults.retryCount),
      RETRY_COUNT_MIN,
      RETRY_COUNT_MAX,
      base.retryCount,
    ),
    retryInterval: clampInt(
      pick(value.retryInterval, legacyDefaults.retryInterval),
      RETRY_INTERVAL_MIN,
      RETRY_INTERVAL_MAX,
      base.retryInterval,
    ),
    temperature: clampNumber(
      pick(value.temperature, legacyDefaults.temperature),
      TEMPERATURE_MIN,
      TEMPERATURE_MAX,
      base.temperature,
    ),
    defaultContextThreshold: clampInt(
      pick(value.defaultContextThreshold, legacyDefaults.contextThreshold),
      CONTEXT_THRESHOLD_MIN,
      CONTEXT_THRESHOLD_MAX,
      base.defaultContextThreshold,
    ),
    activeModelRef: normalizeModelRef(value.activeModelRef),
  };
}

// ==================== 语义校验（严格出：保存前逐项拦截） ====================

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * 校验单个模型（渠道内保存前调用）。
 * 同渠道重名由 validateChannel 统一去重报错（每个多重名只报一次），
 * 此处只负责单条目自身的形状合法性。
 */
export function validateModel(model: ModelConfig): string[] {
  const errors: string[] = [];
  if (!model.name.trim()) {
    errors.push(t('sidepanel.apiConfig.validateModelNameEmpty'));
  }
  if (!Number.isInteger(model.contextThreshold)) {
    errors.push(t('sidepanel.apiConfig.validateThresholdInteger'));
  } else if (model.contextThreshold < CONTEXT_THRESHOLD_MIN) {
    errors.push(t('sidepanel.apiConfig.validateThresholdMin'));
  } else if (model.contextThreshold > CONTEXT_THRESHOLD_MAX) {
    errors.push(t('sidepanel.apiConfig.validateThresholdMax'));
  }
  return errors;
}

/** 校验单个渠道（保存前调用；含其全部模型） */
export function validateChannel(channel: ChannelConfig): string[] {
  const errors: string[] = [];

  if (!driverRegistry.has(channel.protocol)) {
    errors.push(t('sidepanel.apiConfig.unsupportedProtocol', { provider: String(channel.protocol) }));
  }
  if (!channel.baseUrl.trim()) {
    errors.push(t('sidepanel.apiConfig.validateUrlRequired'));
  } else if (!isValidUrl(channel.baseUrl.trim())) {
    errors.push(t('sidepanel.apiConfig.invalidServiceUrl'));
  }
  // 驱动策略：需要密钥的协议（非 Ollama 本地协议）必须填写 Key
  if (driverRegistry.requiresApiKey(channel.protocol) && !channel.apiKey.trim()) {
    errors.push(t('sidepanel.apiConfig.validateApiKeyRequired'));
  }

  if (channel.models.length === 0) {
    errors.push(t('sidepanel.apiConfig.validateChannelNoModels'));
  } else {
    // 重名检测：首次出现不报，再次出现时按名报一次——
    // 「A/B 同名」只产生一条错误，不会因两两互查重复刷屏
    const seenNames = new Set<string>();
    for (const model of channel.models) {
      errors.push(...validateModel(model));
      const key = model.name.trim();
      if (!key) continue;
      if (seenNames.has(key)) {
        errors.push(t('sidepanel.apiConfig.validateModelDuplicate', { name: key }));
      } else {
        seenNames.add(key);
      }
    }
  }

  return errors;
}

/** 校验整个渠道文档（保存前调用；渠道 id 重复一并拦截） */
export function validateChannelState(state: ChannelState): string[] {
  const errors: string[] = [];
  const seenIds = new Set<string>();
  for (const channel of state.channels) {
    if (seenIds.has(channel.id)) {
      errors.push(t('sidepanel.apiConfig.validateDuplicateChannelId'));
      continue;
    }
    seenIds.add(channel.id);
    const channelErrors = validateChannel(channel);
    // 错误前缀带渠道名（无名渠道用协议标签），多渠道时能一眼定位是哪一个
    if (channelErrors.length > 0) {
      const label = channel.name.trim() || driverRegistry.tryGet(channel.protocol)?.meta.label || channel.protocol;
      errors.push(...channelErrors.map(error => `[${label}] ${error}`));
    }
  }
  return errors;
}

/** 校验应用设置（保存前调用） */
export function validateAppSettings(settings: AppSettings): string[] {
  const errors: string[] = [];
  const minutes = settings.interactTimeoutMinutes;
  if (
    !Number.isInteger(minutes) ||
    minutes < INTERACT_TIMEOUT_MIN_MINUTES ||
    minutes > INTERACT_TIMEOUT_MAX_MINUTES
  ) {
    errors.push(t('sidepanel.apiConfig.validateInteractTimeoutRange'));
  }
  if (
    !Number.isInteger(settings.textMaxIterations) ||
    settings.textMaxIterations < ITERATIONS_MIN ||
    settings.textMaxIterations > ITERATIONS_MAX
  ) {
    errors.push(t('sidepanel.apiConfig.validateTextIterationsRange'));
  }
  if (
    !Number.isInteger(settings.visionMaxIterations) ||
    settings.visionMaxIterations < ITERATIONS_MIN ||
    settings.visionMaxIterations > ITERATIONS_MAX
  ) {
    errors.push(t('sidepanel.apiConfig.validateVisionIterationsRange'));
  }
  if (
    !Number.isInteger(settings.maxConsecutiveFailedToolRounds) ||
    settings.maxConsecutiveFailedToolRounds < FAILED_TOOL_ROUNDS_MIN ||
    settings.maxConsecutiveFailedToolRounds > FAILED_TOOL_ROUNDS_MAX
  ) {
    errors.push(t('sidepanel.apiConfig.validateToolFailRoundsRange'));
  }
  if (
    !Number.isInteger(settings.retryCount) ||
    settings.retryCount < RETRY_COUNT_MIN ||
    settings.retryCount > RETRY_COUNT_MAX
  ) {
    errors.push(t('sidepanel.apiConfig.validateRetryRange'));
  }
  if (
    !Number.isInteger(settings.retryInterval) ||
    settings.retryInterval < RETRY_INTERVAL_MIN ||
    settings.retryInterval > RETRY_INTERVAL_MAX
  ) {
    errors.push(t('sidepanel.apiConfig.validateRetryIntervalRange'));
  }
  if (
    !Number.isFinite(settings.temperature) ||
    settings.temperature < TEMPERATURE_MIN ||
    settings.temperature > TEMPERATURE_MAX
  ) {
    errors.push(t('sidepanel.apiConfig.validateTemperatureRange'));
  }
  if (
    !Number.isInteger(settings.defaultContextThreshold) ||
    settings.defaultContextThreshold < CONTEXT_THRESHOLD_MIN ||
    settings.defaultContextThreshold > CONTEXT_THRESHOLD_MAX
  ) {
    errors.push(t('sidepanel.apiConfig.validateThresholdInteger'));
  }
  return errors;
}