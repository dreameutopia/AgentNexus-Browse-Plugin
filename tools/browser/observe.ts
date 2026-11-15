import { exclusiveText, readableTextError } from './text-runtime';
import { readPageFrames, PageReadError, addFrameIssue, type FrameReadReport } from '../common/frame-read';
import { elementInspectPayload } from './element-inspect-payload';
/** Explicit, bounded snapshots. A fresh request always scans; continuation never silently changes datasets. */
import { BaseBrowserTool } from '../base/browser-tool';
import type { ToolMetadata, ToolExecutionContext } from '../registry';
import type { OpenAITool } from '@/common/openai-types';
import { observeAccessibility } from './text-accessibility';
import { focusedTextPayload } from './text-target-payload';
import { ToolResult } from '@/common/tool-handler';
import { resolveTabTarget } from './tab-target';
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
  /** 该快照的分页大小（续读必须沿用，改变即视为新查询） */
  pageSize: number;
  /** 是否只保留命中过滤条件的元素（影响结果集与分页总数） */
  hitsOnly: boolean;
  /** 采集时是否包含节点详情（只影响载荷体积；续读省略时沿用快照值） */
  includeDetails: boolean;
  frameDiagnostics: FrameReadReport;
}
export interface ElementGetterArgs {
  view?: ScanMode | 'accessibility' | 'element';
  /** 目标标签页（可选；省略=当前活动页，显式传入会先切换到该标签页） */
  tabId?: number | string;
  elementId?: string;
  frameId?: number;
  regex?: string;
  xpath?: string;
  page?: number;
  pageSize?: number;
  hitsOnly?: boolean;
  includeDetails?: boolean;
  snapshotId?: string;
  categories?: string[];
}
/** 默认分页大小（模型的上下文预算默认值；可经 pageSize 调小，上限同此值） */
const PAGE_SIZE = 40;
/** 表格单元格文本上限：description/context 过长时截断，防止单条记录吃掉整页预算 */
const CELL_TEXT_MAX = 160;
const TTL = 120_000;
const escapeCell = (text: string): string =>
  text
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]/g, ' ')
    .replace(/`/g, "'");
/** 单元格截断：长描述只保留开头，完整内容仍可用 view=element 读取 */
const clipCell = (text: string): string =>
  text.length > CELL_TEXT_MAX ? text.slice(0, CELL_TEXT_MAX) + '…' : text;

// Enumeration never targets an element/frame; keep the schema branches separate.
const enumerationProperties = {
  tabId: {
    type: 'integer',
    minimum: 0,
    description:
      '目标标签页 ID（可选；省略=当前活动标签页）。显式传入会先核对存在性与可注入性，再切换到该标签页采集。',
  },
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
      '仅枚举：快照分页页码（从 1 开始，不是网页翻页）。新查询省略或传 1；续读传返回的 nextPage，nextPage=null 即结束。',
  },
  pageSize: {
    type: 'integer',
    minimum: 1,
    maximum: PAGE_SIZE,
    description:
      `仅枚举：本页返回条数（1-${PAGE_SIZE}，默认 ${PAGE_SIZE}）。新查询生效并绑定快照；续读须与首次一致（改变即按新查询从 page=1 重采）。上下文紧张时调小（如 10）。`,
  },
  hitsOnly: {
    type: 'boolean',
    description:
      '仅枚举：只返回命中 regex/xpath 的元素（无过滤条件时无效），默认 false（命中置顶、其余候选仍返回）。搜索结果页/长列表只关心命中项时开启，可显著减少载荷。',
  },
  includeDetails: {
    type: 'boolean',
    description:
      '仅枚举：是否返回 details 结构化明细（默认 true）。只需要 ElementId/Type/Description 去交互时设为 false，载荷可减少一半以上。',
  },
};
const elementProperties = {
  tabId: {
    type: 'integer',
    minimum: 0,
    description:
      '目标标签页 ID（可选；省略=当前活动标签页）。显式传入会先核对存在性与可注入性，再切换到该标签页读取。',
  },
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
    // 纯读（DOM/AX 扫描，不写 DOM、不滚动、不改变视口）：视觉循环整批纯读
    // 时不重拍，截图身份继续有效。
    // 不变量（勿轻易改动）：本工具经 textCommand → cdpSession.attach 复用调试
    // 会话；action 快照存活期内会话被 retainUntil 保留（TTL 120s+30s），故不会
    // 新增 attach、不递增 epoch、不触发调试提示条导致的视口尺寸变化——
    // 即「豁免重拍」不会作废模型手里的截图凭据。
    // 例外：显式传 tabId 会先切换标签页（用户眼前页面变了），此时
    // vision-feedback 会按参数撤销豁免并重拍。
    noVisionRecapture: true,
  };
  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: this.name,
      description:
        '观察当前活动页。两种调用互斥：\n' +
        '1. 枚举：controls=按钮与输入（默认）；buttons/inputs=分类；structure=表格、选区、值/选项、滚动容器与 canvas；accessibility=辅助功能语义。categories 严格筛选类别（OR），结果 Category/State 与 details 提供类型、状态、关联引用和可用动作；close 关闭入口优先展示但不自动操作。自动覆盖可访问 frame，不传 elementId/frameId（包括 0/null）；可用 regex，DOM 视图还可用 xpath。例如 {"view":"controls","categories":["combobox","checkbox"]}。\n' +
        '2. 节点详情：仅传 view="element"、枚举返回的 DOM elementId 和同一行 frameId，读取属性、XPath、文字、状态、外观与 frame 内位置；不传 regex/xpath/page/snapshotId。AX 引用不支持此视图。\n' +
        '新枚举省略 snapshotId，从 page=1 开始；续读传 snapshotId，page 取上次返回的 nextPage，nextPage=null 即结束（这是快照内部的分页，不是网页翻页）。改变条件或操作后重新采集。# 是展示行号，不是 ElementId。交互调用 browser_interact：DOM 引用配同一行 FrameId，AX 引用自带路由。coverage 表示覆盖边界，未渲染数据不会自动出现。载荷太大时用 pageSize 调小每页条数、hitsOnly=true 只看命中项、includeDetails=false 省略明细（表格列仍含 ElementId/FrameId，交互照常引用）。',
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

  private async validate(snapshot: Snapshot, signal?: AbortSignal): Promise<{ valid: Set<number>; report: FrameReadReport }> {
    // Probe every accessible frame, including new/removed/navigated frames.
    const results = await readPageFrames({
      target: { tabId: snapshot.tabId, allFrames: true },
      world: 'ISOLATED',
      func: validateElementReferences,
      args: [[]],
    }, { operation: 'observe-document-validation', stage: 'validation', signal });
    const valid = new Set<number>();
    for (const frame of results) {
      if (!snapshot.fingerprints.has(frame.frameId)) {
        addFrameIssue(results.frameDiagnostics, { frameId: frame.frameId, stage: 'validation', code: 'NEW_FRAME_NOT_IN_SNAPSHOT', message: 'New frame is outside frozen snapshot membership; start a fresh query to include it' });
        continue;
      }
      if (
        !frame.result?.valid ||
        frame.result.fingerprint !== snapshot.fingerprints.get(frame.frameId)
      )
        addFrameIssue(results.frameDiagnostics, { frameId: frame.frameId, stage: 'validation', code: 'STALE_DOCUMENT', message: 'Document, route, revision, or frame membership differs from the snapshot; frame omitted' });
      else valid.add(frame.frameId);
    }
    for (const frameId of snapshot.fingerprints.keys()) {
      if (!results.some(r => r.frameId === frameId) && !results.frameDiagnostics.issues.some(i => i.frameId === frameId)) addFrameIssue(results.frameDiagnostics, { frameId, stage: 'validation', code: 'FRAME_MISSING', message: 'Snapshot frame was not found during validation; its elements are omitted' });
    }
    return { valid, report: results.frameDiagnostics };
  }

  async execute(args: ElementGetterArgs = {}, context?: ToolExecutionContext): Promise<ToolResult> {
    this.ensureBackgroundContext();
    try { return await exclusiveText(() => { context?.signal?.throwIfAborted(); return this.run(args, context); }, 8000, context?.signal); }
    catch (error) { return this.createErrorResponse(readableTextError(error)); }
  }
  private async run(args: ElementGetterArgs, context?: ToolExecutionContext): Promise<ToolResult> {
    const signal = context?.signal;
    try {
      const input = args ?? {};
      if (typeof input !== 'object' || Array.isArray(input))
        return this.createErrorResponse('参数必须是对象');
      const allowedKeys = [
        'view',
        'regex',
        'xpath',
        'snapshotId',
        'page',
        'pageSize',
        'hitsOnly',
        'includeDetails',
        'elementId',
        'frameId',
        'categories',
        'tabId',
      ];
      const unknownKeys = Object.keys(input).filter((k) => !allowedKeys.includes(k));
      if (unknownKeys.length > 0)
        return this.createErrorResponse(
          `存在未知参数：${unknownKeys.join('、')}。允许的参数：${allowedKeys.join('/')}。` +
            '本工具默认作用于当前活动标签页；要操作其它标签页请传 tabId（会先校验存在性并切换到该页）。',
        );
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
          'pageSize',
          'hitsOnly',
          'includeDetails',
          'categories',
        ].filter((key) => key in input);
        if (extraFields.length)
          return this.createErrorResponse(
            `INVALID_ARGUMENT：view=element 不接受 ${extraFields.join('/')}。删除这些字段，仅保留 view、elementId、frameId（可选 tabId）后重试。`,
          );
        const target = await resolveTabTarget({
          tabId: input.tabId,
          tool: 'browser_observe',
          context,
        });
        if (!target.ok) return this.createErrorResponse(target.error);
        const rows = await readPageFrames({
          target: { tabId: target.tabId, frameIds: [input.frameId!] },
          world: 'ISOLATED',
          func: elementInspectPayload,
          args: [input.elementId],
        }, { operation: 'observe-element', signal });
        const detail = rows[0]?.result;
        if (!detail || detail.error) {
          addFrameIssue(rows.frameDiagnostics, { frameId: input.frameId!, stage: 'read', code: 'ELEMENT_INSPECTION_FAILED', message: detail?.error || 'Element or frame disappeared' });
          return { ...this.createErrorResponse(
            detail?.error || '元素或 frame 已消失，请重新枚举',
          ), data: { frameDiagnostics: rows.frameDiagnostics } };
        }
        return this.createSuccessResponse({
          ...detail,
          frameDiagnostics: rows.frameDiagnostics,
          frameId: input.frameId,
          tabId: target.tabId,
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
        const target = await resolveTabTarget({
          tabId: input.tabId,
          tool: 'browser_observe',
          context,
        });
        if (!target.ok) return this.createErrorResponse(target.error);
        // Pin the resolved tab; the user may switch active tabs during an await.
        return this.createSuccessResponse(
          await observeAccessibility({
            ...(input.page !== undefined ? { page: input.page } : {}),
            ...(input.snapshotId !== undefined ? { snapshotId: input.snapshotId } : {}),
            ...(input.regex !== undefined ? { regex: input.regex } : {}),
            ...(input.xpath !== undefined ? { xpath: input.xpath } : {}),
            ...(input.categories !== undefined ? { categories: input.categories } : {}),
            tabId: target.tabId,
            signal,
          }),
        );
      }
      const page = input.page ?? 1;
      if (!Number.isSafeInteger(page) || page < 1)
        return this.createErrorResponse('page 必须是从 1 开始的有限整数');
      if (
        input.pageSize !== undefined &&
        (!Number.isSafeInteger(input.pageSize) ||
          input.pageSize < 1 ||
          input.pageSize > PAGE_SIZE)
      )
        return this.createErrorResponse(
          `pageSize 必须是 1-${PAGE_SIZE} 的整数（默认 ${PAGE_SIZE}）`,
        );
      for (const key of ['hitsOnly', 'includeDetails'] as const) {
        if (input[key] !== undefined && typeof input[key] !== 'boolean')
          return this.createErrorResponse(key + ' 必须是布尔值');
      }
      // 省略 tabId 一律操作当前活动页（语义与其它工具一致）：快照续读不会
      // 悄悄把用户眼前的页面切走。若快照属于别的标签页，下方以
      // STALE_SNAPSHOT + `tabId=<快照标签页>` 明确引导。
      const target = await resolveTabTarget({
        tabId: input.tabId,
        tool: 'browser_observe',
        context,
      });
      if (!target.ok) return this.createErrorResponse(target.error);
      const { tabId, url } = target;
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
            'STALE_SNAPSHOT：快照不存在、已过期或页面/标签页已改变。' +
              (stored
                ? `该快照属于标签页 ${stored.tabId}，需要续读请显式传 tabId=${stored.tabId}；`
                : '') +
              '省略 snapshotId，从 page=1 重新采集。',
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
        // 分页大小与 hitsOnly 改变会改变结果集边界：必须与快照一致，
        // 否则页码含义漂移（模型按旧 nextPage 续读会静默漏数据）
        if (input.pageSize !== undefined && input.pageSize !== stored.pageSize)
          return this.createErrorResponse(
            'QUERY_MISMATCH：快照绑定原 pageSize。改变每页条数时省略 snapshotId，从 page=1 重采。',
          );
        if (input.hitsOnly !== undefined && input.hitsOnly !== stored.hitsOnly)
          return this.createErrorResponse(
            'QUERY_MISMATCH：快照绑定原 hitsOnly。改变命中过滤时省略 snapshotId，从 page=1 重采。',
          );
        snapshot = stored;
      } else {
        if (page !== 1)
          return this.createErrorResponse(
            '翻页必须提供上次返回的 snapshotId；新查询必须从 page=1 开始。',
          );
        const regex = (input.regex || '').trim();
        const xpath = (input.xpath || '').trim();
        // hitsOnly 只对 regex/xpath 有意义：显式拒绝而不是静默降级，
        // 否则快照语义与模型预期不一致（续读时还会触发 QUERY_MISMATCH）
        if (input.hitsOnly && !(regex || xpath)) {
          return this.createErrorResponse(
            'hitsOnly=true 需要同时提供 regex 或 xpath；只按 categories 筛选时结果本身已收敛，删掉 hitsOnly 即可。',
          );
        }
        const hitsOnly = !!input.hitsOnly;
        const pageSize = input.pageSize ?? PAGE_SIZE;
        const results = await readPageFrames({
          target: { tabId, allFrames: true },
          world: 'ISOLATED',
          func: elementScanPayload,
          args: [input.view ?? this.defaultView, regex, xpath, tabId],
        }, { operation: 'observe-scan', signal });
        const elements: ScannedElement[] = [];
        const fingerprints = new Map<number, string>();
        for (const frame of results) {
          const payload = frame.result as PayloadResult | null | undefined;
          if (!payload || payload.error || typeof payload.fingerprint !== 'string' || !payload.fingerprint || !Array.isArray(payload.elements)) {
            addFrameIssue(results.frameDiagnostics, { frameId: frame.frameId, stage: 'read', code: 'PAYLOAD_ERROR', message: payload?.error || 'INCOMPLETE_SCAN: missing fingerprint/elements' });
            continue;
          }
          if (payload.truncated) addFrameIssue(results.frameDiagnostics, { frameId: frame.frameId, stage: 'read', scope: 'coverage', code: 'SCAN_TRUNCATED', message: payload.truncationReason || 'Traversal budget reached; collected controls preserved' });
          fingerprints.set(frame.frameId, payload.fingerprint);
          for (const element of payload.elements) {
            if (!element || typeof element.elementId !== 'string' || !element.elementId || typeof element.type !== 'string' || !Number.isFinite(element.score)) {
              addFrameIssue(results.frameDiagnostics, { frameId: frame.frameId, stage: 'read', scope: 'element', code: 'INVALID_ELEMENT_RESULT', message: 'Malformed control record omitted; other controls retained' });
              continue;
            }
            if (
              matchesControlCategory(element.semantics, input.categories || [])
            )
              elements.push({ ...element, frameId: frame.frameId });
          }
        }
        if (!fingerprints.size) return { ...this.createErrorResponse(results.frameDiagnostics.issues.map(i => i.message).join('; ') || 'INCOMPLETE_SCAN'), data: { frameDiagnostics: results.frameDiagnostics } };
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
          pageSize,
          hitsOnly,
          includeDetails: input.includeDetails !== false,
          frameDiagnostics: results.frameDiagnostics,
        };
        snapshotId = crypto.randomUUID();
        this.snapshots.set(snapshotId, snapshot);
        while (this.snapshots.size > 8)
          this.snapshots.delete(this.snapshots.keys().next().value!);
      }
      const validation = await this.validate(snapshot, signal);
      const diagnostics: FrameReadReport[] = [snapshot.frameDiagnostics, validation.report];
      if (!validation.valid.size) {
        this.snapshots.delete(snapshotId!);
        return { ...this.createErrorResponse(
          'STALE_SNAPSHOT：文档、路由或 frame 集合已改变，请从 page=1 重采。',
        ), data: { frameDiagnostics: diagnostics } };
      }
      const hasFilter = !!(snapshot.regex || snapshot.xpath);
      // 详情开关只影响载荷体积（不改变结果集）：续读省略时沿用快照，
      // 显式传入则以本次为准——避免「首次关了详情、续读又悄悄变回来」
      const includeDetails = input.includeDetails ?? snapshot.includeDetails;
      const totalHits = snapshot.elements.filter((el) => el.isHit).length;
      // hitsOnly：结果集收敛为命中项（分页边界同步收敛），未命中候选不再占预算
      const pool =
        snapshot.hitsOnly && hasFilter
          ? snapshot.elements.filter((el) => el.isHit)
          : snapshot.elements;
      const totalCandidates = snapshot.elements.length;
      const totalElements = pool.length;
      const totalPages = Math.max(1, Math.ceil(totalElements / snapshot.pageSize));
      if (page > totalPages)
        return this.createErrorResponse(
          'PAGE_OUT_OF_RANGE：共 ' +
            totalPages +
            ' 页，请使用有效页码，不会重复返回最后一页。',
        );
      const start = (page - 1) * snapshot.pageSize;
      const pageElements = pool.slice(start, start + snapshot.pageSize);
      let elements = pageElements.filter(el => validation.valid.has(el.frameId));
      // Optional async reads must precede final reference checks, not widen their age.
      let focus: Array<Record<string, unknown>> = [];
      try {
        const focused = await readPageFrames({ target: { tabId, allFrames: true }, world: 'ISOLATED', func: focusedTextPayload, args: [] }, { operation: 'observe-focus', stage: 'focus', timeoutMs: 2500, frameTimeoutMs: 1200, discoveryTimeoutMs: 500, signal });
        diagnostics.push(focused.frameDiagnostics);
        focus = focused.filter(r => {
          if (r.result && 'error' in r.result && r.result.error) {
            addFrameIssue(focused.frameDiagnostics, { frameId: r.frameId, stage: 'focus', code: 'FOCUS_READ_FAILED', message: String(r.result.error) });
            return false;
          }
          return !!r.result;
        }).map(r => ({ ...r.result, frameId: r.frameId }));
      } catch (error) {
        if (error instanceof PageReadError) diagnostics.push(error.frameDiagnostics);
        else diagnostics.push({ operation: 'observe-focus', status: 'failed', discoveryComplete: false, elapsedMs: 0, successfulFrameIds: [], issues: [{ stage: 'focus', code: 'UNEXPECTED_ERROR', message: readableTextError(error) }] });
      }
      // Second pass on every delivered page: exact node identity + document revision.
      const invalidFrames = new Set<number>();
      const invalidElements = new Set<string>();
      await Promise.all([...new Set(elements.map((el) => el.frameId))].map(async frameId => {
        let checked;
        try { checked = await readPageFrames({
          target: { tabId, frameIds: [frameId] },
          world: 'ISOLATED',
          func: validateElementReferences,
          args: [
            elements
              .filter((el) => el.frameId === frameId)
              .map((el) => el.elementId),
            snapshot.view !== 'structure',
          ],
        }, { operation: 'observe-reference-validation', stage: 'validation', signal }); }
        catch (error) {
          invalidFrames.add(frameId);
          if (error instanceof PageReadError) diagnostics.push(error.frameDiagnostics);
          else throw error;
          return;
        }
        diagnostics.push(checked.frameDiagnostics);
        if (
          checked.length !== 1 ||
          (!checked[0].result?.valid && !Array.isArray(checked[0].result?.validElementIds)) ||
          checked[0].result.fingerprint !== snapshot.fingerprints.get(frameId)
        ) {
          invalidFrames.add(frameId);
          addFrameIssue(checked.frameDiagnostics, { frameId, stage: 'validation', code: 'STALE_ELEMENTS', message: 'Node identity or document fingerprint changed before delivery; frame omitted' });
          return;
        }
        const referenceCheck = checked[0].result!;
        if (Array.isArray(referenceCheck.validElementIds)) {
          const allowed = new Set(referenceCheck.validElementIds);
          const omittedIds = elements.filter(el => el.frameId === frameId && !allowed.has(el.elementId)).map(el => el.elementId);
          for (const id of omittedIds) invalidElements.add(id);
          if (omittedIds.length) addFrameIssue(checked.frameDiagnostics, { frameId, stage: 'validation', scope: 'element', elementIds: omittedIds, code: 'STALE_ELEMENTS', message: 'These references failed identity/render/actionability checks and were omitted; other references retained' });
          for (const failure of referenceCheck.errors ?? []) addFrameIssue(checked.frameDiagnostics, { frameId, stage: 'validation', scope: 'element', elementIds: [failure.elementId], code: 'REFERENCE_VALIDATION_FAILED', message: failure.message });
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
            { invalidElements.add(element.elementId); addFrameIssue(checked.frameDiagnostics, { frameId, stage: 'validation', scope: 'element', elementIds: [element.elementId], code: 'STALE_ELEMENTS', message: 'Control category changed; element omitted' }); continue; }
          element.semantics = live.semantics;
          element.details = {
            ...element.details,
            ...live.semantics,
            ...live.semantics.states,
          };
        }
      }));
      elements = elements.filter(el => !invalidFrames.has(el.frameId) && !invalidElements.has(el.elementId));
      if (pageElements.length && !elements.length) return { ...this.createErrorResponse('STALE_ELEMENTS：本页引用均未通过核验，省略 snapshotId 重采。'), data: { frameDiagnostics: diagnostics } };
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
            escapeCell(clipCell(el.description || '-')) +
            ' | ' +
            escapeCell(clipCell(el.context || '-')) +
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
          focus,
          frameDiagnostics: diagnostics,
          partial: diagnostics.some(r => r.status !== 'complete') || elements.length !== pageElements.length,
          omittedElements: pageElements.length - elements.length,
          coverage: {
            complete: false,
            source: 'DOM in injectable frames; only currently rendered nodes',
          },
          ...(includeDetails
            ? {
                details: elements
                  .filter((el) => el.details)
                  .map((el) => ({
                    elementId: el.elementId,
                    frameId: el.frameId,
                    ...el.details,
                  })),
              }
            : {}),
          tabId,
          url,
          query: {
            regex: snapshot.regex,
            xpath: snapshot.xpath,
            categories: snapshot.categories,
          },
          totalElements,
          ...(snapshot.hitsOnly ? { totalCandidates } : {}),
          ...(hasFilter ? { totalHits } : {}),
          page,
          pageSize: snapshot.pageSize,
          totalPages,
          nextPage: page < totalPages ? page + 1 : null,
          filtered: hasFilter,
          ...(hasFilter ? { hitsOnly: snapshot.hitsOnly } : {}),
          snapshotReused,
          hint:
            (hasFilter && totalHits === 0
              ? snapshot.hitsOnly
                ? '没有任何元素命中过滤条件（hitsOnly 下结果为空）：改用正则的片段、去掉 xpath 后重试，或设 hitsOnly=false 查看全部候选。'
                : '没有任何元素命中过滤条件，表格仍包含其余候选。'
              : '') +
            '续读传 snapshotId 和 page（取 nextPage 的值）；改变条件或操作后省略 snapshotId 重采。节点详情用 view=element，交互用 browser_interact；枚举不传 elementId/frameId。' +
            (snapshot.view === 'structure' && !includeDetails
              ? '注意：structure 视图的表格行/选区与选项数据在 details 中，includeDetails=false 时只剩元素摘要，需要表格内容请不要关闭。'
              : '') +
            (elements.length >= 20 && includeDetails
              ? '载荷偏大时可设 includeDetails=false（省略 details）或 pageSize 调小。'
              : ''),
        },
        '本页 ' +
          elements.length +
          ' 条 / 共 ' +
          totalElements +
          ' 条（快照第 ' +
          page +
          '/' +
          totalPages +
          ' 页，每页 ' +
          snapshot.pageSize +
          ' 条）。' +
          (hasFilter
            ? snapshot.hitsOnly
              ? `已按命中过滤：命中 ${totalHits} 条。`
              : `命中 ${totalHits} 条（置顶显示，其余为候选）。`
            : ''),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('background context')
      )
        throw error;
      return { ...this.createErrorResponse(
        '页面观察失败；等待稳定后从 page=1 重采',
        new Error(readableTextError(error)),
      ), ...(error instanceof PageReadError ? { data: { frameDiagnostics: error.frameDiagnostics } } : {}) };
    }
  }
}
