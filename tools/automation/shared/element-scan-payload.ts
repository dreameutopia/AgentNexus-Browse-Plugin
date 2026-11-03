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
 * - 'inputs'：文本框/textarea/下拉框/富文本区等可输入元素（含富文本识别）。
 *
 * 共享部分（节点引用生成、可见性与遮挡判定、xpath 祖先链命中、过滤标记、排序）
 * 只存在一份；模式差异（采集范围、描述提取链、类型映射、评分权重、截断规则）
 * 由统一节点注册与交付前校验保证定位链路一致。
 */

/** 扫描模式：按钮/链接 或 输入元素 */
import type {
  ReferenceDocument,
  ElementReferenceRegistry,
} from './element-reference';
export type ScanMode = 'controls' | 'buttons' | 'inputs' | 'structure';

/** 注入脚本返回的元素记录（frameId 由宿主侧补写） */
export interface PayloadElement {
  type: string;
  description: string;
  context: string;
  elementId: string;
  score: number;
  details?: Record<string, unknown>;
  /** 是否命中 regex 过滤（未启用 regex 时为 null） */
  matchedRegex: boolean | null;
  /** 是否命中 xpath 过滤（未启用 xpath 时为 null） */
  matchedXpath: boolean | null;
  /** 是否命中全部已启用的过滤条件（命中者在结果中置顶并标记 ✓） */
  isHit: boolean;
  /** 仅 buttons 模式：标记是否为下载/导出按钮 */
  isDownload?: boolean;
}

