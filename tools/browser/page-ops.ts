/**
 * 页面就绪与滚动工具（browser_page_ops）
 *
 * 合并掉的旧工具（**旧名全仓禁绝**，防回潮断言见 tests/tools/tools.test.ts）：
 *   - browser_scroll            按视口高度倍数滚动整页（可选先点击坐标区再滚）
 *   - browser_wait_for_element  轮询等待某个 CSS 选择器出现
 *
 * 合并理由：两者都是**不需要 DOM 引用体系**的轻量页面操作——一个改视口、
 * 一个等条件，都是「对页面做一件事然后回报状态」，与 browser_interact 的
 * 引用式交互（必须带 elementId + frameId）是两套不同的定位方式。合成一个
 * 工具后，模型只需记「要滚就 scroll、要等就 wait_element」两个 action，
 * 而不用在两个名字之间挑。
 *
 * 与其它工具的边界（**刻意不合并**）：
 *   - browser_interact  引用式交互（点击/填充/按键）：必须带 observe 得到的引用，
 *                        且有审批门与 exclusiveText 互斥队列；
 *   - generic_wait      纯时间等待（不针对任何页面条件）；
 *   - browser_navigation(action="wait")  等待页面加载就绪（就绪判定单一来源）。
 *
 * 防御性约定：
 *   - 滚动量与等待时长有界（滚动 ≤ 100 屏 / 单次等待 ≤ 120s），超时给出
 *     精确原因而不是笼统失败；
 *   - 选择器非法时给出可读错误（不静默失败），非法选择器由页面抛错时原样
 *     转述其原因；
 *   - 任何失败都以带原因的结果返回，绝不向调用方抛出异常。
 */

