/**
 * 模型注册表（ModelRegistry）—— 引用解析的单一入口
 *
 * 职责：
 *   1. 把稳定引用（ModelRef）解析为可直接发请求的端点快照（ResolvedModelEndpoint），
 *      快照内聚：协议驱动 id / baseUrl / apiKey / 模型 wire name / 重试与采样参数 /
 *      上下文阈值 —— 解析一经完成，整条请求链路只读快照、绝不回读全局配置；
 *   2. 解析的回落链（防御引用失效，保证会话永不因配置变动而报错中断）：
 *        会话引用 → 全局默认引用 → 首个可用模型 → 显式失败
 *      回落发生时携带 fallbackFrom / fallbackReason，调用方可据此向用户提示
 *      「原模型已不可用，已自动切换」；
 *   3. 可用模型清单（跨渠道扁平化，供选择器 / 一次性调用方）与视觉能力判定；
 *   4. 全局默认引用的自愈（渠道/模型被删除后 activeModelRef 自动回落）。
 *
 * 「可用」的判定（listOptions 的过滤条件，同时也是 resolve 的有效性条件）：
 *   渠道已启用 + 协议驱动已注册 + baseUrl 合法 + 模型已启用 + 模型名非空
 *   +（驱动要求时）apiKey 非空。
 *
 * 本模块无 Vue 依赖；订阅机制供 UI 层把变更同步到响应式状态。
 */

import { driverRegistry } from '../stream/driver-registry';
import type { ModelEndpoint, ProviderType } from '../stream/types';
import { channelStore } from './channel-store';
import { appSettingsStore } from './app-settings';
import {
  clampInt,
  clampNumber,
  CONTEXT_THRESHOLD_MAX,
  CONTEXT_THRESHOLD_MIN,
  CONTEXT_THRESHOLD_DEFAULT,
  modelRefKey,
  normalizeModelRef,
  RETRY_COUNT_MAX,
  RETRY_COUNT_MIN,
  RETRY_COUNT_DEFAULT,
  RETRY_INTERVAL_MAX,
  RETRY_INTERVAL_MIN,
  RETRY_INTERVAL_DEFAULT,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
  TEMPERATURE_DEFAULT,
  type AppSettings,
  type ChannelConfig,
  type ModelConfig,
  type ModelRef,
} from './channel-types';

// ==================== 类型 ====================

/** 解析成功的端点快照（运行期不可变；apiKey 只存在于内存） */
export interface ResolvedModelEndpoint extends ModelEndpoint {
  /** 该模型的上下文字符阈值（窗口计量与守卫使用） */
  contextThreshold: number;
  /** 来源引用（供会话回写 / 日志 / 定位） */
  ref: ModelRef;
  /** 展示标签：「模型展示名 · 渠道名」 */
  label: string;
}

/** 解析失败原因（穷尽枚举，便于 UI 精确提示） */
export type ModelResolveFailure =
  /** 一个可用模型都没有（未配置） */
  | 'unconfigured'
  /** 引用的渠道不存在（已被删除） */
  | 'channel-missing'
  /** 渠道被禁用 */
  | 'channel-disabled'
  /** 渠道协议未注册（驱动缺失，配置了不支持的协议） */
  | 'driver-unknown'
  /** 渠道端点不完整（无 baseUrl / URL 非法 / 缺少必需的 apiKey） */
  | 'endpoint-invalid'
  /** 引用的模型不存在（已被删除） */
  | 'model-missing'
  /** 模型被禁用 */
  | 'model-disabled';

/** 解析结果：成功携带快照与回落轨迹；失败携带精确原因 */
export type ModelResolution =
  | {
      ok: true;
      endpoint: ResolvedModelEndpoint;
      /** 实际使用的引用与请求引用不同（发生了回落）时为被放弃的原引用 */
      fallbackFrom?: ModelRef;
      /** 回落原因（引用为何失效） */
      fallbackReason?: ModelResolveFailure;
    }
  | { ok: false; reason: ModelResolveFailure };

