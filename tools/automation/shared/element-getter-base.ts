/**
 * 可交互元素获取工具宿主基类
 * （interactive_button_getter / interactive_input_getter 共用）
 *
 * 两个工具的宿主侧流程完全同构：参数归一 → 标签页与受限页检查 → 多槽缓存
 * （tabId|url|过滤条件 键 + 跨 frame 页面指纹校验）→ 注入 payload 全帧采集 →
 * 跨 frame 排序 → 分页（越界回退）→ 过滤提示 → Markdown 表格响应。
 * 差异仅剩：扫描模式（buttons/inputs）、文案名词、openaiSchema 与 metadata——
 * 全部由子类以声明方式提供，execute 主流程只存在一份。
 */

import { BaseTool } from '../../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { isRestrictedUrl } from '@/common/constants';
import {
  elementScanPayload,
  type PayloadElement,
  type PayloadResult,
  type ScanMode,
} from './element-scan-payload';

/** 元素记录（payload 返回 + 宿主补写 frameId） */
export interface ScannedElement extends PayloadElement {
  /** 采集到该元素的 frame（0 = 主页面） */
  frameId: number;
}

/** 内存缓存条目：相同标签页 + 相同 URL + 相同过滤条件 + 页面指纹未变时直接读缓存，保证 page 参数真实生效 */
interface CachedResult {
  /** 缓存所属标签页 ID：防止同 URL 的不同标签页互相污染 */
  tabId: number;
  /** 缓存时的标签页 URL：导航后立即失效 */
  url: string;
  /** 过滤条件指纹：regex 与 xpath 的组合 */
  queryKey: string;
  /** 页面指纹：逐 frame 的 readyState|元素总数|滚动高度 拼接，DOM 或 frame 集合变化即失效 */
  fingerprint: string;
  /** 采集时刻（TTL 从采集算起，命中不刷新，避免陈旧数据永不过期） */
  timestamp: number;
  elements: ScannedElement[];
}

/** 每页返回的元素数量上限 */
const PAGE_SIZE = 40;
/** 缓存有效期（毫秒） */
const CACHE_TTL_MS = 120_000;
/** 缓存槽位上限（按最旧淘汰，支持多标签页/多过滤条件并存不互相挤占） */
const CACHE_MAX_ENTRIES = 8;
/** 过滤/空白页提示中的示例站点 */
const EXAMPLE_URL = 'https://www.bing.com/';

/**
 * Markdown 单元格转义：
 * - `|` 换为 `\|`（表格列分隔符）；
 * - 换行压成空格；
 * - 反引号换为直引号——选择器被包进 code span，反引号会提前闭合围栏破坏表格结构
 *   （code span 内不处理反斜杠转义，必须替换字符本身）。
 */
