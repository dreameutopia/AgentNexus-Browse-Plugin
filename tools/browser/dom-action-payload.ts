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
   * 中心点命中的遮挡元素；未被遮挡返回 null
   */
  function getObstruction(element: Element): Element | null {
    const rect = element.getBoundingClientRect();
    const x =
      (Math.max(0, rect.left) + Math.min(window.innerWidth, rect.right)) / 2;
    const y =
      (Math.max(0, rect.top) + Math.min(window.innerHeight, rect.bottom)) / 2;
    let hit = document.elementFromPoint(x, y);
    while (hit && shadowOf(hit)?.elementFromPoint) {
      const inner = shadowOf(hit)!.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    const root = element.getRootNode() as ShadowRoot;
    if (root.host && hit === root.host && !root.elementFromPoint) return null;
    if (!hit) return null;
    if (hit === element || element.contains(hit)) return null;
    return hit;
  }

  function describeElement(el: Element): string {
    const id = el.id ? `#${el.id}` : '';
    const cls =
      typeof el.className === 'string' && el.className.trim()
        ? `.${el.className.trim().split(/\s+/)[0]}`
        : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  }

  const stale = (): DomActionResult => ({
    outcome: effectsStarted ? 'unknown' : 'not_dispatched',
    errorCode: 'STALE_ELEMENT', phase,
    error:
      'STALE_ELEMENT：元素已失效、被替换或语义已改变。请重新调用 browser_observe 获取 ElementId 与 FrameId；不要猜测 CSS 或尝试其他 frame。',
  });

  try {
    const registry = (document as ReferenceDocument).__agentNexusReferences;
    let element = registry?.resolve(elementId) as
      HTMLElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (!element) return stale();
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
      registry?.describe?.(element).states.disabled ||
      element.matches(':disabled') ||
      element.closest(
        '[inert],[aria-disabled="true"],[data-disabled]:not([data-disabled="false"])',
      )
    ) {
      return reject('NOT_ACTIONABLE：元素已禁用或处于 inert 容器中。');
    }
    const obstruction = getObstruction(element);
    if (obstruction) {
      return {
        ...reject(`OBSCURED：Element "${elementId}" is obscured by <${describeElement(obstruction).slice(0,160)}> (likely a popup/overlay). Close it first, then retry.`),
      };
    }

    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
    const readBoolean = (
      kind: 'checked' | 'expanded' | 'selected',
    ): boolean | 'mixed' | null => {
      const states = registry?.describe?.(element).states;
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
      const category = registry?.describe?.(element).category;
      if (kind !== 'expanded' && registry?.describe?.(element).states.readonly)
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
        return reject(
          'UNOBSERVABLE_STATE：控件未暴露目标状态；请使用 click/keys 后重新观察。',
        );
      if (current === desired)
        return {
          success: true,
          changed: false,
          state: { [kind]: current },
          outcome: 'state_verified',
        };
      if (kind === 'selected' && !desired &&
        ['option','tab','treeitem','gridcell','row'].includes(category || '') &&
        registry?.describe?.(element).states.multiselectable !== true)
        return reject('UNSUPPORTED_STATE：未确认多选能力，不能单独取消单选项；请选中同组另一项。');
      const result = await domActionPayload('click', elementId);
      await settle();
      if (
        !result.success &&
        (!element.isConnected ||
          readBoolean(kind) !== desired ||
          registry?.describe?.(element).category !== category)
      )
        return result;
      if (
        !element.isConnected ||
        readBoolean(kind) !== desired ||
        registry?.describe?.(element).category !== category
      )
        return {
          error:
            'STATE_UNVERIFIED：控件被替换或未接受目标状态，请重新观察，不自动重放。',
          outcome: 'unknown',
        };
      return {
        success: true,
        changed: true,
        state: { [kind]: desired },
        outcome: 'state_verified',
      };
    }

    if (action === 'select') {
      if (registry?.describe?.(element).states.readonly)
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
        if (registry?.describe?.(element).states.disabled || registry?.describe?.(element).states.readonly)
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
          !registry?.describe?.(node).states.disabled &&
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
        registry?.describe?.(option).category || '',
      );
      if (
        !checked &&
        registry?.describe?.(option).states.selected === undefined
      )
        return reject(
          'UNOBSERVABLE_STATE：选项没有选中状态，请对 option 使用 click 后核对控件值。',
        );
      const ownerValue = () =>
        String(
          ['input', 'textarea', 'select'].includes(element.localName)
            ? (element as HTMLInputElement).value
            : element.textContent || '',
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
        registry?.describe?.(element).category === 'combobox'
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

      registry!.invalidate(); // Even a pointer/mousedown handler may mutate the application.
      dispatchPointerEvent('pointerover');
      if (registry?.resolve(elementId) !== element) return stale();
      dispatchMouseEvent('mouseover');
      if (registry?.resolve(elementId) !== element) return stale();
      const compatibilityMouse = dispatchPointerEvent('pointerdown');
      if (registry?.resolve(elementId) !== element) return stale();
      if (compatibilityMouse) dispatchMouseEvent('mousedown');
      if (registry?.resolve(elementId) !== element) return stale();
      if (
        !isRendered(element) ||
        registry?.describe?.(element).states.disabled ||
        element.matches(':disabled') ||
        element.closest(
          '[inert],[aria-disabled="true"],[data-disabled]:not([data-disabled="false"])',
        ) ||
        getObstruction(element)
      ) {
        return {
          error:
            'NOT_ACTIONABLE：鼠标事件后目标隐藏、禁用或被遮挡，请重新采集并核对页面。',
        };
      }

      // 执行核心的 click() 方法
      dispatchPointerEvent('pointerup');
      if (registry?.resolve(elementId) !== element) return stale();
      if (compatibilityMouse) dispatchMouseEvent('mouseup');
      if (registry?.resolve(elementId) !== element) return stale();
      if (typeof element.click === 'function') element.click();
      else dispatchMouseEvent('click');

      dispatchPointerEvent('pointerout');
      dispatchMouseEvent('mouseout');

      return {
        success: true,
        message: `Click dispatched; verify the expected page change. ElementId: "${elementId}"`,
      };
    }

    // ══════════ 分支：填充 ══════════
    if (action !== 'fill') return reject('INVALID_ARGUMENT：未知 DOM action。');
    if (registry?.describe?.(element).patterns?.includes('date-segment'))
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
      registry?.describe?.(element).states.readonly ||
      element.matches('[readonly], [aria-readonly="true"]')
    )
      return reject('NOT_ACTIONABLE：输入框为只读。');
    phase = 'focus'; effectsStarted = true; element.focus();
    if (registry?.resolve(elementId) !== element) return stale();
    if (registry?.describe?.(element).states.disabled || registry?.describe?.(element).states.readonly)
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
      return {
        error:
          'VALUE_MISMATCH：页面未接受完整输入，请检查控件格式约束或自定义编辑器。',
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
