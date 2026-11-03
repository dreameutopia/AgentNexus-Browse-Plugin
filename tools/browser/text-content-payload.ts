/** Self-contained visible-text extraction, including extension-accessible shadow roots. */
export function textContentPayload(limit: number) {
  const roots: (Document | ShadowRoot)[] = [document];
  const chunks: string[] = [];
  let truncated = false;
  for (let i = 0; i < roots.length; i++) {
    if (i >= 200) {
      truncated = true;
      break;
    }
    const root = roots[i];
    if (root === document)
      chunks.push(
        typeof document.body?.innerText === 'string'
          ? document.body.innerText
          : document.body?.textContent || ''
      );
    else
      for (const child of Array.from(root.children)) {
        if (child.matches('script,style,noscript,template')) continue;
        const style = window.getComputedStyle(child);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        chunks.push(
          typeof (child as HTMLElement).innerText === 'string'
            ? (child as HTMLElement).innerText
            : child.textContent || ''
        );
      }
    root.querySelectorAll('*').forEach((el) => {
      let shadow = el.shadowRoot;
      try {
        shadow ||= (globalThis as any).chrome?.dom?.openOrClosedShadowRoot?.(
          el
        );
      } catch {
        /* unsupported API */
      }
      if (shadow) roots.push(shadow);
    });
    if (chunks.reduce((sum, text) => sum + text.length, 0) > limit) {
      truncated = true;
      break;
    }
  }
  const text = chunks.join('\n');
  return {
    text: text.slice(0, limit),
    truncated: truncated || text.length > limit,
    shadowRoots: Math.max(0, roots.length - 1),
    url: document.URL,
  };
}
