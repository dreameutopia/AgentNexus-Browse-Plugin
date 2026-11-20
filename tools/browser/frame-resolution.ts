/**
 * 元素引用 → 所属 frame 的推导。
 *
 * 为什么需要（实测数据）：一次真实任务里，模型两次调用 browser_interact 都漏填
 * frameId，每次都被 INVALID_ARGUMENT 挡回（"DOM 操作必须提供观察结果的 FrameId"），
 * 白烧两轮。而 frameId **本可由 elementId 唯一确定**：
 *
 *   元素引用格式为 `anx:<tabId>:<nonce>:<序号>`，其中 nonce 由**每个 frame 的
 *   document 独立生成**（引用注册表挂在 document 上，elementScanPayload 被注入到
 *   每个 frame 各自执行——见 tools/automation/shared/element-scan-payload.ts）。
 *   因此同一 tab 内，nonce 段唯一标识一个 frame。
 *
 * 两条推导通路（按代价从低到高）：
 *   1. **宿主侧快照索引**：browser_observe 枚举时已经知道每个元素来自哪个 frame，
 *      把映射记进索引即可 O(1) 命中——无需任何页面注入。
 *   2. **全 frame 广播探测**：索引未命中时（如引用来自更早的一次观察），
 *      一次 allFrames 注入让各 frame 报告自己是否认这个 id。
 *
 * 设计约束：
 *   - 推导**永不覆盖**显式传入的 frameId：显式值优先；若与推导结果冲突，
 *     报 FRAME_MISMATCH 并同时给出两个 id，让模型能立刻定位自己的抄写错误。
 *   - 推导失败必须给出**可区分**的原因（索引未命中 / 探测未命中 / 多 frame 命中），
 *     不能笼统地说"引用无效"。
 */

import type { ToolExecutionContext } from '../registry';
import { executeScriptBounded } from '../common/frame-read';
import { boundedText } from './text-runtime';

/** 元素引用格式：`anx:<tabId>:<nonce>:<序号>`。 */
const ELEMENT_ID_PATTERN = /^anx:(\d+):([a-f0-9-]+):(\d+)$/;

/** 单个 tab 的 elementId → frameId 索引。 */
type FrameIndex = Map<string, number>;

/** 索引保存上限（每个 tab）。超出后按插入顺序淘汰最旧项。 */
const FRAME_INDEX_MAX_ENTRIES = 5000;

/**
 * 宿主侧 frame 索引。
 *
 * 以 tabId 分桶；桶内是 elementId → frameId 的映射。
 * 页面重渲染会让旧引用失效（由注入侧的失效判定负责），索引只负责**定位**，
 * 因此过期条目留在索引里无害——真正操作时仍会经过完整的引用有效性校验。
 */
const frameIndexes = new Map<number, FrameIndex>();

/** 记录一次枚举结果里的 elementId → frameId 映射。 */
export function recordElementFrames(
  tabId: number,
  entries: readonly { elementId: string; frameId: number }[],
): void {
  if (!entries.length) return;
  let index = frameIndexes.get(tabId);
  if (!index) {
    index = new Map<string, number>();
    frameIndexes.set(tabId, index);
  }
  for (const entry of entries) {
    if (!index.has(entry.elementId)) {
      if (index.size >= FRAME_INDEX_MAX_ENTRIES) {
        // Map 保持插入顺序 → 首个键即最旧项
        const oldest = index.keys().next();
        if (!oldest.done) index.delete(oldest.value);
      }
      index.set(entry.elementId, entry.frameId);
    }
  }
}

/** 丢弃某个 tab 的索引（导航后旧引用全部失效）。 */
export function clearFrameIndex(tabId: number): void {
  frameIndexes.delete(tabId);
}

/** 推导结果。 */
export type FrameResolution =
  | { status: 'resolved'; frameId: number; source: 'index' | 'probe' }
  | { status: 'not_an_element_id' }
  | { status: 'not_indexed' }
  | { status: 'not_found'; accessibleFrames: number }
  | { status: 'ambiguous'; frameIds: number[] };

