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
 * 「可用」的判定统一委托 endpoint-liveness 层（单一事实源），本模块不再
 * 自行实现过滤规则——判定口径只存在那一处，UI 与运行期永不漂移。
 *
 * 响应式约定：`configured` / `options` / `blockerIssue` 由 Vue ref 承载，
 * 任何渠道或应用设置变更（本上下文保存 / 跨上下文同步）都会自动刷新。
 * UI 直接绑定，不再需要各自维护一份「输入框是否启用」的镜像 ref。
 *
 * 本模块仅依赖 Vue 的 ref（无组件上下文），可在 Node 中单测。
 */

import { ref } from 'vue';
import { t } from '@/utils/i18n/core';
import type { ModelEndpoint, ProviderType } from '../stream/types';
import { channelStore } from './channel-store';
import { appSettingsStore } from './app-settings';
import {
  checkChannelLiveness,
  checkModelLiveness,
  firstIssue,
  type LivenessIssue,
} from './endpoint-liveness';
import { channelLabelOf } from './channel-display';
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

/** 由「已确认可用」的渠道 + 模型构造端点快照（全部数值经钳制，脏配置进不来）。
 *  重试与采样温度是全局应用设置（不按渠道单独配置），此处从 appSettings 取值。 */
function buildEndpoint(
  channel: ChannelConfig,
  model: ModelConfig,
  settings: AppSettings,
): ResolvedModelEndpoint {
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
    label: `${model.name.trim()} · ${channelLabelOf(channel)}`,
  };
}

/** 可用性问题 → 解析失败原因（单一映射点，两套枚举保持对齐） */
function issueToFailure(issue: LivenessIssue): ModelResolveFailure {
  switch (issue.code) {
    // blockerIssue 专属 code：一个渠道都没有 = 未配置（解析链带上具体渠道，
    // 实际到不了这条分支；列入只为穷尽枚举，保持两套对齐的编译期保证）
    case 'no-channels':
      return 'unconfigured';
    case 'channel-disabled':
      return 'channel-disabled';
    case 'driver-unknown':
      return 'driver-unknown';
    case 'url-empty':
    case 'url-invalid':
    case 'key-missing':
      return 'endpoint-invalid';
    case 'model-disabled':
      return 'model-disabled';
    case 'model-name-empty':
      // 模型名为空在归一层会被丢弃，理论上到不了这里；保守按端点无效处理
      return 'endpoint-invalid';
  }
}

// ==================== 注册表 ====================

/** 注册表的状态快照（一次计算，三个只读出口共用） */
interface RegistrySnapshot {
  /** 可用模型清单 */
  options: ModelOption[];
  /** 是否至少存在一个完全可用的模型 */
  configured: boolean;
  /** 「未配置」时的第一条具体原因（纯数据；文案由 UI 层查 i18n 得到） */
  blockerIssue: LivenessIssue | null;
}

class ModelRegistry {
  /**
   * 变更信号：底层存储状态发生变化即自增。
   *
   * 状态**不缓存在这里**——快照按 revision 惰性重算并记忆化：
   *   - 读到的永远是当前事实（不存在「缓存过期」窗口）；
   *   - 每次 revision 变化最多重算一次（多个 getter 共享同一份快照）；
   *   - revision 是响应式 ref，UI 的 computed / 模板能正确追踪。
   *
   * 之所以不直接用 reactive 承载快照：领域层交给上层的必须是**普通对象**，
   * 绝不能是 Vue 代理（代理会渗进会话落库 / 备份序列化的数据结构，
   * 也让「读取即拿到同一引用」的深拷贝边界失效）。
   */
  private readonly revision = ref(0);
  /** 记忆化快照（按 revision 失效） */
  private snapshot: { revision: number; value: RegistrySnapshot } | null = null;
  /** UI 层订阅者（配置变更通知） */
  private readonly listeners = new Set<() => void>();

  constructor() {
    // 注册表**始终**监听底层存储：状态新鲜度不能取决于「有没有人订阅 UI」。
    // 若只在 subscribe() 时才挂监听，未订阅时读取到的清单会停留在旧快照。
    channelStore.subscribe(() => this.handleStoreChange());
    appSettingsStore.subscribe(() => this.handleStoreChange());
  }

