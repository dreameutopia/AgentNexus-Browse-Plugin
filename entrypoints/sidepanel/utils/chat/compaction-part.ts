/**
 * 压缩片段（type='compaction'）的生命周期纯函数——唯一实现。
 *
 * 双写约定的两侧共用：
 *   - 引擎侧写入转录记录（record.parts，随 flush 持久化，历史重载还原）；
 *   - UI 侧镜像同一状态到直播消息（runningAssistantMessages 的 parts）。
 * 两侧调用同一组函数，保证终态按索引合并（assistant-complete）时片段流
 * 不错位——这是既有「片段流即时间线」约定在压缩片段上的延续。
 *
 * 语义：
 *   - start → pushCompactionPart：追加一条 pending 片段（一次压缩一行，
 *     同一运行内多次压缩各占一行，时间线按发生顺序排列）；
 *   - done/failed → settleCompactionPart：结算**最后一条 pending** 片段
 *     （携带 summary / token 数 / 错误与耗时）；
 *   - 运行终态（中止 / 异常 / 收尾）→ settlePendingCompactionParts：
 *     把所有仍处 pending 的压缩片段结算为中断错误，绝不让旋转态片段
 *     留在一条已定稿的消息里。
 */

import type { CompactionPartState, MessagePart } from '../../types/chat';

/**
 * 构造一条压缩片段（状态由调用方给定）。
 *
 * 两侧共用：
 *   - 发送前压缩的种子形态（已结算的 success / error，无 pending→结算过程）——
 *     引擎侧写 record.parts、UI 侧缓冲同一条数据，种子字节一致；
 *   - 运行中压缩的 pending 片段（见 pushCompactionPart）。
 */
export function createCompactionPart(state: CompactionPartState): MessagePart {
  return { type: 'compaction', compaction: { ...state } };
}

/** 新建一条 pending 压缩片段（不可变追加，返回新数组） */
export function pushCompactionPart(
  parts: readonly MessagePart[],
  state: Pick<CompactionPartState, 'trigger'> & Partial<Pick<CompactionPartState, 'originalTokens'>>,
): MessagePart[] {
  return [...parts, createCompactionPart({ status: 'pending', ...state })];
}

/** 就地结算片段对象（变异写法：record.parts 与 UI parts 都持片段引用） */
function settlePart(part: MessagePart, state: Partial<CompactionPartState>): void {
  if (!part.compaction) return;
  part.compaction = { ...part.compaction, ...state, status: state.status ?? part.compaction.status };
}

/**
 * 结算最后一条 **pending** 压缩片段。
 *
 * 扫描方向：自流末向前，跳过已结算的压缩片段，命中第一条 pending 即结算。
 * 「跳过已结算」而非「遇已结算即失败」是必要的：一次运行可能多次压缩，
 * 片段流形如 [已结算的发送前压缩, pending 的运行中压缩]，结算必须落到
 * 那条 pending 上——早先的已结算片段只作跳过，不阻断结算。
 *
 * 返回是否结算成功（无 pending 片段时 false——事件乱序 / 重复结算 / 迟到
 * 事件的防御：已结算的片段不会被二次覆盖）。
 */
export function settleCompactionPart(
  parts: readonly MessagePart[],
  state: Partial<CompactionPartState> & Pick<CompactionPartState, 'status'>,
): boolean {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.type !== 'compaction' || !part.compaction) continue;
    if (part.compaction.status !== 'pending') continue;
    settlePart(part, state);
    return true;
  }
  return false;
}

/**
 * 把所有 pending 压缩片段结算为中断错误（运行终态收尾）。
 * 返回是否存在被结算的片段（调用方据此决定是否刷新/落库）。
 */
export function settlePendingCompactionParts(
  parts: readonly MessagePart[],
  error: string,
): boolean {
  let settled = false;
  for (const part of parts) {
    if (part.type !== 'compaction' || !part.compaction) continue;
    if (part.compaction.status !== 'pending') continue;
    settlePart(part, { status: 'error', error });
    settled = true;
  }
  return settled;
}

/** 展开意图切换（双写策略：列表副本与运行源共用同一片段对象时一次写入即可） */
export function toggleCompactionExpanded(parts: readonly MessagePart[], index: number): boolean {
  const part = parts[index];
  if (!part || part.type !== 'compaction' || !part.compaction) return false;
  if (part.compaction.status === 'pending') return false;
  part.compaction = { ...part.compaction, expanded: !part.compaction.expanded };
  return true;
}

/**
 * 历史重载的展示归一（纯函数，零拷贝快路径）。
 *
 * 场景：运行中压缩的 pending 片段随 2s 快照落库后，进程在压缩完成前崩溃
 * （或被浏览器杀死）——库里留下带旋转态片段的死记录，重载后会在一条
 * 永不再更新的消息上渲染一个永恒的 spinner。
 *
 * 归一规则：历史加载（非 attach 的直播快照）一律把 pending 结算为中断
 * 错误。若压缩仍在进行，attach 路径用的是引擎内存中的运行记录（不经本
 * 函数），随后的 done/failed 事件照常结算——两条读取路径互不干扰。
 *
 * 拷贝语义：无 pending 时返回原数组引用（零拷贝）；有待结算片段时返回
 * 新数组、新片段对象（不污染调用方持有的记录对象——历史记录可能同时
 * 进缓存 / 备份导出，展示归一绝不能反向写入它们）。
 */
export function historyDisplayParts(
  parts: readonly MessagePart[],
  interruptedText: string,
): MessagePart[] {
  let hasPending = false;
  for (const part of parts) {
    if (part.type === 'compaction' && part.compaction?.status === 'pending') {
      hasPending = true;
      break;
    }
  }
  if (!hasPending) return parts as MessagePart[];
  return parts.map(part =>
    part.type === 'compaction' && part.compaction?.status === 'pending'
      ? { ...part, compaction: { ...part.compaction, status: 'error' as const, error: interruptedText } }
      : part,
  );
}
