import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata, type ToolExecutionContext } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { normalizeWaitSeconds } from './wait-contract';

export class GenericWaitTool extends BaseTool {
  name = 'generic_wait';
  
  metadata: ToolMetadata = {
    name: 'generic_wait',
    description: '可中止的通用等待，单位秒；超过 600 秒自动按 600 秒执行，等待不代表页面业务完成',
    category: 'common',
    version: '2.0.0',
    author: 'Chrome Extension',
    tags: ['utility', 'wait', 'delay']
  };
  
  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'generic_wait',
      description: '等待指定秒数，可随用户停止立即取消。最大 600 秒（10 分钟），超过自动截为 600 秒。仅等待时间，不保证加载或业务完成；结束后重新观察页面。视觉循环会另等 3 秒再拍新图。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          waitSeconds: {
            type: 'number',
            description: '等待秒数（可为小数），超过 600 自动按 600 执行',
            minimum: 0
          }
        },
        required: ['waitSeconds']
      }
    }
  };

  async execute(params: { waitSeconds: number }, context?: ToolExecutionContext): Promise<ToolResult> {
    try {
      if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => key !== 'waitSeconds'))
        throw new Error('等待参数仅接受 waitSeconds');
      const seconds = normalizeWaitSeconds(params.waitSeconds), started = Date.now(), signal = context?.signal;
      const completed = await new Promise<boolean>(resolve => {
        // 保持 let：signal 已 aborted 时 finish(false) 会在 timer 初始化之前执行，
        // 改为 const 会触发 TDZ（finish 闭包读取 timer 时它尚未初始化）。
        // eslint-disable-next-line prefer-const
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (ok: boolean) => { if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener('abort', cancel); resolve(ok); };
        const cancel = () => finish(false);
        if (signal?.aborted) { finish(false); return; }
        signal?.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(() => finish(true), seconds * 1000);
      });
      const data = { requestedSeconds: params.waitSeconds, waitSeconds: seconds, capped: seconds !== params.waitSeconds, elapsedMs: Date.now() - started };
      if (!completed) return { success: false, error: '等待已取消', data };
      return this.createSuccessResponse(data, `已等待 ${seconds} 秒${data.capped ? '（请求超过 10 分钟，已自动限制）' : ''}；请重新观察页面结果`);
    } catch (error) { return this.createErrorResponse(error instanceof Error ? error.message : String(error)); }
  }
}

export const genericWaitTool = new GenericWaitTool();
