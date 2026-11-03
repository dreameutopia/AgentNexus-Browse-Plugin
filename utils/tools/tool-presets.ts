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

/** 场景类型 */
export type ToolScenario =
  | 'chat'
  | 'visionAssist'
  | 'visionAgent'
  | 'excalidraw'
  | 'bilibili'
  | 'searchAgent'
  | 'deepSearch'
  | 'automation'
  | 'dataHarvest'
  | 'siteLearnText'
  | 'siteLearnVision'
  | 'siteValidateText'
  | 'siteValidateVision'
  | 'note'
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
  | 'extendedSearch'
  | 'resultScrape'
  | 'integratedSearch'
  | 'resourceCapture'
  | 'visionTools'
  | 'networkTools'
  | 'skillLoad'
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
 * 会话「无条件注入」核心工具全集——与 runtime-builder 装配时置首的三项严格同源。
 *
 * 用途：技能可用性判定需要知道会话**真实**的工具面。智能体预设工具只是一部分，
 * 核心工具（交互征询 / 页面正文 / 任务计划）对任何智能体都恒定可用；漏掉它们
 * 会让「allowed-tools 含核心工具」的技能在所有智能体下都匹配失败。
 *
 * 维护约定：新增无条件注入的工具时，必须同时改这里与 runtime-builder 的
 * toolIdSet 初始化（两处口径不一致 = 技能匹配漏判）。
 */
export const CORE_SESSION_TOOL_IDS: readonly string[] = [
  ...CORE_INTERACT_TOOL_IDS,
  ...CORE_PAGE_TOOL_IDS,
  PLAN_TOOL_ID,
];

/** 基础浏览器操作（同时作为未知场景的防御性回退；不含无条件注入的核心工具） */
const BASIC_BROWSER_TOOLS = [
  'browser_navigate',
  'browser_get_page_info',
  'wait_page_load',
  'browser_go_back_or_forward',
  'browser_get_all_tabs',
  'browser_switch_tab',
  'browser_close_tab',
  'browser_create_tab',
  'browser_scroll',
  'browser_inject_script',
  'bing_search',
] as const;

/** 多平台搜索 */
const SEARCH_PLATFORM_TOOLS = [
  'zhihu_search',
  'baidu_search',
  'bing_search',
  'github_search',
  'csdn_search',
] as const;

/** Bilibili 专用 */
const BILIBILI_TOOLS = [
  'bilibili_subtitle_tool',
  'bilibili_jump_tool',
  'bilibili_search_result_scraper',
  'browser_navigate',
  'browser_go_back_or_forward',
  'bilibili_search',
] as const;

/** 笔记 / 外部记忆（统一 note_tool，action 区分增删改查与列表） */
const NOTE_TOOLS = [
  'note_tool',
] as const;

/** 自动化交互（browser_get_page_text 由核心层无条件注入，此处不重复登记） */
const AUTOMATION_TOOLS = [
  'browser_navigate',
  'browser_get_page_info',
  'wait_page_load',
  'browser_go_back_or_forward',
  'bing_search',
  'generic_wait',
  // 懒加载/无限滚动页面：getter 采样前先滚动触发渲染，再重新采集
  'browser_scroll',
  'interactive_input_getter',
  'interactive_button_getter',
  'enhance_click',
  'enhance_fill',
  'browser_page_exec',
] as const;

/**
 * Vision Action 基座：自动截图 + 手动恢复截图，vision_mark 按需打标。
 * 提取为常量供 visionAgent 场景与网站学习（视觉策略 / 视觉验证）共用，
 * 避免三处列表漂移。
 */
const VISION_AGENT_TOOLS = [
  'screenshot',
  'browser_navigate',
  'vision_click',
  'vision_drag',
  'vision_input',
  'vision_hover',
  'vision_keyboard',
  'vision_mark',
  'vision_inspect',
  'browser_go_back_or_forward',
  'wait_page_load',
  'vision_scroll',
] as const;

// ──── 网站学习（Site Learn）场景 ────
// 学习段与验证段是同一会话的两轮运行，工具组按「学习策略 / 目标操作模式」
// 选择，并且**互斥**地只带各自的终止型提交工具——两套同时注入会让模型
// 有机会在错误的阶段调用错误的提交工具。
// 共同部分（核心层已无条件注入，此处不重复登记）：
//   browser_get_page_text / plan_tool / interact。
// 两段都带 note_tool：学习段用于逐步留痕，验证段用于记录卡点。

/** 网站学习·文本策略：Auto Action 基座 + 外部记忆 + 学习提交 */
const SITE_LEARN_TEXT_TOOLS = [
  ...AUTOMATION_TOOLS,
  'note_tool',
  'submit_skill',
] as const;

