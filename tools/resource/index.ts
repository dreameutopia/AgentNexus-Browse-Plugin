/**
 * 资源工具集合
 * 包含资源嗅探和下载工具
 */

import { toolRegistry } from '../registry';
import { ResourceSnifferTool } from './resource-sniffer-tool';
import { ResourceDownloaderTool } from './resource-downloader-tool';
import { ClearCapturedFilesTool } from './clear_captured_files';
import { GetCapturedFileTool } from './get_captured_file_by_id';
import { StartDownloadInterceptionTool } from './start_download_interception';
import { StopDownloadInterceptionTool } from './stop_download_interception';
import { ListCapturedFilesTool } from './list_captured_files';

// 创建资源工具实例
function createResourceTools() {
  return [
    new ResourceSnifferTool(),
    new ResourceDownloaderTool(),
    new ClearCapturedFilesTool(),
    new GetCapturedFileTool(),
    new StartDownloadInterceptionTool(),
    new StopDownloadInterceptionTool(),
    new ListCapturedFilesTool()
  ];
}

// 注册函数
export function registerResourceTools() {
  const resourceTools = createResourceTools();
  resourceTools.forEach(tool => {
    toolRegistry.register(tool);
  });
}

export {
  ResourceSnifferTool,
  ResourceDownloaderTool,
  ClearCapturedFilesTool,
  GetCapturedFileTool,
  StartDownloadInterceptionTool,
  StopDownloadInterceptionTool,
  ListCapturedFilesTool
};