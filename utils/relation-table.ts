/**
 * 关系表解析内核（纯函数）——「任意 JSON 值 → 可导出的行表」的单一事实源
 *
 * ==================== 为什么独立成模块 ====================
 *
 * 数据通道上有四个消费方都要回答同一个问题：
 *   - xlsx_tool(create_from_data)：dataFiles 里的文件是什么表？
 *   - data_ref_tool(merge / dedupe)：files 里的文件是什么表？
 *   - data_ref_tool(info)：这个数据源的表结构是什么？
 *   - data_ref_tool(project)：复合结构里表在哪个路径？
 *
 * 四处各写一份判定规则必然漂移（同一个文件在导出时能过、在合并时报错）。
 * 本模块把「信封 → 表」的解析收敛为唯一实现，全部动作共用同一套语义与
 * 同一份错误文案——描述与实现因此天然一致。
 *
 * ==================== 解析规则（确定性，不猜） ====================
 *
 * 1. **顶层是数组** → 它就是表本身（records 对象数组 / matrix 二维数组）。
 * 2. **顶层是对象** → 视为信封：按**声明式载荷路径契约**定位它的行表。
 *
 *    信封是行业标准形态（JSON:API 规定根必须是对象、载荷在具名成员 `data`；
 *    GraphQL 同样用 `data`/`errors` 成员；pandas 的 json_normalize 以
 *    `record_path` 指定载荷路径、并用 `meta` 把同级元数据提升为列）。
 *    因此「拒绝一切信封」会否掉最合规的载荷形态；正确做法是**公布契约**：
 *    声明哪些成员名承载行表，再据此归一。
 *
 *    契约成员名（大小写不敏感，精确匹配）：
 *      rows / items / data / records / list / results / content
 *
 *   解析顺序（**单一排序**，不分支）：
 *     ① 元素形态档：对象数组(1) > 二维数组(2) > 标量/空数组(3)
 *        ——「像表」比「像元数据」优先；
 *     ② 载荷路径契约命中：契约成员名(rows/items/data/…) 优先于同档的其它名字
 *        ——名字本身就是作者的声明；
 *     ③ 层级深度：越浅越可能是主表（顶层成员优先于嵌套成员）。
 *
 *    取排序最高的一组；若该组仍有多个 → **歧义，不猜**：回显全部候选路径，
 *    由调用方显式指定。
 *
 *    关键性质：
 *   - **绝不静默猜表**：歧义时给出候选清单与显式指定方式，避免把
 *     「related」「recent」之类的旁支数组误当成主表导出。
 *   - **契约是平局裁决器，不是唯一判据**：{rows:[…], meta:{items:[…]}} 判为
 *     rows（浅层优先）；{content:[1,2], items:[{…}]} 判为 items（形态优先）；
 *     两者都判据明确，不产生伪歧义。
 *   - **同层同档同契约状态仍多候选 → 真歧义**：{rows:[…], items:[…]} 必须
 *     由调用方指定——两个都是作者声明过的载荷名，工具无权替作者选。
 *   - **深度只在形态相同时比较**：{data:{items:[…]}} 只有一个候选，直接命中。
 *
 * ==================== 元数据提升（meta） ====================
 *
 * 信封里与载荷并列的标量成员（如 totalOnPage / returned / page）不是噪音，
 * 而是**对账口径**——把实抓行数与它们比较才能发现漏抓。解析结果因此把它们
 * 原样带出（envelopeMeta），供下游回显与核对。
 *
 * ==================== 与 project 的关系 ====================
 *
 * 解析结果以「段列表」（segments）给出而非仅字符串路径：段列表可绕开点号
 * 转义（键名含 '.' 时字符串路径无法寻址），并与 data-ref-rows.ts 的
 * projectRows 内部寻址口径一致（其 path 语义 = 相对源行的点分路径；
 * 源为对象时即相对该对象）。
 */

