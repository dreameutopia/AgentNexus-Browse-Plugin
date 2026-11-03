/**
 * 可交互按钮/链接获取工具（interactive_button_getter）
 * v4.1.0 - 内置 regex / xpath 过滤（命中置顶 + ✓ 标记）、Markdown 分页与稳定缓存
 *
 * 实现分层：
 * - 宿主流程（参数归一 / 标签页检查 / 缓存 / 跨 frame 汇总 / 分页 / 响应）
 *   见 `shared/element-getter-base.ts`（与 interactive_input_getter 共用一份）；
 * - 页面内采集荷载见 `shared/element-scan-payload.ts` 的 buttons 模式
 *   （自包含注入，下载特征识别与按钮描述链为本模式专属）。
 */

import { BaseElementGetterTool } from './shared/element-getter-base';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

export class InteractiveButtonGetterTool extends BaseElementGetterTool {
  name = 'interactive_button_getter';

  protected readonly scanMode = 'buttons' as const;
  protected readonly scanLabel = '可交互按钮/链接 (v4.1)';
  protected readonly elementUnit = '元素';
  protected readonly errorLabel = '可交互按钮';

  metadata: ToolMetadata = {
    name: 'interactive_button_getter',
    description: '获取页面及其所有iframe中的可交互元素（按钮/链接/勾选框/单选钮/提交按钮等）：支持 regex/xpath 过滤（命中置顶并标记）、Markdown 表格分页（每页 40 个）与内存缓存',
    category: 'automation',
    version: '4.1.0',
    author: 'AgentNexus',
    tags: ['automation', 'button', 'link', 'element', 'interaction', 'iframe', 'regex', 'xpath']
  }

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'interactive_button_getter',
      description: '获取页面（含所有 iframe）中的可交互按钮/链接/勾选框/单选钮等可点击元素（下拉选择框请用 interactive_input_getter），结果为 Markdown 表格，每页最多 40 个元素。可选 regex / xpath 过滤：命中全部已启用条件的元素会置顶并在 Hit 列标记 ✓；未命中的元素仍会按优先级排在其后返回（过滤从不返回空表）。相同标签页、相同过滤条件下结果有内存缓存，page 参数可稳定翻页。',
      parameters: {
        type: 'object',
        properties: {
          regex: {
            type: 'string',
            description: '可选，正则过滤：对元素的描述文本、类名及常用属性值（id/name/href/value/data-* 等）做不区分大小写的匹配。优先写宽泛的包含式模式（如 登录|注册、下一页|更多、down|export），避免 ^ $ 锚点、精确全句或超长精确串，否则容易一无所获。与 xpath 同时提供时须同时满足，除非确有必要建议只设一个。'
          },
          xpath: {
            type: 'string',
            description: "可选，XPath 1.0 过滤：元素本身或其任一祖先被选中即算命中（容器级写法可用）。推荐相对路径，如 //button[contains(.,'提交')]、//*[contains(@aria-label,'导出')]、//a[contains(@href,'download')]；避免 /html/body/div[3]/... 绝对路径。与 regex 同时提供时须同时满足。"
          },
          page: {
            type: 'number',
            description: '页码，从 1 开始，默认 1。每页最多 40 个元素；相同过滤条件下结果已缓存，翻页稳定生效。',
            default: 1
          }
        },
        required: []
      }
    }
  };
}

// 导出工具实例
export const interactiveButtonGetterTool = new InteractiveButtonGetterTool();
