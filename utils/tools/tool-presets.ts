/**
 * 工具预设配置
 *
 * 按场景定义各 Agent 可使用的工具 ID 列表。
 * 每个预设可单独引用，也可通过 scenario 名称获取组合结果。
 * 约定：此处只保留真实调用方引用的场景（预置智能体 + 默认对话），
 * 新增场景时同步维护调用方，避免出现无人引用的死预设。
 */

import { CORE_INTERACT_TOOL_IDS } from '@/tools/interact/interact-prompt';
import { PLAN_TOOL_ID } from '@/tools/plan/plan-prompt';
import { NOTE_TOOL_ID } from '@/tools/note/note-prompt';
import { READ_FILE_TOOL_ID } from '@/tools/upload-file/upload-file-prompt';
import { VISION_GUI_TOOL_ID } from '@/tools/vision/gui-contract';

/** 场景类型 */
export type ToolScenario =
  | 'chat'
  | 'visionAssist'
  | 'visionAgent'
  | 'excalidraw'
  | 'bilibili'
  | 'deepSearch'
  | 'automation'
  | 'dataHarvest'
  | 'siteLearnText'
  | 'siteLearnVision'
  | 'siteLearnVisionForText'
  | 'siteValidateText'
  | 'siteValidateVision'
  | 'resource'
  | 'files'
  | 'navigation'
  | 'data'
  // hub 自定义智能体新增工具组（仅在此处登记，供管理页勾选）
  | 'pageRead'
  | 'domInteract'
  | 'tabsWindows'
  | 'scripting'
  | 'bookmarkHistory'
  | 'webSearch'
  | 'resourceCapture'
  | 'visionTools'
  | 'networkTools'
  | 'python'
  | 'all';

// ──── 原子工具集合 ────

/**
 * 核心页面读取工具（无条件注入，所有智能体/场景必得）。
 * 当前标签页正文读取是浏览器 Agent 的基础能力——用户指令指向当前页面时
 * 模型必须能直接读取（runtime-builder 与 CORE_INTERACT_TOOL_IDS 一并置入
 * 工具集，用户在编辑页不可裁剪）。编辑页各工具组不再包含它。
 */
export const CORE_PAGE_TOOL_IDS = ['browser_get_page_text'] as const;

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
 * read_file（上传文件分页读取）同属核心层：用户上传文件的 <upload_file>
 * 信封出现在任意会话，读取入口必须恒定在场（使用准则见 upload-file-prompt）。
 *
 * 维护约定：新增无条件注入的工具时，必须同时改这里与 runtime-builder 的
 * toolIdSet 初始化（两处口径不一致 = 技能匹配漏判）。
 */
export const CORE_SESSION_TOOL_IDS: readonly string[] = [
  ...CORE_INTERACT_TOOL_IDS,
  ...CORE_PAGE_TOOL_IDS,
  PLAN_TOOL_ID,
  NOTE_TOOL_ID,
  READ_FILE_TOOL_ID,
];

/** 基础浏览器操作（同时作为未知场景的防御性回退；不含无条件注入的核心工具） */
const BASIC_BROWSER_TOOLS = [
  'browser_observe',
  'browser_interact',
  'browser_navigation',
  'browser_get_page_info',
  'browser_tabs',
  'browser_page_exec',
  // 通用网页搜索（engine 枚举：bing / baidu）：导航 + 解析一步完成
  'web_search',
] as const;

/**
 * 通用网页搜索工具（engine 枚举 bing / baidu，一次调用完成导航 + 结果解析）
 */
const WEB_SEARCH_TOOL_IDS = ['web_search'] as const;

/**
 * 站点平台搜索工具（platform 枚举：知乎 / GitHub / CSDN / MOOC / 小红书 /
 * 知网 / Bilibili）——与通用网页搜索共用执行链路，按「站点内检索」单列。
 */
const PLATFORM_SEARCH_TOOL_IDS = ['platform_search'] as const;

/**
 * 搜索工具组（hub 自定义智能体用）：通用网页检索 + 站点平台检索。
 * 原「扩展搜索平台 / 结果抓取 / 集成搜索」三组 27 个平台专属工具已合并于此；
 * 2026-11-10 起按语义拆为两个工具（web_search / platform_search），
 * hub 编辑页仍以「搜索」一组呈现，避免组内再分细粒度勾选。
 */
