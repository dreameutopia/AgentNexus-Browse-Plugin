/**
 * 元素捕获消息协议（侧边栏 ⇄ 内容脚本）
 *
 * 所有消息都带 `type` 字段与统一前缀，避免与宿主既有消息冲突。
 * 侧边栏 → 标签页：通过 chrome.tabs.sendMessage 广播到全部 frame；
 * 内容脚本 → 侧边栏：通过 chrome.runtime.sendMessage，侧边栏以 sender.frameId 补写 frameId。
 */

import type { CapturedElementDescriptor, ElementSelectorResult } from './types';

export const ELEMENT_CAPTURE_MESSAGE = {
  /** 侧边栏 → 所有 frame：进入捕获模式 */
  START: 'ANX_ELEMENT_CAPTURE_START',
  /** 侧边栏 → 所有 frame：退出捕获模式并清理遮罩 */
  STOP: 'ANX_ELEMENT_CAPTURE_STOP',
  /** 侧边栏 → 指定 frame：二次校验选择器是否仍能精准定位 */
  VERIFY: 'ANX_ELEMENT_CAPTURE_VERIFY',
  /** 侧边栏 → 指定 frame：校验并高亮闪烁定位到的元素（不改动捕获状态） */
  HIGHLIGHT: 'ANX_ELEMENT_CAPTURE_HIGHLIGHT',
  /** 内容脚本 → 侧边栏：捕获器已就绪 */
  READY: 'ANX_ELEMENT_CAPTURE_READY',
  /** 内容脚本 → 侧边栏：用户确认捕获一个元素 */
  RESULT: 'ANX_ELEMENT_CAPTURE_RESULT',
  /** 内容脚本 → 侧边栏：用户按 Esc / 页面卸载等原因退出 */
  CANCELLED: 'ANX_ELEMENT_CAPTURE_CANCELLED',
  /** 内容脚本 → 侧边栏：捕获器内部错误（仍可能继续捕获） */
  FAILED: 'ANX_ELEMENT_CAPTURE_FAILED',
} as const;

/** 单帧内捕获器状态 */
export type ElementCaptureFrameState = 'idle' | 'picking' | 'confirmed';

export type ElementCaptureCancelReason = 'user-cancel' | 'page-unload' | 'error';

export interface ElementCaptureReadyMessage {
  type: typeof ELEMENT_CAPTURE_MESSAGE.READY;
  isTopFrame: boolean;
  url: string;
}

export interface ElementCaptureResultMessage {
  type: typeof ELEMENT_CAPTURE_MESSAGE.RESULT;
  selector: ElementSelectorResult;
  descriptor: CapturedElementDescriptor;
  screenshotDataUrl: string | null;
  pageUrl: string;
  pageTitle: string;
}

export interface ElementCaptureCancelledMessage {
  type: typeof ELEMENT_CAPTURE_MESSAGE.CANCELLED;
  reason: ElementCaptureCancelReason;
  message?: string;
}

export interface ElementCaptureFailedMessage {
  type: typeof ELEMENT_CAPTURE_MESSAGE.FAILED;
  message: string;
}

export interface ElementCaptureVerifyRequest {
  type: typeof ELEMENT_CAPTURE_MESSAGE.VERIFY;
  css: string;
  shadowHosts?: string[];
}

export interface ElementCaptureVerifyResponse {
  ok: boolean;
  matchCount: number;
  message?: string;
}

/** 校验元素并高亮：命中唯一元素时在页面内框选 + 闪烁指定时长 */
export interface ElementCaptureHighlightRequest {
  type: typeof ELEMENT_CAPTURE_MESSAGE.HIGHLIGHT;
  css: string;
  shadowHosts?: string[];
  /** 高亮持续时长（毫秒，默认 3000） */
  durationMs?: number;
}

export type ElementCaptureHighlightResponse = ElementCaptureVerifyResponse;

export interface ElementCaptureStartCommand {
  type: typeof ELEMENT_CAPTURE_MESSAGE.START;
}

export interface ElementCaptureStopCommand {
  type: typeof ELEMENT_CAPTURE_MESSAGE.STOP;
}

/** 判断消息是否属于元素捕获协议（防御任意 page 消息注入） */
export function isElementCaptureMessage(value: unknown): value is { type: string } {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && type.startsWith('ANX_ELEMENT_CAPTURE_');
}
