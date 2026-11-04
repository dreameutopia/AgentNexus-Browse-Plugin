/**
 * 语音识别（ASR）配置持久化存储模块
 *
 * 与渠道配置管理器（utils/channels）同构：持久化委托给配置持久化引擎（asrConfig 域），
 * 主副本 + 镜像副本 + 滚动快照三层冗余。
 *
 * 仅支持 OpenAI 兼容协议族（POST {baseUrl}/audio/transcriptions）：
 * - SiliconFlow（FunAudioLLM/SenseVoiceSmall、TeleAI/TeleSpeechASR，2026-10 依官方
 *   OpenAPI 枚举核实，FunAudioLLM/Fun-ASR 已不在可用模型列表）
 * - OpenAI（推荐 gpt-transcribe；whisper-1 / gpt-4o-transcribe / gpt-4o-mini-transcribe
 *   已被官方弃用，2027-02-26 关停，过渡期仍可用）
 * - Groq（whisper-large-v3、whisper-large-v3-turbo）
 * - 自定义 OpenAI 兼容服务（自定义 baseURL）
 * 阿里云 DashScope 的 ASR 为任务提交+轮询 / WebSocket 流式协议，非 OpenAI 兼容，
 * 仅在文档列表中展示（supported: false，标注「即将上线」）。
 */

import { getEngine } from '../config/engine';
import { t, type MessageKey } from '@/utils/i18n/core';

// ==================== 配置接口 ====================

/** 可配置的 ASR 供应商（OpenAI 兼容协议族） */
export type AsrProvider = 'siliconflow' | 'openai' | 'groq' | 'custom';

/** 文档列表中的供应商 id（含暂不支持的 DashScope） */
export type AsrProviderId = AsrProvider | 'dashscope';

/** 用户 ASR 配置 */
export interface UserAsrConfig {
  /** ASR 供应商 */
  provider: AsrProvider;
  /** 接口基础地址（OpenAI 兼容，拼接 /audio/transcriptions） */
  baseUrl: string;
  /** API 密钥 */
  apiKey: string;
  /** 模型名称，如 FunAudioLLM/SenseVoiceSmall */
  model: string;
}

// ==================== 供应商元数据 ====================

/** ASR 供应商元数据 — 用于设置页卡片、输入提示与文档链接 */
export interface AsrProviderMeta {
  label: string;
  value: AsrProviderId;
  /** 默认接口基础地址（custom 为空，用户必填） */
  baseUrl: string;
  /** 推荐模型（点击快速填入） */
  models: string[];
  /** 官方文档链接 */
  docsUrl: string;
  /** 是否已在当前版本支持配置 */
  supported: boolean;
  /** 供应商说明文案（消息键） */
  hintKey: MessageKey;
}

/** 支持的 ASR 供应商（设置页「支持的供应商」文档列表数据源，含暂不支持项） */
export const SUPPORTED_ASR_PROVIDERS: readonly AsrProviderMeta[] = [
  {
    label: 'SiliconFlow 硅基流动',
    value: 'siliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['FunAudioLLM/SenseVoiceSmall', 'TeleAI/TeleSpeechASR'],
    docsUrl: 'https://docs.siliconflow.com/en/api-reference/audio/create-audio-transcriptions',
    supported: true,
    hintKey: 'sidepanel.asr.hintSiliconflow',
  },
  {
    label: 'OpenAI',
    value: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-transcribe', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'],
    docsUrl: 'https://developers.openai.com/api/docs/guides/speech-to-text',
    supported: true,
    hintKey: 'sidepanel.asr.hintOpenai',
  },
  {
    label: 'Groq',
    value: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['whisper-large-v3', 'whisper-large-v3-turbo'],
    docsUrl: 'https://console.groq.com/docs/speech-to-text',
    supported: true,
    hintKey: 'sidepanel.asr.hintGroq',
  },
  {
    label: '自定义（OpenAI 兼容）',
    value: 'custom',
    baseUrl: '',
    models: [],
    docsUrl: '',
    supported: true,
    hintKey: 'sidepanel.asr.hintCustom',
  },
  {
    label: '阿里云 DashScope',
    value: 'dashscope',
    baseUrl: '',
    models: ['paraformer-realtime-v2', 'qwen3-asr-flash-filetrans', 'qwen3-asr-flash-realtime'],
    docsUrl: 'https://help.aliyun.com/zh/model-studio/asr-model',
    supported: false,
    hintKey: 'sidepanel.asr.hintDashscope',
  },
];

// ==================== 默认配置 ====================

export const DEFAULT_ASR_CONFIG: UserAsrConfig = {
  provider: 'siliconflow',
  baseUrl: '',
  apiKey: '',
  model: '',
};

/** 供应商 → 默认 baseUrl（custom 无默认值） */
export function defaultBaseUrlOf(provider: AsrProvider): string {
  return SUPPORTED_ASR_PROVIDERS.find(meta => meta.value === provider)?.baseUrl ?? '';
}

/** 供应商 → 推荐模型列表 */
export function recommendModelsOf(provider: AsrProvider): string[] {
  return SUPPORTED_ASR_PROVIDERS.find(meta => meta.value === provider)?.models ?? [];
}

/**
 * 拼接转写端点：baseUrl 去尾部斜杠 + /audio/transcriptions
 * 供 voice-to-text 与设置页「实际请求地址」预览共用，杜绝两套拼接逻辑漂移。
 */