import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata, type ToolExecutionContext } from '../registry';
import type { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import {
  checkActionMatrix,
  readNonEmptyStringField,
  readNumberField,
} from './action-args';

/** 两个 action（schema 枚举与运行期校验同源） */
export const PAGE_OPS_ACTIONS = ['scroll', 'wait_element'] as const;
export type PageOpsAction = (typeof PAGE_OPS_ACTIONS)[number];

/** 每个 action 允许出现的参数（运行期矩阵，防拼写错误与张冠李戴静默失效） */
const ACTION_PARAMS: Record<PageOpsAction, readonly string[]> = {
  scroll: ['direction', 'screens', 'clickBox', 'tabId'],
  wait_element: ['selector', 'timeout', 'tabId'],
};

/** 单次滚动上限（屏） */
const MAX_SCREENS = 100;
/** 单次等待上限（毫秒） */
const MAX_WAIT_MS = 120_000;

interface PageOpsArgs {
  action: PageOpsAction;
  direction?: 'up' | 'down';
  screens?: number;
  clickBox?: [number, number, number, number];
  selector?: string;
  timeout?: number;
  tabId?: number;
}

type ValidationResult = { error: ToolResult; args?: never } | { error?: never; args: PageOpsArgs };

/**
 * 页面就绪与滚动工具
 */
export class BrowserPageOpsTool extends BaseBrowserTool {
  name = 'browser_page_ops';

  metadata: ToolMetadata = {
    name: 'browser_page_ops',
    description: '轻量页面操作：按屏滚动整页 / 等待指定元素出现（action 驱动，无需 DOM 引用）',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'scroll', 'wait', 'element', 'page'],
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_page_ops',
      description:
        '不需要 DOM 引用的轻量页面操作，action 二选一：' +
        'scroll=按视口高度倍数滚动整页（direction=up/down，screens 默认 1，上限 100 屏；' +
        'clickBox 可选，先点击该区域中心再滚动）；' +
        'wait_element=等待满足 CSS 选择器的元素出现（selector 必填，timeout 默认 5000ms、上限 120000ms；' +
        '超时返回精确原因与已等待时长）。' +
        '需要点击/填充具体控件、或需要容器内滚动时用 browser_interact（必须带 observe 返回的引用）。' +
        '纯时间等待（不针对任何元素条件）用 generic_wait。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: [...PAGE_OPS_ACTIONS],
            description: 'scroll=按屏滚动整页；wait_element=等待元素出现',
          },
          direction: {
            type: 'string',
            enum: ['up', 'down'],
            description: '仅 action="scroll"：滚动方向',
          },
          screens: {
            type: 'number',
            description: `仅 action="scroll"：滚动屏数（以视口高度为单位，默认 1，上限 ${MAX_SCREENS}）`,
            default: 1
          },
          clickBox: {
            type: 'array',
            items: { type: 'number' },
            description: '仅 action="scroll"：可选的点击区域（box2d 格式 [x1,y1,x2,y2]，滚动前先点击其中心）',
            minItems: 4,
            maxItems: 4
          },
          selector: {
            type: 'string',
            description: '仅 action="wait_element"：要等待的 CSS 选择器',
            placeholder: '.result-list'
          },
          timeout: {
            type: 'number',
            description: `仅 action="wait_element"：等待上限（毫秒，默认 5000，上限 ${MAX_WAIT_MS}）`,
            default: 5000
          },
          tabId: {
            type: 'number',
            description: '标签页 ID（可选，默认当前活动标签页）'
          },
        },
        required: ['action'],
      },
    },
  };

  async execute(rawArgs: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
    this.ensureBackgroundContext();

    const validated = this.validate(rawArgs);
    if (validated.error) return validated.error;
    const args = validated.args;

    try {
      switch (args.action) {
        case 'scroll':
          return await this.handleScroll(args, context);
        case 'wait_element':
          return await this.handleWaitElement(args, context);
      }
    } catch (error) {
      return this.createErrorResponse(
        `页面操作 ${args.action} 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ──── 参数校验 ────

  private validate(rawArgs: unknown): ValidationResult {
    const matrix = checkActionMatrix<PageOpsAction>(rawArgs, {
      actions: PAGE_OPS_ACTIONS,
      params: ACTION_PARAMS,
    });
    if (!matrix.ok) return { error: this.createErrorResponse(matrix.error) };
    const { action, input } = matrix;

    const args: PageOpsArgs = { action };

    if (input.direction !== undefined) {
      if (input.direction !== 'up' && input.direction !== 'down') {
        return {
          error: this.createErrorResponse(
            `direction 必须是 "up" 或 "down"，实际收到 ${JSON.stringify(input.direction ?? null)}`,
          ),
        };
      }
      args.direction = input.direction;
    }

    const screens = readNumberField(input, 'screens', { min: 1, max: MAX_SCREENS, integer: true });
    if (!screens.ok) return { error: this.createErrorResponse(screens.error) };
    if (screens.value !== undefined) args.screens = screens.value;

    const timeout = readNumberField(input, 'timeout', { min: 1, max: MAX_WAIT_MS, integer: true });
    if (!timeout.ok) return { error: this.createErrorResponse(timeout.error) };
    if (timeout.value !== undefined) args.timeout = timeout.value;

    const tabId = readNumberField(input, 'tabId', { min: 0, integer: true });
    if (!tabId.ok) return { error: this.createErrorResponse(tabId.error) };
    if (tabId.value !== undefined) args.tabId = tabId.value;

    const selector = readNonEmptyStringField(input, 'selector');
    if (!selector.ok) return { error: this.createErrorResponse(selector.error) };
    if (selector.value !== undefined) args.selector = selector.value;

    if (input.clickBox !== undefined) {
      const box = input.clickBox;
      const valid =
        Array.isArray(box) &&
        box.length === 4 &&
        box.every(item => typeof item === 'number' && Number.isFinite(item));
      if (!valid) {
        return {
          error: this.createErrorResponse(
            `clickBox 必须是 4 个有限数字组成的 box2d 坐标 [x1,y1,x2,y2]，实际收到 ${JSON.stringify(box ?? null)}`,
          ),
        };
      }
      args.clickBox = box as [number, number, number, number];
    }

    if (action === 'scroll' && args.direction === undefined) {
      return { error: this.createErrorResponse('action="scroll" 需要 direction（up 或 down）') };
    }
    if (action === 'wait_element' && !args.selector) {
      return { error: this.createErrorResponse('action="wait_element" 需要 selector（要等待的 CSS 选择器）') };
    }

    return { args };
  }

  // ──── action 实现 ────

  /** scroll：按视口高度倍数滚动整页 */
  private async handleScroll(args: PageOpsArgs, context?: ToolExecutionContext): Promise<ToolResult> {
    const tab = args.tabId !== undefined
      ? await chrome.tabs.get(args.tabId)
      : await this.getActiveTab();

    if (!tab || typeof tab.id !== 'number') {
      return this.createErrorResponse(
        args.tabId !== undefined
          ? `标签页 ${args.tabId} 不存在或已关闭`
          : '没有可用的活动标签页',
      );
    }
    if (args.tabId !== undefined) context?.onTabTarget?.(tab.id);

    const direction = args.direction!;
    const screens = args.screens ?? 1;
    const clickBox = args.clickBox ?? null;

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [direction, screens, clickBox],
      func: (dir: string, screenCount: number, box: [number, number, number, number] | null) => {
        // 可选：先点击区域中心（页面元素可能不在当前视口内，需要先激活）
        let clicked = false;
        let clickPosition: { x: number; y: number } | null = null;
        if (box) {
          const centerX = (box[0] + box[2]) / 2;
          const centerY = (box[1] + box[3]) / 2;
          const element = document.elementFromPoint(centerX, centerY);
          if (element) {
            element.dispatchEvent(
              new MouseEvent('click', {
                view: window,
                bubbles: true,
                cancelable: true,
                clientX: centerX,
                clientY: centerY,
              }),
            );
            clicked = true;
            clickPosition = { x: centerX, y: centerY };
          }
        }

        const viewportHeight = window.innerHeight;
        const scrollDistance = viewportHeight * 0.95 * screenCount;
        const scrollY = dir === 'up' ? -scrollDistance : scrollDistance;
        window.scrollBy({ top: scrollY, behavior: 'smooth' });

        return {
          scrolled: true,
          direction: dir,
          screens: screenCount,
          viewportHeight,
          scrollDistance: Math.abs(scrollY),
          clicked,
          clickPosition,
          position: { x: window.scrollX, y: window.scrollY },
        };
      },
    });

    const result = results?.[0]?.result as Record<string, unknown> | undefined;

    return this.createSuccessResponse(
      {
        tabId: tab.id,
        direction,
        screens,
        clickBox: args.clickBox ?? null,
        ...(result ?? {}),
      },
      `已按 ${direction} 方向滚动 ${screens} 屏`,
    );
  }

  /** wait_element：等待满足 CSS 选择器的元素出现 */
  private async handleWaitElement(args: PageOpsArgs, context?: ToolExecutionContext): Promise<ToolResult> {
    const tab = args.tabId !== undefined
      ? await chrome.tabs.get(args.tabId)
      : await this.getActiveTab();

    if (!tab || typeof tab.id !== 'number') {
      return this.createErrorResponse(
        args.tabId !== undefined
          ? `标签页 ${args.tabId} 不存在或已关闭`
          : '没有可用的活动标签页',
      );
    }
    if (args.tabId !== undefined) context?.onTabTarget?.(tab.id);

    const selector = args.selector!;
    const timeout = args.timeout ?? 5000;

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [selector, timeout],
      func: async (sel: string, time: number) => {
        const start = Date.now();
        // 选择器非法时 querySelector 抛错——原样上抛，由调用方转成可读错误
        while (Date.now() - start < time) {
          const element = document.querySelector(sel);
          if (element) {
            return {
              found: true,
              waitTime: Date.now() - start,
              elementInfo: {
                tagName: element.tagName,
                id: element.id,
                className: element.className,
                textContent: element.textContent?.slice(0, 100),
              },
            };
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return { found: false, waitTime: Date.now() - start };
      },
    });

    const result = results?.[0]?.result as { found?: boolean; waitTime?: number; elementInfo?: Record<string, unknown> } | undefined;

    if (!result || result.found !== true) {
      const waited = result?.waitTime ?? timeout;
      return this.createErrorResponse(
        `等待 ${timeout}ms 内未出现满足「${selector}」的元素（已等待 ${waited}ms）——页面可能仍在加载，或选择器与实际 DOM 不符`,
      );
    }

    return this.createSuccessResponse(
      {
        tabId: tab.id,
        selector,
        timeout,
        waitTime: result.waitTime,
        elementInfo: result.elementInfo,
      },
      `元素在 ${result.waitTime}ms 后出现`,
    );
  }
}

// 导出工具实例
export const browserPageOpsTool = new BrowserPageOpsTool();
