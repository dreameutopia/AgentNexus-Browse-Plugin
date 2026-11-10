/**
 * Mermaid 渲染工具
 *
 * 将 Mermaid 图表源码渲染为 PNG 并保存到浏览器下载目录。
 *
 * ==================== 架构（v2 重写） ====================
 *
 * 旧实现（向当前标签页注入 CDN 脚本 + executeScript func）存在不可修复的
 * 结构性缺陷，从未真正可用：
 *   1. executeScript({func}) 在 ISOLATED world 执行，而注入的 CDN <script>
 *      加载在 MAIN world —— 渲染函数中 window.mermaid 永远是 undefined；
 *   2. 目标页面的 CSP 大概率拦截 CDN 脚本（onload 永不触发）；
 *   3. 游离节点上调用 getBBox() 恒得 0，尺寸回退硬编码 800×600 会裁剪图表；
 *   4. mermaid 默认 htmlLabels 的 <foreignObject> 在 Canvas 光栅化中为空白。
 *
 * 新实现采用扩展离屏页（Offscreen Document，Chrome 116+）：
 *   工具（background/sidepanel 均可执行）
 *     → 确保离屏页存在（chrome.offscreen，BLOBS reason）
 *     → chrome.runtime.sendMessage 发送源码
 *     → 离屏页用内置打包的 mermaid（非 CDN）渲染 SVG → PNG dataURL
 *     → chrome.downloads 保存。离屏宿主也服务 Python 执行与屏幕共享。
 *
 * ==================== 错误处理契约 ====================
 *
 * 所有失败路径返回「阶段错误码 + 可读中文说明 (+ 技术细节)」，错误码可
 * grep/上报定位：MERMAID_EMPTY_CODE / MERMAID_CODE_TOO_LONG /
 * MERMAID_RENDER_TIMEOUT /
 * MERMAID_PARSE_ERROR / MERMAID_EMPTY_SVG / MERMAID_SIZE_LIMIT /
 * MERMAID_CONVERT_ERROR / MERMAID_INTERNAL_ERROR / MERMAID_DOWNLOAD_FAILED。
 */

import { BaseTool } from '../base-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { ensureOffscreenHost } from '@/utils/offscreen-host';
import {
  MermaidOffscreenMsgType,
  MERMAID_MAX_CODE_LENGTH,
  MERMAID_RENDER_TIMEOUT_MS,
  type MermaidRenderRequest,
  type MermaidRenderResponse,
} from './mermaid-protocol';

/** 下载文件名最大长度（含 .png 扩展名前的部分） */
const MAX_FILENAME_LENGTH = 80;

/**
 * 清洗下载文件名：剔除路径分隔符/控制字符/Windows 保留字符，
 * 防路径穿越（../）与非法文件名，空结果回退默认名。
 */
/** 文件名中需要替换为下划线的保留字符（路径分隔符 / Windows 保留字符） */
const FORBIDDEN_FILENAME_CHARS = '\\/:*?"<>|';

function sanitizeFilename(name: string): string {
  // 逐字符清洗（不用含控制字符的正则，规避 no-control-regex）：
  // 路径分隔符、Windows 保留字符与 C0 控制字符一律替换为下划线，
  // 防路径穿越（../）与非法文件名
  let cleaned = '';
  for (const ch of name) {
    const forbidden = FORBIDDEN_FILENAME_CHARS.includes(ch) || ch.charCodeAt(0) <= 0x1f;
    cleaned += forbidden ? '_' : ch;
  }
  cleaned = cleaned
    .replace(/^\.+/, '')
    .trim()
    .slice(0, MAX_FILENAME_LENGTH);
  return cleaned || 'mermaid-diagram';
}

export class MermaidRendererTool extends BaseTool {
  name = 'mermaid_renderer';

