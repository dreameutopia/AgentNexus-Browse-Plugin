/**
 * Mermaid 离屏渲染消息协议
 *
 * mermaid_renderer 工具（background / sidepanel 均可发起）与
 * 共享离屏宿主的 Mermaid 处理器之间的通信契约。
 * 双侧共用本文件，保证消息结构与错误码不漂移。
 *
 * 为什么需要离屏页：mermaid 渲染依赖 DOM（d3/dagre 测量）与 Canvas（PNG 转换），
 * background service worker 两者皆无；向网页注入 CDN 脚本的旧方案因
 * isolated world 与 main world 隔离（window.mermaid 永远不可见）从未真正可用，
 * 且存在页面 CSP 拦截与远程代码注入风险。
 */

/** 消息类型（chrome.runtime.sendMessage 的 type 字段） */
export enum MermaidOffscreenMsgType {
  RENDER = 'an_mermaid_offscreen_render',
}

/** 单次渲染的整体超时（毫秒）：覆盖库加载 + 渲染 + PNG 转换 */
export const MERMAID_RENDER_TIMEOUT_MS = 45_000;

/** 源码长度上限（字符）：防御性拒绝异常超长输入（LLM 失控输出） */
export const MERMAID_MAX_CODE_LENGTH = 100_000;

/**
 * PNG 画布硬限制（Chrome：单边 ≤ 16384px，总面积约 268MP）。
 * 超限的图表会被拒绝并返回 SIZE_LIMIT，而非产出损坏/空白的图片。
 */
export const MERMAID_MAX_CANVAS_EDGE = 16_000;
export const MERMAID_MAX_CANVAS_AREA = 16_000 * 16_000;

/** 导出倍率（2x 保证高清屏下的清晰度；超限图自动降档） */
export const MERMAID_EXPORT_SCALE = 2;

/** 离屏页失败错误码（工具侧原样透传给调用方，便于定位阶段） */
export type MermaidOffscreenErrorCode =
  /** mermaid 语法解析失败（detail 含行号级原因） */
  | 'PARSE_ERROR'
  /** 渲染产物为空 */
  | 'EMPTY_SVG'
  /** 图表尺寸超出画布硬限制 */
  | 'SIZE_LIMIT'
  /** SVG → PNG 转换失败（图片解码 / canvas） */
  | 'CONVERT_ERROR'
  /** 未预期异常 */
  | 'INTERNAL_ERROR';

/** 渲染请求（background → offscreen） */
export interface MermaidRenderRequest {
  type: MermaidOffscreenMsgType.RENDER;
  code: string;
}

/** 渲染响应（offscreen → background） */
export type MermaidRenderResponse =
  | {
      ok: true;
      /** PNG data URL（data:image/png;base64,...） */
      dataUrl: string;
      /** 画布像素宽（已含导出倍率） */
      width: number;
      /** 画布像素高（已含导出倍率） */
      height: number;
      /** 端到端耗时（毫秒） */
      durationMs: number;
    }
  | {
      ok: false;
      code: MermaidOffscreenErrorCode;
      /** 面向调用方的可读失败原因 */
      message: string;
      /** 技术细节（解析错误原文等，已截断） */
      detail?: string;
    };
