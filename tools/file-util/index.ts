/**
 * 工作区文件工具模块
 *
 * file_util：会话工作区唯一文件入口（read / create / append / edit / delete /
 * copy / list / search / grep），配套固定注入契约（FILE_UTIL_TOOL_ID /
 * FILE_UTIL_SYSTEM_PROMPT_SECTION，见 file-util-prompt.ts）由 runtime-builder
 * 无条件并入所有会话。
 *
 * 其他工具（js_run / python_run / document_tool / read_website / data_ref_tool /
 * browser_extract_data）不再各自实现文本文件 CRUD，只保留其执行/产出职责；
 * 产出的结果文件统一由 file_util 读取与盘点。
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