import { analyzeValue, isPlainObject, type DataShape } from './data-ref-rows';

/** 信封内部的最大下探深度（段数上限；防畸形深层结构拖垮解析） */
export const RELATION_ENVELOPE_MAX_DEPTH = 4;

/**
 * 载荷路径契约成员名（小写比较）。
 *
 * 这些是行业既有的行表成员命名（JSON:API 的 `data`、GraphQL 的 `data`、
 * pandas json_normalize 常用的 `records`/`values`，以及业界普遍的
 * `rows`/`items`/`list`/`results`）。契约成员名的存在本身就是作者的**声明**，
 * 因此优先于任何结构启发式——这是「公布契约再归一」，不是猜。
 */
export const RELATION_PAYLOAD_MEMBER_NAMES: readonly string[] = [
  'rows',
  'items',
  'data',
  'records',
  'list',
  'results',
  'content',
];

/** 候选的形态档：1=对象数组 2=二维数组 3=标量数组/空数组 */
export type RelationCandidateTier = 1 | 2 | 3;

/** 一个数组候选（信封内部的一个数组字段） */
export interface RelationCandidate {
  /** 点分路径（展示用；键名含 '.' 时仅作提示，需按 segments 寻址） */
  path: string;
  /** 路径段列表（可精确寻址，绕开点号转义） */
  segments: string[];
  /** 候选数组长度 */
  rows: number;
  /** 形态档：1=对象数组 2=二维数组 3=其余 */
  tier: RelationCandidateTier;
  /** 深度（顶层数组字段为 1） */
  depth: number;
  /** 是否命中载荷路径契约成员名（作者已声明该成员承载行表） */
  contracted: boolean;
}

/** 表在源值中的位置 */
export type RelationLocation =
  /** 源值本身就是表（顶层数组） */
  | { kind: 'direct' }
  /** 表位于信封内的某条路径 */
  | { kind: 'envelope'; segments: string[]; path: string };

/**
 * 表的定位方式（决定回执如何措辞，也让模型知道结论有多可靠）：
 *   - direct    = 源值本身就是表；
 *   - contract  = 命中载荷路径契约成员名（作者已声明，最可靠）；
 *   - heuristic = 未命中契约名，靠元素形态/深度唯一判定（可靠但需核对）。
 */
export type RelationMatchKind = 'direct' | 'contract' | 'heuristic';

/** 解析成功的结果 */
export interface RelationTable {
  /** 行数据（直接表即原数组；信封表即该数组） */
  rows: unknown[];
  /** 表的位置 */
  location: RelationLocation;
  /** 全部候选（仅信封场景非空；歧义时用于回显） */
  candidates: RelationCandidate[];
  /** 信封顶层除表之外的其余键名（按出现顺序；直接表场景为空） */
  envelopeKeys: string[];
  /**
   * 信封顶层的标量元数据（键 → 原始值）。
   *
   * 这是**对账基数的载体**：脚本常把「页面宣称总数 / DOM 匹配数 / 当前页码」
   * 等与行数组并列放在信封里（如 {page, totalOnPage, returned, rows}）。
   * 把它们原样带出，模型才有独立的对照口径——否则「实抓行数」只能与自己
   * 比较（自证式对账），无法发现漏抓。
   */
  envelopeMeta: Record<string, unknown>;
  /**
   * 表的定位方式——决定结论的可靠性，也让回执能如实告诉模型「这是靠声明
   * 定的还是靠结构推的」：
   *   - contract  = 命中载荷路径契约成员名（作者已声明，最可靠）
   *   - heuristic = 未命中契约名，靠元素形态/深度唯一判定（可靠但需核对）
   */
  matchKind: RelationMatchKind;
}

/** 解析结果：成功给出表，或说明为何识别不出表 */
export type RelationResolution =
  | ({ ok: true } & RelationTable)
  | { ok: false; reason: string; candidates: RelationCandidate[] };

