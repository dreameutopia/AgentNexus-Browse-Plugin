/**
 * 工具执行相关逻辑 composable
 */
import { ref, reactive } from 'vue';
import type { ToolDefinition, ExecutionResult } from './types';
import { resolveActionDefinition } from './types';
import { extractContentText, primaryChannelOf } from '@/common/tool-handler';

export function useToolExecution() {
  const selectedTool = ref<ToolDefinition | null>(null);
  const toolParams = reactive<Record<string, any>>({});
  const isExecuting = ref(false);
  const executionResult = ref<ExecutionResult | null>(null);

  const selectTool = (tool: ToolDefinition) => {
    selectedTool.value = tool;
    executionResult.value = null;
    clearParams();
  };

  const clearParams = () => {
    Object.keys(toolParams).forEach(key => {
      delete toolParams[key];
    });

    if (selectedTool.value) {
      Object.entries(resolveActionDefinition(selectedTool.value, toolParams.action).parameters).forEach(([name, param]) => {
        if (param.default !== undefined) {
          toolParams[name] = param.default;
        }
      });
    }
  };

  const executeTool = async () => {
    if (!selectedTool.value) return;

    isExecuting.value = true;
    executionResult.value = null;

    try {
      const processedParams: Record<string, any> = {};
      const definition = resolveActionDefinition(selectedTool.value, toolParams.action);

      for (const [name, value] of Object.entries(toolParams)) {
        if (value === undefined || value === null || value === '' && name !== 'text') continue;
        if (!Object.hasOwn(definition.parameters, name)) continue;

        const param = definition.parameters[name];

        if (param && (param.type === 'object' || param.type === 'array')) {
          try {
            processedParams[name] = typeof value === 'string' ? JSON.parse(value) : value;
          } catch (e) {
            console.warn(`无法解析参数 ${name} 的JSON值:`, value);
            processedParams[name] = value;
          }
        } else {
          processedParams[name] = value;
        }
      }

      console.log('执行工具:', selectedTool.value.name);
      console.log('参数:', processedParams);

      const response = await chrome.runtime.sendMessage({
        type: 'CALL_TOOL',
        tool: {
          name: selectedTool.value.name,
          args: processedParams
        }
      });

      console.log('工具响应:', response);
      // 无应答（监听器未注册 / 消息未被处理）时以可读错误呈现，
      // 而不是存入 undefined 让结果区静默变空白
      if (response === undefined || response === null) {
        executionResult.value = {
          isError: true,
          content: [{
            type: 'text',
            text: '后台无响应（消息未被处理）：请检查扩展后台是否就绪后重试'
          }]
        };
      } else {
        executionResult.value = response;
      }
    } catch (error: any) {
      console.error('执行错误:', error);
      executionResult.value = {
        isError: true,
        content: [{
          type: 'text',
          text: `执行错误: ${error.message || String(error)}`
        }]
      };
    } finally {
      isExecuting.value = false;
    }
  };

  const formatResult = (result: ExecutionResult | null): string => {
    if (!result) return '';

    /** content 文本块拼成的正文（图片等非文本块单独标注） */
    const contentText = (): string => {
      const text = extractContentText(result.content);
      if (text) return text;
      if (!result.content) return '';
      if (Array.isArray(result.content)) {
        return result.content.map(item => {
          if (item.type === 'image') return `[图片: ${item.source?.type || 'unknown'}]`;
          return JSON.stringify(item, null, 2);
        }).join('\n\n');
      }
      return JSON.stringify(result.content, null, 2);
    };
    /** 结构化载荷的 pretty JSON（循环引用等异常形态降级为字符串快照） */
    const dataText = (): string => {
      if (!result.data || typeof result.data !== 'object') return '';
      try {
        return JSON.stringify(result.data, null, 2);
      } catch {
        return String(result.data);
      }
    };

    // 正文在 content（结果表 / 清单正文 / 页文本）：先给正文，再附事实元数据
    if (primaryChannelOf(result) === 'content') {
      const body = contentText();
      const meta = dataText();
      if (!meta) return body;
      return `${body}\n\n--- 结构化载荷 ---\n${meta}`;
    }

    // 正题在 data：展示完整结构化载荷
    const structured = dataText();
    if (structured) return structured;

    // 退化路径：只有 content
    const body = contentText();
    if (body) return body;

    return JSON.stringify(result, null, 2);
  };

  const copyResult = () => {
    if (!executionResult.value) return;

    const text = formatResult(executionResult.value);
    navigator.clipboard.writeText(text).then(() => {
      alert('结果已复制到剪贴板');
    }).catch(err => {
      console.error('复制失败:', err);
      alert('复制失败');
    });
  };

  return {
    selectedTool,
    toolParams,
    isExecuting,
    executionResult,
    selectTool,
    clearParams,
    executeTool,
    formatResult,
    copyResult
  };
}
