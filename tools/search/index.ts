/**
 * 搜索工具集合
 *
 * 两个工具、同一执行链路：
 *   - web_search     —— 通用网页检索（engine 枚举：bing / baidu）
 *   - platform_search —— 站点平台检索（platform 枚举：知乎 / GitHub / CSDN /
 *     MOOC / 小红书 / 中国知网 / Bilibili）
 *
 * 目标注册表与解析通道见 ./search-targets.ts，执行链路见 ./search-tool-base.ts。
 */

import { toolRegistry } from '../registry';
import { WebSearchTool } from './web-search-tool';
import { PlatformSearchTool } from './platform-search-tool';

// 注册函数
export function registerSearchTools() {
  toolRegistry.register(new WebSearchTool());
  toolRegistry.register(new PlatformSearchTool());
}

export { WebSearchTool };
export { PlatformSearchTool };
export { BaseSearchTool, type SearchToolSpec } from './search-tool-base';
export {
  SEARCH_TARGETS,
  SEARCH_TARGET_IDS,
  SEARCH_ENGINE_IDS,
  SEARCH_PLATFORM_IDS,
  isSearchTargetId,
  isSearchPlatformId,
  type SearchEngineId,
  type SearchPlatformId,
  type SearchTargetId,
  type SearchTargetConfig,
} from './search-targets';
