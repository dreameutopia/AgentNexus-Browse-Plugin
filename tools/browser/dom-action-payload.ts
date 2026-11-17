import type { ReferenceDocument } from '../automation/shared/element-reference';

/**
 * browser_interact 共用注入荷载
 *
 * ⚠️ 注入约束：`chrome.scripting.executeScript({ func })` 会把函数源码序列化后
 * 注入页面执行，闭包与模块作用域不会随之带入。因此 `domActionPayload`
 * 必须完全自包含（只引用自身参数、嵌套声明与页面全局对象）；调用方只能直接
 * 传本函数引用 + 显式 args，不能用 .bind / 箭头包装代理。
 *
 * 共享前奏：
 *   渲染检查 → 屏幕外先滚动到视口中央并等两帧重查 → 遮挡检查 → 分派操作。
 * 之后按 action 分支：
 *   - 'click'：Pointer/Mouse down/up → click()，每步复核节点；
 *   - 'fill' ：focus → 按 contenteditable / select / input|textarea 分路填充 → blur。
 *   - 状态操作：先读取期望状态，必要时通过事件交互，再核对；不自动重放。
 */

/** 支持的操作 */
export type DomAction =
  'click' | 'fill' | 'set_checked' | 'set_expanded' | 'set_selected' | 'select';

export interface SemanticActionOptions {
  checked?: boolean;
  expanded?: boolean;
  selected?: boolean;
  values?: string[];
}

/** 荷载返回形态（宿主据此转为 ToolResult） */
export interface DomActionResult {
  success?: boolean;
  message?: string;
  error?: string;
  /** 仅 fill：填充后的最终文本（供宿主核对） */
  finalValue?: string | null;
  state?: Record<string, unknown>;
  changed?: boolean;
  outcome?: 'state_verified' | 'not_dispatched' | 'unknown';
  errorCode?: string;
  phase?: string;
  /**
   * 状态宿主（控件本体）的引用——当上报元素只是可见表面时，说明状态住在谁身上。
   */
  controlElementId?: string;
  /** 勾选前后观测到的状态（诊断用：让模型判断是「没点上」还是「点上了被回滚」） */
  observedBefore?: boolean | 'mixed' | null;
  observedAfter?: boolean | 'mixed' | null;
  /** 控件未暴露状态时，列出可用的候选信号 */
  stateCandidates?: {
    ariaChecked?: string | null;
    nativeChecked?: boolean;
    dataState?: string | null;
    classNames?: string[];
  };
  /** 给模型的下一步建议 */
  suggestedAction?: string;
  /** 仅 fill：VALUE_MISMATCH 时的期望值（错误文案里有截断版，这里是完整体） */
  expectedValue?: string;
  /** 仅 fill：VALUE_MISMATCH 时页面实际接受的值 */
  actualValue?: string;
  /** 部分几何重叠被放行时随成功结果附带的遮挡说明（浮层/高覆盖仍会拦） */
  obstruction?: {
    element: string;
    coveragePercent: number;
    note: string;
  };
}

