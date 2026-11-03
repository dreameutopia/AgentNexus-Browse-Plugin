/**
 * 获取页面 Markdown 内容工具（高级版）
 * 智能提取页面内容并转换为 AI 友好的 Markdown 格式
 * 支持批量URL并行处理，全局并发控制
 */

import { BaseTool } from '../base-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';

// ============ 全局并发控制 ============
const MAX_CONCURRENCY = 3;
let activeCount = 0;
const waitingQueue: Array<() => void> = [];

/**
 * 获取并发锁
 */
function acquireLock(): Promise<void> {
  return new Promise((resolve) => {
    if (activeCount < MAX_CONCURRENCY) {
      activeCount++;
      resolve();
    } else {
      waitingQueue.push(resolve);
    }
  });
}

/**
 * 释放并发锁
 */
function releaseLock(): void {
  activeCount--;
  if (waitingQueue.length > 0 && activeCount < MAX_CONCURRENCY) {
    activeCount++;
    const next = waitingQueue.shift();
    next?.();
  }
}

// 单个URL的提取结果
interface UrlExtractionResult {
  url: string;
  success: boolean;
  markdown?: string;
  title?: string;
  length?: number;
  error?: string;
}

export class GetPageMarkdownTool extends BaseTool {
  name = 'getPageMarkdown';
  
