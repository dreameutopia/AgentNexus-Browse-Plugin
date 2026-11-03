import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { isRestrictedUrl } from '@/common/constants';
import { enhanceActionPayload, type EnhancePayloadResult } from './enhance-action-payload';

/**
 * 定义 execute 方法所需的参数类型
 */
interface FillParams {
  selector: string;
  value: string;
  frameId?: number; // frameId 缺省时按主页面（0）处理；显式提供必须是非负整数
}

/**
 * 增强版填充工具 (Enhance Fill Tool)
 * - 完全 iframe 感知（frameIds 精确定向）
 * - 点击/填充的页面内逻辑共用 `enhance-action-payload.ts`（自包含注入荷载）：
 *   渲染检查 → 屏幕外先滚动到视口中央 → 遮挡检查 → 按 contenteditable / select /
 *   input|textarea 分路填充（execCommand 失败时回退直写并补发 input 事件）
 * - 受限页面（chrome:// 等）提前拦截并给出可操作提示，而非注入失败后的模糊报错
 */
export class EnhanceFillTool extends BaseTool {
  name = 'enhance_fill';
  
  metadata: ToolMetadata = {
    name: 'enhance_fill',
    description: '向指定的页面元素（包括iframe内部的）填充内容。',
    category: 'automation',
    version: '1.1.0',
    author: 'Gemini',
    tags: ['automation', 'fill', 'input', 'iframe', 'enhanced']
  }

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'enhance_fill',
      description: '向指定的页面元素（包括iframe内部的）填充内容。必须提供frameId。',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: '目标元素的CSS选择器。',
          },
          value: {
            type: 'string',
            description: '要填充到元素中的文本值。',
          },
          frameId: {
            type: 'number',
            description: '目标元素所在的iframe的ID。主页面ID为0。',
          }
        },
        required: ['selector', 'value', 'frameId']
      }
    }
  };

  async execute(params: FillParams): Promise<ToolResult> {
    // 参数可能整体缺失（executeTool 对 undefined/null 直接透传），必须可选链防御
    const selector = params?.selector;
    const value = params?.value;
    const frameId = params?.frameId;

    // 验证核心参数（value 允许空字符串——清空输入是合法操作）
    if (typeof selector !== 'string' || !selector.trim()) {
      return this.createErrorResponse('Missing required parameter: selector.');
    }
    if (value === undefined || value === null) {
      return this.createErrorResponse('Missing required parameter: value.');
    }
    // 非字符串值（模型偶尔给出数字/布尔）按 JS 赋值语义归一为字符串，
    // 与注入后 element.value = value 的隐式转换完全一致，提前归一便于日志与排错
    const fillText = typeof value === 'string' ? value : String(value);

    // frameId 缺省按主页面 0；显式提供必须是非负整数（防脏值直达 chrome API）
    let targetFrame = 0;
    if (frameId !== undefined && frameId !== null) {
      if (!Number.isInteger(frameId) || frameId < 0) {
        return this.createErrorResponse(
          `参数 frameId 必须是非负整数（主页面为 0），实际收到 ${JSON.stringify(frameId)}`
        );
      }
      targetFrame = frameId;
    }

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (typeof tabId !== 'number') {
        return this.createErrorResponse('No active tab found.');
      }

      // 受限页面无法注入脚本：提前给出与工具链一致口径的可读提示
      const pageUrl = tabs[0].url || '';
      if (isRestrictedUrl(pageUrl)) {
        return this.createErrorResponse(
          `当前页面为受限地址（${pageUrl || '无 URL'}），扩展无法在此注入脚本执行填充。请先导航到普通网页。`
        );
      }

      this.log(`Executing fill on Tab ${tabId}, Frame ${targetFrame}, Selector: "${selector}"`);

      // 使用 frameId 精确地定位注入目标；荷载函数必须直接传模块函数引用
      //（bind/箭头包装会在序列化后引用注入上下文不存在的外部标识符）
      const injectionResults = await chrome.scripting.executeScript({
        target: {
            tabId,
            frameIds: [targetFrame] // 指定要注入的 frame
        },
        func: enhanceActionPayload,
        args: ['fill', selector, fillText],
      });

      // executeScript 返回空数组 = 目标 frame 不在当前标签页（已被移除/从未存在）
      if (!injectionResults || injectionResults.length === 0) {
        return this.createErrorResponse(
          `目标 frame（frameId=${targetFrame}）在当前标签页中不存在或已卸载——请用 interactive_input_getter / interactive_button_getter 重新获取 FrameId 后重试`
        );
      }

      // executeScript 返回一个数组，我们取第一个（也是唯一一个）结果
      const result: EnhancePayloadResult | undefined = injectionResults[0]?.result;

      if (!result) {
        this.log(`Fill script in frame ${targetFrame} returned no result.`, 'error');
        return this.createErrorResponse(
          `Fill script returned no result（frame ${targetFrame} 可能在注入瞬间被卸载或页面正在跳转）——请重试，仍失败则重新采集元素`
        );
      }

      if (result.error) {
        this.log(`Fill operation failed in frame ${targetFrame}: ${result.error}`, 'error');
        return this.createErrorResponse(result.error);
      }

      this.log(`Fill operation successful in frame ${targetFrame}.`);
      return this.createSuccessResponse(result, result.message);

    } catch (error) {
      // 捕获注入过程本身可能发生的错误
      this.log('Failed to execute fill script.', 'error');
      return this.createErrorResponse('Failed to execute the fill script. The frame might have been detached.', error);
    }
  }
}

// 导出工具的单例
export const enhanceFillTool = new EnhanceFillTool();
