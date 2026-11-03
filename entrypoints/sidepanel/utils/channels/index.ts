/**
 * 渠道领域模块出口（最小公共面）
 *
 * 分层：
 *   channel-types      领域类型 + 边界常量 + 归一化公共件（零依赖）
 *   channel-validation 语义校验 + 存储归一化（依赖 types + 驱动注册表）
 *   channel-store      渠道配置持久化（配置引擎 channels 域）+ 内存缓存 + 变更通知
 *   app-settings       全局应用设置持久化（appSettings 域）+ 默认模型引用
 *   model-registry     引用解析（回落链）+ 可用清单 + 端点快照装配（组合 store 与 settings）
 *
 * 消费约定：
 *   - UI / 装配层一律经 modelRegistry 读取「可用模型」与端点，不直连 store；
 *   - 持久化写入一律走 store 的 save（内部保证归一化 + 校验 + 引擎读回校验）。
 * 此 barrel 只导出确有跨模块消费者的能力；模块内部件请直接相对导入源文件。
 */

export {
  CONTEXT_THRESHOLD_DEFAULT,
  CONTEXT_THRESHOLD_MAX,
  CONTEXT_THRESHOLD_MIN,
  createEmptyChannel,
  createEmptyModel,
  DEFAULT_APP_SETTINGS,
  FAILED_TOOL_ROUNDS_DEFAULT,
  FAILED_TOOL_ROUNDS_MAX,
  FAILED_TOOL_ROUNDS_MIN,
  generateId,
  INTERACT_TIMEOUT_DEFAULT_MINUTES,
  INTERACT_TIMEOUT_MAX_MINUTES,
  INTERACT_TIMEOUT_MIN_MINUTES,
  ITERATIONS_MAX,
  ITERATIONS_MIN,
  modelRefKey,
  normalizeModelRef,
  TEXT_MAX_ITERATIONS_DEFAULT,
  VISION_MAX_ITERATIONS_DEFAULT,
} from './channel-types';
export type {
  AppSettings,
  ChannelConfig,
  ChannelState,
  ModelConfig,
  ModelRef,
} from './channel-types';

export {
  normalizeAppSettings,
  normalizeChannelState,
  validateAppSettings,
  validateChannel,
  validateChannelState,
  validateModel,
} from './channel-validation';

export { channelStore } from './channel-store';

export { appSettingsStore } from './app-settings';

export { modelRegistry } from './model-registry';
export type {
  ModelOption,
  ModelResolveFailure,
  ModelResolution,
  ResolvedModelEndpoint,
} from './model-registry';