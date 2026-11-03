import { exclusiveText } from './text-runtime';
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
import { validateElementReferences } from '../automation/shared/element-reference';

export interface ScannedElement extends PayloadElement {
  frameId: number;
}
interface Snapshot {
  tabId: number;
  url: string;
  regex: string;
  xpath: string;
  timestamp: number;
  view: ScanMode;
  elements: ScannedElement[];
  fingerprints: Map<number, string>;
}
export interface ElementGetterArgs {
  view?: ScanMode | 'accessibility';
  regex?: string;
  xpath?: string;
  page?: number;
  snapshotId?: string;
}
const PAGE_SIZE = 40;
const TTL = 120_000;
const escapeCell = (text: string): string =>
  text
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]/g, ' ')
    .replace(/`/g, "'");

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
  };
  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: this.name,
      description:
        '纯文本观察页面及可注入 frame。controls=按钮与输入；buttons/inputs=分类；structure=表格行列/选区/值/选项/滚动容器/canvas；accessibility=浏览器辅助功能语义（需要 debugger，可能仅部分覆盖）。DOM 引用需配合同一行 FrameId；AX 引用自带路由，只支持 focus/keys/type。新查询从 page=1；续读传 snapshotId 和 nextPage；改条件省略快照。未渲染数据不会自动出现。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          view: {
            type: 'string',
            enum: [
              'controls',
              'buttons',
              'inputs',
              'structure',
              'accessibility',
            ],
            default: 'controls',
          },
          regex: {
            type: 'string',
            description:
              'DOM：命中置顶，未命中仍返回；AX：只返回匹配语义节点。不区分大小写。',
          },
          xpath: {
            type: 'string',
            description:
              '仅 DOM 视图的 XPath 1.0；元素/祖先命中，和 regex 同时提供为 AND。',
          },
          snapshotId: {
            type: 'string',
            description: '续读上次快照；新查询或操作后省略。',
          },
          page: {
            type: 'number',
            description: '正整数；每页最多40条，新查询为1。',
            default: 1,
          },
        },
        required: [],
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
          (k) => !['view', 'regex', 'xpath', 'snapshotId', 'page'].includes(k)
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
        ].includes(input.view)
      )
        return this.createErrorResponse('view 无效');
      for (const key of ['regex', 'xpath', 'snapshotId'] as const) {
        if (input[key] !== undefined && typeof input[key] !== 'string')
          return this.createErrorResponse(key + ' 必须是字符串');
      }
      if (
        input.view === 'accessibility' ||
        input.snapshotId?.startsWith('axs:')
      ) {
        this.ensureBackgroundContext();
        if (input.view !== undefined && input.view !== 'accessibility')
          return this.createErrorResponse(
            'QUERY_MISMATCH：快照属于 accessibility'
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
          '当前页面为浏览器默认页或受限页面，无法采集'
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
            'STALE_SNAPSHOT：快照不存在、已过期或页面/标签页已改变。省略 snapshotId，从 page=1 重新采集。'
          );
        }
        if (
          (input.regex !== undefined && input.regex.trim() !== stored.regex) ||
          (input.xpath !== undefined && input.xpath.trim() !== stored.xpath)
        ) {
          return this.createErrorResponse(
            'QUERY_MISMATCH：快照绑定原过滤条件。改变或清除条件时省略 snapshotId，并从 page=1 开始。'
          );
        }
        if (input.view !== undefined && input.view !== stored.view)
          return this.createErrorResponse('QUERY_MISMATCH：快照绑定原 view');
        snapshot = stored;
      } else {
        if (page !== 1)
          return this.createErrorResponse(
            '翻页必须提供上次返回的 snapshotId；新查询必须从 page=1 开始。'
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
            'INCOMPLETE_SCAN：部分 frame 未返回结果，请等待页面稳定后重新采集。'
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
            elements.push({ ...element, frameId: frame.frameId });
        }
        elements.sort(
          (a, b) =>
            Number(b.isHit) - Number(a.isHit) ||
            b.score - a.score ||
            a.frameId - b.frameId ||
            a.elementId.localeCompare(b.elementId)
        );
        snapshot = {
          tabId,
          url,
          regex,
          xpath,
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
          'STALE_SNAPSHOT：文档、路由或 frame 集合已改变，请从 page=1 重采。'
        );
      }
      const totalElements = snapshot.elements.length;
      const totalPages = Math.max(1, Math.ceil(totalElements / PAGE_SIZE));
      if (page > totalPages)
        return this.createErrorResponse(
          'PAGE_OUT_OF_RANGE：共 ' +
            totalPages +
            ' 页，请使用有效页码，不会重复返回最后一页。'
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
            'STALE_ELEMENTS：交付前二次核验失败。省略 snapshotId，从 page=1 重新采集。'
          );
        }
      }
      const hasFilter = !!(snapshot.regex || snapshot.xpath);
      const totalHits = snapshot.elements.filter((el) => el.isHit).length;
      const lines = [
        '| # | Type | Description | Context | ElementId | FrameId |' +
          (hasFilter ? ' Hit |' : ''),
        '|---|---|---|---|---|---|' + (hasFilter ? '---|' : ''),
        ...elements.map(
          (el, i) =>
            '| ' +
            (start + i + 1) +
            ' | ' +
            el.type +
            ' | ' +
            escapeCell(el.description || '-') +
            ' | ' +
            escapeCell(el.context || '-') +
            ' | ' +
            el.elementId +
            ' | ' +
            el.frameId +
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
              : '')
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
          query: { regex: snapshot.regex, xpath: snapshot.xpath },
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
            '翻页传 snapshotId 和 nextPage；改变/清除过滤条件或页面变化后，省略 snapshotId 从 page=1 重采。操作时原样传 ElementId 和 FrameId，# 只是当前快照的全局行号。',
        },
        'Retrieved ' +
          elements.length +
          '/' +
          totalElements +
          ' elements (page ' +
          page +
          '/' +
          totalPages +
          ').'
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('background context')
      )
        throw error;
      return this.createErrorResponse(
        '页面观察失败；等待稳定后从 page=1 重采',
        error
      );
    }
  }
}
