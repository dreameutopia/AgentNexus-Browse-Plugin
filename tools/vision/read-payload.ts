/** Self-contained isolated-world payload. Never evaluates supplied code, clicks,
 * focuses, types, hovers, changes styles, or writes values. Only scroll mutates.
 * （原 vision_read_wait 的 probe 分支随工具下线一并删除。） */
export async function visionReadPayload(action: 'read' | 'scroll', options: {
  point?: { x: number; y: number };
  region?: { x: number; y: number; width: number; height: number };
  direction?: 'up' | 'down' | 'left' | 'right';
  /** 目标容器滚动百分比（容器相对；手势 scroll 的视口相对百分比是另一个参数） */
  containerPercent?: number;
}) {
  const clean = (value: string | null | undefined, max = 300) => (value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const bounds = { left: options.region?.x ?? 0, top: options.region?.y ?? 0,
    right: options.region ? options.region.x + options.region.width : innerWidth,
    bottom: options.region ? options.region.y + options.region.height : innerHeight };
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect(), style = getComputedStyle(el);
    if (r.width <= 0 || r.height <= 0 || r.right <= bounds.left || r.bottom <= bounds.top ||
        r.left >= bounds.right || r.top >= bounds.bottom || style.visibility !== 'visible' || style.opacity === '0') return false;
    let parent = el.parentElement;
    for (let depth = 0; parent && depth < 40; depth++, parent = parent.parentElement) {
      const s = getComputedStyle(parent), p = parent.getBoundingClientRect();
      if (s.display === 'none' || s.visibility !== 'visible' || s.opacity === '0') return false;
      if (/(hidden|clip|auto|scroll)/.test(s.overflowY) && (r.bottom <= p.top || r.top >= p.bottom)) return false;
      if (/(hidden|clip|auto|scroll)/.test(s.overflowX) && (r.right <= p.left || r.left >= p.right)) return false;
    }
    return true;
  };
  const parentOf = (el: Element): Element | null => {
    const root = el.getRootNode();
    return el.parentElement || ('host' in root ? (root as ShadowRoot).host : null);
  };
  const hit = (doc: Document | ShadowRoot, x: number, y: number): Element | null => {
    let el = doc.elementFromPoint(x, y);
    for (let i = 0; el?.shadowRoot && i < 20; i++) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };
  if (action === 'scroll') {
    const horizontal = options.direction === 'left' || options.direction === 'right';
    let doc = document, x = options.point?.x ?? innerWidth / 2, y = options.point?.y ?? innerHeight / 2;
    let target = options.point ? hit(doc, x, y) : doc.scrollingElement;
    let frameDepth = 0;
    // Same-origin frame coordinates are local; transformed frames are ambiguous.
    while (target?.tagName === 'IFRAME' && frameDepth++ < 8) {
      const frame = target as HTMLIFrameElement, r = frame.getBoundingClientRect();
      for (let ancestor: Element | null = frame, depth = 0; ancestor && depth < 40; ancestor = parentOf(ancestor), depth++) {
        const style = ancestor.ownerDocument.defaultView!.getComputedStyle(ancestor);
        if ((style.transform && style.transform !== 'none') || (style.perspective && style.perspective !== 'none'))
          throw new Error('Transformed iframe or ancestor is unsupported; ask the user to scroll it');
      }
      if (Math.abs(r.width - frame.offsetWidth) > 1 || Math.abs(r.height - frame.offsetHeight) > 1)
        throw new Error('Transformed iframe is unsupported; ask the user to scroll it');
      try {
        if (!frame.contentDocument) throw new Error('Frame inaccessible');
        x -= r.left + frame.clientLeft; y -= r.top + frame.clientTop;
        doc = frame.contentDocument; target = hit(doc, x, y);
      } catch { throw new Error('Cross-origin/inaccessible iframe; ask the user to scroll it'); }
    }
    if (frameDepth > 8) throw new Error('Frame nesting limit exceeded');
    let selected: Element | null = null;
    for (let depth = 0; target && depth < 80; depth++, target = parentOf(target)) {
      const s = target.ownerDocument.defaultView!.getComputedStyle(target);
      const overflow = horizontal ? s.overflowX : s.overflowY;
      const extent = horizontal ? target.scrollWidth - target.clientWidth : target.scrollHeight - target.clientHeight;
      if (target === doc.scrollingElement || (/(auto|scroll)/.test(overflow) && extent > 1)) { selected = target; break; }
    }
    if (!selected) return { moved: false, reason: 'No scrollable container at target', atBoundary: true };
    if (selected === doc.scrollingElement) {
      for (const root of [doc.documentElement, doc.body]) {
        if (!root) continue;
        const style = doc.defaultView!.getComputedStyle(root);
        if (/(hidden|clip)/.test(horizontal ? style.overflowX : style.overflowY))
          return { moved: false, reason: 'Document scrolling is locked; target a visible component or ask the user', atBoundary: false };
      }
    }
    const el = selected, before = { x: el.scrollLeft, y: el.scrollTop };
    const amount = (horizontal ? el.clientWidth : el.clientHeight) * (options.containerPercent ?? 75) / 100 *
      (options.direction === 'up' || options.direction === 'left' ? -1 : 1);
    el.scrollTo({ left: before.x + (horizontal ? amount : 0), top: before.y + (horizontal ? 0 : amount), behavior: 'instant' as ScrollBehavior });
    let stable = 0, previous = { x: el.scrollLeft, y: el.scrollTop };
    for (let i = 0; i < 8 && stable < 2; i++) {
      await new Promise(resolve => setTimeout(resolve, 75));
      const next = { x: el.scrollLeft, y: el.scrollTop };
      stable = Math.abs(next.x - previous.x) < 0.5 && Math.abs(next.y - previous.y) < 0.5 ? stable + 1 : 0;
      previous = next;
    }
    const after = { x: el.scrollLeft, y: el.scrollTop };
    const maxX = Math.max(0, el.scrollWidth - el.clientWidth), maxY = Math.max(0, el.scrollHeight - el.clientHeight);
    return { before, after, delta: { x: after.x - before.x, y: after.y - before.y },
      moved: Math.abs(after.x - before.x) > 0.5 || Math.abs(after.y - before.y) > 0.5,
      settled: stable >= 2, container: { tag: el.tagName, frameDepth, width: el.clientWidth, height: el.clientHeight },
      // RTL scrollLeft may be negative; boundary is direction-independent.
      edges: { x: Math.abs(after.x) < 1 || Math.abs(Math.abs(after.x) - maxX) < 1, y: after.y < 1 || after.y >= maxY - 1 },
      hint: 'Actual scroll offsets only. Lazy loading may still change content; verify the next screenshot. No click or wheel event was sent.' };
  }
  const describe = (el: Element) => {
    const r = el.getBoundingClientRect();
    const secret = el.matches('input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"]');
    const control = el as HTMLInputElement;
    return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role'),
      name: clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') ||
        (!secret && (el.childElementCount < 4 || el.matches('button,a,summary,label')) ? (el as HTMLElement).innerText || el.textContent : ''), 160),
      disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
      checked: el.matches('input[type="checkbox"],input[type="radio"]') ? control.checked : el.getAttribute('aria-checked'),
      expanded: el.getAttribute('aria-expanded'), required: el.matches(':required') || el.getAttribute('aria-required') === 'true',
      invalid: el.getAttribute('aria-invalid'), password: secret,
      // Do not return input values, hidden properties, handlers, or script state.
      rect: { x: Math.max(0, r.left) / innerWidth * 1000, y: Math.max(0, r.top) / innerHeight * 1000,
        width: Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left)) / innerWidth * 1000,
        height: Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) / innerHeight * 1000 } };
  };
  const controls: ReturnType<typeof describe>[] = [], text: string[] = [];
  let nodes = 0, chars = 0, truncated = false, frames = 0;
  const controlSelector = 'button,a[href],input,select,textarea,[role],summary,[contenteditable="true"]';
  const scan = (root: Node, depth = 0) => {
    if (depth > 20) { truncated = true; return; }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (++nodes > 5000 || chars >= 8000) { truncated = true; break; }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (el.tagName === 'IFRAME') frames++;
        if (el.matches(controlSelector) && visible(el)) {
          if (controls.length < 40) controls.push(describe(el)); else truncated = true;
        }
        if (el.shadowRoot && visible(el)) scan(el.shadowRoot, depth + 1);
      } else {
        const parent = node.parentElement;
        if (!parent || parent.closest('script,style,noscript,textarea,input,[hidden],[aria-hidden="true"]') || !visible(parent)) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        if (!Array.from(range.getClientRects()).some(r => r.right > bounds.left && r.left < bounds.right && r.bottom > bounds.top && r.top < bounds.bottom)) continue;
        const value = clean(node.textContent, Math.min(1000, 8000 - chars));
        if (value) { text.push(value); chars += value.length; }
      }
    }
  };
  if (options.point) {
    let el = hit(document, options.point.x, options.point.y);
    for (let i = 0; el && i < 5; i++, el = parentOf(el)) if (visible(el)) controls.push(describe(el));
  } else scan(document.body || document.documentElement);
  const result = { text: text.join('\n'), controls, truncated, scannedNodes: nodes,
    coverage: { source: 'current rendered DOM intersecting viewport/region', complete: false,
      limitations: 'Occlusion is not fully detected. Canvas/WebGL, closed shadow roots and iframe interiors are not read. DOM may have changed since screenshot.', iframeCount: frames },
    page: { url: location.href.slice(0, 500), title: clean(document.title), readyState: document.readyState } };
  // Stay below the generic tool-context guard, preserving valid structured data
  // and coverage metadata instead of handing it a giant JSON string to cut.
  if (result.text.length > 4000) { result.text = result.text.slice(0, 4000); result.truncated = true; }
  while (JSON.stringify(result).length > 6500 && result.controls.length) { result.controls.pop(); result.truncated = true; }
  return result;
}
