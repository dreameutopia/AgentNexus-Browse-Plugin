/**
 * 选区读取（单一事实源）
 *
 * content script 三通道事件（selectionchange / select 捕获 / mouseup+keyup）
 * 共用此实现；抽出为独立模块以便在 Node+JSDOM 下回归（content script 本体
 * 无法脱离浏览器挂载，选区读取逻辑却可以）。
 *
 * 三段读取策略（逐段兜底，覆盖复杂站点的选区形态）：
 *   1. **表单控件**（input / textarea，含 open Shadow DOM 内的）：从深层
 *      activeElement 的 selectionStart/End 切片读值——window.getSelection()
 *      对表单内选区恒返回空，这是「输入框里划词不同步」的唯一读法；
 *   2. **文档选区直读**：Selection.toString()，覆盖普通 DOM 正文选区；
 *   3. **Range 级克隆兜底**：Selection.toString() 在跨根 / Shadow DOM 选区
 *      上存在序列化缺口（返回空串但 rangeCount > 0）——此时逐 Range
 *      cloneContents 收集文本节点，闭合 Shadow 边界也能拿到原文。
 *
 * 注意：content script 运行在隔离世界，页面对 Selection.prototype 的
 * 猴子补丁影响不到这里的调用（每个世界有独立原型）。
 */

/** 沿 open Shadow DOM 下钻，取真正持有焦点的元素（document.activeElement 对
 *  shadow 内焦点返回的是宿主元素——规范的事件重定向，不穿透） */
export function getDeepActiveElement(doc: Document = document): Element | null {
  let el = doc.activeElement;
  while (el) {
    const inner = (el as HTMLElement).shadowRoot?.activeElement;
    if (inner && inner !== el) {
      el = inner;
      continue;
    }
    break;
  }
  return el;
}

/** 从单个 Range 收集文本（克隆进游离 div 取 textContent，绕开 toString 的跨根序列化缺口） */
function textOfRange(range: Range, doc: Document): string {
  try {
    const holder = doc.createElement('div');
    holder.appendChild(range.cloneContents());
    return holder.textContent ?? '';
  } catch {
    // 极端形态（Range 已失效等）：退回 Range.toString，失败则放弃该段
    try {
      return range.toString();
    } catch {
      return '';
    }
  }
}

/**
 * 读取当前选中文本（已去首尾空白；无选区返回空串）。
 *
 * 读取顺序：表单控件切片 → Selection.toString() → Range 级克隆收集。
 * 前两段任一拿到非空结果即返回；全部为空 = 真无选区（光标态的
 * collapsed range 在克隆路径上同样产出空串，不会误报）。
 */
export function readSelectedText(doc: Document = document): string {
  // ── 1. 表单控件选区 ──
  try {
    const active = getDeepActiveElement(doc);
    // isConnected：已脱离文档的残留焦点元素（极少数 SPA 拆节点的时序）不作数，
    // 其 selection* 可能残留旧值；shadow 内元素随宿主连通，isConnected 同样为真
    if (
      (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
      active.isConnected
    ) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      // 部分 input 类型（number 等）selection* 返回 null；end > start 才是真选区
      if (typeof start === 'number' && typeof end === 'number' && end > start) {
        const sliced = active.value.slice(start, end).trim();
        if (sliced) return sliced;
      }
    }
  } catch {
    // 个别 input 类型访问 selection* 会抛：落到文档选区路径，绝不中断整条读取
  }

  // ── 2. 文档选区直读 ──
  const selection = doc.getSelection?.();
  if (!selection || selection.rangeCount === 0) return '';
  const direct = selection.toString().trim();
  if (direct) return direct;

  // ── 3. Range 级克隆兜底（Shadow DOM / 跨根选区的序列化缺口）──
  let collected = '';
  for (let i = 0; i < selection.rangeCount; i++) {
    collected += textOfRange(selection.getRangeAt(i), doc);
    if (collected.trim()) break; // 多 Range（罕见）拿到即止
  }
  return collected.trim();
}
