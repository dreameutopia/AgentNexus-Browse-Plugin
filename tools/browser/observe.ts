import { exclusiveText, readableTextError } from './text-runtime';
import { elementInspectPayload } from './element-inspect-payload';
/** Explicit, bounded snapshots. A fresh request always scans; continuation never silently changes datasets. */
import { BaseBrowserTool } from '../base/browser-tool';
import type { ToolMetadata } from '../registry';
import type { OpenAITool } from '@/common/openai-types';
import { observeAccessibility } from './text-accessibility';
import { focusedTextPayload } from './text-target-payload';
import { ToolResult } from '@/common/tool-handler';
import { isRestrictedUrl } from '@/common/constants';
import {
  elementScanPayload,
  type PayloadElement,
  type PayloadResult,
  type ScanMode,
} from '../automation/shared/element-scan-payload';
import {
  CONTROL_CATEGORIES,
  matchesControlCategory,
  validateElementReferences,
} from '../automation/shared/element-reference';

export interface ScannedElement extends PayloadElement {
  frameId: number;
}
interface Snapshot {
  tabId: number;
  url: string;
  regex: string;
  xpath: string;
  categories: string[];
  timestamp: number;
  view: ScanMode;
  elements: ScannedElement[];
  fingerprints: Map<number, string>;
}
export interface ElementGetterArgs {
  view?: ScanMode | 'accessibility' | 'element';
  elementId?: string;
  frameId?: number;
  regex?: string;
  xpath?: string;
  page?: number;
  snapshotId?: string;
  categories?: string[];
}
const PAGE_SIZE = 40;
const TTL = 120_000;
const escapeCell = (text: string): string =>
  text
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]/g, ' ')
    .replace(/`/g, "'");

// Enumeration never targets an element/frame; keep the schema branches separate.
const enumerationProperties = {
  categories: {
    type: 'array',
    minItems: 1,
    maxItems: CONTROL_CATEGORIES.length,
    uniqueItems: true,
    items: { type: 'string', enum: [...CONTROL_CATEGORIES] },
    description:
      '按语义类别严格筛选（OR），与 regex/xpath 组合。支持 calendar/date-range/time-range/date-segment 复合模式，基础类别仍保留；模式按明确 DOM 证据判断，AX 不保证暴露。比如 ["close","combobox","checkbox"]；空数组无效。续读省略继承，改变时新采集。类型、patterns 和实时状态在 details 中返回。',
  },
  view: {
    type: 'string',
    enum: ['controls', 'buttons', 'inputs', 'structure', 'accessibility'],
    description: '枚举视图；新查询默认 controls，续读省略时继承快照视图。',
  },
  regex: {
    type: 'string',
    description:
      '不区分大小写。DOM：匹配文字/placeholder/aria-label 等，命中置顶，未命中候选仍返回，只有 Hit 标记才算命中；AX：只返回匹配语义节点。',
  },
  xpath: {
    type: 'string',
    description:
      '仅 DOM 枚举：XPath 1.0，元素或祖先命中。和 regex 同传为 AND；XPath 未命中时删除 xpath，再单独用 regex 兜底。Shadow 内局部路径不能直接作为文档 XPath。',
  },
  snapshotId: {
    type: 'string',
    description:
      '仅续读同一冻结结果时传；省略 view/过滤条件表示继承。改变或清除条件、切换视图、页面变化或操作后省略，从 page=1 重采。DOM/AX 快照不能混用。',
  },
  page: {
    type: 'integer',
    minimum: 1,
    description:
      '仅枚举：从 1 开始，每页最多 40 条。新查询省略或传 1；续读传返回的 nextPage，nextPage=null 即结束。',
  },
};
const elementProperties = {
  view: { type: 'string', enum: ['element'] },
  elementId: {
    type: 'string',
    minLength: 1,
    description:
      '仅 view=element：原样复制最近枚举得到的 DOM ElementId，不能用行号、CSS、XPath 或 ax: 引用。',
  },
  frameId: {
    type: 'integer',
    minimum: 0,
    description:
      '仅 view=element：与 ElementId 同一行的 FrameId，0 也须显式提供。不是枚举范围参数；其它视图必须省略，不能传 0 或 null 占位。',
  },
};

export class BrowserObserveTool extends BaseBrowserTool {
  name = 'browser_observe';
  constructor(private defaultView: ScanMode = 'controls') {
    super();
  }
  metadata: ToolMetadata = {
    name: this.name,
    description:
      '纯文本页面观察：控件、输入、表格结构和浏览器辅助功能树，稳定引用与快照分页',
    category: 'browser',
    version: '6.0.0',
    visionRefresh: 'none',
  };
  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: this.name,
      description:
        '观察当前活动页。两种调用互斥：\n' +
        '1. 枚举：controls=按钮与输入（默认）；buttons/inputs=分类；structure=表格、选区、值/选项、滚动容器与 canvas；accessibility=辅助功能语义。categories 严格筛选类别（OR），结果 Category/State 与 details 提供类型、状态、关联引用和可用动作；close 关闭入口优先展示但不自动操作。自动覆盖可访问 frame，不传 elementId/frameId（包括 0/null）；可用 regex，DOM 视图还可用 xpath。例如 {"view":"controls","categories":["combobox","checkbox"]}。\n' +
        '2. 节点详情：仅传 view="element"、枚举返回的 DOM elementId 和同一行 frameId，读取属性、XPath、文字、状态、外观与 frame 内位置；不传 regex/xpath/page/snapshotId。AX 引用不支持此视图。\n' +
        '新枚举省略 snapshotId，从 page=1 开始；续读传 snapshotId，page 取上次返回的 nextPage，nextPage=null 即结束。改变条件或操作后重新采集。# 是展示行号，不是 ElementId。交互调用 browser_interact：DOM 引用配同一行 FrameId，AX 引用自带路由。coverage 表示覆盖边界，未渲染数据不会自动出现。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...enumerationProperties,
          ...elementProperties,
          view: {
            type: 'string',
            enum: [...enumerationProperties.view.enum, 'element'],
            description:
              '枚举与节点详情二选一；新查询默认 controls，续读省略则继承快照视图。只有 element 接受且必须提供 elementId/frameId。',
          },
        },
        required: [],
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: enumerationProperties,
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: elementProperties,
            required: ['view', 'elementId', 'frameId'],
          },
        ],
      },
    },
  };
  private snapshots = new Map<string, Snapshot>();

  private async validate(snapshot: Snapshot): Promise<boolean> {
    // Probe every accessible frame, including new/removed/navigated frames.
    const results = await chrome.scripting.executeScript({
      target: { tabId: snapshot.tabId, allFrames: true },
      world: 'ISOLATED',
      func: validateElementReferences,
      args: [[]],
    });
    if (results.length !== snapshot.fingerprints.size) return false;
    for (const frame of results) {
      if (
        !frame.result?.valid ||
        frame.result.fingerprint !== snapshot.fingerprints.get(frame.frameId)
      )
        return false;
    }
    return true;
  }

  async execute(args: ElementGetterArgs = {}): Promise<ToolResult> {
    this.ensureBackgroundContext();
    return exclusiveText(() => this.run(args));
  }
  private async run(args: ElementGetterArgs): Promise<ToolResult> {
    try {
      const input = args ?? {};
      if (typeof input !== 'object' || Array.isArray(input))
        return this.createErrorResponse('参数必须是对象');
      if (
        Object.keys(input).some(
          (k) =>
            ![
              'view',
              'regex',
              'xpath',
              'snapshotId',
              'page',
              'elementId',
              'frameId',
              'categories',
            ].includes(k),
        )
      )
        return this.createErrorResponse('存在未知参数');
      if (
        input.view !== undefined &&
        ![
          'controls',
          'buttons',
          'inputs',
          'structure',
          'accessibility',
          'element',
        ].includes(input.view)
      )
        return this.createErrorResponse('view 无效');
      if (input.view === 'element') {
        if (
          typeof input.elementId !== 'string' ||
          !input.elementId.trim() ||
          input.elementId.startsWith('ax:') ||
          !Number.isSafeInteger(input.frameId) ||
          input.frameId! < 0
        )
          return this.createErrorResponse(
            'INVALID_ARGUMENT：view=element 必须提供枚举得到的 DOM elementId 与同一行非负整数 frameId（包括 0）；AX 引用不支持此视图。',
          );
        const extraFields = [
          'regex',
          'xpath',
          'snapshotId',
          'page',
          'categories',
        ].filter((key) => key in input);
        if (extraFields.length)
          return this.createErrorResponse(
            `INVALID_ARGUMENT：view=element 不接受 ${extraFields.join('/')}。删除这些字段，仅保留 view、elementId、frameId 后重试。`,
          );
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (typeof tab?.id !== 'number' || !tab.url || isRestrictedUrl(tab.url))
          return this.createErrorResponse('当前页面不可读取');
        const rows = await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [input.frameId!] },
          world: 'ISOLATED',
          func: elementInspectPayload,
          args: [input.elementId],
        });
        const detail = rows[0]?.result;
        if (!detail || detail.error)
          return this.createErrorResponse(
            detail?.error || '元素或 frame 已消失，请重新枚举',
          );
        return this.createSuccessResponse({
          ...detail,
          frameId: input.frameId,
          tabId: tab.id,
        });
      }
      const referenceFields = ['elementId', 'frameId'].filter(
        (key) => key in input,
      );
      if (referenceFields.length)
        return this.createErrorResponse(
          `INVALID_ARGUMENT：枚举不接受 ${referenceFields.join('/')}。删除这些字段，保留原枚举条件后重试；枚举自动覆盖可访问 frame，frameId 不是范围参数。节点详情才使用 view=element + elementId + frameId。`,
        );
      for (const key of ['regex', 'xpath', 'snapshotId'] as const) {
        if (input[key] !== undefined && typeof input[key] !== 'string')
          return this.createErrorResponse(key + ' 必须是字符串');
      }
      if (
        input.categories !== undefined &&
        (!Array.isArray(input.categories) ||
          !input.categories.length ||
          input.categories.length > CONTROL_CATEGORIES.length ||
          new Set(input.categories).size !== input.categories.length ||
          input.categories.some(
            (category) =>
              !CONTROL_CATEGORIES.includes(
                category as (typeof CONTROL_CATEGORIES)[number],
              ),
          ))
      )
        return this.createErrorResponse(
          'INVALID_ARGUMENT：categories 必须是非空、无重复的已知类别数组。',
        );
      if (
        input.view === 'accessibility' ||
        input.snapshotId?.startsWith('axs:')
      ) {
        this.ensureBackgroundContext();
        if (input.view !== undefined && input.view !== 'accessibility')
          return this.createErrorResponse(
            'QUERY_MISMATCH：快照属于 accessibility',
          );
        return this.createSuccessResponse(await observeAccessibility(input));
      }
      const page = input.page ?? 1;
      if (!Number.isSafeInteger(page) || page < 1)
        return this.createErrorResponse('page 必须是从 1 开始的有限整数');
      const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const tabId = tabs[0]?.id;
      const url = tabs[0]?.url || '';
      if (typeof tabId !== 'number')
        return this.createErrorResponse('未找到带 ID 的活动标签页');
      if (!url || url === 'about:blank')
        return this.createErrorResponse('当前页面为空白页，请先访问网页');
      if (isRestrictedUrl(url))
        return this.createErrorResponse(
          '当前页面为浏览器默认页或受限页面，无法采集',
        );
      for (const [id, entry] of this.snapshots) {
        if (Date.now() - entry.timestamp >= TTL) this.snapshots.delete(id);
      }
      let snapshotId = input.snapshotId?.trim();
      let snapshot: Snapshot;
      const snapshotReused = !!snapshotId;
      if (snapshotId) {
        const stored = this.snapshots.get(snapshotId);
        if (!stored || stored.tabId !== tabId || stored.url !== url) {
          return this.createErrorResponse(
            'STALE_SNAPSHOT：快照不存在、已过期或页面/标签页已改变。省略 snapshotId，从 page=1 重新采集。',
          );
        }
        if (
          (input.regex !== undefined && input.regex.trim() !== stored.regex) ||
          (input.xpath !== undefined && input.xpath.trim() !== stored.xpath) ||
          (input.categories !== undefined &&
            JSON.stringify([...input.categories].sort()) !==
              JSON.stringify(stored.categories))
        ) {
          return this.createErrorResponse(
            'QUERY_MISMATCH：快照绑定原过滤条件。改变或清除条件时省略 snapshotId，并从 page=1 开始。',
          );
        }
        if (input.view !== undefined && input.view !== stored.view)
          return this.createErrorResponse('QUERY_MISMATCH：快照绑定原 view');
        snapshot = stored;
      } else {
        if (page !== 1)
          return this.createErrorResponse(
            '翻页必须提供上次返回的 snapshotId；新查询必须从 page=1 开始。',
          );
        const regex = (input.regex || '').trim();
        const xpath = (input.xpath || '').trim();
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: 'ISOLATED',
          func: elementScanPayload,
          args: [input.view ?? this.defaultView, regex, xpath, tabId],
        });
        if (!results.length || results.some((frame) => !frame.result)) {
          return this.createErrorResponse(
            'INCOMPLETE_SCAN：部分 frame 未返回结果，请等待页面稳定后重新采集。',
          );
        }
        const elements: ScannedElement[] = [];
        const fingerprints = new Map<number, string>();
        for (const frame of results) {
          const payload = frame.result as PayloadResult;
          if (payload.error) return this.createErrorResponse(payload.error);
          if (!payload.fingerprint)
            return this.createErrorResponse('INCOMPLETE_SCAN：缺少文档标识');
          fingerprints.set(frame.frameId, payload.fingerprint);
          for (const element of payload.elements)
            if (
              matchesControlCategory(element.semantics, input.categories || [])
            )
              elements.push({ ...element, frameId: frame.frameId });
        }
        elements.sort(
          (a, b) =>
            Number(b.isHit) - Number(a.isHit) ||
            b.score - a.score ||
            a.frameId - b.frameId ||
            a.elementId.localeCompare(b.elementId),
        );
        snapshot = {
          tabId,
          url,
          regex,
          xpath,
          categories: [...(input.categories || [])].sort(),
          view: (input.view ?? this.defaultView) as ScanMode,
          timestamp: Date.now(),
          elements,
          fingerprints,
        };
        snapshotId = crypto.randomUUID();
        this.snapshots.set(snapshotId, snapshot);
        while (this.snapshots.size > 8)
          this.snapshots.delete(this.snapshots.keys().next().value!);
      }
      if (!(await this.validate(snapshot))) {
        this.snapshots.delete(snapshotId!);
        return this.createErrorResponse(
          'STALE_SNAPSHOT：文档、路由或 frame 集合已改变，请从 page=1 重采。',
        );
      }
      const totalElements = snapshot.elements.length;
      const totalPages = Math.max(1, Math.ceil(totalElements / PAGE_SIZE));
      if (page > totalPages)
        return this.createErrorResponse(
          'PAGE_OUT_OF_RANGE：共 ' +
            totalPages +
            ' 页，请使用有效页码，不会重复返回最后一页。',
        );
      const start = (page - 1) * PAGE_SIZE;
      const elements = snapshot.elements.slice(start, start + PAGE_SIZE);
      // Second pass on every delivered page: exact node identity + document revision.
      for (const frameId of new Set(elements.map((el) => el.frameId))) {
        const checked = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          world: 'ISOLATED',
          func: validateElementReferences,
          args: [
            elements
              .filter((el) => el.frameId === frameId)
              .map((el) => el.elementId),
            snapshot.view !== 'structure',
          ],
        });
        if (
          checked.length !== 1 ||
          !checked[0].result?.valid ||
          checked[0].result.fingerprint !== snapshot.fingerprints.get(frameId)
        ) {
          this.snapshots.delete(snapshotId!);
          return this.createErrorResponse(
            'STALE_ELEMENTS：交付前二次核验失败。省略 snapshotId，从 page=1 重新采集。',
          );
        }
        // Freeze membership/order, not mutable checked/value/expanded state.
        for (const live of checked[0].result.semantics || []) {
          const element = elements.find(
            (item) =>
              item.elementId === live.elementId && item.frameId === frameId,
          );
          if (!element) continue;
          if (
            snapshot.categories.length &&
            !matchesControlCategory(live.semantics, snapshot.categories)
          )
            return this.createErrorResponse(
              'STALE_ELEMENTS：类别变化，请省略 snapshotId 重采。',
            );
          element.semantics = live.semantics;
          element.details = {
            ...element.details,
            ...live.semantics,
            ...live.semantics.states,
          };
        }
      }
      const hasFilter = !!(snapshot.regex || snapshot.xpath);
      const totalHits = snapshot.elements.filter((el) => el.isHit).length;
      const lines = [
        '| # | Type | Description | Context | ElementId | FrameId | Category | State |' +
          (hasFilter ? ' Hit |' : ''),
        '|---|---|---|---|---|---|---|---|' + (hasFilter ? '---|' : ''),
        ...elements.map(
          (el, i) =>
            '| ' +
            (start + i + 1) +
            ' | ' +
            escapeCell(el.type.slice(0,100)) +
            ' | ' +
            escapeCell(el.description || '-') +
            ' | ' +
            escapeCell(el.context || '-') +
            ' | ' +
            el.elementId +
            ' | ' +
            el.frameId +
            ' | ' +
            (el.semantics?.category || 'element') + (el.semantics?.patterns?.length ? ' [' + el.semantics.patterns.join(',') + ']' : '') +
            ' | ' +
            escapeCell(
              JSON.stringify(
                Object.fromEntries(
                  Object.entries(el.semantics?.states || {}).filter(([key]) =>
                    [
                      'checked',
                      'selected',
                      'expanded',
                      'pressed',
                      'disabled',
                      'readonly',
                      'invalid',
                      'value',
                      'multiple',
                    ].includes(key),
                  ),
                ),
              ),
            ) +
            ' |' +
            (hasFilter
              ? ' ' +
                (el.isHit
                  ? '✓ ' +
                    (el.matchedRegex && el.matchedXpath
                      ? 'regex+xpath'
                      : el.matchedRegex
                        ? 'regex'
                        : 'xpath')
                  : '-') +
                ' |'
              : ''),
        ),
      ];
      return this.createSuccessResponse(
        {
          elements: elements.length ? lines.join('\n') : '_No elements found_',
          snapshotId,
          view: snapshot.view,
          focus: (
            await chrome.scripting.executeScript({
              target: { tabId, allFrames: true },
              world: 'ISOLATED',
              func: focusedTextPayload,
              args: [],
            })
          )
            .filter((r) => r.result)
            .map((r) => ({ ...r.result, frameId: r.frameId })),
          coverage: {
            complete: false,
            source: 'DOM in injectable frames; only currently rendered nodes',
          },
          details: elements
            .filter((el) => el.details)
            .map((el) => ({
              elementId: el.elementId,
              frameId: el.frameId,
              ...el.details,
            })),
          tabId,
          url,
          query: {
            regex: snapshot.regex,
            xpath: snapshot.xpath,
            categories: snapshot.categories,
          },
          totalElements,
          ...(hasFilter ? { totalHits } : {}),
          page,
          pageSize: PAGE_SIZE,
          totalPages,
          nextPage: page < totalPages ? page + 1 : null,
          filtered: hasFilter,
          snapshotReused,
          hint:
            (hasFilter && totalHits === 0
              ? '没有任何元素命中过滤条件，表格仍包含其余候选。'
              : '') +
            '续读传 snapshotId 和 page（取 nextPage 的值）；改变条件或操作后省略 snapshotId 重采。节点详情用 view=element，交互用 browser_interact；枚举不传 elementId/frameId。',
        },
        'Retrieved ' +
          elements.length +
          '/' +
          totalElements +
          ' elements (page ' +
          page +
          '/' +
          totalPages +
          ').',
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('background context')
      )
        throw error;
      return this.createErrorResponse(
        '页面观察失败；等待稳定后从 page=1 重采',
        new Error(readableTextError(error)),
      );
    }
  }
}
