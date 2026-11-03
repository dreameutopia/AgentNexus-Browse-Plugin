/**
 * enhance_click / enhance_fill 共用注入荷载
 *
 * ⚠️ 注入约束：`chrome.scripting.executeScript({ func })` 会把函数源码序列化后
 * 注入页面执行，闭包与模块作用域不会随之带入。因此 `enhanceActionPayload`
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
export type EnhanceAction = 'click' | 'fill';

/** 荷载返回形态（宿主据此转为 ToolResult） */
export interface EnhancePayloadResult {
  success?: boolean;
  message?: string;
  error?: string;
  /** 仅 fill：填充后的最终文本（供宿主核对） */
  finalValue?: string | null;
}

export async function enhanceActionPayload(
  action: EnhanceAction,
  selector: string,
  value?: string,
): Promise<EnhancePayloadResult> {
  /**
   * 元素是否已渲染（不依赖视口，避免把屏幕外元素误判为不可见）
   */
  function isRendered(element: Element): boolean {
    if (!element.isConnected) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.1) {
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
    return cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight;
  }

  /**
   * 中心点命中的遮挡元素；未被遮挡返回 null
   */
  function getObstruction(element: Element): Element | null {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!hit) return null;
    if (hit === element || element.contains(hit)) return null;
    return hit;
  }

  function describeElement(el: Element): string {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? `.${el.className.trim().split(/\s+/)[0]}`
      : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  }

  /** 元素未命中时的可操作提示（iframe 场景是最常见的误用） */
  function notFoundError(): string {
    return `Element with selector "${selector}" not found in this frame. ` +
      `若元素位于 iframe 内，请传入 interactive_*_getter 结果中的 FrameId（主页面为 0）后重试。`;
  }

  // 荷载函数的执行入口
  try {
    // 断言非空仅为收窄类型；下方仍有运行期判空（querySelector 可能返回 null）
    let element = document.querySelector(selector) as HTMLElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

    if (!element) {
      return { error: notFoundError() };
    }
    if (!isRendered(element)) {
      return { error: `Element "${selector}" exists but is not rendered (display:none or zero size).` };
    }

    // 屏幕外元素：先滚动到视口中央，再做遮挡检查与操作
    if (!isCenterInViewport(element)) {
      element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      // 等两帧，让滚动与可能的懒加载渲染完成
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // 滚动可能触发重渲染替换节点，重新查询选择器
      const refreshed = document.querySelector(selector) as typeof element;
      if (!refreshed) {
        return { error: `Element "${selector}" disappeared after scrolling (page re-rendered). Re-fetch elements and retry.` };
      }
      element = refreshed;
      if (!isRendered(element)) {
        return { error: `Element "${selector}" is not rendered after scrolling.` };
      }
    }

    const obstruction = getObstruction(element);
    if (obstruction) {
      return { error: `Element "${selector}" is obscured by <${describeElement(obstruction)}> (likely a popup/overlay). Close it first, then retry.` };
    }

    // ══════════ 分支：点击 ══════════
    if (action === 'click') {
      // 模拟一系列更真实的鼠标事件，以兼容现代JS框架
      const dispatchMouseEvent = (type: string) => {
        const event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window
        });
        element.dispatchEvent(event);
      };

      dispatchMouseEvent('mouseover');
      dispatchMouseEvent('mousedown');

      // 执行核心的 click() 方法
      element.click();

      dispatchMouseEvent('mouseup');
      dispatchMouseEvent('mouseout');

      return {
        success: true,
        message: `Successfully clicked the element matching selector: "${selector}"`
      };
    }

    // ══════════ 分支：填充 ══════════
    const text = typeof value === 'string' ? value : String(value ?? '');

    // 聚焦是所有操作的前提
    element.focus();

    if ('isContentEditable' in element && element.isContentEditable) {
      // 1. 对于 contenteditable 元素 (如高级文本编辑器)
      // 使用 execCommand 模拟真实用户输入，以兼容现代JS框架
      element.textContent = ''; // 先清空
      const inserted = document.execCommand('insertText', false, text);
      // execCommand 在部分环境（无用户激活 / 异形编辑器）会静默失败：
      // 失败或完全没有写入内容时回退为直接赋值并补发 input 事件，绝不谎报成功
      if (!inserted || (text !== '' && !element.textContent)) {
        element.textContent = text;
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (element.tagName === 'SELECT') {
      // 2. 对于 <select> 下拉菜单
      const selectElement = element as HTMLSelectElement;
      let optionFound = false;
      for (const option of Array.from(selectElement.options)) {
        if (option.value === text || option.text.trim() === text.trim()) {
          selectElement.value = option.value;
          optionFound = true;
          break;
        }
      }
      if (!optionFound) {
        return { error: `No option with value or text matching "${text}" found.` };
      }
      selectElement.dispatchEvent(new Event('change', { bubbles: true }));
    } else if ('value' in element) {
      // 3. 对于标准的 <input> 和 <textarea>
      const inputElement = element as HTMLInputElement | HTMLTextAreaElement;
      inputElement.value = ''; // 先清空
      inputElement.value = text;
      // 触发事件以确保框架能捕获到变化
      inputElement.dispatchEvent(new Event('input', { bubbles: true }));
      inputElement.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      return { error: `Element with selector "${selector}" is not a recognized fillable type.` };
    }

    // 操作完成后失焦
    element.blur();

    return {
      success: true,
      message: 'Element filled successfully.',
      finalValue: 'isContentEditable' in element && element.isContentEditable
        ? element.textContent
        : String((element as HTMLInputElement).value ?? '')
    };
  } catch (error) {
    return { error: `An unexpected error occurred while ${action === 'click' ? 'clicking' : 'filling'} the element: ${(error as Error).message}` };
  }
}
