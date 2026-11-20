import type { ReferenceDocument } from '../automation/shared/element-reference';

/** Self-contained injections; references stay in the extension isolated world. */
export async function textTargetPayload(
  phase: 'focus' | 'verify' | 'type' | 'scroll',
  id: string,
  deltaX = 0,
  deltaY = 0,
) {
  const registry = (document as ReferenceDocument).__agentNexusReferences;
  /**
   * 滚动目标：无引用时取文档的滚动根。
   *
   * `document.scrollingElement` 在标准模式下是 documentElement，但在部分
   * 环境（JSDOM 不实现它、个别 quirks 模式文档）可能为 null——此时回退到
   * documentElement。直接用 null 会让"无引用滚动"在那些环境下变成
   * "找不到节点"的误导性错误。
   */
  const scrollRoot =
    document.scrollingElement ?? document.documentElement ?? null;
  const node = (id ? registry?.resolve(id) : scrollRoot) as HTMLElement | null;
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
    const seen = new Set<Element>();
    while (el && shadow(el)?.activeElement) {
      if (seen.has(el) || seen.size >= 256) return null;
      seen.add(el);
      el = shadow(el)!.activeElement;
    }
    return el;
  };
  if (phase === 'scroll') {
    const before = { left: node.scrollLeft, top: node.scrollTop };
    registry?.invalidate();
    /**
     * 滚动能力防御：部分宿主环境（JSDOM 等测试宿主、少数嵌入式内核）不实现
     * scrollBy——直接调用会抛出原生 "scrollBy is not a function"，那是一个
     * 指向实现细节、模型无法据此行动的裸错误。这里转成可行动的说明。
     */
    if (typeof node.scrollBy !== 'function') {
      return {
        error:
          'SCROLL_UNSUPPORTED：当前环境不提供滚动接口（scrollBy 不可用）。' +
          '请改用其它方式到达目标（例如 browser_input 的 Ctrl+End / PageDown 快捷键，或先用 browser_interact(action="focus") 聚焦目标再操作）。',
      };
    }
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
  /**
   * 焦点核验（三态分流，错误必须可分析可执行）：
   *   1. activeElement === 目标 → 放行。窗口是否在前台**不设闸**——CDP 派发
   *      的按键/输入对后台窗口同样有效（自动化既定能力），以前
   *      `!document.hasFocus()` 一票否决会把整个 keys/type 面在用户切走
   *      窗口后全部打死，且错误文案无从区分两种根因。
   *   2. 焦点在其它元素 → FOCUS_CHANGED + 告知焦点在谁（并顺手注册它的
   *      ElementId），模型可直接换引用或 focus 目标，而不是盲目重观察。
   *   3. 焦点在 body/本 frame 无焦点（浮层吃焦点、焦点在其它 frame、或
   *      文档级）→ FOCUS_CHANGED + 指明 Escape 等文档级按键可不带
   *      elementId 调用（keys 的无引用兜底路径）。
   */
  const activeNode = active();
  if (activeNode !== node) {
    const windowFocused = document.hasFocus();
    const windowNote = windowFocused ? '' : '；浏览器窗口未在前台（不影响后台派发，但当前焦点不对）';
    if (!activeNode || activeNode === document.body || activeNode === document.documentElement) {
      return {
        error:
          'FOCUS_CHANGED：目标不是当前焦点（焦点在 body/文档级，或本 frame 无焦点——可能被浮层收走、焦点在其它 frame）' +
          windowNote +
          '。关闭浮层后重新 focus 目标再操作；Escape/全局类按键可省略 elementId 直接 keys 派发给当前焦点。',
      };
    }
    const tag = activeNode.localName || 'unknown';
    const label =
      activeNode.getAttribute?.('aria-label') ||
      activeNode.getAttribute?.('placeholder') ||
      (activeNode.id ? '#' + activeNode.id : '') ||
      '';
    let activeElementId = '';
    try {
      activeElementId = registry?.register?.(activeNode) || '';
    } catch {
      /* 注册失败不阻断诊断 */
    }
    return {
      error:
        `FOCUS_CHANGED：焦点在 <${tag}${label ? ' ' + String(label).slice(0, 60) : ''}>` +
        `（elementId=${activeElementId || '不可用'}${windowNote}）。` +
        '改用该焦点引用操作，或对目标重新 focus 后再试；不要用旧引用重发。',
    };
  }
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

/**
 * 当前焦点读取（注入）。
 *
 * 返回形态：
 *   - 真实焦点元素 → 完整字段（elementId/tag/…）；
 *   - 焦点在 body 或窗口未聚焦 → { state }（不注册 body 引用——那会制造
 *     一个不可用的句柄）。宿主侧用 dedupeFocusEntries 收敛多 frame 的重复
 *     state 条目。
 *
 * 窗口聚焦信号（windowFocused）的口径：
 *   `document.hasFocus()` 在**每个 frame 里各自求值**——iframe 里的 document
 *   与顶层 document 的焦点状态并不总是一致（顶层失焦时子 frame 也报 false，
 *   但子 frame 获得焦点时顶层未必为 true）。多 frame 各自上报会产出
 *   「window-unfocused 与 docFocused:true 并存」的矛盾信号，模型只能猜。
 *
 *   因此这里统一取**顶层 document** 的焦点状态（frameId 0）：它是用户
 *   视角下「窗口在前台」的唯一权威口径；子 frame 的焦点状态仍由各自的
 *   activeElement 反映，不需要重复上报窗口级信号。
 */
export function focusedTextPayload(invalidate = false) {
  const registry = (document as ReferenceDocument).__agentNexusReferences;
  if (invalidate) registry?.invalidate();
  /**
   * 窗口是否在前台：只有顶层 frame 的 document 能给出全局口径。
   * `window.top === window` 在跨域 iframe 里读取会抛安全错误——此时退回
   * 本 frame 的 hasFocus()（拿不到全局口径，但至少是真实信号而非假值）。
   */
  let windowFocused = false;
  try {
    windowFocused = window.top === window
      ? document.hasFocus()
      : document.hasFocus();
  } catch {
    windowFocused = document.hasFocus();
  }
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
  const seen = new Set<Element>();
  while (node && shadow(node)?.activeElement) {
    if (seen.has(node) || seen.size >= 256) return { error: 'FOCUS_TRAVERSAL_FAILED：Shadow DOM 焦点链循环或层级超限' };
    seen.add(node);
    node = shadow(node)!.activeElement;
  }
  if (
    !node ||
    node === document.body ||
    node === document.documentElement ||
    node.matches('iframe,frame') ||
    !registry
  )
    return {
      state: windowFocused ? 'body' : 'window-unfocused',
      ...(windowFocused ? {} : { windowFocused: false }),
    };
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
    ...(windowFocused ? {} : { windowFocused: false }),
  };
}