/** 可选模型条目（跨渠道扁平清单，供选择器渲染） */
export interface ModelOption {
  /** 稳定键（modelRefKey），用于 v-for key 与选择签名 */
  key: string;
  ref: ModelRef;
  /** 发送给提供商的模型名 */
  wireName: string;
  /** 展示名（= wireName；渠道名由 channelName 单独标注） */
  label: string;
  /** 所属渠道展示名（空名渠道回落协议标签） */
  channelName: string;
  /** 所属渠道协议 */
  protocol: ProviderType;
  /** 视觉能力声明 */
  vision: boolean;
  /** 该模型的上下文字符阈值（附件预算 / 圆环估算用，已钳制） */
  contextThreshold: number;
}

// ==================== 解析细节 ====================

/** 端点有效性：驱动已知 + baseUrl 合法 +（策略要求时）apiKey 非空 */
function endpointValidity(channel: ChannelConfig): ModelResolveFailure | null {
  if (!driverRegistry.has(channel.protocol)) return 'driver-unknown';
  const baseUrl = channel.baseUrl.trim();
  if (!baseUrl) return 'endpoint-invalid';
  try {
    new URL(baseUrl);
  } catch {
    return 'endpoint-invalid';
  }
  if (driverRegistry.requiresApiKey(channel.protocol) && !channel.apiKey.trim()) {
    return 'endpoint-invalid';
  }
  return null;
}

/** 单模型可用性检查：渠道侧 → 模型侧，返回 null 表示可用 */
function modelAvailability(
  channel: ChannelConfig | null,
  model: ModelConfig | null,
  ref: ModelRef,
): ModelResolveFailure | null {
  if (!channel) return 'channel-missing';
  if (ref.channelId !== channel.id) return 'channel-missing';
  if (!channel.enabled) return 'channel-disabled';
  const endpointError = endpointValidity(channel);
  if (endpointError) return endpointError;
  if (!model) return 'model-missing';
  if (ref.modelId !== model.id) return 'model-missing';
  if (!model.enabled) return 'model-disabled';
  if (!model.name.trim()) return 'endpoint-invalid';
  return null;
}

/** 由「已确认可用」的渠道 + 模型构造端点快照（全部数值经钳制，脏配置进不来）。
 *  重试与采样温度是全局应用设置（不按渠道单独配置），此处从 appSettings 取值。 */
function buildEndpoint(
  channel: ChannelConfig,
  model: ModelConfig,
  settings: AppSettings,
): ResolvedModelEndpoint {
  const channelLabel = channel.name.trim() || driverRegistry.tryGet(channel.protocol)?.meta.label || channel.protocol;
  return {
    provider: channel.protocol,
    baseUrl: channel.baseUrl.trim(),
    model: model.name.trim(),
    apiKey: channel.apiKey,
    retryCount: clampInt(settings.retryCount, RETRY_COUNT_MIN, RETRY_COUNT_MAX, RETRY_COUNT_DEFAULT),
    retryIntervalMs: clampInt(settings.retryInterval, RETRY_INTERVAL_MIN, RETRY_INTERVAL_MAX, RETRY_INTERVAL_DEFAULT) * 1000,
    temperature: clampNumber(settings.temperature, TEMPERATURE_MIN, TEMPERATURE_MAX, TEMPERATURE_DEFAULT),
    contextThreshold: clampInt(
      model.contextThreshold,
      CONTEXT_THRESHOLD_MIN,
      CONTEXT_THRESHOLD_MAX,
      CONTEXT_THRESHOLD_DEFAULT,
    ),
    ref: { channelId: channel.id, modelId: model.id },
    label: `${model.name.trim()} · ${channelLabel}`,
  };
}

// ==================== 注册表 ====================