/**
 * 网站学习·视觉策略：Vision Action 基座 + 反查转译 + 外部记忆 + 学习提交。
 * vision_inspect 是「视觉定位 → 选择器」的转译通道：目标模式为 text 时
 * 必须靠它把看到的位置翻译成文本模型可用的 xpath/选择器。
 */
const SITE_LEARN_VISION_TOOLS = [
  ...VISION_AGENT_TOOLS,
  'browser_get_page_info',
  'generic_wait',
  'note_tool',
  'submit_skill',
] as const;

/** 验证段·目标模式文本：由 Auto Action 盲测技能，提交验收结论 */
const SITE_VALIDATE_TEXT_TOOLS = [
  ...AUTOMATION_TOOLS,
  'note_tool',
  'submit_validation',
] as const;

/** 验证段·目标模式视觉：由 Vision Action 盲测技能，提交验收结论 */
const SITE_VALIDATE_VISION_TOOLS = [
  ...VISION_AGENT_TOOLS,
  'browser_get_page_info',
  'generic_wait',
  'note_tool',
  'submit_validation',
] as const;

/**
 * 数据批量采集（Auto Action 全套 + 数据引用通道）：
 * 脚本抓取（page_exec saveResult）→ 暂存批次（data_ref_tool）→ xlsx 直接导出，
 * 大批量数据全程不经过模型上下文；DOM 结构明确时可用 browser_extract_data，
 * 已知 JSON 接口用 browser_network_request 直连。
 * 无限滚动分页靠 browser_scroll（继承自 AUTOMATION_TOOLS）触发加载后重采。
 */
const DATA_HARVEST_TOOLS = [
  ...AUTOMATION_TOOLS,
  'browser_extract_data',
  'browser_network_request',
  'data_ref_tool',
  'xlsx_tool',
] as const;