const SEARCH_GROUP_TOOL_IDS = [...WEB_SEARCH_TOOL_IDS, ...PLATFORM_SEARCH_TOOL_IDS] as const;

/** Bilibili 专用（检索走 platform_search 的 platform="bilibili"，视频页导航走浏览器工具） */
const BILIBILI_TOOLS = [
  'bilibili_subtitle_tool',
  'bilibili_jump_tool',
  'browser_navigation',
  'platform_search',
] as const;

/**
 * 网络观察（CDP Network 域被动捕获）。
 *
 * **两个 action agent（文本通用助手 / 视觉通用助手）不携带此工具**：它们的
 * 职责是操作页面，网络观察对「点哪里、填什么」是噪声；且该工具占用
 * exclusiveText 互斥队列（与视觉 GUI 共用调试会话），会拖慢每一步交互。
 * 因此它只出现在数据采集 / 网站学习 / 技能验证这些「以观察数据为目的」的
 * 场景里，以及 hub 自定义智能体的资源工具组中。
 */
const NETWORK_CAPTURE_TOOL = 'browser_network_capture';

/** 自动化交互（browser_get_page_text 由核心层无条件注入，此处不重复登记） */
const AUTOMATION_TOOLS = [
  'browser_observe',
  'browser_interact',
  'browser_dom_explore',
  'browser_tabs',
  'browser_navigation',
  'browser_get_page_info',
  // 通用网页搜索（engine 枚举：bing / baidu，自带导航）
  'web_search',
  // 站点平台搜索（platform 枚举：知乎 / GitHub / CSDN 等，自带导航）
  'platform_search',
  'generic_wait',
  // 懒加载/无限滚动页面：getter 采样前先滚动触发渲染，再重新采集
  'browser_page_exec',
] as const;

/**
 * 视觉通用助手基座：自动截图 + 统一 GUI 手势 + DOM 感知。
 * 仅供 visionAgent 场景使用；网站学习/验证有自己独立的清单（见下方
 * 网站学习区块），两者的配置各自演进、互不影响。
 */
const VISION_AGENT_TOOLS = [
  VISION_GUI_TOOL_ID,
  // 视觉操作保留完整 DOM 感知/交互能力，生成的混合定位技能才能被实际执行。
  // 标签页/窗口管理（含窗口树枚举）随 browser_tabs 基座在场，不再单独登记
  ...AUTOMATION_TOOLS,
  'screenshot',
] as const;

// ──── 网站学习（Site Learn）场景 ────
// 学习段与验证段是同一会话的两轮运行，工具组按「目标操作模式 × 学习策略」
// 选择，并且**互斥**地只带各自的终止型提交工具——两套同时注入会让模型
// 有机会在错误的阶段调用错误的提交工具。
//
// ── 独立配置约定 ──
// 本区块是学习域**自有**的工具清单：刻意不展开 AUTOMATION_TOOLS /
// VISION_AGENT_TOOLS。文本通用助手与视觉通用助手两个智能体的配置变更
// 不得影响网站学习/验证，反之亦然（learn-prompts 同理不 import 两个智能体
// 的 SOP；两边靠注释交叉锚定，见 learn-prompts.ts 文末维护约定）。
//
// ── 组合口径 ──
//   target=text  × strategy=text → siteLearnText         纯文本，无截图
//   target=text  × strategy=vision → siteLearnVisionForText 文本全套 + 截图（仅辅助理解），**无 vision_gui**
//   target=vision（策略恒 vision）→ siteLearnVision      文本全套 + vision_gui + 截图（标签页/窗口枚举随 browser_tabs 基座在场）
// 验证段只看 targetMode（技能交给谁用就用谁的执行面盲测）。
//
// 共同部分（核心层已无条件注入，此处不重复登记）：
//   browser_get_page_text / plan_tool / interact / note_tool
//   （学习段逐步留痕、验证段记录卡点的 note_tool 用法由 learn-prompts 的
//     <recording> 规范约束，工具本身随核心层恒定可用）。
// 都带 browser_network_capture：观察页面背后数据（learn-prompts 的
// dom-locating 块与之交叉锚定）。

