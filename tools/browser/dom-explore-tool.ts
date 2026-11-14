/**
 * DOM 关系探索工具（browser_dom_explore）
 *
 * 面向「大量重复元素」界面（商品卡片、评论列表、表格行）的结构理解与
 * 数据提取辅助：以 browser_observe 枚举出的元素为种子，探索其祖先链、
 * 子元素、兄弟与全页相似元素，把「这个列表怎么重复的、字段挂在哪」
 * 变成一次可分页读取的确定性结果。
 *
 * 与既有工具的配合（引用体系互通）：
 *   - 输入：browser_observe（任意枚举视图）返回的 DOM elementId + 同行
 *     frameId；也接受本工具此前返回的新引用；
 *   - 输出：所有发现的元素注册进同一共享注册表，新 elementId 可直接交给
 *     browser_observe(view=element) 深查属性、browser_interact 操作、或
 *     本工具继续探索（如对重复容器 children 展开字段结构）；
 *   - similar 附带生成选择器与实测匹配数——模型可把它直接写进
 *     js_run 的抓取脚本（querySelectorAll 批量抽取），结果自动落
 *     results/ 结果文件 → data_ref_tool 治理 → xlsx_tool(dataFiles) 导出。
 *
 * 分页契约（children/siblings/similar）：与 browser_observe 同构——首次
 * 调用从 page=1 采集并冻结为 snapshotId 快照，续读传 snapshotId + page
 * （取上次响应的 nextPage）；改变任何条件或页面变化后须重新采集。
 * 每页 40 条，交付前对当页元素做二次引用核验（防 DOM 已变仍交付旧数据）。
 */

