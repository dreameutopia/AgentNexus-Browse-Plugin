/**
 * 视口图像去重判重器（模型可见上下文的「唯一截图」保障）
 *
 * 职责：判定「这张视口截图是否已经出现在模型可见上下文里」。
 * 判重依据是**图片内容哈希**（ImageRef），不是 data URL 字符串：
 *   - 图片库是内容寻址的（SHA-256），同一像素内容恒得同一 hash；
 *   - data URL 字符串可能因编码差异（换行/压缩参数）而不同，内容却相同——
 *     字符串比较会漏判并白白重复附图；
 *   - hash 比较天然跨轮次、跨消息一致（历史截图入库后 hash 不变）。
 *
 * 使用契约：
 *   - 判定为「重复」时**不得**再作为 image_url 部件附加到模型上下文
 *     （像素证据模型已持有，重复图片只多耗约 1200 token/张）；
 *   - 判定为「重复」**不**影响归档与 UI 时间线：截图确实发生过，
 *     仍须入库、仍须发 message-image 事件（内容寻址下同 hash 天然只存一份，
 *     时间线仍按「两次真实发生」记两条片段）。
 *   - 区域放大图（vision_read_zoom）与用户上传图片**不参与**判重：
 *     语义与视口全景不同（局部证据 / 用户提供的素材），恒不复用。
 *
 * 边界防御：
 *   - hash 缺失（入库失败）时返回 false（不判重）——宁可多附一张图，
 *     也不能因为拿不到引用就误判并丢掉模型需要的像素证据；
 *   - 判重集合只增不减：模型上下文里的历史截图不会被「撤销」，
 *     因此任何时候都应假设旧图仍可能在上下文里。
 */

/** 一张待判重的视口图像 */
export interface ViewportImageCandidate {
  /** 图片内容哈希（ImageRef）；缺失 = 无法判重 */
  ref?: string | null;
  /** 图像种类：仅 'viewport' 参与判重 */
  kind: 'viewport' | 'region';
}

/**
 * 判重器：持有「模型可见上下文已包含的视口图哈希」集合。
 *
 * 生命周期与一次运行（RunHandle）同寿命：准备阶段注入首截图的 hash，
 * 每次向模型交付视口图后登记其 hash。
 */
export class ViewportImageDeduplicator {
  /** 已进入模型可见上下文的视口图哈希（内容寻址 hash，非 data URL） */
  private readonly seen = new Set<string>();

  /**
   * 登记一张已进入模型上下文的视口图（幂等）。
   * 引用缺失时静默忽略——无法判重的图不进集合（宁可漏判重，不可误删证据）。
   */
  remember(ref: string | null | undefined): void {
    if (typeof ref === 'string' && ref.length > 0) this.seen.add(ref);
  }

  /**
   * 该候选是否已在模型可见上下文中出现过（true = 重复，不应再附图）。
   *
   * 只有视口全景参与判重；引用缺失一律判 false（不判重）。
   */
  isDuplicate(candidate: ViewportImageCandidate): boolean {
    if (candidate.kind !== 'viewport') return false;
    const ref = candidate.ref;
    if (typeof ref !== 'string' || ref.length === 0) return false;
    return this.seen.has(ref);
  }

  /** 当前已登记的视口图数量（诊断用） */
  get size(): number {
    return this.seen.size;
  }
}