/**
 * 学习/验证共用的 DOM 文本操作基座（学习域自有清单，不引用 AUTOMATION_TOOLS）。
 * browser_get_page_text 由核心层注入，不在此列。
 * browser_tabs 同时承载原「窗口树枚举」（action="windows"），视觉/文本目标
 * 统一随基座在场——窗口信息是纯枚举只读，不再是视觉目标专属。
 */
const SITE_LEARN_DOM_TOOLS = [
  'browser_observe',
  'browser_interact',
  'browser_dom_explore',
  'browser_tabs',
  'browser_navigation',
  'browser_get_page_info',
  // 通用网页搜索（engine 枚举：bing / baidu，自带导航）
  'web_search',
  'generic_wait',
  // 懒加载/无限滚动页面：getter 采样前先滚动触发渲染，再重新采集
  'browser_page_exec',
] as const;

/** 网站学习·文本目标 × 文本策略：纯文本探索，无截图循环 */
const SITE_LEARN_TEXT_TOOLS = [
  ...SITE_LEARN_DOM_TOOLS,
  NETWORK_CAPTURE_TOOL,
  'submit_skill',
] as const;

/**
 * 网站学习·文本目标 × 视觉策略（siteLearnVisionForText）：
 * 文本全套 + screenshot——自动截图仅用于帮助理解屏幕元素。
 * **不携带 vision_gui**：文本目标的学习、操作与取证一律走 DOM 文本通道，
 * 视觉手势工具不得出现在该组合的工具面
 * （与 learn-prompts 的 <vision-gui-tool> 禁用分区交叉锚定）。
 */
const SITE_LEARN_VISION_FOR_TEXT_TOOLS = [
  ...SITE_LEARN_TEXT_TOOLS,
  'screenshot',
] as const;

/** 网站学习·视觉目标：文本全套 + 统一 GUI 手势 + 截图，按需打标 */
const SITE_LEARN_VISION_TOOLS = [
  ...SITE_LEARN_TEXT_TOOLS,
  VISION_GUI_TOOL_ID,
  'screenshot',
] as const;

/** 按目标与学习策略共同选择学习段场景（学习看 strategy × targetMode） */
export function getSiteLearnScenario(config: { targetMode: 'text' | 'vision'; strategy: 'text' | 'vision' }): ToolScenario {
  if (config.targetMode === 'vision') return 'siteLearnVision';
  return config.strategy === 'vision' ? 'siteLearnVisionForText' : 'siteLearnText';
}

/** 验证段·目标模式文本：纯文本工具盲测技能（无截图、无 GUI），提交验收结论 */
const SITE_VALIDATE_TEXT_TOOLS = [
  ...SITE_LEARN_DOM_TOOLS,
  NETWORK_CAPTURE_TOOL,
  'submit_validation',
] as const;

/** 验证段·目标模式视觉：文本全套 + 统一 GUI，与产出该技能的执行面同构 */
const SITE_VALIDATE_VISION_TOOLS = [
  ...SITE_LEARN_DOM_TOOLS,
  NETWORK_CAPTURE_TOOL,
  VISION_GUI_TOOL_ID,
  'screenshot',
  'submit_validation',
] as const;

/** 按目标操作模式选择验证段场景（验证只看 targetMode，与学习策略无关） */
export function getSiteValidateScenario(targetMode: 'text' | 'vision'): ToolScenario {
  return targetMode === 'vision' ? 'siteValidateVision' : 'siteValidateText';
}

/**
 * 数据批量采集（文本通用助手全套 + 数据引用通道）：
 * 脚本抓取（page_exec saveResult）→ 暂存批次（data_ref_tool）→ xlsx 直接导出，
 * 大批量数据全程不经过模型上下文；DOM 结构明确时可用 browser_extract_data，
 * 已知 JSON 接口用 browser_network_request 直连。
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

/** 资源嗅探与下载（媒体资源嗅探 + 网络捕获 + 资源落盘） */
const RESOURCE_GROUP_TOOLS = [
  'resource_sniffer',
  'browser_network_capture',
  'resource_downloader',
] as const;

/** 下载与文件上传（查询下载状态 + 本地文件上传） */
const FILES_GROUP_TOOLS = [
  'get_downloads_status',
  'file_upload_getter',
  'file_uploader',
] as const;

