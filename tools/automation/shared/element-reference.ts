/** Shared contracts; serialized injections must not capture module bindings. */

/**
 * 引用失效的分层判定（单一事实源）。
 *
 * 为什么分层：早期实现用一个「签名」把**身份**与**上下文**揉在一起——签名里含
 * 祖先文本、表单全文、祖先的 aria-* 属性。于是页面上任何无关变动（聊天挂件吐字、
 * 校验文案出现/消失、祖先的 aria-busy 翻转）都会让一个**仍然连接、仍然可点**的
 * 元素被判成「已失效」。这在真实站点上不是偶发竞态，而是结构必然。
 *
 * 三层语义（由强到弱）：
 * - identity：元素**自身**的稳定属性与文本。变了 → 目标可能已是另一个控件
 *   → IDENTITY_DRIFT（硬失效，重新观察）。
 * - record：元素在**记录/行**中的归属（祖先链、recordOwner、data-id/data-key、
 *   结构类 aria-*）。变了 → 记录被复用（虚拟表格典型场景）→ CONTEXT_CHANGED
 *   （硬失效；这一层必须保留，否则旧引用会误指到复用后的新行）。
 * - context：自由文本上下文摘要（如所在 <form> 的前 180 字符）。变了 → 只是
 *   **上下文变了**，元素本身没变 → CONTEXT_DRIFT（**软信号，不失效**）。
 */
export type ReferenceInvalidationReason =
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'DOCUMENT_CHANGED'
  | 'DISCONNECTED'
  | 'IDENTITY_DRIFT'
  | 'CONTEXT_CHANGED';

/** resolve() 的诊断结果：元素 + 失效原因（供精确错误文案使用）。 */
export interface ReferenceResolution {
  element: Element | null;
  /** 失效原因；element 非 null 时为 null */
  reason: ReferenceInvalidationReason | null;
  /** 上下文摘要变化（软信号：元素仍有效，但周边文本变了） */
  contextChanged: boolean;
}

export interface ElementReferenceRegistry {
  semanticVersion?: number;
  register(element: Element): string;
  resolve(id: string): Element | null;
  fingerprint(): string;
  invalidate(): void;
  describe?(element: Element): ControlSemantics;
  isRendered?(element: Element): boolean;
  /**
   * 解析「状态与激活行为的真正宿主」。
   *
   * 可见表面与状态宿主常常不是同一个节点：自定义复选框通常是
   * `<label><input type=checkbox hidden></label>`——用户点的是 label（可见），
   * 状态住在 input（隐藏）上。读写分离到这个程度时：
   * - 读状态必须读 control；
   * - 写操作必须作用在**不会重复触发**的节点上（点 label 会双触发，见 dom-action-payload）。
   *
   * 解析规则（实现见 element-scan-payload）：
   *   1. <label> → label.control（input[type=checkbox|radio]）；
   *   2. role=checkbox|radio|switch 元素 → 其最近后代 input[type=checkbox|radio]；
   *   3. 其余 → 元素自身（永不返回 null）。
   */
  controlOf?(element: Element): Element;
  /**
   * 带诊断的解析：区分「没找到 / 过期 / 文档变了 / 节点被替换 / 身份漂移 /
   * 记录被复用」，并额外报告上下文软漂移。
   */
  resolveDetailed?(id: string): ReferenceResolution;
  /**
   * 重绑定：元素被应用重渲染替换后，找出**唯一**的等价替代节点。
   *
   * 为什么需要：框架常在 mousedown/pointerdown 后重建 DOM（换掉按钮节点）。
   * 旧实现此时直接报「元素已失效」并**放弃已派发的事件**——用户看到的是
   * 「点了没反应」。重绑定让操作能落到重建后的等价节点上。
   *
   * 严格唯一性：只有**恰好一个**候选时才返回（多个同名按钮时宁可失败也不能
   * 猜错目标）。
   */
  rebind?(id: string): Element | null;
}

