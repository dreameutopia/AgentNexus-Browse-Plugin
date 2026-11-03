/**
 * 协议驱动注册表（Protocol Driver Registry）
 *
 * 「驱动」= 一种对话协议的完整实现单元，四要素内聚于一处：
 *   1. id（ProviderType）——渠道配置引用协议的稳定标识；
 *   2. adapter —— 请求体/URL/请求头/SSE 解析的协议适配器（行为）；
 *   3. meta —— 设置界面展示所需的全部 UI 元数据（标签/图标/占位符/示例）；
 *   4. policy —— 驱动级策略声明（如是否必须携带 API Key）。
 *
 * 设计意图（解耦）：
 *   - 新增协议 = 实现一个 ProtocolAdapter + 在本文件注册一条驱动，
 *     设置 UI、连通性探测、渠道校验、模型列表拉取全部经由注册表自动获得
 *     对该协议的支持，无需改动任何消费方；
 *   - 消费方一律通过 driverRegistry 查询，绝不各自维护协议清单——
 *     清单只存在这一份，杜绝「UI 支持 5 种但探测只认 4 种」类漂移。
 *
 * 本模块零 Vue 依赖；适配器单例在模块加载时注册（无副作用，仅构造实例）。
 */

import type { MessageKey } from '@/utils/i18n/core';
import type { ProtocolAdapter, ProviderType } from './types';
import { OpenAIAdapter } from './adapters/openai-adapter';
import { OllamaAdapter } from './adapters/ollama-adapter';
import { GeminiAdapter } from './adapters/gemini-adapter';
import { ClaudeAdapter } from './adapters/claude-adapter';
import { ResponsesAdapter } from './adapters/responses-adapter';

// ==================== 类型 ====================

/** 驱动 UI 元数据（设置界面 / 模型选择器展示用） */
export interface DriverMeta {
  /** 展示名（如 "OpenAI"） */
  label: string;
  /** 协议标识（与 id 同值，供模板按值绑定） */
  value: ProviderType;
  /** 品牌图标路径 */
  icon: string;
  /** baseUrl 输入占位符（消息键，渲染时经 t() 解析以跟随语言切换） */
  urlPlaceholder: MessageKey;
  /** baseUrl 示例值 */
  urlExample: string;
  /** 模型名称占位符（消息键） */
  modelPlaceholder: MessageKey;
  /** 模型名称示例 */
  modelExample: string;
}

/** 驱动级策略声明 */
export interface DriverPolicy {
  /** 该协议是否要求非空 API Key（Ollama 等本地协议为 false） */
  requiresApiKey: boolean;
}

/** 协议驱动 = 适配器 + UI 元数据 + 策略 */
export interface ProtocolDriver {
  readonly id: ProviderType;
  readonly meta: DriverMeta;
  readonly policy: DriverPolicy;
  readonly adapter: ProtocolAdapter;
}

// ==================== 注册表 ====================

export class DriverRegistry {
  private readonly drivers = new Map<ProviderType, ProtocolDriver>();

  /**
   * 注册驱动。
   * @throws 重复 id（编程错误：同一协议注册两次会让后注册者静默覆盖前者）
   */
  register(driver: ProtocolDriver): void {
    if (this.drivers.has(driver.id)) {
      throw new Error(`[DriverRegistry] 协议驱动重复注册: ${driver.id}`);
    }
    if (driver.adapter.providerType !== driver.id) {
      throw new Error(
        `[DriverRegistry] 驱动 id (${driver.id}) 与适配器 providerType (${driver.adapter.providerType}) 不一致`,
      );
    }
    this.drivers.set(driver.id, driver);
  }

  /** 取驱动；不存在时抛出带可用清单的可读错误（上游配置了未注册协议时能一眼定位） */
  get(id: ProviderType): ProtocolDriver {
    const driver = this.drivers.get(id);
    if (!driver) {
      throw new Error(
        `[DriverRegistry] 未注册的协议驱动: ${String(id)}，可用驱动: ${this.ids().join(', ') || '(无)'}`,
      );
    }
    return driver;
  }

  /** 取驱动（找不到返回 null，用于「引用可能已失效」的防御性判定） */
  tryGet(id: ProviderType): ProtocolDriver | null {
    return this.drivers.get(id) ?? null;
  }

  has(id: ProviderType): boolean {
    return this.drivers.has(id);
  }

  /** 全部驱动（注册顺序即展示顺序） */
  list(): ProtocolDriver[] {
    return Array.from(this.drivers.values());
  }

  /** 全部协议 id */
  ids(): ProviderType[] {
    return Array.from(this.drivers.keys());
  }

  /** 驱动级策略查询；未知协议按「需要密钥」的保守侧处理 */
  requiresApiKey(id: ProviderType): boolean {
    return this.tryGet(id)?.policy.requiresApiKey ?? true;
  }
}

// ==================== 单例与内置驱动注册 ====================

export const driverRegistry = new DriverRegistry();

driverRegistry.register({
  id: 'openai',
  meta: {
    label: 'OpenAI',
    value: 'openai',
    icon: '/ai/chatgpt.png',
    urlPlaceholder: 'sidepanel.apiConfig.urlPlaceholderOpenai',
    urlExample: 'https://api.openai.com/v1',
    modelPlaceholder: 'sidepanel.apiConfig.modelPlaceholderOpenai',
    modelExample: 'gpt-4o',
  },
  policy: { requiresApiKey: true },
  adapter: new OpenAIAdapter(),
});

driverRegistry.register({
  id: 'ollama',
  meta: {
    label: 'Ollama',
    value: 'ollama',
    icon: '/ai/ollama.png',
    urlPlaceholder: 'sidepanel.apiConfig.urlPlaceholderOllama',
    urlExample: 'http://localhost:11434',
    modelPlaceholder: 'sidepanel.apiConfig.modelPlaceholderOllama',
    modelExample: 'llama3',
  },
  policy: { requiresApiKey: false },
  adapter: new OllamaAdapter(),
});

driverRegistry.register({
  id: 'gemini',
  meta: {
    label: 'Gemini',
    value: 'gemini',
    icon: '/ai/gemini.png',
    urlPlaceholder: 'sidepanel.apiConfig.urlPlaceholderGemini',
    urlExample: 'https://generativelanguage.googleapis.com',
    modelPlaceholder: 'sidepanel.apiConfig.modelPlaceholderGemini',
    modelExample: 'gemini-pro',
  },
  policy: { requiresApiKey: true },
  adapter: new GeminiAdapter(),
});

driverRegistry.register({
  id: 'claude',
  meta: {
    label: 'Claude',
    value: 'claude',
    icon: '/ai/claude.png',
    urlPlaceholder: 'sidepanel.apiConfig.urlPlaceholderClaude',
    urlExample: 'https://api.anthropic.com',
    modelPlaceholder: 'sidepanel.apiConfig.modelPlaceholderClaude',
    modelExample: 'claude-3-5-sonnet-20241022',
  },
  policy: { requiresApiKey: true },
  adapter: new ClaudeAdapter(),
});

driverRegistry.register({
  id: 'openai-responses',
  meta: {
    label: 'OpenAI Responses',
    value: 'openai-responses',
    icon: '/ai/chatgpt.png',
    urlPlaceholder: 'sidepanel.apiConfig.urlPlaceholderOpenaiResponses',
    urlExample: 'https://api.openai.com/v1',
    modelPlaceholder: 'sidepanel.apiConfig.modelPlaceholderOpenaiResponses',
    modelExample: 'gpt-4o',
  },
  policy: { requiresApiKey: true },
  adapter: new ResponsesAdapter(),
});