/**
 * 端点活性问题的展示层映射（结构化事实 → 可读文案）
 *
 * 分层纪律：领域层（utils/channels/endpoint-liveness）只产出「哪一项不合格」的
 * 结构化事实，本模块负责把它翻译成当前语言的文案。
 *
 * 放在 UI 层而非领域层的原因：
 *   - 文案属于表现层，领域层必须与语言无关；
 *   - 本模块依赖 vue-i18n（响应式），在渲染中调用会跟踪 locale ref，
 *     语言切换时提示文案自动跟随，无需重新加载配置。
 */

import { t } from '@/utils/i18n';
import type { LivenessIssue } from '../channels';

/** 活性问题代码 → i18n 消息键（穷尽映射；新增 code 必须在此登记） */
const LIVENESS_MESSAGE_KEYS = {
  'no-channels': 'sidepanel.apiConfig.livenessNoChannels',
  'channel-disabled': 'sidepanel.apiConfig.livenessChannelDisabled',
  'driver-unknown': 'sidepanel.apiConfig.livenessDriverUnknown',
  'url-empty': 'sidepanel.apiConfig.livenessUrlEmpty',
  'url-invalid': 'sidepanel.apiConfig.livenessUrlInvalid',
  'key-missing': 'sidepanel.apiConfig.livenessKeyMissing',
  'model-disabled': 'sidepanel.apiConfig.livenessModelDisabled',
  'model-name-empty': 'sidepanel.apiConfig.livenessModelNameEmpty',
} as const satisfies Record<LivenessIssue['code'], string>;

/** 把一条活性问题渲染为当前语言的可读文案 */
export function livenessIssueText(issue: LivenessIssue | null): string {
  if (!issue) return '';
  const key = LIVENESS_MESSAGE_KEYS[issue.code];
  return t(key, { channel: issue.channelLabel, model: issue.modelName });
}