  metadata: ToolMetadata = {
    name: 'getPageMarkdown',
    description: '智能提取页面内容并转换为 AI 友好的 Markdown 格式，支持批量URL并行处理（最多3并发）',
    category: 'analyse',
    version: '2.0.0',
    author: 'AgentNexus',
    tags: ['markdown', 'extraction', 'ai-friendly', 'batch', 'parallel']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'getPageMarkdown',
      description: '智能提取页面内容并转换为 AI 友好的 Markdown 格式，自动识别并保留标题、表格、列表、代码块等结构。支持提取当前页面、单个URL或多个URL（批量并行处理，最多3个并发）。',
      parameters: {
        type: 'object',
        properties: {
          urls: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } }
            ],
            description: '目标页面URL。可以是单个URL字符串或URL数组。默认为"current"表示当前页面。多个URL将并行处理（最多3个同时进行）。'
          },
          includeMetadata: {
            type: 'boolean',
            description: '是否包含页面元数据（标题、URL 等）'
          }
        },
        required: []
      }
    }
  };

  async execute(args: { urls?: string | string[]; url?: string; includeMetadata?: boolean } = {}): Promise<ToolResult> {
    try {
      const includeMetadataArg = args.includeMetadata ?? true;
      
      // 兼容旧的 url 参数，同时支持新的 urls 参数
      let urlList: string[];
      if (args.urls) {
        urlList = Array.isArray(args.urls) ? args.urls : [args.urls];
      } else if (args.url) {
        urlList = [args.url];
      } else {
        urlList = ['current'];
      }

      // 获取当前活动标签页
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!currentTab.id) {
        throw new Error('无法获取当前标签页');
      }

      this.log(`开始处理 ${urlList.length} 个URL，最大并发: ${MAX_CONCURRENCY}`);

      // 使用 Promise.allSettled 并行处理所有URL（带并发控制）
      const resultPromises = urlList.map((urlArg, index) => 
        this.processUrlWithLock(urlArg, index, currentTab, includeMetadataArg)
      );

      const settledResults = await Promise.allSettled(resultPromises);

      // 整理结果
      const results: UrlExtractionResult[] = settledResults.map((result, index) => {
        if (result.status === 'fulfilled') {
          return result.value;
        } else {
          return {
            url: urlList[index],
            success: false,
            error: result.reason?.message || '未知错误'
          };
        }
      });

      const successCount = results.filter(r => r.success).length;
      const failCount = results.length - successCount;

      // 重新激活原来的标签页
      try {
        await chrome.tabs.update(currentTab.id, { active: true });
      } catch (e) {
        // 忽略，可能标签页已关闭
      }

      // 单个URL时保持向后兼容的返回格式
      if (urlList.length === 1) {
        const singleResult = results[0];
        if (singleResult.success) {
          return {
            success: true,
            message: `成功提取页面 Markdown 内容，共 ${singleResult.length} 字符`,
            data: {
              markdown: singleResult.markdown,
              length: singleResult.length,
              url: singleResult.url,
              title: singleResult.title
            },
            content: [{
              type: 'text',
              text: singleResult.markdown || ''
            }]
          };
        } else {
          return {
            success: false,
            message: `提取失败: ${singleResult.error}`,
            error: singleResult.error,
            isError: true,
            content: [{
              type: 'text',
              text: `提取失败: ${singleResult.error}`
            }]
          };
        }
      }

      // 多个URL时返回批量结果
      const combinedMarkdown = results
        .filter(r => r.success && r.markdown)
        .map(r => `<!-- Source: ${r.url} -->\n${r.markdown}`)
        .join('\n\n---\n\n');

      return {
        success: successCount > 0,
        message: `批量提取完成: ${successCount} 成功, ${failCount} 失败`,
        data: {
          totalCount: urlList.length,
          successCount,
          failCount,
          results,
          combinedMarkdown
        },
        content: [{
          type: 'text',
          text: combinedMarkdown || '没有成功提取的内容'
        }]
      };
      
    } catch (error: any) {
      this.log(`页面 Markdown 提取失败: ${error.message}`, 'error');
      
      return {
        success: false,
        message: `提取失败: ${error.message}`,
        error: error.message,
        isError: true,
        content: [{
          type: 'text',
          text: `提取失败: ${error.message}`
        }]
      };
    }
  }

  /**
   * 带锁的URL处理（并发控制）
   */
  private async processUrlWithLock(
    urlArg: string,
    index: number,
    currentTab: chrome.tabs.Tab,
    includeMetadata: boolean
  ): Promise<UrlExtractionResult> {
    // 获取并发锁
    await acquireLock();
    this.log(`[${index}] 获取锁，开始处理: ${urlArg}`);
    
    try {
      return await this.processSingleUrl(urlArg, currentTab, includeMetadata);
    } finally {
      releaseLock();
      this.log(`[${index}] 释放锁，完成处理: ${urlArg}`);
    }
  }

  /**
   * 处理单个URL
   */
  private async processSingleUrl(
    urlArg: string,
    currentTab: chrome.tabs.Tab,
    includeMetadata: boolean
  ): Promise<UrlExtractionResult> {
    const isCurrentPage = !urlArg || 
                         urlArg === 'current' || 
                         urlArg === 'null' ||
                         urlArg === currentTab.url;

    let targetTabId: number;
    let needCloseTab = false;

    try {
      if (isCurrentPage) {
        targetTabId = currentTab.id!;
      } else {
        needCloseTab = true;
        
        const newTab = await chrome.tabs.create({ 
          url: urlArg, 
          active: false
        });
        
        if (!newTab.id) {
          throw new Error('无法创建新标签页');
        }
        
        targetTabId = newTab.id;
        
        await this.waitForTabLoad(targetTabId, 30000);
        
        const statusCheckResult = await this.checkPageStatus(targetTabId);
        
        if (!statusCheckResult.success) {
          await chrome.tabs.remove(targetTabId);
          return {
            url: urlArg,
            success: false,
            error: statusCheckResult.message
          };
        }
      }

      // 注入脚本执行内容提取
      const results = await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        func: extractPageMarkdownFunc,
        args: [null, includeMetadata]
      });

      const markdown = results[0]?.result || '';
      const targetTab = await chrome.tabs.get(targetTabId);
      
      if (needCloseTab) {
        await chrome.tabs.remove(targetTabId);
      }
      
      return {
        url: targetTab.url || urlArg,
        success: true,
        markdown,
        title: targetTab.title,
        length: markdown.length
      };
      
    } catch (error: any) {
      // 确保关闭标签页
      if (needCloseTab && targetTabId!) {
        try {
          await chrome.tabs.remove(targetTabId);
        } catch (e) {
          // 忽略关闭错误
        }
      }
      
      return {
        url: urlArg,
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 等待标签页加载完成
   */
  private waitForTabLoad(tabId: number, timeout: number = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      const checkStatus = async () => {
        try {
          const tab = await chrome.tabs.get(tabId);
          
          if (tab.status === 'complete') {
            resolve();
            return;
          }
          
          if (Date.now() - startTime > timeout) {
            reject(new Error('页面加载超时'));
            return;
          }
          
          // 继续等待
          setTimeout(checkStatus, 200);
        } catch (error) {
          reject(error);
        }
      };
      
      checkStatus();
    });
  }

  /**
   * 检查页面HTTP状态（通过页面内容判断）
   */
  private async checkPageStatus(tabId: number): Promise<{ success: boolean; message: string; error?: string }> {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // 检查页面是否包含常见的错误指示
          const title = document.title.toLowerCase();
          const bodyText = document.body?.innerText?.toLowerCase() || '';
          
          // 检查404错误
          if (title.includes('404') || title.includes('not found') ||
              bodyText.includes('404') && bodyText.includes('not found')) {
            return { isError: true, code: 404, message: '页面不存在 (404 Not Found)' };
          }
          
          // 检查503错误
          if (title.includes('503') || title.includes('service unavailable') ||
              bodyText.includes('503') && bodyText.includes('service unavailable')) {
            return { isError: true, code: 503, message: '服务暂时不可用 (503 Service Unavailable)' };
          }
          
          // 检查500错误
          if (title.includes('500') || title.includes('internal server error') ||
              bodyText.includes('500') && bodyText.includes('internal server error')) {
            return { isError: true, code: 500, message: '服务器内部错误 (500 Internal Server Error)' };
          }
          
          // 检查502错误
          if (title.includes('502') || title.includes('bad gateway')) {
            return { isError: true, code: 502, message: '网关错误 (502 Bad Gateway)' };
          }
          
          // 检查403错误
          if (title.includes('403') || title.includes('forbidden') ||
              bodyText.includes('403') && bodyText.includes('forbidden')) {
            return { isError: true, code: 403, message: '禁止访问 (403 Forbidden)' };
          }
          
          // 检查连接错误
          if (title.includes('err_') || title.includes('无法访问') || 
              title.includes('cannot be reached') || title.includes('connection refused')) {
            return { isError: true, code: 0, message: '无法连接到网站' };
          }
          
          return { isError: false, code: 200, message: 'OK' };
        }
      });
      
      const statusResult = results[0]?.result;
      
      if (statusResult?.isError) {
        return {
          success: false,
          message: statusResult.message,
          error: `HTTP ${statusResult.code}`
        };
      }
      
      return { success: true, message: 'OK' };
      
    } catch (error: any) {
      return {
        success: false,
        message: `页面状态检查失败: ${error.message}`,
        error: error.message
      };
    }
  }
}

