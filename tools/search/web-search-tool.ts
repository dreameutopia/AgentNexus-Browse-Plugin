/**
 * 通用网页搜索工具（web_search）
 *
 * 只承载**通用搜索引擎**（engine 枚举：bing / baidu）。站点内检索（知乎 /
 * GitHub / CSDN / MOOC / 小红书 / 中国知网 / Bilibili）由 platform_search
 * 承载——两个工具共用同一执行链路（导航 + 等待 + 解析 + Markdown 表，见
 * search-tool-base.ts），差异仅在目标集合、参数名与面向模型的文案。
 *
 * 历史沿革：本工具曾以 website 枚举承载全部 9 个搜索目标（通用引擎 + 站点
 * 平台），现按「通用网页检索 / 站点内检索」拆为两个工具——目标集合小到能
 * 在工具描述里讲清边界，模型选错工具的空间也随之消失。
 *
 * 执行上下文：sidepanel 与 background（service worker）均可运行。
 */

import { ToolMetadata } from '../registry';
import { BaseSearchTool, type SearchToolSpec } from './search-tool-base';
import { SEARCH_ENGINE_IDS } from './search-targets';

export class WebSearchTool extends BaseSearchTool {
  name = 'web_search';

  /** 差异面：只接通用搜索引擎，参数名为 engine */
  protected readonly spec: SearchToolSpec = {
    targets: SEARCH_ENGINE_IDS,
    paramName: 'engine',
    paramLabel: '搜索引擎',
    targetKindLabel: '搜索引擎',
  };

  /** 工具描述主体（能力边界 + 并发禁令 + 结果契约 + 可信度口径） */
  protected readonly usageDescription =
    '通用网页搜索（通用搜索引擎）：一次调用完成「导航到搜索引擎结果页 → 等待加载 → 解析结构化结果 → Markdown 表格」。' +
    'engine 决定用哪个搜索引擎（枚举见参数说明，共 2 个）。' +
    '⚠ 本工具自带页面导航（效果等同 browser_navigation(action="open") 打开搜索结果页，无需先手动导航）：会真实打开或跳转标签页并改变当前活动页面。' +
    '因此【禁止在同一轮里并发调用本工具】——多个导航会互相争抢活动标签页、解析到错误页面；需要换关键词时逐个串行调用，每次依据上次返回决定下一步。' +
    '站点内检索（知乎 / GitHub / CSDN / 中国大学MOOC / 小红书 / 中国知网 / Bilibili）用 platform_search，本工具只负责通用网页。' +
    '返回两部分：navigation（是否成功导航 + 当前实际网址）与 results（解析出的条目数与 Markdown 结果表）。' +
    '结果表逐条给出标题、链接与摘要——**可信度由你自己按来源域名判断**：官方/一手站点（机构官网、交易所与监管披露、上市公司公告、通讯社与主流媒体、官方文档）可信度高；' +
    '百科与社区问答、聚合站、自媒体与论坛只是线索入口、不能作为唯一定论。' +
    '凡进入结论的关键事实，必须换到至少一个独立域名（不同注册域）再读一遍原文核对；' +
    '两处说法冲突时如实呈现分歧，不要单选其一。' +
    'results 解析失败时 navigation 仍有效——页面已就位，用 browser_get_page_text 读取当前页自行解析即可。';

  /** 目标参数选择指引（枚举清单由基类按注册表生成，此处只写「怎么选」） */
  protected readonly paramDescription =
    '两者都可用于通用网页检索，差异在索引覆盖面与结果密度——中文与国内资讯偏百度，海外与英文资料偏 Bing；不确定时先用一个看结果密度，不够再换另一个。';

  metadata: ToolMetadata = {
    name: 'web_search',
    description:
      '通用网页搜索：一次调用完成「导航到搜索引擎结果页 → 等待加载 → 解析结构化结果 → Markdown 表格」（bing / baidu）',
    displayName: '网页搜索',
    category: 'search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['search', 'integrated', 'multi-engine'],
    permissions: ['tabs', 'scripting'],
    // 搜索必然改变页面（导航到结果页）：保持默认（noVisionRecapture 缺省
    // false），视觉会话在工具批次后重拍截图
  };

  openaiSchema = this.buildOpenAISchema('web_search');
}
