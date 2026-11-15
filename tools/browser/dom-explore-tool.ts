import { readPageFrames, PageReadError, addFrameIssue, type FrameReadReport, type FrameResults } from '../common/frame-read';
/**
 * DOM 关系探索工具（browser_dom_explore）
 *
 * 面向「大量重复元素」界面（商品卡片、评论列表、表格行）的结构理解与
 * 数据提取辅助：以元素为种子，探索其祖先链、子元素、兄弟与全页相似元素，
 * 把「这个列表怎么重复的、字段挂在哪」变成一次可分页读取的确定性结果。
 *
 * 种子来源（按优先级）：
 *   1. elementId + frameId —— browser_observe / 本工具返回的 DOM 引用（最精准）；
 *   2. selector —— CSS 选择器（自动搜索开放 Shadow DOM；未给 frameId 时跨全部
 *      frame 查找，唯一匹配自动定位，多匹配返回候选列表）；
 *   3. xpath —— CSS 无法表达时使用（同上，支持全部 frame 与开放 Shadow DOM）。
 *   没有任何引用时也**不必**先 observe：selector/xpath 会按需创建与 observe
 *   契约一致的引用注册表，解析出的种子同样返回 ElementId。
 *
 * 与既有工具的配合（引用体系互通）：
 *   - 输入：browser_observe（任意枚举视图）返回的 DOM elementId + 同行 frameId，
 *     或 CSS selector / XPath；
 *   - 输出：所有发现的元素注册进同一共享注册表，新 elementId 可直接交给
 *     browser_observe(view=element) 深查属性、browser_interact 操作、或
 *     本工具继续探索；payload.nextActions 直接给出可复制的下一步调用参数；
 *   - similar 附带生成选择器与实测匹配数——模型可把它直接写进
 *     js_run 的抓取脚本（querySelectorAll 批量抽取），结果自动落
 *     results/ 结果文件 → data_ref_tool 治理 → xlsx_tool(dataFiles) 导出。
 *
 * 分页契约（children/siblings/similar）：与 browser_observe 同构——首次
 * 调用从 page=1 采集并冻结为 snapshotId 快照，续读传 snapshotId + page
 * （取上次响应的 nextPage）；续读可省略种子参数（继承快照），改变条件或
 * 页面变化后须重新采集。每页 40 条，交付前对当页元素做二次引用核验。
 */

