import { exclusiveText, readableTextError } from './text-runtime';
import { readPageFrames, PageReadError, addFrameIssue, type FrameReadReport } from '../common/frame-read';
import { elementInspectPayload } from './element-inspect-payload';
/** Explicit, bounded snapshots. A fresh request always scans; continuation never silently changes datasets. */
import { BaseBrowserTool } from '../base/browser-tool';
import type { ToolMetadata, ToolExecutionContext } from '../registry';
import type { OpenAITool } from '@/common/openai-types';
import { observeAccessibility } from './text-accessibility';
import { focusedTextPayload, dedupeFocusEntries } from './text-target-payload';
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
  /** 扫描范围：父容器 CSS 选择器（可选，空串 = 文档根） */
  parentSelector: string;
  /** 扫描范围：父容器 XPath（可选，与 parentSelector 互斥） */
  parentXPath: string;
  /** 扫描范围：限定 frameId（可选；undefined = 所有可访问 frame） */
  frameId?: number;
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
  /** 仅枚举：限定扫描的父容器（CSS 选择器，可选；与 parentXPath 互斥） */
  parentSelector?: string;
  /** 仅枚举：限定扫描的父容器（XPath 1.0，可选；与 parentSelector 互斥） */
  parentXPath?: string;
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
/** 按指定长度截断（form 行的 label/value 用，长度与表格列不同） */
const clipTo = (text: string, max: number): string =>
  text.length > max ? text.slice(0, max) + '…' : text;
/**
 * CSS modules 类名哈希尾段（`PCButton--pcButton--WUbRi2M` 的第三段）随构建
 * 每次变化，对模型零信息——展示层裁到前两段。只动 ≥3 段的 `--` 结构，
 * `next-select-arrow` 这类单连字符类名不受影响。仅用于展示；dom_explore
 * 生成选择器走原始类名。
 */
const trimCssHash = (text: string): string =>
  text.replace(/[A-Za-z0-9_]+(?:--[A-Za-z0-9_]+){2,}/g, (token) =>
    token.split('--').slice(0, 2).join('--'),
  );