/** 候选分档：元素全为对象=1；元素全为数组=2；其余=3（含空数组与标量数组） */
function candidateTier(value: readonly unknown[]): RelationCandidateTier {
  if (value.length === 0) return 3;
  if (value.every(isPlainObject)) return 1;
  if (value.every(Array.isArray)) return 2;
  return 3;
}

/** 收集对象内部（含嵌套对象）的全部数组字段 */
function collectCandidates(
  value: Record<string, unknown>,
  prefix: string[],
  depth: number,
  out: RelationCandidate[],
): void {
  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child)) {
      const segments = [...prefix, key];
      out.push({
        path: segments.join('.'),
        segments,
        rows: child.length,
        tier: candidateTier(child),
        depth,
        contracted: RELATION_PAYLOAD_MEMBER_NAMES.includes(key.toLowerCase()),
      });
      continue;
    }
    if (isPlainObject(child) && depth < RELATION_ENVELOPE_MAX_DEPTH) {
      collectCandidates(child, [...prefix, key], depth + 1, out);
    }
  }
}

/** 按段列表在对象内取值（不经点号字符串，键名含 '.' 也能寻址） */
export function resolveBySegments(
  root: unknown,
  segments: readonly string[],
): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (!isPlainObject(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * 解析任意 JSON 值为关系表（纯函数，无 I/O）。
 *
 * @param value 源值（脚本返回值 / 数据文件解析结果）
 * @returns 解析成功时给出行数据与表的位置；源值不含可识别表时返回 ok:false
 */
export function resolveRelationTable(value: unknown): RelationResolution {
  if (Array.isArray(value)) {
    return {
      ok: true,
      rows: value,
      location: { kind: 'direct' },
      candidates: [],
      envelopeKeys: [],
      envelopeMeta: {},
      matchKind: 'direct',
    };
  }
  if (!isPlainObject(value)) {
    return {
      ok: false,
      reason: `源值不是对象或数组（形态：${analyzeValue(value).kind}）`,
      candidates: [],
    };
  }

  const candidates: RelationCandidate[] = [];
  collectCandidates(value, [], 1, candidates);
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: '该对象内部没有任何数组字段，无法识别出关系表',
      candidates: [],
    };
  }

  // ── 单一排序：形态档 → 契约命中 → 层级深度 ──
  // 三个维度合成一个可比较的序数（越小越优先），再取最优组；
  // 最优组仍有多个 → 歧义，交由调用方显式指定。
  const rank = (item: RelationCandidate): number[] => [
    item.tier,
    item.contracted ? 0 : 1,
    item.depth,
  ];
  const compareRank = (a: number[], b: number[]): number => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  };
  // 取排序最高的一组（并列即全部保留，交由歧义分支处理）
  let bestRank = rank(candidates[0]);
  let bestItems: RelationCandidate[] = [];
  for (const item of candidates) {
    const itemRank = rank(item);
    const cmp = compareRank(itemRank, bestRank);
    if (cmp < 0) {
      bestRank = itemRank;
      bestItems = [item];
    } else if (cmp === 0) {
      bestItems.push(item);
    }
  }
  const best = bestItems;

  if (best.length > 1) {
    // 歧义：不猜——回显候选，由调用方显式指定路径
    const shapes = [
      ...new Set(best.map((item) => item.tier)),
    ].map((tier) => (tier === 1 ? '对象数组' : tier === 2 ? '二维数组' : '标量/空数组'));
    const contracted = best.every((item) => item.contracted);
    return {
      ok: false,
      reason:
        `信封内有 ${best.length} 个同等优先级的候选数组（${shapes.join('、')}` +
        (contracted ? '，且都是载荷路径契约成员名' : '') +
        `）：` +
        best.map((item) => `${item.path}（${item.rows} 行）`).join('、') +
        '——无法确定哪张是行表，请显式指定 path。',
      candidates,
    };
  }

  const chosen = best[0];
  const rows = resolveBySegments(value, chosen.segments);
  if (!Array.isArray(rows)) {
    return {
      ok: false,
      reason: `候选路径 "${chosen.path}" 未能解析为数组`,
      candidates,
    };
  }

  return {
    ok: true,
    rows,
    location: { kind: 'envelope', segments: chosen.segments, path: chosen.path },
    candidates,
    envelopeKeys: Object.keys(value),
    envelopeMeta: collectEnvelopeMeta(value),
    matchKind: chosen.contracted ? 'contract' : 'heuristic',
  };
}

