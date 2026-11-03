/**
 * B站字幕提取工具
 * 用于提取B站视频的字幕信息，支持多种格式输出
 */
import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

export class BilibiliSubtitleTool extends BaseTool {
  name = 'bilibili_subtitle_tool';
  
  metadata: ToolMetadata = {
    name: 'bilibili_subtitle_tool',
    description: '提取B站视频的字幕信息，支持JSON、SRT、VTT格式输出，可选择语言和是否包含视频信息',
    category: 'bilibili',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['bilibili', 'subtitle', 'video', 'extract'],
    permissions: ['tabs', 'activeTab'],
    supportedSites: ['bilibili.com']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'bilibili_subtitle_tool',
      description: '提取B站视频的字幕信息，支持多种格式和语言选择',
      parameters: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            enum: ['text', 'json', 'srt', 'vtt'],
            description: '字幕输出格式：text(纯文本)、json(结构化数据)、srt(SubRip格式)、vtt(WebVTT格式)',
            default: 'text'
          },
          language: {
            type: 'string',
            description: '字幕语言代码，如zh-CN(中文)、en(英文)等，留空则获取所有可用语言',
            default: ''
          },
          includeVideoInfo: {
            type: 'boolean',
            description: '是否在结果中包含视频基本信息(标题、ID、CID等)',
            default: false
          }
        },
        required: []
      }
    }
  };

  async execute(params: {
    format?: 'text' | 'json' | 'srt' | 'vtt';
    language?: string;
    includeVideoInfo?: boolean;
  }): Promise<ToolResult> {
    const {
      format = 'text',
      language = '',
      includeVideoInfo = false
    } = params;

    try {
      // 检查当前页面是否为B站视频页面
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const currentTab = tabs[0];
      
      if (!currentTab?.url || !/bilibili\.com\/(video|list)\//.test(currentTab.url)) {
        return {
          success: false,
          message: '请在B站视频播放页使用此工具',
          data: null
        };
      }

      // 注入字幕提取脚本
      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id! },
        files: ['inject-scripts/scraper/bilibili-subtitle.js']
      });

      // 等待页面加载完成
      await new Promise<void>((resolve, reject) => {
        if (!currentTab?.id) return resolve();
        const timeout = setTimeout(() => reject(new Error('页面加载超时')), 10000);
        const check = () => {
          chrome.tabs.get(currentTab.id!, (tab) => {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            if (chrome.runtime.lastError) {
              clearTimeout(timeout);
              // eslint-disable-next-line @typescript-eslint/ban-ts-comment
              // @ts-ignore
              return reject(new Error(chrome.runtime.lastError.message));
            }
            if (tab?.status === 'complete') {
              clearTimeout(timeout);
              resolve();
            } else {
              setTimeout(check, 120);
            }
          });
        };
        check();
      });

      // 等待脚本完成注册监听器
      await new Promise((r) => setTimeout(r, 300));

      // 发送消息到内容脚本执行字幕提取（使用回调包装为 Promise，处理 lastError 和超时）
      const requestFormat = format === 'text' ? 'json' : format;
      const response: any = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('字幕提取超时')), 20000);
        try {
          chrome.tabs.sendMessage(
            currentTab.id!,
            {
              action: 'extractSubtitles',
              options: {
                format: requestFormat,
                language: language || 'all',
                includeVideoInfo
              }
            },
            (res) => {
              clearTimeout(timeout);
              // 处理可能的 lastError
              // eslint-disable-next-line @typescript-eslint/ban-ts-comment
              // @ts-ignore
              if (chrome.runtime.lastError) {
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-ignore
                return reject(new Error(chrome.runtime.lastError.message));
              }
              resolve(res);
            }
          );
        } catch (e) {
          clearTimeout(timeout);
          reject(e);
        }
      });
 
      if (response?.success) {
        if (format === 'text') {
          const subtitles = Array.isArray(response?.subtitles) ? response.subtitles : [];
          const lines: string[] = [];
          for (const sub of subtitles) {
            const items = Array.isArray(sub?.items) ? sub.items : [];
            for (const it of items) {
              const content = (it && typeof it.content === 'string') ? it.content : '';
              if (content) lines.push(content);
            }
          }
          const text = lines.join('\n');
          return {
            success: true,
            message: `成功提取文本字幕，行数：${lines.length}`,
            data: {
              title: response.title,
              aid: response.aid,
              cid: response.cid,
              text
            }
          };
        } else {
          return {
            success: true,
            message: `成功提取${response.subtitles?.length ?? 0}个字幕`,
            data: response
          };
        }
      } else {
        return {
          success: false,
          message: response?.error || '字幕提取失败',
          data: null
        };
      }

    } catch (error) {
      return {
        success: false,
        message: `字幕提取出错: ${error instanceof Error ? error.message : String(error)}`,
        data: null
      };
    }
  }
}
