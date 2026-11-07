/**
 * 结构化页面正文提取荷载（browser_get_page_text 注入用）
 *
 * 每个可注入 frame 各执行一次（executeScript allFrames），把 document.body
 * 转成保留语义结构的 Markdown：标题层级 / 表格（grid 还原 rowspan+colspan）/
 * 列表（嵌套 + 任务项）/ 代码块（语言识别）/ 链接 / 引用 / 图片 / 表单控件。
 *
 * 遍历约定（与旧 textContentPayload 同源的边界，按现代组件框架收紧）：
 *   - 元素带可访问 shadow root（el.shadowRoot 或 chrome.dom.openOrClosedShadowRoot）
 *     时子节点取 shadow 树（这是实际渲染内容；slot 用 assignedNodes 取被分发
 *     节点，无分发时才用回退子节点），光 DOM 子节点不再遍历——未分发的光子
 *     节点本就不渲染；宿主自身语义（a/h1/strong…）仍然套用在 shadow 内容上；
 *   - 隐藏元素（display:none / visibility:hidden）整棵跳过（先于 shadow 检查，
 *     隐藏宿主的 shadow 树同样不可见）；
 *   - script/style/svg/canvas 等无文本语义的标签整棵跳过（iframe 内容由
 *     allFrames 在各自 frame 中提取，本 frame 内的 iframe 节点本身跳过）；
 *   - 嵌套表格不会污染外层表格：行/单元格/caption 均按 closest 限定归属。
 *
 * 噪声引擎：控制字符与零宽/私用区字符（图标字体连字）剔除、行分隔符归一为
 * 空格、超长 base64/hex/转义序列折叠、同字符长连排收敛、代码围栏之外的空白
 * 规整（连续空行 ≤1、行内多空格合一）——代码块内部保持原样（仅剔控制字符）。
 *
 * 自包含铁律：函数体内不得引用任何模块级标识符（chrome.scripting 会把源码
 * 序列化后到页面干净作用域求值），全部常量声明在函数体内。
 */
