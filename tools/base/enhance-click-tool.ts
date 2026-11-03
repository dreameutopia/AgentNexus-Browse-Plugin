import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { isRestrictedUrl } from '@/common/constants';
import { enhanceActionPayload, type EnhancePayloadResult } from './enhance-action-payload';

/**
 * 定义 execute 方法所需的参数类型
 */
interface ClickParams {
  selector: string;
  frameId?: number; // frameId 缺省时按主页面（0）处理；显式提供必须是非负整数
}

/**
 * 增强版点击工具 (Enhance Click Tool)
 * - 完全 iframe 感知（frameIds 精确定向）
 * - 点击/填充的页面内逻辑共用 `enhance-action-payload.ts`（自包含注入荷载）：
 *   渲染检查 → 屏幕外先滚动到视口中央 → 遮挡检查 → 派发真实鼠标事件序列
 * - 受限页面（chrome:// 等）提前拦截并给出可操作提示，而非注入失败后的模糊报错
 */
export class EnhanceClickTool extends BaseTool {
  name = 'enhance_click';
  
  metadata: ToolMetadata = {
    name: 'enhance_click',
    description: '点击指定的页面元素（包括iframe内部的）。',
    category: 'automation',
    version: '1.2.0',
    author: 'Gemini',
    tags: ['automation', 'click', 'interaction', 'iframe', 'enhanced'],
    // 参数语义级人审门：confirm=true 或 selector/description 命中破坏性关键词时
    // 经会话引擎的 onToolApproval 请求用户放行（缺省拒绝，安全侧）
    requiresConfirm: true,
  }

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'enhance_click',
      description:
        '点击指定的页面元素（包括iframe内部的）。必须提供frameId。' +
        '⚠️ 不可逆操作（发送 / 提交 / 发布 / 投递 / 购买 / 下单 / 支付 / 删除等）必须传 confirm=true——' +
        '系统会停下来等用户批准后再执行；可逆操作（打开、切换、展开、关闭弹窗等）不要传，否则会无谓打断流程。',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: '目标元素的CSS选择器。',
          },
          frameId: {
            type: 'number',
            description: '目标元素所在的iframe的ID。主页面ID为0。',
          },
          description: {
            type: 'string',
            description:
              '可选：本次点击的目标与意图（如"点击发送消息按钮"）。用于安全审核与操作日志，建议填写。',
          },
          confirm: {
            type: 'boolean',
            description:
              '是否为不可逆操作（发送/提交/发布/投递/购买/下单/支付/删除等）。为 true 时执行前需用户批准；可逆操作省略或传 false。',
            default: false,
          },
        },
        required: ['selector', 'frameId'],
      },
    },
  };

  async execute(params: ClickParams): Promise<ToolResult> {
    // 参数可能整体缺失（executeTool 对 undefined/null 直接透传），必须可选链防御
    const selector = params?.selector;
    const frameId = params?.frameId;

    if (typeof selector !== 'string' || !selector.trim()) {
      return this.createErrorResponse('Missing required parameter: selector.');
    }
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
          `当前页面为受限地址（${pageUrl || '无 URL'}），扩展无法在此注入脚本执行点击。请先导航到普通网页。`
        );
      }

      this.log(`Executing click on Tab ${tabId}, Frame ${targetFrame}, Selector: "${selector}"`);

      // 使用 frameId 精确地定位注入目标；荷载函数必须直接传模块函数引用
      //（bind/箭头包装会在序列化后引用注入上下文不存在的外部标识符）
      const injectionResults = await chrome.scripting.executeScript({
        target: {
            tabId,
            frameIds: [targetFrame] // 指定要注入的 frame
        },
        func: enhanceActionPayload,
        args: ['click', selector],
      });

      // executeScript 返回空数组 = 目标 frame 不在当前标签页（已被移除/从未存在）
      if (!injectionResults || injectionResults.length === 0) {
        return this.createErrorResponse(
          `目标 frame（frameId=${targetFrame}）在当前标签页中不存在或已卸载——请用 interactive_input_getter / interactive_button_getter 重新获取 FrameId 后重试`
        );
      }

      const result: EnhancePayloadResult | undefined = injectionResults[0]?.result;

      if (!result) {
        this.log(`Click script in frame ${targetFrame} returned no result.`, 'error');
        return this.createErrorResponse(
          `Click script returned no result（frame ${targetFrame} 可能在注入瞬间被卸载或页面正在跳转）——请重试，仍失败则重新采集元素`
        );
      }

      if (result.error) {
        this.log(`Click operation failed in frame ${targetFrame}: ${result.error}`, 'error');
        return this.createErrorResponse(result.error);
      }

      this.log(`Click operation successful in frame ${targetFrame}.`);
      return this.createSuccessResponse(result, result.message);

    } catch (error) {
      this.log('Failed to execute click script.', 'error');
      return this.createErrorResponse('Failed to execute the click script. The frame might have been detached or the selector is invalid.', error);
    }
  }
}

// 导出工具的单例
export const enhanceClickTool = new EnhanceClickTool();
