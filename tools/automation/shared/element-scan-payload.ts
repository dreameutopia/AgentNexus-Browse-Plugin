/**
 * 可交互元素扫描荷载（browser_observe 共用）
 *
 * ⚠️ 注入约束：`chrome.scripting.executeScript({ func })` 会把函数源码序列化后
 * 注入页面执行，闭包与模块作用域不会随之带入。因此 `elementScanPayload` 必须
 * **完全自包含**：函数体内只能引用自身参数、自身声明的嵌套声明与页面全局对象，
 * 绝不能引用任何模块级常量/辅助函数（注入后将抛 ReferenceError）。
 * 同理，调用方只能直接传本函数引用 + 显式 args，不能用 .bind / 箭头包装代理
 * （包装函数序列化后会引用外部函数名）。
 *
 * browser_observe 通过 `mode` 参数选择观察范围：
 * - 'controls'：合并按钮与输入；'structure'：结构、状态与滚动容器；
 * - 'buttons'：按钮/链接/勾选框等可点击元素（含下载特征识别）；
 * - 'inputs'：文本框/textarea/下拉框/富文本区等可输入元素（含富文本识别）；
 * - 'registry'（内部）：只保证完整引用注册表就位即返回，不扫描 DOM。
 *
 * 共享部分（节点引用生成、可见性与遮挡判定、xpath 祖先链命中、过滤标记、排序）
 * 只存在一份；模式差异（采集范围、描述提取链、类型映射、评分权重、截断规则）
 * 由统一节点注册与交付前校验保证定位链路一致。
 */

/** 扫描模式：按钮/链接 或 输入元素 */
import type {
  ReferenceDocument,
  ElementReferenceRegistry,
  ControlSemantics,
} from './element-reference';
export type ScanMode =
  | 'controls'
  | 'buttons'
  | 'inputs'
  | 'structure'
  | 'form'
  | 'registry';

/** 注入脚本返回的元素记录（frameId 由宿主侧补写） */
export interface PayloadElement {
  type: string;
  description: string;
  context: string;
  elementId: string;
  score: number;
  details?: Record<string, unknown>;
  semantics?: ControlSemantics;
  /** 是否命中 regex 过滤（未启用 regex 时为 null） */
  matchedRegex: boolean | null;
  /** 是否命中 xpath 过滤（未启用 xpath 时为 null） */
  matchedXpath: boolean | null;
  /** 是否命中全部已启用的过滤条件（命中者在结果中置顶并标记 ✓） */
  isHit: boolean;
  /** 仅 buttons 模式：标记是否为下载/导出按钮 */
  isDownload?: boolean;
  /** 仅 form 模式：文档坐标（top + scrollY），宿主据此按表单阅读顺序排序与分组 */
  y?: number;
}

/** 注入脚本返回结果 */
export interface PayloadResult {
  elements: PayloadElement[];
  /** Document nonce + action revision + URL; pagination freezes membership rather than re-sorting live DOM. */
  fingerprint?: string;
  error?: string;
  truncated?: boolean;
  truncationReason?: string;
  /**
   * 父容器作用域在本 frame 未命中（选择器合法、容器不在这个 frame）。
   * **不是错误**：多 frame 页面里子 frame 没有目标容器是常态——宿主把它静默
   * 计入成员（fingerprint 照常回传，避免每次验证都误报 NEW_FRAME），只有
   * **所有**已扫描 frame 都未命中时才由宿主升级为 PARENT_CONTAINER_NOT_FOUND。
   */
  containerMiss?: boolean;
}

/**
 * 荷载函数入口（被注入到每个 frame 中独立执行）
 * 先按模式收集可交互元素，再按 regex（描述文本正则）与 xpath（元素/祖先命中）
 * 做过滤标记，命中全部已启用条件的元素排在最前。
 */