class ModelRegistry {
  /** 加载两个底层存储（单飞由各 store 自身保证） */
  async load(): Promise<void> {
    await Promise.all([channelStore.load(), appSettingsStore.load()]);
  }

  isLoaded(): boolean {
    return channelStore.isLoaded() && appSettingsStore.isLoaded();
  }

  /** 订阅配置变更（渠道或应用设置任一变化都会触发）；返回取消订阅函数 */
  subscribe(listener: () => void): () => void {
    const offChannels = channelStore.subscribe(listener);
    const offSettings = appSettingsStore.subscribe(listener);
    return () => {
      offChannels();
      offSettings();
    };
  }

  // ==================== 可用模型清单 ====================

  /** 跨渠道扁平的可用模型清单（渠道顺序 → 模型顺序，过滤规则见模块头注释） */
  listOptions(): ModelOption[] {
    const options: ModelOption[] = [];
    for (const channel of channelStore.getAll()) {
      if (!channel.enabled) continue;
      if (endpointValidity(channel)) continue;
      const channelLabel =
        channel.name.trim() || driverRegistry.tryGet(channel.protocol)?.meta.label || channel.protocol;
      for (const model of channel.models) {
        if (!model.enabled) continue;
        const wireName = model.name.trim();
        if (!wireName) continue;
        options.push({
          key: modelRefKey({ channelId: channel.id, modelId: model.id }),
          ref: { channelId: channel.id, modelId: model.id },
          wireName,
          label: wireName,
          channelName: channelLabel,
          protocol: channel.protocol,
          vision: model.vision,
          contextThreshold: clampInt(
            model.contextThreshold,
            CONTEXT_THRESHOLD_MIN,
            CONTEXT_THRESHOLD_MAX,
            CONTEXT_THRESHOLD_DEFAULT,
          ),
        });
      }
    }
    return options;
  }

  /** 是否已配置出至少一个可用模型（输入框启用 / 首次配置弹窗判定） */
  isConfigured(): boolean {
    return this.listOptions().length > 0;
  }

  // ==================== 解析 ====================

  /**
   * 解析端点快照（回落链：preferred → active → 首个可用 → 失败）。
   * 不抛错：预期内的失效以结果值返回，由调用方决定提示或继续。
   */
  resolve(preferred?: ModelRef | null): ModelResolution {
    const normalizedPreferred = normalizeModelRef(preferred);
    const active = appSettingsStore.getActiveModelRef();

    let fallbackFrom: ModelRef | undefined;
    let fallbackReason: ModelResolveFailure | undefined;

    // 候选顺序：请求引用 → 全局默认引用（去重）
    const preferredKey = normalizedPreferred ? modelRefKey(normalizedPreferred) : '';
    const candidates: ModelRef[] = [];
    if (normalizedPreferred) candidates.push(normalizedPreferred);
    if (active && modelRefKey(active) !== preferredKey) {
      candidates.push(active);
    }

    for (const ref of candidates) {
      const attempt = this.resolveExact(ref);
      if (attempt.ok) {
        if (fallbackReason && normalizedPreferred) {
          return { ...attempt, fallbackFrom: normalizedPreferred, fallbackReason };
        }
        return attempt;
      }
      // 记录「首选引用」的失效原因（后续候选成功时作为回落原因上报）
      if (!fallbackReason) {
        fallbackFrom = ref;
        fallbackReason = attempt.reason;
      }
    }

    // 回落兜底：清单里的第一个可用模型
    const options = this.listOptions();
    if (options.length > 0) {
      const attempt = this.resolveExact(options[0].ref);
      if (attempt.ok) {
        if (fallbackReason && normalizedPreferred) {
          return { ...attempt, fallbackFrom: normalizedPreferred, fallbackReason };
        }
        return attempt;
      }
    }

    return { ok: false, reason: 'unconfigured' };
  }