export function resolveTranscriptionEndpoint(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/audio/transcriptions`;
}

/** 供应商 id 白名单（未知值一律回落默认供应商） */
const ASR_PROVIDERS: readonly AsrProvider[] = ['siliconflow', 'openai', 'groq', 'custom'];

/**
 * 逐字段归一 ASR 配置（宽容进、严格出）。
 * 存储层不保证字段形状（备份导入 / 外部写入皆可能），所有字段进入业务前
 * 必须过这一道：脏类型收敛为默认值，字符串去首尾空白，未知键直接丢弃。
 */
export function normalizeAsrConfig(raw: unknown): UserAsrConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_ASR_CONFIG };
  }
  const value = raw as Record<string, unknown>;
  const text = (input: unknown): string => (typeof input === 'string' ? input.trim() : '');
  const provider = ASR_PROVIDERS.includes(value.provider as AsrProvider)
    ? (value.provider as AsrProvider)
    : DEFAULT_ASR_CONFIG.provider;
  return {
    provider,
    baseUrl: text(value.baseUrl),
    apiKey: text(value.apiKey),
    model: text(value.model),
  };
}

// ==================== 配置管理器 ====================

/**
 * ASR 配置管理器
 *
 * 持久化委托给配置持久化引擎（asrConfig 域），三层冗余 + 读回校验，
 * 读取按恢复阶梯自动降级并自愈。整个插件（输入框语音、语音助手）的
 * 语音转文字统一从这里读取配置。
 */
/** 加载结果：存储故障以结构化结果返回（与渠道/应用设置存储同构） */
export interface AsrLoadResult {
  ok: boolean;
  issues: string[];
}

export class AsrConfigManager {
  private static config: UserAsrConfig = { ...DEFAULT_ASR_CONFIG };
  private static loaded = false;

  /**
   * 从持久化引擎加载配置（应用启动或打开设置弹窗时调用）。
   * 存储故障时**显式重置为默认配置**——绝不停留在可能过期的内存态，
   * 否则调用方会拿旧配置去发请求，与实际存储状态不符。
   */
  static async load(): Promise<UserAsrConfig> {
    try {
      const state = await getEngine().domain<UserAsrConfig>('asrConfig').load();
      // 逐字段归一：备份导入可能写入脏类型/多余字段，
      // 直接展开会把未知键带进配置对象（并可能污染后续落盘）
      this.config = normalizeAsrConfig(state.data);
      if (state.data && state.source !== 'primary') {
        console.warn(`[AsrConfig] 配置已从 ${state.source} 副本恢复:`, state.issues);
      } else if (state.issues.length) {
        console.warn('[AsrConfig] 配置读取告警:', state.issues);
      }
      this.loaded = true;
    } catch (error) {
      console.error('[AsrConfig] Failed to load config:', error);
      // 加载失败：内存态必须是确定的（默认配置），绝不停留在过期值
      this.config = { ...DEFAULT_ASR_CONFIG };
      this.loaded = true;
    }
    return { ...this.config };
  }

  /**
   * 加载并返回结构化结果（供需要区分「成功 / 存储故障」的调用方使用）。
   * 存储故障不抛错：返回 ok=false + issues，配置已重置为默认。
   */
  static async loadWithResult(): Promise<AsrLoadResult> {
    try {
      await this.load();
      return { ok: true, issues: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, issues: [message] };
    }
  }

  /**
   * 保存配置（写入未通过读回校验时抛错，绝不静默丢数据）。
   *
   * 顺序纪律：**先落盘，成功后再更新内存态**——反序会让写盘失败时
   * 内存里留下一份从未持久化的配置，转写请求会带着它去发 HTTP。
   */
  static async save(config: Partial<UserAsrConfig>): Promise<void> {
    const merged = normalizeAsrConfig({ ...this.config, ...config });
    try {
      await getEngine().domain<UserAsrConfig>('asrConfig').save(merged);
    } catch (error) {
      console.error('[AsrConfig] Failed to save config:', error);
      throw error;
    }
    // 落盘成功后才更新内存态：失败时内存与存储保持一致
    this.config = merged;
  }

  /** 获取当前配置（内存副本） */
  static getConfig(): UserAsrConfig {
    return { ...this.config };
  }

  /** 检查是否已完成配置（baseUrl + apiKey + model 齐备即可用） */
  static isConfigured(): boolean {
    return !!(
      this.config.baseUrl &&
      this.config.baseUrl.trim() !== '' &&
      this.config.apiKey &&
      this.config.apiKey.trim() !== '' &&
      this.config.model &&
      this.config.model.trim() !== ''
    );
  }

  /** 重置为默认配置（同时清掉主副本、镜像与快照） */
  static async reset(): Promise<void> {
    this.config = { ...DEFAULT_ASR_CONFIG };
    await getEngine().domain<UserAsrConfig>('asrConfig').clear();
  }

  /** 验证配置是否完整有效 */
  static validate(config: Partial<UserAsrConfig>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!config.provider) {
      errors.push(t('sidepanel.asr.validateProviderRequired'));
    }

    if (!config.baseUrl || config.baseUrl.trim() === '') {
      errors.push(t('sidepanel.asr.validateUrlRequired'));
    } else {
      try {
        new URL(config.baseUrl);
      } catch {
        errors.push(t('sidepanel.asr.invalidUrl'));
      }
    }

    if (!config.model || config.model.trim() === '') {
      errors.push(t('sidepanel.asr.validateModelRequired'));
    }

    if (!config.apiKey || config.apiKey.trim() === '') {
      errors.push(t('sidepanel.asr.validateApiKeyRequired'));
    }

    return { valid: errors.length === 0, errors };
  }

  /** 可配置供应商列表（仅 supported 项，用于选择卡片） */
  static getProviderList(): AsrProviderMeta[] {
    return SUPPORTED_ASR_PROVIDERS.filter(meta => meta.supported);
  }

  /** 是否已从存储加载 */
  static isLoaded(): boolean {
    return this.loaded;
  }
}

/** 导出便捷实例 */
export const asrConfig = AsrConfigManager;