/** 从 elementId 直接读出 tabId 与 nonce（不查索引）。 */
export function parseElementId(
  elementId: string,
): { tabId: number; nonce: string } | null {
  const match = ELEMENT_ID_PATTERN.exec(elementId);
  if (!match) return null;
  return { tabId: Number(match[1]), nonce: match[2] };
}

/**
 * 推导 elementId 所属的 frame。
 *
 * @param tabId 目标标签页（必须与 elementId 中的 tabId 一致，否则调用方先行拒绝）
 * @param options.verify 显式传入 frameId 时的交叉核对策略：
 *   - `'probe'`（默认）：索引命中即核对，不命中则广播探测——能发现"模型抄错了行"；
 *   - `'skip'`：只信显式值，不做任何额外工作——用于调用方已自行核对过引用的场景。
 */
export async function resolveElementFrame(
  tabId: number,
  elementId: string,
  options: { verify?: 'probe' | 'skip'; context?: ToolExecutionContext } = {},
): Promise<FrameResolution> {
  if (!ELEMENT_ID_PATTERN.test(elementId)) return { status: 'not_an_element_id' };

  const index = frameIndexes.get(tabId);
  const indexed = index?.get(elementId);
  if (indexed !== undefined)
    return { status: 'resolved', frameId: indexed, source: 'index' };

  // 索引未命中：全 frame 广播探测。
  const results = await boundedText(
    executeScriptBounded({
      target: { tabId, allFrames: true },
      world: 'ISOLATED',
      func: ownsElementReferencePayload,
      args: [elementId],
    }, undefined, undefined, options.context),
    '定位元素所属 frame',
  );
  const owners: number[] = [];
  for (const result of results) {
    const payload = result.result as { owns?: boolean } | undefined;
    if (payload?.owns && typeof result.frameId === 'number') owners.push(result.frameId);
  }
  if (owners.length === 1) return { status: 'resolved', frameId: owners[0], source: 'probe' };
  if (owners.length > 1)
    return { status: 'ambiguous', frameIds: owners };
  return {
    status: 'not_found',
    accessibleFrames: results.filter((result) => result.frameId !== undefined).length,
  };
}

/**
 * 探测载荷：报告当前 frame 的引用注册表是否认这个 id。
 *
 * 自包含（可被 chrome.scripting 序列化），不依赖模块作用域。
 */
function ownsElementReferencePayload(elementId: string) {
  const registry = (
    document as unknown as {
      __agentNexusReferences?: { resolve(id: string): Element | null };
    }
  ).__agentNexusReferences;
  if (!registry) return { owns: false };
  try {
    return { owns: registry.resolve(elementId) !== null };
  } catch {
    return { owns: false };
  }
}

/** 把推导结果转成可直接给模型看的错误文案。 */
export function describeFrameResolutionFailure(
  resolution: FrameResolution,
  elementId: string,
): string {
  switch (resolution.status) {
    case 'not_an_element_id':
      return (
        `INVALID_ELEMENT_ID：${elementId} 不是有效的元素引用。` +
        '请原样复制 browser_observe 结果中的 ElementId（形如 anx:<tabId>:<nonce>:<序号>）。'
      );
    case 'not_indexed':
      return (
        `FRAME_NOT_RESOLVED：无法确定 ${elementId} 所属的 frame。` +
        '该引用不在最近的观察索引中，且广播探测未命中——引用可能来自已被清理的旧观察。' +
        '请重新 browser_observe 获取新的 ElementId 与 FrameId。'
      );
    case 'not_found':
      return (
        `FRAME_NOT_RESOLVED：在 ${resolution.accessibleFrames} 个可访问 frame 中都没有找到 ${elementId}。` +
        '引用可能已失效（页面重渲染/已导航）或属于另一个标签页。' +
        '请重新 browser_observe 获取新的 ElementId 与 FrameId。'
      );
    case 'ambiguous':
      return (
        `FRAME_AMBIGUOUS：${elementId} 同时出现在多个 frame（${resolution.frameIds.join(', ')}），` +
        '无法自动判定目标。请显式传入 frameId 指定。'
      );
    default:
      return `FRAME_NOT_RESOLVED：无法确定 ${elementId} 所属的 frame。`;
  }
}