  /** 精确解析（无回落；供 resolve 与「必须命中此引用」的场景） */
  resolveExact(ref: ModelRef): ModelResolution {
    const normalized = normalizeModelRef(ref);
    if (!normalized) return { ok: false, reason: 'unconfigured' };
    const channel = channelStore.get(normalized.channelId);
    if (!channel) return { ok: false, reason: 'channel-missing' };
    const model = channel.models.find(item => item.id === normalized.modelId) ?? null;
    const failure = modelAvailability(channel, model, normalized);
    if (failure) return { ok: false, reason: failure };
    // 走到这里 modelAvailability 已保证 model 非空（防御：显式再断一次，杜绝 cast）
    if (!model) return { ok: false, reason: 'model-missing' };
    return { ok: true, endpoint: buildEndpoint(channel, model, appSettingsStore.get()) };
  }

  /**
   * 解析并要求成功（回落链同 resolve）；失败抛出带精确原因的可读错误。
   * 供 runtime 装配与一次性调用方（工作流 AI 工具）使用——这些场景
   * 「没有可用模型」是必须中断的前置条件，不是可降级状态。
   */
  require(preferred?: ModelRef | null): ResolvedModelEndpoint {
    const resolution = this.resolve(preferred);
    if (!resolution.ok) {
      throw new Error(describeFailure(resolution.reason));
    }
    if (resolution.fallbackReason && resolution.fallbackFrom) {
      console.warn(
        `[ModelRegistry] 引用 ${modelRefKey(resolution.fallbackFrom)} 已不可用（${resolution.fallbackReason}），` +
          `已回落到 ${modelRefKey(resolution.endpoint.ref)}`,
      );
    }
    return resolution.endpoint;
  }

  /** 解析「当前生效模型」（一次性调用方入口） */
  resolveActive(): ResolvedModelEndpoint {
    return this.require(null);
  }

  // ==================== 全局默认引用自愈 ====================

  /**
   * 自愈 activeModelRef：指向的模型已不可用（删除/禁用/端点失效）时，
   * 回落到首个可用模型；一个可用模型都没有则清空。
   * @returns 是否发生了修正
   */
  async healActiveRef(): Promise<boolean> {
    const current = appSettingsStore.getActiveModelRef();
    const options = this.listOptions();
    const stillValid = current && options.some(option => option.key === modelRefKey(current));
    if (stillValid) return false;
    const next = options.length > 0 ? options[0].ref : null;
    const result = await appSettingsStore.save({ activeModelRef: next });
    if (!result.ok) {
      console.warn('[ModelRegistry] 默认模型自愈写入失败:', result.errors);
      return false;
    }
    if (current) {
      console.info(
        `[ModelRegistry] 默认模型 ${modelRefKey(current)} 已不可用，已切换为 ${next ? modelRefKey(next) : '(空)'}`,
      );
    }
    return true;
  }
}

/** 失败原因 → 可读中文提示（用户可见，含处置指引） */
function describeFailure(reason: ModelResolveFailure): string {
  switch (reason) {
    case 'unconfigured':
      return '模型配置不完整：尚无可用模型，请先在设置中添加渠道与模型';
    case 'channel-missing':
      return '模型配置不完整：所属渠道已被删除，请在设置中重新选择模型';
    case 'channel-disabled':
      return '模型配置不完整：所属渠道已被禁用，请在设置中启用该渠道';
    case 'driver-unknown':
      return '模型配置不完整：渠道使用的协议未注册（驱动缺失），请检查渠道协议设置';
    case 'endpoint-invalid':
      return '模型配置不完整：渠道缺少有效的服务地址或密钥，请先完成渠道设置';
    case 'model-missing':
      return '模型配置不完整：所选模型已被删除，请在设置中重新选择模型';
    case 'model-disabled':
      return '模型配置不完整：所选模型已被禁用，请在设置中启用该模型';
  }
}

/** 全局单例 */
export const modelRegistry = new ModelRegistry();