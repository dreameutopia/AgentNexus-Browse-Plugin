import type { ToolResult } from '@/common/tool-handler';
import { visionGuiAction, visionGuiRefresh } from '@/tools/vision/gui-contract';
export const VISION_TOOL_SETTLE_DELAY_MS = 3000;

export interface VisionToolImage {
  callIndex: number;
  image: string;
  description: string;
  kind: 'viewport' | 'region';
  /** 已归档的内容哈希引用（视口截图落库后回填；续拍复用，避免重复写库） */
  imageRef?: string;
  /** 已归档图片的 8 位短 id（回答中用 <agent-image id="..." /> 引用） */
  shortId?: string;
}
/** Keep image bytes in the multimodal channel, not JSON tool text. */
export function takeVisionToolImage(result: ToolResult, callIndex: number, sourceName?:string, args?:unknown): VisionToolImage | null {
  // Arbitrary page/tool JSON must not impersonate an actionable viewport image.
  // 视口图生产者名单：screenshot 是唯一完整视口截图工具（vision_read_wait 已下线）；
  // vision_gui(action="zoom") 的区域图经 guiZoom 单独放行。
  const producers=['screenshot'];
  const guiZoom=sourceName==='vision_gui' && visionGuiAction(args)==='zoom';
  if(sourceName!==undefined && !producers.includes(sourceName) && !guiZoom) return null;
  const data = result.data;
  if (result.success !== true || !data || typeof data.screenshot !== 'string' ||
      !data.screenshot.startsWith('data:image/png;base64,') || typeof data.text !== 'string') return null;
  const region=guiZoom || data.imageKind==='region';
  return { callIndex, image: data.screenshot, description: data.text, kind: region ? 'region' : 'viewport' };
}
export function withoutVisionImage(result: ToolResult): ToolResult {
  if (!result.data || typeof result.data.screenshot !== 'string') return result;
  const { screenshot: _image, ...data } = result.data;
  return { ...result, data };
}
/**
 * 视觉循环重拍判定（策略单一事实源：ToolMetadata.noVisionRecapture，见 registry.ts）。
 *
 * 判定顺序（每调用顺序扫描，后者可覆盖前者——批次末态即返回值）：
 *   1. 本调用产出了可复用视口图（screenshot 成功）→ 复用，不追加拍摄；
 *   2. screenshot 未产出视口图（失败/降级）→ 保守触发恢复性重拍；
 *   3. vision_gui 按动作判定（gui-contract）：手势、mark 与 read_scroll 消耗
 *      截图 → 重拍；inspect/zoom/check/read 保留源图 → 不重拍；
 *   4. 其余工具由 noRecapture 回调判定：true（纯读豁免）不改变批次状态，
 *      false / 未声明（含未知与插件工具）一律保守重拍。
 *   5. 「前台打开」例外：纯读豁免的前提是**不改变用户可见的页面**。
 *      browser_get_page_text 带 url 时会在前台新建并激活标签页打开目标页
 *      （等同 browser_navigation(action="open")；后台打开拿不到真实浏览上下文、
 *      容易触发人机验证），用户眼前的页面已经变了 —— 截图身份失效，必须重拍。
 *      参数无法解析时**按「可能带 url」处理**（保守重拍）：解析失败不等于
 *      没有 url，猜错会让模型拿着一张过期截图继续操作。
 *   6. 合并型多语义工具的纯读 action 例外（见 PURE_READ_ACTIONS）：
 *      browser_tabs / browser_navigation 各自混有纯读与改视图两类 action，
 *      工具级 noVisionRecapture 无法表达——按 action 精确豁免；参数解析
 *      失败或 action 不在纯读名单时回到第 4 条保守重拍。
 *
 * 返回 false 且批次无图片产出时，视觉循环不合成续拍消息——工具结果按文本
 * 执行循环原样回传，截图身份继续有效（纯读不消耗驱动层 snapshot）。
 */
type VisionCall = string | { function: { name: string; arguments?: string } };

/** 「前台打开」型纯读工具：带 url 参数时会切换用户可见页面，豁免重拍失效 */
const FOREGROUND_OPENING_TOOLS = new Set(['browser_get_page_text']);

/**
 * 合并型工具的纯读 action（与 registry 的 noVisionRecapture 并列的 action 级豁免）：
 *   - browser_tabs(list/windows)     纯 chrome.tabs/windows 枚举，不改活动标签与视口
 *   - browser_navigation(wait)       纯轮询 tab.status/readyState，不触碰页面
 * switch/close/create 与 open/refresh/back/forward 改变用户眼前的页面 → 不在名单，
 * 落回第 4 条保守重拍。参数解析失败（argsKnown=false）同样保守重拍。
 */
const PURE_READ_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  js_run: ['create', 'edit', 'delete', 'read', 'list'],
  browser_tabs: ['list', 'windows'],
  browser_navigation: ['wait'],
};

/** 该调用是否命中「合并型工具的纯读 action」豁免（args 解析失败一律 false = 保守） */
function isPureReadMergedAction(name: string, argsKnown: boolean, args: unknown): boolean {
  const pureActions = PURE_READ_ACTIONS[name];
  if (!pureActions) return false;
  if (!argsKnown || !args || typeof args !== 'object' || Array.isArray(args)) return false;
  const action = (args as { action?: unknown }).action;
  return typeof action === 'string' && pureActions.includes(action);
}

/** 调用参数里是否带非空 url（url 模式 = 前台打开目标页） */
function hasUrlArgument(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const url = (args as { url?: unknown }).url;
  return typeof url === 'string' && url.trim().length > 0;
}

export function needsVisionRefresh(calls: VisionCall[], images: VisionToolImage[], noRecapture: (name: string) => boolean | undefined): boolean {
  let refresh = false;
  calls.forEach((call, index) => {
    const name=typeof call==='string'?call:call.function.name;
    let args:unknown;
    // argsKnown：参数是否**确定**不含 url。字符串形式的调用没有参数（确定没有）；
    // 对象形式但 JSON 解析失败时不确定 → 保守按「可能带 url」处理。
    let argsKnown = true;
    if(typeof call!=='string') {
      try { args=JSON.parse(call.function.arguments??''); }
      catch { argsKnown = false; /* Recover conservatively. */ }
    }
    if (images.some(image => image.callIndex === index && image.kind === 'viewport')) refresh = false;
    else if (name === 'screenshot') refresh = true;
    else if (name === 'vision_gui') { if(visionGuiRefresh(args)==='after') refresh=true; }
    else if (FOREGROUND_OPENING_TOOLS.has(name) && (!argsKnown || hasUrlArgument(args))) refresh = true;
    else if (isPureReadMergedAction(name, argsKnown, args)) { /* 纯枚举/等待 action：不改变批次状态 */ }
    else if (!noRecapture(name)) refresh = true;
  });
  return refresh;
}