import { exclusiveText } from './text-runtime';
import { BaseBrowserTool } from '../base/browser-tool';
import type { ToolMetadata } from '../registry';
import type { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { TOOL_NAMES } from '@/common/constants';
import { resolveTabTarget } from './tab-target';
import {
  elementExplorePayload,
  exploreSeedLookupPayload,
  validateExploreReferences,
  type ExploreElementSummary,
  type ExplorePayloadResult,
  type ExploreSeedCandidate,
} from './element-explore-payload';

/** 每页交付条数（与 browser_observe 的 PAGE_SIZE 对齐） */
const EXPLORE_PAGE_SIZE = 40;
/** 快照存活时长（与 browser_observe 一致；引用注册表条目同为 120s） */
const SNAPSHOT_TTL_MS = 120_000;
/** 最大保留快照数（防内存膨胀；旧快照 FIFO 淘汰） */
const MAX_SNAPSHOTS = 8;
/** 跨 frame 种子查找时单 frame 返回的候选上限 */
const SEED_LOOKUP_LIMIT = 20;
/** selector/xpath 长度上限（超长必为误用） */
const MAX_SEED_CHARS = 2_000;

type ExploreAction = 'parent' | 'children' | 'siblings' | 'similar';
type SeedKind = 'element' | 'selector' | 'xpath';

/** 可复制的下一步调用（避免模型在 hint 文本里二次解析参数） */
interface NextAction {
  tool: string;
  args: Record<string, unknown>;
  why: string;
}

interface DomExploreParams {
  action?: ExploreAction;
  elementId?: string;
  frameId?: number;
  /** 种子 CSS 选择器（与 elementId / xpath 三选一） */
  selector?: string;
  /** 种子 XPath 1.0（与 elementId / selector 三选一） */
  xpath?: string;
  /** selector/xpath 多匹配时取第几个（1 起，默认 1） */
  matchIndex?: number;
  /** 目标标签页（可选；省略 = 当前活动页；显式传入会先切换到该标签页） */
  tabId?: number | string;
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
  frameDiagnostics?: FrameReadReport;
  tabId: number;
  url: string;
  action: ExploreAction;
  /** 种子身份（用于续读时校验是否换了目标） */
  seedKey: string;
  /** 种子原始形态（续读省略种子时用于回显，避免出现空 selector/elementId） */
  seedKind: SeedKind;
  seedValue: string;
  matchIndex: number;
  queryMatchIndex?: number;
  /** 新查询时按 matchIndex 选中帧内序号的过程说明（续读原样回显） */
  selectionNote?: string;
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
  seedMatchCount?: number;
  seedElementId?: string;
  fingerprint: string;
  timestamp: number;
}

/** 占位值识别：模型在没有引用时会用这些词「占位」，必须给出定向指引而不是格式报错 */
const PLACEHOLDER_SEED =
  /^(placeholder|dummy|xxx+|todo|tbd|n\/?a|none|null|undefined|element_?id|id|ref|selector|xpath|1|0|-1)$/i;

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

/** 种子身份键：用于快照续读时判断「是否换了探索目标」 */
function seedKeyOf(kind: SeedKind, value: string, matchIndex: number): string {
  return kind === 'element'
    ? `element:${value}`
    : `${kind}:${value}@${matchIndex}`;
}

export class DomExploreTool extends BaseBrowserTool {
  name = TOOL_NAMES.BROWSER.DOM_EXPLORE;

  metadata: ToolMetadata = {
    name: TOOL_NAMES.BROWSER.DOM_EXPLORE,
    description:
      'DOM 关系探索：以引用或选择器为种子获取祖先链/子元素/兄弟/相似重复元素列表，附生成选择器与可复制下一步，分页与引用齐全',
    category: 'browser',
    version: '1.1.0',
    tags: ['browser', 'dom', 'structure', 'explore', 'scrape', 'rpa'],
    displayName: 'DOM 关系探索',
    // 纯读（注入荷载只做结构遍历/相似元素发现，不写 DOM、不动视口）：
    // 视觉循环无需重拍，截图身份继续有效。
    // 例外：显式传 tabId 会先切换标签页，vision-feedback 会按参数撤销豁免。
    noVisionRecapture: true,
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAMES.BROWSER.DOM_EXPLORE,
      description:
        '探索目标元素的 DOM 关系，理解重复列表结构并定位批量抓取入口。\n' +
        '种子三选一（优先级从高到低）：① elementId + frameId —— browser_observe 或本工具返回的 DOM 引用，最精准；' +
        '② selector —— CSS 选择器，推荐给「已知类名/结构」的场景，自动搜索开放 Shadow DOM，未给 frameId 时跨全部 frame 查找；' +
        '③ xpath —— 仅当 CSS 无法表达时使用（XPath 1.0，必须选中元素节点）。' +
        'selector/xpath 匹配到多个元素时：未给 frameId 且未给 matchIndex 会返回跨 frame 候选列表（含每个候选的 ElementId，可直接选用）；给 matchIndex 则取第 N 个继续探索；显式给了 frameId 时不跨 frame 枚举，默认取该 frame 内第 1 个并在 note 中回显实际匹配数。' +
        '没有任何引用时无需先 observe——selector/xpath 会按需建立引用注册表。\n' +
        'action 四选一：parent=祖先链逐层摘要（附同构兄弟数，用于识别「重复卡片容器」在哪一层）；' +
        'children=子元素列表（depth 展开 1..3 层，用于确认卡片内字段布局）；siblings=同父兄弟全列；' +
        'similar=相似元素发现（自动识别重复容器组并逐容器等位匹配，附可直接用于 js_run 抓取脚本的生成选择器与实测匹配数）。' +
        '结果中的 nextActions 是可直接复制的下一步调用（tool + args），不必再从文本提示里拼参数。' +
        'children/siblings/similar 分页：首次 page=1 生成 snapshotId，续读只传 snapshotId + page（可省略种子参数）；改变条件或页面变化后重新采集。' +
        'tabId 可选：省略=当前活动页；显式传入会先切换到该标签页再执行。' +
        '典型链路：similar 拿到重复容器与选择器 → children 确认字段 → js_run 用选择器批量抓取（结果自动落 results/）→ xlsx_tool(dataFiles) 导出。',
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
              '种子 DOM ElementId（anx: 开头，原样复制观察结果）。与 selector/xpath 三选一；没有引用时不要传占位值，改用 selector。',
          },
          frameId: {
            type: 'integer',
            minimum: 0,
            description:
              '与 elementId 同一行的 FrameId（0 也要显式提供）。elementId 必填；selector/xpath 可省略（省略时跨全部 frame 查找）。',
          },
          selector: {
            type: 'string',
            description:
              '种子 CSS 选择器（与 elementId/xpath 三选一）。自动搜索开放 Shadow DOM；省略 frameId 时跨 frame 查找，唯一匹配自动定位。示例：".plugin_goodsCardWrapper"。',
          },
          xpath: {
            type: 'string',
            description:
              '种子 XPath 1.0（与 elementId/selector 三选一，仅 CSS 无法表达时使用）。必须选中元素节点；绝对路径只在主文档有效。示例："(//div[contains(@class,\\"item\\")])[2]"。',
          },
          matchIndex: {
            type: 'integer',
            minimum: 1,
            description:
              'selector/xpath 多匹配时取第几个（1 起，默认 1）。多匹配且未指定时返回候选列表，按返回的 index 回填即可。',
          },
          tabId: {
            type: 'integer',
            description:
              '目标标签页 ID（可选；省略=当前活动页）。显式传入会先核对存在性与可注入性，再切换到该标签页执行。',
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
            description:
              '仅续读同一冻结结果时传；可省略种子参数。改变条件/action/种子或页面变化后省略，从 page=1 重采',
          },
          page: {
            type: 'integer',
            minimum: 1,
            description: '从 1 开始，每页最多 40 条；续读传上次返回的 nextPage，nextPage=null 即结束',
          },
        },
        required: ['action'],
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
      // ── 参数严格校验（未知参数拒绝并回显键名，防拼写误用静默失效） ──
      const allowed = [
        'action',
        'elementId',
        'frameId',
        'selector',
        'xpath',
        'matchIndex',
        'tabId',
        'levels',
        'depth',
        'visibleOnly',
        'snapshotId',
        'page',
      ];
      const unknown = Object.keys(input).filter((k) => !allowed.includes(k));
      if (unknown.length > 0)
        return this.createErrorResponse(
          `存在未知参数：${unknown.join('、')}。支持的参数：${allowed.join('/')}`
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

      // ── 种子来源解析（elementId / selector / xpath 三选一） ──
      const providedSeeds = (['elementId', 'selector', 'xpath'] as const).filter(
        (key) => input[key] !== undefined && input[key] !== null
      );
      if (providedSeeds.length > 1)
        return this.createErrorResponse(
          `INVALID_ARGUMENT：elementId / selector / xpath 三选一，不要同时提供（收到 ${providedSeeds.join('、')}）。已有引用用 elementId，已知类名用 selector，CSS 无法表达时才用 xpath。`
        );

      const hasSnapshot = typeof input.snapshotId === 'string' && input.snapshotId.trim() !== '';
      if (providedSeeds.length === 0 && !hasSnapshot)
        return this.createErrorResponse(
          '缺少种子：三选一 —— ① elementId + frameId（browser_observe 返回的引用，最精准）；② selector（CSS 选择器，推荐）；③ xpath（CSS 无法表达时）。' +
            '尚无任何引用时直接用 selector，不必先 observe。'
        );

      let seedKind: SeedKind | undefined;
      let seedValue = '';
      let matchIndex = 1;
      if (providedSeeds.length === 1) {
        seedKind = providedSeeds[0] === 'elementId' ? 'element' : providedSeeds[0];
        const raw = input[providedSeeds[0] as 'elementId' | 'selector' | 'xpath'];
        if (typeof raw !== 'string' || !raw.trim())
          return this.createErrorResponse(
            `${providedSeeds[0]} 必须是非空字符串，实际收到 ${JSON.stringify(raw ?? null)}`
          );
        seedValue = raw.trim();
        if (seedValue.length > MAX_SEED_CHARS)
          return this.createErrorResponse(
            `${providedSeeds[0]} 过长（${seedValue.length} 字符，上限 ${MAX_SEED_CHARS}）——请改用更精简的选择器，或先用 observe 缩小范围。`
          );

        if (seedKind === 'element') {
          if (PLACEHOLDER_SEED.test(seedValue))
            return this.createErrorResponse(
              `PLACEHOLDER_ELEMENT_ID：收到占位值 "${seedValue}"，当前并没有可用的元素引用。` +
                '请改用 selector（推荐，例如 ".item-card"）或 xpath 指定种子；已经观察过页面时，请原样复制结果中的 ElementId（anx: 开头）与同一行 FrameId。'
            );
          if (seedValue.startsWith('ax:'))
            return this.createErrorResponse(
              'INVALID_ELEMENT_ID：AX 引用（ax: 开头）不支持 DOM 探索。请用 browser_observe 的 DOM 视图重新枚举，或直接用 selector/xpath。'
            );
          if (!/^anx:\d+:[a-f0-9-]+:\d+$/.test(seedValue))
            return this.createErrorResponse(
              `INVALID_ELEMENT_ID：ElementId 形如 anx:<tabId>:<nonce>:<序号>（从 browser_observe / browser_dom_explore 结果原样复制），实际收到 ${JSON.stringify(seedValue.slice(0, 80))}。` +
                '若暂时没有引用，请改用 selector（CSS）或 xpath 作为种子，不要传行号/类名/占位值。'
            );
          if (input.matchIndex !== undefined)
            return this.createErrorResponse('matchIndex 仅用于 selector/xpath（elementId 已是唯一元素）。');
          if (!Number.isSafeInteger(input.frameId) || (input.frameId as number) < 0)
            return this.createErrorResponse(
              'INVALID_ARGUMENT：elementId 必须同时提供同一行的非负整数 frameId（包括 0 也要显式提供）。'
            );
        } else {
          if (input.frameId !== undefined && (!Number.isSafeInteger(input.frameId) || (input.frameId as number) < 0))
            return this.createErrorResponse(
              `INVALID_ARGUMENT：frameId 必须是非负整数（0 也合法）；不确定在哪个 frame 时请省略，工具会跨全部 frame 查找。`
            );
          if (input.matchIndex !== undefined && (!Number.isSafeInteger(input.matchIndex) || input.matchIndex < 1))
            return this.createErrorResponse('matchIndex 必须是 ≥1 的整数（第几个匹配，默认 1）。');
          if (input.matchIndex !== undefined) matchIndex = input.matchIndex;
        }
      }

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
      if (input.visibleOnly !== undefined && typeof input.visibleOnly !== 'boolean')
        return this.createErrorResponse('visibleOnly 必须是布尔值');
      if (
        input.snapshotId !== undefined &&
        (typeof input.snapshotId !== 'string' || input.snapshotId.trim() === '')
      )
        return this.createErrorResponse(
          'snapshotId 必须是非空字符串（省略表示新查询；续读时传上次返回的 snapshotId）。'
        );
      if (input.page !== undefined && (!Number.isSafeInteger(input.page) || input.page < 1))
        return this.createErrorResponse('page 必须是从 1 开始的整数');

      // ── 目标标签页解析（显式 tabId 会先校验再切换；省略=当前活动页） ──
      // 续读不主动切换标签页：快照属于其它标签页时在下方以 STALE_SNAPSHOT
      // 给出 `tabId=<快照标签页>` 的明确引导。
      const target = await resolveTabTarget({
        tabId: input.tabId,
        tool: 'browser_dom_explore',
      });
      if (!target.ok) return this.createErrorResponse(target.error);
      const { tabId, url } = target;

      // ── 分页参数 + 快照预解析（必须先于种子查找：续读允许省略种子） ──
      const page = input.page ?? 1;
      let visibleOnly = input.visibleOnly !== false;
      let requestedDepth = input.depth ?? 1;

      // TTL 清理
      for (const [id, entry] of this.snapshots) {
        if (Date.now() - entry.timestamp >= SNAPSHOT_TTL_MS)
          this.snapshots.delete(id);
      }

      const requestedSnapshotId =
        typeof input.snapshotId === 'string' ? input.snapshotId.trim() : '';
      let snapshot: ExploreSnapshot | undefined;
      if (requestedSnapshotId) {
        const stored = this.snapshots.get(requestedSnapshotId);
        if (!stored)
          return this.createErrorResponse(
            'STALE_SNAPSHOT：快照不存在或已过期（存活 120 秒）。省略 snapshotId，从 page=1 重新采集。'
          );
        if (stored.tabId !== tabId || stored.url !== url)
          return this.createErrorResponse(
            `STALE_SNAPSHOT：该快照属于标签页 ${stored.tabId}（${stored.url || '未知网址'}），` +
              `当前目标是标签页 ${tabId}（${url || '未知网址'}）。需要续读请显式传 tabId=${stored.tabId}；` +
              '否则省略 snapshotId 从 page=1 重采。'
          );
        if (stored.action !== action)
          return this.createErrorResponse(
            `QUERY_MISMATCH：快照绑定 action=${stored.action}，本次为 ${action}。改变 action 时省略 snapshotId，从 page=1 重采。`
          );
        if (input.visibleOnly === undefined) {
          // 续读省略过滤条件 = 继承快照（与 observe 的续读语义一致）；
          // 显式改变才视为新查询，避免模型每次续读都要重复全部条件
          visibleOnly = stored.visibleOnly;
        } else if (input.visibleOnly !== stored.visibleOnly) {
          return this.createErrorResponse(
            'QUERY_MISMATCH：快照绑定原 visibleOnly。改变过滤条件时省略 snapshotId，从 page=1 重采。'
          );
        }
        if (input.depth === undefined) {
          requestedDepth = stored.depth;
        } else if (input.depth !== stored.depth) {
          return this.createErrorResponse(
            'QUERY_MISMATCH：快照绑定原 depth。改变展开深度时省略 snapshotId，从 page=1 重采。'
          );
        }
        snapshot = stored;
      }

      // ── 种子定位：续读继承快照种子；新查询才跨 frame 查找/处理多匹配 ──
      let frameId: number | undefined = input.frameId;
      let frameDiagnostics: FrameReadReport | undefined = snapshot?.frameDiagnostics;
      let candidatesNote: string | undefined;
      let resolvedSeedElementId: string | undefined;
      let lookupMatchCount: number | undefined;
      if (snapshot) {
        if (seedKind) {
          if (seedKind !== snapshot.seedKind || seedValue !== snapshot.seedValue)
            return this.createErrorResponse(
              'QUERY_MISMATCH：快照绑定原种子。续读请省略种子参数（自动继承），或省略 snapshotId 从 page=1 重采。'
            );
          if (input.frameId !== undefined && input.frameId !== snapshot.frameId)
            return this.createErrorResponse(
              'QUERY_MISMATCH：快照绑定原 frameId。改变 frame 时省略 snapshotId，从 page=1 重采。'
            );
          if (
            input.matchIndex !== undefined &&
            input.matchIndex !== (input.frameId !== undefined ? snapshot.matchIndex : snapshot.queryMatchIndex ?? snapshot.matchIndex)
          )
            return this.createErrorResponse(
              'QUERY_MISMATCH：快照绑定原 matchIndex。改变匹配序号时省略 snapshotId，从 page=1 重采。'
            );
        } else {
          // 继承种子形态，保证响应回显与后续 nextActions 依然完整
          seedKind = snapshot.seedKind;
          seedValue = snapshot.seedValue;
        }
        frameId = snapshot.frameId;
        matchIndex = snapshot.matchIndex;
        candidatesNote = snapshot.selectionNote;
      } else if (seedKind && seedKind !== 'element' && frameId === undefined) {
        const looked = await this.lookupSeedAcrossFrames(tabId, seedKind, seedValue);
        if (!looked.ok) return { ...this.createErrorResponse(looked.error), data: { frameDiagnostics: looked.frameDiagnostics } };
        frameDiagnostics = looked.frameDiagnostics;
        lookupMatchCount = looked.total;
        if (looked.total === 0) {
          return { ...this.createErrorResponse(
            `${looked.frameDiagnostics.status === 'complete' ? 'SEED_NOT_FOUND' : 'INCOMPLETE_SCAN'}：${seedKind} "${seedValue.slice(0, 120)}" 在已读取 frame 中未匹配到元素。` +
              (looked.syntaxError ? `\n${looked.syntaxError}` : '') +
              (looked.shadowHit
                ? '\n注意：匹配只可能位于未开放 Shadow DOM（closed shadow root 无法访问）。'
                : '') +
              '\n排查：① 类名可能是构建哈希（换版本即变），改用稳定属性/结构选择器；② 目标可能尚未渲染（先滚动/等待）；③ 目标可能在跨域 iframe（本工具无法注入）；④ 用 browser_observe 枚举可见控件确认页面形态。'
          ), data: { frameDiagnostics } };
        }
        if (looked.total > 1 && input.matchIndex === undefined) {
          return this.createSuccessResponse(
            {
              action,
              seedKind,
              selector: seedValue,
              totalMatches: looked.total,
              frameDiagnostics,
              frameCount: looked.frameCount,
              candidates: this.renderCandidates(looked.candidates),
              truncated: looked.truncated || looked.total > looked.candidates.length,
              ...(looked.shadowHit
                ? {
                    note:
                      '部分匹配位于 Shadow DOM：本工具与 selector/xpath 已跨开放 shadow root，但写进 js_run 的 querySelectorAll 不会跨 shadow——脚本中需逐 host 读取 shadowRoot 后再查询。',
                  }
                : {}),
              tabId,
              url,
              nextActions: this.candidateActions(action, seedValue, looked.candidates, tabId),
            },
            `匹配到 ${looked.total} 个元素（${looked.frameCount} 个 frame）：请用 matchIndex 指定第几个继续 ${action}，或直接使用候选的 ElementId。`
          );
        }
        if (looked.total === 1) {
          frameId = looked.candidates[0].frameId;
          resolvedSeedElementId = looked.candidates[0].elementId;
          if (input.matchIndex !== undefined && input.matchIndex > 1)
            return this.createErrorResponse(
              `SEED_INDEX_OUT_OF_RANGE：${seedKind} 在全部 frame 中只匹配到 1 个元素，matchIndex=${input.matchIndex} 超出范围（1..1）。`
            );
        } else {
          // 多匹配 + 指定 matchIndex：按全局顺序取目标，并换算为其 frame 内的序号
          const picked = looked.candidates.find(
            (candidate) => candidate.index === input.matchIndex
          );
          if (!picked) {
            // 候选表每帧有上限：命中被截断的区段时必须给出可执行指引，
            // 不能谎报「超出 1..total」让模型反复试错
            if (looked.truncated)
              return this.createErrorResponse(
                `SEED_INDEX_OUT_OF_RANGE：${seedKind} 共匹配 ${looked.total} 个元素，但候选表只展开前 ${looked.candidates.length} 个（单 frame 上限 ${SEED_LOOKUP_LIMIT}）。` +
                  '请改用候选表中的 ElementId 作为种子，或缩小选择器范围（先滚动/翻页后重采）再定位。'
              );
            return this.createErrorResponse(
              `SEED_INDEX_OUT_OF_RANGE：${seedKind} 共匹配 ${looked.total} 个元素，matchIndex=${input.matchIndex} 超出范围（1..${looked.total}）。`
            );
          }
          frameId = picked.frameId;
          resolvedSeedElementId = picked.elementId;
          matchIndex = picked.frameOrdinal;
          candidatesNote = `已按 matchIndex=${input.matchIndex} 选中 frame ${frameId} 内的第 ${picked.frameOrdinal} 个匹配。`;
        }
      }
      if (frameId === undefined)
        return this.createErrorResponse(
          'INVALID_ARGUMENT：无法确定目标 frame（内部状态异常），请重试；或改用 elementId + frameId、selector（省略 frameId 自动跨 frame 查找）。'
        );

      const seedKey = seedKind
        ? seedKeyOf(seedKind, seedValue, matchIndex)
        : undefined;

      // ── parent：单次注入直接返回 ──
      if (action === 'parent') {
        const injected = await this.inject(tabId, frameId, {
          action,
          seedKind: seedKind!,
          seedValue,
          matchIndex,
          levels: input.levels ?? 3,
          depth: 1,
          visibleOnly: false,
          resolvedElementId: resolvedSeedElementId,
          documentId: frameDiagnostics?.documents?.find(f => f.frameId === frameId)?.documentId,
        });
        if (!injected.ok) return this.createErrorResponse(injected.error);
        const result = injected.result!;
        // 交付前二次核验（当页全部引用仍有效）
        const verified = await this.verifyReferences(
          tabId,
          frameId,
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
        const repeatLevel = result.levels!.find((l) => (l.repeatsInParent ?? 0) >= 2);
        const nextActions: NextAction[] = repeatLevel
          ? [
              {
                tool: 'browser_dom_explore',
                args: {
                  action: 'similar',
                  elementId: repeatLevel.elementId,
                  frameId,
                  ...(input.tabId !== undefined ? { tabId } : {}),
                },
                why: `第 ${repeatLevel.depth} 层同构兄弟 ≥2，疑似重复容器——similar 可拿全部同类元素与生成选择器`,
              },
              {
                tool: 'browser_dom_explore',
                args: {
                  action: 'children',
                  elementId: repeatLevel.elementId,
                  frameId,
                  depth: 2,
                  ...(input.tabId !== undefined ? { tabId } : {}),
                },
                why: '展开重复容器的字段布局',
              },
            ]
          : [
              {
                tool: 'browser_dom_explore',
                args: {
                  action: 'siblings',
                  elementId: seedKind === 'element' ? seedValue : result.seedElementId,
                  frameId,
                  ...(input.tabId !== undefined ? { tabId } : {}),
                },
                why: '各级祖先均无同构兄弟——先检查同级元素是否才是列表项',
              },
            ];
        return this.createSuccessResponse(
          {
            action,
            frameDiagnostics,
            seedKind,
            ...(seedKind === 'element' ? { elementId: seedValue } : { selector: seedValue, matchIndex }),
            ...(result.seedMatchCount !== undefined ? { seedMatchCount: result.seedMatchCount } : {}),
            ...(result.seedElementId ? { seedElementId: result.seedElementId } : {}),
            levels: lines.join('\n'),
            frameId,
            tabId,
            url,
            ...(candidatesNote ? { note: candidatesNote } : {}),
            nextActions,
            hint:
              (repeatLevel
                ? `第 ${repeatLevel.depth} 层（${repeatLevel.tag}${repeatLevel.classes ? '.' + repeatLevel.classes.split(' ')[0] : ''}）同构兄弟 ≥2，疑似重复容器。`
                : '各级祖先均无同构兄弟。') +
              '同构兄弟=该层在父下同标签且 class 相近的元素数（含自身）。',
          },
          `Retrieved ${result.levels!.length} ancestor levels (含种子).`
        );
      }

      // ── children / siblings / similar：快照分页 ──
      // 快照与种子校验已在前面完成（续读可省略种子）；这里只负责
      // 「没有快照 → 采集并冻结」或「已有快照 → 直接交付当页」。
      let snapshotId = requestedSnapshotId;
      const snapshotReused = !!snapshot;
      if (!snapshot) {
        if (page !== 1)
          return this.createErrorResponse(
            '翻页必须提供上次返回的 snapshotId；新查询必须从 page=1 开始。'
          );
        const injected = await this.inject(tabId, frameId, {
          action,
          seedKind: seedKind!,
          seedValue,
          matchIndex,
          levels: 3,
          depth: requestedDepth,
          visibleOnly,
          resolvedElementId: resolvedSeedElementId,
          documentId: frameDiagnostics?.documents?.find(f => f.frameId === frameId)?.documentId,
        });
        if (!injected.ok) return this.createErrorResponse(injected.error);
        const result = injected.result!;
        snapshot = {
          frameDiagnostics,
          tabId,
          url,
          action,
          seedKey: seedKey!,
          seedKind: seedKind!,
          seedValue,
          matchIndex,
          queryMatchIndex: input.matchIndex ?? 1,
          ...(candidatesNote ? { selectionNote: candidatesNote } : {}),
          frameId,
          visibleOnly,
          depth: requestedDepth,
          elements: result.elements ?? [],
          ...(result.pattern ? { pattern: result.pattern } : {}),
          ...(result.noPattern ? { noPattern: true } : {}),
          ...(result.truncated ? { truncated: true } : {}),
          ...(result.note ? { note: result.note } : {}),
          ...((lookupMatchCount ?? result.seedMatchCount) !== undefined ? { seedMatchCount: lookupMatchCount ?? result.seedMatchCount } : {}),
          ...(result.seedElementId ? { seedElementId: result.seedElementId } : {}),
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
            url,
            ...(snapshot.seedElementId ? { seedElementId: snapshot.seedElementId } : {}),
            nextActions: [
              {
                tool: 'browser_dom_explore',
                args: {
                  action: 'children',
                  elementId: snapshot.seedElementId,
                  frameId,
                  depth: 2,
                  tabId,
                },
                why: '未发现重复模式时，直接展开种子自身确认字段结构',
              },
              {
                tool: 'browser_observe',
                args: { view: 'structure', tabId },
                why: '改用结构视图确认列表/表格边界',
              },
            ],
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
        snapshot.frameId,
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
        frameDiagnostics: snapshot.frameDiagnostics,
        action,
        elements: totalElements > 0 ? lines.join('\n') : '_No elements found_',
        snapshotId,
        snapshotReused,
        seedKind: snapshot.seedKind,
        ...(snapshot.seedKind === 'element'
          ? { elementId: snapshot.seedValue }
          : { selector: snapshot.seedValue, matchIndex: snapshot.matchIndex }),
        ...(snapshot.seedMatchCount !== undefined ? { seedMatchCount: snapshot.seedMatchCount } : {}),
        ...(snapshot.seedElementId ? { seedElementId: snapshot.seedElementId } : {}),
        frameId: snapshot.frameId,
        tabId,
        url,
        visibleOnly: snapshot.visibleOnly,
        totalElements,
        page,
        pageSize: EXPLORE_PAGE_SIZE,
        totalPages,
        nextPage: page < totalPages ? page + 1 : null,
        ...(snapshot.truncated ? { truncated: true } : {}),
        ...(snapshot.note ? { note: snapshot.note } : {}),
        ...(candidatesNote ? { selectionNote: candidatesNote } : {}),
      };

      const nextActions: NextAction[] = [];
      if (page < totalPages) {
        nextActions.push({
          tool: 'browser_dom_explore',
          args: { action, snapshotId, page: page + 1, tabId },
          why: '还有下一页（续读可省略种子参数）',
        });
      }

      if (action === 'similar') {
        payload.pattern = snapshot.pattern;
        const selector = snapshot.pattern?.combinedSelector;
        payload.hint =
          (selector
            ? `批量抓取：js_run 里 document.querySelectorAll('${selector}')（实测匹配 ${snapshot.pattern?.selectorMatchCount ?? '?'} 个；注意 js_run 的选择器不跨 Shadow DOM）。`
            : '') +
          (snapshot.pattern?.mode === 'descendant' && snapshot.pattern?.containerElementId
            ? `字段布局：对容器执行 children。`
            : '') +
          `单元素深查用 browser_observe(view="element")；操作元素用 browser_interact。`;
        if (snapshot.pattern?.mode === 'descendant' && snapshot.pattern?.containerElementId) {
          nextActions.push({
            tool: 'browser_dom_explore',
            args: {
              action: 'children',
              elementId: snapshot.pattern.containerElementId,
              frameId: snapshot.frameId,
              depth: 2,
              tabId,
            },
            why: '展开重复容器内部字段',
          });
        }
        if (snapshot.seedElementId)
          nextActions.push({
            tool: 'browser_observe',
            args: { view: 'element', elementId: snapshot.seedElementId, frameId: snapshot.frameId, tabId },
            why: '查看种子元素完整属性/XPath/状态',
          });
      } else if (action === 'children') {
        payload.hint = `字段提取：对代表性子元素 browser_observe(view="element") 查属性/XPath；批量抽取用 js_run 以容器选择器遍历。`;
        if (snapshot.seedElementId)
          nextActions.push({
            tool: 'browser_dom_explore',
            args: {
              action: 'similar',
              elementId: snapshot.seedElementId,
              frameId: snapshot.frameId,
              tabId,
            },
            why: '若该子结构在页面重复，similar 可直接给出批量选择器',
          });
      } else {
        payload.hint = `同级对比后：相似元素用 similar（附生成选择器）；子结构用 children。`;
        if (snapshot.seedElementId)
          nextActions.push({
            tool: 'browser_dom_explore',
            args: {
              action: 'similar',
              elementId: snapshot.seedElementId,
              frameId: snapshot.frameId,
              tabId,
            },
            why: '把同级元素扩展为全页相似元素组',
          });
      }
      payload.nextActions = nextActions;

      // 显式指定 frameId 时不会先跨 frame 返回候选表：若该 frame 内仍有多匹配，
      // 必须说明本次按 matchIndex=1 探索，避免模型把它当成唯一匹配
      if (
        !snapshotReused &&
        snapshot.seedKind !== 'element' &&
        input.matchIndex === undefined &&
        (snapshot.seedMatchCount ?? 0) > 1
      ) {
        payload.note = [
          snapshot.note,
          `该 ${snapshot.seedKind} 在 frame ${snapshot.frameId} 内匹配 ${snapshot.seedMatchCount} 个，本次按 matchIndex=1 探索；其它匹配请改传 matchIndex（1..${snapshot.seedMatchCount}）。`,
        ]
          .filter(Boolean)
          .join(' ');
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
      return { ...this.createErrorResponse(
        `DOM 探索失败：${error instanceof Error ? error.message : String(error)}。等待页面稳定后重试；若引用已过期，省略 snapshotId 从 page=1 重采。`,
        error
      ), ...(error instanceof PageReadError ? { data: { frameDiagnostics: error.frameDiagnostics } } : {}) };
    }
  }

  /**
   * 跨 frame 的种子查找：每个可注入 frame 注入一次查找荷载，聚合匹配。
   *
   * 候选编号是**全局顺序**（frameId 升序 → frame 内 DOM 顺序），并附带
   * frameOrdinal（该 frame 内序号）——后续探索注入只作用于单个 frame，
   * 必须用 frame 内序号，否则 matchIndex 会错位。
   */
  private async lookupSeedAcrossFrames(
    tabId: number,
    kind: 'selector' | 'xpath',
    value: string
  ): Promise<
    | {
        ok: true;
        total: number;
        frameCount: number;
        truncated: boolean;
        shadowHit: boolean;
        candidates: Array<ExploreSeedCandidate & { frameId: number; frameOrdinal: number }>;
        syntaxError?: string;
        frameDiagnostics: FrameReadReport;
      }
    | { ok: false; error: string; frameDiagnostics?: FrameReadReport }
  > {
    let results: FrameResults<ReturnType<typeof exploreSeedLookupPayload>>;
    try {
      results = await readPageFrames({
        target: { tabId, allFrames: true },
        world: 'ISOLATED',
        func: exploreSeedLookupPayload,
        args: [kind, value, SEED_LOOKUP_LIMIT, tabId],
      }, { operation: 'dom-explore-seed-lookup' });
    } catch (error) {
      return {
        ok: false,
        ...(error instanceof PageReadError ? { frameDiagnostics: error.frameDiagnostics } : {}),
        error: `INJECTION_FAILED：无法在页面中查找种子（标签页可能已关闭或被浏览器保护）：${
          error instanceof Error ? error.message : String(error)
        }。请用 browser_tabs 确认标签页状态后重试。`,
      };
    }

    const frames = results
      .filter((entry) => {
        const result = entry.result;
        if (result && typeof result === 'object' && !Array.isArray(result) &&
          (typeof result.error === 'string' ||
            (Array.isArray(result.matches) && Number.isSafeInteger(result.total) && result.total! >= result.matches.length &&
              result.matches.every(match => match && typeof match.elementId === 'string' && typeof match.tag === 'string' &&
                (match.classes === undefined || typeof match.classes === 'string') &&
                (match.text === undefined || typeof match.text === 'string'))))) return true;
        addFrameIssue(results.frameDiagnostics, { frameId: entry.frameId, documentId: entry.documentId, stage: 'read', code: 'INVALID_RESULT', message: 'Seed lookup returned malformed candidates' });
        return false;
      })
      .map((entry) => ({
        frameId: entry.frameId ?? 0,
        result: entry.result as ReturnType<typeof exploreSeedLookupPayload>,
      }))
      .sort((a, b) => a.frameId - b.frameId);
    if (frames.length === 0) {
      return {
        ok: false,
        frameDiagnostics: results.frameDiagnostics,
        error:
          'INCOMPLETE_SCAN：所有 frame 都没有返回查找结果（页面可能正在导航或注入被拒绝）。等待页面稳定后用 browser_observe 确认可读性。',
      };
    }
    const failed = frames.filter((frame) => frame.result.error);
    for (const frame of failed) {
      addFrameIssue(results.frameDiagnostics, { frameId: frame.frameId, stage: 'read', code: 'PAYLOAD_ERROR', message: frame.result.error! });
    }
    if (failed.length === frames.length) {
      return { ok: false, error: failed[0].result.error!, frameDiagnostics: results.frameDiagnostics };
    }

    const candidates: Array<ExploreSeedCandidate & { frameId: number; frameOrdinal: number }> = [];
    let total = 0;
    let truncated = false;
    let shadowHit = false;
    for (const frame of frames) {
      const result = frame.result;
      if (result.error) continue;
      total += result.total ?? 0;
      truncated = truncated || !!result.truncated;
      shadowHit = shadowHit || !!result.shadowHit;
      (result.matches ?? []).forEach((match, index) => {
        candidates.push({
          ...match,
          index: candidates.length + 1,
          frameId: frame.frameId,
          frameOrdinal: index + 1,
        });
      });
    }
    const syntaxError = failed.find((frame) => frame.frameId === 0)?.result.error;
    return {
      ok: true,
      frameDiagnostics: results.frameDiagnostics,
      total,
      frameCount: frames.filter((frame) => (frame.result.total ?? 0) > 0).length,
      truncated: truncated || total > candidates.length,
      shadowHit,
      candidates,
      ...(total === 0 && syntaxError ? { syntaxError } : {}),
    };
  }

  /** 候选表格（含 frameId 与可选序号，便于直接回填） */
  private renderCandidates(
    candidates: Array<ExploreSeedCandidate & { frameId: number; frameOrdinal: number }>
  ): string {
    const lines = [
      '| # | FrameId | matchIndex | Tag | Classes | Text | ElementId | 可见 |',
      '|---|---|---|---|---|---|---|---|',
    ];
    for (const candidate of candidates) {
      lines.push(
        `| ${candidate.index} | ${candidate.frameId} | ${candidate.frameOrdinal} | ${candidate.tag} | ${escapeCell(
          candidate.classes || '-'
        )} | ${escapeCell(candidate.text || '-')} | ${candidate.elementId} | ${
          candidate.visible ? '✓' : '-'
        } |`
      );
    }
    return lines.join('\n');
  }

  /** 多匹配候选的下一步：直接给出前 3 个可复制的 similar 调用 */
  private candidateActions(
    action: ExploreAction,
    selector: string,
    candidates: Array<ExploreSeedCandidate & { frameId: number; frameOrdinal: number }>,
    tabId: number
  ): NextAction[] {
    return candidates.slice(0, 3).map((candidate) => ({
      tool: 'browser_dom_explore',
      args: {
        action,
        selector,
        frameId: candidate.frameId,
        matchIndex: candidate.frameOrdinal,
        tabId,
      },
      why: `第 ${candidate.index} 个匹配（frame ${candidate.frameId} 内第 ${candidate.frameOrdinal} 个），${candidate.tag}${
        candidate.classes ? '.' + candidate.classes.split(' ')[0] : ''
      }`,
    }));
  }

  /** 注入荷载到目标 frame */
  private async inject(
    tabId: number,
    frameId: number,
    params: {
      action: ExploreAction;
      seedKind: SeedKind;
      seedValue: string;
      matchIndex: number;
      levels: number;
      depth: number;
      visibleOnly: boolean;
      resolvedElementId?: string;
      documentId?: string;
    }
  ): Promise<
    | { ok: false; error: string }
    | { ok: true; result: ExplorePayloadResult & { fingerprint: string } }
  > {
    let results: chrome.scripting.InjectionResult<unknown>[];
    try {
      results = await readPageFrames({
        target: { tabId, ...(params.documentId ? { documentIds: [params.documentId] } : { frameIds: [frameId] }) },
        world: 'ISOLATED',
        func: elementExplorePayload,
        args: [
          params.action,
          params.resolvedElementId ? 'element' : params.seedKind,
          params.resolvedElementId ?? params.seedValue,
          params.resolvedElementId ? 1 : params.matchIndex,
          params.levels,
          params.depth,
          params.visibleOnly,
          tabId,
        ],
      });
    } catch (error) {
      return {
        ok: false,
        error: `INJECTION_FAILED：frame ${frameId} 注入失败（标签页可能已关闭/导航，或该 frame 受限）：${
          error instanceof Error ? error.message : String(error)
        }。请重新观察页面后重试。`,
      };
    }
    const result = results?.[0]?.result as ExplorePayloadResult | undefined;
    if (!result)
      return {
        ok: false,
        error:
          'INCOMPLETE_SCAN：目标 frame 未返回结果（frame 可能已随导航消失，或荷载执行异常）——请 browser_observe 重新枚举，或省略 frameId 让 selector/xpath 跨 frame 查找。',
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
      const checked = await readPageFrames({
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