/** 导航增强（快捷/历史/书签导航与检索） */
const NAVIGATION_GROUP_TOOLS = [
  'quick_navigation',
  'history_navigation',
  'bookmark_navigation',
  'browser_search_bookmarks',
  'browser_search_history',
] as const;

/** 数据处理（结构化抽取 + 表格 + 引用暂存 + 压缩 + 图表渲染） */
const DATA_GROUP_TOOLS = [
  'extract_data',
  'xlsx_tool',
  'data_ref_tool',
  'semantic_compressor',
  'mermaid_renderer',
] as const;

/** 页面深度读取（HTML / 元数据 / 指定区域抓取；
 *  结构化正文读取 browser_get_page_text 已升级为核心能力无条件注入
 *  （结构化 Markdown + url 直读 + 超长分页），不再占用工具组位；
 *  browser_get_element_info 已下线（由 browser_observe 取代） */
const PAGE_READ_GROUP_TOOLS = [
  'browser_get_page_html',
  'browser_get_page_info',
  'page-source',
] as const;

/** DOM 元素交互（文本观察、结构探索、节点交互与等待；
 *  点击/填充统一走 browser_interact——内联 payload + frameId 精确定向 iframe，
 *  browser_click / browser_fill（content-script 消息通道）已下线） */
const DOM_INTERACT_GROUP_TOOLS = [
  'browser_observe',
  'browser_dom_explore',
  'browser_interact',
  'browser_wait_for_element',
] as const;

/** 标签页与窗口（统一枚举/切换/创建/关闭/窗口树，单工具五 action） */
const TABS_WINDOWS_GROUP_TOOLS = [
  'browser_tabs',
] as const;

/** 页面脚本执行（注入 JS、向注入脚本发消息、页面级高权限执行/抽取/清理） */
const SCRIPTING_GROUP_TOOLS = [
  'browser_send_command_to_inject_script',
  'browser_page_exec',
  'browser_extract_data',
  'browser_clean_page',
] as const;

/** 书签与历史（书签增删查 + 历史检索 + 快捷/历史/书签导航） */
const BOOKMARK_HISTORY_GROUP_TOOLS = [
  'browser_bookmark_create',
  'browser_bookmark_delete',
  'browser_search_bookmarks',
  'browser_search_history',
  'quick_navigation',
  'history_navigation',
  'bookmark_navigation',
] as const;

/**
 * 搜索工具组（hub 自定义智能体工具组）：通用网页检索 + 站点平台检索。
 * 直接引用 SEARCH_GROUP_TOOL_IDS，杜绝两份同值清单漂移。
 */
const SEARCH_GROUP_TOOLS = [...SEARCH_GROUP_TOOL_IDS];

/** 下载拦截与文件捕获（开启/停止拦截 + 已捕获文件列表/详情/清理） */
const RESOURCE_CAPTURE_GROUP_TOOLS = [
  'start_download_interception',
  'stop_download_interception',
  'list_captured_files',
  'get_captured_file_by_id',
  'clear_captured_files',
] as const;

/**
 * 视觉辅助工具组（hub 自定义智能体可勾选面）：截图与 OCR。
 *
 * **刻意不含 vision_gui**：vision_gui 只经「视觉操作」开关（AgentConfig.vision）
 * 注入——hub 编辑器不提供勾选入口，runtime 装配时按开关对智能体工具面做
 * 注入/剔除归一（见 runtime-builder「视觉操作开关注入」），提示词钩子再按
 * 工具面检测注入规程。三条链路共同保证「vision_gui ∈ 工具面 ⇔ 开关开启」。
 */
const VISION_TOOLS_GROUP = [
  'screenshot',
  'ocr',
] as const;

/** 网络请求与控制台（HTTP 请求发送 + 控制台输出/异常捕获） */
const NETWORK_TOOLS_GROUP = [
  'browser_network_request',
  'browser_console',
] as const;

/**
 * Python 沙箱计算（hub 自定义智能体工具组）。
 * 环境可用性由运行时守卫：未下载/未核验时 python_run 返回引导错误，
 * 智能体编辑页对该组做可用性门控（见 AgentManager）。
 */