function escapeMarkdownCell(str: string): string {
  return str.replace(/\|/g, '\\|').replace(/\n/g, ' ').replace(/`/g, "'");
}

export abstract class BaseElementGetterTool extends BaseTool {
  /** 页面内注入的扫描模式（决定采集范围与描述提取策略） */
  protected abstract readonly scanMode: ScanMode;
  /** 日志标签（含版本号），如「可交互按钮/链接 (v4.1)」 */
  protected abstract readonly scanLabel: string;
  /** 计数名词，如「元素」/「输入元素」 */
  protected abstract readonly elementUnit: string;
  /** 错误文案中的工具指代，如「可交互按钮」/「可交互输入」 */
  protected abstract readonly errorLabel: string;

  // 缓存（多槽 LRU：键 = tabId|url|过滤条件，最多 CACHE_MAX_ENTRIES 个，按最旧淘汰）
  private cache = new Map<string, CachedResult>();

  /**
   * 获取轻量页面指纹（跨所有 frame）：逐 frame 的 readyState|元素总数|滚动高度，
   * 按 frameId 排序拼接。任一 frame 的 DOM 变化或 frame 集合变化都会改变指纹。
   * 仅用于缓存命中校验；缓存写入时的指纹取自采集 payload 自身（同一时刻快照）。
   */
  private async getPageFingerprint(tabId: number): Promise<string | null> {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => `${document.readyState}|${document.getElementsByTagName('*').length}|${document.body ? document.body.scrollHeight : 0}`
      });
      if (!results || results.length === 0) return null;
      // 按 frameId 排序保证拼接顺序稳定（与采集侧 frameFingerprints.sort() 同口径）
      return results
        .map(r => `${r.frameId}:${r.result ?? ''}`)
        .sort()
        .join('§');
    } catch {
      return null;
    }
  }

  /**
   * 将元素数组转换为 Markdown 表格格式
   * 节省 token 同时保证强结构性；启用过滤时追加 Hit 列
   */
  private formatElementsAsMarkdown(elements: ScannedElement[], hasFilter: boolean): string {
    if (elements.length === 0) {
      return '_No elements found_';
    }

    const lines: string[] = [];

    lines.push(hasFilter
      ? '| # | Type | Description | Selector | FrameId | Hit |'
      : '| # | Type | Description | Selector | FrameId |');
    lines.push(hasFilter
      ? '|---|------|-------------|----------|---------|-----|'
      : '|---|------|-------------|----------|---------|');

    elements.forEach((el, index) => {
      const desc = escapeMarkdownCell(el.description || '-');
      const selector = escapeMarkdownCell(el.selector || '-');
      let row = `| ${index + 1} | ${el.type} | ${desc} | \`${selector}\` | ${el.frameId ?? 0}`;
      if (hasFilter) {
        const hitLabel = el.isHit
          ? `✓ ${el.matchedRegex && el.matchedXpath ? 'regex+xpath' : el.matchedRegex ? 'regex' : 'xpath'}`
          : '-';
        row += ` | ${hitLabel} |`;
      } else {
        row += ' |';
      }
      lines.push(row);
    });

    return lines.join('\n');
  }

  async execute(args: { regex?: string; xpath?: string; page?: number } = {}): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      // 参数整体可能为 null（executeTool 对缺失参数透传 null），归一后再读字段
      const input = args ?? ({} as { regex?: string; xpath?: string; page?: number });
      // ── 参数形态防御：OpenAI function calling 偶尔给出数字/对象等非字符串过滤条件，
      //    直接 .trim() 会在深层抛 TypeError；在入口以可读错误暴露，便于定位模型输出问题 ──
      for (const key of ['regex', 'xpath'] as const) {
        const value = input[key];
        if (value !== undefined && value !== null && typeof value !== 'string') {
          const receivedType = Array.isArray(value) ? 'array' : typeof value;
          return this.createErrorResponse(`参数 ${key} 必须是字符串，实际收到 ${receivedType}`);
        }
      }
      const regexSource = (input.regex || '').trim();
      const xpathExpr = (input.xpath || '').trim();
      const hasFilter = !!(regexSource || xpathExpr);
      // Number() 归一：字符串数字可用、NaN 回落 1、负数/0 钳制到 1、小数向下取整；
      // 无法解析的页码额外产出提示（见下方 hints），让「按第 1 页返回」可被模型感知
      const requestedPage = Number(input.page);
      const page = Math.max(1, Math.floor(requestedPage) || 1);
      const unparseablePageHint =
        input.page !== undefined && input.page !== null && !Number.isFinite(requestedPage)
          ? `页码参数无法解析（收到 ${JSON.stringify(input.page)}），已按默认第 1 页返回。`
          : null;

      this.log(`开始获取${this.scanLabel} - ${hasFilter ? `过滤模式 regex="${regexSource}" xpath="${xpathExpr}"` : '全量模式'}...`);

      // 1. 当前活动标签页（tabId 允许为 0，不能用真值判断）
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (typeof tabId !== 'number') {
        return this.createErrorResponse('未找到带 ID 的活动标签页');
      }
      const url = tabs[0].url || '';

      // 2. 空白页 / 无 URL（更具体的提示优先）
      if (!url || url === 'about:blank') {
        return this.createErrorResponse(
          `当前页面为空白页，不支持获取可交互元素。请先访问一个网页，例如：${EXAMPLE_URL}`
        );
      }
      // 3. 浏览器内置/受限页面（chrome://、edge://、file:// 等，统一口径见 common/constants）
      if (isRestrictedUrl(url)) {
        return this.createErrorResponse(
          `当前处于浏览器默认页，不支持获取可交互元素。请先访问一个网页，例如：${EXAMPLE_URL}`
        );
      }

      // 缓存键 = tabId|url|过滤条件：不同标签页/不同过滤条件各占一槽，互不挤占
      const queryKey = `${regexSource}\u0001${xpathExpr}`;
      const cacheKey = `${tabId}\u0002${url}\u0002${queryKey}`;

      let allElements: ScannedElement[] = [];
      let fromCache = false;

      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        // 命中校验：跨 frame 指纹一致才可复用（任一 frame DOM 变化即失效）
        const fingerprint = await this.getPageFingerprint(tabId);
        if (fingerprint && fingerprint === cached.fingerprint) {
          this.log(`过滤条件、标签页与页面指纹一致，命中缓存（共 ${cached.elements.length} 个元素）`);
          allElements = cached.elements;
          fromCache = true;
        }
      }

      if (!fromCache) {
        this.log('从页面注入采集元素...');

        // 注入 payload 到所有 frame（func 直接传模块函数引用 + 显式 args：
        // 绑定/箭头包装会在序列化后引用外部函数，注入上下文不存在这些标识符）
        const injectionResults = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: elementScanPayload,
          args: [this.scanMode, regexSource, xpathExpr],
        });

        const rawElements: ScannedElement[] = [];
        const frameFingerprints: string[] = [];
        let injectError: string | null = null;
        // 每个 frame 都必须返回结果，否则缓存指纹与下次校验指纹（按全部 frame 生成）
        // 永远对不上——这类采集只做透传不落缓存，避免留下必然失效的死槽位
        const allFramesReported =
          injectionResults.length > 0 && injectionResults.every(r => !!r.result);

        for (const frameResult of injectionResults) {
          const res: PayloadResult | undefined = frameResult.result;
          if (!res) continue;
          if (res.error) {
            injectError = res.error;
            break;
          }
          // 指纹取自采集 payload 自身（与元素同一时刻快照），格式与 getPageFingerprint 一致
          frameFingerprints.push(`${frameResult.frameId}:${res.fingerprint ?? ''}`);
          if (res.elements && res.elements.length > 0) {
            for (const el of res.elements) {
              rawElements.push({ ...el, frameId: frameResult.frameId });
            }
          }
        }
        if (injectError) {
          return this.createErrorResponse(injectError);
        }

        // 跨 frame 全局排序：命中过滤条件者置顶，其余按评分降序
        rawElements.sort((a, b) => {
          if (hasFilter && !!a.isHit !== !!b.isHit) return a.isHit ? -1 : 1;
          return (b.score || 0) - (a.score || 0);
        });

        allElements = rawElements;

        // 写入多槽缓存；超过上限时淘汰最旧的一条
        if (allFramesReported) {
          this.cache.set(cacheKey, {
            tabId,
            url,
            queryKey,
            fingerprint: frameFingerprints.sort().join('§'),
            timestamp: Date.now(),
            elements: allElements
          });
          while (this.cache.size > CACHE_MAX_ENTRIES) {
            let oldestKey: string | null = null;
            let oldestTs = Infinity;
            for (const [k, v] of this.cache) {
              if (v.timestamp < oldestTs) {
                oldestTs = v.timestamp;
                oldestKey = k;
              }
            }
            if (oldestKey) this.cache.delete(oldestKey);
            else break;
          }
          this.log(`结果已缓存（${allElements.length} 个元素，当前 ${this.cache.size} 槽）`);
        } else {
          this.log('存在未返回结果的 frame，本次采集不写入缓存（避免指纹不一致的死缓存）', 'warn');
        }
      }

      // 分页处理（page 越界时回退到最后一页，避免返回空表造成误解）
      const totalElements = allElements.length;
      const totalHits = hasFilter ? allElements.filter(el => el.isHit).length : 0;
      const totalPages = Math.max(1, Math.ceil(totalElements / PAGE_SIZE));
      let effectivePage = page;
      let pageClamped = false;
      if (effectivePage > totalPages) {
        effectivePage = totalPages;
        pageClamped = true;
      }
      const startIndex = (effectivePage - 1) * PAGE_SIZE;
      const pagedElements = allElements.slice(startIndex, startIndex + PAGE_SIZE);

      const duration = Date.now() - startTime;
      this.log(
        `${hasFilter ? '过滤' : '全量'}获取完成：共 ${totalElements} 个${this.elementUnit}` +
        `${hasFilter ? `（命中 ${totalHits} 个）` : ''}，返回第 ${effectivePage}/${totalPages} 页的 ${pagedElements.length} 个，` +
        `耗时: ${duration}ms${fromCache ? '（来自缓存）' : ''}`
      );

      // 将 elements 转为 markdown 表格格式，节省 token 同时保证结构性
      const elementsMarkdown = this.formatElementsAsMarkdown(pagedElements, hasFilter);

      // 过滤无命中时给出明确的下一步提示（返回的仍是全部元素）
      const hints: string[] = [];
      if (unparseablePageHint) {
        hints.push(unparseablePageHint);
      }
      if (pageClamped) {
        hints.push(`页码 ${page} 超出范围，已返回最后一页（共 ${totalPages} 页）。`);
      }
      if (hasFilter && totalHits === 0) {
        hints.push('没有任何元素命中过滤条件；下方表格为全部元素（按优先级排序）。请放宽 regex/xpath 条件后重试，或直接翻页浏览挑选候选。');
      } else if (hasFilter) {
        hints.push(`命中 ${totalHits} 个元素，已置顶并以 ✓ 标记，其后为其余元素。同一目标最多连续搜索 3 次，仍无目标请改为不带过滤条件翻页枚举。`);
      }
      const hint = hints.length > 0 ? hints.join(' ') : undefined;

      const responsePayload = {
        elements: elementsMarkdown,
        totalElements,
        ...(hasFilter ? { totalHits } : {}),
        page: effectivePage,
        pageSize: PAGE_SIZE,
        totalPages,
        filtered: hasFilter,
        cached: fromCache,
        ...(hint ? { hint } : {})
      };

      return this.createSuccessResponse(
        responsePayload,
        `Retrieved ${pagedElements.length}/${totalElements} elements (page ${effectivePage}/${totalPages})` +
        `${hasFilter ? `, ${totalHits} matched filters` : ''}${fromCache ? ' [cached]' : ''}.`
      );

    } catch (error) {
      const duration = Date.now() - startTime;
      this.log(`获取失败，耗时: ${duration}ms`, 'error');
      return this.createErrorResponse(`获取${this.errorLabel}元素失败`, error);
    }
  }
}
