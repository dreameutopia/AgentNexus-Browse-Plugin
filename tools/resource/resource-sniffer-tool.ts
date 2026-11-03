/**
 * 资源嗅探工具
 * 支持按文件类型筛选，获取多个资源，返回ID和对应信息，并进行缓存
 */

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../index';
import { OpenAITool } from '@/common/openai-types';

interface ResourceInfo {
  id: string;
  url: string;
  filename: string;
  fileType: string;
  size?: string;
  title?: string;
  description?: string;
  source?: 'dom' | 'network' | 'platform';
}

interface ResourceCache {
  [id: string]: {
    downloadUrl: string;
    info: ResourceInfo;
    timestamp: number;
  };
}

export class ResourceSnifferTool extends BaseTool {
  name = 'resource_sniffer';
  private cache: ResourceCache = {};
  
  metadata: ToolMetadata = {
    name: 'resource_sniffer',
    description: '嗅探当前页面的资源文件，支持按文件类型筛选和缓存',
    category: 'resource',
    version: '1.2.0',
    author: 'AgentNexus',
    tags: ['resource', 'sniffer', 'download', 'cache']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'resource_sniffer',
      description: 'Sniff and detect resources on current page with file type filtering and caching',
      parameters: {
        type: 'object',
        properties: {
          fileTypes: {
            type: 'array',
            items: { type: 'string' },
            description: 'File types to filter (e.g., ["pdf", "doc", "mp4", "mp3", "zip"]). Leave empty for all types.'
          },
          maxResults: {
            type: 'number',
            description: 'Maximum number of results to return (default: 10)',
            default: 10
          },
          includeImages: {
            type: 'boolean',
            description: 'Whether to include image files (jpg, png, gif, etc.)',
            default: false
          }
        },
        required: []
      }
    }
  };

  async execute(args: {
    fileTypes?: string[];
    maxResults?: number;
    includeImages?: boolean;
  }): Promise<ToolResult> {
    try {
      const {
        fileTypes = [],
        maxResults = 10,
        includeImages = false
      } = args;

      this.log(`Starting resource sniffing with filters: ${JSON.stringify({ fileTypes, maxResults, includeImages })}`);

      // 获取当前活动标签页
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        return this.createErrorResponse('No active tab found');
      }

      // 优先使用已注入的页面脚本，如果未注入则主动注入 data/resource-sniffer.js 到内容脚本环境（ISOLATED world 才能使用 chrome.* API）
      await new Promise<void>((resolve) => {
        try {
          chrome.scripting.executeScript({
            target: { tabId: tab.id! },
            files: ['inject-scripts/data/resource-sniffer.js'],
          }, () => {
            if (chrome.runtime.lastError) {
              this.log(`data/resource-sniffer.js 注入可能失败，将尝试消息通信并在必要时回退：${chrome.runtime.lastError.message}`, 'warn');
            }
            resolve();
          });
        } catch (e: any) {
          this.log(`注入 data/resource-sniffer.js 抛出异常：${e?.message || e}`, 'warn');
          resolve();
        }
      });

      // 通过消息协议与已注入脚本通信（action: 'ping' | 'sniffMediaResources'）
      const sendTabMessage = async <T = any>(message: any): Promise<T | null> => {
        return new Promise((resolve) => {
          try {
            chrome.tabs.sendMessage(tab.id!, message, (resp) => resolve((resp as T) ?? null));
          } catch (_e) {
            resolve(null);
          }
        });
      };

      // 尝试 ping，确认监听器已就绪（非致命）
      const pingResp = await sendTabMessage<{ status: string }>({ action: 'ping' });
      if (pingResp?.status !== 'pong') {
        this.log('data/resource-sniffer.js 未响应 ping，将继续尝试 sniff 或回退', 'warn');
      }

      // 优先请求注入脚本执行媒体嗅探
      const sniffResp = await sendTabMessage<{ status: 'success' | 'error'; data?: any; message?: string }>({ action: 'sniffMediaResources' });

      // 将注入脚本返回的分组媒体数据转换为 ResourceInfo[]，并应用过滤与上限
      let resources: ResourceInfo[] = [];
      if (sniffResp && sniffResp.status === 'success' && sniffResp.data) {
        const data = sniffResp.data as { images?: any[]; videos?: any[]; audios?: any[]; backgroundImages?: any[] };
        const seen = new Set<string>();

        const fileTypeMap: { [key: string]: string[] } = {
          document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp'],
          archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
          video: ['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp'],
          audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'],
          image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico', 'tiff'],
          code: ['js', 'css', 'html', 'json', 'xml', 'py', 'java', 'cpp', 'c', 'php', 'rb', 'go'],
          font: ['ttf', 'otf', 'woff', 'woff2', 'eot'],
          data: ['csv', 'sql', 'db', 'sqlite'],
        };

        const getFileExtension = (url: string): string => {
          try {
            const urlObj = new URL(url);
            const pathname = urlObj.pathname.split('?')[0];
            const lastDot = pathname.lastIndexOf('.');
            if (lastDot > 0) return pathname.substring(lastDot + 1).toLowerCase();
          } catch (_e) {
            const match = url.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
            if (match) return match[1].toLowerCase();
          }
          return '';
        };

        const generateId = (url: string): string => {
          try {
            return btoa(encodeURIComponent(url)).replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
          } catch (_e) {
            return Math.random().toString(36).substring(2, 18);
          }
        };

        const matchesFileType = (extension: string): boolean => {
          if (fileTypes.length === 0) return true;
          if (fileTypes.includes(extension)) return true; // 直接扩展名匹配
          for (const category of fileTypes) {
            if (fileTypeMap[category]?.includes(extension)) return true;
          }
          return false;
        };

        const pushItem = (item: any, isImage: boolean) => {
          if (!item || !item.url || seen.has(item.url) || resources.length >= maxResults) return;
          const ext = getFileExtension(item.url);
          if (!ext) return;
          if (isImage && !includeImages) return;
          if (!matchesFileType(ext)) return;
          seen.add(item.url);
          let filename = '';
          try {
            const u = new URL(item.url);
            filename = (u.pathname.split('/').pop() || `file.${ext}`).split('?')[0];
          } catch (_e) {
            filename = `file.${ext}`;
          }
          const title = item.alt || item.contextText || filename;
          const description = item.contextText || item.sourceType || '';
          resources.push({
            id: generateId(item.url),
            url: item.url,
            filename,
            fileType: ext,
            size: '',
            title,
            description,
            source: 'dom',
          });
        };

        // 添加视频和音频
        (data.videos || []).forEach((i) => pushItem(i, false));
        (data.audios || []).forEach((i) => pushItem(i, false));
        // 仅在需要时添加图片相关
        if (includeImages) {
          (data.images || []).forEach((i) => pushItem(i, true));
          (data.backgroundImages || []).forEach((i) => pushItem(i, true));
        }
      }

      // 如果注入脚本不可用或没有结果，则使用内联嗅探函数兜底
      if (!resources || resources.length === 0) {
        const fallback = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: this._sniffResources,
          args: [{ fileTypes, maxResults, includeImages }],
        });
        resources = (fallback && fallback[0] && (fallback[0] as any).result) ? ((fallback[0] as any).result as ResourceInfo[]) : [];
      }

      if (!resources) resources = [];

      // 更新缓存
      this._updateCache(resources);

      this.log(`Found ${resources.length} resources, cached ${Object.keys(this.cache).length} total`);

      return this.createSuccessResponse({
        resources,
        totalFound: resources.length,
        cached: Object.keys(this.cache).length,
        filters: { fileTypes, maxResults, includeImages }
      }, `Successfully found ${resources.length} resources`);

    } catch (error) {
      return this.createErrorResponse('Resource sniffing failed', error);
    }
  }

  /**
   * 更新缓存
   */
  private _updateCache(resources: ResourceInfo[]): void {
    const timestamp = Date.now();
    
    // 这里不清空全部缓存，而是刷新/合并，便于多次嗅探累计
    for (const resource of resources) {
      this.cache[resource.id] = {
        downloadUrl: resource.url,
        info: resource,
        timestamp
      };
    }
  }

  /**
   * 获取缓存数据
   */
  getCache(): Record<string, { downloadUrl: string; info: ResourceInfo; timestamp: number }> {
    return this.cache;
  }

  /**
   * 资源嗅探脚本（在页面中执行）
   */
  private _sniffResources(options: {
    fileTypes: string[];
    maxResults: number;
    includeImages: boolean;
  }): ResourceInfo[] {
    const { fileTypes, maxResults, includeImages } = options;
    const resources: ResourceInfo[] = [];
    const seenUrls = new Set<string>();

    // 定义文件类型映射（完整）
    const fileTypeMap: { [key: string]: string[] } = {
      'document': ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp'],
      'archive': ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
      'video': ['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp'],
      'audio': ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'],
      'image': ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico', 'tiff'],
      'code': ['js', 'css', 'html', 'json', 'xml', 'py', 'java', 'cpp', 'c', 'php', 'rb', 'go'],
      'font': ['ttf', 'otf', 'woff', 'woff2', 'eot'],
      'data': ['csv', 'sql', 'db', 'sqlite']
    };

    // 生成唯一ID
    const generateId = (url: string): string => {
      try {
        return btoa(encodeURIComponent(url)).replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
      } catch (_e) {
        return Math.random().toString(36).substring(2, 18);
      }
    };

    // 获取文件扩展名
    const getFileExtension = (url: string): string => {
      try {
        const urlObj = new URL(url, window.location.href);
        const pathname = urlObj.pathname;
        const cleanPath = pathname.split('?')[0];
        const lastDot = cleanPath.lastIndexOf('.');
        if (lastDot > 0) {
          return cleanPath.substring(lastDot + 1).toLowerCase();
        }
      } catch (_e) {
        const match = url.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
        if (match) return match[1].toLowerCase();
      }
      return '';
    };

    // 检查文件类型是否匹配
    const matchesFileType = (extension: string): boolean => {
      if (fileTypes.length === 0) return true;
      if (fileTypes.includes(extension)) return true; // 直接匹配扩展名
      for (const category of fileTypes) {
        if (fileTypeMap[category]?.includes(extension)) return true;
      }
      return false;
    };

    const getFileSizeInfo = (element: Element): string => {
      const sizeAttrs = ['data-size', 'data-filesize', 'size'];
      for (const attr of sizeAttrs) {
        const val = element.getAttribute(attr);
        if (val) return val;
      }
      return '';
    };

    // 处理资源
    const processResource = (url: string, element?: Element | null, title?: string, description?: string, source: ResourceInfo['source'] = 'dom') => {
      if (!url || seenUrls.has(url) || resources.length >= maxResults) return;

      const extension = getFileExtension(url);
      if (!extension) return;
      if (fileTypeMap.image.includes(extension) && !includeImages) return;
      if (!matchesFileType(extension)) return;

      seenUrls.add(url);

      // 获取文件名
      let filename = '';
      try {
        const urlObj = new URL(url, window.location.href);
        const pathname = urlObj.pathname;
        filename = pathname.split('/').pop() || `file.${extension}`;
        filename = filename.split('?')[0];
      } catch (_e) {
        filename = `file.${extension}`;
      }

      const size = element ? getFileSizeInfo(element) : '';
      const elementTitle = element?.getAttribute?.('title') || element?.getAttribute?.('alt') || '';
      const elementText = (element && 'textContent' in element) ? (element.textContent || '').trim() : '';

      resources.push({
        id: generateId(url),
        url,
        filename,
        fileType: extension,
        size,
        title: title || elementTitle || elementText || filename,
        description: description || elementTitle || '',
        source,
      });
    };

    // 1. 扫描所有链接
    document.querySelectorAll('a[href]').forEach(link => {
      const href = (link as HTMLAnchorElement).href;
      if (href && !href.startsWith('javascript:') && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
        processResource(href, link, link.textContent?.trim() || undefined);
      }
    });

    // 2. 扫描媒体元素
    document.querySelectorAll('img[src], video[src], audio[src], source[src]').forEach(media => {
      const src = (media as HTMLImageElement | HTMLVideoElement | HTMLAudioElement | HTMLSourceElement).src;
      if (src) processResource(src, media);
    });

    // 3. 扫描嵌入对象
    document.querySelectorAll('embed[src], object[data], iframe[src]').forEach(embed => {
      const src = embed.getAttribute('src') || embed.getAttribute('data');
      if (src) processResource(src as string, embed);
    });

    // 4. 扫描下载按钮和特殊属性
    document.querySelectorAll('[download], [data-download], [data-url], [data-href]').forEach(element => {
      const downloadUrl = element.getAttribute('href') || 
                          element.getAttribute('data-download') || 
                          element.getAttribute('data-url') ||
                          element.getAttribute('data-href');
      if (downloadUrl) processResource(downloadUrl, element);
    });

    // 5. 扫描 CSS 背景图片
    if (includeImages) {
      document.querySelectorAll('*').forEach(element => {
        const style = window.getComputedStyle(element as Element);
        const backgroundImage = style.backgroundImage;
        if (backgroundImage && backgroundImage !== 'none') {
          const matches = backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
          if (matches && matches[1]) processResource(matches[1], element, undefined, 'CSS background image');
        }
      });
    }

    // 6. 扫描平台特定资源（简化版，尽量不依赖 UI 变动）
    try {
      const hostname = window.location.hostname.toLowerCase();
      if (hostname.includes('github.com')) {
        document.querySelectorAll('[data-testid="raw-button"], a[download], a[href*="/raw/"]').forEach(a => {
          const href = (a as HTMLAnchorElement).href;
          if (href) processResource(href, a, 'GitHub Raw File', 'GitHub', 'platform');
        });
      }
      if (hostname.includes('pan.baidu.com')) {
        document.querySelectorAll('[data-category="file"]').forEach(el => {
          const filename = (el.querySelector('.file-name')?.textContent || '').trim();
          if (filename) processResource(`#baidu-${filename}`, el, filename, 'Baidu Pan File', 'platform');
        });
      }
      if (hostname.includes('aliyundrive.com')) {
        document.querySelectorAll('[data-testid="virtual-list-item"]').forEach(el => {
          const filename = (el.querySelector('.name--1OdWw')?.textContent || '').trim();
          if (filename) processResource(`#aliyun-${filename}`, el, filename, 'Aliyun Drive File', 'platform');
        });
      }
    } catch (_e) {
      // 平台专属抓取规则失败不影响通用资源收集结果
      void _e;
    }

    return resources;
  }
}