/**
 * 消息片段分组纯函数：结束态「前奏折叠」+ 直播态「连续过程小折叠」。
 *
 * 从 MessageItem / MessageParts 抽出的领域规则——所有终态（正常结束 / 用户
 * 中止 / 运行异常 / 学习模式收尾）共用同一条分组约定，且需要独立单测覆盖
 * 每一种边缘时序，放在组件内既无法复用也无法直接测试。
 *
 * ── 结束态分组（groupAnswerParts）──
 * 锚点是「最后一个文本片段」= 末段正文。除锚点与 notice 外的一切片段
 * （正文之前的推理/工具/截图/中间文本，**以及正文之后残留的工具调用等**）
 * 一律收入前奏折叠——被中止或异常收尾的运行同样完整折叠，不允许折叠条
 * 下方再漏出过程内容。notice（守卫停止、截断说明等终态注记）恒保持可见，
 * 不被折叠遮蔽。没有任何文本片段时（如中止于纯工具轮），前奏收纳全部
 * 过程内容、正文为空——折叠条单独成立。
 *
 * ── 连续过程小折叠（buildLivePartSegments）──
 * 直播中与结束态（含展开的前奏折叠内部）共用的过程收拢：**只有连续的
 * 工具调用、思考与截图（含 vision 截图、上下文压缩）才收拢**，两项即成簇
 * （对标 Claude Code / Codex / Copilot：最新活动恒可见、被取代的旧活动收拢
 * 成组）。正文文本是正式输出，不参与收拢——它恒可见，并作为簇间隔离：一旦
 * 出现非思考输出，过程连续即被隔断，两侧各自成簇。notice（终态注记）
 * 同样恒可见且切断簇；抵达片段流末尾的簇保留最新一项直接可见（直播中
 * 的当前活动不被折叠遮住），其余整组收拢。
 */

import type { IndexedMessagePart } from '../../types/chat';

// ==================== 结束态分组 ====================

/** 结束态分组结果（MessageItem 分组渲染的数据源） */
export interface AnswerGrouping {
  /** 收入前奏折叠的全部过程片段（锚点正文与 notice 之外的一切） */
  prelude: IndexedMessagePart[];
  /** 末段正文（最后一个文本片段；无任何文本时为 null） */
  final: IndexedMessagePart | null;
  /** 折叠条之下保持可见的片段（系统注记：终态说明恒可见） */
  tail: IndexedMessagePart[];
  /** 摘要是否包含思考过程（含旧记录的 reasoning_content） */
  hasReasoning: boolean;
  /** 全消息工具调用数（摘要展示用；含锚点之后被并入前奏的调用） */
  toolCount: number;
  /** 全消息上下文压缩次数（摘要展示用；与 toolCount 同一口径） */
  compactionCount: number;
}

/** 结束态分组选项 */
export interface GroupAnswerOptions {
  /** 旧记录仅有 reasoning_content、无 reasoning 片段（已 trim 判空） */
  legacyReasoningText: boolean;
  /** 消息级 toolCalls 总数（旧记录 parts 可能缺工具片段时的回退口径） */
  totalToolCalls?: number;
}

/**
 * 按末段正文切分可见片段（结束态「前奏折叠」的唯一依据）。
 *
 * 规则：
 *   - final   = 最后一个 text 片段（锚点，始终直接可见）；
 *   - prelude = 其余全部非 notice 片段——**含锚点之后**的过程残留
 *               （中止前最后一批工具调用 / 截图 / 思考），一并折叠，
 *               折叠条之下只允许出现锚点正文与终态注记；
 *   - tail    = 全部 notice 片段（终态说明，恒可见）。
 * notice 在时间线上只会由引擎在收尾时追加（appendNotice 仅终止路径调用），
 * 理论上不会出现在正文之前；即使出现（防御脏数据）也归入 tail 保持可见。
 */
export function groupAnswerParts(
  indexed: IndexedMessagePart[],
  options: GroupAnswerOptions,
): AnswerGrouping {
  let finalPos = -1;
  for (let i = indexed.length - 1; i >= 0; i--) {
    if (indexed[i].part.type === 'text') {
      finalPos = i;
      break;
    }
  }
  const final = finalPos === -1 ? null : indexed[finalPos];

  const prelude: IndexedMessagePart[] = [];
  const tail: IndexedMessagePart[] = [];
  for (const item of indexed) {
    if (final !== null && item === final) continue;
    if (item.part.type === 'notice') tail.push(item);
    else prelude.push(item);
  }

  return {
    prelude,
    final,
    tail,
    hasReasoning: options.legacyReasoningText || prelude.some(it => it.part.type === 'reasoning'),
    toolCount: options.totalToolCalls ?? indexed.filter(it => it.part.type === 'tool').length,
    compactionCount: indexed.filter(it => it.part.type === 'compaction').length,
  };
}

// ==================== 连续过程小折叠（直播态 + 结束态前奏内部通用） ====================

/** 簇摘要计数 */
export interface ClusterCounts {
  tools: number;
  reasoning: number;
  images: number;
  compactions: number;
}

