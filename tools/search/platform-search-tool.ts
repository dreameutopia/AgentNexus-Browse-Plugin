/**
 * 站点平台搜索工具（platform_search）
 *
 * 承载**通用站点内检索**（platform 枚举：知乎 / GitHub / CSDN / MOOC /
 * 小红书 / 中国知网）。通用网页检索由 web_search（bing / baidu）承载，
 * Bilibili 站内视频检索由专属工具 bilibili_search 承载（B 站是特定智能体的
 * 专属动作，不属于通用站点检索面）——三个工具共用同一执行链路
 * （导航 + 等待 + 解析 + Markdown 表，见 search-tool-base.ts）与同一份目标
 * 注册表（search-targets.ts），差异仅在目标集合、参数名与面向模型的文案。
 *
 * 与 web_search 的分工：站点结果是**站内聚合**（社区观点、二手转述、
 * 垂直领域内容），适合做观点分布与线索发现；官方披露、财报、监管文件等
 * 一手事实仍应经 web_search 找独立域名来源交叉核对。
 *
 * 执行上下文：sidepanel 与 background（service worker）均可运行。
 */

import { ToolMetadata } from '../registry';
import { BaseSearchTool, type SearchToolSpec } from './search-tool-base';
import { SEARCH_PLATFORM_IDS } from './search-targets';

export class PlatformSearchTool extends BaseSearchTool {
  name = 'platform_search';

  /** 差异面：只接通用站点平台，参数名为 platform */
  protected readonly spec: SearchToolSpec = {
    targets: SEARCH_PLATFORM_IDS,
    paramName: 'platform',
    paramLabel: '站点平台',
    targetKindLabel: '站点平台',
  };

  /** 工具描述主体（能力边界 + 站点差异 + 并发禁令 + 结果契约） */
  protected readonly usageDescription =
    '站点平台搜索（站点内检索）：一次调用完成「导航到站点搜索结果页 → 等待加载 → 解析结构化结果 → Markdown 表格」。' +
    'platform 决定在哪个站点内检索（枚举见参数说明，共 ' + SEARCH_PLATFORM_IDS.length + ' 个）。' +
    '通用网页检索用 web_search（bing / baidu）；Bilibili 站内视频检索用 bilibili_search——本工具只负责通用站点内检索。' +
    '⚠ 本工具同样自带页面导航（效果等同 browser_navigation(action="open")），会真实打开或跳转标签页并改变当前活动页面，因此【禁止在同一轮里并发调用本工具】。' +
    '站点差异须知：知乎 / 小红书等内容社区依赖登录态，未登录常返回登录墙或空结果——此时 results.count=0 且页面已就位，可改用 browser_get_page_text 读取当前页，或换 web_search 走通用检索；' +
    '中国知网 / MOOC 结果为动态渲染，可调大 waitTime（上限 10000 毫秒）等待渲染完成。' +
    '返回两部分：navigation（是否成功导航 + 当前实际网址）与 results（解析出的条目数与 Markdown 结果表）。' +
    '站点内结果是站内聚合（多为二手转述与社区观点），可作为线索与观点分布的一手来源，但不能替代官方披露——关键事实仍需独立域名交叉核对。' +
    'results 解析失败时 navigation 仍有效——页面已就位，用 browser_get_page_text 读取当前页自行解析即可。';

  /** 目标参数选择指引（枚举清单由基类按注册表生成，此处只写「怎么选」） */
  protected readonly paramDescription =
    '按问题性质选站点：技术实现与踩坑→csdn；开源项目与 issue→github；专业问答与经验讨论→zhihu；系统化课程与教材→mooc；消费与生活方式内容→xiaohongshu；学术论文与文献→cnki。';

  metadata: ToolMetadata = {
    name: 'platform_search',
    description:
      '站点平台搜索：一次调用完成「导航到站点搜索结果页 → 等待加载 → 解析结构化结果 → Markdown 表格」（知乎 / GitHub / CSDN / MOOC / 小红书 / 知网 / Bilibili）',
    displayName: '站点搜索',
    category: 'search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['search', 'platform', 'integrated'],
    permissions: ['tabs', 'scripting'],
    // 搜索必然改变页面（导航到结果页）：保持默认（noVisionRecapture 缺省
    // false），视觉会话在工具批次后重拍截图
  };

  openaiSchema = this.buildOpenAISchema('platform_search');
}
