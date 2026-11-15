/**
 * 工作区文件工具模块
 *
 * file_util：会话工作区的通用文件读写入口（读取 / 创建 / 追加 / 编辑 / 删除），
 * 配套固定注入契约（FILE_UTIL_TOOL_ID / FILE_UTIL_SYSTEM_PROMPT_SECTION，
 * 见 file-util-prompt.ts）由 runtime-builder 无条件并入所有会话。
 *
 * 与 upload-file 模块（read_file）的关系：read_file 已随会话文件库一并下线——
 * 上传文件不再被解析成第二份副本，正文一律从工作区 inputs/ 下的原始文件读取。
 */

import { toolRegistry } from '../registry';
import { FileUtilTool, fileUtilTool } from './file-util-tool';

/** 注册工作区文件工具 */
export function registerFileUtilTools() {
  toolRegistry.register(fileUtilTool);
}

// 导出（FileUtilTool 类型供测试/扩展复用）
export { FileUtilTool, fileUtilTool, FILE_UTIL_READ_PAGE_CHARS } from './file-util-tool';
export { FILE_UTIL_TOOL_ID, FILE_UTIL_SYSTEM_PROMPT_SECTION } from './file-util-prompt';
