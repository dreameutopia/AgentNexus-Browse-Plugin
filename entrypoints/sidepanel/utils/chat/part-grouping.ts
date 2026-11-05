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
 * ── 直播态分段（buildLivePartSegments）──
 * 直播中连续的过程片段（工具调用 / 推理 / 截图）达到阈值后折叠成一条
 * 「小折叠」摘要条（对标 Claude Code / Codex / Copilot：最新活动恒可见、
 * 被取代的旧活动收拢成组）。消息末尾的簇保留最新一项在条外直接可见，
 * 中段（后面已有正文/注记接续）的簇整组收拢。
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
  };
}

// ==================== 直播态分段（连续过程小折叠） ====================

/** 直播簇摘要计数 */
export interface ClusterCounts {
  tools: number;
  reasoning: number;
  images: number;
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
 * 触发小折叠的簇规模下限：簇内片段数达到该值才收拢
 * （末尾簇收拢前 n-1 项、保留最新 1 项；中段簇整组收拢）。
 * 低于该值的簇按原样逐项渲染——为一两个片段立折叠条只会增加点击成本。
 */
export const MIN_LIVE_CLUSTER_PARTS = 3;

/** 过程片段（参与连续过程簇的片段类型） */
const isProcessPart = (part: IndexedMessagePart['part']): boolean =>
  part.type === 'tool' || part.type === 'reasoning' || part.type === 'image';

const countParts = (items: IndexedMessagePart[]): ClusterCounts => {
  const counts: ClusterCounts = { tools: 0, reasoning: 0, images: 0 };
  for (const item of items) {
    if (item.part.type === 'tool') counts.tools += 1;
    else if (item.part.type === 'reasoning') counts.reasoning += 1;
    else if (item.part.type === 'image') counts.images += 1;
  }
  return counts;
};

const sumToolDuration = (items: IndexedMessagePart[]): number => {
  let total = 0;
  for (const item of items) {
    const ms = item.part.type === 'tool' ? item.part.toolCall?.executionTime : undefined;
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) total += ms;
  }
  return total;
};

/**
 * 直播片段流 → 渲染项序列：把连续过程片段（工具/推理/截图）收拢为
 * 「小折叠」摘要条。collapse=false（结束态分组、非直播上下文）时退化为
 * 原样逐项输出，行为与未引入簇之前完全一致。
 *
 * 簇的两种形态：
 *   - 末尾簇（片段流终止于该簇）：保留最新一项在条外直接可见——
 *     直播中的当前活动（运行中的工具 / 正在流出的思考）不能被折叠遮住；
 *   - 中段簇（后续已有正文/注记接续）：整组收拢——后面出现了更新的
 *     内容，簇内全部片段都已被取代。
 */
export function buildLivePartSegments(
  indexed: IndexedMessagePart[],
  options: { collapse: boolean },
): LiveRenderEntry[] {
  const entries: LiveRenderEntry[] = [];
  let run: IndexedMessagePart[] = [];

  const flush = (trailing: boolean): void => {
    if (run.length === 0) return;
    if (!options.collapse || run.length < MIN_LIVE_CLUSTER_PARTS) {
      for (const item of run) entries.push({ kind: 'part', item });
      run = [];
      return;
    }
    const grouped = trailing ? run.slice(0, -1) : run.slice();
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
    if (trailing) entries.push({ kind: 'part', item: run[run.length - 1] });
    run = [];
  };

  for (const item of indexed) {
    if (isProcessPart(item.part)) {
      run.push(item);
      continue;
    }
    flush(false);
    entries.push({ kind: 'part', item });
  }
  flush(true);
  return entries;
}
