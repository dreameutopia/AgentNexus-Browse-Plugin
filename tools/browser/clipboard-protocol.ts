/**
 * 扩展侧剪贴板通道协议（零依赖唯一事实源）。
 *
 * 为什么需要它（本次任务复盘得出的根因）：
 *   在**页面上下文**调用 `navigator.clipboard.writeText()` 会挂起——Chrome 弹出
 *   浏览器级权限气泡（"查看复制到剪贴板的文本和图像"）。该气泡在浏览器 UI 层，
 *   不在页面 DOM，任何 DOM 观察工具都看不到，模型只会看到脚本执行超时。
 *   实测（飞书表格写入任务）：同样的调用连续两次 30s 超时，而页面上下文的
 *   `execCommand('copy')` 一次成功——差别在于后者在有 transient activation 时
 *   不触发异步权限路径。
 *
 * 通道设计：
 *   - 写入走**扩展侧** offscreen document（manifest `clipboardWrite` 权限使扩展页
 *     写入无需用户手势、也不触发页面 origin 的权限气泡）；
 *   - MV3 service worker 无 DOM，且 Chrome 157 之前不能用 `navigator.clipboard`
 *     → 必须经 offscreen 文档中转；
 *   - offscreen 文档无焦点，`navigator.clipboard.writeText` 在其中不可靠 →
 *     固定走「隐藏 textarea + select() + document.execCommand('copy')」；
 *   - Chrome 每 profile 只允许一个 offscreen 文档 → 复用既有宿主
 *     （`utils/offscreen-host.ts`），本协议只定义消息形状，不新建文档。
 *
 * 读��同样受限：offscreen 文档无焦点时 `navigator.clipboard.readText()` 不可靠，
 * 读取由扩展页面上下文（sidepanel，持有焦点）承担，见 `clipboard-read` 的执行方。
 */

/** background（service worker）→ offscreen document 的剪贴板命令。 */
export const CLIPBOARD_MSG = {
  /** 写入文本到系统剪贴板 */
  WRITE: 'AGENTNEXUS_CLIPBOARD_WRITE',
  /** 读取系统剪贴板文本 */
  READ: 'AGENTNEXUS_CLIPBOARD_READ',
} as const;

/**
 * 扩展页面（sidepanel）侧的剪贴板读取请求。
 *
 * 与离屏通道分开的原因：离屏文档无焦点，`navigator.clipboard.readText()` 在其中
 * 不可靠；sidepanel 是运行在扩展进程里的真实文档，持有用户焦点，是唯一可靠的
 * 读取执行方。请求由工具层发起、由 sidepanel 应答。
 */
export const CLIPBOARD_PAGE_MSG = {
  /** 请求扩展页面读取系统剪贴板文本 */
  READ: 'AGENTNEXUS_CLIPBOARD_PAGE_READ',
} as const;

/** 写入请求载荷。 */
export interface ClipboardWriteRequest {
  type: typeof CLIPBOARD_MSG.WRITE;
  /** 待写入的纯文本 */
  text: string;
}

/** 读取请求载荷。 */
export interface ClipboardReadRequest {
  type: typeof CLIPBOARD_MSG.READ;
}

/** offscreen document 的统一应答形状。 */
export interface ClipboardResponse {
  ok: boolean;
  /** 失败时的可定位原因（成功时省略） */
  error?: string;
  /** 写入是否成功（execCommand('copy') 的返回值） */
  copied?: boolean;
  /** 读取到的文本 */
  text?: string;
}

/** 单次剪贴板读写的内容上限（字符）。
 *
 * 系统剪贴板对超大文本的承载能力与各平台实现相关；超限时明确拒绝而不是让
 * execCommand 静默截断（静默截断会让模型以为整份数据已写入）。
 * 与工作区单文件读取上限（16MB）相比保守得多：剪贴板用途以表格/短文本为主，
 * 大数据应走文件交付（outputs/*.csv）而非剪贴板。 */
export const CLIPBOARD_MAX_CHARS = 2_000_000;

/** 判断一条消息是否是本协议的请求。 */
export function isClipboardRequest(
  message: unknown,
): message is ClipboardWriteRequest | ClipboardReadRequest {
  if (!message || typeof message !== 'object') return false;
  const type = (message as { type?: unknown }).type;
  return type === CLIPBOARD_MSG.WRITE || type === CLIPBOARD_MSG.READ;
}