const PYTHON_GROUP_TOOLS = [
  'python_run',
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
  visionAssist: ['screenshot', VISION_GUI_TOOL_ID, 'generic_wait'],

  /** 视觉通用助手：完整截图相对坐标操作；按需打标用于检查 */
  visionAgent: [...VISION_AGENT_TOOLS],

  /** 网站学习·文本目标×文本策略（学习段，结束信号 submit_skill；无截图） */
  siteLearnText: [...SITE_LEARN_TEXT_TOOLS],
  /** 网站学习·视觉目标（学习段；文本全套 + vision_gui 手势，按需打标） */
  siteLearnVision: [...SITE_LEARN_VISION_TOOLS],
  /** 网站学习·文本目标×视觉策略（学习段；文本全套 + 截图辅助理解，**无 vision_gui**） */
  siteLearnVisionForText: [...SITE_LEARN_VISION_FOR_TEXT_TOOLS],
  /** 网站学习·验证段，目标模式文本（结束信号 submit_validation；无截图、无 GUI） */
  siteValidateText: [...SITE_VALIDATE_TEXT_TOOLS],
  /** 网站学习·验证段，目标模式视觉（结束信号 submit_validation；文本全套 + vision_gui） */
  siteValidateVision: [...SITE_VALIDATE_VISION_TOOLS],

  /** 思维导图：Excalidraw 绘图 */
  excalidraw: ['excalidraw_tool'],

  /** Bilibili 检索与视频处理（站点搜索工具按会话动态扩展） */
  bilibili: [...BILIBILI_TOOLS],

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
    'browser_page_exec',
  ],

  /** 文本通用助手：通用网页自动化 */
  automation: [...AUTOMATION_TOOLS],

  /** 数据采集助手：批量数据采集与导出（脚本抓取 → dataRef 暂存 → xlsx 直出） */
  dataHarvest: [...DATA_HARVEST_TOOLS],

  /** 资源嗅探与下载（hub 自定义智能体工具组） */
  resource: [...RESOURCE_GROUP_TOOLS],

  /** 下载与文件上传（hub 自定义智能体工具组） */
  files: [...FILES_GROUP_TOOLS],

  /** 导航增强（hub 自定义智能体工具组） */
  navigation: [...NAVIGATION_GROUP_TOOLS],

  /** 数据处理（hub 自定义智能体工具组） */
  data: [...DATA_GROUP_TOOLS],

  /** 页面深度读取（hub 自定义智能体工具组） */
  pageRead: [...PAGE_READ_GROUP_TOOLS],

  /** DOM 元素交互（hub 自定义智能体工具组） */
  domInteract: [...DOM_INTERACT_GROUP_TOOLS],

  /** 标签页与窗口（hub 自定义智能体工具组） */
  tabsWindows: [...TABS_WINDOWS_GROUP_TOOLS],

  /** 页面脚本执行（hub 自定义智能体工具组） */
  scripting: [...SCRIPTING_GROUP_TOOLS],

  /** 书签与历史（hub 自定义智能体工具组） */
  bookmarkHistory: [...BOOKMARK_HISTORY_GROUP_TOOLS],

  /** 搜索工具组（hub 自定义智能体工具组；通用网页检索 + 站点平台检索） */
  webSearch: [...SEARCH_GROUP_TOOLS],

  /** 下载拦截与文件捕获（hub 自定义智能体工具组） */
  resourceCapture: [...RESOURCE_CAPTURE_GROUP_TOOLS],

  /** 视觉坐标操作（hub 自定义智能体工具组；仅截图/OCR——vision_gui 由「视觉操作」开关注入） */
  visionTools: [...VISION_TOOLS_GROUP],

  /** 网络请求与控制台（hub 自定义智能体工具组） */
  networkTools: [...NETWORK_TOOLS_GROUP],

  /** Python 沙箱计算（hub 自定义智能体工具组；须先在设置中启用 Python 环境） */
  python: [...PYTHON_GROUP_TOOLS],
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
    return getAvailableToolIds?.() ?? [];
  }
  // 防御：JS 调用方传入未注册的场景键时回退基础浏览器工具，而非抛错中断装配
  return SCENARIO_PRESETS[scenario] ?? [...BASIC_BROWSER_TOOLS];
}
