import { SKILL_TOOL_ID } from '@/utils/skills/skill-tool-contract';
import { FILE_UTIL_TOOL_ID } from '@/tools/file-util/file-util-prompt';

/** Capability ceiling for the built-in guide, including skills and extra tools.
 * Deliberately explicit: registering a new tool must not silently grant it here.
 * note_tool / plan_tool / file_util 与 interact 同属 CORE_SESSION_TOOL_IDS 全局工具：
 * 写笔记、建计划与读写用户上传文件都不触碰页面（观察者边界约束的是对页面的
 * 代操作，不是会话内状态与用户数据文件的读取），故对观察型智能体同样放行。
 *
 * python_run：计算类工具（工作区脚本 + Pyodide 沙箱），不触碰页面 DOM；
 * 其脚本对工作区的读写属于用户数据面而非页面代操作。它仅在用户于管理中心
 * 「Python 环境」页面显式给本智能体注入、且环境就绪时才会出现在工具面
 * （见 runtime-builder 的注入逻辑），因此不扩大观察型智能体的默认能力。
 *
 * js_run 不在白名单：其仅剩的 run/crawl 都在页面内执行脚本，属于观察者
 * 边界内的代操作能力；原先允许的 create/read/edit/delete/list 已统一收敛
 * 到 file_util，观察型智能体仍可通过 file_util 读写工作区文件。
 *
 * vision_gui：只读观察已并入其 action 面（原 vision_read* 工具随之删除），
 * 因此列入白名单——但观察者边界下沉到 action 级（VISION_ASSISTANT_GUI_ACTIONS），
 * 由会话引擎在执行前拒绝手势类 action（见 conversation-engine 执行闸门）。 */
export const VISION_ASSISTANT_TOOLS = [
  'screenshot', 'vision_gui', 'browser_wait', 'python_run',
  'read_website', 'interact', 'plan_tool', 'note_tool', FILE_UTIL_TOOL_ID, SKILL_TOOL_ID,
] as const;

/**
 * 视觉助手开放的 vision_gui action（观察者边界的 action 级硬闸门，fail-closed）：
 *   - read       原 vision_read（有界 DOM 文本/控件状态，不消耗源图）
 *   - read_scroll 原 vision_read_scroll（阅读式滚动，消耗源图）
 *   - zoom       原 vision_read_zoom（原图裁剪放大阅读）
 * 其余 9 个 action（手势 / mark / inspect / check）一律不在能力内——
 * 没有 mark 就无法 inspect，check 属断言型取证也随观察者边界一并排除，
 * 与合并前的工具面保持完全等价，不因合并扩大观察者的页面影响面。
 */
export const VISION_ASSISTANT_GUI_ACTIONS: ReadonlySet<string> = new Set([
  'read', 'read_scroll', 'zoom',
]);

const allowed = new Set<string>(VISION_ASSISTANT_TOOLS);
export function isVisionAssistantTool(name: string): boolean { return allowed.has(name); }
export function filterVisionAssistantTools(ids: readonly string[]): string[] {
  return [...new Set(ids.filter(isVisionAssistantTool))];
}
