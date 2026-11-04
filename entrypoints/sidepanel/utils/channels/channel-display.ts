/**
 * 渠道展示身份（单一事实源）
 *
 * 「这个渠道在界面上叫什么」只有一个定义：用户自定义名优先，
 * 未命名时回落协议标签（OpenAI / Ollama / …），协议未注册时原样展示协议 id。
 *
 * 该口径同时用于：端点活性诊断文案、设置界面校验错误前缀、
 * 删除渠道的二次确认文案——三处若各写一份，命名规则一旦调整就会漂移
 * （诊断说「渠道 A」而确认弹窗说「OpenAI」，用户会以为是两个东西）。
 */

import { driverRegistry } from '../stream/driver-registry';
import type { ChannelConfig } from './channel-types';

/** 渠道展示名（无名渠道回落协议标签，与诊断/错误前缀同一口径） */
export function channelLabelOf(channel: ChannelConfig): string {
  return channel.name.trim() || driverRegistry.tryGet(channel.protocol)?.meta.label || channel.protocol;
}