/**
 * 信封的标量元数据：与行数组并列的对照口径（页面总数/匹配数/页码等）。
 *
 * 只取顶层标量（嵌套对象由 project carry 按需提升为列，不在此处展开）。
 */
function collectEnvelopeMeta(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === null || typeof child !== "object") meta[key] = child;
  }
  return meta;
}

/**
 * 解析失败（歧义/无表）时的可执行处置文案——数据通道各工具共用。
 *
 * 文案遵循「错误即教学」：点明**实际拿到的形态**、**为什么不能用**、
 * **下一步的确切调用**（含可直接复制的参数），而不是只说「格式不对」。
 *
 * @param resolution 解析结果（ok:false 分支）
 * @param sourceLabel 数据来源描述（文件路径等），用于回显
 */
export function describeRelationFailure(
  resolution: Extract<RelationResolution, { ok: false }>,
  sourceLabel: string,
): string {
  const candidates = resolution.candidates;
  const candidateText = candidates.length
    ? `候选表路径：${candidates.map((item) => `${item.path}（${item.rows} 行）`).join('、')}。`
    : '';
  // 歧义时给出**逐个候选的确切调用**——模型不必自己拼 path
  const perCandidate = candidates
    .map(
      (item) =>
        `  · data_ref_tool(action="project", file="${sourceLabel}", path="${item.path}") → 导出 dataFiles=[投影结果文件]`,
    )
    .join('\n');
  const remedy = perCandidate
    ? `处理方式（对每个候选表各投影一次，再用 data_ref_tool(action="merge", files=[...]) 合并）：\n${perCandidate}`
    : '处理方式：① 用 data_ref_tool(action="info", file="' +
      sourceLabel +
      '") 查看该文件的实际结构与可用字段；② 若表在某个字段里，用 data_ref_tool(action="project", file="' +
      sourceLabel +
      '", path="<字段路径>") 投影为关系表后再导出；③ 若脚本本就该返回行数组，改脚本直接 return 对象数组（结果文件即可直接交给 create_from_data 的 dataFiles）。';
  return `${sourceLabel} 不是可直接导出的表：${resolution.reason}。${candidateText}${remedy}`;
}

/**
 * 解析成功后的回显片段（说明「用的是哪个路径的表」）——供各工具拼接进
 * 自己的响应文案，让模型一眼看到解析结论而不必再猜。
 *
 * 同时回显**信封的标量元数据**：这是模型做「实抓 vs 宣称总数」对账时
 * 唯一可用的独立口径——不回显就等于把对账依据藏进了文件里。
 */
export function describeRelationChoice(table: RelationTable): string {
  if (table.location.kind === "direct") return "";
  // 定位方式如实回显：契约命中是作者声明（可放心用），启发式命中值得核对一眼。
  const basisText =
    table.matchKind === "contract"
      ? "（载荷路径契约成员名，作者已声明）"
      : "（未命中契约成员名，按元素形态与层级唯一判定——请核对这确实是你要的表）";
  // 只说「哪张表、怎么定的」——**不列信封元数据**：调用方会把 envelopeMeta
  // 作为结构化字段单独回传，同一份事实出现两次是纯上下文浪费。
  return `已从信封结构中定位行表：路径 "${table.location.path}"（${table.rows.length} 行）${basisText}`;
}

