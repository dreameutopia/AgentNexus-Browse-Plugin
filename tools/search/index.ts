/**
 * 搜索工具集合
 *
 * 原 9 个平台专属 *_search（纯导航）已与结果抓取、集成搜索合并为统一的
 * web_search（website 枚举区分平台，集成语义：导航 + 解析一步完成）。
 * 平台清单与解析通道见 ./search-platforms.ts。
 */

import { toolRegistry } from '../registry';
import { WebSearchTool } from './web-search-tool';

// 注册函数
export function registerSearchTools() {
  toolRegistry.register(new WebSearchTool());
}

export { WebSearchTool };
export {
  SEARCH_PLATFORMS,
  SEARCH_PLATFORM_IDS,
  isSearchPlatformId,
  formatSupportedPlatforms,
  type SearchPlatformId,
  type SearchPlatformConfig,
} from './search-platforms';