// Enumeration never targets an element/frame; keep the schema branches separate.
const enumerationProperties = {
  tabId: {
    type: 'integer',
    minimum: 0,
    description:
      '目标标签页 ID（可选；省略=当前活动标签页）。显式传入会先核对存在性与可注入性，再切换到该标签页采集。',
  },
  frameId: {
    type: 'integer',
    minimum: 0,
    description:
      '仅枚举：限定在指定 frame 内扫描（可选；省略=所有可访问 frame）。与回执表格中的 FrameId 同源。',
  },
  parentSelector: {
    type: 'string',
    maxLength: 2000,
    description:
      '仅枚举：只扫描该 CSS 选择器命中的父容器子树（可选；与 parentXPath 互斥）。命中多个容器时全部扫描；所有 frame 都未命中直接报错，不会退回整页。' +
      '与 xpath 的区别：parent* 是**结果集裁剪**（容器外元素完全不返回），xpath 只做命中标记（容器外元素仍在候选里）——想限定范围用本参数；可与 regex/xpath 同传（AND：先定范围，再在范围内标命中）。',
  },
  parentXPath: {
    type: 'string',
    maxLength: 2000,
    description:
      '仅枚举：只扫描该 XPath 1.0 命中的父容器子树（可选；与 parentSelector 互斥）。命中多个容器时全部扫描；所有 frame 都未命中直接报错，不会退回整页。' +
      '仅命中非元素节点时明确拒绝（容器必须是元素）。同样做**结果集裁剪**（区别于 xpath 过滤参数的"命中标记"语义），两者可 AND 组合。',
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
    enum: ['controls', 'buttons', 'inputs', 'structure', 'accessibility', 'form'],
    description:
      '枚举视图；新查询默认 controls，续读省略时继承快照视图。form=表单盘点（字段+分区+填写顺序，表格自带明细，不另返回 details）。',
  },
  regex: {
    type: 'string',
    description:
      '不区分大小写。DOM：匹配文字/placeholder/aria-label 等，命中置顶，未命中候选仍返回，只有 Hit 标记才算命中；AX：只返回匹配语义节点。',
  },
  xpath: {
    type: 'string',
    description:
      '仅 DOM 枚举：XPath 1.0，元素或祖先命中，只做**命中标记**（未命中元素仍作为候选返回）。和 regex 同传为 AND；' +
      '若目的是按容器限定范围（容器外元素不进结果），改用 parentSelector/parentXPath。XPath 未命中时删除 xpath，再单独用 regex 兜底。Shadow 内局部路径不能直接作为文档 XPath。',
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
      '纯文本页面观察：控件、输入、表格结构、表单盘点与浏览器辅助功能树，稳定引用与快照分页',
    category: 'browser',
    version: '6.1.0',
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
      /**
       * 描述采用 XML 分段：模型按段读取比读一整段散文更准，
       * 且每段的边界（能做什么/怎么传/拿回什么/出错怎么办）互不干扰。
       * 固定不变的用法说明只在此处出现一次，不在每次调用的结果里重复。
       */
      description:
        '<observe>\n' +
        '  <capability>观察当前活动页，产出可交互元素的稳定引用（ElementId + FrameId），供 browser_interact 操作。</capability>\n' +
        '  <modes>\n' +
        '    <mode name="枚举">默认 controls=按钮与输入；buttons/inputs=按类别；structure=表格、选区、值/选项、滚动容器与 canvas；accessibility=辅助功能语义；form=表单盘点（按填写顺序列出字段与动作，每行带分区/label/name/必填/当前值，适合长表单一次性摸清结构）。categories 严格筛选（OR）。自动覆盖可访问 frame。</mode>\n' +
        '    <mode name="节点详情">仅传 view="element" + 枚举返回的 DOM elementId + 同行 frameId；读属性、XPath、文字、状态、外观与 frame 内位置。不接受 regex/xpath/page/snapshotId；AX 引用不支持此视图。</mode>\n' +
        '  </modes>\n' +
        '  <usage>\n' +
        '    <item>新枚举省略 snapshotId，从 page=1 开始。</item>\n' +
        '    <item>续读传 snapshotId + page（取上次返回的 nextPage；nextPage=null 即结束）。这是快照内部的分页，不是网页翻页。</item>\n' +
        '    <item>改变条件或执行操作后必须重新采集（省略 snapshotId）。</item>\n' +
        '    <item>表格里的 # 是展示行号，不是 ElementId；ElementId 是 anx: 开头的整串。</item>\n' +
        '    <item>载荷太大时：pageSize 调小每页条数、hitsOnly=true 只看命中项、includeDetails=false 省略明细（表格仍含 ElementId/FrameId，交互照常引用）。</item>\n' +
        '    <item>长表单/多区块表单先用 view="form" 盘点一次（分区+字段+必填+现值一次拿全，不返回 details），再按行引用交互；不要用 controls 分页翻找字段。</item>\n' +
        '    <item>范围可选：frameId 只扫指定 frame；parentSelector / parentXPath 只扫该父容器子树（两者互斥）。parent* 是结果集裁剪（容器外不返回），xpath 过滤只是命中标记（容器外仍在候选）。所有 frame 都没有该父容器时直接报错，不会退回整页；仅部分 frame 没有时该 frame 静默缺席。</item>\n' +
        '  </usage>\n' +
        '  <result>elements 表格给出类型/描述/上下文/ElementId/FrameId/类别/状态（view=form 时改为行式清单：分区/label/name/必填/现值并入每行，不返回 details）；details 给出识别依据、关联引用与可用动作；focus 给当前焦点；coverage 给覆盖边界（未渲染的数据不会出现）。</result>\n' +
        '</observe>',
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
          // 合并后 frameId 同时服务两条分支：枚举为可选范围，element 为必填定位
          frameId: {
            type: 'integer',
            minimum: 0,
            description:
              '枚举：可选，限定扫描的 frameId；view=element：必填，必须与 ElementId 同一行（0 也要显式传）。',
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

  private async validate(snapshot: Snapshot, signal?: AbortSignal, context?: ToolExecutionContext): Promise<{ valid: Set<number>; report: FrameReadReport }> {
    // Probe every accessible frame, including new/removed/navigated frames.
    const results = await readPageFrames({
      target: snapshot.frameId !== undefined
        ? { tabId: snapshot.tabId, frameIds: [snapshot.frameId] }
        : { tabId: snapshot.tabId, allFrames: true },
      world: 'ISOLATED',
      func: validateElementReferences,
      args: [[]],
    }, { operation: 'observe-document-validation', stage: 'validation', signal }, context);
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
        'parentSelector',
        'parentXPath',
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
          'form',
          'element',
        ].includes(input.view)
      )
        return this.createErrorResponse(
          'view 无效：合法值为 controls/buttons/inputs/structure/accessibility/form，节点详情为 element。',
        );
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
          'parentSelector',
          'parentXPath',
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
        }, { operation: 'observe-element', signal }, context);
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
      const referenceFields = ['elementId'].filter(
        (key) => key in input,
      );
      if (referenceFields.length)
        return this.createErrorResponse(
          `INVALID_ARGUMENT：枚举不接受 ${referenceFields.join('/')}。删除这些字段，保留原枚举条件后重试；节点详情才使用 view=element + elementId + frameId。`,
        );
      const requestedFrameId = input.frameId;
      if (
        requestedFrameId !== undefined &&
        (!Number.isSafeInteger(requestedFrameId) || requestedFrameId < 0)
      )
        return this.createErrorResponse(
          'INVALID_ARGUMENT：枚举的 frameId 必须是非负整数（省略 = 扫描所有可访问 frame）。',
        );
      for (const key of ['parentSelector', 'parentXPath'] as const) {
        if (input[key] !== undefined && typeof input[key] !== 'string')
          return this.createErrorResponse(`${key} 必须是字符串（CSS 选择器 / XPath）`);
        if (typeof input[key] === 'string' && input[key]!.trim().length > 2000)
          return this.createErrorResponse(
            `INVALID_ARGUMENT：${key} 过长（上限 2000 字符）。请缩小父容器范围或改用更短的选择器。`,
          );
      }
      const trimmedParentSelector = (input.parentSelector || '').trim();
      const trimmedParentXPath = (input.parentXPath || '').trim();
      if (trimmedParentSelector && trimmedParentXPath)
        return this.createErrorResponse(
          'INVALID_ARGUMENT：parentSelector 与 parentXPath 只能二选一。请删除其中一个后重试。',
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
          'INVALID_ARGUMENT：categories 必须是非空、无重复的已知类别数组。合法类别（共 ' +
            CONTROL_CATEGORIES.length +
            ' 个）：' +
            CONTROL_CATEGORIES.join('/') +
            '。注意没有 "input"（文本框是 "text"）与 "submit"（按钮是 "button"）。',
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
        if (
          input.frameId !== undefined ||
          (input.parentSelector && input.parentSelector.trim()) ||
          (input.parentXPath && input.parentXPath.trim())
        )
          return this.createErrorResponse(
            'INVALID_ARGUMENT：accessibility 视图不支持 frameId / parentSelector / parentXPath 范围参数。删除这些字段后重试，或改用 DOM 枚举视图。',
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
          }, context),
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
          (input.parentSelector !== undefined && input.parentSelector.trim() !== stored.parentSelector) ||
          (input.parentXPath !== undefined && input.parentXPath.trim() !== stored.parentXPath) ||
          (input.frameId !== undefined && input.frameId !== stored.frameId) ||
          (input.categories !== undefined &&
            JSON.stringify([...input.categories].sort()) !==
              JSON.stringify(stored.categories))
        ) {
          return this.createErrorResponse(
            'QUERY_MISMATCH：快照绑定原过滤条件与扫描范围（regex/xpath/categories/parentSelector/parentXPath/frameId）。改变或清除条件时省略 snapshotId，并从 page=1 开始。',
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
        // 扫描范围：frameId 可选（限定单 frame），父容器可选（限定子树）
        const envScope = input.frameId;
        const results = await readPageFrames({
          target: envScope !== undefined
            ? { tabId, frameIds: [envScope] }
            : { tabId, allFrames: true },
          world: 'ISOLATED',
          func: elementScanPayload,
          args: [
            input.view ?? this.defaultView,
            regex,
            xpath,
            tabId,
            trimmedParentSelector,
            trimmedParentXPath,
          ],
        }, { operation: 'observe-scan', signal }, context);
        if (envScope !== undefined && results.length === 0) {
          return { ...this.createErrorResponse(
            `FRAME_NOT_FOUND：frameId=${envScope} 不存在或不可注入。请省略 frameId 扫描所有可访问 frame，或确认页面内嵌框架已加载。`,
          ), data: { frameDiagnostics: results.frameDiagnostics } };
        }
        const elements: ScannedElement[] = [];
        const fingerprints = new Map<number, string>();
        // 父容器作用域的全 frame 判定：containerMiss（合法但本 frame 无容器）
        // 静默计入成员——多 frame 页面里子 frame 没有容器是常态，逐帧报
        // PAYLOAD_ERROR + 验证期 NEW_FRAME 双重误报会淹没真问题；
        // 只有**所有**已扫描 frame 都未命中时才升级为 PARENT_CONTAINER_NOT_FOUND。
        const scopeRequested = !!(trimmedParentSelector || trimmedParentXPath);
        let containerMissCount = 0;
        let scannedFrameCount = 0;
        for (const frame of results) {
          const payload = frame.result as PayloadResult | null | undefined;
          if (payload && payload.containerMiss) {
            containerMissCount++;
            // fingerprint 照常入册：缺席 frame 仍是快照成员，后续 validate()
            // 不会把它误判成 NEW_FRAME_NOT_IN_SNAPSHOT
            if (typeof payload.fingerprint === 'string' && payload.fingerprint)
              fingerprints.set(frame.frameId, payload.fingerprint);
            continue;
          }
          if (!payload || payload.error || typeof payload.fingerprint !== 'string' || !payload.fingerprint || !Array.isArray(payload.elements)) {
            addFrameIssue(results.frameDiagnostics, { frameId: frame.frameId, stage: 'read', code: 'PAYLOAD_ERROR', message: payload?.error || 'INCOMPLETE_SCAN: missing fingerprint/elements' });
            continue;
          }
          scannedFrameCount++;
          if (payload.truncated) addFrameIssue(results.frameDiagnostics, { frameId: frame.frameId, stage: 'read', scope: 'coverage', code: 'SCAN_TRUNCATED', message: payload.truncationReason || 'Traversal budget reached; collected controls preserved' });
          fingerprints.set(frame.frameId, payload.fingerprint);
          for (const element of payload.elements) {
            if (!element || typeof element.elementId !== 'string' || !element.elementId || typeof element.type !== 'string' || !Number.isFinite(element.score)) {
              addFrameIssue(results.frameDiagnostics, { frameId: frame.frameId, stage: 'read', scope: 'element', code: 'INVALID_ELEMENT_RESULT', message: 'Malformed control record omitted; other controls retained' });
              continue;
            }
            if (
              // form 视图的分区脚手架不参与类别筛选：类别过滤掉标题会让
              // 该区字段失去 section 上下文（分类信息在语义，不在分组行）
              element.type === 'section' ||
              matchesControlCategory(element.semantics, input.categories || [])
            )
              elements.push({ ...element, frameId: frame.frameId });
          }
        }
        if (scopeRequested && scannedFrameCount === 0) {
          const selectorText = trimmedParentSelector || trimmedParentXPath;
          const firstPayloadIssue = results.frameDiagnostics.issues.find(
            (issue) => issue.code === 'PAYLOAD_ERROR',
          );
          const parts: string[] = [];
          if (containerMissCount > 0)
            parts.push(
              `PARENT_CONTAINER_NOT_FOUND：父容器（${selectorText}）在全部 ${containerMissCount} 个已扫描 frame 中均未命中。请确认选择器或 frameId，或省略 parent 参数改为整页扫描。`,
            );
          // 帧级硬错误（非法选择器等）比"未命中"更具体，一并透出
          if (firstPayloadIssue) parts.push(firstPayloadIssue.message);
          return {
            ...this.createErrorResponse(
              parts.join('；') ||
                `PARENT_CONTAINER_NOT_FOUND：父容器（${selectorText}）未命中。`,
            ),
            data: { frameDiagnostics: results.frameDiagnostics },
          };
        }
        if (!fingerprints.size) return { ...this.createErrorResponse(results.frameDiagnostics.issues.map(i => i.message).join('; ') || 'INCOMPLETE_SCAN'), data: { frameDiagnostics: results.frameDiagnostics } };
        elements.sort(
          (a, b) =>
            Number(b.isHit) - Number(a.isHit) ||
            b.score - a.score ||
            a.frameId - b.frameId ||
            a.elementId.localeCompare(b.elementId),
        );
        const snapshotView = (input.view ?? this.defaultView) as ScanMode;
        // form 视图：把分区标题（section 脚手架行）折进每个字段的
        // details.section 并移除标题行本身；标题命中 regex 时其整区字段继承
        // 命中（模型搜「教育情况」应得到该区所有字段）。存储序 = 命中置顶 + 文档序。
        if (snapshotView === 'form') {
          const ordered = [...elements].sort(
            (a, b) => (a.y ?? 0) - (b.y ?? 0),
          );
          const kept: ScannedElement[] = [];
          let section = '';
          let sectionHit = false;
          for (const el of ordered) {
            if (el.type === 'section') {
              section = (el.description || '').slice(0, 80);
              sectionHit = el.isHit;
              continue;
            }
            if (sectionHit) el.isHit = true;
            el.details = { ...(el.details || {}), section };
            kept.push(el);
          }
          kept.sort(
            (a, b) => Number(b.isHit) - Number(a.isHit) || (a.y ?? 0) - (b.y ?? 0),
          );
          elements.length = 0;
          elements.push(...kept);
        }
        snapshot = {
          tabId,
          url,
          regex,
          xpath,
          categories: [...(input.categories || [])].sort(),
          view: snapshotView,
          timestamp: Date.now(),
          elements,
          fingerprints,
          pageSize,
          hitsOnly,
          includeDetails: input.includeDetails !== false,
          parentSelector: trimmedParentSelector,
          parentXPath: trimmedParentXPath,
          ...(envScope !== undefined ? { frameId: envScope } : {}),
          frameDiagnostics: results.frameDiagnostics,
        };
        snapshotId = crypto.randomUUID();
        this.snapshots.set(snapshotId, snapshot);
        while (this.snapshots.size > 8)
          this.snapshots.delete(this.snapshots.keys().next().value!);
      }
      const validation = await this.validate(snapshot, signal, context);
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
        const focused = await readPageFrames({
          target: snapshot.frameId !== undefined
            ? { tabId, frameIds: [snapshot.frameId] }
            : { tabId, allFrames: true },
          world: 'ISOLATED',
          func: focusedTextPayload,
          args: [],
        }, { operation: 'observe-focus', stage: 'focus', timeoutMs: 2500, frameTimeoutMs: 1200, discoveryTimeoutMs: 500, signal }, context);
        diagnostics.push(focused.frameDiagnostics);
        type FocusEntry = { elementId?: string; state?: string; [key: string]: unknown };
        const focusCandidates: FocusEntry[] = [];
        for (const entry of focused) {
          if (entry.result && 'error' in entry.result && entry.result.error) {
            addFrameIssue(focused.frameDiagnostics, { frameId: entry.frameId, stage: 'focus', code: 'FOCUS_READ_FAILED', message: String(entry.result.error) });
            continue;
          }
          if (entry.result) focusCandidates.push({ ...entry.result, frameId: entry.frameId });
        }
        focus = dedupeFocusEntries(focusCandidates);
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
        }, { operation: 'observe-reference-validation', stage: 'validation', signal }, context); }
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
      const hitMark = (el: ScannedElement): string =>
        hasFilter && el.isHit
          ? ' ✓(' +
            (el.matchedRegex && el.matchedXpath
              ? 'regex+xpath'
              : el.matchedRegex
                ? 'regex'
                : 'xpath') +
            ')'
          : '';
      const lines =
        snapshot.view === 'form'
          ? // 表单视图：行式清单（分区 + label + name + 必填 + 现值 + 引用），
            // 比 markdown 表窄得多，且行内自含分区上下文——分页切开后仍可读。
            elements.map((el, i) => {
              const detail = (el.details || {}) as Record<string, unknown>;
              const section =
                typeof detail.section === 'string' && detail.section
                  ? detail.section.slice(0, 80)
                  : '-';
              const parts = [
                `${start + i + 1}. [${section}] ${clipTo(el.description || '-', 120)}`,
                `type=${el.type.slice(0, 40)}`,
              ];
              if (typeof detail.name === 'string' && detail.name)
                parts.push(`name=${detail.name.slice(0, 80)}`);
              if (detail.required === true) parts.push('必填');
              if (typeof detail.value === 'string' && detail.value)
                parts.push(`value=${clipTo(detail.value, 80)}`);
              parts.push(el.elementId, `frame=${el.frameId}`);
              return parts.join(' | ') + hitMark(el);
            })
          : [
              '| # | Type | Description | Context | ElementId | FrameId | Category | State |' +
                (hasFilter ? ' Hit |' : ''),
              '|---|---|---|---|---|---|---|---|' + (hasFilter ? '---|' : ''),
              ...elements.map((el, i) => {
                // 上下文列：同构记录会整段重复同样的邻近文本（实测某表单页
                // 96% 是重复），逐行复读纯烧预算——与上一行相同则折叠为 〃
                const context =
                  i > 0 && elements[i - 1].context === el.context && el.context
                    ? '〃'
                    : clipCell(el.context || '-');
                const states = Object.fromEntries(
                  Object.entries(el.semantics?.states || {}).filter(
                    ([key, value]) =>
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
                      ].includes(key) &&
                      // 默认值回显是纯样板：disabled/readonly=false 与空 value
                      // 在每一行都重复出现（实测占 State 列大头），略去即等价
                      !(key === 'disabled' && value === false) &&
                      !(key === 'readonly' && value === false) &&
                      !(key === 'value' && value === ''),
                  ),
                );
                const stateText = JSON.stringify(states);
                return (
                  '| ' +
                  (start + i + 1) +
                  ' | ' +
                  escapeCell(el.type.slice(0,100)) +
                  ' | ' +
                  escapeCell(clipCell(trimCssHash(el.description || '-'))) +
                  ' | ' +
                  escapeCell(context) +
                  ' | ' +
                  el.elementId +
                  ' | ' +
                  el.frameId +
                  ' | ' +
                  (el.semantics?.category || 'element') + (el.semantics?.patterns?.length ? ' [' + el.semantics.patterns.join(',') + ']' : '') +
                  ' | ' +
                  escapeCell(stateText === '{}' ? '-' : stateText) +
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
                );
              }),
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
          ...(includeDetails && snapshot.view !== 'form'
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
          /**
           * 只保留** situational** 的提示（与本次结果相关的事实）。
           *
           * 固定的用法说明（怎么续读、怎么交互、载荷怎么调）已写进工具描述，
           * 在这里逐次重复只会消耗上下文、稀释真正需要注意的信息。
           */
          ...(hasFilter && totalHits === 0
            ? {
                hint:
                  snapshot.hitsOnly
                    ? '没有任何元素命中过滤条件（hitsOnly 下结果为空）：改用正则的片段、去掉 xpath 后重试，或设 hitsOnly=false 查看全部候选。'
                    : '没有任何元素命中过滤条件，表格仍包含其余候选。',
              }
            : {}),
          // 父容器存在但内部空（容器自身不计入结果）——不给提示模型会以为采集中断
          ...((snapshot.parentSelector || snapshot.parentXPath) &&
          !totalElements &&
          !(hasFilter && totalHits === 0)
            ? {
                hint:
                  '父容器已命中但其内部没有符合当前视图的可采集元素（容器本身不计入结果）。确认视图是否合适，或省略 parent 参数改为整页扫描。',
              }
            : {}),
          ...(snapshot.view === 'structure' && !includeDetails
            ? {
                hint:
                  'structure 视图的表格行/选区与选项数据在 details 中，includeDetails=false 时只剩元素摘要，需要表格内容请不要关闭。',
              }
            : {}),
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
          ' 条' +
          (snapshot.view === 'form'
            ? '，表单视图：按填写顺序，分区已并入每行 [分区]，字段明细直接在行内'
            : '') +
          '）。' +
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
      const message = readableTextError(error);
      // 限定/依赖 frameId 的路径在 frame 不存在时由 frame-read 以 NO_RESULT 收口——
      // 必须映射为可定位的 FRAME_NOT_FOUND，而不是笼统的「页面观察失败」。
      // 两条路径的指引不同：枚举范围可省略 frameId，节点详情必须重新枚举。
      // 注意：catch 在 `const input` 的块外，只能读 run 的入参 args（形态防御后使用）。
      const scopeInput: ElementGetterArgs =
        args && typeof args === 'object' && !Array.isArray(args) ? args : {};
      if (scopeInput.frameId !== undefined && /NO_RESULT/.test(message)) {
        return {
          ...this.createErrorResponse(
            scopeInput.view === 'element'
              ? `FRAME_NOT_FOUND：frameId=${scopeInput.frameId} 不存在或不可注入（${message}）。该引用所属 frame 可能已销毁，请重新 browser_observe 获取新的 ElementId/FrameId。`
              : `FRAME_NOT_FOUND：frameId=${scopeInput.frameId} 不存在或不可注入（${message}）。请省略 frameId 扫描所有可访问 frame，或确认页面内嵌框架已加载。`,
          ),
          ...(error instanceof PageReadError
            ? { data: { frameDiagnostics: error.frameDiagnostics } }
            : {}),
        };
      }
      return { ...this.createErrorResponse(
        '页面观察失败；等待稳定后从 page=1 重采',
        new Error(message),
      ), ...(error instanceof PageReadError ? { data: { frameDiagnostics: error.frameDiagnostics } } : {}) };
    }
  }
}