import { exclusiveText } from './text-runtime';
import { BaseBrowserTool } from '../base/browser-tool';
import type { ToolMetadata } from '../registry';
import type { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { isRestrictedUrl, TOOL_NAMES } from '@/common/constants';
import {
  elementExplorePayload,
  validateExploreReferences,
  type ExploreElementSummary,
  type ExplorePayloadResult,
} from './element-explore-payload';

/** 每页交付条数（与 browser_observe 的 PAGE_SIZE 对齐） */
const EXPLORE_PAGE_SIZE = 40;
/** 快照存活时长（与 browser_observe 一致；引用注册表条目同为 120s） */
const SNAPSHOT_TTL_MS = 120_000;
/** 最大保留快照数（防内存膨胀；旧快照 FIFO 淘汰） */
const MAX_SNAPSHOTS = 8;

type ExploreAction = 'parent' | 'children' | 'siblings' | 'similar';

interface DomExploreParams {
  action?: ExploreAction;
  elementId?: string;
  frameId?: number;
  /** parent 专用：上溯层数 1..8（默认 3） */
  levels?: number;
  /** children 专用：展开深度 1..3（默认 1） */
  depth?: number;
  /** children/siblings/similar：仅返回渲染中的元素（默认 true） */
  visibleOnly?: boolean;
  snapshotId?: string;
  page?: number;
}

interface ExploreSnapshot {
  tabId: number;
  url: string;
  action: ExploreAction;
  elementId: string;
  frameId: number;
  /** 采集时的过滤参数（续读改变即视为新查询） */
  visibleOnly: boolean;
  /** 采集时的展开深度（children；其它 action 恒 1，仅作绑定比对用） */
  depth: number;
  elements: ExploreElementSummary[];
  /** pattern 仅 similar 有 */
  pattern?: ExplorePayloadResult['pattern'];
  noPattern?: boolean;
  truncated?: boolean;
  note?: string;
  fingerprint: string;
  timestamp: number;
}

/** 单元格转义（markdown 表格安全） */
const escapeCell = (text: string): string =>
  text.replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ').replace(/`/g, "'");

/** 列表元素的表格行（children/siblings/similar 共用） */
const elementRows = (elements: ExploreElementSummary[], startIndex: number): string[] =>
  elements.map(
    (el, i) =>
      `| ${startIndex + i + 1}${el.isSeed ? '★' : ''} | ${el.tag} | ${escapeCell(
        el.classes || '-'
      )} | ${escapeCell(el.text || '-')} | ${escapeCell(el.attrs || '-')} | ${
        el.childCount
      } | ${el.elementId} |`
  );

export class DomExploreTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.DOM_EXPLORE;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.DOM_EXPLORE,
    description:
      'DOM 关系探索：以观察引用为种子获取祖先链/子元素/兄弟/相似重复元素列表，附生成选择器，分页与引用齐全',
    category: 'browser',
    version: '1.0.0',
    tags: ['browser', 'dom', 'structure', 'explore', 'scrape', 'rpa'],
    displayName: 'DOM 关系探索',
    // 纯读（注入荷载只做结构遍历/相似元素发现，不写 DOM、不动视口）：
    // 视觉循环无需重拍，截图身份继续有效
    noVisionRecapture: true,
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.DOM_EXPLORE,
      description:
        '探索当前页面指定元素的 DOM 关系，理解重复列表结构并定位批量抓取入口。action 四选一：' +
        'parent=祖先链逐层摘要（附同构兄弟数，用于识别「重复卡片容器」在哪一层）；' +
        'children=子元素列表（depth 展开 1..3 层，用于确认卡片内字段布局）；' +
        'siblings=同父兄弟全列（对比同级差异）；' +
        'similar=相似元素发现（自动识别重复容器组并逐容器等位匹配，附可直接用于 js_run 抓取脚本的生成选择器与实测匹配数）。' +
        '种子 elementId + frameId 原样复制自 browser_observe 枚举结果（或本工具此前返回的新引用）；返回的所有元素都注册进同一引用体系，' +
        '可继续 browser_observe(view=element) 深查、browser_interact 操作、本工具递归探索。' +
        'children/siblings/similar 分页：首次 page=1 生成 snapshotId，续读传 snapshotId + page（取 nextPage）；改变条件或页面变化后重新采集。' +
        '典型链路：observe 找到一个商品标题 → similar 得到全部同类元素与选择器 → children(重复容器) 确认字段 → js_run 用选择器批量抓取（结果自动落 results/ 结果文件）→ xlsx_tool(dataFiles) 导出。' +
        '多 frame 页面：引用只在其所属 frame 有效，其它 frame 需重新 observe 后各自探索。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['parent', 'children', 'siblings', 'similar'],
            description:
              'parent=祖先链（含同构兄弟数）；children=子元素（depth 展开）；siblings=同父兄弟；similar=相似重复元素+生成选择器',
          },
          elementId: {
            type: 'string',
            description:
              '种子元素的 DOM ElementId——原样复制 browser_observe 枚举结果（或本工具此前返回），不能用行号/CSS/XPath/ax: 引用',
          },
          frameId: {
            type: 'integer',
            minimum: 0,
            description: '与 ElementId 同一行的 FrameId（0 也须显式提供）',
          },
          levels: {
            type: 'integer',
            minimum: 1,
            maximum: 8,
            description: '仅 action=parent：上溯祖先层数（默认 3，上限 8）',
          },
          depth: {
            type: 'integer',
            minimum: 1,
            maximum: 3,
            description: '仅 action=children：子元素展开深度（默认 1，上限 3）',
          },
          visibleOnly: {
            type: 'boolean',
            description:
              'children/siblings/similar：仅返回渲染中的元素（默认 true）。列表含隐藏模板节点时传 false',
          },
          snapshotId: {
            type: 'string',
            description: '仅续读同一冻结结果时传；改变条件/action/elementId 或页面变化后省略，从 page=1 重采',
          },
          page: {
            type: 'integer',
            minimum: 1,
            description: '从 1 开始，每页最多 40 条；续读传上次返回的 nextPage，nextPage=null 即结束',
          },
        },
        required: ['action', 'elementId', 'frameId'],
      },
    },
  };

  private snapshots = new Map<string, ExploreSnapshot>();

  async execute(args: DomExploreParams = {}): Promise<ToolResult> {
    this.ensureBackgroundContext();
    return exclusiveText(() => this.run(args || {}));
  }

  private async run(input: DomExploreParams): Promise<ToolResult> {
    try {
      // ── 参数严格校验（未知参数拒绝，防拼写误用静默失效） ──
      const allowed = [
        'action',
        'elementId',
        'frameId',
        'levels',
        'depth',
        'visibleOnly',
        'snapshotId',
        'page',
      ];
      const unknown = Object.keys(input).filter((k) => !allowed.includes(k));
      if (unknown.length > 0)
        return this.createErrorResponse(
          `存在未知参数：${unknown.join('/')}。支持的参数：${allowed.join('/')}`
        );

      const action = input.action;
      if (
        action !== 'parent' &&
        action !== 'children' &&
        action !== 'siblings' &&
        action !== 'similar'
      )
        return this.createErrorResponse(
          `action 必须是 parent/children/siblings/similar，实际收到 ${JSON.stringify(action ?? null)}`
        );

      const elementId = input.elementId;
      if (
        typeof elementId !== 'string' ||
        !/^anx:\d+:[a-f0-9-]+:\d+$/.test(elementId)
      )
        return this.createErrorResponse(
          'INVALID_ARGUMENT：elementId 必须是 browser_observe 枚举返回的 DOM 引用（anx: 开头原样复制），不支持 ax: 引用、行号、CSS 或 XPath。'
        );
      const frameId = input.frameId;
      if (!Number.isSafeInteger(frameId) || (frameId as number) < 0)
        return this.createErrorResponse(
          'INVALID_ARGUMENT：frameId 必须是 ElementId 同行的非负整数（包括 0 也要显式提供）。'
        );

      // action 专属参数互斥校验（良性误用给指引而非裸拒）
      if (action !== 'parent' && input.levels !== undefined)
        return this.createErrorResponse(
          `levels 仅 action=parent 使用（${action} 不接受）；${action === 'children' ? '展开范围用 depth' : '无需层数参数'}。`
        );
      if (action !== 'children' && input.depth !== undefined)
        return this.createErrorResponse(
          `depth 仅 action=children 使用（${action} 不接受）。`
        );
      if (action === 'parent' && (input.snapshotId !== undefined || input.page !== undefined))
        return this.createErrorResponse(
          'parent 结果最多 9 层，不分页——省略 snapshotId/page。'
        );

      for (const [key, min, max] of [
        ['levels', 1, 8],
        ['depth', 1, 3],
      ] as const) {
        const value = input[key];
        if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max))
          return this.createErrorResponse(`${key} 必须是 ${min}..${max} 的整数`);
      }
      if (
        input.visibleOnly !== undefined &&
        typeof input.visibleOnly !== 'boolean'
      )
        return this.createErrorResponse('visibleOnly 必须是布尔值');
      if (input.snapshotId !== undefined && typeof input.snapshotId !== 'string')
        return this.createErrorResponse('snapshotId 必须是字符串');
      if (input.page !== undefined && (!Number.isSafeInteger(input.page) || input.page < 1))
        return this.createErrorResponse('page 必须是从 1 开始的整数');

      // ── 标签页解析（与 observe 同口径） ──
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (typeof tab?.id !== 'number' || !tab.url || isRestrictedUrl(tab.url))
        return this.createErrorResponse('当前页面不可读取（受限页面或无激活标签页）');
      const tabId = tab.id;

      // ── parent：单次注入直接返回 ──
      if (action === 'parent') {
        const injected = await this.inject(tabId, frameId as number, {
          action,
          elementId,
          levels: input.levels ?? 3,
          depth: 1,
          visibleOnly: false,
        });
        if (!injected.ok) return this.createErrorResponse(injected.error!);
        const result = injected.result!;
        // 交付前二次核验（当页全部引用仍有效）
        const verified = await this.verifyReferences(
          tabId,
          frameId as number,
          result.levels!.map((l) => l.elementId),
          result.fingerprint!
        );
        if (!verified.ok) return this.createErrorResponse(verified.error!);
        const lines = [
          '| Level | Tag | Classes | Text | Attrs | Sub | 同构兄弟 | ElementId |',
          '|---|---|---|---|---|---|---|---|',
          ...result.levels!.map(
            (l) =>
              `| ${l.depth}${l.isSeed ? '★种子' : ''} | ${l.tag} | ${escapeCell(
                l.classes || '-'
              )} | ${escapeCell(l.text || '-')} | ${escapeCell(l.attrs || '-')} | ${
                l.childCount
              } | ${l.repeatsInParent ?? '-'} | ${l.elementId} |`
          ),
        ];
        const repeatLevel = result
          .levels!.find((l) => (l.repeatsInParent ?? 0) >= 2);
        return this.createSuccessResponse(
          {
            action,
            levels: lines.join('\n'),
            frameId,
            tabId,
            url: tab.url,
            hint:
              (repeatLevel
                ? `第 ${repeatLevel.depth} 层（${repeatLevel.tag}${repeatLevel.classes ? '.' + repeatLevel.classes.split(' ')[0] : ''}）同构兄弟 ≥2，疑似重复容器——对其 ElementId 执行 similar 可拿全部同类元素与选择器，执行 children 可展开字段布局。`
                : '各级祖先均无同构兄弟；若目标确是列表，先 siblings 检查同级，或对列表内任一元素重新观察。') +
              '同构兄弟=该层在父下同标签且 class 相近的元素数（含自身）。',
          },
          `Retrieved ${result.levels!.length} ancestor levels (含种子).`
        );
      }

      // ── children / siblings / similar：快照分页 ──
      const page = input.page ?? 1;
      const visibleOnly = input.visibleOnly !== false;
      const requestedDepth = input.depth ?? 1;

      // TTL 清理
      for (const [id, entry] of this.snapshots) {
        if (Date.now() - entry.timestamp >= SNAPSHOT_TTL_MS)
          this.snapshots.delete(id);
      }

      let snapshotId = input.snapshotId?.trim();
      let snapshot: ExploreSnapshot;
      const snapshotReused = !!snapshotId;
      if (snapshotId) {
        const stored = this.snapshots.get(snapshotId);
        if (
          !stored ||
          stored.tabId !== tabId ||
          stored.url !== tab.url ||
          stored.action !== action ||
          stored.elementId !== elementId ||
          stored.frameId !== frameId ||
          stored.visibleOnly !== visibleOnly ||
          stored.depth !== requestedDepth
        ) {
          return this.createErrorResponse(
            'STALE_SNAPSHOT：快照不存在、已过期或 action/elementId/frameId/visibleOnly/depth 与原查询不一致。' +
              '续读须沿用原参数并传 page；改变条件后省略 snapshotId 从 page=1 重采。'
          );
        }
        snapshot = stored;
      } else {
        if (page !== 1)
          return this.createErrorResponse(
            '翻页必须提供上次返回的 snapshotId；新查询必须从 page=1 开始。'
          );
        const injected = await this.inject(tabId, frameId as number, {
          action,
          elementId,
          levels: 3,
          depth: requestedDepth,
          visibleOnly,
        });
        if (!injected.ok) return this.createErrorResponse(injected.error!);
        const result = injected.result!;
        snapshot = {
          tabId,
          url: tab.url,
          action,
          elementId,
          frameId: frameId as number,
          visibleOnly,
          depth: requestedDepth,
          elements: result.elements ?? [],
          ...(result.pattern ? { pattern: result.pattern } : {}),
          ...(result.noPattern ? { noPattern: true } : {}),
          ...(result.truncated ? { truncated: true } : {}),
          ...(result.note ? { note: result.note } : {}),
          fingerprint: result.fingerprint!,
          timestamp: Date.now(),
        };
        snapshotId = crypto.randomUUID();
        this.snapshots.set(snapshotId, snapshot);
        while (this.snapshots.size > MAX_SNAPSHOTS)
          this.snapshots.delete(this.snapshots.keys().next().value!);
      }

      // similar 未发现重复模式：直接返回（无分页意义）
      if (snapshot.noPattern) {
        return this.createSuccessResponse(
          {
            action,
            noPattern: true,
            note: snapshot.note,
            frameId,
            tabId,
            url: tab.url,
            hint: snapshot.note,
          },
          '未发现重复模式。'
        );
      }

      const totalElements = snapshot.elements.length;
      const totalPages = Math.max(1, Math.ceil(totalElements / EXPLORE_PAGE_SIZE));
      if (page > totalPages)
        return this.createErrorResponse(
          `PAGE_OUT_OF_RANGE：共 ${totalPages} 页，请使用有效页码（1..${totalPages}）。`
        );
      const start = (page - 1) * EXPLORE_PAGE_SIZE;
      const elements = snapshot.elements.slice(start, start + EXPLORE_PAGE_SIZE);

      // 交付前二次核验：当页引用在原 frame 仍有效 + 文档指纹未变
      const verified = await this.verifyReferences(
        tabId,
        frameId as number,
        elements.map((el) => el.elementId),
        snapshot.fingerprint
      );
      if (!verified.ok) {
        this.snapshots.delete(snapshotId!);
        return this.createErrorResponse(verified.error!);
      }

      const lines = [
        '| # | Tag | Classes | Text | Attrs | Sub | ElementId |',
        '|---|---|---|---|---|---|---|',
        ...elementRows(elements, start),
      ];

      const payload: Record<string, unknown> = {
        action,
        elements: totalElements > 0 ? lines.join('\n') : '_No elements found_',
        snapshotId,
        snapshotReused,
        frameId,
        tabId,
        url: tab.url,
        visibleOnly: snapshot.visibleOnly,
        totalElements,
        page,
        pageSize: EXPLORE_PAGE_SIZE,
        totalPages,
        nextPage: page < totalPages ? page + 1 : null,
        ...(snapshot.truncated ? { truncated: true } : {}),
        ...(snapshot.note ? { note: snapshot.note } : {}),
      };

      if (action === 'similar') {
        payload.pattern = snapshot.pattern;
        payload.hint =
          (snapshot.pattern?.combinedSelector
            ? `批量抓取：js_run 里 document.querySelectorAll('${snapshot.pattern.combinedSelector}')（实测匹配 ${snapshot.pattern.selectorMatchCount ?? '?'} 个；匹配数与容器数 ${snapshot.pattern.containerCount} 明显不符时按容器遍历更稳）。`
            : '') +
          (snapshot.pattern?.mode === 'descendant' && snapshot.pattern?.containerElementId
            ? `字段布局：对本页任一元素所在容器执行 browser_dom_explore(action="children", elementId="${snapshot.pattern.containerElementId}", frameId=${frameId}, depth=2)。`
            : '') +
          `单元素深查 browser_observe(view="element")；操作 browser_interact；续读传 snapshotId + page（nextPage=${page < totalPages ? page + 1 : 'null'} 即结束）。`;
      } else if (action === 'children') {
        payload.hint = `字段提取：对代表性子元素 browser_observe(view="element") 查属性/XPath；批量抽取在 js_run 中以种子为容器 querySelectorAll 遍历。续读传 snapshotId + page。`;
      } else {
        payload.hint = `同级对比后：相似元素用 action="similar"（附生成选择器）；子结构用 action="children"。续读传 snapshotId + page。`;
      }

      const actionLabel: Record<string, string> = {
        children: 'child elements',
        siblings: 'siblings',
        similar: 'similar elements',
      };
      return this.createSuccessResponse(
        payload,
        `Retrieved ${elements.length}/${totalElements} ${actionLabel[action]} (page ${page}/${totalPages})${
          action === 'similar' && snapshot.pattern
            ? `; pattern=${snapshot.pattern.mode}, containers=${snapshot.pattern.containerCount}`
            : ''
        }.`
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('background context')
      )
        throw error;
      return this.createErrorResponse('DOM 探索失败；等待页面稳定后从 page=1 重采', error);
    }
  }

  /** 注入荷载到目标 frame */
  private async inject(
    tabId: number,
    frameId: number,
    params: {
      action: ExploreAction;
      elementId: string;
      levels: number;
      depth: number;
      visibleOnly: boolean;
    }
  ): Promise<
    | { ok: false; error: string }
    | { ok: true; result: ExplorePayloadResult & { fingerprint: string } }
  > {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'ISOLATED',
      func: elementExplorePayload,
      args: [
        params.action,
        params.elementId,
        params.levels,
        params.depth,
        params.visibleOnly,
        tabId,
      ],
    });
    const result = results?.[0]?.result as ExplorePayloadResult | undefined;
    if (!result)
      return {
        ok: false,
        error:
          'INCOMPLETE_SCAN：目标 frame 未返回结果（frame 可能已随导航消失，或荷载执行异常）——请 browser_observe 重新枚举。',
      };
    if (result.error) return { ok: false, error: result.error };
    // 防御：荷载契约要求成功时必带字符串指纹与对应形状的列表——
    // 不满足即视为异常返回而非把 undefined 伪装成数据
    if (typeof result.fingerprint !== 'string' || !result.fingerprint)
      return {
        ok: false,
        error: 'INCOMPLETE_SCAN：荷载返回缺少文档指纹（页面可能正在导航）——请稍后重试。',
      };
    const expected = params.action === 'parent' ? result.levels : result.elements;
    if (!Array.isArray(expected))
      return {
        ok: false,
        error: `INCOMPLETE_SCAN：荷载返回缺少 ${params.action} 结果列表——请稍后重试或重新枚举。`,
      };
    return { ok: true, result: result as ExplorePayloadResult & { fingerprint: string } };
  }

  /** 交付前二次核验：文档指纹未变 + 待交付引用身份仍有效（不含可见性检查——
   *  visibleOnly=false 的快照合法包含隐藏节点，可见性不是引用有效性条件） */
  private async verifyReferences(
    tabId: number,
    frameId: number,
    elementIds: string[],
    expectedFingerprint: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const checked = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        world: 'ISOLATED',
        func: validateExploreReferences,
        args: [elementIds],
      });
      if (
        checked.length !== 1 ||
        !checked[0].result?.valid ||
        checked[0].result.fingerprint !== expectedFingerprint
      ) {
        return {
          ok: false,
          error:
            'STALE_ELEMENTS：文档或引用已变化，交付前核验失败。省略 snapshotId，从 page=1 重新采集。',
        };
      }
      return { ok: true };
    } catch {
      return {
        ok: false,
        error:
          'STALE_ELEMENTS：目标 frame 注入失败（可能已导航/关闭）。请重新观察后探索。',
      };
    }
  }
}

export const domExploreTool = new DomExploreTool();
