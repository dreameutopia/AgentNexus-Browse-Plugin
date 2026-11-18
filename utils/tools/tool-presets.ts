/**
 * 工具预设配置
 *
 * 按场景定义各 Agent 可使用的工具 ID 列表。
 * 每个预设可单独引用，也可通过 scenario 名称获取组合结果。
 * 约定：此处只保留真实调用方引用的场景（预置智能体 + 默认对话），
 * 新增场景时同步维护调用方，避免出现无人引用的死预设。
 * 管理中心（hub）智能体编辑页的工具组是独立的 UI 分组（见 AgentManager 的
 * toolGroups），不再登记为场景——此处的场景只服务运行时装配。
 */

import { CORE_INTERACT_TOOL_IDS } from '@/tools/interact/interact-prompt';
import { SKILL_TOOL_ID } from '@/utils/skills/skill-tool-contract';
import { JS_RUN_TOOL_ID, isHiddenAgentScriptTool } from '@/tools/javascript/js-contract';
import { PLAN_TOOL_ID } from '@/tools/plan/plan-prompt';
import { NOTE_TOOL_ID } from '@/tools/note/note-prompt';
import { FILE_UTIL_TOOL_ID } from '@/tools/file-util/file-util-prompt';
import { VISION_GUI_TOOL_ID } from '@/tools/vision/gui-contract';

/** 场景类型 */
export type ToolScenario =
  | 'chat'
  | 'visionAssist'
  | 'visionAgent'
  | 'excalidraw'
  | 'deepSearch'
  | 'automation'
  | 'dataHarvest'
  | 'all';

// ──── 原子工具集合 ────

/**
 * 核心页面读取工具（无条件注入，所有智能体/场景必得）。
 * 当前标签页正文读取是浏览器 Agent 的基础能力——用户指令指向当前页面时
 * 模型必须能直接读取（runtime-builder 与 CORE_INTERACT_TOOL_IDS 一并置入
 * 工具集，用户在编辑页不可裁剪）。编辑页各工具组不再包含它。
 *
 * 统一规范：正文读取 = read_website（落盘 content/*.md + 单页 3000 字符，
 * 后续页用 file_util(action="read", path, index) 续读；产物可下载/可被其它
 * 工具按路径消费）。历史文本通道保留注册但不再注入，全仓不允许再引用它
 * 作为默认通道。
 */
export const CORE_PAGE_TOOL_IDS = ['read_website'] as const;

/**
 * 会话「无条件注入」核心工具全集——与 runtime-builder 装配时置首的清单严格同源。
 *
 * 用途：技能可用性判定需要知道会话**真实**的工具面。智能体预设工具只是一部分，
 * 核心工具（交互征询 / 页面正文 / 任务计划 / 工作笔记）对任何智能体都恒定可用；
 * 漏掉它们会让「allowed-tools 含核心工具」的技能在所有智能体下都匹配失败。
 *
 * note_tool 与 plan_tool 同级核心：工具与使用准则（NOTE_SYSTEM_PROMPT_SECTION）
 * 均无条件注入所有会话，任何智能体/场景不可裁剪（vision 策略放行见
 * vision-assistant-policy）。因此下方各场景清单与 hub 工具组一律**不再登记**
 * note_tool——单一事实源在此处，场景清单重复登记会造成两处口径漂移。
 * file_util（工作区文件读写）同属核心层：用户上传的文件以 <upload_file>
 * 清单出现在任意会话，读取入口必须恒定在场（使用准则见 file-util-prompt）。
 *
 * 维护约定：新增无条件注入的工具时，必须同时改这里与 runtime-builder 的
 * toolIdSet 初始化（两处口径不一致 = 技能匹配漏判）。
 */
export const CORE_SESSION_TOOL_IDS: readonly string[] = [
  ...CORE_INTERACT_TOOL_IDS,
  ...CORE_PAGE_TOOL_IDS,
  PLAN_TOOL_ID,
  NOTE_TOOL_ID,
  FILE_UTIL_TOOL_ID,
  JS_RUN_TOOL_ID,
  SKILL_TOOL_ID,
];

/**
 * 插件智能体默认可用的核心工具子集。
 *
 * 只包含无页面副作用、无任意脚本能力的会话状态工具与工作区文件工具；
 * 页面型核心工具（read_website / interact / js_run 等）必须在
 * manifest.capabilities.hostTools 中显式声明后才进入插件智能体工具面。
 * 这样 manifest 的 network / hostTools 才是真实边界，而不是“声明了但核心工具仍可绕过”。
 *
 * file_util 在此集合内：插件智能体同样会收到用户上传的文件（<upload_file>
 * 清单），若不提供读取入口，它将完全无法查看用户给它的材料。
 */
export const PLUGIN_SAFE_CORE_TOOL_IDS: readonly string[] = [
  PLAN_TOOL_ID,
  NOTE_TOOL_ID,
  FILE_UTIL_TOOL_ID,
  SKILL_TOOL_ID,
];

/** 基础浏览器操作（同时作为未知场景的防御性回退；不含无条件注入的核心工具） */
const BASIC_BROWSER_TOOLS = [
  'browser_observe',
  'browser_interact',
  'browser_navigation',
  'browser_get_page_info',
  'browser_tabs',
  // 通用网页搜索（engine 枚举：bing / baidu）：导航 + 解析一步完成
  'web_search',
] as const;

