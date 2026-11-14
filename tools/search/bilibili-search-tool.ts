/**
 * Bilibili 站内视频检索工具（bilibili_search）
 *
 * B 站检索是**特定智能体的专属动作**（Bilibili 搜索助手），不是通用站点
 * 检索能力的一部分——因此它从 platform_search 的平台枚举里独立出来，
 * 自成一个工具：
 *   - platform_search 的职责是「通用站点内检索」（知乎 / GitHub / CSDN /
 *     MOOC / 小红书 / 知网），枚举里不再有 Bilibili；
 *   - bilibili_search 的职责是「B 站视频检索」，目标固定，schema 里没有
 *     目标参数——模型只需给关键词。
 *
 * 执行链路（导航 → 等待 → 解析 → Markdown 表）与其它搜索工具完全同构，
 * 由 BaseSearchTool 统一承载（见 search-tool-base.ts）；目标配置（URL 模板
 * 与 scraper 配对）仍登记在共享注册表 search-targets.ts 的专属目标类别里，
 * 不在此处复制。
 *
 * 执行上下文：sidepanel 与 background（service worker）均可运行。
 */

import { ToolMetadata } from '../registry';
import { BaseSearchTool, type SearchToolSpec } from './search-tool-base';

/** 本工具的固定目标（B 站）；注册表里的专属目标 id */
const BILIBILI_TARGET_ID = 'bilibili' as const;

export class BilibiliSearchTool extends BaseSearchTool {
  name = 'bilibili_search';

  /**
   * 差异面：目标固定（B 站），schema 不含目标参数。
   * targets 只登记本工具自己的目标——不展开专属目标清单，
   * 避免将来新增专属平台时本工具的集合被顺带撑大。
   */
  protected readonly spec: SearchToolSpec = {
    targets: [BILIBILI_TARGET_ID],
    fixedTarget: BILIBILI_TARGET_ID,
    paramName: 'platform',
    paramLabel: '站点平台',
    targetKindLabel: '站点平台',
  };

  /** 工具描述主体（能力边界 + 并发禁令 + 结果契约 + 下游衔接） */
  protected readonly usageDescription =
    'Bilibili 站内视频检索：一次调用完成「导航到 Bilibili 搜索结果页 → 等待加载 → 解析视频条目 → Markdown 表格」。' +
    'query 为精炼关键词；结果表逐条给出视频标题、链接与摘要。' +
    '⚠ 本工具自带页面导航（效果等同 browser_navigation(action="open") 打开搜索结果页）：会真实打开或跳转标签页并改变当前活动页面，' +
    '因此【禁止在同一轮里并发调用本工具】——换关键词时逐个串行调用，连续多轮可传 newTab=false 复用标签页。' +
    'B 站结果为动态渲染，偶发解析不全时可调大 waitTime（上限 10000 毫秒）等待渲染完成。' +
    '本工具只负责「搜到视频」：拿到条目后用 browser_navigation(action="open") 打开选中的视频页，' +
    '再用 bilibili_subtitle_tool 提取字幕；results 解析失败时页面已就位，可用 browser_get_page_text 读取当前页自行提取。';

  metadata: ToolMetadata = {
    name: 'bilibili_search',
    description:
      'Bilibili 站内视频检索：一次调用完成「导航到 B 站搜索结果页 → 等待加载 → 解析视频条目 → Markdown 表格」',
    displayName: 'B站搜索',
    category: 'search',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['search', 'bilibili', 'video'],
    permissions: ['tabs', 'scripting'],
    // 搜索必然改变页面（导航到结果页）：保持默认（noVisionRecapture 缺省
    // false），视觉会话在工具批次后重拍截图
  };

  openaiSchema = this.buildOpenAISchema('bilibili_search');
}
