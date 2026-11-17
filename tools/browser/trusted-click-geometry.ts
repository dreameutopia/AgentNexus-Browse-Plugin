/**
 * 可信点击的坐标采集荷载（trusted click 专用）
 *
 * 为什么需要独立文件：可信点击走 CDP `Input.dispatchMouseEvent`，需要**页面
 * 视口坐标**（含 iframe 偏移），而 DOM 注入拿到的 `getBoundingClientRect()` 是
 * **frame 局部坐标**。两者必须换算，否则点到的地方是错的。
 *
 * 本荷载在**目标 frame 内**执行，返回：
 * - `local`：元素在自身 frame 视口内的矩形（中心点）；
 * - `frameOffset`：该 frame 相对其父 frame 视口的偏移（逐层累加到顶层）；
 * - `hit`：该点实际命中的元素是否就是目标（或其后代）——命中检查用于避免
 *   「按坐标点到了遮挡物」。
 *
 * ⚠️ 注入约束：同 element-scan-payload——必须完全自包含，只能引用自身参数、
 * 自身嵌套声明与页面全局对象。
 */

/** 单个 frame 的视口信息 */
export interface TrustedClickGeometry {
  /** 元素在自身 frame 视口内的中心点 */
  local: { x: number; y: number };
  /** 元素在自身 frame 视口内的矩形 */
  rect: { x: number; y: number; width: number; height: number };
  /** 该 frame 相对顶层视口的累计偏移 */
  frameOffset: { x: number; y: number };
  /** 目标位于第几层 iframe（0 = 顶层） */
  framesDeep: number;
  /** 探测到的点击点是否真的命中目标（false = 被遮挡） */
  hitTarget: boolean;
  /** 命中的元素描述（诊断用） */
  hitDescription: string;
  /** 点击点是否在视口内（frame 内与顶层都满足） */
  inViewport: boolean;
  /** 元素是否可渲染（有面积、可见） */
  visible: boolean;
  /** 实际点击点的顶层视口坐标（= local + frameOffset） */
  topLevel: { x: number; y: number };
}