export function elementScanPayload(
  mode: ScanMode,
  regexSource: string,
  xpathExpr: string,
  tabId = 0,
  parentSelector = '',
  parentXPath = '',
): PayloadResult {
  const scanStarted = performance.now();
  let truncated = false;
  let scanWarning: string | undefined;
  const overBudget = () => {
    if (performance.now() - scanStarted > 2000) { truncated = true; return true; }
    return false;
  };
  // Persist only in the extension isolated world; never add attributes to page DOM.
  const shadowOf = (el: Element): ShadowRoot | null => {
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
  const contextOf = (el: Element): string => {
    const semantic = el.closest(
      'tr, li, [role="row"], fieldset, [role="dialog"], form',
    );
    const container =
      semantic ||
      (el.parentElement === document.body ? null : el.parentElement);
    const text = (container?.textContent || '').trim().replace(/\s+/g, ' ');
    return !semantic && text.length > 180 ? '' : text.slice(0, 180);
  };
  const refDocument = document as ReferenceDocument;
  const semanticVersion = 3;
  let registry = refDocument.__agentNexusReferences;
  const rendered = (element: Element): boolean => {
    if (!element.isConnected || !document.body) return false;
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    let opacity = 1;
    let node: Element | null = element;
    for (let depth=0; node && depth<256; depth++) {
      const current = window.getComputedStyle(node);
      if (current.display === 'none' || current.contentVisibility === 'hidden') return false;
      const alpha = Number.parseFloat(current.opacity);
      opacity *= Number.isFinite(alpha) ? alpha : 1;
      if (opacity < 0.1) return false;
      node = node.assignedSlot || node.parentElement || (node.getRootNode() as ShadowRoot).host || null;
    }
    if (node) return false;
    const rect = element.getBoundingClientRect();
    return rect.width >= 1 && rect.height >= 1 && element.getClientRects().length > 0;
  };
  if (!registry || !registry.describe || registry.semanticVersion !== semanticVersion) {
    // randomUUID is restricted to secure contexts; getRandomValues also works on
    // HTTP/local-device pages, which are valid automation targets.
    const nonce = Array.from(
      window.crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    let counter = 0;
    let revision = 0;
    const entries = new Map<
      string,
      {
        node: WeakRef<Element>;
        /** 身份签名（硬失效） */
        identity: string;
        /** 记录签名（硬失效：虚拟行复用防线） */
        record: string;
        /** 上下文摘要（软信号：变了只提示，不失效） */
        context: string;
        /** 重绑定线索：节点被替换后据此找回等价元素 */
        locator: LocatorHint;
        expires: number;
        url: string;
      }
    >();
    const nodes = new WeakMap<Element, string>();
    /**
     * 身份属性：元素**自身**的稳定标识。
     *
     * 刻意排除**状态类**属性：value / checked / selected / disabled / readonly /
     * required 与 aria-checked / aria-selected / aria-expanded / aria-pressed /
     * aria-current / aria-invalid / aria-busy / aria-describedby /
     * aria-errormessage / data-state。
     *
     * 排除的理由是硬性的：这些属性描述的是「控件现在处于什么状态」，而不是
     * 「这是谁」。把它们写进身份，等于让控件**自己作废自己的引用**——
     * set_checked 勾上后 aria-checked 翻转 → 身份漂移 → 下一次操作被判
     * STALE_ELEMENT；输入框打字后 value 变化 → 同样的自伤。真实站点上这会让
     * 「操作 → 回读 → 再操作」这种最常见的闭环彻底不可用。
     */
    const IDENTITY_ATTR_PATTERN =
      /^(id|name|type|role|href|title|placeholder|contenteditable|multiple|aria-label|aria-labelledby|data-id|data-key|data-value|data-testid|data-role|data-name)$/;
    /**
     * 记录级属性：祖先链上用于标识「属于哪一行/哪个记录」的属性。
     *
     * 含**位置类** aria（aria-rowindex / aria-colindex / aria-posinset /
     * aria-setsize 等）：它们标识记录在结果集中的位置，是虚拟行复用的判据
     * （行被复用时位置号改变 → 旧引用必须失效）。刻意不含 aria-busy /
     * aria-invalid / aria-expanded 这类**瞬时状态**——它们一变就失效会让
     * 正常控件被误判。
     */
    const RECORD_ATTR_PATTERN =
      /^(id|name|role|aria-rowindex|aria-colindex|aria-rowcount|aria-colcount|aria-posinset|aria-setsize|data-id|data-key|data-record-id|data-row-id|data-index|data-testid)$/;
    const attributesOf = (el: Element, pattern: RegExp): string =>
      JSON.stringify(
        Array.from(el.attributes)
          .filter((a) => pattern.test(a.name))
          .map((a) => [a.name, a.value])
          .sort((a, b) => a[0].localeCompare(b[0])),
      );
    const attributes = (el: Element): string => attributesOf(el, IDENTITY_ATTR_PATTERN);
    /**
     * 控件宿主解析：状态与激活行为真正所属的节点。
     *
     * 规则（顺序即优先级）：
     *   1. <label> → label.control（必须是 input[type=checkbox|radio]）
     *   2. role=checkbox|radio|switch 的元素 → 其最近后代 input[type=checkbox|radio]
     *   3. 其余 → 元素自身（永不返回 null，调用方无需再做空值回退）
     *
     * 为什么必须解析：自定义复选框的可见表面是 label/包装器，状态住在 input 上。
     * 读状态要读 control；写操作要作用在**只触发一次**的节点上——点 label 会把
     * 点击转发给控件，控件的 click 又冒泡回 label，导致处理器被调用两次、
     * toggle 净效果为零。
     */
    const controlOf = (el: Element): Element => {
      if (el.localName === 'label') {
        const control = (el as HTMLLabelElement).control;
        if (
          control &&
          control.localName === 'input' &&
          ['checkbox', 'radio'].includes((control as HTMLInputElement).type)
        )
          return control;
        // label 未关联 checkbox/radio 控件：它自己就是操作表面（点击聚焦关联控件）
        return el;
      }
      const role = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
      if (['checkbox', 'radio', 'switch', 'toggle'].includes(role)) {
        const inner = el.querySelector(
          'input[type="checkbox"],input[type="radio"]',
        ) as HTMLInputElement | null;
        if (inner) return inner;
      }
      return el;
    };
    /**
     * 身份签名：元素自身。变了 → 目标可能已是另一个控件（IDENTITY_DRIFT，硬失效）。
     */
    const identitySignature = (el: Element): string => {
      const input =
        ['input', 'textarea', 'select'].includes(el.localName) ||
        (el as HTMLElement).isContentEditable;
      const labels = Array.from((el as HTMLInputElement).labels || []).map(
        (label) => label.textContent,
      );
      const root = el.getRootNode() as Document | ShadowRoot;
      const namedBy = (el.getAttribute('aria-labelledby') || '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => root.getElementById?.(id)?.textContent || '');
      return JSON.stringify([
        el.namespaceURI,
        el.localName,
        attributes(el),
        input ? '' : el.textContent,
        labels,
        namedBy,
      ]);
    };
    /**
     * 记录签名：元素在记录/行中的归属。
     *
     * 这一层**必须**保留：虚拟表格会复用 DOM 行，旧引用若不被拦下就会误指到
     * 复用后的新行（见 tests/tools/complex-controls.test.ts 的虚拟行复用防御）。
     * 与旧签名不同，这里只取祖先链上的**记录标识属性**与 recordOwner 文本，
     * 不再把祖先的自由文本与 aria-* 状态属性算进来。
     */
    const recordSignature = (el: Element): string => {
      const ancestors: string[] = [];
      const parentOf = (node: Element): Element | null =>
        node.parentElement || (node.getRootNode() as ShadowRoot).host || null;
      let parent = parentOf(el);
      for (
        let depth = 0;
        parent && depth < 8;
        depth++, parent = parentOf(parent)
      ) {
        ancestors.push(parent.localName + attributesOf(parent, RECORD_ATTR_PATTERN));
        if (parent.matches('tr, li, [role="row"], [data-id], [data-key]')) {
          ancestors.push(parent.textContent || '');
          break;
        }
      }
      const recordOwner = el.closest('tr,[role="row"],li,[data-id],[data-key]');
      return JSON.stringify([
        ancestors,
        recordOwner
          ? [
              recordOwner.localName,
              attributesOf(recordOwner, RECORD_ATTR_PATTERN),
              recordOwner.textContent,
            ]
          : null,
      ]);
    };
    /**
     * 上下文签名：自由文本摘要（所在 <form>/容器的文本）。
     *
     * 这一层**不再参与失效判定**——它是「周边内容变了」的信号，不是「这个元素
     * 换了」的证据。真实页面上校验文案、聊天挂件、计数器都会改它，把它算进
     * 硬失效会让一个完全可点的元素被反复判死。
     */
    const contextSignature = (el: Element): string => contextOf(el);
    const resolveDetailed = (
      id: string,
    ): {
      element: Element | null;
      reason:
        | 'NOT_FOUND'
        | 'EXPIRED'
        | 'DOCUMENT_CHANGED'
        | 'DISCONNECTED'
        | 'IDENTITY_DRIFT'
        | 'CONTEXT_CHANGED'
        | null;
      contextChanged: boolean;
    } => {
      const entry = entries.get(id);
      if (!entry) return { element: null, reason: 'NOT_FOUND', contextChanged: false };
      const el = entry.node.deref();
      if (!el) { entries.delete(id); return { element: null, reason: 'NOT_FOUND', contextChanged: false }; }
      if (entry.expires <= Date.now()) {
        // 过期即删除：引用不会「续期」，留着只会让 rebind 误以为还有线索
        entries.delete(id);
        return { element: null, reason: 'EXPIRED', contextChanged: false };
      }
      if (entry.url !== document.URL) {
        entries.delete(id);
        return { element: null, reason: 'DOCUMENT_CHANGED', contextChanged: false };
      }
      if (!el.isConnected || el.ownerDocument !== document)
        return { element: null, reason: 'DISCONNECTED', contextChanged: false };
      const currentIdentity = identitySignature(el);
      if (currentIdentity !== entry.identity) {
        entries.delete(id);
        return { element: null, reason: 'IDENTITY_DRIFT', contextChanged: false };
      }
      const currentRecord = recordSignature(el);
      if (currentRecord !== entry.record) {
        entries.delete(id);
        return { element: null, reason: 'CONTEXT_CHANGED', contextChanged: false };
      }
      return {
        element: el,
        reason: null,
        contextChanged: contextSignature(el) !== entry.context,
      };
    };
    const resolve = (id: string): Element | null => resolveDetailed(id).element;
    /**
     * 定位线索：元素被重渲染替换后，用来重新找到「同一个东西」的路标。
     *
     * 优先级：稳定 id → data-testid/data-id/data-key → 结构路径。
     * 路径用「同标签兄弟中的序号」表示（而非完整 CSS 选择器），避免类名里的
     * 哈希后缀在重渲染后变化导致线索失效。
     *
     * 结构路径**必须能穿过 shadow root**：自定义控件大量住在影子 DOM 里，
     * 只按 light DOM 路径下钻会永远找不到候选，重绑定形同虚设。
     */
    type LocatorStep = {
      /** 在当前层里找同标签的第 index 个孩子 */
      tag: string;
      index: number;
      /** 落到该元素后，是否继续进入它的 shadow root */
      intoShadow: boolean;
    };
    type LocatorHint =
      | { kind: 'id'; value: string }
      | { kind: 'attr'; attr: string; value: string }
      | { kind: 'path'; steps: LocatorStep[] };
    const locatorOf = (el: Element): LocatorHint => {
      if (el.id) return { kind: 'id', value: el.id };
      for (const attr of ['data-testid', 'data-id', 'data-key']) {
        const value = el.getAttribute(attr);
        if (value) return { kind: 'attr', attr, value };
      }
      const steps: LocatorStep[] = [];
      let node: Element | null = el;
      // 上限 16 层：再深的结构用路径也不稳，宁可放弃重绑定
      for (let depth = 0; node && depth < 16; depth++) {
        const parent: Element | null = node.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter(
            (child) => child.localName === node!.localName,
          );
          steps.unshift({
            tag: node.localName,
            index: Math.max(0, sameTag.indexOf(node)),
            intoShadow: false,
          });
          node = parent;
          continue;
        }
        // 没有 parentElement ⇒ 节点位于某个 shadow root 内（或是根本身）。
        // 记录「进入 host 的影子树」这一步，再从 host 继续往上走。
        const root = node.getRootNode() as ShadowRoot;
        const host: Element | null =
          root && 'host' in root ? ((root as unknown as { host: Element }).host ?? null) : null;
        if (!host) {
          steps.unshift({ tag: node.localName, index: 0, intoShadow: false });
          break;
        }
        const hostParent: Element | null = host.parentElement;
        const hostSiblings = hostParent
          ? Array.from(hostParent.children).filter(
              (child) => child.localName === host.localName,
            )
          : [];
        steps.unshift({
          tag: host.localName,
          index: Math.max(0, hostSiblings.indexOf(host)),
          intoShadow: true,
        });
        node = hostParent;
      }
      return { kind: 'path', steps };
    };
    /** 按定位线索找出候选节点（不保证唯一，调用方负责唯一性判定）。 */
    const candidatesFor = (hint: LocatorHint): Element[] => {
      if (hint.kind === 'id') {
        const found = document.getElementById(hint.value);
        return found ? [found] : [];
      }
      if (hint.kind === 'attr') {
        return Array.from(
          document.querySelectorAll(`[${hint.attr}="${CSS.escape(hint.value)}"]`),
        );
      }
      // path：从 documentElement 逐层下钻（可穿影子树）
      // current 既可能是 Element 也可能是 ShadowRoot——两者都有 children，
      // 影子树里的元素只有在这一层才能被找到。
      let current: Element | ShadowRoot | null = document.documentElement;
      for (const step of hint.steps) {
        if (!current) return [];
        const sameTag: Element[] = Array.from(current.children).filter(
          (child) => child.localName === step.tag,
        );
        const next: Element | undefined = sameTag[step.index];
        if (!next) return [];
        if (!step.intoShadow) {
          current = next;
          continue;
        }
        // 进入影子树：shadowOf 可能返回 null（宿主已无影子根）
        current = shadowOf(next);
        if (!current) return [];
      }
      // 终点应当是 Element（路径的最后一步指向具体元素）
      return current && current.nodeType === 1
        ? [current as unknown as Element]
        : [];
    };
    /**
     * 重绑定：元素被应用重渲染替换后，找出**唯一**的等价替代节点。
     *
     * 框架常在 mousedown/pointerdown 后重建 DOM（换掉按钮节点）。旧实现此时
     * 直接报「元素已失效」并**放弃已派发的事件**——用户看到的是「点了没反应」。
     * 重绑定让操作能落到重建后的等价节点上。
     *
     * 严格唯一：候选多于一个时返回 null——页面里常有多个同名按钮（「删除」、
     * 「投递」），此时宁可不操作也不能猜错目标。
     */
    const rebind = (id: string): Element | null => {
      const entry = entries.get(id);
      if (!entry) return null;
      const old = entry.node.deref();
      const hint = entry.locator;
      const candidates = candidatesFor(hint).filter(
        (candidate) =>
          candidate !== old &&
          candidate.isConnected &&
          candidate.ownerDocument === document &&
          // 候选必须仍满足同一身份（属性/文本在重渲染后可能又变了）
          identitySignature(candidate) === entry.identity,
      );
      return candidates.length === 1 ? candidates[0] : null;
    };
    registry = {
      semanticVersion,
      isRendered: rendered,
      describe(el): ControlSemantics {
        const native = el as HTMLInputElement;
        const tag = el.localName;
        const role = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
        const root = el.getRootNode() as Document | ShadowRoot;
        const textOf = (node: Element) =>
          (
            (node.getAttribute('aria-labelledby') || '')
              .split(/\s+/)
              .map((id) => root.getElementById?.(id)?.textContent || '')
              .join(' ')
              .trim() ||
            node.getAttribute('aria-label') ||
            Array.from((node as HTMLInputElement).labels || [])
              .map((l) => l.textContent)
              .join(' ') ||
            node.getAttribute('title') ||
            node.getAttribute('placeholder') ||
            node.textContent ||
            ''
          )
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 300);
        const name = textOf(el);
        if (tag === 'label') {
          const control = (el as HTMLLabelElement).control;
          if (
            control &&
            control.localName === 'input' &&
            ['checkbox', 'radio'].includes((control as HTMLInputElement).type)
          ) {
            const semantics = registry!.describe!(control);
            const controlElementId = registry!.register(control);
            return {
              ...semantics,
              name: name || semantics.name,
              role: 'label',
              evidence: 'label-control',
              actions: semantics.states.disabled
                ? []
                : ['click', ...(semantics.actions.includes('set_checked') ? ['set_checked'] : [])],
              // 状态宿主（隐藏 input）的引用与可见性提到**顶层**——模型不必去解析
              // relations 就能知道「这行是可见表面，状态住在另一个节点上」。
              controlElementId,
              controlRendered: rendered(control),
              controlIsSeparate: true,
              relations: [
                {
                  relation: 'label-control',
                  elementId: controlElementId,
                  role: control.localName,
                  name: semantics.name,
                },
              ],
            };
          }
        }
        const roles: Record<string, string> = {
          checkbox: 'checkbox',
          radio: 'radio',
          switch: 'switch',
          combobox: 'combobox',
          listbox: 'listbox',
          option: 'option',
          menu: 'menu',
          menubar: 'menu',
          menuitem: 'menuitem',
          menuitemcheckbox: 'checkbox',
          menuitemradio: 'radio',
          tab: 'tab',
          tablist: 'tablist',
          tree: 'tree',
          treeitem: 'treeitem',
          treegrid: 'grid',
          grid: 'grid',
          gridcell: 'gridcell',
          row: 'row', table: 'table', cell: 'cell', columnheader: 'columnheader', rowheader: 'rowheader', tabpanel: 'tabpanel',
          radiogroup: 'group',
          group: 'group',
          dialog: 'dialog',
          alertdialog: 'dialog',
          slider: 'slider',
          spinbutton: 'spinbutton',
          textbox: 'text',
          searchbox: 'search',
          button: 'button',
          link: 'link',
          toolbar: 'toolbar',
          tooltip: 'tooltip',
          status: 'status',
          alert: 'status',
          log: 'status',
          progressbar: 'progress',
          meter: 'meter',
          separator: 'separator',
        };
        let category = roles[role] || 'element';
        let evidence = roles[role] ? 'aria-role' : 'generic';
        if (tag === 'input') {
          const type = native.type;
          category = [
            'checkbox',
            'radio',
            'range',
            'color',
            'number',
            'file',
            'password',
            'search',
          ].includes(type)
            ? { range: 'slider' }[type] || type
            : ['date', 'datetime-local', 'month', 'week'].includes(type)
              ? 'date'
              : type === 'time'
                ? 'time'
                : ['button', 'submit', 'reset', 'image'].includes(type)
                  ? 'button'
                  : 'text';
          if (role === 'combobox' || role === 'spinbutton' || role === 'switch')
            category = roles[role];
          evidence = 'native';
        } else if (tag === 'select') {
          category = (el as HTMLSelectElement).multiple
            ? 'multiselect'
            : 'select';
          evidence = 'native';
        } else if (tag === 'textarea') {
          category = 'text';
          evidence = 'native';
        } else if ((el as HTMLElement).isContentEditable) {
          category = 'editor';
          evidence = 'native';
        } else if (tag === 'summary') {
          category = 'disclosure';
          evidence = 'native';
        } else if (tag === 'dialog') {
          category = 'dialog';
          evidence = 'native';
        } else if (tag === 'button' && category === 'element') {
          category = 'button';
          evidence = 'native';
        } else if (tag === 'a' && el.hasAttribute('href')) {
          category = 'link';
          evidence = 'native';
        } else if (['table','tr','td','th','progress','meter','output','fieldset'].includes(tag) && !roles[role]) {
          category = ({table:'table',tr:'row',td:'cell',th:['row','rowgroup'].includes(el.getAttribute('scope') || '') ? 'rowheader' : 'columnheader',progress:'progress',meter:'meter',output:'status',fieldset:'group'} as Record<string,string>)[tag];
          evidence = 'native';
        }
        const patterns: string[] = [];
        if (el.closest('[data-calendar],[data-slot="calendar"],[data-slot="range-calendar"],[data-slot="calendar-grid"]')) patterns.push('calendar');
        if (el.closest('[data-date-range],[data-slot="date-range-picker"],[data-slot="date-range-field"],[data-slot="range-calendar"]')) patterns.push('date-range');
        if (el.closest('[data-time-range]')) patterns.push('time-range');
        const segment = el.getAttribute('data-type') || el.getAttribute('data-segment');
        if (role === 'spinbutton' && segment && ['year','month','day','hour','minute','second','dayPeriod','era','timeZoneName'].includes(segment)) patterns.push('date-segment');
        if (category === 'button' && el.hasAttribute('aria-pressed'))
          category = 'toggle';
        if (
          category === 'button' &&
          el.hasAttribute('aria-expanded') &&
          !el.hasAttribute('aria-haspopup')
        )
          category = 'disclosure';
        if (
          category === 'listbox' &&
          el.getAttribute('aria-multiselectable') === 'true'
        )
          category = 'multiselect';
        const closeName =
          /^(?:(?:close|dismiss)(?:\s+(?:dialog|modal|popup|popover|menu|notification|toast|panel|window|button))?|(?:关闭|關閉)(?:弹窗|彈窗|对话框|對話框|窗口|视窗|視窗|面板|菜单|選單|通知)?|×|✕|✖)$/i.test(
            name,
          );
        const closeToken = /(?:^|[\s_-])(?:close|dismiss)(?:$|[\s_-])/i.test(
          [
            el.getAttribute('class'),
            el.getAttribute('data-testid'),
            el.getAttribute('data-action'),
          ]
            .join(' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2'),
        );
        if (
          ['button', 'element'].includes(category) &&
          (closeName || closeToken) &&
          (tag === 'button' ||
            role === 'button' ||
            el.hasAttribute('onclick') ||
            el.hasAttribute('tabindex') ||
            window.getComputedStyle(el).cursor === 'pointer')
        ) {
          category = 'close';
          evidence = closeName ? 'name' : 'attribute-hint';
        }
        if (
          category === 'element' &&
          (el.hasAttribute('onclick') ||
            window.getComputedStyle(el).cursor === 'pointer')
        ) {
          category = 'button';
          evidence = 'interaction-hint';
        }
        if (
          category === 'element' &&
          (el.scrollHeight > el.clientHeight + 1 ||
            el.scrollWidth > el.clientWidth + 1)
        )
          category = 'scroll';
        let inheritedDisabled = false;
        let inheritedReadonly = false;
        let ancestor: Element | null = el;
        for (let depth = 0; ancestor && depth < 256; depth++) {
          inheritedDisabled ||= ancestor.matches(
            '[inert],[aria-disabled="true"],[data-disabled]:not([data-disabled="false"])',
          );
          inheritedReadonly ||= ancestor.matches('[aria-readonly="true"]');
          ancestor =
            ancestor.parentElement ||
            (ancestor.getRootNode() as ShadowRoot).host ||
            null;
        }
        const states: Record<string, unknown> = {
          disabled: el.matches(':disabled') || inheritedDisabled,
          readonly: el.matches('[readonly]') || inheritedReadonly,
        };
        for (const attr of [
          'checked',
          'selected',
          'expanded',
          'pressed',
          'required',
          'invalid',
          'busy',
          'multiselectable',
          'haspopup',
          'autocomplete',
          'orientation',
          'valuemin',
          'valuemax',
          'valuenow',
          'valuetext',
          'level',
          'posinset',
          'setsize',
          'current',
          'modal',
          'rowindex', 'colindex', 'rowcount', 'colcount', 'rowspan', 'colspan', 'sort', 'roledescription', 'description', 'keyshortcuts',
        ]) {
          const value = el.getAttribute('aria-' + attr);
          if (value !== null)
            states[attr] =
              value === 'true' ? true : value === 'false' ? false : value.slice(0,500);
        }
        if (tag === 'input' && ['checkbox', 'radio'].includes(native.type)) {
          states.checked = native.indeterminate ? 'mixed' : native.checked;
          states.indeterminate = native.indeterminate;
        }
        /**
         * role 包装器内含原生控件时的状态回退。
         *
         * 形如 `<div role="checkbox"><input type="checkbox"></div>` 的自定义控件很
         * 常见：包装器没有 aria-checked，状态只在内层 input 上。若不回落，
         * states.checked 会是 undefined → set_checked 报 UNOBSERVABLE_STATE，
         * 而控件其实完全可读可写。
         */
        if (
          states.checked === undefined &&
          ['checkbox', 'radio', 'switch', 'toggle'].includes(category) &&
          tag !== 'input'
        ) {
          const inner = el.querySelector(
            'input[type="checkbox"],input[type="radio"]',
          ) as HTMLInputElement | null;
          if (inner) {
            states.checked = inner.indeterminate ? 'mixed' : inner.checked;
            states.indeterminate = inner.indeterminate;
            states.controlIsInner = true;
          }
        }
        if ('required' in el)
          states.required = !!native.required || states.required === true;
        if (el.hasAttribute('name')) states.name = el.getAttribute('name')!.slice(0,500);
        if (
          'value' in el &&
          native.type !== 'password' &&
          native.type !== 'hidden'
        ) {
          states.value = String(native.value).slice(0, 500);
          states.valueTruncated = String(native.value).length > 500;
        }
        if (tag === 'input') states.inputType = native.type;
        if (native.validity) {
          states.valid = native.validity.valid;
          if (!native.validity.valid) {
            states.validation = Object.fromEntries(['valueMissing','typeMismatch','patternMismatch','tooLong','tooShort','rangeUnderflow','rangeOverflow','stepMismatch','badInput','customError']
              .filter(key => (native.validity as unknown as Record<string,boolean>)[key]).map(key => [key,true]));
            if (!['password','hidden'].includes(native.type)) states.validationMessage = native.validationMessage.slice(0,300);
          }
        }
        if (patterns.includes('date-segment')) states.segment = segment;
        for (const attr of ['datetime','data-date','data-start','data-end','data-range-start','data-range-end']) {
          if (el.hasAttribute(attr)) states[attr] = el.getAttribute(attr)!.slice(0, 200);
        }
        if (['td','th'].includes(tag)) {
          states.rowspan = (el as HTMLTableCellElement).rowSpan;
          states.colspan = (el as HTMLTableCellElement).colSpan;
          states.domCellIndex = (el as HTMLTableCellElement).cellIndex;
        }
        if (tag === 'tr') states.domRowIndex = (el as HTMLTableRowElement).rowIndex;
        if (tag === 'table') states.domRowCount = (el as HTMLTableElement).rows.length;
        if (tag === 'progress') { states.valuemax = (el as HTMLProgressElement).max; states.indeterminate = !el.hasAttribute('value'); }
        if (tag === 'meter') for (const key of ['min','max','low','high','optimum'] as const) states[key] = (el as HTMLMeterElement)[key];
        for (const attr of [
          'min',
          'max',
          'step',
          'pattern',
          'maxlength',
          'minlength',
          'accept',
        ])
          if (el.hasAttribute(attr))
            states[attr] = el.getAttribute(attr)!.slice(0, 500);
        if (tag === 'select') {
          const select = el as HTMLSelectElement;
          states.multiple = select.multiple;
          states.selectedValues = Array.from(select.selectedOptions)
            .slice(0, 100)
            .map((o) => o.value.slice(0, 500));
          states.selectedValuesTruncated =
            select.selectedOptions.length > 100 ||
            Array.from(select.selectedOptions).some(
              (o) => o.value.length > 500,
            );
          states.optionsTruncated = select.options.length > 100;
          states.options = Array.from(select.options)
            .slice(0, 100)
            .map((o) => ({
              value: o.value.slice(0, 500),
              text: o.text.slice(0, 500),
              valueTruncated: o.value.length > 500,
              textTruncated: o.text.length > 500,
              selected: o.selected,
              disabled: o.disabled || !!o.closest('optgroup[disabled]'),
            }));
        }
        if (tag === 'option') {
          states.selected = (el as HTMLOptionElement).selected;
          states.disabled =
            el.matches(':disabled') || !!el.closest('optgroup[disabled]');
        }
        // Framework attributes are supplementary evidence, never inferred from CSS alone.
        const frameworkState = el.getAttribute('data-state');
        if (frameworkState !== null)
          states.frameworkState = frameworkState.slice(0, 100);
        const headlessState = (
          el.getAttribute('data-headlessui-state') || ''
        ).split(/\s+/);
        if (
          ['option', 'tab', 'treeitem'].includes(category) &&
          states.selected === undefined
        ) {
          if (el.hasAttribute('data-selected'))
            states.selected = el.getAttribute('data-selected') !== 'false';
          else if (el.hasAttribute('data-headlessui-state'))
            states.selected = headlessState.includes('selected');
        }
        if (
          states.expanded === undefined &&
          (role === 'combobox' || el.hasAttribute('aria-haspopup'))
        ) {
          if (['open', 'closed'].includes(frameworkState || ''))
            states.expanded = frameworkState === 'open';
          else if (el.hasAttribute('data-headlessui-state'))
            states.expanded = headlessState.includes('open');
        }
        if (
          ['checkbox', 'radio', 'switch', 'toggle'].includes(category) &&
          states.checked === undefined &&
          states.pressed === undefined
        ) {
          if (
            ['checked', 'unchecked', 'indeterminate'].includes(
              frameworkState || '',
            )
          )
            states.checked =
              frameworkState === 'indeterminate'
                ? 'mixed'
                : frameworkState === 'checked';
        }
        if (tag === 'input' && native.list) {
          states.suggestions = Array.from(native.list.options)
            .slice(0, 100)
            .map((o) => ({
              value: o.value.slice(0, 500),
              label: o.label.slice(0, 500),
              valueTruncated: o.value.length > 500,
              labelTruncated: o.label.length > 500,
            }));
          states.suggestionsTruncated = native.list.options.length > 100;
          if (category === 'text' || category === 'search')
            category = 'combobox';
        }
        if (tag === 'summary')
          states.expanded = el.parentElement?.hasAttribute('open') || false;
        if (tag === 'dialog') states.open = el.hasAttribute('open');
        const relations: ControlSemantics['relations'] = [];
        if (el.matches('[data-date-range],[data-time-range],[data-slot="date-range-picker"],[data-slot="date-range-field"]')) {
          const fields = Array.from(el.querySelectorAll('input,[role="spinbutton"]')).filter(field =>
            !field.matches('input[type="password"],input[type="hidden"]') &&
            field.closest('[data-date-range],[data-time-range],[data-slot="date-range-picker"],[data-slot="date-range-field"]') === el);
          states.fieldsTruncated = fields.length > 20;
          states.fields = fields.slice(0,20).map(field => ({elementId:registry!.register(field),role:field.getAttribute('role') || field.localName,
            name:textOf(field),type:field.getAttribute('type'),segment:field.getAttribute('data-type') || field.getAttribute('data-segment'),
            value:'value' in field ? String((field as HTMLInputElement).value).slice(0,200) : undefined}));
        }
        if (tag === 'input' && native.list)
          relations.push({
            relation: 'list',
            elementId: registry!.register(native.list),
            role: 'datalist',
            name: textOf(native.list),
          });
        const dialog = el.closest(
          'dialog,[role="dialog"],[role="alertdialog"]',
        );
        if (dialog && dialog !== el)
          relations.push({
            relation: 'dialog',
            elementId: registry!.register(dialog),
            role: dialog.getAttribute('role') || 'dialog',
            name: textOf(dialog),
          });
        for (const attr of [
          'controls',
          'owns',
          'activedescendant',
          'describedby',
          'errormessage',
          'details',
          'headers',
        ]) {
          for (const id of (el.getAttribute(attr === 'headers' ? 'headers' : 'aria-' + attr) || '')
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 20)) {
            const targets = root.querySelectorAll('#' + CSS.escape(id));
            const target = targets.length === 1 ? targets[0] : null;
            if (targets.length > 1) {
              const warnings = (states.relationWarnings ||= []) as unknown[];
              warnings.push({relation:attr,id:id.slice(0,100),reason:'duplicate_id'});
            }
            if (target && target !== el)
              relations.push({
                relation: attr,
                elementId: registry!.register(target),
                role: target.getAttribute('role') || target.localName,
                name: textOf(target),
              });
          }
        }
        const group = el.closest(
          '[role="listbox"],[role="radiogroup"],[role="tree"],[role="menu"],[role="tablist"],[role="grid"],[role="treegrid"],table,fieldset',
        );
        if (group && group !== el && group.hasAttribute('aria-multiselectable')) states.multiselectable = group.getAttribute('aria-multiselectable') === 'true';
        if (group && group !== el)
          relations.push({
            relation: 'group',
            elementId: registry!.register(group),
            role: group.getAttribute('role') || group.localName,
            name: textOf(group),
          });
        const focusable = el.matches('input:not([type="hidden"]),textarea,select,button,a[href],area[href],summary,[tabindex]') || (el as HTMLElement).isContentEditable;
        const actions: string[] = states.disabled || !focusable ? [] : ['focus', 'keys'];
        if (!states.disabled) {
          if (!['table','group','tabpanel','toolbar','tooltip','status','progress','meter','separator','scroll'].includes(category) || el.hasAttribute('onclick') || window.getComputedStyle(el).cursor === 'pointer') actions.push('click');
          if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) actions.push('scroll');
          if (
            ['checkbox', 'radio', 'switch', 'toggle'].includes(category) &&
            !states.readonly
          )
            actions.push('set_checked');
          if (
            (tag === 'select' || ['combobox','listbox','menu','tree'].includes(role)) &&
            !states.readonly
          )
            actions.push('select');
          if (
            ((tag === 'input' &&
              ![
                'checkbox',
                'radio',
                'file',
                'hidden',
                'button',
                'submit',
                'reset',
                'image',
              ].includes(native.type)) ||
              tag === 'textarea' ||
              (el as HTMLElement).isContentEditable) &&
            !states.readonly && !patterns.includes('date-segment')
          )
            actions.push('fill');
          if (
            ((tag === 'input' &&
              [
                'text',
                'search',
                'email',
                'password',
                'url',
                'tel',
                'number',
              ].includes(native.type)) ||
              tag === 'textarea' ||
              (el as HTMLElement).isContentEditable) &&
            !states.readonly
          )
            actions.push('type');
          if (states.selected !== undefined && !states.readonly)
            actions.push('set_selected');
          if (states.expanded !== undefined || tag === 'summary')
            actions.push('set_expanded');
        }
        /**
         * 状态宿主（控件本体）暴露到顶层。
         *
         * 对「可见表面 ≠ 状态宿主」的自定义控件（label 包裹隐藏 input、
         * role=checkbox 包裹 input），这告诉模型：这一行的 ElementId 指向可见
         * 表面，而 checked 状态住在 controlElementId 上。模型据此既不必猜，
         * 也不必去写脚本探测 DOM 结构。
         */
        const hostControl = controlOf(el);
        const controlIsSeparate = !!hostControl && hostControl !== el;
        return {
          category,
          patterns,
          role: role || tag,
          evidence,
          name,
          states,
          relations,
          actions,
          ...(controlIsSeparate
            ? {
                controlElementId: registry!.register(hostControl),
                controlRendered: rendered(hostControl),
                controlIsSeparate: true,
              }
            : {}),
        };
      },
      register(el) {
        const previous = nodes.get(el);
        if (previous && resolve(previous) === el) {
          const entry = entries.get(previous)!;
          entry.expires = Date.now() + 120_000;
          // 重新观察同一元素时刷新各层签名：身份/记录变了说明它已不是同一个
          // 目标（此时本就该换引用）；上下文变了只更新软信号，不影响有效性。
          entry.identity = identitySignature(el);
          entry.record = recordSignature(el);
          entry.context = contextSignature(el);
          return previous;
        }
        if (counter % 256 === 0)
          for (const [id, entry] of entries) {
            if (entry.expires <= Date.now() || !entry.node.deref()?.isConnected)
              entries.delete(id);
          }
        const id = `anx:${tabId}:${nonce}:${++counter}`;
        const identity = identitySignature(el);
        entries.set(id, {
          node: new WeakRef(el),
          identity,
          record: recordSignature(el),
          context: contextSignature(el),
          locator: locatorOf(el),
          expires: Date.now() + 120_000,
          url: document.URL,
        });
        nodes.set(el, id);
        while (entries.size > 20_000)
          entries.delete(entries.keys().next().value!);
        return id;
      },
      resolve,
      resolveDetailed,
      controlOf,
      rebind,
      invalidate() {
        revision++;
      },
      fingerprint() {
        return `${nonce}|${revision}|${document.URL}`;
      },
    } satisfies ElementReferenceRegistry;
    refDocument.__agentNexusReferences = registry;
    const reset = () => {
      entries.clear();
      revision++;
    };
    window.addEventListener('pagehide', reset);
    window.addEventListener('popstate', reset);
    window.addEventListener('hashchange', reset);
  }
  // 'registry' 模式（内部引导用）：只保证完整注册表就位即返回，不扫描 DOM。
  // 供 browser_dom_explore 冷启动引导——explore 产出的引用必须带完整语义契约
  // （describe/controlOf/rebind），否则 set_checked 等状态操作在这些引用上失效。
  if (mode === 'registry') {
    return { elements: [], fingerprint: registry!.fingerprint() };
  }
  const frameFingerprint = registry.fingerprint();

  // —— 扫描范围（可选）：限定在父容器子树内 ——
  // 语义：parentSelector / parentXPath 命中一个或多个容器时，只遍历其子树
  // （自动穿透其中的开放 Shadow DOM）；容器本身不进入结果集。未命中直接报错，
  // 绝不静默退回整页扫描（否则模型会以为过滤生效而误判）。
  let scopedContainers: Element[] | null = null;
  if (parentSelector || parentXPath) {
    if (parentSelector) {
      try {
        scopedContainers = Array.from(document.querySelectorAll(parentSelector));
      } catch (e) {
        return {
          elements: [],
          fingerprint: frameFingerprint,
          error: `parentSelector 不是合法的 CSS 选择器：${(e as Error).message}`,
        };
      }
    } else {
      try {
        const snapshot = document.evaluate(
          parentXPath,
          document,
          null,
          XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
          null,
        );
        const found: Element[] = [];
        for (let i = 0; i < snapshot.snapshotLength; i++) {
          const node = snapshot.snapshotItem(i);
          if (node && node.nodeType === Node.ELEMENT_NODE) found.push(node as Element);
        }
        scopedContainers = found;
      } catch (e) {
        return {
          elements: [],
          fingerprint: frameFingerprint,
          error: `parentXPath 不是合法的 XPath 1.0 表达式：${(e as Error).message}`,
        };
      }
    }
    // 去掉被其它命中容器包含的嵌套容器，避免同一子树重复遍历
    scopedContainers = scopedContainers.filter(
      (container, index, list) =>
        !list.some(other => other !== container && other.contains(container)),
    );
    if (scopedContainers.length === 0) {
      // 选择器合法但本 frame 没有容器——非错误（多 frame 常态），
      // 交宿主决定：单 frame 全 miss → PARENT_CONTAINER_NOT_FOUND；
      // 其它 frame 命中 → 本 frame 静默缺席，不制造 issue 噪声。
      return {
        elements: [],
        fingerprint: frameFingerprint,
        containerMiss: true,
      };
    }
  }

  const roots: Node[] = scopedContainers && scopedContainers.length > 0
    ? [...scopedContainers]
    : [document];
  const seenRoots = new Set<Node>(roots);
  // 容器自身的 shadow 树：TreeWalker 只走 root 的**后代**，作为 root 的容器
  // 自己不会被访问到，其 shadowOf 不会被循环发现——这里显式播种，否则
  // 「作用域到 custom element 容器」会静默丢掉容器 shadow 内的全部控件。
  if (scopedContainers) {
    for (const container of scopedContainers) {
      const ownShadow = shadowOf(container);
      if (ownShadow && !seenRoots.has(ownShadow)) {
        roots.push(ownShadow);
        seenRoots.add(ownShadow);
      }
    }
  }
  const scanNodes: Element[] = [];
  for (let i = 0; i < roots.length; i++) {
    const walker = document.createTreeWalker(roots[i], 1 /* NodeFilter.SHOW_ELEMENT */);
    let current: Node | null;
    while ((current = walker.nextNode())) {
      if (scanNodes.length >= 20000 || performance.now() - scanStarted > 700) { truncated = true; break; }
      const el = current as Element;
      scanNodes.push(el);
      const shadow = shadowOf(el);
      if (shadow && !seenRoots.has(shadow)) { roots.push(shadow); seenRoots.add(shadow); }
    }
    if (truncated) break;
  }
  const queryAll = (selector: string): Element[] =>
    scanNodes.filter(el => !overBudget() && (selector === '*' || el.matches(selector)));

  /**
   * 父容器作用域的**统一越界门**（register / registerSection 共用）。
   *
   * 为什么必须是门而不是只在遍历处收口：结果来源有多个（queryAll 启发式、
   * xpath 显式节点、body 编辑器特例、分区标题……），只在遍历收口会让
   * `parentSelector + xpath` 组合把容器外被 xpath 命中的元素漏进来——
   * 裁剪被局部击穿。防御性要求：任何新注册路径自动被这一道门覆盖。
   *
   * 语义：容器自身不进结果（"进入容器看里面"）；容器**shadow 树内的元素**
   * 算在内（Node.contains 不跨 shadow 边界，需沿 host 逐层提升）。
   * 未启用作用域时零开销直通。
   */
  const withinScope = (el: Element): boolean => {
    if (!scopedContainers || scopedContainers.length === 0) return true;
    let node: Element | null = el;
    for (let hop = 0; node && hop < 64; hop++) {
      for (const container of scopedContainers) {
        // 首跳排除容器自身；提升到 host 之后（hop>0）容器就是祖先，算在内
        if (container.contains(node) && (hop > 0 || container !== node))
          return true;
      }
      const root = node.getRootNode() as ShadowRoot | Document;
      const host = (root as Partial<ShadowRoot>).host;
      node = host ?? null; // Document 无 host → 退出（越界）
    }
    return false;
  };

  // —— 过滤条件编译（非法条件立即返回错误，避免整页误判）——
  let regex: RegExp | null = null;
  if (regexSource) {
    try {
      regex = new RegExp(regexSource, 'i');
    } catch (e) {
      return {
        elements: [],
        fingerprint: frameFingerprint,
        error: `regex 参数不是合法的 JavaScript 正则表达式：${(e as Error).message}`,
      };
    }
  }

  let xpathNodes: Set<Element> | null = null;
  if (xpathExpr) {
    try {
      const snapshot = document.evaluate(
        xpathExpr,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      xpathNodes = new Set<Element>();
      for (let i = 0; i < snapshot.snapshotLength; i++) {
        const node = snapshot.snapshotItem(i);
        if (node && node.nodeType === Node.ELEMENT_NODE) {
          xpathNodes.add(node as Element);
        }
      }
    } catch (e) {
      const example =
        mode === 'buttons'
          ? "//button[contains(.,'提交')]"
          : "//input[@name='keyword']";
      return {
        elements: [],
        fingerprint: frameFingerprint,
        error: `xpath 参数不是合法的 XPath 1.0 表达式：${(e as Error).message}。请使用相对路径写法，如 ${example}`,
      };
    }
  }

  /**
   * 页面分析器类（内联定义，保证注入后自包含）
   */
  class PageAnalyzer {
    // ══════════════════ 共享：节点引用与上下文 ══════════════════
    getElementId(el: Element): string {
      return registry!.register(el);
    }
    getContext(el: Element): string {
      return contextOf(el);
    }

    // ══════════════════ 共享：可见性与遮挡判定 ══════════════════
    isInViewport(el: Element): boolean {
      const rect = el.getBoundingClientRect();
      return (
        rect.top < window.innerHeight &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.right > 0
      );
    }

    isObscured(el: Element): boolean {
      const rect = el.getBoundingClientRect();
      const x =
        (Math.max(0, rect.left) + Math.min(window.innerWidth, rect.right)) / 2;
      const y =
        (Math.max(0, rect.top) + Math.min(window.innerHeight, rect.bottom)) / 2;
      let hit = document.elementFromPoint(x, y);
      const visited = new Set<Element>();
      while (hit && shadowOf(hit)?.elementFromPoint) {
        if (visited.has(hit) || visited.size >= 256) { truncated = true; scanWarning = 'HIT_TEST_FAILED: cyclic or excessively deep Shadow DOM hit testing; affected controls omitted'; return true; }
        visited.add(hit);
        const inner = shadowOf(hit)!.elementFromPoint(x, y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
      const root = el.getRootNode() as ShadowRoot;
      if (root.host && hit === root.host && !root.elementFromPoint)
        return false;
      return !!hit && hit !== el && !el.contains(hit);
    }

    /**
     * 检查元素是否被渲染且具有可交互的基本条件 (不检查是否在视口内)
     */
    isPotentiallyInteractable(el: Element): boolean {
      return !!el && el instanceof Element && rendered(el);
    }

    // ══════════════════ 共享：xpath 祖先链命中 ══════════════════
    /**
     * xpath 命中判定：元素本身或任一祖先被 xpath 选中即算命中
     * （容器级 xpath 写法 //div[@class='toolbar']//button 因此可用）
     */
    isInXpathChain(el: Element, xpathNodes: Set<Element>): boolean {
      let current: Element | null = el;
      for (let depth = 0; current && depth < 50; depth++) {
        if (xpathNodes.has(current)) return true;
        current = current.parentElement;
      }
      return false;
    }

    // ══════════════════ 共享：单元素构建守卫 ══════════════════
    /** 渲染检查 + 视口内遮挡检查；返回 false 表示该元素不应出现在结果中 */
    private passesVisibilityGuard(el: Element): boolean {
      if (!this.isPotentiallyInteractable(el)) return false;
      // 只对当前在屏幕上的元素做遮挡检查；屏幕外的元素保留（翻页仍可见）
      if (this.isInViewport(el) && this.isObscured(el)) return false;
      return true;
    }

    /** 过滤标记 + 命中判定（两种模式完全一致的语义） */
    private applyFilterFlags(
      record: PayloadElement,
      el: Element,
      attrHaystack: string,
      regex: RegExp | null,
      xpathNodes: Set<Element> | null,
    ): void {
      // 过滤标记：regex 对「描述 + 类名 + 常用属性值」不区分大小写匹配（在截断前的全文上进行）
      record.matchedRegex = regex ? regex.test(attrHaystack) : null;
      record.matchedXpath = xpathNodes
        ? this.isInXpathChain(el, xpathNodes)
        : null;
      record.isHit = false;
    }

    // ══════════════════ buttons 模式专属：描述提取 ══════════════════
    // =================================================================
    // ▶️ 获取元素的直接文本内容（不包括子元素的文本）
    // =================================================================
    getDirectTextContent(el: Element): string {
      let text = '';
      // 遍历所有子节点
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
          // 只收集文本节点
          text += node.textContent || '';
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          // 对于元素节点，只递归查找文本相关的容器元素（span, strong, em, b, i 等）
          const tagName = (node as Element).tagName.toLowerCase();
          if (
            [
              'span',
              'strong',
              'em',
              'b',
              'i',
              'small',
              'mark',
              'label',
            ].includes(tagName)
          ) {
            text += this.getDirectTextContent(node as Element);
          }
        }
      }
      return text.trim().replace(/\s+/g, ' ');
    }

    // =================================================================
    // ▶️ 增强的 description 提取方法（buttons）- 按优先级尝试多种来源
    // =================================================================
    getButtonDescription(el: Element): string {
      // 第一优先级：aria-label 属性（通常是最准确的可访问性描述）
      let description = el.getAttribute('aria-label') || '';
      if (description) return description;

      // 第二优先级：title 属性
      description = el.getAttribute('title') || '';
      if (description) return description;

      // 第三优先级：aria-labelledby 引用
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const labelIds = labelledBy.split(/\s+/);
        const labelTexts = labelIds
          .map((id) => document.getElementById(id)?.textContent?.trim())
          .filter(Boolean);
        if (labelTexts.length > 0) {
          return labelTexts.join(' ');
        }
      }

      // 第四优先级：获取元素的直接文本内容（排除子元素文本）
      // 这样可以避免获取到不相关的子元素内容（如更多选项按钮 ⋮）
      const directText = this.getDirectTextContent(el);
      if (directText && directText.length >= 2 && directText.length <= 50) {
        return directText;
      }

      // 第五优先级：元素全部文本内容（作为 fallback）
      description = (el.textContent || (el as HTMLElement).innerText || '')
        .trim()
        .replace(/\s+/g, ' ');
      // 过滤掉单个特殊字符（如 ⋮、×、+ 等菜单按钮）
      if (
        description &&
        !/^[⋮×+\-·•…⋯⁝⁞︙]+$/.test(description) &&
        description.length <= 50
      ) {
        return description;
      }

      // 第六优先级：SVG 的 name 或 aria-label
      const svg = el.querySelector('svg');
      if (svg) {
        description =
          svg.getAttribute('name') || svg.getAttribute('aria-label') || '';
        if (description) return description;
      }

      // 第七优先级：子 img 元素的 alt 属性
      const img = el.querySelector('img');
      if (img) {
        description = img.getAttribute('alt') || '';
        if (description) return description;
      }

      // 第八优先级：data-* 属性扫描（tooltip、label、action 等）
      const tooltipAttrs = [
        'data-tooltip',
        'data-tip',
        'data-original-title',
        'data-title',
        'data-content',
      ];
      for (const attr of tooltipAttrs) {
        const value = el.getAttribute(attr);
        if (value) return value;
      }

      // 第九优先级：父元素上下文 - 从最近的带描述的祖先元素获取语义
      let ancestor = el.parentElement;
      for (let i = 0; i < 2 && ancestor; i++) {
        // 最多向上查找 2 层
        const ancestorLabel =
          ancestor.getAttribute('aria-label') || ancestor.getAttribute('title');
        if (ancestorLabel) {
          return ancestorLabel;
        }
        ancestor = ancestor.parentElement;
      }

      // 第十优先级：图标类名语义解析 - 从 class="icon-delete" 提取语义词
      const className = el.getAttribute('class') || '';
      if (typeof className === 'string') {
        // 匹配常见的图标类名模式
        const iconPatterns = [
          /icon[-_]?(\w+)/i,
          /fa[-_]?(\w+)/i,
          /glyphicon[-_]?(\w+)/i,
          /mdi[-_]?(\w+)/i,
          /material[-_]icons?[-_]?(\w+)/i,
        ];
        for (const pattern of iconPatterns) {
          const match = className.match(pattern);
          if (match && match[1]) {
            // 转换为可读格式："trash" -> "trash", "arrow-left" -> "arrow left"
            return match[1].replace(/[-_]/g, ' ').toLowerCase();
          }
        }
      }

      return '';
    }

    // =================================================================
    // ▶️ 检测按钮是否可能触发下载事件（buttons 模式）
    // =================================================================
    isDownloadTrigger(el: Element): boolean {
      // 1. 检查 download 属性（HTML5 标准下载属性）
      if (el.hasAttribute('download')) {
        return true;
      }

      // 2. 检查 href 特征
      const href = el.getAttribute('href') || '';
      if (href) {
        // blob: 或 data: URL 通常用于动态生成的下载
        if (href.startsWith('blob:') || href.startsWith('data:')) {
          return true;
        }

        // 常见下载文件扩展名
        const downloadExtensions =
          /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|7z|tar|gz|exe|dmg|pkg|apk|ipa|mp3|mp4|avi|mov|mkv|wav|flac|csv|json|xml|txt|rtf|epub|mobi|iso)(\?.*)?$/i;
        if (downloadExtensions.test(href)) {
          return true;
        }

        // URL 路径包含下载相关关键词
        const downloadUrlPatterns =
          /\/(download|export|attachment|file|get-file|fetch-file|save|output)\b/i;
        if (downloadUrlPatterns.test(href)) {
          return true;
        }
      }

      // 3. 检查文本内容
      const text = (
        el.textContent ||
        (el as HTMLElement).innerText ||
        ''
      ).toLowerCase();
      const downloadTextPatterns = [
        // 中文
        /下载/,
        /导出/,
        /保存/,
        /另存/,
        /获取文件/,
        /导出报表/,
        /下载附件/,
        /导出数据/,
        // 英文
        /\bdownload\b/,
        /\bexport\b/,
        /\bsave\s*(as|file)?\b/,
        /\bget\s*file\b/,
        /\battachment\b/,
      ];
      for (const pattern of downloadTextPatterns) {
        if (pattern.test(text)) {
          return true;
        }
      }

      // 4. 检查 class 和 id 属性
      const classAndId = (
        (el.className || '') +
        ' ' +
        (el.id || '')
      ).toLowerCase();
      const downloadClassPatterns =
        /\b(download|export|save|attachment|file-download|export-btn|save-btn|dl-btn)\b/;
      if (downloadClassPatterns.test(classAndId)) {
        return true;
      }

      // 5. 检查 data-* 属性
      const dataAttrs = [
        'data-download',
        'data-export',
        'data-action',
        'data-command',
        'data-type',
      ];
      for (const attr of dataAttrs) {
        const value = (el.getAttribute(attr) || '').toLowerCase();
        if (value && /download|export|save/.test(value)) {
          return true;
        }
      }

      // 6. 检查 onclick 属性
      const onclick = (el.getAttribute('onclick') || '').toLowerCase();
      if (
        /download|export|save|fileSaver|createObjectURL|writeFile/.test(onclick)
      ) {
        return true;
      }

      // 7. 检查图标类名（FontAwesome, Material, 通用图标库）
      const iconClassPatterns = [
        /fa-download/,
        /fa-file-download/,
        /fa-save/,
        /fa-export/,
        /mdi-download/,
        /mdi-file-download/,
        /mdi-export/,
        /mdi-content-save/,
        /icon[-_]?download/,
        /icon[-_]?export/,
        /icon[-_]?save/,
        /glyphicon[-_]?download/,
        /glyphicon[-_]?save/,
        /download[-_]?icon/,
        /export[-_]?icon/,
        /save[-_]?icon/,
      ];
      // 元素自身 class 先测（SVG 元素的 className 是对象，取 class 属性拿到真实类名）
      const ownClass =
        (el.getAttribute && el.getAttribute('class')) ||
        `${el.className || ''}`;
      for (const pattern of iconClassPatterns) {
        if (pattern.test(ownClass)) return true;
      }
      // 后代逐个匹配、首中即停：图标类模式均不含空白，逐元素判定与「拼接后整体正则」
      // 语义等价，但避免为大容器物化整棵子树的类名字符串（性能防护）
      const descendants = el.querySelectorAll('*');
      for (let i = 0; i < descendants.length; i++) {
        const descClass =
          (descendants[i].getAttribute &&
            descendants[i].getAttribute('class')) ||
          `${descendants[i].className || ''}`;
        for (const pattern of iconClassPatterns) {
          if (pattern.test(descClass)) return true;
        }
      }

      // 8. 检查 SVG 图标的 name 或 aria-label
      const svg = el.querySelector('svg');
      if (svg) {
        const svgName = (
          svg.getAttribute('name') ||
          svg.getAttribute('aria-label') ||
          ''
        ).toLowerCase();
        if (/download|export|save/.test(svgName)) {
          return true;
        }
      }

      // 9. 检查 aria-label 和 title 属性
      const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
      const title = (el.getAttribute('title') || '').toLowerCase();
      if (/download|export|save|下载|导出|保存/.test(ariaLabel + ' ' + title)) {
        return true;
      }

      return false;
    }

    // ══════════════════ buttons 模式专属：评分与记录构建 ══════════════════
    /**
     * 计算按钮的优先级评分（下载按钮 > 视口内可见 > 文本质量 > 语义标签 > 位置靠上）
     */
    private calculateButtonScore(element: {
      isDownload: boolean;
      isInViewport: boolean;
      textLength: number;
      tagName: string;
      computedCursor: string;
      rectTop: number;
    }): number {
      let score = 0;

      // 0. 下载按钮优先加分 (50分) - 最高优先级
      if (element.isDownload) score += 50;

      // 1. 可见性评分 (40分)
      if (element.isInViewport) score += 30;
      else score += 10;

      // 2. 内容质量评分 (30分)
      if (element.textLength > 0) {
        if (element.textLength >= 2 && element.textLength <= 30)
          score += 30; // 合理长度
        else if (element.textLength > 30)
          score += 20; // 较长
        else score += 10; // 很短
      }

      // 3. 语义标签评分 (20分)
      if (['button', 'a'].includes(element.tagName)) score += 20;
      else if (element.computedCursor === 'pointer') score += 10;

      // 4. 位置评分 (10分) - 越靠上越重要
      if (element.rectTop >= 0 && element.rectTop < 300) score += 10;
      else if (element.rectTop >= 300 && element.rectTop < 800) score += 5;

      return score;
    }

    /**
     * 为单个按钮类元素构建结果记录（描述、类型、评分、过滤标记）
     * 返回 null 表示元素不可交互（未渲染 / 视口内被遮挡）
     */
    buildButtonRecord(
      el: Element,
      regex: RegExp | null,
      xpathNodes: Set<Element> | null,
    ): PayloadElement | null {
      if (!this.passesVisibilityGuard(el)) return null;

      const tagName = el.tagName.toLowerCase();
      const rawClassName = el.getAttribute('class') || '';
      const href = el.getAttribute('href') || '';
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el as HTMLElement);

      // 使用增强的 description 提取方法
      let description = this.getButtonDescription(el);

      // 简化的 class 名作为辅助信息（同时参与 regex 匹配）
      const simplifiedClass = rawClassName
        .split(/\s+/)
        .filter((c) => c && c.length < 30) // 过滤过长的 class
        .slice(0, 3) // 最多取3个
        .join(' ');

      // 如果没有提取到 description，使用 class 名作为兜底
      if (!description && simplifiedClass) {
        description = `[class: ${simplifiedClass}]`;
      }

      // 如果还是没有 description，使用标签名 + 位置作为兜底
      if (!description) {
        description = `[${tagName} @ (${Math.round(rect.left)}, ${Math.round(rect.top)})]`;
      }

      // 检测是否为下载/导出按钮
      const isDownload = this.isDownloadTrigger(el);

      // 构建最终的 description：如果有内容描述且有 class，则附加 class 信息
      let finalDescription = description;
      if (
        !description.startsWith('[class:') &&
        !description.startsWith('[' + tagName) &&
        simplifiedClass
      ) {
        finalDescription = `${description} [${simplifiedClass}]`;
      }

      // 如果是下载按钮，在 description 前添加标记
      if (isDownload) {
        finalDescription = `[📥下载] ${finalDescription}`;
      }

      const fullDescription = finalDescription;
      if (finalDescription.length > 70)
        finalDescription = finalDescription.substring(0, 67) + '...';

      // 元素类型判定：a[href] 或 role=link 为链接；表单控件按类型标注；其余为普通元素
      const inputType =
        tagName === 'input'
          ? (el.getAttribute('type') || 'text').toLowerCase()
          : '';
      let type = 'button';
      if (
        (tagName === 'a' &&
          (href.startsWith('http') || href.startsWith('/'))) ||
        el.getAttribute('role') === 'link'
      ) {
        type = 'link';
      } else if (
        tagName === 'input' &&
        ['checkbox', 'radio'].includes(inputType)
      ) {
        type = inputType;
      } else if (
        tagName === 'input' &&
        ['submit', 'button', 'reset', 'image'].includes(inputType)
      ) {
        type = 'button';
      } else if (tagName === 'select') {
        type = 'select';
      } else if (
        !['button', 'a'].includes(tagName) &&
        !el.hasAttribute('onclick') &&
        el.getAttribute('role') !== 'button' &&
        style.cursor !== 'pointer'
      ) {
        type = 'element';
      }

      // 属性参与匹配使 regex 可覆盖 href/id/name/value/data-* 等场景，无需为此单独写 xpath
      const attrHaystack = [
        fullDescription,
        rawClassName,
        el.id,
        href,
        el.getAttribute('name') || '',
        el.getAttribute('value') || '',
        el.getAttribute('data-testid') || '',
        el.getAttribute('data-action') || '',
        el.getAttribute('data-url') || '',
      ]
        .filter(Boolean)
        .join(' ');

      const record: PayloadElement = {
        type,
        description: finalDescription,
        context: this.getContext(el),
        elementId: this.getElementId(el),
        score: 0,
        isDownload,
        matchedRegex: null,
        matchedXpath: null,
        isHit: false,
      };
      this.applyFilterFlags(record, el, attrHaystack, regex, xpathNodes);

      record.score = this.calculateButtonScore({
        isDownload,
        isInViewport: this.isInViewport(el),
        textLength: fullDescription.length,
        tagName,
        computedCursor: style.cursor,
        rectTop: rect.top,
      });

      return record;
    }

    // ══════════════════ inputs 模式专属：描述提取 ══════════════════
    findAssociatedDescription(el: Element): string {
      // 1. 通过 label[for] 查找关联的 label
      if (el.id) {
        const label = (el.getRootNode() as Document | ShadowRoot).querySelector(
          `label[for="${CSS.escape(el.id)}"]`,
        );
        if (label && label.textContent) {
          return label.textContent.trim();
        }
      }

      // 2. 通过 aria-labelledby 查找关联的元素
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const labelIds = labelledBy.split(/\s+/);
        const labelTexts = labelIds
          .map((id) => document.getElementById(id)?.textContent?.trim())
          .filter(Boolean);
        if (labelTexts.length > 0) {
          return labelTexts.join(' ');
        }
      }

      // 3. 查找父容器中的 placeholder 元素
      const parent = el.parentElement;
      if (parent) {
        const placeholderSibling = parent.querySelector(
          '[class*="placeholder"]',
        );
        if (
          placeholderSibling &&
          placeholderSibling.parentElement === parent &&
          placeholderSibling.textContent
        ) {
          return placeholderSibling.textContent.trim();
        }
      }

      // 4. 查找前一个兄弟元素的文本
      const precedingSibling = el.previousElementSibling;
      if (precedingSibling && precedingSibling.textContent) {
        if (
          !['script', 'style'].includes(precedingSibling.tagName.toLowerCase())
        ) {
          return precedingSibling.textContent.trim();
        }
      }

      // 5. 父容器 label 查找 - 支持 <div class="form-group"><label>名字</label><input></div> 这种结构
      let ancestor = el.parentElement;
      for (let i = 0; i < 3 && ancestor; i++) {
        // 最多向上查找 3 层
        const label = ancestor.querySelector('label');
        if (
          label &&
          label.textContent &&
          !ancestor.querySelector('input + input, textarea + textarea')
        ) {
          // 确保这个容器只有一个输入元素，避免 label 关联错误
          return label.textContent.trim();
        }
        ancestor = ancestor.parentElement;
      }

      return '';
    }

    /**
     * 增强的 description 提取方法（inputs）- 按优先级尝试多种来源
     */
    getInputDescription(el: Element): string {
      // 第一优先级：标准属性
      let description =
        el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
      if (description) return description;

      // 第二优先级：关联描述（label, aria-labelledby 等）
      description = this.findAssociatedDescription(el);
      if (description) return description;

      // 第三优先级：name 属性
      description = el.getAttribute('name') || '';
      if (description) return description;

      // 第四优先级：title 属性
      description = el.getAttribute('title') || '';
      if (description) return description;

      // 第五优先级：data-* 属性扫描
      const dataAttrs = [
        'data-placeholder',
        'data-label',
        'data-name',
        'data-field',
        'data-testid',
        'data-qa',
      ];
      for (const attr of dataAttrs) {
        const value = el.getAttribute(attr);
        if (value) {
          // 将 data-testid 等转为可读格式（如 "user-email-input" -> "user email input"）
          return value
            .replace(/[-_]/g, ' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .toLowerCase();
        }
      }

      // 第六优先级：输入框内已有值作为辅助描述
      const inputValue = (el as HTMLInputElement).value;
      if (
        (el as HTMLInputElement).type !== 'password' &&
        inputValue &&
        inputValue.length <= 30
      ) {
        return `(contains: ${inputValue})`;
      }

      return '';
    }

    // ══════════════════ inputs 模式专属：评分与记录构建 ══════════════════
    /**
     * 计算输入元素的优先级评分（视口内可见 > 文本质量 > 语义标签 > 位置靠上）
     */
    private calculateInputScore(element: {
      isInViewport: boolean;
      textLength: number;
      type: string;
      rectTop: number;
    }): number {
      let score = 0;

      // 1. 可见性评分 (40分)
      if (element.isInViewport) score += 30;
      else score += 10; // 屏幕外但仍可交互

      // 2. 内容质量评分 (30分)
      if (element.textLength > 0) {
        if (element.textLength >= 2 && element.textLength <= 30) score += 30;
        else if (element.textLength > 30) score += 20;
        else score += 10;
      }

      // 3. 语义标签评分 (20分)
      if (element.type === 'element')
        score += 5; // xpath 显式选中的非标准输入元素
      else score += 20; // 标准 input/textarea/富文本区

      // 4. 位置评分 (10分) - 越靠上越重要
      if (element.rectTop >= 0 && element.rectTop < 300) score += 10;
      else if (element.rectTop >= 300 && element.rectTop < 800) score += 5;

      return score;
    }

    // =================================================================
    // ▶️ 为单个输入类元素构建结果记录（类型、描述、评分、过滤标记）
    // =================================================================
    buildInputRecord(
      el: Element,
      regex: RegExp | null,
      xpathNodes: Set<Element> | null,
      /** form 视图盘点模式：只管「字段存在与否」，不做可见性/只读过滤（操作层仍会兜底拒绝） */
      formMode = false,
    ): PayloadElement | null {
      if (!formMode && !this.passesVisibilityGuard(el)) return null;
      if (!formMode && el.matches('[readonly], [aria-readonly="true"]'))
        return null;

      const tagName = el.tagName.toLowerCase();
      const rawClassName = el.getAttribute('class') || '';
      const rect = el.getBoundingClientRect();

      let description = this.getInputDescription(el);
      let type: string | null = null;

      if (tagName === 'textarea') {
        type = 'textarea';
        if (!description) description = 'Rich text area';
      } else if (tagName === 'select') {
        // 下拉选择框：browser_interact(action="fill") 按 option 文本/值匹配填充
        type = 'select';
        if (!description) description = 'Select dropdown';
      } else if (tagName === 'input') {
        const inputType = (el as HTMLInputElement).type || 'text';
        if (
          [
            'text',
            'search',
            'email',
            'password',
            'url',
            'tel',
            'number',
            'date',
            'time',
            'datetime-local',
            'month',
            'week',
            'color',
            'range',
          ].includes(inputType)
        ) {
          type = `input_${inputType}`;
          if (!description) description = `Text input (${inputType})`;
        } else if (formMode && inputType === 'file') {
          // 隐藏的 file input 是上传控件的常态（自定义按钮包壳）——盘点必须
          // 看得见它，操作层 set_files 对隐藏 file input 有专属豁免路径
          type = 'input_file';
          if (!description) description = 'File upload input';
        } else {
          return null; // checkbox/radio 等交由 buildButtonRecord（状态宿主路径）
        }
      } else if ((el as HTMLElement).isContentEditable) {
        type = tagName === 'body' ? 'body_editor' : 'div_editable';
        if (!description) description = 'Rich text editor area';
      } else {
        return null;
      }

      // 走到这里 type 必已被赋值（各分支未赋值时已 return），?? 仅为收窄类型
      const finalType: string = type ?? 'element';
      const rawDescription = description;
      const inViewport = this.isInViewport(el);

      // 屏幕外元素追加可见性提示，帮助调用方决定是否滚动
      let finalDescription = inViewport
        ? description
        : `${description} (currently not visible)`;
      // form 盘点的 label 是分组识别的主键，放宽截断（表格展示层还会再裁一次）
      const descLimit = formMode ? 157 : 50;
      if (finalDescription.length > descLimit) {
        finalDescription = finalDescription.substring(0, descLimit - 3) + '...';
      }

      // 属性参与匹配使 regex 可覆盖 placeholder/name/id/value/data-* 等场景，无需为此单独写 xpath
      const attrHaystack = [
        rawDescription,
        rawClassName,
        el.id,
        el.getAttribute('name') || '',
        el.getAttribute('placeholder') || '',
        el.getAttribute('value') || '',
        el.getAttribute('data-testid') || '',
        el.getAttribute('data-name') || '',
      ]
        .filter(Boolean)
        .join(' ');

      const record: PayloadElement = {
        type: finalType,
        description: finalDescription,
        context: this.getContext(el),
        elementId: this.getElementId(el),
        score: 0,
        matchedRegex: null,
        matchedXpath: null,
        isHit: false,
      };
      this.applyFilterFlags(record, el, attrHaystack, regex, xpathNodes);

      record.score = this.calculateInputScore({
        isInViewport: inViewport,
        textLength: rawDescription.length,
        type: finalType,
        rectTop: rect.top,
      });

      return record;
    }

    // ══════════════════ 主流程：采集 → 过滤标记 → 命中置顶排序 ══════════════════
    analyze(): PayloadElement[] {
      const results = new Map<Element, PayloadElement>();
      if (!document.body) return [];

      const register = (el: Element) => {
        if (overBudget() || results.size >= 8000) { truncated = true; return; }
        // 父容器作用域统一越界门（xpath 显式节点 / body 特例 / 启发式一并覆盖）
        if (!el || !withinScope(el)) return;
        // form 视图：嵌套 button 只收最外层（包装器与文案按钮会成对出现，
        // 两行同义记录纯占预算）——外层的描述已含子层文案
        if (
          mode === 'form' &&
          el.localName === 'button' &&
          el.closest('button') &&
          el.closest('button') !== el
        )
          return;
        if (
          results.has(el) ||
          // form 视图保留禁用/失效控件：表单盘点需要看到「字段存在但当前
          // 不可填」——交互层的 NOT_ACTIONABLE 仍会在操作时兜底拒绝。
          (mode !== 'structure' &&
            mode !== 'form' &&
            (el.matches(':disabled') ||
              el.closest(
                '[inert],[aria-disabled="true"],[data-disabled]:not([data-disabled="false"])',
              )))
        )
          return;
        let record: PayloadElement | null;
        if (mode === 'structure') {
          if (!this.isPotentiallyInteractable(el)) return;
          const role = el.getAttribute('role') || el.localName;
          const text = (
            el.getAttribute('aria-label') ||
            (el as HTMLInputElement).placeholder ||
            el.textContent ||
            ''
          )
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 500);
          const state: Record<string, unknown> = {};
          for (const attr of [
            'aria-rowindex',
            'aria-colindex',
            'aria-rowcount',
            'aria-colcount',
            'aria-selected',
            'aria-expanded',
            'aria-checked',
            'aria-disabled',
            'aria-readonly',
            'rowspan',
            'colspan',
            'name',
            'type',
            'title',
          ]) {
            if (el.hasAttribute(attr)) state[attr] = el.getAttribute(attr)!.slice(0,500);
          }
          // Values/options are populated once by the shared semantic runtime below.
          state.scroll = {
            left: el.scrollLeft,
            top: el.scrollTop,
            width: el.scrollWidth,
            height: el.scrollHeight,
            clientWidth: el.clientWidth,
            clientHeight: el.clientHeight,
          };
          record = {
            type: role,
            description: text || role,
            context: this.getContext(el),
            elementId: this.getElementId(el),
            score: 0,
            matchedRegex: null,
            matchedXpath: null,
            isHit: false,
            details: state,
          };
          this.applyFilterFlags(
            record,
            el,
            [role, text, el.id, el.getAttribute('class') || ''].join(' '),
            regex,
            xpathNodes,
          );
        } else {
          record =
            mode === 'inputs'
              ? this.buildInputRecord(el, regex, xpathNodes)
              : mode === 'form'
                ? this.buildInputRecord(el, regex, xpathNodes, true) ||
                  this.buildButtonRecord(el, regex, xpathNodes)
                : mode === 'controls'
                  ? this.buildInputRecord(el, regex, xpathNodes) ||
                    this.buildButtonRecord(el, regex, xpathNodes)
                  : this.buildButtonRecord(el, regex, xpathNodes);
        }
        if (record && mode === 'form')
          record.y = Math.round(
            el.getBoundingClientRect().top + window.scrollY,
          );
        if (
          record &&
          (mode === 'structure' ||
            mode === 'form' ||
            !registry!.describe!(el).states.disabled)
        )
          results.set(el, record);
      };
      /** form 视图专用：分区标题只作分组脚手架（宿主侧折进字段的 section，不单独渲染）。 */
      const registerSection = (el: Element) => {
        if (overBudget() || results.size >= 8000) {
          truncated = true;
          return;
        }
        if (!el || !withinScope(el) || results.has(el)) return;
        const text = (
          el.getAttribute('aria-label') || el.textContent || ''
        )
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 160);
        if (!text) return;
        const record: PayloadElement = {
          type: 'section',
          description: text,
          context: '',
          elementId: this.getElementId(el),
          score: 0,
          matchedRegex: null,
          matchedXpath: null,
          isHit: false,
          y: Math.round(el.getBoundingClientRect().top + window.scrollY),
        };
        this.applyFilterFlags(record, el, text, regex, xpathNodes);
        results.set(el, record);
      };

      if (mode === 'structure') {
        queryAll('*')
          .filter(
            (el) =>
              el.matches(
                'table,thead,tbody,tr,th,td,canvas,iframe,frame,input,textarea,select,progress,meter,output,fieldset,[role],[contenteditable],[data-calendar],[data-date-range],[data-time-range],[data-slot="calendar"],[data-slot="range-calendar"],[data-slot="date-range-picker"],[data-slot="date-range-field"]',
              ) ||
              el.scrollHeight > el.clientHeight + 1 ||
              el.scrollWidth > el.clientWidth + 1,
          )
          .forEach((el) => register(el));
      } else if (mode === 'buttons' || mode === 'controls') {
        // 步骤 1: 扩大搜查范围——语义标签 + class 模糊 + 表单按钮控件 + ARIA 角色
        // （select 下拉归 browser_observe，由 browser_interact(action="fill") 按 option 文本填充）
        const selectors = [
          'a',
          'button',
          'summary',
          'input[type="submit"]',
          'input[type="button"]',
          'input[type="reset"]',
          'input[type="image"]',
          'input[type="checkbox"]',
          'input[type="radio"]',
          '[role="button"]',
          '[role="link"]',
          '[onclick]',
          '[role="checkbox"]',
          '[role="radio"]',
          '[role="switch"]',
          '[role="tab"]',
          '[role="menuitem"]',
          '[role="option"]',
          '[role="combobox"]',
          '[role="radiogroup"]',
          '[role="dialog"]',
          '[role="alertdialog"]',
          '[role="listbox"]',
          '[role="menu"]',
          '[role="menubar"]',
          '[role="menuitemcheckbox"]',
          '[role="menuitemradio"]',
          '[role="slider"]',
          '[role="spinbutton"]',
          '[role="tablist"]',
          '[role="tree"]',
          '[role="grid"]',
          '[role="gridcell"]',
          '[role="treegrid"]', '[role="row"]', '[role="columnheader"]', '[role="rowheader"]',
          '[data-calendar]', '[data-date-range]', '[data-time-range]', '[data-slot="calendar"]', '[data-slot="range-calendar"]', '[data-slot="date-range-picker"]', '[data-slot="date-range-field"]',
          '[aria-haspopup]',
          '[aria-expanded]',
          '[aria-pressed]',
          '[tabindex]:not([tabindex="-1"])',
          'dialog[open]',
          'label[for]',
          'label:has(input[type="checkbox"],input[type="radio"])',
          '[role="treeitem"]',
          '[class*="button"]',
          '[class*="btn"]',
          '[class*="icon"]',
          '[class*="action"]',
        ];
        queryAll(selectors.join(', ')).forEach((el) => register(el));
        // React/Vue handlers need not produce onclick attributes. Discover only the
        // outer pointer surface, not every icon/text descendant inheriting its cursor.
        queryAll('*').forEach((el) => {
          if (overBudget()) return;
          if (results.has(el) || !this.isPotentiallyInteractable(el)) return;
          if (window.getComputedStyle(el).cursor !== 'pointer') return;
          const parent = el.parentElement;
          if (parent && window.getComputedStyle(parent).cursor === 'pointer')
            return;
          register(el);
        });
        if (mode === 'controls')
          queryAll('input,textarea,select,[contenteditable]').forEach((el) =>
            register(el),
          );

        // 步骤 2: xpath 显式选中的元素——即使启发式未识别为可交互也纳入（提升定位上限）
        if (xpathNodes) {
          xpathNodes.forEach((el) => register(el));
        }
      } else if (mode === 'form') {
        // 表单视图：字段（含只读/隐藏/禁用——盘点不做过滤）+ 语义按钮（保存/
        // 添加/删除/导航）+ 复选 label（状态宿主的可见表面）+ 分区标题脚手架。
        // 不走 controls 的 class/光标启发式——那只为「找可点的东西」，会把
        // 图标与装饰面也拉进来。
        queryAll(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]):not(body), [role="combobox"], [role="listbox"], [role="radiogroup"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], button, [role="button"], label[for], label:has(input[type="checkbox"]), label:has(input[type="radio"])',
        ).forEach((el) => register(el));
        if ((document.body as HTMLElement).isContentEditable) {
          register(document.body);
        }
        queryAll('h1,h2,h3,h4,h5,h6,legend,summary,[role="heading"]').forEach(
          registerSection,
        );
        if (xpathNodes) {
          xpathNodes.forEach((el) => register(el));
        }
      } else {
        // 步骤 1: 标准排查 (input, textarea, select, 非body的contenteditable)
        queryAll(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]):not(body)',
        ).forEach((el) => register(el));

        // 步骤 2: 特殊案件 - 检查 <body> 本身是否是编辑器
        if ((document.body as HTMLElement).isContentEditable) {
          register(document.body);
        }

        // Cursor styling alone does not make a node editable. Never mutate DOM to manufacture controls.

        // 步骤 4: xpath 显式选择的可填充元素（容器通过祖先链标记其输入后代）
        if (xpathNodes) {
          xpathNodes.forEach((el) => register(el));
        }
      }

      const list = Array.from(results.values());
      for (const record of list) {
        if (overBudget()) break;
        const node = registry!.resolve(record.elementId);
        if (!node) continue;
        const semantics = registry!.describe!(node);
        record.semantics = semantics;
        record.details = {
          ...record.details,
          ...semantics,
          ...semantics.states,
        };
        // section 是 form 视图的分组脚手架（type 固定），不参与语义类型改写
        if (
          record.type !== 'section' &&
          (!['native', 'generic'].includes(semantics.evidence) ||
            semantics.category === 'close')
        )
          record.type = semantics.category;
        if (
          semantics.name &&
          (record.description.startsWith('[class:') ||
            /^\[[\w-]+ @/.test(record.description) ||
            semantics.category === 'close')
        )
          record.description = semantics.name;
        if (semantics.category === 'close') record.score += 45;
        if (node.closest('dialog[open],[role="dialog"],[role="alertdialog"]'))
          record.score += 15;
        if (
          regex &&
          regex.test(
            [semantics.category, semantics.role, semantics.name].join(' '),
          )
        )
          record.matchedRegex = true;
      }
      const hasFilter = regex !== null || xpathNodes !== null;

      list.forEach((record) => {
        // 同时设置 regex 与 xpath 时必须同时满足
        record.isHit = hasFilter
          ? (regex ? record.matchedRegex === true : true) &&
            (xpathNodes ? record.matchedXpath === true : true)
          : false;
      });

      // 排序：命中过滤条件者置顶，其余按评分降序
      list.sort((a, b) => {
        if (hasFilter && a.isHit !== b.isHit) return a.isHit ? -1 : 1;
        // form 视图按文档坐标排序（阅读顺序 = 填写顺序），不做评分级排——
        // 表单里「哪个字段在前」本身就是模型需要的事实，评分排序会打乱它
        if (mode === 'form') return (a.y ?? 0) - (b.y ?? 0);
        return (b.score || 0) - (a.score || 0);
      });

      return list;
    }
  }

  // 荷载函数的入口点
  try {
    const analyzer = new PageAnalyzer();
    const elements = analyzer.analyze();
    const validElements = elements.filter(record => registry!.resolve(record.elementId) !== null);
    if (validElements.length !== elements.length) {
      return {
        elements: validElements,
        fingerprint: registry!.fingerprint(),
        truncated: true,
        truncationReason: `STALE_ELEMENTS：采集期间 ${elements.length - validElements.length} 个节点失效，已排除；保留其余有效引用。`,
      };
    }
    return { elements, fingerprint: registry!.fingerprint(), ...(truncated ? { truncated: true, truncationReason: scanWarning || 'DOM scan exceeded time, node, or control budget; currently collected nodes preserved' } : {}) };
  } catch (error) {
    console.error(`Error during in-frame ${mode} analysis:`, error);
    let message = 'Unserializable error value';
    try {message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);} catch { /* Preserve a bounded fallback. */ }
    return {
      elements: [],
      fingerprint: frameFingerprint,
      error: `ELEMENT_SCAN_FAILED：页面内分析失败：${message.slice(0,2000)}`,
    };
  }
}
