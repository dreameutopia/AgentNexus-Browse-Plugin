/**
 * 直播消息的片段流装配（纯函数，单一事实源）。
 *
 * 助手消息在直播期的片段流由三类事件推进：建立占位（assistant-start）、
 * 首个内容事件（正文 / 推理 / 工具调用）、截图到达（message-image）。
 * 三者对片段流的影响集中在此模块，App.vue 只负责事件分发——规则一旦分散，
 * 「占位转真实消息」那一步就容易连带丢掉首截图片段：首截图于是从时间线
 * 上消失，只剩 imageRefs 引用，渲染层随即回退到消息底部的「关联图片区」
 * （截图被挂在消息最后，而不是按发生顺序内联在对应轮次之前）。
 *
 * 片段流即时间线：截图片段按**截屏发生顺序**排列——首截图位于消息最前，
 * 每轮工具后的重截图紧跟其轮次。顺序口径与引擎 record.parts 一致，
 * 终态覆盖（assistant-complete 按下标合并）才不会错位。
 */

import type { MessagePart } from '../../types/chat';

/** 直播消息的片段流状态（与 UI 消息对象的 parts / imageRefs 一一对应） */
export interface LiveMessageState {
  /** 片段流（按发生顺序） */
  parts: MessagePart[];
  /** 图片引用集合（去重保序；终态对齐与历史兜底展示用） */
  imageRefs: string[];
}

/** 图片引用去重保序（空引用剔除） */
const dedupeRefs = (refs: readonly string[]): string[] => {
  const result: string[] = [];
  for (const ref of refs) {
    if (ref && !result.includes(ref)) result.push(ref);
  }
  return result;
};

/**
 * assistant-start：建立「思考中」占位。
 *
 * 首截图（若已就位）按发生顺序置于片段流**最前**——它是本轮最早发生的
 * 事实，排在正文与工具调用之前；正文占位片段（空文本）随后，真正的
 * 正文由首个内容事件写入。
 */
export function startLiveMessage(imageRefs: readonly string[] = []): LiveMessageState {
  const refs = dedupeRefs(imageRefs);
  return {
    parts: [
      ...refs.map(ref => ({ type: 'image' as const, imageRef: ref })),
      { type: 'text', content: '' },
    ],
    imageRefs: refs,
  };
}

/**
 * 首个内容事件（正文 / 推理 / 工具调用）到达：占位转为真实消息。
 *
 * 空正文占位片段必须丢弃（正文由内容事件重新写入），**截图片段与压缩
 * 片段必须保留**——首截图与发送前压缩（pre-run 种子片段）都是这一轮
 * 之前已经发生的事实，丢弃等于把它们从时间线上抹掉：截图只能靠
 * imageRefs 兜底呈现（挂在消息最后），压缩则彻底失去时间线入口。
 */
export function beginLiveMessage(state: LiveMessageState): LiveMessageState {
  return {
    parts: state.parts.filter(part => part.type === 'image' || part.type === 'compaction'),
    imageRefs: state.imageRefs,
  };
}

/**
 * 截图到达：按发生顺序追加到片段流末尾。
 *
 * 片段流不去重——内容寻址下同一张图的两次截屏是**两次真实发生**，时间线
 * 必须保留两条（漏推会让终态按索引合并时与引擎记录错位）；引用集合去重
 * 保序（引用是集合语义，同一张图只登记一次）。
 */
export function appendLiveImage(state: LiveMessageState, imageRef: string): LiveMessageState {
  if (!imageRef) return state;
  return {
    parts: [...state.parts, { type: 'image', imageRef }],
    imageRefs: state.imageRefs.includes(imageRef) ? state.imageRefs : [...state.imageRefs, imageRef],
  };
}

/**
 * 消息是否含可见内容（用于中止终态化：完全无内容的占位消息直接移除）。
 * 截图片段算可见内容——只截了屏还没来得及说话就被中止的轮次，截图本身
 * 就是这一轮唯一的产出，移除消息等于把截图连同记录一起丢掉。压缩片段
 * 同理：中止发生在压缩期间/之后的轮次，压缩行（含其中断结算态）是唯一
 * 产出，保留它才不丢「这一轮发生过什么」的事实。
 */
export function hasVisibleLiveContent(state: {
  content?: string;
  reasoningContent?: string;
  toolCallCount?: number;
  parts?: readonly MessagePart[];
}): boolean {
  if (typeof state.content === 'string' && state.content.trim()) return true;
  if (typeof state.reasoningContent === 'string' && state.reasoningContent.trim()) return true;
  if ((state.toolCallCount ?? 0) > 0) return true;
  return (state.parts ?? []).some(part => part.type === 'image' || part.type === 'compaction');
}