export function structuredPagePayload(): {
  markdown: string;
  truncated: boolean;
  shadowRoots: number;
  url: string;
  title: string;
  error?: string;
} {
  // ─── 常量（必须内联在函数体内） ───
  /** 单 frame 提取结果字符上限（超长截断并标记） */
  const FRAME_CHAR_LIMIT = 800_000;
  /** 递归/遍历的累计字符停止线：超过后不再深入新子树（防超大页拖垮注入） */
  const EMIT_STOP_CHARS = 2_000_000;
  /** DOM 递归深度上限（正常页面 < 30） */
  const MAX_DEPTH = 64;
  /** 列表嵌套缩进上限 */
  const MAX_LIST_DEPTH = 8;
  /** 单个代码块字符上限 */
  const MAX_CODE_CHARS = 20_000;
  /** 表格防御上限 */
  const MAX_TABLE_ROWS = 400;
  const MAX_TABLE_COLS = 60;
  const MAX_CELL_CHARS = 600;
  /** 链接/图片 URL 长度上限（超长多为跟踪参数或内联数据） */
  const MAX_URL_CHARS = 1_000;
  /** 下拉框展示的选项数上限 */
  const MAX_OPTIONS = 12;
  /** base64/hex 长编码串阈值：连续 ≥ 该长度的纯编码字符视为噪声折叠 */
  const NOISE_RUN_CHARS = 200;
  /** 同一字符连续出现阈值（分隔线等）超过则收敛 */
  const REPEAT_CHARS = 40;

  // 预编译清洗正则（构造一次；/g 配合 String.replace 使用，replace 完成后
  // lastIndex 自动复位，跨调用复用安全）。含不可见码位的模式统一经
  // new RegExp + \\uXXXX 转义构造——源码保持纯 ASCII，杜绝不可见字符
  // 混入字面量（U+2028/2029 是正则字面量的行终止符，字面量写法直接语法错误）。
  // eslint-disable-next-line no-control-regex -- 剔除控制字符正是清洗目的（保留 \t \n）
  const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
  /** 零宽符（ZWSP/ZWNJ/ZWJ/LRM/RLM/BOM）与 BMP 私用区（图标字体连字码位）：
   *  无宽度无语义，直接剔除。不处理增补平面私用区（15/16 面）——按码元的
   *  正则里无法与正常 emoji 区分，宁漏勿杀。 */
  const INVISIBLE_CHARS_RE = new RegExp('[\\u200B-\\u200F\\uFEFF\\uE000-\\uF8FF]', 'g');
  /** 行/段分隔符（U+2028/2029，亦是严格 JSON 网关的危险字符）与双向嵌套
   *  控制符（U+202A-202E）：语义上是断行/方向隔离，替换为空格避免词粘连。 */
  const LINE_SEP_RE = new RegExp('[\\u2028\\u2029\\u202A-\\u202E]', 'g');
  const NOISE_RUN_RE = new RegExp('[A-Za-z0-9+/]{' + NOISE_RUN_CHARS + ',}={0,3}', 'g');
  const ESCAPE_SOUP_RE = /(?:\\u[0-9a-fA-F]{4}){40,}/g;
  const REPEAT_RE = new RegExp('(.)\\1{' + REPEAT_CHARS + ',}', 'g');

  const IGNORED_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'iframe', 'embed', 'object',
    'applet', 'svg', 'canvas', 'math', 'video', 'audio', 'source', 'track',
    'link', 'meta', 'base', 'datalist', 'map', 'area', 'col', 'colgroup',
  ]);
  // 注意：dialog 不在忽略表——<dialog open> 是真实可见的模态内容；
  // 关闭态在 Chrome 里由 UA 样式 display:none 兜底进 isHidden。

  const shadowRootsCount = { n: 0 };
  const visited = new WeakSet<object>();
  let emittedChars = 0;
  let truncated = false;

  const safeSlice = (text: string, end: number): string => {
    const stop = Math.min(end, text.length);
    if (stop <= 0) return '';
    const code = text.charCodeAt(stop - 1);
    // 切点前一位是高位代理（增补平面前半）时回退一位，避免产生孤立代理项
    if (code >= 0xd800 && code <= 0xdbff) return text.slice(0, stop - 1);
    return text.slice(0, stop);
  };

  /** 文本清洗：不可见字符剔除 → 噪声编码串折叠 → 空白收敛（trim 可选） */
  const cleanText = (raw: string, trim = true): string => {
    let text = raw || '';
    if (!text) return '';
    text = text.replace(CONTROL_CHARS_RE, '').replace(INVISIBLE_CHARS_RE, '').replace(LINE_SEP_RE, ' ');
    if (text.length >= NOISE_RUN_CHARS) {
      text = text.replace(NOISE_RUN_RE, '［长编码串省略］').replace(ESCAPE_SOUP_RE, '［转义序列省略］');
    }
    text = text.replace(REPEAT_RE, (match) => match[0] + '…');
    text = text.replace(/\s+/g, ' ');
    return trim ? text.trim() : text;
  };

  /** 代码文本清洗：保留换行与缩进，仅剔除不可见字符并折叠超长编码串 */
  const cleanCode = (raw: string): string => {
    let text = raw || '';
    if (!text) return '';
    text = text.replace(CONTROL_CHARS_RE, '').replace(INVISIBLE_CHARS_RE, '').replace(LINE_SEP_RE, ' ');
    return text.replace(NOISE_RUN_RE, '［长编码串省略］');
  };

  const shadowOf = (el: Element): ShadowRoot | null => {
    try {
      if (el.shadowRoot) return el.shadowRoot;
    } catch { /* 访问受限 */ }
    try {
      const chromeApi = (globalThis as unknown as { chrome?: { dom?: { openOrClosedShadowRoot?: (el: Element) => ShadowRoot | null } } }).chrome;
      const opener = chromeApi?.dom?.openOrClosedShadowRoot;
      if (typeof opener === 'function') return opener.call(chromeApi!.dom, el);
    } catch { /* 不支持时静默 */ }
    return null;
  };

  const isHidden = (el: Element): boolean => {
    try {
      const style = window.getComputedStyle(el);
      return style.display === 'none' || style.visibility === 'hidden';
    } catch {
      return false;
    }
  };

  const attrInt = (el: Element, name: string, fallback: number): number => {
    const raw = el.getAttribute(name);
    if (!raw) return fallback;
    const value = parseInt(raw, 10);
    return Number.isFinite(value) && value >= 1 ? value : fallback;
  };

  /** 代码块语言识别：data-lang 属性 → class 里的 language-/lang-/highlight-/brush: 前缀 */
  const codeLanguage = (codeEl: Element | null, preEl: Element | null): string => {
    for (const el of [codeEl, preEl]) {
      if (!el || !el.getAttribute) continue;
      const attr = el.getAttribute('data-lang') || el.getAttribute('data-language');
      if (attr) return attr.slice(0, 24);
      const cls = el.getAttribute('class') || '';
      const match = cls.match(/(?:^|\s)(?:language|lang|highlight|brush)(?:[:-])([\w+#.-]+)/);
      if (match) return match[1].replace(/^[.-]+/, '').slice(0, 24);
    }
    return '';
  };

  /** 行内片段收敛：块级子元素产生的多余换行压成单空格（列表项/标题内文用） */
  const cleanInline = (raw: string): string => (raw || '').replace(/\s*\n+\s*/g, ' ').replace(/ {2,}/g, ' ').trim();

  const convertList = (list: Element, ordered: boolean, depth: number): string => {
    if (depth > MAX_LIST_DEPTH) return '';
    let out = '\n';
    let index = ordered ? attrInt(list, 'start', 1) : 0;
    const items = Array.from(list.children).filter((child) => child.tagName === 'LI');
    for (const item of items) {
      if (visited.has(item)) continue;
      visited.add(item);
      // 任务列表：li 直接子级的 checkbox 转为 [x]/[ ]
      let checkbox = '';
      const first = item.firstElementChild;
      if (first && first.tagName === 'INPUT' && (first.getAttribute('type') || '').toLowerCase() === 'checkbox') {
        checkbox = (first as HTMLInputElement).checked ? '[x] ' : '[ ] ';
      }
      let content = '';
      for (const child of Array.from(item.childNodes)) {
        const tag = (child as Element).tagName;
        if (tag === 'UL' || tag === 'OL') continue;
        content += convertNode(child, 0);
      }
      content = cleanInline(content);
      const marker = ordered ? `${index++}. ` : '- ';
      out += '  '.repeat(depth) + marker + checkbox + content + '\n';
      for (const child of Array.from(item.children)) {
        const tag = child.tagName;
        if (tag === 'UL') out += convertList(child, false, depth + 1);
        else if (tag === 'OL') out += convertList(child, true, depth + 1);
      }
    }
    // 计入停止线（嵌套列表会被外层重复累计一次——只会让停止更早，方向安全）
    emittedChars += out.length;
    return out + '\n';
  };

  /**
   * 表格 → 管道表：按 rowspan/colspan 做 grid 还原（内容只落在锚点格，
   * 被跨占的格留空），保证 LLM 读到的列对齐与真实表格一致。
   * 行/单元格/caption 都按 closest 限定归属，嵌套表格的数据不会混入本表。
   */
  const convertTable = (table: Element): string => {
    type Cell = string | null;
    const grid: Cell[][] = [];
    const ensureRow = (row: number) => {
      while (grid.length <= row) grid.push([]);
    };
    const occupied = (row: number, col: number): boolean => {
      const line = grid[row];
      return !!line && line[col] !== undefined && line[col] !== null;
    };
    const rows = Array.from(table.querySelectorAll('tr')).filter((row) => row.closest('table') === table);
    if (rows.length === 0) return '';
    let rowsTruncated = false;
    for (let r = 0; r < rows.length; r++) {
      if (r >= MAX_TABLE_ROWS) { rowsTruncated = true; break; }
      const cells = Array.from(rows[r].querySelectorAll('th,td')).filter((cell) => cell.closest('tr') === rows[r]);
      if (cells.length === 0) continue;
      ensureRow(r);
      let col = 0;
      for (const cell of cells) {
        if (col >= MAX_TABLE_COLS) break;
        while (occupied(r, col) && col < MAX_TABLE_COLS) col++;
        if (col >= MAX_TABLE_COLS) break;
        const colspan = Math.min(attrInt(cell, 'colspan', 1), MAX_TABLE_COLS);
        const rowspan = Math.min(attrInt(cell, 'rowspan', 1), MAX_TABLE_ROWS);
        let text = cleanText(cell.textContent || '');
        if (text.length > MAX_CELL_CHARS) text = safeSlice(text, MAX_CELL_CHARS) + '…';
        text = text.replace(/\|/g, '\\|');
        for (let rr = r; rr < r + rowspan; rr++) {
          ensureRow(rr);
          for (let cc = col; cc < col + colspan; cc++) {
            if (cc >= MAX_TABLE_COLS) break;
            grid[rr][cc] = rr === r && cc === col ? text : '';
          }
        }
        col += colspan;
      }
    }
    const usedRows = grid.filter((line) => line.some((cell) => typeof cell === 'string' && cell !== ''));
    if (usedRows.length === 0) return '';
    let maxCols = 0;
    for (const line of usedRows) {
      for (let c = line.length - 1; c >= 0; c--) {
        if (line[c] !== undefined && line[c] !== null) { maxCols = Math.max(maxCols, c + 1); break; }
      }
    }
    if (maxCols === 0) return '';
    const renderRow = (line: Cell[]): string => {
      const cells: string[] = [];
      for (let c = 0; c < maxCols; c++) {
        const value = line[c];
        cells.push(typeof value === 'string' ? value : '');
      }
      return '| ' + cells.join(' | ') + ' |';
    };
    let out = '\n';
    const caption = Array.from(table.querySelectorAll('caption')).find((cap) => cap.closest('table') === table);
    const captionText = caption ? cleanText(caption.textContent || '') : '';
    if (captionText) out += '**' + captionText + '**\n\n';
    out += renderRow(usedRows[0]) + '\n';
    out += '| ' + Array.from({ length: maxCols }, () => '---').join(' | ') + ' |\n';
    for (let i = 1; i < usedRows.length; i++) out += renderRow(usedRows[i]) + '\n';
    if (rowsTruncated) out += '…［表格行数超限已截断］\n';
    emittedChars += out.length;
    return out + '\n';
  };

  /**
   * 元素语义转换主入口（返回该子树的 Markdown 片段）。
   * shadow 宿主的「渲染子节点」是 shadow 树；语义包装（链接/标题/强调…）
   * 仍按宿主标签套用——带 shadow 的 <a> 依然产出 [text](href)。
   */
  const convertElement = (el: Element, depth: number): string => {
    const tag = el.tagName.toLowerCase();

    if (IGNORED_TAGS.has(tag)) return '';

    // 隐藏检查先于 shadow：隐藏宿主的 shadow 树同样不可见，整棵跳过
    if (isHidden(el)) return '';

    const shadow = shadowOf(el);
    if (shadow) shadowRootsCount.n++;
    const childNodes: Node[] = shadow
      ? Array.from(shadow.childNodes)
      : Array.from(el.childNodes);
    /** 本元素「渲染子节点」的处理入口（深度 +1，与容器遍历口径一致） */
    const inner = (): string => processNodes(childNodes, depth + 1);

    // slot 分发语义：有被分发节点（flatten 含跨层）时取分发内容，
    // 否则用回退子节点（未被占用 slot 的回退内容才实际渲染）
    if (tag === 'slot') {
      let assigned: Node[] = [];
      try {
        assigned = Array.from((el as HTMLSlotElement).assignedNodes({ flatten: true }));
      } catch { /* 非 slot 环境按普通元素 */ }
      if (assigned.length > 0) return processNodes(assigned, depth);
      return processNodes(Array.from(el.childNodes), depth);
    }

    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const level = Number(tag[1]);
        const text = cleanInline(inner());
        return text ? '\n' + '#'.repeat(level) + ' ' + text + '\n\n' : '';
      }
      case 'p': {
        const text = inner().replace(/\s*\n+\s*/g, ' ').replace(/ {2,}/g, ' ').trim();
        return text ? text + '\n\n' : '';
      }
      case 'a': {
        const href = el.getAttribute('href') || '';
        let linkText = cleanInline(inner());
        if (!linkText) linkText = cleanText(el.textContent || '');
        if (!linkText) return '';
        const absolute = href && !/^(javascript|data):/i.test(href) && !href.startsWith('#')
          ? (el as HTMLAnchorElement).href || href
          : '';
        if (absolute && absolute.length <= MAX_URL_CHARS && !absolute.startsWith('data:')) {
          return '[' + linkText + '](' + absolute + ')';
        }
        return linkText;
      }
      case 'strong': case 'b': {
        const text = cleanInline(inner());
        return text ? '**' + text + '**' : '';
      }
      case 'em': case 'i': case 'cite': {
        const text = cleanInline(inner());
        return text ? '*' + text + '*' : '';
      }
      case 'del': case 's': case 'strike': {
        const text = cleanInline(inner());
        return text ? '~~' + text + '~~' : '';
      }
      case 'code': {
        if (el.parentElement && el.parentElement.tagName === 'PRE') return el.textContent || '';
        const text = cleanCode(el.textContent || '').replace(/\s+/g, ' ').trim();
        return text ? '`' + safeSlice(text, 200) + '`' : '';
      }
      case 'pre': {
        const codeEl = el.querySelector('code');
        let codeText = cleanCode((codeEl || el).textContent || '');
        if (codeText.length > MAX_CODE_CHARS) {
          codeText = safeSlice(codeText, MAX_CODE_CHARS) + '\n…［代码超长已截断（共 ' + (el.textContent || '').length + ' 字符）］';
        }
        if (!codeText.trim()) return '';
        const lang = codeLanguage(codeEl, el);
        return '\n```' + lang + '\n' + codeText.replace(/\s+$/g, '') + '\n```\n\n';
      }
      case 'ul': case 'menu':
        return '\n' + convertList(el, false, 0);
      case 'ol':
        return '\n' + convertList(el, true, 0);
      case 'li':
        // li 由 convertList 处理；防御性兜底（li 脱离列表容器时）
        return inner();
      case 'table': return convertTable(el);
      case 'blockquote': {
        const content = inner().trim();
        if (!content) return '';
        return content.split('\n').map((line) => ('> ' + line).trimEnd()).join('\n') + '\n\n';
      }
      case 'hr': return '\n---\n\n';
      case 'br': return '  \n';
      case 'img': {
        const src = el.getAttribute('src') || '';
        if (!src || src.startsWith('data:')) return '';
        // img.src 属性返回解析后的绝对地址
        const absolute = (el as HTMLImageElement).src || src;
        if (absolute.length > MAX_URL_CHARS) return '';
        const alt = cleanText(el.getAttribute('alt') || '') || 'image';
        return '![' + safeSlice(alt, 120) + '](' + absolute + ')';
      }
      case 'button': {
        const text = cleanText(el.textContent || '');
        return text ? ' [' + safeSlice(text, 120) + '] ' : '';
      }
      case 'input': {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox' || type === 'radio' || type === 'hidden' || type === 'file' || type === 'image') {
          return '';
        }
        if (type === 'submit' || type === 'button' || type === 'reset') {
          // 提交/按钮型输入的可见文案在 value 上
          const action = cleanText(el.getAttribute('value') || '');
          return action ? ' [' + safeSlice(action, 120) + '] ' : '';
        }
        if (type === 'password') return ' [密码框] ';
        const label = cleanText(el.getAttribute('placeholder') || el.getAttribute('aria-label') || '');
        return label ? ' [输入框: ' + safeSlice(label, 120) + '] ' : ' [输入框] ';
      }
      case 'textarea': {
        const label = cleanText(el.getAttribute('placeholder') || el.getAttribute('aria-label') || '');
        return label ? ' [文本域: ' + safeSlice(label, 120) + '] ' : ' [文本域] ';
      }
      case 'select': {
        const options = Array.from(el.querySelectorAll('option'));
        if (options.length === 0) return '';
        const shown = options.slice(0, MAX_OPTIONS).map((option) => {
          const text = cleanText(option.textContent || '');
          return (option as HTMLOptionElement).selected ? '「' + text + '」' : text;
        });
        const suffix = options.length > MAX_OPTIONS ? ' …' : '';
        return ' [下拉: ' + shown.join(' | ') + suffix + '] ';
      }
      case 'dl': {
        let out = '\n';
        for (const child of Array.from(el.children)) {
          const childTag = child.tagName.toLowerCase();
          const childText = cleanInline(processNodes(Array.from(child.childNodes), depth + 1));
          if (childTag === 'dt') {
            if (childText) out += '**' + childText + '**\n';
          } else if (childTag === 'dd') {
            if (childText) out += '- ' + childText + '\n';
          } else {
            out += processNodes(Array.from(child.childNodes), depth + 1);
          }
        }
        return out + '\n';
      }
      case 'summary': {
        const text = cleanInline(inner());
        return text ? '\n**' + text + '**\n\n' : '';
      }
      case 'figcaption': {
        const text = cleanInline(inner());
        return text ? '\n*' + text + '*\n\n' : '';
      }
      case 'abbr': {
        const text = cleanText(el.textContent || '');
        const title = cleanText(el.getAttribute('title') || '');
        return title ? text + '（' + safeSlice(title, 80) + '）' : text;
      }
      default:
        return inner();
    }
  };

  const convertNode = (node: Node, depth: number): string => {
    if (emittedChars > EMIT_STOP_CHARS) {
      truncated = true;
      return '';
    }
    if (depth > MAX_DEPTH) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      // 文本节点只收敛空白不 trim——相邻行内元素之间的词间距不能丢
      return cleanText(node.textContent || '', false);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as Element;
    if (visited.has(el)) return '';
    visited.add(el);
    return convertElement(el, depth);
  };

  const processNodes = (nodes: Node[], depth: number): string => {
    let out = '';
    for (const node of nodes) out += convertNode(node, depth);
    emittedChars += out.length;
    return out;
  };

  // ─── 主流程 ──
  try {
    const body = document.body;
    if (!body) {
      return { markdown: '', truncated: false, shadowRoots: 0, url: document.URL || '', title: document.title || '' };
    }
    let markdown = processNodes(Array.from(body.childNodes), 0);

    // 代码围栏之外的空白规整：围栏内保持原样，围栏外行内空格合一、连续空行 ≤1
    const lines = markdown.split('\n');
    const out: string[] = [];
    let inFence = false;
    let blankRun = 0;
    for (const line of lines) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        out.push(line.replace(/\s+$/, ''));
        blankRun = 0;
        continue;
      }
      if (inFence) {
        out.push(line);
        continue;
      }
      if (line.trim() === '') {
        blankRun++;
        if (blankRun <= 1) out.push('');
        continue;
      }
      blankRun = 0;
      out.push(line.replace(/[ \t]+/g, ' ').replace(/\s+$/, ''));
    }
    markdown = out.join('\n').trim();

    if (markdown.length > FRAME_CHAR_LIMIT) {
      markdown = safeSlice(markdown, FRAME_CHAR_LIMIT) + '\n\n…［本 frame 内容超长已截断］';
      truncated = true;
    }
    return {
      markdown,
      truncated,
      shadowRoots: shadowRootsCount.n,
      url: document.URL || '',
      title: document.title || '',
    };
  } catch (error) {
    return {
      markdown: '',
      truncated: false,
      shadowRoots: shadowRootsCount.n,
      url: (typeof document !== 'undefined' && document.URL) || '',
      title: (typeof document !== 'undefined' && document.title) || '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
