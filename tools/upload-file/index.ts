/**
 * 上传文件工具模块
 *
 * read_file：会话上传文件的分页读取（全文持久化于会话文件库），
 * 配套固定注入契约（READ_FILE_TOOL_ID / UPLOAD_FILE_SYSTEM_PROMPT_SECTION，
 * 见 upload-file-prompt.ts）由 runtime-builder 无条件并入所有会话。
 */

import { toolRegistry } from '../registry';
import { ReadFileTool, readFileTool } from './read-file-tool';

/** 注册上传文件读取工具 */
export function registerUploadFileTools() {
  toolRegistry.register(readFileTool);
}

// 导出（ReadFileTool 类型供测试/扩展复用）
export { ReadFileTool, readFileTool };
export { READ_FILE_TOOL_ID, UPLOAD_FILE_SYSTEM_PROMPT_SECTION } from './upload-file-prompt';