export interface ControlSemantics {
  category: string;
  patterns?: string[];
  role: string;
  evidence: string;
  name: string;
  states: Record<string, unknown>;
  relations: Array<{
    relation: string;
    elementId: string;
    role: string;
    name: string;
  }>;
  actions: string[];
  /**
   * 状态宿主（控件本体）的引用与可见性。
   *
   * 当上报元素是「可见 label / role 包装器」而状态住在「隐藏 input」上时，
   * 这两个字段直接告诉模型「这一行是可见表面，状态在另一个节点上」——
   * 不必去猜，也不必去写脚本探测。
   */
  controlElementId?: string;
  controlRendered?: boolean;
  /** 上报元素只是可见表面、真正被操作的是 control */
  controlIsSeparate?: boolean;
}

export const CONTROL_CATEGORIES = [
  'button',
  'close',
  'link',
  'text',
  'search',
  'password',
  'number',
  'date',
  'time',
  'color',
  'slider',
  'spinbutton',
  'checkbox',
  'radio',
  'switch',
  'toggle',
  'select',
  'multiselect',
  'combobox',
  'listbox',
  'option',
  'menu',
  'menuitem',
  'tab',
  'tablist',
  'tree',
  'treeitem',
  'grid',
  'gridcell',
  'dialog',
  'disclosure',
  'group',
  'toolbar',
  'tooltip',
  'status',
  'progress',
  'meter',
  'separator',
  'file',
  'editor',
  'scroll',
  'element',
  'table', 'row', 'cell', 'columnheader', 'rowheader', 'tabpanel',
  'calendar', 'date-range', 'time-range', 'date-segment',
] as const;

/** A control can be a grid and a calendar at the same time. */
export function matchesControlCategory(semantics: Pick<ControlSemantics, 'category' | 'patterns'> | undefined, categories: readonly string[]): boolean {
  return !categories.length || categories.some(category => category === (semantics?.category || 'element') || semantics?.patterns?.includes(category));
}

export type ReferenceDocument = Document & {
  __agentNexusReferences?: ElementReferenceRegistry;
};

/** A read-only second pass, in the same isolated world as scan and action. */
export function validateElementReferences(
  ids: string[],
  requireActionable = true,
): {
  fingerprint: string;
  valid: boolean;
  semantics?: Array<{ elementId: string; semantics: ControlSemantics }>;
  validElementIds?: string[];
  invalidElementIds?: string[];
  errors?: Array<{ elementId: string; message: string }>;
} {
  const registry = (document as ReferenceDocument).__agentNexusReferences;
  const validElementIds: string[] = [];
  const invalidElementIds: string[] = [];
  const semantics: Array<{ elementId: string; semantics: ControlSemantics }> = [];
  const errors: Array<{ elementId: string; message: string }> = [];
  for (const elementId of ids) {
    try {
      const node = registry?.resolve(elementId);
      if (!node) { invalidElementIds.push(elementId); continue; }
      const current = registry?.describe?.(node);
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const rendered = registry?.isRendered ? registry.isRendered(node) : style.display !== 'none';
      const actionable = !requireActionable || (!current?.states.disabled && !node.matches(':disabled') && !node.closest('[inert],[aria-disabled="true"],[data-disabled]:not([data-disabled="false"])'));
      if (!rendered || style.visibility === 'hidden' || style.visibility === 'collapse' || Number.parseFloat(style.opacity) < 0.1 || rect.width < 1 || rect.height < 1 || !actionable) {
        invalidElementIds.push(elementId);
        continue;
      }
      validElementIds.push(elementId);
      if (current) semantics.push({ elementId, semantics: current });
    } catch (error) {
      invalidElementIds.push(elementId);
      let message = 'Unserializable reference validation error';
      try { message = (error instanceof Error ? error.message : String(error)).slice(0, 300); } catch { /* Keep the fallback. */ }
      errors.push({ elementId, message });
    }
  }
  return {
    fingerprint: registry?.fingerprint() ?? '',
    semantics: registry?.describe ? semantics : undefined,
    valid: !!registry && invalidElementIds.length === 0,
    validElementIds,
    invalidElementIds,
    ...(errors.length ? { errors } : {}),
  };
}
