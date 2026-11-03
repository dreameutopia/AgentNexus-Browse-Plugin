/**
 * 下载状态获取工具
 * 获取浏览器下载任务的状态、进度和历史记录
 */

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../index';
import { OpenAITool } from '@/common/openai-types';

// 下载项接口
interface DownloadItem {
  id: string;
  filename: string;
  url: string;
  state: 'in_progress' | 'interrupted' | 'complete';
  paused: boolean;
  bytesReceived: number;
  totalBytes: number;
  fileSize: string;
  progress: number;
  estimatedEndTime?: string;
  startTime: string;
  endTime?: string;
  mime: string;
  finalUrl: string;
  exists: boolean;
  danger: string;
  error?: string;
}

export class DownloadsStatusGetterTool extends BaseTool {
  name = 'get_downloads_status';
  
  metadata: ToolMetadata = {
    name: 'get_downloads_status',
    description: '获取浏览器下载任务的状态、进度和历史记录',
    category: 'automation',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['download', 'status', 'progress', 'history', 'monitoring']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'get_downloads_status',
      description: 'Get browser download tasks status, progress and history. Returns structured information about downloads including progress, speed, state and file details.',
      parameters: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            enum: ['in_progress', 'complete', 'interrupted', 'all'],
            description: 'Filter downloads by state. "in_progress" for active downloads, "complete" for finished, "interrupted" for failed, "all" for everything',
            default: 'all'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of download items to return',
            default: 10,
            minimum: 1,
            maximum: 100
          },
          query: {
            type: 'string',
            description: 'Search query to filter downloads by filename or URL (case-insensitive)',
            default: ''
          },
          orderBy: {
            type: 'string',
            enum: ['startTime', 'bytesReceived', 'totalBytes'],
            description: 'Sort downloads by specified field',
            default: 'startTime'
          }
        },
        required: []
      }
    }
  };

  async execute(args: {
    state?: 'in_progress' | 'complete' | 'interrupted' | 'all';
    limit?: number;
    query?: string;
    orderBy?: 'startTime' | 'bytesReceived' | 'totalBytes';
  }): Promise<ToolResult> {
    try {
      const {
        state = 'all',
        limit = 10,
        query = '',
        orderBy = 'startTime'
      } = args;

      this.log(`Fetching downloads with state: ${state}, limit: ${limit}`);

      // 构建搜索查询
      const searchQuery: chrome.downloads.DownloadQuery = {
        limit,
        orderBy: [`-${orderBy}`] // 降序排列
      };

      // 根据 state 过滤
      if (state !== 'all') {
        searchQuery.state = state;
      }

      // 如果有搜索查询，添加到搜索条件
      if (query) {
        searchQuery.query = [query];
      }

      // 搜索下载项
      const downloads = await chrome.downloads.search(searchQuery);

      // 转换为 Markdown 表格格式
      const downloadItems: DownloadItem[] = downloads.map(item => {
        const progress = item.totalBytes > 0 
          ? Math.round((item.bytesReceived / item.totalBytes) * 100) 
          : 0;

        // 计算文件大小
        const fileSize = this._formatBytes(item.totalBytes || item.bytesReceived);

        // 估算剩余时间（仅用于进行中的下载）
        let estimatedEndTime: string | undefined;
        if (item.state === 'in_progress' && item.totalBytes > 0 && item.bytesReceived > 0) {
          const remainingBytes = item.totalBytes - item.bytesReceived;
          const startTime = new Date(item.startTime).getTime();
          const elapsedTime = Date.now() - startTime;
          const downloadSpeed = item.bytesReceived / (elapsedTime / 1000); // bytes per second
          
          if (downloadSpeed > 0) {
            const remainingSeconds = Math.round(remainingBytes / downloadSpeed);
            estimatedEndTime = this._formatTime(remainingSeconds);
          }
        }

        return {
          id: String(item.id),
          filename: item.filename,
          url: item.url,
          state: item.state,
          paused: item.paused,
          bytesReceived: item.bytesReceived,
          totalBytes: item.totalBytes,
          fileSize,
          progress,
          estimatedEndTime,
          startTime: new Date(item.startTime).toLocaleString(),
          endTime: item.endTime ? new Date(item.endTime).toLocaleString() : undefined,
          mime: item.mime,
          finalUrl: item.finalUrl || item.url,
          exists: item.exists,
          danger: item.danger,
          error: item.error
        };
      });

      // 生成 Markdown 表格
      const markdownTable = this._generateMarkdownTable(downloadItems);

      // 统计信息
      const summary = {
        total: downloadItems.length,
        inProgress: downloadItems.filter(d => d.state === 'in_progress').length,
        completed: downloadItems.filter(d => d.state === 'complete').length,
        interrupted: downloadItems.filter(d => d.state === 'interrupted').length,
        totalSize: this._formatBytes(
          downloadItems.reduce((sum, d) => sum + d.totalBytes, 0)
        ),
        downloadedSize: this._formatBytes(
          downloadItems.reduce((sum, d) => sum + d.bytesReceived, 0)
        )
      };

      this.log(`Found ${downloadItems.length} downloads`);

      return this.createSuccessResponse({
        downloads: markdownTable,
        summary,
        filters: {
          state,
          limit,
          query,
          orderBy
        }
      }, `Successfully retrieved ${downloadItems.length} download(s)`);

    } catch (error) {
      this.log(`Error fetching downloads: ${error}`, 'error');
      return this.createErrorResponse('Failed to fetch downloads', error);
    }
  }

  /**
   * 生成 Markdown 表格
   */
  private _generateMarkdownTable(downloads: DownloadItem[]): string {
    if (downloads.length === 0) {
      return '暂无下载记录';
    }

    // 表头
    let markdown = '| ID | 文件名 | 状态 | 进度 | 文件大小 | 已下载 | 开始时间 | 结束时间 | 是否存在 | 错误 |\n';
    markdown += '|---|---|---|---|---|---|---|---|---|---|\n';

    // 表格内容
    for (const item of downloads) {
      // 截取文件名（保留路径的最后部分）
      const filename = item.filename.split(/[\\/]/).pop() || item.filename;
      const shortFilename = filename.length > 40 ? filename.substring(0, 37) + '...' : filename;
      
      // 状态翻译
      const stateMap: Record<string, string> = {
        'in_progress': '⏬ 下载中',
        'complete': '✅ 完成',
        'interrupted': '❌ 中断'
      };
      const state = stateMap[item.state] || item.state;
      
      // 进度显示
      const progress = item.state === 'in_progress' 
        ? `${item.progress}%${item.estimatedEndTime ? ` (剩余${item.estimatedEndTime})` : ''}`
        : `${item.progress}%`;
      
      // 已下载大小
      const downloaded = this._formatBytes(item.bytesReceived);
      
      // 是否存在
      const exists = item.exists ? '✓' : '✗';
      
      // 错误信息
      const error = item.error || '-';
      
      // 结束时间
      const endTime = item.endTime || '-';

      markdown += `| ${item.id} | ${shortFilename} | ${state} | ${progress} | ${item.fileSize} | ${downloaded} | ${item.startTime} | ${endTime} | ${exists} | ${error} |\n`;
    }

    return markdown;
  }

  /**
   * 格式化字节大小
   */
  private _formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * 格式化时间（秒转为可读格式）
   */
  private _formatTime(seconds: number): string {
    if (seconds < 60) {
      return `${seconds}秒`;
    } else if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      return `${minutes}分钟`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}小时${minutes}分钟`;
    }
  }
}