/**
 * 独立的提取函数（用于注入到页面上下文）
 * 必须是独立函数才能被 chrome.scripting.executeScript 序列化
 */
function extractPageMarkdownFunc(selector: string | null, includeMetadata: boolean = true): string {
    // ============ 配置 ============
    
    // 只在顶层过滤的元素（不会递归检查父元素）
    const IGNORED_TAGS = new Set([
      'script', 'style', 'noscript', 'iframe', 'embed', 'object', 
      'svg', 'canvas', 'video', 'audio', 'template'
    ]);
    
    // 页脚相关的选择器（只在顶层判断）
    const FOOTER_SELECTORS = [
      'footer', '.footer', '#footer', '.site-footer',
      '[role="contentinfo"]'
    ];
    
    // 页脚文本特征
    const FOOTER_TEXT_PATTERNS = [
      /©\s*\d{4}/i,
      /All Rights Reserved/i,
      /Terms of Service/i,
      /Privacy Policy/i,
      /Cookie Preferences/i
    ];
    
    // ============ 辅助函数 ============
    
    const cleanText = (text: string): string => {
      return text.replace(/\s+/g, ' ').trim();
    };
    
    const isHidden = (el: HTMLElement): boolean => {
      const style = window.getComputedStyle(el);
      return style.display === 'none' || 
             style.visibility === 'hidden' || 
             (style.opacity === '0' && !el.querySelector('*'));
    };
    
    const isFooterElement = (el: Element): boolean => {
      // 检查是否匹配页脚选择器
      for (const sel of FOOTER_SELECTORS) {
        if (el.matches?.(sel)) return true;
      }
      
      // 检查文本是否包含页脚特征
      const text = el.textContent || '';
      if (text.length < 500) { // 只对短文本检查
        for (const pattern of FOOTER_TEXT_PATTERNS) {
          if (pattern.test(text)) return true;
        }
      }
      
      return false;
    };
    
    // 处理已访问的元素，避免重复
    const visited = new WeakSet<Node>();
    
    // ============ 转换函数 ============
    
    const convertNode = (node: Node, depth: number = 0): string => {
      if (visited.has(node)) return '';
      visited.add(node);
      
      // 文本节点
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || '';
        return cleanText(text);
      }
      
      if (node.nodeType !== Node.ELEMENT_NODE) {
        return '';
      }
      
      const el = node as HTMLElement;
      const tagName = el.tagName.toLowerCase();
      
      // 跳过忽略的标签
      if (IGNORED_TAGS.has(tagName)) {
        return '';
      }
      
      // 跳过隐藏元素
      if (isHidden(el)) {
        return '';
      }
      
      // 顶层检查页脚（只在深度小于3时检查）
      if (depth < 3 && isFooterElement(el)) {
        return '';
      }
      
      let result = '';
      
      // 根据标签类型处理
      switch (tagName) {
        // 标题
        case 'h1':
          result = `\n# ${cleanText(el.textContent || '')}\n\n`;
          break;
        case 'h2':
          result = `\n## ${cleanText(el.textContent || '')}\n\n`;
          break;
        case 'h3':
          result = `\n### ${cleanText(el.textContent || '')}\n\n`;
          break;
        case 'h4':
          result = `\n#### ${cleanText(el.textContent || '')}\n\n`;
          break;
        case 'h5':
          result = `\n##### ${cleanText(el.textContent || '')}\n\n`;
          break;
        case 'h6':
          result = `\n###### ${cleanText(el.textContent || '')}\n\n`;
          break;
          
        // 段落
        case 'p': {
          const pContent = processChildren(el, depth);
          if (pContent.trim()) {
            result = `${pContent}\n\n`;
          }
          break;
        }
          
        // 链接
        case 'a': {
          const href = (el as HTMLAnchorElement).href;
          const linkText = processChildren(el, depth) || cleanText(el.textContent || '');
          if (linkText.trim()) {
            if (href && !href.startsWith('javascript:')) {
              result = `[${linkText.trim()}](${href})`;
            } else {
              result = linkText;
            }
          }
          break;
        }
          
        // 强调
        case 'strong':
        case 'b': {
          const boldText = processChildren(el, depth);
          if (boldText.trim()) {
            result = `**${boldText.trim()}**`;
          }
          break;
        }
          
        case 'em':
        case 'i': {
          const italicText = processChildren(el, depth);
          if (italicText.trim()) {
            result = `*${italicText.trim()}*`;
          }
          break;
        }
          
        // 代码
        case 'code':
          if (el.parentElement?.tagName.toLowerCase() !== 'pre') {
            result = `\`${el.textContent || ''}\``;
          } else {
            result = el.textContent || '';
          }
          break;
          
        case 'pre': {
          const codeEl = el.querySelector('code');
          const codeText = codeEl?.textContent || el.textContent || '';
          let lang = '';
          if (codeEl) {
            const langClass = Array.from(codeEl.classList).find(c => c.startsWith('language-'));
            if (langClass) lang = langClass.replace('language-', '');
          }
          result = `\n\`\`\`${lang}\n${codeText}\n\`\`\`\n\n`;
          break;
        }
          
        // 列表
        case 'ul':
          result = '\n' + convertList(el, false) + '\n';
          break;
          
        case 'ol':
          result = '\n' + convertList(el, true) + '\n';
          break;
          
        case 'li':
          // li 由 convertList 处理
          result = processChildren(el, depth);
          break;
          
        // 表格
        case 'table':
          result = convertTable(el as HTMLTableElement);
          break;
          
        // 引用
        case 'blockquote': {
          const quoteContent = processChildren(el, depth);
          if (quoteContent.trim()) {
            result = quoteContent.split('\n')
              .filter(line => line.trim())
              .map(line => `> ${line}`)
              .join('\n') + '\n\n';
          }
          break;
        }
          
        // 水平线
        case 'hr':
          result = '\n---\n\n';
          break;
          
        // 换行
        case 'br':
          result = '  \n';
          break;
          
        // 图片
        case 'img': {
          const img = el as HTMLImageElement;
          const alt = img.alt || 'image';
          const src = img.src;
          // 过滤 base64 编码的图片
          if (src && !src.startsWith('data:')) {
            result = `![${alt}](${src})`;
          }
          break;
        }
          
        // 删除线
        case 'del':
        case 's':
          result = `~~${processChildren(el, depth)}~~`;
          break;
          
        // 容器元素 - 递归处理
        case 'div':
        case 'section':
        case 'article':
        case 'main':
        case 'aside':
        case 'header':
        case 'span':
        case 'nav': // 不过滤导航，让内容完整
        case 'details':
        case 'summary':
        case 'figure':
        case 'figcaption':
        case 'form':
        case 'fieldset':
        case 'legend':
        case 'label':
        case 'td':
        case 'th':
        case 'tbody':
        case 'thead':
        case 'tfoot':
        case 'tr':
          result = processChildren(el, depth);
          break;
          
        // 按钮 - 提取文本
        case 'button': {
          const btnText = cleanText(el.textContent || '');
          if (btnText) {
            result = `[${btnText}]`;
          }
          break;
        }
          
        // 输入框 - 显示占位符或值
        case 'input': {
          const input = el as HTMLInputElement;
          if (input.type === 'text' || input.type === 'search') {
            const placeholder = input.placeholder || input.value;
            if (placeholder) {
              result = `[输入框: ${placeholder}]`;
            }
          }
          break;
        }
          
        // 其他元素 - 递归处理子节点
        default:
          result = processChildren(el, depth);
      }
      
      return result;
    };
    
    const processChildren = (el: Element, depth: number): string => {
      let result = '';
      for (const child of Array.from(el.childNodes)) {
        result += convertNode(child, depth + 1);
      }
      return result;
    };
    
    const convertList = (list: HTMLElement, ordered: boolean, indent: number = 0): string => {
      let result = '';
      const items = Array.from(list.children).filter(child => child.tagName.toLowerCase() === 'li');
      
      items.forEach((item, index) => {
        const prefix = ordered ? `${index + 1}. ` : '- ';
        const indentStr = '  '.repeat(indent);
        
        // 提取直接内容（不包括嵌套列表）
        let itemContent = '';
        for (const child of Array.from(item.childNodes)) {
          const childTag = (child as Element).tagName?.toLowerCase();
          if (childTag === 'ul' || childTag === 'ol') continue;
          itemContent += convertNode(child, 0);
        }
        
        result += `${indentStr}${prefix}${itemContent.trim()}\n`;
        
        // 处理嵌套列表
        for (const child of Array.from(item.children)) {
          const childTag = child.tagName.toLowerCase();
          if (childTag === 'ul') {
            result += convertList(child as HTMLElement, false, indent + 1);
          } else if (childTag === 'ol') {
            result += convertList(child as HTMLElement, true, indent + 1);
          }
        }
      });
      
      return result;
    };
    
    const convertTable = (table: HTMLTableElement): string => {
      const rows: string[][] = [];
      let hasHeader = false;
      
      // 收集所有行
      const allRows = table.querySelectorAll('tr');
      allRows.forEach((row, rowIndex) => {
        const cells: string[] = [];
        row.querySelectorAll('th, td').forEach(cell => {
          cells.push(cleanText(cell.textContent || ''));
        });
        if (cells.length > 0 && cells.some(c => c.trim())) {
          rows.push(cells);
          if (row.querySelector('th')) hasHeader = true;
        }
      });
      
      if (rows.length === 0) return '';
      
      // 确定最大列数
      const maxCols = Math.max(...rows.map(r => r.length));
      
      // 标准化行
      rows.forEach(row => {
        while (row.length < maxCols) row.push('');
      });
      
      let result = '\n';
      
      // 第一行作为表头
      result += '| ' + rows[0].join(' | ') + ' |\n';
      result += '| ' + rows[0].map(() => '---').join(' | ') + ' |\n';
      
      // 数据行
      for (let i = 1; i < rows.length; i++) {
        result += '| ' + rows[i].join(' | ') + ' |\n';
      }
      
      return result + '\n';
    };
    
    // ============ 主逻辑 ============
    
    let markdown = '';
    
    // 元数据
    if (includeMetadata) {
      markdown += `# ${document.title}\n\n`;
      markdown += `**URL:** ${window.location.href}\n\n`;
      markdown += `---\n\n`;
    }
    
    // 确定根元素
    let root: Element;
    if (selector) {
      root = document.querySelector(selector) || document.body;
    } else {
      // 默认使用 body，确保不遗漏内容
      root = document.body;
    }
    
    // 转换
    markdown += processChildren(root, 0);
    
    // 清理
    markdown = markdown
      .replace(/\n{3,}/g, '\n\n')  // 多余空行
      .replace(/\s+$/gm, '')       // 行尾空白
      .trim();
    
    return markdown;
  }
