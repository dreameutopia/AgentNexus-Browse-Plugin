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
 *     → chrome.downloads 保存，用后即关离屏页（全局仅允许一个离屏页，
 *       及时释放避免与 screen-share-offscreen 冲突）
 *
 * ==================== 错误处理契约 ====================
 *
 * 所有失败路径返回「阶段错误码 + 可读中文说明 (+ 技术细节)」，错误码可
 * grep/上报定位：MERMAID_EMPTY_CODE / MERMAID_CODE_TOO_LONG /
 * OFFSCREEN_CONFLICT / OFFSCREEN_CREATE_FAILED / MERMAID_RENDER_TIMEOUT /
 * MERMAID_PARSE_ERROR / MERMAID_EMPTY_SVG / MERMAID_SIZE_LIMIT /
 * MERMAID_CONVERT_ERROR / MERMAID_INTERNAL_ERROR / MERMAID_DOWNLOAD_FAILED。
 */

import { BaseTool } from '../base-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import {
  MermaidOffscreenMsgType,
  MERMAID_MAX_CODE_LENGTH,
  MERMAID_RENDER_TIMEOUT_MS,
  type MermaidRenderRequest,
  type MermaidRenderResponse,
} from './mermaid-protocol';

/** WXT 构建后 HTML 入口名（entrypoints/mermaid-offscreen/index.html → mermaid-offscreen.html） */
const OFFSCREEN_HTML = 'mermaid-offscreen.html';

/** 下载文件名最大长度（含 .png 扩展名前的部分） */
const MAX_FILENAME_LENGTH = 80;

/**
 * chrome.runtime.getContexts 返回项的最小结构（旧版 @types/chrome 未收录
 * 该 API 的返回类型，按 MV3 Chrome ≥116 的运行时形状声明；只声明消费到的字段）
 */
interface OffscreenContextInfo {
  documentUrl?: string;
}

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
   * 并发串行化：LLM 可能并行发起多次工具调用，而 Chrome 全局仅允许一个
   * offscreen document；用 Promise 链把「ensure → 渲染 → 关闭」整体排队，
   * 避免并发调用互相关闭对方正在使用的离屏页。
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

      // ── 2. 确保离屏页存在（返回是否由本次调用创建）──
      const created = await this.ensureOffscreen();

      // ── 3. 请求渲染（超时守卫；用后即关，释放全局唯一离屏槽位）──
      let response: MermaidRenderResponse | null = null;
      try {
        response = await this.requestRender(code);
      } finally {
        if (created) await this.closeOffscreenQuietly();
      }

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
   * 确保离屏页存在。
   * @returns 是否由本次调用创建（true = 调用方负责用后关闭）
   * @throws 带错误码的 Error：OFFSCREEN_CONFLICT / OFFSCREEN_CREATE_FAILED
   */
  private async ensureOffscreen(): Promise<boolean> {
    // 查询现存离屏页：Chrome 同一时刻全局仅允许一个。
    // 旧版 @types/chrome 未收录 getContexts 的返回类型（标为 void），按运行时
    // 形状声明最小结构类型并显式断言（MV3 Chrome ≥116 该形状稳定）
    let contexts: OffscreenContextInfo[] = [];
    try {
      contexts = (await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      })) as unknown as OffscreenContextInfo[];
    } catch {
      // Chrome <116 无 getContexts：走 createDocument 的冲突错误兜底
    }

    const mine = contexts.find(context => context.documentUrl?.endsWith(OFFSCREEN_HTML));
    if (mine) {
      // 上一次调用异常中断遗留的本工具离屏页：直接复用（调用方不关闭，
      // 交由下一轮异常恢复；正常路径总会走到关闭分支）
      return false;
    }
    if (contexts.length > 0) {
      throw new Error(
        '[OFFSCREEN_CONFLICT] 离屏渲染通道正被其他功能占用（如屏幕共享），请在其结束后重试',
      );
    }

    try {
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL(OFFSCREEN_HTML),
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: '在扩展页环境中将 Mermaid 图表渲染为 PNG（Service Worker 无 DOM/Canvas）',
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('single offscreen')) {
        // 查询与创建之间的竞态窗口内被其他功能抢先创建
        throw new Error(
          '[OFFSCREEN_CONFLICT] 离屏渲染通道刚被其他功能占用，请稍后重试',
        );
      }
      throw new Error(`[OFFSCREEN_CREATE_FAILED] 创建离屏渲染页失败: ${message}`);
    }
  }

  /** 关闭本工具创建的离屏页（容错：已关闭/关闭失败均静默，不阻塞主流程） */
  private async closeOffscreenQuietly(): Promise<void> {
    try {
      await chrome.offscreen.closeDocument();
      this.log('离屏渲染页已关闭（释放全局离屏槽位）');
    } catch {
      // 已被系统回收或并发场景下被关闭：无需处理
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