/**
 * 单个数据源（工作区数据文件 / 暂存批次）的行数据解析结果。
 *
 * 形态与 rowCount 取自**解析后的表**（而非原文件），因此下游的
 * 「按表拼接 / 按表去重 / 按表选列」全部基于同一口径。
 */
export interface ResolvedDataSource {
  /** 表数据行 */
  rows: unknown[];
  /** 表的形态（records / matrix） */
  kind: DataShape;
  /** 解析说明（信封场景非空；直接数组为空串） */
  note: string;
  /** 行数（表长度） */
  rowCount: number;
  /** 信封里的标量元数据（对账口径候选；无则为空对象） */
  envelopeMeta: Record<string, unknown>;
}

/**
 * 完整性对账状态——**始终存在**，不靠「字段缺失」暗示。
 *
 * 为什么要显式建模：成熟工具链在「没有可比基准」时的默认行为是**静默地
 * 不做这项检查**（检查缺席读起来像「没问题」）。而对批量采集来说，
 * 「没核对」与「核对过且一致」必须能被区分，否则一次漏抓会以「成功」告终。
 *
 * 基准来源（按可信度）：
 *   - envelope：信封里作者自报的总量字段（totalOnPage / total / count 等）
 *   - domCount：抓取前用同一选择器单独数出的 DOM 匹配数
 *   - none：无可用基准——此时完整性**未被验证**，必须如实声明
 */
export type CompletenessBaseline =
  /** 信封里作者自报的总量（键名 + 数值） */
  | { kind: 'envelope'; key: string; value: number }
  /** 抓取前独立数出的 DOM 匹配数 */
  | { kind: 'domCount'; value: number }
  /** 无可用基准——完整性未经验证 */
  | { kind: 'none'; reason: string };

/** 对账结论 */
export type CompletenessVerdict =
  /** 实抓行数 == 基准 */
  | 'matched'
  /** 实抓行数 < 基准（可能漏抓） */
  | 'short'
  /** 实抓行数 > 基准（可能重复或基准过时） */
  | 'over'
  /** 无基准，未做核对 */
  | 'unverified';

/**
 * 对账基准字段的**优先级分组**（组内顺序即优先级，从高到低）。
 *
 * 为什么分组而不是「谁出现用谁」：同一个信封里可能同时有
 * `{total: 100, count: 10, page: 2}` —— total 是页面总量（真正的基准），
 * count 是本页条数（**等于实抓行数，拿它对账是自证式对账**），
 * page 是页码（当基准毫无意义）。所以：
 *   - 第 1 组：页面/接口宣称的**总量**（total* / itemcount / resultcount）
 *   - 第 2 组：DOM 匹配数（matched* / matchcount）
 *   - 第 3 组：期望值（expected*）
 *   - 第 4 组：count（最弱——常见于「本页条数」，与实抓行数同源）
 *
 * 组内按**声明顺序**找，避免同一组里多个键（total 与 totalcount）命中
 * 顺序随对象键序漂移。
 */
const ENVELOPE_BASELINE_GROUPS: readonly (readonly string[])[] = [
  [
    'total',
    'totalcount',
    'totalonpage',
    'totalitems',
    'totalresult',
    'itemcount',
    'resultcount',
    'resultstotal',
  ],
  ['matchedcount', 'matchcount', 'matched', 'matchedtotal'],
  ['expectedcount', 'expected'],
  ['count'],
];

/**
 * 从信封标量元数据中取「作者自报的总量」作为对账基准。
 *
 * 返回 null 表示无可用基准（调用方须如实声明「完整性未验证」）。
 *
 * @param envelopeMeta 信封顶层标量成员
 */
