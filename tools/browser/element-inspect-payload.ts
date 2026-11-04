import type { ReferenceDocument } from '../automation/shared/element-reference';

/** Serialized into the same isolated world as browser_observe; no captured helpers. */
export function elementInspectPayload(elementId: string) {
  const registry = (document as ReferenceDocument).__agentNexusReferences;
  const node = registry?.resolve(elementId);
  if (!node) return { error: 'STALE_ELEMENT：引用已失效，请重新 browser_observe。' };
  const literal = (value: string): string => {
    if (!value.includes("'")) return "'" + value + "'";
    if (!value.includes('"')) return '"' + value + '"';
    return 'concat(' + value.split("'").map(part => "'" + part + "'").join(',"\'",') + ')';
  };
  const xpathOf = (element: Element): string => {
    const step = (item: Element): string => item.namespaceURI === 'http://www.w3.org/1999/xhtml'
      ? item.localName : '*[local-name()=' + literal(item.localName) + ']';
    if (element.id) return '//*[@id=' + literal(element.id) + ']';
    for (const attr of ['data-testid', 'name', 'aria-label', 'placeholder']) {
      const value = element.getAttribute(attr);
      if (value && element.getRootNode() === document) {
        const path = '//' + step(element) + '[@' + attr + '=' + literal(value) + ']';
        if (document.evaluate(path, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength === 1) return path;
      }
    }
    const parts: string[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) {
      const siblings = current.parentElement ? Array.from(current.parentElement.children).filter(el => el.localName === current!.localName && el.namespaceURI === current!.namespaceURI) : [current];
      parts.unshift(step(current) + '[' + (siblings.indexOf(current) + 1) + ']');
    }
    return '/' + parts.join('/');
  };
  const root = node.getRootNode();
  const shadowHosts: string[] = [];
  for (let scope = root; scope !== document && 'host' in scope;) {
    const host = (scope as ShadowRoot).host;
    shadowHosts.unshift(xpathOf(host));
    scope = host.getRootNode();
  }
  const style = window.getComputedStyle(node);
  const rect = node.getBoundingClientRect();
  const sensitive = node.matches('input[type="password"], input[type="hidden"]');
  const attributes = Object.fromEntries(Array.from(node.attributes)
    .filter(attr => !/^on/i.test(attr.name) && !['value', 'srcdoc'].includes(attr.name.toLowerCase()))
    .slice(0, 60).map(attr => [attr.name, attr.value.slice(0, 500)]));
  return {
    elementId, tag: node.localName, attributes,
    text: sensitive ? '' : (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 1000),
    value: sensitive ? undefined : ('value' in node ? String(node.value).slice(0, 500) : undefined),
    labels: Array.from((node as HTMLInputElement).labels || []).map(label => (label.textContent || '').trim().slice(0, 300)),
    checked: 'checked' in node ? Boolean(node.checked) : undefined,
    selected: 'selected' in node ? Boolean(node.selected) : undefined,
    editable: node.matches('input:not([readonly]), textarea:not([readonly]), [contenteditable="true"], [contenteditable=""]'),
    options: node.localName === 'select' ? Array.from((node as HTMLSelectElement).options).slice(0, 100)
      .map(option => ({ text: option.text, value: option.value, selected: option.selected, disabled: option.disabled })) : undefined,
    xpath: root === document ? xpathOf(node) : null,
    shadow: shadowHosts.length ? { hosts: shadowHosts, localPath: xpathOf(node), note: 'Shadow 内路径不能直接用于文档 XPath；按 host 作用域重新探测。' } : undefined,
    frameUrl: document.location.href,
    visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0,
    enabled: !node.matches(':disabled, [aria-disabled="true"]') && !node.closest('[inert]'),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    appearance: { color: style.color, backgroundColor: style.backgroundColor, borderRadius: style.borderRadius },
    hint: 'rect 是本 frame 的 CSS 像素，不能直接用于视觉坐标；XPath 需重新查询并核对文字/属性与唯一性。',
  };
}
