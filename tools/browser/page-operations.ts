/**
 * 页面操作工具
 * 提供页面滚动、等待元素等功能
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata, type ToolExecutionContext } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';

/**
 * 页面滚动工具
 */
export class ScrollTool extends BaseBrowserTool {
  name = 'browser_scroll';

  metadata: ToolMetadata = {
    name: 'browser_scroll',
    description: '滚动页面',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'page', 'scroll']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: '滚动页面。支持按屏滚动（以视口高度为单位），可选择先点击指定坐标区域',
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['up', 'down'],
            description: '滚动方向：up（向上）、down（向下）'
          },
          screens: {
            type: 'number',
            description: '滚动屏数（以视口高度为单位），如 1、2、3。实际滚动距离 = 视口高度 × 95% × 屏数',
            default: 1
          },
          clickBox: {
            type: 'array',
            items: { type: 'number' },
            description: '点击坐标（box2d格式: [x1, y1, x2, y2]），选填。如有值，将在滚动前先点击该区域中心点',
            minItems: 4,
            maxItems: 4
          },
          tabId: {
            type: 'number',
            description: '标签页 ID（可选，默认当前活动标签页）'
          }
        },
        required: ['direction']
      }
    }
  };

  async execute(args: { 
    direction: 'up' | 'down'; 
    screens?: number;
    clickBox?: [number, number, number, number];
    tabId?: number;
  }, context?: ToolExecutionContext): Promise<ToolResult> {
    this.ensureBackgroundContext();

    try {
      this.validateArgs(args, ['direction']);

      const tab = args.tabId 
        ? await chrome.tabs.get(args.tabId)
        : await this.getActiveTab();

      if (!tab || !tab.id) {
        return this.createErrorResponse('No active tab found');
      }

      const { direction, screens = 1, clickBox } = args;

      // 验证 clickBox 格式
      if (clickBox && clickBox.length !== 4) {
        return this.createErrorResponse('clickBox must be in [x1, y1, x2, y2] format');
      }

      if (args.tabId !== undefined) context?.onTabTarget?.(tab.id);

      // 执行滚动脚本（确保 clickBox 可序列化）
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [direction, screens, clickBox || null],
        func: (dir: string, screenCount: number, box: [number, number, number, number] | null) => {
          // 如果有点击坐标，先点击
          if (box) {
            const [x1, y1, x2, y2] = box;
            const centerX = (x1 + x2) / 2;
            const centerY = (y1 + y2) / 2;
            
            // 创建并触发点击事件
            const element = document.elementFromPoint(centerX, centerY);
            if (element) {
              const clickEvent = new MouseEvent('click', {
                view: window,
                bubbles: true,
                cancelable: true,
                clientX: centerX,
                clientY: centerY
              });
              element.dispatchEvent(clickEvent);
            }
          }

          // 计算滚动距离：视口高度 × 95% × 屏数
          const viewportHeight = window.innerHeight;
          const scrollDistance = viewportHeight * 0.95 * screenCount;
          
          // 根据方向计算实际滚动值
          const scrollY = dir === 'up' ? -scrollDistance : scrollDistance;
          
          // 执行滚动
          window.scrollBy({ top: scrollY, behavior: 'smooth' });
          
          return { 
            scrolled: true, 
            direction: dir,
            screens: screenCount,
            viewportHeight,
            scrollDistance: Math.abs(scrollY),
            clicked: !!box,
            clickPosition: box ? { x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2 } : null,
            position: { x: window.scrollX, y: window.scrollY } 
          };
        }
      });

      const result = results?.[0]?.result;

      return this.createSuccessResponse({
        tabId: tab.id,
        direction,
        screens,
        clickBox,
        ...result
      }, `Page scrolled ${direction} by ${screens} screen(s)`);
    } catch (error) {
      return this.createErrorResponse('Failed to scroll page', error);
    }
  }
}

/**
 * 等待元素工具
 */
export class WaitForElementTool extends BaseBrowserTool {
  name = 'browser_wait_for_element';

  metadata: ToolMetadata = {
    name: 'browser_wait_for_element',
    description: '等待页面元素出现',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'page', 'wait', 'element']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_wait_for_element',
      description: '等待页面中的指定元素出现',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS 选择器'
          },
          timeout: {
            type: 'number',
            description: '超时时间（毫秒），默认 5000'
          },
          tabId: {
            type: 'number',
            description: '标签页 ID（可选，默认当前活动标签页）'
          }
        },
        required: ['selector']
      }
    }
  };

  async execute(args: { 
    selector: string; 
    timeout?: number;
    tabId?: number;
  }, context?: ToolExecutionContext): Promise<ToolResult> {
    this.ensureBackgroundContext();

    try {
      this.validateArgs(args, ['selector']);

      const tab = args.tabId 
        ? await chrome.tabs.get(args.tabId)
        : await this.getActiveTab();

      if (!tab || !tab.id) {
        return this.createErrorResponse('No active tab found');
      }

      const { selector, timeout = 5000 } = args;

      if (args.tabId !== undefined) context?.onTabTarget?.(tab.id);

      // 执行等待脚本
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [selector, timeout],
        func: async (sel: string, time: number) => {
          const startTime = Date.now();
          
          while (Date.now() - startTime < time) {
            const element = document.querySelector(sel);
            if (element) {
              return {
                found: true,
                waitTime: Date.now() - startTime,
                elementInfo: {
                  tagName: element.tagName,
                  id: element.id,
                  className: element.className,
                  textContent: element.textContent?.slice(0, 100)
                }
              };
            }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          
          return { found: false, waitTime: Date.now() - startTime };
        }
      });

      const result = results?.[0]?.result;

      if (result?.found) {
        return this.createSuccessResponse({
          tabId: tab.id,
          selector,
          ...result
        }, `Element found after ${result.waitTime}ms`);
      } else {
        return this.createErrorResponse(`Element not found within ${timeout}ms`);
      }
    } catch (error) {
      return this.createErrorResponse('Failed to wait for element', error);
    }
  }
}

// 导出工具实例
export const scrollTool = new ScrollTool();
export const waitForElementTool = new WaitForElementTool();