/**
 * 网络观察（CDP Network 域被动捕获）。
 *
 * **两个 action agent（文本通用助手 / 视觉通用助手）不携带此工具**：它们的
 * 职责是操作页面，网络观察对「点哪里、填什么」是噪声；且该工具占用
 * exclusiveText 互斥队列（与视觉 GUI 共用调试会话），会拖慢每一步交互。
 * 因此它只出现在数据采集这些「以观察数据为目的」的场景里，
 * 以及 hub 自定义智能体的资源工具组中。
 */
const NETWORK_CAPTURE_TOOL = 'browser_network_capture';

/** 自动化交互（read_website 由核心层无条件注入，此处不重复登记） */
const AUTOMATION_TOOLS = [
  'browser_observe',
  'browser_interact',
  'browser_download_click',
  'browser_dom_explore',
  'browser_tabs',
  'browser_navigation',
  'browser_get_page_info',
  // 通用网页搜索（engine 枚举：bing / baidu，自带导航）
  // ——刻意不带 platform_search：通用助手的检索面是「通用网页」，
  //   站点内检索是特定场景（Deep Search / 数据采集）的专用能力
  'web_search',
  'browser_wait',
  // 懒加载/无限滚动页面：getter 采样前先滚动触发渲染，再重新采集
] as const;

/**
 * 视觉通用助手基座：自动截图 + 统一 GUI 手势 + DOM 感知。
 * 仅供 visionAgent 场景使用。
 */
const VISION_AGENT_TOOLS = [
  VISION_GUI_TOOL_ID,
  // 视觉操作保留完整 DOM 感知/交互能力，生成的混合定位技能才能被实际执行。
  // 标签页/窗口管理（含窗口树枚举）随 browser_tabs 基座在场，不再单独登记
  ...AUTOMATION_TOOLS,
  'screenshot',
] as const;

/**
 * 数据批量采集（文本通用助手全套 + 数据治理通道）：
 * 脚本抓取（js_run run/crawl 结果自动落 results/ 结果文件）→ 治理（data_ref_tool
 * merge/dedupe/project，产物同为结果文件）→ xlsx dataFiles 直接导出，
 * 大批量数据全程不经过模型上下文；
 * DOM 结构明确时可用 browser_extract_data，已知 JSON 接口用 browser_network_request 直连。
 * 无限滚动分页靠 browser_interact(action="scroll")触发加载后重采。
 */
const DATA_HARVEST_TOOLS = [
  ...AUTOMATION_TOOLS,
  NETWORK_CAPTURE_TOOL,
  'browser_extract_data',
  'browser_network_request',
  'data_ref_tool',
  'xlsx_tool',
] as const;

// ──── 场景预设映射 ────
// （导出供 tests/tools 契约测试枚举全部场景——新增场景若漏登记注册名，
//   测试会立即失败，防止预设与注册表漂移）
export const SCENARIO_PRESETS: Record<Exclude<ToolScenario, 'all'>, string[]> = {
  /** 默认对话（未选择智能体）：正文读取已由核心层无条件提供（结构化 Markdown），
   *  这里只补页面加载诊断 */
  chat: ['browser_get_page_info'],

  /** 视觉助手：观察、阅读滚动、原图放大及等待重拍；运行时另施加能力上限
   *  （vision_gui 经 VISION_ASSISTANT_GUI_ACTIONS 收敛为只读 read/read_scroll/zoom） */
  visionAssist: ['screenshot', VISION_GUI_TOOL_ID, 'browser_wait'],

  /** 视觉通用助手：完整截图相对坐标操作；按需打标用于检查 */
  visionAgent: [...VISION_AGENT_TOOLS],

  /** 思维导图：Excalidraw 绘图 */
  excalidraw: ['excalidraw_tool'],

  /** Deep Search：多站点深度调研（通用检索 web_search 恒定在场，站点检索
   *  platform_search 由发送装配按已开启站点动态追加，见 deep-search-sites）。
   *  页面深访工具组（observe / interact / page_exec / dom_explore）：
   *  应对 SPA 渲染、登录墙外可见内容、需滚动/翻页的结果页，以及结构化提取
   *  （相似元素 + JS 脚本）——与数据采集助手同源能力，
   *  预算与使用纪律由 deep-search 预设提示词约束。
   *  note_tool 由核心层无条件注入（调研留痕是 Deep Search 的核心工作方式），
   *  此处不重复登记 */
  deepSearch: [
    'browser_navigation',
    'browser_get_page_info',
    'browser_observe',
    'browser_interact',
    'browser_dom_explore',
  ],

  /** 文本通用助手：通用网页自动化 */
  automation: [...AUTOMATION_TOOLS],

  /** 数据采集助手：批量数据采集与导出（脚本抓取 → results/ 结果文件 → xlsx 直出） */
  dataHarvest: [...DATA_HARVEST_TOOLS],
};

/**
 * 根据场景名称获取对应的工具 ID 列表
 * @param scenario 使用场景（须显式传入）
 * @param getAvailableToolIds 获取全部可用工具 ID 的回调（仅 'all' 场景使用）
 */
export function getPresetToolIds(
  scenario: ToolScenario,
  getAvailableToolIds?: () => string[],
): string[] {
  if (scenario === 'all') {
    return (getAvailableToolIds?.() ?? []).filter(id => !isHiddenAgentScriptTool(id));
  }
  // 防御：JS 调用方传入未注册的场景键时回退基础浏览器工具，而非抛错中断装配
  return SCENARIO_PRESETS[scenario] ?? [...BASIC_BROWSER_TOOLS];
}