  /** 底层存储状态变化：作废快照 + 通知 UI 订阅者 */
  private handleStoreChange(): void {
    this.invalidate();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        // 单个订阅者异常绝不影响其它订阅者与主流程
        console.warn('[ModelRegistry] 变更监听器执行失败:', error);
      }
    }
  }

  /** 加载两个底层存储（单飞由各 store 自身保证） */
  async load(): Promise<void> {
    await Promise.all([channelStore.load(), appSettingsStore.load()]);
    this.invalidate();
  }

  /**
   * 加载并返回结构化结果（供需要区分「成功 / 存储故障」的启动路径使用）。
   * 存储故障不抛错：返回 ok=false + issues，状态按内存态（空配置）重算。
   */
  async loadWithResult(): Promise<{ ok: boolean; issues: string[] }> {
    const [channels, settings] = await Promise.all([
      channelStore.loadWithResult(),
      appSettingsStore.loadWithResult(),
    ]);
    this.invalidate();
    const issues = [...channels.issues, ...settings.issues];
    return { ok: channels.ok && settings.ok, issues };
  }

  isLoaded(): boolean {
    return channelStore.isLoaded() && appSettingsStore.isLoaded();
  }

  /**
   * 订阅配置变更（渠道或应用设置任一变化都会触发）；返回取消订阅函数。
   * 订阅回调在快照作废**之后**执行，保证回调里读到的是最新清单。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 标记状态过期（下次读取时重算） */
  private invalidate(): void {
    this.revision.value += 1;
  }

  /** 当前快照（按 revision 记忆化；读取 revision 建立响应式依赖） */
  private current(): RegistrySnapshot {
    const revision = this.revision.value;
    if (!this.snapshot || this.snapshot.revision !== revision) {
      const options = this.buildOptions();
      this.snapshot = {
        revision,
        value: {
          options,
          configured: options.length > 0,
          blockerIssue: options.length > 0 ? null : this.firstBlocker(),
        },
      };
    }
    return this.snapshot.value;
  }

  // ==================== 可用模型清单 ====================

  /**
   * 跨渠道扁平的可用模型清单（渠道顺序 → 模型顺序）。
   * 判定委托 endpoint-liveness；本方法只做「过滤 + 投影」。
   */
  private buildOptions(): ModelOption[] {
    const options: ModelOption[] = [];
    for (const channel of channelStore.getAll()) {
      const channelLiveness = checkChannelLiveness(channel);
      if (!channelLiveness.ok) continue;
      const channelLabel = channelLabelOf(channel);
      for (const model of channel.models) {
        if (!checkModelLiveness(channel, model, channelLiveness).ok) continue;
        const wireName = model.name.trim();
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

  /**
   * 「未配置」时的第一条具体原因（无渠道 / 渠道全禁 / 端点不完整 逐级回落）
   */
  private firstBlocker(): LivenessIssue | null {
    const channels = channelStore.getAll();
    if (channels.length === 0) {
      return { code: 'no-channels', channelLabel: '', modelName: '' };
    }
    for (const channel of channels) {
      const channelLiveness = checkChannelLiveness(channel);
      const channelIssue = firstIssue(channelLiveness.issues);
      if (channelIssue) return channelIssue;
      for (const model of channel.models) {
        const modelIssue = firstIssue(checkModelLiveness(channel, model, channelLiveness).issues);
        if (modelIssue) return modelIssue;
      }
    }
    return null;
  }

  /** 响应式：是否已配置出至少一个可用模型（输入框启用 / 首次配置弹窗判定） */
  get configured(): boolean {
    return this.current().configured;
  }

  /** 响应式：可用模型清单（普通对象数组，非 Vue 代理） */
  get options(): readonly ModelOption[] {
    return this.current().options;
  }

  /**
   * 响应式：「未配置」时的第一条具体原因（纯数据；文案由 UI 层查 i18n 得到）。
   * configured=true 时恒为 null。
   */
  get blockerIssue(): LivenessIssue | null {
    return this.current().blockerIssue;
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
    const options = this.current().options;
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
    if (!model) return { ok: false, reason: 'model-missing' };

    // 可用性判定与清单同源：渠道 → 模型，任一失败即带精确原因
    const channelLiveness = checkChannelLiveness(channel);
    if (!channelLiveness.ok) {
      return { ok: false, reason: issueToFailure(channelLiveness.issues[0]) };
    }
    const modelLiveness = checkModelLiveness(channel, model, channelLiveness);
    if (!modelLiveness.ok) {
      return { ok: false, reason: issueToFailure(modelLiveness.issues[0]) };
    }
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
   *
   * 幂等且零副作用：引用本就有效时**不写盘**（避免每次订阅都做一次
   * 无意义的存储往返）。
   *
   * 前置守卫：应用设置尚未加载时**不动手**——此时读到的 activeModelRef 恒为 null，
   * 分不清「用户没设默认模型」与「还没读到用户设的那个」，
   * 贸然写入会用首个可用模型覆盖用户原本的选择。
   * @returns 是否发生了修正
   */
  async healActiveRef(): Promise<boolean> {
    if (!this.isLoaded()) return false;

    const current = appSettingsStore.getActiveModelRef();
    const options = this.current().options;

    // 引用本就有效 → 无需修正（保留用户选择的模型，不强制回落到首个）
    if (current && options.some(option => option.key === modelRefKey(current))) {
      return false;
    }

    // 目标值：首个可用模型；一个都没有则清空
    const next = options.length > 0 ? options[0].ref : null;

    // 当前已是目标值（两者皆空）→ 不写盘。
    // 这一步同时是**自触发的死循环闸门**：写入会触发变更通知 → 再次自愈，
    // 若「无变化也照样写盘」就是无限自触发（一个可用模型都没有时必然发生）。
    if (!current && !next) return false;

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

/** 失败原因 → 可读提示（用户可见，含处置指引；文案走 i18n 目录） */
function describeFailure(reason: ModelResolveFailure): string {
  switch (reason) {
    case 'unconfigured':
      return t('sidepanel.apiConfig.resolveUnconfigured');
    case 'channel-missing':
      return t('sidepanel.apiConfig.resolveChannelMissing');
    case 'channel-disabled':
      return t('sidepanel.apiConfig.resolveChannelDisabled');
    case 'driver-unknown':
      return t('sidepanel.apiConfig.resolveDriverUnknown');
    case 'endpoint-invalid':
      return t('sidepanel.apiConfig.resolveEndpointInvalid');
    case 'model-missing':
      return t('sidepanel.apiConfig.resolveModelMissing');
    case 'model-disabled':
      return t('sidepanel.apiConfig.resolveModelDisabled');
  }
}

/** 全局单例 */
export const modelRegistry = new ModelRegistry();