/** 注入脚本返回结果 */
export interface PayloadResult {
  elements: PayloadElement[];
  /** Document nonce + action revision + URL; pagination freezes membership rather than re-sorting live DOM. */
  fingerprint?: string;
  error?: string;
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
  tabId = 0
): PayloadResult {
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
      'tr, li, [role="row"], fieldset, [role="dialog"], form'
    );
    const container =
      semantic ||
      (el.parentElement === document.body ? null : el.parentElement);
    const text = (container?.textContent || '').trim().replace(/\s+/g, ' ');
    return !semantic && text.length > 180 ? '' : text.slice(0, 180);
  };
  const refDocument = document as ReferenceDocument;
  let registry = refDocument.__agentNexusReferences;
  if (!registry) {
    // randomUUID is restricted to secure contexts; getRandomValues also works on
    // HTTP/local-device pages, which are valid automation targets.
    const nonce = Array.from(
      window.crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('');
    let counter = 0;
    let revision = 0;
    const entries = new Map<
      string,
      {
        node: WeakRef<Element>;
        signature: string;
        expires: number;
        url: string;
      }
    >();
    const nodes = new WeakMap<Element, string>();
    const attributes = (el: Element): string =>
      JSON.stringify(
        Array.from(el.attributes)
          .filter((a) =>
            /^(id|name|type|role|href|title|placeholder|contenteditable|aria-.*|data-.*)$/.test(
              a.name
            )
          )
          .map((a) => [a.name, a.value])
          .sort((a, b) => a[0].localeCompare(b[0]))
      );
    const signature = (el: Element): string => {
      const input =
        ['input', 'textarea', 'select'].includes(el.localName) ||
        (el as HTMLElement).isContentEditable;
      const ancestors: string[] = [];
      const parentOf = (node: Element): Element | null =>
        node.parentElement || (node.getRootNode() as ShadowRoot).host || null;
      let parent = parentOf(el);
      for (
        let depth = 0;
        parent && depth < 8;
        depth++, parent = parentOf(parent)
      ) {
        ancestors.push(parent.localName + attributes(parent));
        if (parent.matches('tr, li, [role="row"], [data-id], [data-key]')) {
          ancestors.push(parent.textContent || '');
          break;
        }
      }
      const labels = Array.from((el as HTMLInputElement).labels || []).map(
        (label) => label.textContent
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
        contextOf(el),
        ancestors,
      ]);
    };
    const resolve = (id: string): Element | null => {
      const entry = entries.get(id);
      const el = entry?.node.deref();
      if (
        !entry ||
        !el ||
        entry.expires <= Date.now() ||
        entry.url !== document.URL ||
        !el.isConnected ||
        el.ownerDocument !== document ||
        entry.signature !== signature(el)
      ) {
        entries.delete(id);
        return null;
      }
      return el;
    };
    registry = {
      register(el) {
        const previous = nodes.get(el);
        if (previous && resolve(previous) === el) {
          entries.get(previous)!.expires = Date.now() + 120_000;
          return previous;
        }
        if (counter % 256 === 0)
          for (const [id, entry] of entries) {
            if (entry.expires <= Date.now() || !entry.node.deref()?.isConnected)
              entries.delete(id);
          }
        const id = `anx:${tabId}:${nonce}:${++counter}`;
        entries.set(id, {
          node: new WeakRef(el),
          signature: signature(el),
          expires: Date.now() + 120_000,
          url: document.URL,
        });
        nodes.set(el, id);
        while (entries.size > 20_000)
          entries.delete(entries.keys().next().value!);
        return id;
      },
      resolve,
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
  const roots: (Document | ShadowRoot)[] = [document];
  for (let i = 0; i < roots.length; i++) {
    roots[i].querySelectorAll('*').forEach((el) => {
      const shadow = shadowOf(el);
      if (shadow) roots.push(shadow);
    });
  }
  const queryAll = (selector: string): Element[] =>
    roots.flatMap((root) => Array.from(root.querySelectorAll(selector)));
  const frameFingerprint = registry.fingerprint();

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
        null
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
      while (hit && shadowOf(hit)?.elementFromPoint) {
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
      if (!el || !(el instanceof Element) || !document.body || !el.isConnected)
        return false;
      const style = getComputedStyle(el);
      // 必须是渲染出来的元素
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        parseFloat(style.opacity) < 0.1
      )
        return false;
      // 必须有实际大小
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;

      return true;
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
      xpathNodes: Set<Element> | null
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
      xpathNodes: Set<Element> | null
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
          `label[for="${CSS.escape(el.id)}"]`
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
          '[class*="placeholder"]'
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
      xpathNodes: Set<Element> | null
    ): PayloadElement | null {
      if (!this.passesVisibilityGuard(el)) return null;
      if (el.matches('[readonly], [aria-readonly="true"]')) return null;

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
        } else {
          return null; // checkbox/radio/file 等不在本工具范围（属按钮或文件上传工具）
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
      if (finalDescription.length > 50) {
        finalDescription = finalDescription.substring(0, 47) + '...';
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
        if (
          !el ||
          results.has(el) ||
          (mode !== 'structure' &&
            (el.matches(':disabled, [aria-disabled="true"]') ||
              el.closest('[inert]')))
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
            if (el.hasAttribute(attr)) state[attr] = el.getAttribute(attr);
          }
          const input = el as HTMLInputElement;
          if ('value' in el && input.type !== 'password') {
            state.value = String(input.value).slice(0, 500);
            state.valueTruncated = String(input.value).length > 500;
          }
          if (el.localName === 'select')
            state.optionsTruncated =
              (el as HTMLSelectElement).options.length > 100;
          if (el.localName === 'select')
            state.options = Array.from((el as HTMLSelectElement).options)
              .slice(0, 100)
              .map((o) => ({
                value: o.value,
                text: o.text,
                disabled: o.disabled,
              }));
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
            xpathNodes
          );
        } else {
          record =
            mode === 'inputs'
              ? this.buildInputRecord(el, regex, xpathNodes)
              : mode === 'controls'
                ? this.buildInputRecord(el, regex, xpathNodes) ||
                  this.buildButtonRecord(el, regex, xpathNodes)
                : this.buildButtonRecord(el, regex, xpathNodes);
        }
        if (record) results.set(el, record);
      };

      if (mode === 'structure') {
        queryAll('*')
          .filter(
            (el) =>
              el.matches(
                'table,thead,tbody,tr,th,td,canvas,iframe,frame,input,textarea,select,[role],[contenteditable]'
              ) ||
              el.scrollHeight > el.clientHeight + 1 ||
              el.scrollWidth > el.clientWidth + 1
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
          '[role="treeitem"]',
          '[class*="button"]',
          '[class*="btn"]',
          '[class*="icon"]',
          '[class*="action"]',
        ];
        queryAll(selectors.join(', ')).forEach((el) => register(el));
        if (mode === 'controls')
          queryAll('input,textarea,select,[contenteditable]').forEach((el) =>
            register(el)
          );

        // 步骤 2: xpath 显式选中的元素——即使启发式未识别为可交互也纳入（提升定位上限）
        if (xpathNodes) {
          xpathNodes.forEach((el) => register(el));
        }
      } else {
        // 步骤 1: 标准排查 (input, textarea, select, 非body的contenteditable)
        queryAll(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]):not(body)'
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
        return (b.score || 0) - (a.score || 0);
      });

      return list;
    }
  }

  // 荷载函数的入口点
  try {
    const analyzer = new PageAnalyzer();
    const elements = analyzer.analyze();
    if (
      elements.some((record) => registry!.resolve(record.elementId) === null)
    ) {
      return {
        elements: [],
        fingerprint: registry!.fingerprint(),
        error:
          'STALE_ELEMENTS：采集期间节点失效或超过引用容量，请缩小页面范围或等待稳定后重采。',
      };
    }
    return { elements, fingerprint: registry!.fingerprint() };
  } catch (error) {
    console.error(`Error during in-frame ${mode} analysis:`, error);
    return {
      elements: [],
      fingerprint: frameFingerprint,
      error: `页面内分析失败：${(error as Error).message}`,
    };
  }
}
