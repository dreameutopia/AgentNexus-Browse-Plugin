/**
 * OpenAI Responses 协议适配器
 *
 * 适用于 OpenAI Responses API（/v1/responses），与 Chat Completions 并存的新一代端点。
 *
 * 与 Chat Completions 的差异（依据 openai@5 官方类型定义 responses.d.ts）：
 *   - 端点: POST {base}/responses
 *   - 请求: input 为「消息 / function_call / function_call_output」等 item 数组
 *           文本消息可用 EasyInputMessage { role, content: string }
 *           图片用 { type: 'input_image', image_url, detail }（原生支持远程 URL 与 data URL）
 *   - 工具: { type: 'function', name, parameters, strict }（name 在顶层，不嵌 function）
 *   - 工具回传: 助手轮回放 { type:'function_call', call_id, name, arguments }
 *               结果回传 { type:'function_call_output', call_id, output }
 *   - 上限: max_output_tokens（非 max_tokens），需显式 stream: true
 *   - SSE: 事件流 event/response.* （无 [DONE] 哨兵，以 response.completed 结束）
 *     关键事件:
 *       response.output_text.delta          { delta }                → 正文
 *       response.reasoning_summary_text.delta { delta }              → 推理（o 系列）
 *       response.output_item.added          { item, output_index }   → 函数调用开始
 *       response.function_call_arguments.delta { delta, output_index } → 参数增量
 *       response.function_call_arguments.done  { arguments, output_index } → 参数终值
 *       response.output_item.done           { item, output_index }   → 函数调用完成
 *       response.completed / response.incomplete { response }        → 结束
 *       response.failed / error             { ... }                  → 抛错
 *
 * 关键点：统一工具调用的 id 必须使用 call_id（function_call_output 需要它来配对）。
 */

import { BaseAdapter, type StreamAccumulator } from './base-adapter';
import { createInBandError } from '../errors';
import { mergeUsageSafe, normalizeResponsesUsage } from './usage-normalize';
import type {
  AdapterCapabilities,
  ProviderType,
  StreamRequestConfig,
  StreamCallbacks,
} from '../types';

export class ResponsesAdapter extends BaseAdapter {
  readonly providerType: ProviderType = 'openai-responses';

  /** 能力：图片（远程 URL / data URL 原生支持）、工具、推理流（reasoning summary） */
  readonly capabilities: AdapterCapabilities = {
    vision: true,
    remoteImageUrl: 'native',
    tools: true,
    reasoning: true,
  };

  /**
   * Responses 请求体
   */
  buildRequestBody(config: StreamRequestConfig): any {
    const input: any[] = [];

    for (const msg of config.messages) {
      // ---------- 工具结果：function_call_output ----------
      if (msg.role === 'tool') {
        let output: string;
        try {
          output = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        } catch {
          output = String(msg.content);
        }
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id || '',
          output,
        });
        continue;
      }

