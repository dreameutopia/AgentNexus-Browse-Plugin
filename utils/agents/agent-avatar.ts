/**
 * 智能体头像渲染辅助（纯逻辑 + URL 解析，无 DOM 依赖）
 *
 * 头像模型只有两种形态（见 utils/agents/agent-types.ts）：
 *   - image：图片地址（扩展内相对路径 / http(s) / data URL）
 *   - emoji：emoji 字符
 *
 * 本模块负责把存储层的原始地址解析为 <img src> 可直接使用的值：
 * 扩展内相对路径（/agent/xxx.png）必须转成 chrome-extension:// 绝对地址，
 * 否则在扩展页面（hub / sidepanel）里会被当作站点相对路径请求而 404。
 */

import { DEFAULT_AGENT_AVATAR, type AgentAvatar } from './agent-types';

/**
 * 头像相关的公共出口。
 * DEFAULT_AGENT_AVATAR 在此转出，UI 层只需从本模块导入，
 * 不必再去 agent-types 找默认头像常量（避免两处 import 路径漂移）。
 */
export { DEFAULT_AGENT_AVATAR };
export type { AgentAvatar };

/** 无背景色头像的默认尺寸（px） */
export const AGENT_AVATAR_DEFAULT_SIZE = 24;

/**
 * 图片地址 → 可渲染的 src。
 *
 * - data: / blob: / http(s): 直接透传
 * - 其余（扩展内相对路径）经 chrome.runtime.getURL 转绝对地址
 * - 非扩展环境（测试 / SSR）原样返回，调用方自行处理
 */
export function resolveAvatarImageSrc(src: string): string {
  const trimmed = typeof src === 'string' ? src.trim() : '';
  if (!trimmed) return '';
  if (/^(data:|blob:|https?:\/\/)/i.test(trimmed)) return trimmed;
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      return chrome.runtime.getURL(trimmed.replace(/^\/+/, ''));
    }
  } catch {
    /* 扩展 API 不可用时按原样返回 */
  }
  return trimmed;
}

/**
 * 取智能体的有效头像：缺省回退默认 emoji。
 * 预置、自定义、导入三类智能体都走这一入口，保证渲染分支只有一处。
 */
export function resolveAgentAvatar(avatar?: AgentAvatar | null): AgentAvatar {
  return avatar ?? DEFAULT_AGENT_AVATAR;
}

/**
 * 头像是否为图片形态（决定渲染 <img> 还是文本）。
 */
export function isImageAvatar(avatar?: AgentAvatar | null): boolean {
  return resolveAgentAvatar(avatar).type === 'image';
}