/** 笔记（统一工具，含全部操作） */
const NOTE_GROUP_TOOLS = [
  'note_tool',
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

/** 页面深度读取（HTML / 元数据 / 元素信息 / Markdown / 指定区域抓取；
 *  正文读取 browser_get_page_text 已升级为核心能力无条件注入，不再占用工具组位；
 *  browser_get_element_info 已下线（由 interactive_button_getter / interactive_input_getter 取代） */
const PAGE_READ_GROUP_TOOLS = [
  'browser_get_page_html',
  'browser_get_page_info',
  'page-source',
  'getPageMarkdown',
  'browser_web_fetcher',
] as const;

/** DOM 元素交互（CSS 选择器的点击、填充、键盘与等待；
 *  点击/填充统一走 enhance_click / enhance_fill——内联 payload + frameId 精确定向 iframe，
 *  browser_click / browser_fill（content-script 消息通道）已下线） */
const DOM_INTERACT_GROUP_TOOLS = [
  'browser_keyboard',
  'browser_wait_for_element',
  'browser_scroll',
  'enhance_click',
  'enhance_fill',
] as const;

/** 标签页与窗口（全局窗口/标签枚举、切换、创建、关闭） */
const TABS_WINDOWS_GROUP_TOOLS = [
  'browser_window',
  'browser_get_all_tabs',
  'browser_switch_tab',
  'browser_create_tab',
  'browser_close_tab',
  'browser_close_tabs',
] as const;

/** 页面脚本执行（注入 JS、向注入脚本发消息、页面级高权限执行/抽取/清理） */
const SCRIPTING_GROUP_TOOLS = [
  'browser_inject_script',
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

/** 扩展搜索平台（MOOC / 小红书 / 知网 / B 站检索） */
const EXTENDED_SEARCH_GROUP_TOOLS = [
  'mooc_search',
  'xiaohongshu_search',
  'cnki_search',
  'bilibili_search',
] as const;

/** 搜索结果抓取（各平台结果页结构化解析为 Markdown 表格） */
const RESULT_SCRAPE_GROUP_TOOLS = [
  'baidu_result_scraper',
  'bing_result_scraper',
  'zhihu_result_scraper',
  'github_result_scraper',
  'csdn_result_scraper',
  'cnki_result_scraper',
  'mooc_result_scraper',
  'xiaohongshu_result_scraper',
  'bilibili_search_result_scraper',
] as const;

/** 集成搜索（检索 + 结果页抓取 + Markdown 表格一步完成） */
const INTEGRATED_SEARCH_GROUP_TOOLS = [
  'baidu_integrated_search',
  'bing_integrated_search',
  'zhihu_integrated_search',
  'github_integrated_search',
  'csdn_integrated_search',
  'cnki_integrated_search',
  'mooc_integrated_search',
  'xiaohongshu_integrated_search',
  'bilibili_integrated_search',
] as const;

/** 下载拦截与文件捕获（开启/停止拦截 + 已捕获文件列表/详情/清理） */
const RESOURCE_CAPTURE_GROUP_TOOLS = [
  'start_download_interception',
  'stop_download_interception',
  'list_captured_files',
  'get_captured_file_by_id',
  'clear_captured_files',
] as const;

/** 统一相对坐标 GUI 工具；视觉循环外调用时须主动截图获取 screenshotId。 */
const VISION_TOOLS_GROUP = [
  'screenshot',
  'ocr',
  'vision_click',
  'vision_drag',
  'vision_input',
  'vision_hover',
  'vision_keyboard',
  'vision_mark',
  'vision_inspect',
  'vision_scroll',
] as const;

/** 网络请求与控制台（HTTP 请求发送 + 控制台输出/异常捕获） */
const NETWORK_TOOLS_GROUP = [
  'browser_network_request',
  'browser_console',
] as const;

/** 技能加载（按需读取已启用技能的指令与资源文件） */
const SKILL_LOAD_GROUP_TOOLS = [
  'load_skill',
  'read_skill_file',
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
  /** 默认对话（未选择智能体）：轻量页面读取（正文读取已由核心层无条件提供） */
  chat: ['getPageMarkdown'],

  /** 视觉助手：只读引导 + 滚动查看（截图由会话引擎注入，不占工具位） */
  visionAssist: ['browser_scroll', 'screenshot'],

  /** Vision Action：完整截图相对坐标操作；按需打标用于检查 */
  visionAgent: [...VISION_AGENT_TOOLS],

  /** 网站学习·文本策略（学习段，结束信号 submit_skill） */
  siteLearnText: [...SITE_LEARN_TEXT_TOOLS],
  /** 网站学习·视觉策略（学习段，结束信号 submit_skill） */
  siteLearnVision: [...SITE_LEARN_VISION_TOOLS],
  /** 网站学习·验证段，目标模式文本（结束信号 submit_validation） */
  siteValidateText: [...SITE_VALIDATE_TEXT_TOOLS],
  /** 网站学习·验证段，目标模式视觉（结束信号 submit_validation） */
  siteValidateVision: [...SITE_VALIDATE_VISION_TOOLS],

  /** 思维导图：Excalidraw 绘图 */
  excalidraw: ['excalidraw_tool'],

  /** Bilibili 检索与视频处理（站点搜索工具按会话动态扩展） */
  bilibili: [...BILIBILI_TOOLS],

  /** 搜索智能体：多平台单次快速检索 */
  searchAgent: [...SEARCH_PLATFORM_TOOLS, 'browser_get_page_info'],

  /** Deep Search：多站点深度调研（站点 search/scraper 按已开启站点动态注入） */
  deepSearch: [
    'browser_go_back_or_forward',
    'browser_navigate',
    'browser_get_page_info',
    'getPageMarkdown',
    ...NOTE_TOOLS,
  ],

  /** Auto Action：通用网页自动化 */
  automation: [...AUTOMATION_TOOLS],

  /** 数据收割机：批量数据采集与导出（脚本抓取 → dataRef 暂存 → xlsx 直出） */
  dataHarvest: [...DATA_HARVEST_TOOLS],

  /** 笔记备忘：完整增删改查（hub 自定义智能体工具组） */
  note: [...NOTE_GROUP_TOOLS],

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

  /** 扩展搜索平台（hub 自定义智能体工具组） */
  extendedSearch: [...EXTENDED_SEARCH_GROUP_TOOLS],

  /** 搜索结果抓取（hub 自定义智能体工具组） */
  resultScrape: [...RESULT_SCRAPE_GROUP_TOOLS],

  /** 集成搜索（hub 自定义智能体工具组） */
  integratedSearch: [...INTEGRATED_SEARCH_GROUP_TOOLS],

  /** 下载拦截与文件捕获（hub 自定义智能体工具组） */
  resourceCapture: [...RESOURCE_CAPTURE_GROUP_TOOLS],

  /** 视觉坐标操作（hub 自定义智能体工具组） */
  visionTools: [...VISION_TOOLS_GROUP],

  /** 网络请求与控制台（hub 自定义智能体工具组） */
  networkTools: [...NETWORK_TOOLS_GROUP],

  /** 技能加载（hub 自定义智能体工具组） */
  skillLoad: [...SKILL_LOAD_GROUP_TOOLS],

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