      // ---------- 助手消息：文本 + 回放 function_call ----------
      if (msg.role === 'assistant') {
        const text = typeof msg.content === 'string' ? msg.content : this.extractText(msg.content);
        if (text) {
          // 文本用 EasyInputMessage（content 为字符串，避免 part 类型歧义）
          this.pushTextItem(input, 'assistant', text);
        }
        for (const tc of msg.tool_calls || []) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments || '{}',
          });
        }
        continue;
      }

      // ---------- system / user：纯文本或含图 ----------
      if (typeof msg.content === 'string') {
        this.pushTextItem(input, msg.role, msg.content);
        continue;
      }

      if (Array.isArray(msg.content)) {
        const parts: any[] = [];
        for (const item of msg.content) {
          if (item.type === 'text' && item.text) {
            parts.push({ type: 'input_text', text: item.text });
          } else if (item.type === 'image_url' && item.image_url?.url) {
            parts.push({
              type: 'input_image',
              image_url: item.image_url.url,
              detail: item.image_url.detail || 'auto',
            });
          }
        }
        input.push({ type: 'message', role: msg.role, content: parts });
        continue;
      }

      input.push({ role: msg.role, content: '' });
    }

    const body: any = {
      model: config.model,
      input,
      stream: true,
      // 无状态调用：每轮都带上完整历史，不在服务端留存
      store: false,
    };

    if (config.temperature !== undefined) body.temperature = config.temperature;
    if (config.promptCacheKey) body.prompt_cache_key = config.promptCacheKey;
    if (config.top_p !== undefined) body.top_p = config.top_p;
    if (config.max_tokens !== undefined) body.max_output_tokens = config.max_tokens;

    // 工具定义 — Responses 格式：name 在顶层
    if (config.tools && config.tools.length > 0) {
      body.tools = config.tools.map(tool => ({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: false,
      }));
    }

    // tool_choice 统一格式 → Responses 格式
    if (config.tool_choice !== undefined) {
      if (config.tool_choice === 'auto' || config.tool_choice === 'none') {
        body.tool_choice = config.tool_choice;
      } else if (config.tool_choice && typeof config.tool_choice === 'object') {
        const fn = (config.tool_choice as any).function;
        if (fn?.name) {
          body.tool_choice = { type: 'function', name: fn.name };
        }
      }
    }

    return body;
  }

  /** 提取 content 数组中的纯文本 */
  private extractText(content: any): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((item: any) => item?.type === 'text' && item.text)
      .map((item: any) => item.text)
      .join('');
  }

  /**
   * 追加纯文本 input 消息；与上一条同角色纯文本消息合并。
   * Responses 的 input 是扁平 item 列表，连续同角色文本消息合并为一条，
   * 保证「主系统提示 + 压缩摘要记忆」等多个 system 消息的语义不丢且形态规范。
   */
  private pushTextItem(input: any[], role: string, text: string): void {
    if (!text) return;
    const last = input[input.length - 1];
    if (last && last.role === role && typeof last.content === 'string' && !last.type) {
      last.content = `${last.content}\n\n${text}`;
      return;
    }
    input.push({ role, content: text });
  }

  /**
   * Responses 端点
   * https://api.openai.com/v1/responses
   */
  getRequestUrl(baseUrl: string): string {
    const base = baseUrl.replace(/\/+$/, '');
    if (base.endsWith('/responses')) return base;
    return `${base}/responses`;
  }

  /** Bearer Token（与 Chat Completions 一致） */
  getRequestHeaders(
    apiKey?: string,
    customHeaders?: Record<string, string>
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    if (customHeaders) {
      Object.assign(headers, customHeaders);
    }
    return headers;
  }

  /**
   * 解析 Responses SSE 单行（事件类型见文件头注释）
   */
  protected parseSSELine(
    line: string,
    acc: StreamAccumulator,
    callbacks: StreamCallbacks
  ): boolean {
    const data = this.extractSSEData(line);
    if (data === null) return false;

    let event: any;
    try {
      event = JSON.parse(data);
    } catch (parseError) {
      // 单行损坏容错跳过并留痕（全部行都坏 → 终态校验兜底成协议错误）
      this.recordParseFailure(acc, line);
      console.warn('[ResponsesAdapter] Failed to parse SSE chunk:', parseError, 'Line:', line.trim());
      return false;
    }

    switch (event.type) {
      // ---------- 正文 ----------
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        if (event.delta) this.handleContentToken(event.delta, acc, callbacks);
        break;

      // ---------- 推理（o 系列 reasoning summary） ----------
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (event.delta) this.handleReasoningToken(event.delta, acc, callbacks);
        break;

      // ---------- 工具调用开始 ----------
      case 'response.output_item.added': {
        const item = event.item;
        if (item?.type === 'function_call') {
          const index: number = event.output_index ?? acc.toolCallChunks.size;
          acc.toolCallChunks.set(index, {
            // call_id 是与 function_call_output 配对的关键
            id: item.call_id || item.id || `call_${index}`,
            name: item.name || '',
            arguments: '',
          });
        }
        break;
      }

      // ---------- 工具参数增量 ----------
      case 'response.function_call_arguments.delta': {
        const index: number = event.output_index ?? 0;
        const chunk = acc.toolCallChunks.get(index);
        if (chunk && typeof event.delta === 'string') {
          chunk.arguments += event.delta;
        }
        break;
      }

      // ---------- 工具参数终值（权威，覆盖增量） ----------
      case 'response.function_call_arguments.done': {
        const index: number = event.output_index ?? 0;
        const chunk = acc.toolCallChunks.get(index);
        if (chunk && typeof event.arguments === 'string') {
          chunk.arguments = event.arguments;
        }
        break;
      }

      // ---------- 工具调用完成 ----------
      case 'response.output_item.done': {
        const item = event.item;
        if (item?.type === 'function_call') {
          const index: number = event.output_index ?? 0;
          const existing = acc.toolCallChunks.get(index);
          acc.toolCallChunks.set(index, {
            id: item.call_id || item.id || existing?.id || `call_${index}`,
            name: item.name || existing?.name || '',
            arguments:
              typeof item.arguments === 'string' ? item.arguments : existing?.arguments || '',
          });
        }
        break;
      }

      // ---------- 结束（Responses 无 [DONE] 哨兵，以 completed/incomplete 收尾） ----------
      case 'response.completed':
      case 'response.incomplete': {
        // token 消耗：completed 事件的 response.usage 为完整终值
        //（input/output/total + cached_tokens + reasoning_tokens）
        if (event.response?.usage) {
          acc.usage = mergeUsageSafe(acc.usage, normalizeResponsesUsage(event.response.usage));
        }
        if (acc.toolCallChunks.size > 0) {
          acc.finishReason = 'tool_calls';
        } else {
          const response = event.response;
          const reason = response?.incomplete_details?.reason;
          if (reason === 'max_output_tokens') acc.finishReason = 'length';
          else if (reason === 'content_filter') acc.finishReason = 'content_filter';
          else acc.finishReason = 'stop';
        }
        return true;
      }

      // ---------- 失败 ----------
      case 'response.failed': {
        throw createInBandError({
          prefix: 'Responses API error',
          message: event.response?.error?.message,
          rawEvent: event.response || event,
          provider: this.providerType,
        });
      }

      case 'error': {
        throw createInBandError({
          prefix: 'Responses API error',
          message: event.message ?? event.error?.message,
          rawEvent: event,
          provider: this.providerType,
        });
      }

      // response.created / in_progress / content_part.* / output_text.done 等：忽略
      default:
        break;
    }

    return false;
  }
}