/** 「小折叠」摘要条渲染项 */
export interface LiveClusterBarEntry {
  kind: 'cluster-bar';
  /** 簇稳定标识（组内首个片段的原始下标；簇生长时不变，用于展开记忆） */
  key: string;
  /** 收入摘要条的片段（展开时渲染） */
  grouped: IndexedMessagePart[];
  counts: ClusterCounts;
  /** 组内已结算工具的执行时长合计（毫秒；无已结算调用为 0） */
  durationMs: number;
}

/** 普通片段渲染项；clusterKey 存在时该片段隶属于摘要条，仅在展开时渲染 */
export interface LivePartEntry {
  kind: 'part';
  item: IndexedMessagePart;
  clusterKey?: string;
  /** 归属簇的片段数（展开记忆的版本号：簇生长后自动重新收起） */
  clusterVersion?: number;
}

export type LiveRenderEntry = LiveClusterBarEntry | LivePartEntry;

/**
 * 过程片段（参与连续过程簇的片段类型）：工具调用、思考、截图与上下文压缩。
 * 压缩片段与工具调用同一待遇——直播中是当前活动（pending 旋转行），被后续
 * 活动取代后随簇收拢，终态并入前奏折叠；簇摘要计数单列（「N 次压缩」）。
 */
const isProcessPart = (part: IndexedMessagePart['part']): boolean =>
  part.type === 'tool' || part.type === 'reasoning' || part.type === 'image' || part.type === 'compaction';

/**
 * 簇间断片段：**正文文本（正式输出）**与 notice（终态注记）恒可见、绝不
 * 参与收拢，并隔离两侧的簇——一旦出现非思考输出，工具/思考的连续即被
 * 隔断，两侧各自成簇。未来的未知片段类型同样按断片处理（fail-open，
 * 宁可多展示不隐藏）。
 */
const isBreakerPart = (part: IndexedMessagePart['part']): boolean => !isProcessPart(part);

const countParts = (items: IndexedMessagePart[]): ClusterCounts => {
  const counts: ClusterCounts = { tools: 0, reasoning: 0, images: 0, compactions: 0 };
  for (const item of items) {
    if (item.part.type === 'tool') counts.tools += 1;
    else if (item.part.type === 'reasoning') counts.reasoning += 1;
    else if (item.part.type === 'image') counts.images += 1;
    else if (item.part.type === 'compaction') counts.compactions += 1;
  }
  return counts;
};

/**
 * 簇内已结算过程片段的耗时合计（毫秒；无已结算片段为 0）。
 * 工具取 executionTime、压缩取 durationMs——两者都是「这一行做了多久」的
 * 同一语义字段，簇条耗时是全组过程成本，两类都计入。
 */
const sumToolDuration = (items: IndexedMessagePart[]): number => {
  let total = 0;
  for (const item of items) {
    const ms =
      item.part.type === 'tool'
        ? item.part.toolCall?.executionTime
        : item.part.type === 'compaction'
          ? item.part.compaction?.durationMs
          : undefined;
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) total += ms;
  }
  return total;
};

/**
 * 片段流 → 渲染项序列：把**连续的工具调用 / 思考 / 截图**收拢为「小折叠」
 * 摘要条。直播与结束态（含展开的前奏折叠内部）同一规则；正文文本与
 * notice 作为簇间断片恒可见（隔离语义见 isBreakerPart）。
 *
 * 折叠条件与形态：
 *   - 连续过程片段 ≥2 才收拢：单个工具/思考本身就是一行紧凑容器，
 *     为它立折叠条只增加点击成本；
 *   - 簇抵达片段流末尾（其后没有任何片段）→ 收拢前 n-1 项、保留最新
 *     一项直接可见——直播中的当前活动（运行中的工具 / 正在流出的思考）
 *     不能被折叠遮住；
 *   - 簇其后还有内容（正文 / notice / 后续簇）→ 整组收拢——已有更新的
 *     内容接续，簇内全部片段都已被取代。
 */
export function buildLivePartSegments(indexed: IndexedMessagePart[]): LiveRenderEntry[] {
  const entries: LiveRenderEntry[] = [];
  const total = indexed.length;
  let cursor = 0;

  while (cursor < total) {
    if (isBreakerPart(indexed[cursor].part)) {
      entries.push({ kind: 'part', item: indexed[cursor] });
      cursor += 1;
      continue;
    }
    // 连续过程片段段 [start, end)
    const start = cursor;
    let end = start;
    while (end < total && !isBreakerPart(indexed[end].part)) end += 1;
    const run = indexed.slice(start, end);

    // 单个过程片段：一行紧凑容器，不立折叠条
    if (run.length < 2) {
      for (const item of run) entries.push({ kind: 'part', item });
      cursor = end;
      continue;
    }

    // 抵达片段流末尾的簇保留最新一项在条外直接可见，其余整组收拢
    const reachesStreamEnd = end === total;
    const grouped = reachesStreamEnd ? run.slice(0, -1) : run;
    const key = `cluster-${grouped[0].index}`;
    const version = grouped.length;
    entries.push({
      kind: 'cluster-bar',
      key,
      grouped,
      counts: countParts(grouped),
      durationMs: sumToolDuration(grouped),
    });
    for (const item of grouped) {
      entries.push({ kind: 'part', item, clusterKey: key, clusterVersion: version });
    }
    if (reachesStreamEnd) entries.push({ kind: 'part', item: run[run.length - 1] });
    cursor = end;
  }
  return entries;
}

