import type { ReferenceDocument } from '../automation/shared/element-reference';

/** Self-contained injections; references stay in the extension isolated world. */
export async function textTargetPayload(
  phase: 'focus' | 'verify' | 'type' | 'scroll',
  id: string,
  deltaX = 0,
  deltaY = 0,
) {
  const registry = (document as ReferenceDocument).__agentNexusReferences;
  const node = (
    id ? registry?.resolve(id) : document.scrollingElement
  ) as HTMLElement | null;
  if (!node) return { error: 'STALE_ELEMENT：重新观察并获取引用' };
  const shadow = (el: Element): ShadowRoot | null => {
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
  const active = () => {
    let el = document.activeElement;
    while (el && shadow(el)?.activeElement) el = shadow(el)!.activeElement;
    return el;
  };
  if (phase === 'scroll') {
    const before = { left: node.scrollLeft, top: node.scrollTop };
    registry?.invalidate();
    node.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      success: true,
      before,
      after: { left: node.scrollLeft, top: node.scrollTop },
      moved: before.left !== node.scrollLeft || before.top !== node.scrollTop,
      atBoundary: {
        left: node.scrollLeft <= 0,
        top: node.scrollTop <= 0,
        right: node.scrollLeft + node.clientWidth >= node.scrollWidth - 1,
        bottom: node.scrollTop + node.clientHeight >= node.scrollHeight - 1,
      },
    };
  }
  if (
    (registry?.isRendered && !registry.isRendered(node)) ||
    registry?.describe?.(node).states.disabled ||
    node.matches(':disabled') ||
    node.closest(
      '[inert],[aria-disabled="true"],[data-disabled]:not([data-disabled="false"])',
    )
  )
    return { error: 'NOT_ACTIONABLE：目标不可操作' };
  if (phase === 'focus') {
    registry?.invalidate();
    node.focus();
    if (registry?.resolve(id) !== node)
      return { error: 'STALE_ELEMENT：聚焦时节点变化' };
  }
  if (!document.hasFocus() || active() !== node)
    return { error: 'FOCUS_CHANGED：焦点不在指定引用，重新观察当前焦点' };
  if (
    phase === 'type' &&
    (!(node.isContentEditable || node.matches('textarea,input')) ||
      node.matches('[readonly]') ||
      registry?.describe?.(node).states.readonly ||
      node.closest('[aria-readonly="true"]') ||
      (node.localName === 'input' &&
        ![
          'text',
          'search',
          'email',
          'password',
          'url',
          'tel',
          'number',
        ].includes((node as HTMLInputElement).type)))
  )
    return {
      error: 'NOT_EDITABLE：先通过按键进入编辑模式，再观察实际编辑器引用',
    };
  return { success: true, tag: node.localName };
}

export function focusedTextPayload(invalidate = false) {
  const registry = (document as ReferenceDocument).__agentNexusReferences;
  if (invalidate) registry?.invalidate();
  if (!document.hasFocus()) return null;
  let node = document.activeElement;
  const shadow = (el: Element): ShadowRoot | null => {
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
  while (node && shadow(node)?.activeElement)
    node = shadow(node)!.activeElement;
  if (
    !node ||
    node === document.body ||
    node.matches('iframe,frame') ||
    !registry
  )
    return null;
  const input = node as HTMLInputElement;
  return {
    elementId: registry.register(node),
    tag: node.localName,
    role: node.getAttribute('role'),
    name: (
      node.getAttribute('aria-label') ||
      node.getAttribute('placeholder') ||
      ''
    ).slice(0, 500),
    editable:
      !node.matches(':disabled,[readonly]') &&
      !node.closest(
        '[inert],[aria-disabled="true"],[aria-readonly="true"],[data-disabled]:not([data-disabled="false"])',
      ) &&
      !!(
        (node as HTMLElement).isContentEditable ||
        node.localName === 'textarea' ||
        (node.localName === 'input' &&
          [
            'text',
            'search',
            'email',
            'password',
            'url',
            'tel',
            'number',
          ].includes(input.type))
      ),
    category: registry.describe?.(node).category,
    ...(input.type === 'password'
      ? {}
      : 'value' in node
        ? { value: String(input.value).slice(0, 2000) }
        : { text: (node.textContent || '').slice(0, 2000) }),
  };
}