export async function trustedClickGeometryPayload(
  elementId: string,
): Promise<TrustedClickGeometry | { error: string }> {
  const registry = (document as any).__agentNexusReferences;
  const node = elementId ? registry?.resolve(elementId) : null;
  if (!node) return { error: 'STALE_ELEMENT：引用已失效，请重新 browser_observe 获取 ElementId 与 FrameId' };

  // 屏幕外元素：先滚到视口中央再量坐标。
  // 不做这一步的话，屏幕外目标的 topLevel 坐标落在视口外，CDP 会把点击
  // 派发到别的元素上——比直接报错更危险。
  const initialRect = node.getBoundingClientRect();
  const initialViewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const initialViewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const initialCenterX = initialRect.left + initialRect.width / 2;
  const initialCenterY = initialRect.top + initialRect.height / 2;
  const initiallyInViewport =
    initialRect.width >= 1 &&
    initialRect.height >= 1 &&
    initialCenterX >= 0 &&
    initialCenterY >= 0 &&
    initialCenterX <= initialViewportWidth &&
    initialCenterY <= initialViewportHeight;
  if (!initiallyInViewport) {
    try {
      (node as HTMLElement).scrollIntoView({
        behavior: 'instant',
        block: 'center',
        inline: 'center',
      });
      // 等两帧：滚动可能触发懒加载渲染，坐标需在渲染稳定后量取
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 250);
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(() => {
            clearTimeout(timeout);
            resolve();
          }),
        );
      });
    } catch {
      /* 滚动失败不致命：随后的 inViewport 判定会给出明确错误 */
    }
  }

  const rect = node.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  // 自身 frame 视口尺寸
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

  // 可见性：display/visibility/opacity 与面积
  const style = window.getComputedStyle(node);
  let visible = true;
  {
    let current: Element | null = node;
    let alpha = 1;
    for (let depth = 0; current && depth < 256; depth++) {
      const cs = window.getComputedStyle(current);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') {
        visible = false;
        break;
      }
      const a = Number.parseFloat(cs.opacity);
      alpha *= Number.isFinite(a) ? a : 1;
      if (alpha < 0.1) {
        visible = false;
        break;
      }
      current =
        current.assignedSlot ||
        current.parentElement ||
        ((current.getRootNode() as ShadowRoot).host as Element | null) ||
        null;
    }
    if (visible && (rect.width < 1 || rect.height < 1)) visible = false;
  }

  // 命中检查：找出**真正可点**的位置。
  //
  // 为什么要搜点而不是直接用矩形中心：元素可能被 CSS transform 旋转/缩放，
  // 也可能被 overflow 裁掉一半——此时矩形中心落在元素之外，elementFromPoint
  // 命中的是别的元素。若只信矩形中心，CDP 就会把点击派发到错误目标上
  // （比报错更危险）。这里在矩形内做小范围网格探测，取第一个真正命中目标的点。
  let hitTarget = false;
  let hitDescription = '';
  let clickPoint = { x: centerX, y: centerY };
  try {
    const root = node.getRootNode() as Document | ShadowRoot;
    const probe = (x: number, y: number): Element | null => {
      // 必须在**元素所在的根**里探测：影子 DOM 内的元素在文档层探测只会命中
      // 影子宿主，用文档层判定会把「完全可见可点」误判成「被遮挡」。
      if (root && typeof (root as Document).elementFromPoint === 'function')
        return (root as Document).elementFromPoint(x, y);
      return document.elementFromPoint(x, y);
    };
    const isTarget = (hit: Element | null): boolean =>
      !!hit && (hit === node || node.contains(hit));
    const left = rect.left;
    const top = rect.top;
    const width = rect.width;
    const height = rect.height;
    // 候选点顺序：中心 → 四分点 → 边缘中点 → 网格。中心被 transform 或
    // 裁剪挡住时，后面的候选仍可能落在可见区域上。
    const ratios: Array<[number, number]> = [
      [0.5, 0.5],
      [0.25, 0.5],
      [0.75, 0.5],
      [0.5, 0.25],
      [0.5, 0.75],
      [0.25, 0.25],
      [0.75, 0.25],
      [0.25, 0.75],
      [0.75, 0.75],
      [0.1, 0.5],
      [0.9, 0.5],
      [0.5, 0.1],
      [0.5, 0.9],
    ];
    let hit: Element | null = null;
    for (const [rx, ry] of ratios) {
      const x = left + width * rx;
      const y = top + height * ry;
      const candidate = probe(x, y);
      if (isTarget(candidate)) {
        hit = candidate;
        clickPoint = { x, y };
        break;
      }
      // 记录第一次命中的其它元素，用于遮挡诊断
      if (!hit && candidate) hit = candidate;
    }
    hitTarget = isTarget(hit);
    if (hit) {
      const cls =
        typeof hit.className === 'string' && hit.className.trim()
          ? '.' + hit.className.trim().split(/\s+/)[0]
          : '';
      hitDescription = `${hit.tagName.toLowerCase()}${hit.id ? '#' + hit.id : ''}${cls}`;
    } else {
      hitDescription = '(none)';
    }
  } catch {
    hitDescription = '(unavailable)';
  }

  // 视口判定用**实际点击点**（网格探测出来的那个），不是矩形中心：
  // 元素被 transform 或裁剪时，矩形中心可能落在视口外而实际可点区域在视口内。
  const inViewport =
    rect.width >= 1 &&
    rect.height >= 1 &&
    clickPoint.x >= 0 &&
    clickPoint.y >= 0 &&
    clickPoint.x <= viewportWidth &&
    clickPoint.y <= viewportHeight;

  // frame 偏移：逐层向上累加 iframe 宿主在父 frame 视口中的位置。
  //
  // CDP 的 Input.dispatchMouseEvent 坐标以**顶层视口**为基准，而
  // getBoundingClientRect() 给的是 frame 内坐标——两者必须换算，否则
  // 在 iframe 里的目标会被点到别处。
  //
  // 换算用 frameElement.getBoundingClientRect()（宿主元素在**父 frame 视口**
  // 中的位置），逐层相加即得顶层偏移。
  let offsetX = 0;
  let offsetY = 0;
  let framesDeep = 0;
  try {
    let win: Window | null = window as Window;
    let guard = 0;
    while (guard++ < 16) {
      const frameElement = (win as any).frameElement as HTMLElement | null;
      if (!frameElement || !frameElement.getBoundingClientRect) break;
      const frameRect = frameElement.getBoundingClientRect();
      offsetX += frameRect.left;
      offsetY += frameRect.top;
      framesDeep++;
      const parentWin = frameElement.ownerDocument?.defaultView;
      if (!parentWin || parentWin === win) break;
      win = parentWin;
    }
  } catch {
    /* 偏移计算失败时退化为 0（顶层 frame 场景） */
  }

  // 顶层视口内的最终校验：坐标必须落在顶层视口里，否则 CDP 会把点击派发到
  // 视口外（浏览器会自行钳制，落到不可预期的位置）。
  const topLevel = { x: clickPoint.x + offsetX, y: clickPoint.y + offsetY };
  const topViewportWidth =
    (window.top as Window | null)?.innerWidth ||
    document.documentElement.clientWidth ||
    viewportWidth;
  const topViewportHeight =
    (window.top as Window | null)?.innerHeight ||
    document.documentElement.clientHeight ||
    viewportHeight;
  const inTopViewport =
    topLevel.x >= 0 &&
    topLevel.y >= 0 &&
    topLevel.x <= topViewportWidth &&
    topLevel.y <= topViewportHeight;

  return {
    local: { x: clickPoint.x, y: clickPoint.y },
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    frameOffset: { x: offsetX, y: offsetY },
    framesDeep,
    hitTarget,
    hitDescription,
    inViewport: inViewport && inTopViewport,
    visible,
    topLevel,
  };
}
