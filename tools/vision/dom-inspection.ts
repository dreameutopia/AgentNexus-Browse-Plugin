/** Self-contained isolated-world payload. References never leave their frame. */
export function annotationPayload(action: 'collect' | 'draw' | 'clear' | 'inspect', token: string, ids: number[] = [], localIndex = -1): any {
  const win = window as any;
  const key = '__agentNexusVision';
  if (action === 'clear') { if (win[key]?.token === token) win[key].overlay?.remove(); return; }
  if (action === 'collect') {
    win[key]?.overlay?.remove();
    const elements: Element[] = [];
    let visited = 0;
    const scan = (root: Document | ShadowRoot, depth = 0) => {
      if (depth > 64) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node: Node | null;
      while ((node = walker.nextNode()) && visited++ < 20000 && elements.length < 500) {
        const el = node as Element;
        if (el.shadowRoot) scan(el.shadowRoot, depth + 1);
        if (!el.matches('a[href],button,input,textarea,select,[role],[tabindex],[contenteditable="true"],summary,label')) continue;
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth || s.visibility !== 'visible' || s.display === 'none' || Number(s.opacity) === 0) continue;
        const hit = root.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2)), Math.max(0, Math.min(innerHeight - 1, r.top + r.height / 2)));
        if (hit && (el === hit || el.contains(hit))) elements.push(el);
      }
    };
    scan(document);
    win[key] = { token, elements, rects: [] };
    return elements.length;
  }
  const state = win[key];
  if (!state || state.token !== token) throw new Error('Annotation expired; request new marks');
  if (action === 'draw') {
    if (ids.length !== state.elements.length || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Annotation ID mapping does not match elements');
    state.overlay?.remove();
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;display:block;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    const root = host.attachShadow({ mode: 'closed' });
    state.elements.forEach((el: Element, i: number) => {
      const r = el.getBoundingClientRect(), box = document.createElement('div');
      state.rects[i] = { x: r.x, y: r.y, width: r.width, height: r.height };
      box.style.cssText = `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;outline:1px solid #ff284f;box-sizing:border-box`;
      const label = document.createElement('span');
      label.textContent = String(ids[i]);
      label.style.cssText = `position:absolute;left:${Math.max(0, -r.left)}px;top:${Math.max(0, -r.top)}px;background:#b90028;color:white;font: bold 12px sans-serif;padding:1px 3px`;
      box.append(label); root.append(box);
    });
    state.overlay = host; document.documentElement.append(host);
    return;
  }
  const el: Element = state.elements[localIndex];
  if (!el?.isConnected) throw new Error('Marked element was removed');
  const path = (node: Element): string => {
    const parts: string[] = [];
    for (let n: Element | null = node; n; n = n.parentElement) {
      const parent = n.parentNode as ParentNode | null;
      const siblings = parent?.children ? Array.from(parent.children).filter(e => e.localName === n!.localName && e.namespaceURI === n!.namespaceURI) : [n];
      const name = n.namespaceURI === 'http://www.w3.org/1999/xhtml' ? n.localName : `*[local-name()='${n.localName}' and namespace-uri()='${n.namespaceURI ?? ''}']`;
      parts.unshift(`${name}[${siblings.indexOf(n) + 1}]`);
    }
    return '/' + parts.join('/');
  };
  const selector = (node: Element): string => {
    const parts: string[] = [];
    for (let n: Element | null = node; n; n = n.parentElement) {
      if (n.id && (n.getRootNode() as Document | ShadowRoot).querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const parent = n.parentNode as ParentNode | null;
      const siblings = parent?.children ? Array.from(parent.children) : [n];
      parts.unshift(`${CSS.escape(n.localName)}:nth-child(${siblings.indexOf(n) + 1})`);
    }
    return parts.join(' > ');
  };
  const roots: string[] = [];
  let root = el.getRootNode();
  while (root instanceof ShadowRoot) { roots.unshift(selector(root.host)); root = root.host.getRootNode(); }
  const r = el.getBoundingClientRect(), input = el as HTMLInputElement;
  const capturedRect = state.rects[localIndex];
  return { tag: el.localName, selector: selector(el), xpath: path(el), shadowHosts: roots,
    xpathScope: roots.length ? 'shadow-root (XPath cannot cross shadow boundary)' : 'frame-document',
    attributes: Object.fromEntries(Array.from(el.attributes).filter(a => !/value|password|token|secret/i.test(a.name)).map(a => [a.name, a.value.slice(0, 2000)])),
    text: input.type === 'password' ? '[redacted]' : (el.textContent || '').slice(0, 4000),
    disabled: !!input.disabled, readOnly: !!input.readOnly, checked: !!input.checked,
    editable: el.matches('input,textarea,[contenteditable="true"]'),
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    capturedRect, changedSinceCapture: !!capturedRect && ['x','y','width','height'].some(k => Math.abs(r[k as 'x'] - capturedRect[k]) > 0.5),
    options: el instanceof HTMLSelectElement ? Array.from(el.options).slice(0, 200).map(o => ({ text: o.text, value: o.value, selected: o.selected })) : undefined,
    ancestors: Array.from((function* () { let n = el.parentElement; for (let i = 0; n && i < 5; i++, n = n.parentElement) yield { tag: n.localName, role: n.getAttribute('role') }; })()),
  };
}

/** Only the focused editable frame may accept typing; no iframe-as-editable shortcut. */
export function focusedEditablePayload(token: string, remember = false): boolean {
  if (!document.hasFocus()) return false;
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (!el) return false;
  const win = window as any;
  if (remember) win.__agentNexusInputFocus = { token, el };
  else if (win.__agentNexusInputFocus?.token !== token || win.__agentNexusInputFocus.el !== el) return false;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
  return el instanceof HTMLInputElement && !el.disabled && !el.readOnly &&
    ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(el.type);
}