export async function domActionPayload(
  action: DomAction,
  elementId: string,
  value?: string,
  options: SemanticActionOptions = {},
): Promise<DomActionResult> {
  let phase = 'resolve';
  let effectsStarted = false;
  const reject = (error: string): DomActionResult => ({
    error, outcome: effectsStarted ? 'unknown' : 'not_dispatched',
    errorCode: error.match(/^([A-Z][A-Z0-9_]+)[:：]/)?.[1] || 'DOM_PRECONDITION_FAILED', phase,
  });
  const shadowOf = (el: Element): ShadowRoot | null => {
    try {
      return (
        el.shadowRoot ||
        (globalThis as any).chrome?.dom?.openOrClosedShadowRoot?.(el) ||
        null
      );
    } catch {
      return el.shadowRoot;
    }
  };
  /**
   * 元素是否已渲染（不依赖视口，避免把屏幕外元素误判为不可见）
   */
  function isRendered(element: Element): boolean {
    const runtime = (document as ReferenceDocument).__agentNexusReferences;
    if (runtime?.isRendered) return runtime.isRendered(element);
    if (!element.isConnected) return false;
    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      parseFloat(style.opacity) < 0.1
    ) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      return false;
    }
    // getClientRects 为空 = 未渲染；比 offsetParent 可靠（position:fixed 元素的 offsetParent 为 null，会被误判）
    return element.getClientRects().length > 0;
  }

  /**
   * 元素中心点是否位于视口内（elementFromPoint 仅在视口内有效）
   */
  function isCenterInViewport(element: Element): boolean {
    const rect = element.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return (
      cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight
    );
  }

  /**
   * 中心点命中的遮挡信息；未被遮挡返回 null。
   *
   * 分级判定（与「真实用户能否点到」对齐）：
   *   - overlay（浮层/遮罩：fixed、absolute+高 z-index、dialog/popover/mask 类
   *     容器）→ 无论覆盖率都拦——真实用户隔着弹窗点不到下层；
   *   - 几何重叠但覆盖率 < 60% → **放行**（用户可以点未遮挡的部分），并在
   *     成功结果里附带 obstruction 说明；≥ 60% → 拦（中心区基本被占）。
   * 旧策略「中心点被任何东西碰到就拦」把同表单相邻控件的轻微重叠当弹窗，
   * 是实测里一个按钮卡死十几轮调用的直接原因。
   */
  function getObstruction(
    element: Element,
  ): { element: Element; coverage: number; overlay: boolean } | null {
    const rect = element.getBoundingClientRect();
    const x =
      (Math.max(0, rect.left) + Math.min(window.innerWidth, rect.right)) / 2;
    const y =
      (Math.max(0, rect.top) + Math.min(window.innerHeight, rect.bottom)) / 2;
    let hit = document.elementFromPoint(x, y);
    const visited = new Set<Element>();
    while (hit && shadowOf(hit)?.elementFromPoint) {
      if (visited.has(hit) || visited.size >= 256) throw new Error('HIT_TEST_FAILED：Shadow DOM 命中测试出现循环或层级超限，未继续派发操作');
      visited.add(hit);
      const inner = shadowOf(hit)!.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    const root = element.getRootNode() as ShadowRoot;
    if (root.host && hit === root.host && !root.elementFromPoint) return null;
    if (!hit) return null;
    if (hit === element || element.contains(hit)) return null;
    // 覆盖率：遮挡物矩形与目标矩形的交集面积 / 目标面积
    const hRect = hit.getBoundingClientRect();
    const w = Math.max(
      0,
      Math.min(rect.right, hRect.right) - Math.max(rect.left, hRect.left),
    );
    const h = Math.max(
      0,
      Math.min(rect.bottom, hRect.bottom) - Math.max(rect.top, hRect.top),
    );
    const coverage =
      rect.width * rect.height > 0
        ? Math.min(1, (w * h) / (rect.width * rect.height))
        : 1;
    let overlay = false;
    try {
      const style = getComputedStyle(hit);
      const z = parseInt(style.zIndex || '', 10);
      overlay =
        style.position === 'fixed' ||
        (style.position === 'absolute' && Number.isFinite(z) && z >= 10);
      if (!overlay)
        overlay = !!hit.closest(
          '[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog,[popover],[class*="overlay" i],[class*="modal" i],[class*="mask" i],[class*="backdrop" i],[class*="popup" i]',
        );
    } catch {
      overlay = false;
    }
    return { element: hit, coverage, overlay };
  }
  const blocksClick = (o: NonNullable<ReturnType<typeof getObstruction>>) =>
    o.overlay || o.coverage >= 0.6;
  const obstructionMessage = (
    o: NonNullable<ReturnType<typeof getObstruction>>,
  ): string => {
    const desc = describeElement(o.element).slice(0, 160);
    const pct = Math.round(o.coverage * 100);
    return o.overlay
      ? `OBSCURED：目标被浮层/遮罩 <${desc}> 挡住（覆盖中心点，约 ${pct}% 面积）。先关闭浮层（Escape 或其关闭按钮），再重新观察重试。`
      : `OBSCURED：目标与 <${desc}> 几何重叠（约 ${pct}% 面积，非浮层）。通常是同记录相邻控件或粘性元素——先 browser_interact(action="scroll") 调整布局再重试，或改对可见子元素/包装器操作。`;
  };

  function describeElement(el: Element): string {
    const id = el.id ? `#${el.id}` : '';
    const cls =
      typeof el.className === 'string' && el.className.trim()
        ? `.${el.className.trim().split(/\s+/)[0]}`
        : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  }

  /**
   * 引用失效的精确分类。
   *
   * 早期实现把五种完全不同的原因压成一句「元素已失效、被替换或语义已改变」，
   * 模型无法区分「重新观察就能修」与「这个页面不可靠」，于是只能反复重试或
   * 改写脚本。分类的价值在于**给出不同的下一步**。
   */
  const stale = (reason?: string): DomActionResult => {
    const detail =
      reason ??
      '元素已失效、被替换或语义已改变。请重新调用 browser_observe 获取 ElementId 与 FrameId；不要猜测 CSS 或尝试其他 frame。';
    return {
      outcome: effectsStarted ? 'unknown' : 'not_dispatched',
      errorCode: 'STALE_ELEMENT',
      phase,
      error: `STALE_ELEMENT：${detail}`,
    };
  };

  /** 失效原因 → 精确错误码与可执行的下一步。 */
  const staleFor = (
    reason:
      | 'NOT_FOUND'
      | 'EXPIRED'
      | 'DOCUMENT_CHANGED'
      | 'DISCONNECTED'
      | 'IDENTITY_DRIFT'
      | 'CONTEXT_CHANGED',
  ): DomActionResult => {
    const guidance: Record<string, string> = {
      NOT_FOUND:
        '引用已不存在（可能来自另一次扫描或已被清理）。请重新调用 browser_observe 获取新的 ElementId 与 FrameId。',
      EXPIRED:
        '引用已超过有效期。请重新调用 browser_observe 获取新的 ElementId 与 FrameId（不要复用旧引用）。',
      DOCUMENT_CHANGED:
        '页面已发生导航/换页，原引用属于旧文档。请在新页面重新调用 browser_observe。',
      DISCONNECTED:
        '节点已从文档中移除（页面重渲染替换了它）。请重新调用 browser_observe；本次操作可能已部分生效，先观察现状。',
      IDENTITY_DRIFT:
        '目标元素的自身属性或文字已改变，它可能已不是原先那个控件。请重新调用 browser_observe 并核对目标。',
      CONTEXT_CHANGED:
        '目标所属的记录/行已被复用（虚拟列表典型场景），旧引用已失效。请重新调用 browser_observe。',
    };
    return {
      outcome: effectsStarted ? 'unknown' : 'not_dispatched',
      errorCode: 'STALE_ELEMENT',
      phase,
      error: `STALE_ELEMENT：${guidance[reason]}`,
    };
  };

  try {
    const registry = (document as ReferenceDocument).__agentNexusReferences;
    /**
     * 解析引用并保留失效原因。
     *
     * 用 resolveDetailed 而不是 resolve：后者只给「null」，模型无法判断该
     * 重新观察还是换策略。有了原因就能给出精确的下一步。
     */
    const resolveWithReason = (
      id: string,
    ): { element: Element | null; reason: string | null } => {
      const detailed = registry?.resolveDetailed?.(id);
      if (detailed) {
        return { element: detailed.element, reason: detailed.reason };
      }
      const element = registry?.resolve(id) ?? null;
      return { element, reason: element ? null : 'NOT_FOUND' };
    };
    const resolved = resolveWithReason(elementId);
    /**
     * 当前操作目标。
     *
     * 非空类型是刻意的：解析失败已在上面提前返回；此后 element 只会被**重新
     * 赋值**（滚动后重取、重绑定到等价节点），不会变成 null——重绑定失败走
     * 独立的错误返回路径。用非空类型避免在闭包里反复做空值断言。
     */
    let element = resolved.element as
      HTMLElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (!element) {
      return staleFor(
        (resolved.reason as
          | 'NOT_FOUND'
          | 'EXPIRED'
          | 'DOCUMENT_CHANGED'
          | 'DISCONNECTED'
          | 'IDENTITY_DRIFT'
          | 'CONTEXT_CHANGED') ?? 'NOT_FOUND',
      );
    }
    /** 已通过非空校验的稳定别名（element 会在滚动/重绑定路径上被重新赋值）。 */
    const target = element;
    if (!isRendered(element)) {
      return {
        ...reject(`NOT_RENDERED：Element "${elementId}" exists but is not rendered (display:none or zero size).`),
      };
    }

    // 屏幕外元素：先滚动到视口中央，再做遮挡检查与操作
    if (!isCenterInViewport(element)) {
      phase = 'scroll'; effectsStarted = true;
      element.scrollIntoView({
        behavior: 'instant',
        block: 'center',
        inline: 'center',
      });
      // 等两帧，让滚动与可能的懒加载渲染完成
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 250);
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(() => {
            clearTimeout(timeout);
            resolve();
          }),
        );
      });
      // 滚动可能触发重渲染替换节点，重新核验原节点引用
      const refreshed = registry?.resolve(elementId) as typeof element;
      if (!refreshed) {
        return {
          error: `Element "${elementId}" disappeared after scrolling (page re-rendered). Re-fetch elements and retry.`,
        };
      }
      element = refreshed;
      if (!isRendered(element)) {
        return {
          error: `Element "${elementId}" is not rendered after scrolling.`,
        };
      }
    }

    if (registry?.resolve(elementId) !== element) return stale();
    if (
      registry?.describe?.(element)?.states?.disabled ||
      element.matches(':disabled') ||
      element.closest(
        '[inert],[aria-disabled="true"],[data-disabled]:not([data-disabled="false"])',
      )
    ) {
      return reject('NOT_ACTIONABLE：元素已禁用或处于 inert 容器中。');
    }
    const obstruction = getObstruction(element);
    /** 部分几何重叠（已放行）的说明——附在成功结果里，模型可分析但不被拦 */
    const partialObstruction =
      obstruction && !blocksClick(obstruction)
        ? {
            obstruction: {
              element: describeElement(obstruction.element).slice(0, 160),
              coveragePercent: Math.round(obstruction.coverage * 100),
              note: '中心点被部分遮挡（非浮层），按真实用户可达性放行',
            },
          }
        : null;
    if (obstruction && blocksClick(obstruction)) {
      return {
        ...reject(obstructionMessage(obstruction)),
      };
    }

    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
    /**
     * 读取目标状态。
     *
     * describe 可能不存在（冷启动注册表尚未升级）——必须整链可选，否则
     * `describe?.(el).states` 会在 describe 缺失时抛 TypeError，把
     * 「语义不可知」误报成「DOM 内部错误」。
     */
    const readBoolean = (
      kind: 'checked' | 'expanded' | 'selected',
    ): boolean | 'mixed' | null => {
      if (!element) return null;
      const states = registry?.describe?.(element)?.states;
      const state = kind === 'checked' ? states?.checked ?? states?.pressed : states?.[kind];
      return typeof state === 'boolean' || state === 'mixed' ? state : null;
    };
    // Set desired states through the widget's event handlers, never by forging ARIA attributes.
    if (['set_checked', 'set_expanded', 'set_selected'].includes(action)) {
      const kind =
        action === 'set_checked'
          ? 'checked'
          : action === 'set_expanded'
            ? 'expanded'
            : 'selected';
      const desired = options[kind];
      if (typeof desired !== 'boolean')
        return reject('INVALID_ARGUMENT：缺少布尔目标状态。');
      // describe 每次调用都会做语义推导（含 querySelector），只取一次
      const semantics = registry?.describe?.(element);
      const category = semantics?.category;
      if (kind !== 'expanded' && semantics?.states?.readonly)
        return reject('NOT_ACTIONABLE：控件为只读。');
      if (
        kind === 'checked' &&
        !['checkbox', 'radio', 'switch', 'toggle'].includes(category || '')
      )
        return reject('UNSUPPORTED_STATE：目标不是可勾选控件。');
      if (kind === 'checked' && category === 'radio' && !desired)
        return reject(
          'UNSUPPORTED_STATE：单选项不能单独取消，请选中同组另一项。',
        );
      const current = readBoolean(kind);
      if (current === null)
        return {
          ...reject(
            'UNOBSERVABLE_STATE：控件未暴露目标状态（既无 aria-checked 也无原生 checked）。' +
              '请改用 browser_interact(action="click") 后重新观察，或用 browser_observe(view="element") 读取其属性再判断。',
          ),
          stateCandidates: {
            ariaChecked: element.getAttribute('aria-checked'),
            nativeChecked:
              (element as HTMLInputElement).checked !== undefined
                ? (element as HTMLInputElement).checked
                : undefined,
            dataState: element.getAttribute('data-state'),
            classNames:
              typeof element.className === 'string'
                ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 8)
                : [],
          },
          suggestedAction: 'click_then_observe',
        };
      if (current === desired)
        return {
          success: true,
          changed: false,
          state: { [kind]: current },
          outcome: 'state_verified',
          ...(partialObstruction || {}),
        };
      if (kind === 'selected' && !desired &&
        ['option','tab','treeitem','gridcell','row'].includes(category || '') &&
        semantics?.states?.multiselectable !== true)
        return reject('UNSUPPORTED_STATE：未确认多选能力，不能单独取消单选项；请选中同组另一项。');
      /**
       * 状态宿主（控件本体）与写入目标。
       *
       * 自定义复选框的可见表面是 label/包装器，状态住在 input 上。**点 label 会
       * 双触发**：label 的激活行为把点击转发给控件，控件的 click 又冒泡回
       * label → label 的处理器被调两次 → toggle 净效果为零（已用 JSDOM 复现）。
       *
       * 因此写入必须作用在**只触发一次**的节点上：
       *   - 控件是原生 input → 直接对它 click()：事件冒泡到 label 恰好一次，
       *     且 React 的受控 onChange 能收到；
       *   - 控件不可渲染（隐藏原生 input）→ 仍直接 click()，DOM 激活行为不依赖
       *     可见性，这正是「隐藏 input + 可见 label」的标准做法；
       *   - 没有独立控件 → 点可见元素自身（此时 label 转发是唯一路径）。
       */
      const control = registry?.controlOf?.(element) ?? element;
      const controlIsSeparate = control !== element;
      const readFrom = (target: Element): boolean | 'mixed' | null => {
        const states = registry?.describe?.(target)?.states;
        const state =
          kind === 'checked'
            ? states?.checked ?? states?.pressed
            : states?.[kind];
        return typeof state === 'boolean' || state === 'mixed' ? state : null;
      };
      const observedBefore = readFrom(control) ?? current;
      const controlElementId = controlIsSeparate
        ? semantics?.controlElementId
        : undefined;
      let result: DomActionResult;
      if (controlIsSeparate) {
        // 直接对控件派发一次激活：冒泡到 label 时处理器只被调用一次。
        try {
          (control as HTMLElement).click();
          result = { success: true };
        } catch (error) {
          result = {
            error: `CLICK_FAILED：控件激活失败：${String(
              (error as Error)?.message || error,
            ).slice(0, 200)}`,
            outcome: 'unknown',
            errorCode: 'CLICK_FAILED',
          };
        }
      } else {
        result = await domActionPayload('click', elementId);
      }
      await settle();
      // 回读同样以控件为准（控件可能已被框架换掉）
      const afterElement = registry?.controlOf?.(element) ?? element;
      const observedAfter = readFrom(afterElement) ?? readFrom(element) ?? observedBefore;
      /**
       * 类别守卫：交互过程中控件换了角色/类别（如 role=checkbox 变成 button），
       * 说明这个节点已经不是刚才那个控件——此时读到的状态属于**另一个**语义，
       * 不能拿它当「勾选成功」的证据。
       */
      const categoryAfter = registry?.describe?.(element)?.category;
      const categoryChanged = categoryAfter !== category;
      if (!result.success) {
        return {
          ...result,
          observedBefore,
          observedAfter,
          ...(controlElementId ? { controlElementId } : {}),
        };
      }
      if (
        observedAfter !== desired ||
        !element.isConnected ||
        categoryChanged
      ) {
        return {
          error:
            (categoryChanged
              ? 'STATE_UNVERIFIED：交互过程中控件语义已改变（角色/类别不再是可勾选控件），读到的状态不能作为勾选成功的证据。'
              : 'STATE_UNVERIFIED：已派发勾选但状态未变为目标值（可能被框架回滚，或组件不响应合成点击）。') +
            '请改用 browser_interact(action="click", trusted=true) 派发可信事件后重新观察。',
          outcome: 'unknown',
          errorCode: 'STATE_UNVERIFIED',
          observedBefore,
          observedAfter,
          ...(controlElementId ? { controlElementId } : {}),
        };
      }
      return {
        success: true,
        changed: true,
        state: { [kind]: desired },
        outcome: 'state_verified',
        ...(controlElementId ? { controlElementId } : {}),
        ...(partialObstruction || {}),
      };
    }

    if (action === 'select') {
      if (registry?.describe?.(element)?.states?.readonly)
        return reject('NOT_ACTIONABLE：控件为只读。');
      const values = options.values;
      if (
        !Array.isArray(values) ||
        values.length > 100 ||
        values.some((v) => typeof v !== 'string' || v.length > 2000) ||
        new Set(values).size !== values.length
      )
        return reject(
          'INVALID_ARGUMENT：values 必须是最多100项、无重复的字符串数组。',
        );
      if (element.localName === 'select') {
        const select = element as HTMLSelectElement;
        if (!select.multiple && values.length !== 1)
          return reject('INVALID_ARGUMENT：单选 select 必须恰好指定一个选项。');
        const enabled = Array.from(select.options).filter(
          (o) => !o.disabled && !o.closest('optgroup[disabled]'),
        );
        const chosen: HTMLOptionElement[] = [];
        for (const value of values) {
          const exact = enabled.filter((o) => o.value === value);
          const matches = exact.length
            ? exact
            : enabled.filter((o) => o.text.trim() === value.trim());
          if (matches.length !== 1)
            return reject(
              matches.length
                ? 'AMBIGUOUS_OPTION：匹配多个选项，请消歧。'
                : 'OPTION_NOT_FOUND：没有匹配的可用选项。',
            );
          chosen.push(matches[0]);
        }
        if (new Set(chosen).size !== chosen.length)
          return reject('INVALID_ARGUMENT：多个值指向同一选项。');
        const before = Array.from(select.selectedOptions);
        const wasMultiple = select.multiple;
        if (
          before.length === chosen.length &&
          before.every((o) => chosen.includes(o))
        )
          return {
            success: true,
            changed: false,
            state: { selectedValues: before.map((o) => o.value) },
            outcome: 'state_verified',
          };
        phase = 'focus'; effectsStarted = true; select.focus();
        if (registry?.resolve(elementId) !== element) return stale();
        if (registry?.describe?.(element)?.states?.disabled || registry?.describe?.(element)?.states?.readonly)
          return reject('NOT_ACTIONABLE：聚焦后控件变为禁用或只读。');
        if (
          select.multiple !== wasMultiple ||
          chosen.some(
            (option) =>
              !select.contains(option) ||
              option.disabled ||
              option.closest('optgroup[disabled]'),
          )
        )
          return reject(
            'OPTIONS_CHANGED：聚焦期间选项或多选模式变化，请重新观察。',
          );
        registry!.invalidate();
        // Replacement semantics are explicit, including [] to clear a multiple select.
        phase = 'select';
        for (const option of Array.from(select.options))
          option.selected = chosen.includes(option);
        select.dispatchEvent(
          new Event('input', { bubbles: true, composed: true }),
        );
        select.dispatchEvent(
          new Event('change', { bubbles: true, composed: true }),
        );
        await settle();
        const selected = Array.from(select.selectedOptions);
        if (
          !select.isConnected ||
          select.multiple !== wasMultiple ||
          chosen.some(
            (option) =>
              option.parentElement === null || !select.contains(option),
          ) ||
          selected.length !== chosen.length ||
          !selected.every((o) => chosen.includes(o))
        )
          return {
            error:
              'STATE_UNVERIFIED：选择后节点被替换或选中集合不一致，请重新观察。',
            outcome: 'unknown',
          };
        return {
          success: true,
          changed: true,
          state: { selectedValues: selected.map((o) => o.value) },
          outcome: 'state_verified',
        };
      }
      if (values.length !== 1)
        return reject(
          'UNSUPPORTED_SELECTION：自定义列表每次只处理一个选项；多选请对每个 option 使用 set_selected/set_checked 并重采。',
        );
      const role = element.getAttribute('role');
      if (!['combobox', 'listbox', 'menu', 'tree'].includes(role || ''))
        return reject(
          'UNSUPPORTED_SELECTION：需要原生 select 或明确的列表/组合框引用。',
        );
      const root = element.getRootNode() as Document | ShadowRoot;
      const scopes: Element[] = role === 'combobox' ? [] : [element];
      for (const attr of ['aria-controls', 'aria-owns'])
        for (const id of (element.getAttribute(attr) || '')
          .split(/\s+/)
          .filter(Boolean)) {
          const linked = root.querySelectorAll('#' + CSS.escape(id));
          if (linked.length > 1) return reject('AMBIGUOUS_RELATION：列表关联 ID 重复，请通过明确的列表引用操作。');
          const target = linked[0];
          if (target && !scopes.includes(target)) scopes.push(target);
        }
      if (!scopes.length)
        return reject(
          'NEEDS_EXPANSION：先展开并重采；缺少明确关联列表，不会全页猜测选项。',
        );
      const candidates = [
        ...new Set(
          scopes.flatMap((scope) => [
            ...(scope.matches('[role="option"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="treeitem"]') ? [scope] : []),
            ...Array.from(scope.querySelectorAll(
                '[role="option"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="treeitem"]',
              )),
          ]),
        ),
      ].filter(
        (node) =>
          isRendered(node) &&
          (scopes.includes(node) || scopes.includes(node.closest('[role="listbox"],[role="menu"],[role="tree"]') as Element)) &&
          !registry?.describe?.(node)?.states?.disabled &&
          !node.matches(':disabled') &&
          !node.closest(
            '[inert],[aria-disabled="true"],[data-disabled]:not([data-disabled="false"])',
          ),
      );
      const value = values[0];
      const exact = candidates.filter(
        (node) =>
          node.getAttribute('data-value') === value ||
          node.getAttribute('value') === value,
      );
      const matches = exact.length
        ? exact
        : candidates.filter(
            (node) =>
              (node.getAttribute('aria-label') || node.textContent || '')
                .trim()
                .replace(/\s+/g, ' ') === value.trim(),
          );
      if (matches.length !== 1)
        return reject(
          matches.length
            ? 'AMBIGUOUS_OPTION：关联列表中存在同名项，请改用具体 option 引用。'
            : 'OPTION_NOT_FOUND：当前已渲染的关联列表没有该项；搜索或滚动后重采。',
        );
      const option = matches[0];
      // Use an observed option's state setter; unobservable options require explicit click + observation.
      const checked = ['checkbox', 'radio', 'switch'].includes(
        registry?.describe?.(option)?.category || '',
      );
      if (
        !checked &&
        registry?.describe?.(option)?.states?.selected === undefined
      )
        return reject(
          'UNOBSERVABLE_STATE：选项没有选中状态，请对 option 使用 click 后核对控件值。',
        );
      const ownerValue = () =>
        String(
          ['input', 'textarea', 'select'].includes(target.localName)
            ? (target as HTMLInputElement).value
            : target.textContent || '',
        )
          .trim()
          .replace(/\s+/g, ' ');
      const beforeOwnerValue = ownerValue();
      const optionLabel = (
        option.getAttribute('aria-label') ||
        option.textContent ||
        ''
      )
        .trim()
        .replace(/\s+/g, ' ');
      const optionValue =
        option.getAttribute('data-value') ?? option.getAttribute('value');
      const result = await domActionPayload(
        checked ? 'set_checked' : 'set_selected',
        registry!.register(option),
        undefined,
        checked ? { checked: true } : { selected: true },
      );
      // Portal content often unmounts immediately after selection. A changed,
      // exact owner value can independently verify a single combobox selection.
      if (
        !result.success &&
        role === 'combobox' &&
        !option.isConnected &&
        element.isConnected &&
        !scopes.some(
          (scope) => scope.getAttribute('aria-multiselectable') === 'true',
        ) &&
        registry?.describe?.(element)?.category === 'combobox'
      ) {
        const currentValue = ownerValue();
        if (
          currentValue !== beforeOwnerValue &&
          (currentValue === optionLabel ||
            (optionValue !== null && currentValue === optionValue))
        )
          return {
            success: true,
            changed: true,
            state: { value: currentValue, verification: 'owner_value' },
            outcome: 'state_verified',
          };
      }
      return result;
    }

    // ══════════ 分支：点击 ══════════
    if (action === 'click') {
      phase = 'pointer'; effectsStarted = true;
      // 模拟一系列更真实的鼠标事件，以兼容现代JS框架
      const dispatchMouseEvent = (type: string) => {
        const event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          button: 0,
          buttons: type === 'mousedown' ? 1 : 0,
        });
        return element.dispatchEvent(event);
      };
      const dispatchPointerEvent = (type: string) => {
        if (typeof window.PointerEvent !== 'function') return true;
        return element.dispatchEvent(
          new window.PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
            button: 0,
            buttons: type === 'pointerdown' ? 1 : 0,
          }),
        );
      };

      /**
       * 重绑定：框架在 mousedown 后重建 DOM 时，把操作落到**唯一等价**的新节点上。
       *
       * 早期实现在每个事件后都做 `resolve(elementId) !== element` 校验，一旦
       * 应用重建了节点就直接放弃——用户看到的是「点了没反应」，且工具报
       * 「元素已失效」。改为：事件序列照常派发，关键节点若已被替换，
       * 尝试重绑定到唯一等价节点；无法唯一确定时按**精确原因**报错。
       */
      const rebindIfReplaced = ():
        | { ok: true }
        | {
            ok: false;
            reason:
              | 'NOT_FOUND'
              | 'EXPIRED'
              | 'DOCUMENT_CHANGED'
              | 'DISCONNECTED'
              | 'IDENTITY_DRIFT'
              | 'CONTEXT_CHANGED';
          } => {
        const detailed = registry?.resolveDetailed
          ? registry.resolveDetailed(elementId)
          : { element: registry?.resolve(elementId) ?? null, reason: null, contextChanged: false };
        if (detailed.element === element) return { ok: true };
        const replacement = registry?.rebind?.(elementId) ?? null;
        if (replacement) {
          element = replacement as typeof element;
          return { ok: true };
        }
        return {
          ok: false,
          reason: (detailed.reason as
            | 'NOT_FOUND'
            | 'EXPIRED'
            | 'DOCUMENT_CHANGED'
            | 'DISCONNECTED'
            | 'IDENTITY_DRIFT'
            | 'CONTEXT_CHANGED') ?? 'DISCONNECTED',
        };
      };

      registry!.invalidate(); // Even a pointer/mousedown handler may mutate the application.
      dispatchPointerEvent('pointerover');
      dispatchMouseEvent('mouseover');
      const compatibilityMouse = dispatchPointerEvent('pointerdown');
      if (compatibilityMouse) dispatchMouseEvent('mousedown');
      // mousedown 之后应用可能已重建节点——此时重绑定到等价节点再继续，
      // 而不是把「我自己引发的重渲染」当成目标失效。
      {
        const rebound = rebindIfReplaced();
        if (!rebound.ok) return staleFor(rebound.reason);
      }
      if (
        !isRendered(element) ||
        registry?.describe?.(element)?.states?.disabled ||
        element.matches(':disabled') ||
        element.closest(
          '[inert],[aria-disabled="true"],[data-disabled]:not([data-disabled="false"])',
        ) ||
        (function () {
          // 与入口同一套分级：mousedown 后新出现的部分重叠不否决（应用自己
          // 渲染的悬浮提示/相邻扩展会撞上旧策略），浮层或高覆盖才拦
          const mid = getObstruction(element);
          return !!mid && blocksClick(mid);
        })()
      ) {
        return {
          error:
            'NOT_ACTIONABLE：鼠标事件后目标隐藏、禁用或被浮层遮挡，请重新采集并核对页面。',
        };
      }

      // 执行核心的 click() 方法
      dispatchPointerEvent('pointerup');
      if (compatibilityMouse) dispatchMouseEvent('mouseup');
      {
        const rebound = rebindIfReplaced();
        if (!rebound.ok) return staleFor(rebound.reason);
      }
      if (typeof element.click === 'function') element.click();
      else dispatchMouseEvent('click');

      dispatchPointerEvent('pointerout');
      dispatchMouseEvent('mouseout');

      return {
        success: true,
        message: `Click dispatched; verify the expected page change. ElementId: "${elementId}"`,
        ...(partialObstruction || {}),
      };
    }

    // ══════════ 分支：填充 ══════════
    if (action !== 'fill') return reject('INVALID_ARGUMENT：未知 DOM action。');
    if (registry?.describe?.(element)?.patterns?.includes('date-segment'))
      return reject('UNSUPPORTED_FILL：分段日期字段使用 focus/keys/type，不能整体覆盖其 DOM。');
    if (!element.isContentEditable && !['input','textarea','select'].includes(element.localName))
      return reject('UNSUPPORTED_FILL：目标不是原生输入或 contenteditable；自定义值控件使用 keys/type 后核对。');
    if (
      element.localName === 'input' &&
      [
        'checkbox',
        'radio',
        'file',
        'button',
        'submit',
        'reset',
        'image',
        'hidden',
      ].includes((element as HTMLInputElement).type)
    )
      return reject(
        'UNSUPPORTED_FILL：勾选控件使用 set_checked；文件使用上传工具，按钮使用 click。',
      );
    if (
      element.localName === 'select' &&
      (element as HTMLSelectElement).multiple
    )
      return reject(
        'UNSUPPORTED_FILL：多选 select 使用 select + values，明确替换整个选中集合。',
      );
    if (element.localName === 'select') {
      const result = await domActionPayload('select', elementId, undefined, {
        values: [String(value ?? '')],
      });
      if (result.success) {
        const selectedValue = (element as HTMLSelectElement).value;
        element.blur();
        await settle();
        if (
          !element.isConnected ||
          (element as HTMLSelectElement).value !== selectedValue
        )
          return {
            error: 'UNVERIFIED_FILL：失焦后选择发生变化，请重新观察。',
            outcome: 'unknown',
          };
        if (!(element as HTMLSelectElement).validity.valid)
          return {
            error:
              'CONSTRAINT_VIOLATION：选择未通过原生表单约束，请观察并修正。',
            outcome: 'unknown',
          };
      }
      return {
        ...result,
        finalValue: result.success
          ? (element as HTMLSelectElement).value
          : undefined,
      };
    }
    const text = typeof value === 'string' ? value : String(value ?? '');
    const expectedValue = text;

    // 聚焦是所有操作的前提
    if (
      registry?.describe?.(element)?.states?.readonly ||
      element.matches('[readonly], [aria-readonly="true"]')
    )
      return reject('NOT_ACTIONABLE：输入框为只读。');
    phase = 'focus'; effectsStarted = true; element.focus();
    if (registry?.resolve(elementId) !== element) return stale();
    if (registry?.describe?.(element)?.states?.disabled || registry?.describe?.(element)?.states?.readonly)
      return reject('NOT_ACTIONABLE：聚焦后控件变为禁用或只读。');
    registry!.invalidate();
    phase = 'fill';

    if ('isContentEditable' in element && element.isContentEditable) {
      // 1. 对于 contenteditable 元素 (如高级文本编辑器)
      // 使用 execCommand 模拟真实用户输入，以兼容现代JS框架
      element.textContent = ''; // 先清空
      let inserted = false;
      try {
        inserted = document.execCommand?.('insertText', false, text) ?? false;
      } catch {
        /* fall back to DOM input */
      }
      // execCommand 在部分环境（无用户激活 / 异形编辑器）会静默失败：
      // 失败或完全没有写入内容时回退为直接赋值并补发 input 事件，绝不谎报成功
      if (!inserted || (text !== '' && !element.textContent)) {
        element.textContent = text;
        element.dispatchEvent(
          new Event('input', { bubbles: true, composed: true }),
        );
      }
    } else if ('value' in element) {
      // 3. 对于标准的 <input> 和 <textarea>
      const inputElement = element as HTMLInputElement | HTMLTextAreaElement;
      const proto =
        element.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(inputElement, text);
      else inputElement.value = text;
      // 触发事件以确保框架能捕获到变化
      inputElement.dispatchEvent(
        new Event('input', { bubbles: true, composed: true }),
      );
      inputElement.dispatchEvent(
        new Event('change', { bubbles: true, composed: true }),
      );
    } else {
      return {
        error: `Element with elementId "${elementId}" is not a recognized fillable type.`,
      };
    }

    element.blur();
    // Let controlled inputs process events, then verify the actual value.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!element.isConnected)
      return {
        error:
          'UNVERIFIED_FILL：输入后节点被替换，请重新采集并核对页面值，勿盲目重试提交。',
      };
    const finalValue = element.isContentEditable
      ? element.textContent
      : String((element as HTMLInputElement).value ?? '');
    if (finalValue !== expectedValue) {
      // 期望/实际必须进错误文案：模型只读 error 字符串决策，光给笼统
      // 「未接受」会逼它盲试（实测日期控件上连错两轮到轮次耗尽）。
      const brief = (text: string): string =>
        JSON.stringify(text.length > 160 ? text.slice(0, 160) + '…' : text);
      const diagnosis =
        finalValue === ''
          ? '页面把输入清空了（失焦回滚 / 该段未激活 / 受控组件拒绝）——先点击目标控件或对应分段激活，再重填或改用 focus 后 type 逐段输入。'
          : '页面把值改写成了部分或格式化结果（掩码 / 分段输入 / 受控格式化）——按实际值反推格式约束；分段控件逐段输入，不要整串覆盖。';
      return {
        error: `VALUE_MISMATCH：页面未接受完整输入。期望=${brief(expectedValue)} 实际=${brief(finalValue)}。${diagnosis}`,
        errorCode: 'VALUE_MISMATCH',
        phase,
        outcome: 'unknown',
        expectedValue:
          expectedValue.length > 500
            ? expectedValue.slice(0, 500) + '…'
            : expectedValue,
        actualValue:
          finalValue.length > 500 ? finalValue.slice(0, 500) + '…' : finalValue,
      };
    }
    if ('validity' in element && !(element as HTMLInputElement).validity.valid)
      return {
        error:
          'CONSTRAINT_VIOLATION：值已写入但未通过 min/max/step/pattern/required 等约束，请观察并修正。',
        outcome: 'unknown',
      };

    return {
      success: true,
      message: 'Element filled successfully.',
      finalValue:
        'isContentEditable' in element && element.isContentEditable
          ? element.textContent
          : String((element as HTMLInputElement).value ?? ''),
      ...(partialObstruction || {}),
    };
  } catch (error) {
    let detail = 'unserializable thrown value';
    try { detail = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error); } catch { /* Coercion may itself throw. */ }
    return {
      error: `UNEXPECTED_DOM_ERROR：${action} 在 ${phase} 阶段失败：${detail.slice(0,2000)}`,
      errorCode:'UNEXPECTED_DOM_ERROR', phase, outcome:effectsStarted ? 'unknown' : 'not_dispatched',
    };
  }
}