  metadata: ToolMetadata = {
    name: 'mermaid_renderer',
    description: '渲染Mermaid图表并保存为PNG图片',
    category: 'code',
    version: '2.0.0',
    author: 'AgentNexus',
    tags: ['mermaid', 'diagram', 'render', 'image', 'png']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'mermaid_renderer',
      description:
        '渲染Mermaid图表代码为高清PNG图片并保存到浏览器下载文件夹。源码语法错误时会返回带行号的可读解析错误。支持 flowchart/sequence/gantt/class/state/er/pie/mindmap 等全部 Mermaid 图表类型。',
      parameters: {
        type: 'object',
        properties: {
          mermaidCode: {
            type: 'string',
            description: '要渲染的Mermaid图表源码'
          },
          filename: {
            type: 'string',
            description: '保存的文件名（不含扩展名），默认为 mermaid-diagram',
            default: 'mermaid-diagram'
          }
        },
        required: ['mermaidCode']
      }
    }
  };

  /**
   * 串行化本工具的渲染请求，避免 Mermaid 的测量 DOM 相互干扰。
   */
  private renderQueue: Promise<unknown> = Promise.resolve();

  async execute(params: { mermaidCode?: unknown; filename?: unknown }): Promise<ToolResult> {
    const previous = this.renderQueue;
    let release!: () => void;
    this.renderQueue = new Promise<void>(resolve => {
      release = resolve;
    });
    // 前序调用无论成败都放行本次（失败不阻塞后续渲染）
    await previous.catch(() => undefined);
    try {
      return await this.executeSerialized(params);
    } finally {
      release();
    }
  }

  /** 串行执行体：输入校验 → 离屏渲染 → 下载保存 */
  private async executeSerialized(params: {
    mermaidCode?: unknown;
    filename?: unknown;
  }): Promise<ToolResult> {
    try {
      // ── 1. 输入校验（防御性：类型与长度双查，LLM 参数不可信）──
      const code = typeof params.mermaidCode === 'string' ? params.mermaidCode : '';
      if (!code.trim()) {
        return this.buildError(
          'MERMAID_EMPTY_CODE',
          'mermaidCode 参数不能为空，请提供完整的 Mermaid 图表源码',
        );
      }
      if (code.length > MERMAID_MAX_CODE_LENGTH) {
        return this.buildError(
          'MERMAID_CODE_TOO_LONG',
          `源码长度 ${code.length} 字符超出上限 ${MERMAID_MAX_CODE_LENGTH}，请精简后重试`,
        );
      }
      const rawFilename =
        typeof params.filename === 'string' && params.filename.trim() ? params.filename : 'mermaid-diagram';
      const filename = sanitizeFilename(rawFilename);

      await ensureOffscreenHost();
      const response = await this.requestRender(code);

      if (!response) {
        return this.buildError(
          'MERMAID_RENDER_TIMEOUT',
          `离屏渲染在 ${MERMAID_RENDER_TIMEOUT_MS / 1000} 秒内未返回（库加载/渲染/转换卡死），请重试；若持续失败请精简图表`,
        );
      }
      if (!response.ok) {
        return this.buildError(
          `MERMAID_${response.code}`,
          response.message,
          response.detail ? `\n技术细节: ${response.detail}` : undefined,
        );
      }

      // ── 4. 下载保存 ──
      try {
        await chrome.downloads.download({
          url: response.dataUrl,
          filename: `${filename}.png`,
          saveAs: false,
          conflictAction: 'uniquify',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return this.buildError(
          'MERMAID_DOWNLOAD_FAILED',
          `图片已生成（${response.width}×${response.height}px）但保存失败：${message}`,
          '可重试一次；若浏览器处于无痕/下载受限模式请先解除限制',
        );
      }

      this.log(`渲染成功: ${filename}.png (${response.width}x${response.height}px, ${response.durationMs}ms)`);

      // 保留旧版成功回显行为：调用方可直接对照源码与产物
      return {
        success: true,
        content: [
          {
            type: 'text',
            text:
              `✅ Mermaid 图表渲染成功！\n` +
              `文件已保存为: ${filename}.png（${response.width}×${response.height}px，耗时 ${response.durationMs}ms）\n\n` +
              `渲染的代码：\n\`\`\`mermaid\n${code}\n\`\`\``
          }
        ],
        isError: false
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`渲染失败: ${message}`, 'error');
      return this.buildError('MERMAID_INTERNAL_ERROR', `工具执行发生未预期异常：${message}`);
    }
  }

  /**
   * 发送渲染请求并等待离屏页响应。
   * 返回 null 表示超时（或无接收方）；回调中读取 lastError 避免 unchecked 告警。
   */
  private requestRender(code: string): Promise<MermaidRenderResponse | null> {
    return new Promise<MermaidRenderResponse | null>(resolve => {
      const request: MermaidRenderRequest = { type: MermaidOffscreenMsgType.RENDER, code };
      const timer = setTimeout(() => resolve(null), MERMAID_RENDER_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage(request, response => {
          clearTimeout(timer);
          // 必须显式读取：无监听者响应时 Chrome 会设置 lastError
          void chrome.runtime.lastError;
          resolve((response as MermaidRenderResponse | undefined) ?? null);
        });
      } catch (error) {
        // sendMessage 同步抛出（如上下文销毁）：按超时类错误处理并记录真实原因
        clearTimeout(timer);
        const message = error instanceof Error ? error.message : String(error);
        this.log(`发送渲染请求失败: ${message}`, 'warn');
        resolve(null);
      }
    });
  }

  /** 构造统一格式（阶段错误码 + 可读信息）的错误结果 */
  private buildError(code: string, message: string, suffix?: string): ToolResult {
    return {
      success: false,
      content: [
        {
          type: 'text',
          text: `❌ [${code}] ${message}${suffix ?? ''}`
        }
      ],
      isError: true
    };
  }
}