export function detectEnvelopeBaseline(
  envelopeMeta: Record<string, unknown>,
): CompletenessBaseline | null {
  // 小写键 → 原始键（保留原始拼写用于回显）
  const byLowerKey = new Map<string, string>();
  for (const key of Object.keys(envelopeMeta)) {
    const lower = key.toLowerCase();
    // 同一小写名出现两次时保留首个（对象键序稳定，不随解析器漂移）
    if (!byLowerKey.has(lower)) byLowerKey.set(lower, key);
  }
  for (const group of ENVELOPE_BASELINE_GROUPS) {
    for (const wanted of group) {
      const actualKey = byLowerKey.get(wanted);
      if (!actualKey) continue;
      const value = envelopeMeta[actualKey];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return { kind: 'envelope', key: actualKey, value };
      }
    }
  }
  return null;
}

/**
 * 核对实抓行数与基准，得出对账结论。
 *
 * @param rowCount 实抓行数
 * @param baseline 基准（null 表示无可用基准）
 */
export function verifyCompleteness(
  rowCount: number,
  baseline: CompletenessBaseline | null,
): CompletenessVerdict {
  if (!baseline || baseline.kind === 'none') return 'unverified';
  if (rowCount === baseline.value) return 'matched';
  return rowCount < baseline.value ? 'short' : 'over';
}

/** 对账结论的中文回显（供各工具拼进响应） */
export function describeCompleteness(
  rowCount: number,
  baseline: CompletenessBaseline | null,
  verdict: CompletenessVerdict,
): string {
  if (!baseline || baseline.kind === 'none') {
    const reason = baseline?.kind === 'none' ? baseline.reason : '该数据源未提供可对比的总量字段';
    return `完整性未验证：${reason}——实抓 ${rowCount} 行，但无独立基准可比对（不要用实抓行数自己对照自己）。`;
  }
  const baselineText =
    baseline.kind === 'envelope'
      ? `信封自报 ${baseline.key}=${baseline.value}`
      : `抓取前 DOM 匹配数=${baseline.value}`;
  switch (verdict) {
    case 'matched':
      return `完整性核对通过：实抓 ${rowCount} 行 == ${baselineText}。`;
    case 'short':
      return `完整性核对未通过：实抓 ${rowCount} 行 < ${baselineText}——可能漏抓（懒加载未渲染完 / 分页未抓完 / 选择器漏项），请先排查再交付。`;
    case 'over':
      return `完整性核对未通过：实抓 ${rowCount} 行 > ${baselineText}——可能重复采集或基准已过时，请核对去重。`;
    default:
      return `完整性未验证：实抓 ${rowCount} 行，无独立基准可比对。`;
  }
}

/**
 * 把一个数据源的原始值解析为行数据（数据通道的统一入口）。
 *
 * 与 {@link resolveRelationTable} 同源，额外把「无法解析」的情况转成
 * **带确切下一步**的错误文案（数据通道各工具共用同一份，避免同一问题
 * 在导出时报 A、在合并时报 B）。
 *
 * @param value 数据源的原始值
 * @param sourceLabel 数据来源描述（文件路径 / 批次 ID），用于错误回显
 */
export function resolveDataSourceRows(
  value: unknown,
  sourceLabel: string,
): { ok: true; source: ResolvedDataSource } | { ok: false; reason: string } {
  const resolution = resolveRelationTable(value);
  if (!resolution.ok) {
    return { ok: false, reason: describeRelationFailure(resolution, sourceLabel) };
  }
  const shape = analyzeValue(resolution.rows);
  if (shape.kind === "value") {
    // 解析出的「数组」内部行形态不统一（对象行与其它类型行混杂）
    return {
      ok: false,
      reason:
        `${sourceLabel} 的表内行不是统一的表格形态（对象行与其它类型行混杂）——` +
        '请用 data_ref_tool(action="project", file="' +
        sourceLabel +
        '", path="<表所在路径>") 整形为纯对象数组后再导出',
    };
  }
  return {
    ok: true,
    source: {
      rows: resolution.rows,
      kind: shape.kind,
      note: describeRelationChoice(resolution),
      rowCount: resolution.rows.length,
      envelopeMeta: resolution.envelopeMeta,
    },
  };
}
