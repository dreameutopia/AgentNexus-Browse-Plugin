import type { ReferenceDocument } from '../automation/shared/element-reference';

/**
 * browser_interact 共用注入荷载
 *
 * ⚠️ 注入约束：`chrome.scripting.executeScript({ func })` 会把函数源码序列化后
 * 注入页面执行，闭包与模块作用域不会随之带入。因此 `domActionPayload`
 * 必须完全自包含（只引用自身参数、嵌套声明与页面全局对象）；调用方只能直接
 * 传本函数引用 + 显式 args，不能用 .bind / 箭头包装代理。
 *
 * 共享前奏（两种操作完全一致）：
 *   渲染检查 → 屏幕外先滚动到视口中央并等两帧重查 → 遮挡检查 → 分派操作。
 * 之后按 action 分支：
 *   - 'click'：mouseover → mousedown → click() → mouseup →mouseout（兼容现代框架）；
 *   - 'fill' ：focus → 按 contenteditable / select / input|textarea 分路填充 → blur。
 */

/** 支持的操作 */
export type DomAction = 'click' | 'fill';

/** 荷载返回形态（宿主据此转为 ToolResult） */
export interface DomActionResult {
  success?: boolean;
  message?: string;
  error?: string;
  /** 仅 fill：填充后的最终文本（供宿主核对） */
  finalValue?: string | null;
}

export async function domActionPayload(
  action: DomAction,
  elementId: string,
  value?: string
): Promise<DomActionResult> {
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
    error:
      'STALE_ELEMENT：元素已失效、被替换或语义已改变。请重新调用 browser_observe 获取 ElementId 与 FrameId；不要猜测 CSS 或尝试其他 frame。',
  });

  try {
    const registry = (document as ReferenceDocument).__agentNexusReferences;
    let element = registry?.resolve(elementId) as
      | HTMLElement
      | HTMLInputElement
      | HTMLTextAreaElement
      | HTMLSelectElement;
    if (!element) return stale();
    if (!isRendered(element)) {
      return {
        error: `Element "${elementId}" exists but is not rendered (display:none or zero size).`,
      };
    }

    // 屏幕外元素：先滚动到视口中央，再做遮挡检查与操作
    if (!isCenterInViewport(element)) {
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
          })
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
      element.matches(':disabled, [aria-disabled="true"]') ||
      element.closest('[inert]')
    ) {
      return { error: 'NOT_ACTIONABLE：元素已禁用或处于 inert 容器中。' };
    }
    const obstruction = getObstruction(element);
    if (obstruction) {
      return {
        error: `Element "${elementId}" is obscured by <${describeElement(obstruction)}> (likely a popup/overlay). Close it first, then retry.`,
      };
    }

    // ══════════ 分支：点击 ══════════
    if (action === 'click') {
      // 模拟一系列更真实的鼠标事件，以兼容现代JS框架
      const dispatchMouseEvent = (type: string) => {
        const event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
        });
        element.dispatchEvent(event);
      };

      dispatchMouseEvent('mouseover');
      if (registry?.resolve(elementId) !== element) return stale();
      dispatchMouseEvent('mousedown');
      if (registry?.resolve(elementId) !== element) return stale();
      if (
        !isRendered(element) ||
        element.matches(':disabled, [aria-disabled="true"]') ||
        element.closest('[inert]') ||
        getObstruction(element)
      ) {
        return {
          error:
            'NOT_ACTIONABLE：鼠标事件后目标隐藏、禁用或被遮挡，请重新采集并核对页面。',
        };
      }

      // 执行核心的 click() 方法
      registry!.invalidate();
      if (typeof element.click === 'function') element.click();
      else dispatchMouseEvent('click');

      dispatchMouseEvent('mouseup');
      dispatchMouseEvent('mouseout');

      return {
        success: true,
        message: `Click dispatched; verify the expected page change. ElementId: "${elementId}"`,
      };
    }

    // ══════════ 分支：填充 ══════════
    const text = typeof value === 'string' ? value : String(value ?? '');
    let expectedValue = text;

    // 聚焦是所有操作的前提
    if (element.matches('[readonly], [aria-readonly="true"]'))
      return { error: 'NOT_ACTIONABLE：输入框为只读。' };
    element.focus();
    if (registry?.resolve(elementId) !== element) return stale();
    registry!.invalidate();

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
          new Event('input', { bubbles: true, composed: true })
        );
      }
    } else if (element.tagName === 'SELECT') {
      // 2. 对于 <select> 下拉菜单
      const selectElement = element as HTMLSelectElement;
      const enabled = Array.from(selectElement.options).filter(
        (option) => !option.disabled && !option.closest('optgroup[disabled]')
      );
      const exact = enabled.filter((option) => option.value === text);
      const matches = exact.length
        ? exact
        : enabled.filter((option) => option.text.trim() === text.trim());
      if (!matches.length)
        return {
          error: 'No option with value or text matching "' + text + '" found.',
        };
      if (new Set(matches.map((option) => option.value)).size !== 1)
        return {
          error:
            'AMBIGUOUS_OPTION：选项文字重复，请按明确的 option value 填充。',
        };
      expectedValue = matches[0].value;
      selectElement.value = expectedValue;
      selectElement.dispatchEvent(
        new Event('input', { bubbles: true, composed: true })
      );
      selectElement.dispatchEvent(
        new Event('change', { bubbles: true, composed: true })
      );
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
      inputElement.dispatchEvent(new Event('input', { bubbles: true }));
      inputElement.dispatchEvent(new Event('change', { bubbles: true }));
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

    return {
      success: true,
      message: 'Element filled successfully.',
      finalValue:
        'isContentEditable' in element && element.isContentEditable
          ? element.textContent
          : String((element as HTMLInputElement).value ?? ''),
    };
  } catch (error) {
    return {
      error: `An unexpected error occurred while ${action === 'click' ? 'clicking' : 'filling'} the element: ${(error as Error).message}`,
    };
  }
}
