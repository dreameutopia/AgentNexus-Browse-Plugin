/**
 * 笔记工具模块
 *
 * v4.0 起整合为单一 note_tool（action 区分 create/append/update/get/list/delete），
 * 原五件套（create_note / append_note / update_note / get_note_content / delete_note）
 * 已移除——统一工具的 schema 与工作流约定见 note-tool.ts 文件头。
 */

import { toolRegistry } from '../registry';
import { BaseNoteTool } from './base-note-tool';
import { NoteTool, noteTool } from './note-tool';

/**
 * 注册笔记统一工具
 */
export function registerNoteTools() {
  toolRegistry.register(noteTool);
}

// 导出（BaseNoteTool 供后续新增笔记类工具复用公共契约）
export { BaseNoteTool, NoteTool, noteTool };
