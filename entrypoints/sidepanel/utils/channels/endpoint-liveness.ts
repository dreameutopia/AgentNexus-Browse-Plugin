/**
 * 端点活性判定层（单一事实源）
 *
 * 「一个渠道/模型到底能不能用」只允许有**一份**判定实现。本模块是纯函数，
 * 零 IO、零 Vue 依赖、被以下消费方共用，杜绝口径漂移：
 *   - model-registry   可用模型清单、解析有效性、configured 判定
 *   - 设置表单        连通性测试 / 拉取按钮的可用性与禁用原因
 *   - 输入区提示      「未配置」时给出具体是哪一项不合格
 *
 * 判定口径（渠道层 → 模型层，与解析链逐条对齐）：
 *   1. 渠道已启用；
 *   2. 协议驱动已注册（配置了不支持的协议 = 不可用，但保留数据供 UI 提示）；
 *   3. baseUrl 非空且能被 URL 解析；
 *   4. 驱动要求密钥时 apiKey 非空（本地协议免密钥）；
 *   5. 模型已启用；
 *   6. 模型名（wire name）非空。
 *
 * 分层纪律：本模块只产出**结构化事实**（code + 参与方标识），
 * 绝不产出面向用户的文案——文案由 UI 层按 code 查 i18n 目录得到。
 * 这样领域层保持与语言无关，切换语言不需要改动任何业务代码。
 */

import { driverRegistry } from '../stream/driver-registry';
import { channelLabelOf } from './channel-display';
import type { ChannelConfig, ModelConfig } from './channel-types';

// ==================== 类型 ====================

/** 活性问题代码（穷尽枚举；UI 据此查 i18n 文案） */
export type LivenessCode =
  /** 一个渠道都没有 */
  | 'no-channels'
  /** 渠道被禁用 */
  | 'channel-disabled'
  /** 渠道协议未注册（驱动缺失） */
  | 'driver-unknown'
  /** 未填 API 服务地址 */
  | 'url-empty'
  /** 服务地址不是合法 URL */
  | 'url-invalid'
  /** 缺少必需的 API 密钥 */
  | 'key-missing'
  /** 模型被禁用 */
  | 'model-disabled'
  /** 模型名为空 */
  | 'model-name-empty';

/** 一条具体的不合格原因（纯数据，不含文案） */
export interface LivenessIssue {
  /** 问题代码（UI 据此查 i18n 文案） */
  code: LivenessCode;
  /** 涉及的渠道展示名（无名渠道回落协议标签） */
  channelLabel: string;
  /** 涉及的模型名（渠道层问题为空串） */
  modelName: string;
}

/** 渠道级判定结果 */
export interface ChannelLiveness {
  /** 渠道本身是否可用（不含模型维度） */
  ok: boolean;
  /** 渠道级问题（可能多条，如 URL 与密钥都不合格） */
  issues: LivenessIssue[];
}

/** 模型级判定结果（在渠道可用的前提下评估单个模型） */
export interface ModelLiveness {
  /** 该模型是否可用 */
  ok: boolean;
  /** 不可用时的原因（可用时恒为空数组） */
  issues: LivenessIssue[];
}

// ==================== 实现 ====================

/** baseUrl 是否能被 URL 解析（trim 后空串视为「未填」，单独给 code） */
function isParsableUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * 渠道级活性判定。
 * 返回的 issues 为空数组即渠道可用；否则逐条给出结构化原因。
 */
export function checkChannelLiveness(channel: ChannelConfig): ChannelLiveness {
  const issues: LivenessIssue[] = [];
  const channelLabel = channelLabelOf(channel);

  const push = (code: LivenessCode): void => {
    issues.push({ code, channelLabel, modelName: '' });
  };

  if (!channel.enabled) {
    push('channel-disabled');
  }

  if (!driverRegistry.has(channel.protocol)) {
    push('driver-unknown');
  }

  const rawUrl = channel.baseUrl ?? '';
  if (!rawUrl.trim()) {
    push('url-empty');
  } else if (!isParsableUrl(rawUrl)) {
    push('url-invalid');
  }

  // 密钥要求由驱动策略声明（未知协议按需密钥保守侧处理）
  if (driverRegistry.requiresApiKey(channel.protocol) && !(channel.apiKey ?? '').trim()) {
    push('key-missing');
  }

  return { ok: issues.length === 0, issues };
}

/**
 * 模型级活性判定。**调用方须先确认渠道可用**（channel.ok），
 * 否则本函数不评估模型维度，直接返回 ok=false 并透传渠道问题。
 */
export function checkModelLiveness(
  channel: ChannelConfig,
  model: ModelConfig,
  channelLiveness: ChannelLiveness = checkChannelLiveness(channel),
): ModelLiveness {
  if (!channelLiveness.ok) {
    return { ok: false, issues: [...channelLiveness.issues] };
  }

  const issues: LivenessIssue[] = [];
  const channelLabel = channelLabelOf(channel);
  const modelName = (model.name ?? '').trim();

  if (!model.enabled) {
    issues.push({ code: 'model-disabled', channelLabel, modelName });
  }

  if (!modelName) {
    issues.push({ code: 'model-name-empty', channelLabel, modelName: '' });
  }

  return { ok: issues.length === 0, issues };
}

/** 取一组问题里第一条（用于「未配置」提示只给一个可行动的指引） */
export function firstIssue(issues: readonly LivenessIssue[]): LivenessIssue | null {
  return issues.length > 0 ? issues[0] : null;
}