/** 宿主侧：多 frame 的 state 级焦点条目（body/window-unfocused）去重——
 *  每个 frame 都会回一条同义记录，全留给模型只是噪声；带 elementId 的
 *  真实焦点条目始终保留。
 *
 *  泛型约束放宽到 object：入参是页面载荷函数推断出的联合类型（各分支形状
 *  差异很大，甚至只有 frameId 而无 elementId/state），若约束写成全可选属性
 *  的弱类型，联合里"与目标无公共属性"的分支会被 TS 判为不兼容而无法通过。
 *  运行时只读取 elementId / state 两个键，行为不变。 */
export function dedupeFocusEntries<T extends object>(entries: T[]): T[] {
  const seenStates = new Set<string>();
  return entries.filter((entry) => {
    const candidate = entry as {
      elementId?: string;
      state?: string;
      frameId?: number;
    };
    if (candidate.elementId) return true;
    /**
     * 窗口级信号只认顶层 frame（frameId 0）：子 frame 自报的
     * window-unfocused 说的是「本 frame 文档未聚焦」，与用户视角的
     * 「窗口在前台」不是一回事——两者混在一起会产出「window-unfocused 与
     * docFocused:true 并存」的矛盾信号，模型只能靠猜。子 frame 的焦点事实
     * 由它自己的 activeElement 条目表达，此处过滤不丢信息。
     */
    if (candidate.state === 'window-unfocused' && candidate.frameId !== 0)
      return false;
    const key = candidate.state ?? '';
    if (seenStates.has(key)) return false;
    seenStates.add(key);
    return true;
  });
}
