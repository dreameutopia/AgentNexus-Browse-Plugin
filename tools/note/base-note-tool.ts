/**
 * 笔记工具基类
 *
 * 五个笔记工具（create/append/get/update/delete）共用的公共契约：
 *
 * 1. 结果形状统一：
 *    - 成功：noteToolSuccess（success/isError/content/data 四字段一致）；
 *    - 失败：noteToolFailure，错误文本固定为「错误类型 + 原因 + 处置建议」
 *      三段结构，保证模型端与日志端都能直接分析定位（而非一句模糊的失败提示）。
 *
 * 2. 错误分类（与 utils/notes-database 的错误类型一一对应）：
 *    - NotesParamError   → 参数错误（模型传参问题，提示检查字段）
 *    - NotesDatabaseError → 存储错误（携带 operation/hint，提示存储层排查）
 *    - 其它               → 未知错误（保留原始 message）
 *
 * 3. 参数防御：asArgs 把任意 execute 入参收敛为对象，null/数组/字符串等
 *    非对象输入统一转成可读参数错误，绝不让 TypeError 淹没真实原因。
 */

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import {
  NotesParamError,
  NotesDatabaseError,
  broadcastNotesChanged,
  type NotesChangeAction,
} from '@/utils/notes-database';

/** 错误分类的可读标签 */
const ERROR_KIND_PARAM = '参数错误';
const ERROR_KIND_STORAGE = '存储错误';
const ERROR_KIND_NOT_FOUND = '目标不存在';
const ERROR_KIND_UNKNOWN = '未知错误';

/** 成功结果：content 与 data 双通道（content 给模型阅读，data 给程序消费） */
export function noteToolSuccess(text: string, data: Record<string, unknown>): ToolResult {
  return {
    success: true,
    isError: false,
    content: [{ type: 'text', text }],
    data,
  };
}

/** 失败结果：错误类型 + 原因 + 处置建议的结构化文本 */
export function noteToolFailure(
  toolName: string,
  operation: string,
  kind: string,
  reason: string,
  hint?: string,
): ToolResult {
  const text =
    `[${toolName}] ${operation}失败\n` +
    `错误类型: ${kind}\n` +
    `原因: ${reason}` +
    (hint ? `\n处置建议: ${hint}` : '');

  return {
    success: false,
    isError: true,
    error: text,
    content: [{ type: 'text', text }],
    data: { errorKind: kind, operation },
  };
}

/** 把任意异常映射为结构化失败结果（参数错误 / 存储错误 / 未知错误） */
export function noteToolFailureFromError(
  toolName: string,
  operation: string,
  error: unknown,
): ToolResult {
  if (error instanceof NotesParamError) {
    return noteToolFailure(
      toolName,
      operation,
      ERROR_KIND_PARAM,
      error.message,
      '请修正参数后重试：ID 类参数应为 create_note 返回的 Note ID',
    );
  }
  if (error instanceof NotesDatabaseError) {
    return noteToolFailure(
      toolName,
      operation,
      ERROR_KIND_STORAGE,
      `${error.message}（失败操作: ${error.operation}）`,
      error.hint ??
        '请检查浏览器存储是否可用（隐私模式/磁盘配额），或重装扩展后重试',
    );
  }
  const reason = error instanceof Error ? error.message : String(error);
  return noteToolFailure(toolName, operation, ERROR_KIND_UNKNOWN, reason);
}

/** 目标笔记不存在（先于异常产生，给出比存储错误更精确的指引） */
export function noteNotFound(toolName: string, operation: string, noteId: string): ToolResult {
  return noteToolFailure(
    toolName,
    operation,
    ERROR_KIND_NOT_FOUND,
    `找不到ID为 ${noteId} 的笔记`,
    '请先用 create_note 创建笔记并记录其 Note ID，或检查 ID 是否抄写完整',
  );
}

export abstract class BaseNoteTool extends BaseTool {
  /** 变更广播（写操作成功后调用；广播失败不影响主流程） */
  protected notifyChange(action: NotesChangeAction, noteId: string): void {
    broadcastNotesChanged(action, noteId);
  }

  /** 统一带时间戳的操作日志 */
  protected logStep(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.log(`[${new Date().toISOString()}] ${message}`, level);
  }

  /**
   * 入参防御：execute 可能收到 null/数组/字符串等任意形态（模型输出不可信），
   * 统一收敛为对象；非法形态抛 NotesParamError 走结构化错误通道。
   */
  protected asArgs(raw: unknown): Record<string, unknown> {
    if (raw === null || raw === undefined) return {};
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    throw new NotesParamError(
      'arguments',
      `必须为 JSON 对象，实际收到: ${Array.isArray(raw) ? 'array' : typeof raw}`,
    );
  }
}
