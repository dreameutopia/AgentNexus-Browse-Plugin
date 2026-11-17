/**
 * 元素捕获（网页元素选取）共享类型
 *
 * 分层：
 *   - 选择器引擎（selector-engine）在页面内生成 / 校验精准选择器；
 *   - 内容脚本捕获器（element-picker）负责高亮、确认、截图与上报；
 *   - 侧边栏只消费本文件的 CapturedElement（持久化形态）。
 *
 * 约束：本文件不得引入浏览器 / Vue 依赖，需可被内容脚本与侧边栏同时引用。
 */

/** 单条用户消息最多携带的捕获元素数量（防御性上限） */
export const CAPTURED_ELEMENT_LIMIT = 100;

/** 元素选择器生成策略 */
export type SelectorStrategy = 'id' | 'css-path' | 'xpath';

/** 选择器结果（含二次校验证据） */
export interface ElementSelectorResult {
  /** 主选择器（CSS；Shadow DOM 内为所在 root 内的相对选择器） */
  css: string;
  /** XPath 1.0（Document 内为绝对路径；Shadow DOM 内为 root 内相对路径） */
  xpath: string;
  /** 逐层 Shadow Host 的 CSS 选择器（从 Document 到最内层 root） */
  shadowHosts: string[];
  strategy: SelectorStrategy;
  /** 是否在同一定位根内唯一命中目标元素（二次校验结果） */
  verified: boolean;
  /** 主选择器的匹配数量（0 = 定位失败） */
  matchCount: number;
}

/**
 * 元素类型分类（决定 chip 内展示的图标）。
 * 与 ElementTypeIcon 的图标映射一一对应。
 */
export type CapturedElementKind =
  | 'text-input'
  | 'textarea'
  | 'password'
  | 'number'
  | 'email'
  | 'search'
  | 'tel'
  | 'url'
  | 'date'
  | 'time'
  | 'datetime'
  | 'color'
  | 'range'
  | 'file'
  | 'checkbox'
  | 'radio'
  | 'select'
  | 'button'
  | 'link'
  | 'image'
  | 'video'
  | 'audio'
  | 'table'
  | 'list'
  | 'form'
  | 'iframe'
  | 'canvas'
  | 'svg'
  | 'code'
  | 'heading'
  | 'paragraph'
  | 'container'
  | 'switch'
  | 'label'
  | 'other';

/** 页面侧采集到的元素描述（不含截图与 frameId） */
export interface CapturedElementDescriptor {
  tagName: string;
  kind: CapturedElementKind;
  /** 面向模型的一句话描述（类型 + 可读标签 + 关键属性） */
  description: string;
  /** 元素可见文本（截断；密码等敏感输入不采集） */
  text?: string;
  /** 关键属性快照（id / name / type / role / aria-label / placeholder / alt / href） */
  attributes: Record<string, string>;
  /** 元素在视口内的尺寸（宽高，CSS 像素；仅用于展示与审计） */
  width: number;
  height: number;
}

/** 内容脚本 → 侧边栏的单次捕获载荷 */
export interface CapturedElementPayload {
  selector: ElementSelectorResult;
  descriptor: CapturedElementDescriptor;
  /** 元素完整截图（data URL；失败为 null，不影响其余字段） */
  screenshotDataUrl: string | null;
  pageUrl: string;
  pageTitle: string;
}

/**
 * 持久化形态（随用户消息落库）。
 * id 由侧边栏生成；frameId 由侧边栏从消息 sender 补写。
 */
export interface CapturedElement {
  id: string;
  selector: string;
  xpath?: string;
  shadowHosts?: string[];
  frameId: number;
  kind: CapturedElementKind;
  tagName: string;
  description: string;
  /** 用户备注（可选，最大长度受元素备注上限约束） */
  note?: string;
  /** 截图引用（图片库内容哈希；图片本体在独立图片库） */
  screenshotRef?: string;
  pageUrl?: string;
  pageTitle?: string;
  capturedAt: number;
}

/** 元素备注长度上限（与 UI 输入框 maxlength 同源） */
export const CAPTURED_ELEMENT_NOTE_MAX_CHARS = 500;
