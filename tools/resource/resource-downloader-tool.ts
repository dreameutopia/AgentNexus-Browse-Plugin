/**
 * 资源下载工具
 * 读取资源嗅探工具的缓存数据，根据ID找到对应下载链接进行自动保存到本地
 */

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../index';
import { OpenAITool } from '@/common/openai-types';
import { ResourceSnifferTool } from './resource-sniffer-tool';
import { toolRegistry } from '../registry';

export class ResourceDownloaderTool extends BaseTool {
  name = 'resource_downloader';
  
  metadata: ToolMetadata = {
    name: 'resource_downloader',
    description: '根据资源ID从缓存中获取下载链接并自动保存到本地',
    category: 'resource',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['resource', 'download', 'save', 'cache']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'resource_downloader',
      description: 'Download resources by ID from sniffer cache to local storage',
      parameters: {
        type: 'object',
        properties: {
          resourceIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of resource IDs to download (from resource sniffer results)'
          },
          downloadPath: {
            type: 'string',
            description: 'Optional custom download path/filename. If not provided, uses default Downloads folder.',
            default: ''
          },
          openAfterDownload: {
            type: 'boolean',
            description: 'Whether to open the downloaded file after completion',
            default: false
          }
        },
        required: ['resourceIds']
      }
    }
  };

  async execute(args: {
    resourceIds: string[];
    downloadPath?: string;
    openAfterDownload?: boolean;
  }): Promise<ToolResult> {
    try {
      const {
        resourceIds,
        downloadPath = '',
        openAfterDownload = false
      } = args;

      if (!resourceIds || resourceIds.length === 0) {
        return this.createErrorResponse('No resource IDs provided');
      }

      this.log(`Starting download for ${resourceIds.length} resources`);

      // 获取资源嗅探工具实例以访问缓存
      const snifferTool = this._getSnifferTool();
      if (!snifferTool) {
        return this.createErrorResponse('Resource sniffer tool not found. Please run resource sniffer first.');
      }

      const cache = snifferTool.getCache();
      const downloadResults: any[] = [];
      const errors: string[] = [];

      // 处理每个资源ID
      for (const resourceId of resourceIds) {
        try {
          const cachedResource = cache[resourceId];
          if (!cachedResource) {
            errors.push(`Resource ID ${resourceId} not found in cache`);
            continue;
          }

          const { downloadUrl, info } = cachedResource;
          this.log(`Downloading: ${info.filename} from ${downloadUrl}`);

          // 执行下载
          const downloadResult = await this._downloadResource({
            url: downloadUrl,
            filename: info.filename,
            customPath: downloadPath,
            openAfterDownload
          });

          if (downloadResult.success) {
            downloadResults.push({
              id: resourceId,
              filename: info.filename,
              url: downloadUrl,
              downloadId: downloadResult.downloadId,
              status: 'success'
            });
          } else {
            errors.push(`Failed to download ${info.filename}: ${downloadResult.error}`);
          }

        } catch (error) {
          errors.push(`Error processing resource ID ${resourceId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // 返回结果
      const successCount = downloadResults.length;
      const errorCount = errors.length;

      if (successCount === 0 && errorCount > 0) {
        return this.createErrorResponse(`All downloads failed: ${errors.join('; ')}`);
      }

      return this.createSuccessResponse({
        downloads: downloadResults,
        errors: errors,
        summary: {
          total: resourceIds.length,
          successful: successCount,
          failed: errorCount
        }
      }, `Downloaded ${successCount} of ${resourceIds.length} resources${errorCount > 0 ? ` (${errorCount} failed)` : ''}`);

    } catch (error) {
      return this.createErrorResponse('Resource download failed', error);
    }
  }

  /**
   * 获取资源嗅探工具实例
   */
  private _getSnifferTool(): ResourceSnifferTool | null {
    try {
      const tools = toolRegistry.getAll();
      return tools.find(tool => tool.name === 'resource_sniffer') as ResourceSnifferTool || null;
    } catch (error) {
      this.log(`Error getting sniffer tool: ${error}`, 'error');
      return null;
    }
  }

  /**
   * 下载单个资源
   */
  private async _downloadResource(options: {
    url: string;
    filename: string;
    customPath: string;
    openAfterDownload: boolean;
  }): Promise<{ success: boolean; downloadId?: number; error?: string }> {
    try {
      const { url, filename, customPath, openAfterDownload } = options;

      // 构建下载选项
      const downloadOptions: chrome.downloads.DownloadOptions = {
        url: url,
        filename: customPath || filename,
        saveAs: false, // 不显示保存对话框，直接下载到默认位置
        conflictAction: 'uniquify' // 如果文件已存在，自动重命名
      };

      // 执行下载
      const downloadId = await new Promise<number>((resolve, reject) => {
        chrome.downloads.download(downloadOptions, (id) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(id);
          }
        });
      });

      this.log(`Download started with ID: ${downloadId}`);

      // 如果需要，等待下载完成并打开文件
      if (openAfterDownload) {
        this._waitForDownloadAndOpen(downloadId);
      }

      return { success: true, downloadId };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * 等待下载完成并打开文件
   */
  private async _waitForDownloadAndOpen(downloadId: number): Promise<void> {
    try {
      // 监听下载状态变化
      const listener = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id === downloadId && delta.state?.current === 'complete') {
          chrome.downloads.onChanged.removeListener(listener);
          
          // 打开下载的文件（当前 @types/chrome 只声明了单参签名，不再提供回调形态）
          try {
            chrome.downloads.open(downloadId);
            this.log(`Opened downloaded file with ID: ${downloadId}`);
          } catch (openError) {
            this.log(`Failed to open downloaded file: ${openError}`, 'warn');
          }
        }
      };

      chrome.downloads.onChanged.addListener(listener);

      // 设置超时，避免永久监听
      setTimeout(() => {
        chrome.downloads.onChanged.removeListener(listener);
      }, 60000); // 60秒超时

    } catch (error) {
      this.log(`Error setting up download completion handler: ${error}`, 'warn');
    }
  }

  /**
   * 获取当前缓存的资源列表
   */
  async getCachedResources(): Promise<ToolResult> {
    try {
      const snifferTool = this._getSnifferTool();
      if (!snifferTool) {
        return this.createErrorResponse('Resource sniffer tool not found');
      }

      const cache = snifferTool.getCache();
      // 合并顺序与原字面量 `{ id, ...data.info, cachedAt }` 等价：info 自带 id 时以其为准
      const resources = Object.entries(cache).map(([id, data]) =>
        Object.assign({ id }, data.info, {
          cachedAt: new Date(data.timestamp).toISOString()
        })
      );

      return this.createSuccessResponse({
        resources,
        total: resources.length
      }, `Found ${resources.length} cached resources`);

    } catch (error) {
      return this.createErrorResponse('Failed to get cached resources', error);
    }
  }
}