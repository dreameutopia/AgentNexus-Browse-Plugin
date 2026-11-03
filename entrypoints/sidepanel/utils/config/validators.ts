/**
 * 各配置域的结构校验器
 *
 * 原则：**宽容进、严格出**
 * - 只拦「明显不是这份数据」的东西（字符串/数组/彻底不是对象），
 * - 字段级语义归一（数值钳制、id 去重、activeModelRef 三态化等）由各自的
 *   管理器（channel-validation 的 normalize* 等）负责，不在这里重复实现。
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value));
}

/** 渠道配置域（agent_nexus_channels）—— 只判包裹层与数组形状，逐条语义由渠道层归一 */
export function isChannelStateLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.channels === undefined || value.channels === null) return true;
  return Array.isArray(value.channels);
}

/** 应用设置域（agent_nexus_app_settings）—— 字段全部可选（缺字段由归一化补默认） */
export function isAppSettingsLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const activeRef = value.activeModelRef;
  const activeRefOk =
    activeRef === undefined ||
    activeRef === null ||
    (isRecord(activeRef) && isOptionalString(activeRef.channelId) && isOptionalString(activeRef.modelId));
  return (
    isOptionalNumber(value.interactTimeoutMinutes) &&
    isOptionalNumber(value.textMaxIterations) &&
    isOptionalNumber(value.visionMaxIterations) &&
    isOptionalNumber(value.maxConsecutiveFailedToolRounds) &&
    isOptionalNumber(value.retryCount) &&
    isOptionalNumber(value.retryInterval) &&
    isOptionalNumber(value.temperature) &&
    isOptionalNumber(value.defaultContextThreshold) &&
    activeRefOk
  );
}

/** 语音识别（ASR）配置（agent_nexus_asr_config）—— 老版本可能缺字段，全部按可选校验 */
export function isUserAsrConfigLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isOptionalString(value.provider) &&
    isOptionalString(value.baseUrl) &&
    isOptionalString(value.apiKey) &&
    isOptionalString(value.model)
  );
}
