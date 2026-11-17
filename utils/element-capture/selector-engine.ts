/**
 * 元素选择器引擎（页面内运行，可被内容脚本与后续元素选取类功能复用）
 *
 * 设计目标：
 *   1. 生成「唯一且可回放」的选择器：优先稳定 id，其次最短唯一 CSS 路径，XPath 兜底；
 *   2. 生成后立即做二次校验（重新查询并比对元素身份），校验失败则升级策略；
 *   3. 支持开放 Shadow DOM（返回 shadowHosts 逐层定位）；
 *   4. 输出可读的元素描述与类型分类，供侧边栏 chip / 图标 / 模型上下文复用。
 *
 * 本文件为纯 DOM 逻辑，不依赖 chrome / Vue，不产生副作用。
 */

import type {
  CapturedElementDescriptor,
  CapturedElementKind,
  ElementSelectorResult,
  SelectorStrategy,
} from './types';

/** CSS 标识符转义（优先原生 CSS.escape） */
function escapeCssIdent(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

/** 元素所在的定位根（Document 或开放 ShadowRoot） */
function selectorRootOf(element: Element): Document | ShadowRoot {
  const root = element.getRootNode();
  return typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot ? root : document;
}

/** 判断 id 是否适合作为稳定选择器（过滤明显的框架自动生成 id） */
function isStableId(id: string): boolean {
  const trimmed = id.trim();
  if (!trimmed || trimmed.length > 120) return false;
  if (/^\d/.test(trimmed)) return false;
  if (/[:\s"'<>]/.test(trimmed)) return false;
  // React / Radix / Vue / Angular 等自动生成 id 常见形态
  if (/^(radix|react|mui|rc|ember|ng|vue|el|ant|headlessui|downshift)[-_:]/i.test(trimmed)) {
    return false;
  }
  return true;
}

/** 读取元素本身的选择器片段（标签 + 必要的同标签序号） */
function elementSegment(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const parent = element.parentElement;
  if (!parent) return tag;
  const sameTagSiblings = Array.from(parent.children).filter(
    (child) => child.tagName === element.tagName,
  );
  if (sameTagSiblings.length <= 1) return tag;
  return `${tag}:nth-of-type(${sameTagSiblings.indexOf(element) + 1})`;
}

/** 在指定根内执行 querySelectorAll（非法选择器返回 null） */
function safeQueryAll(root: Document | ShadowRoot, selector: string): Element[] | null {
  if (!selector) return null;
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return null;
  }
}

/** 判断选择器在根内是否唯一命中目标元素 */
function isUniqueTarget(
  root: Document | ShadowRoot,
  selector: string,
  target: Element,
): boolean {
  const matches = safeQueryAll(root, selector);
  return !!matches && matches.length === 1 && matches[0] === target;
}

/** 从元素向上构建最短唯一 CSS 路径（限定在当前定位根内） */
function buildCssPathWithinRoot(element: Element, root: Document | ShadowRoot): string {
  const segments: string[] = [];
  let current: Element | null = element;

  while (current) {
    const id = current.getAttribute('id') || '';
    if (current !== element && isStableId(id)) {
      const idSelector = `#${escapeCssIdent(id)}`;
      // id 唯一时作为祖先锚点可以显著缩短路径
      if (isUniqueTarget(root, idSelector, current)) {
        segments.unshift(idSelector);
        return segments.join(' > ');
      }
    }

    segments.unshift(elementSegment(current));
    const candidate = segments.join(' > ');
    if (isUniqueTarget(root, candidate, element)) {
      return candidate;
    }

    const parent: Element | null = current.parentElement;
    if (!parent) break;
    current = parent;
  }

  return segments.join(' > ');
}

/** 构建 XPath（Document 内为绝对路径；ShadowRoot 内为 root 内相对路径） */
function buildXPathWithinRoot(element: Element, root: Document | ShadowRoot): string {
  const segments: string[] = [];
  let current: Element | null = element;

  while (current) {
    const parent: Element | null = current.parentElement;
    if (!parent) {
      segments.unshift(current.tagName.toLowerCase());
      break;
    }
    const sameTag = Array.from(parent.children).filter(
      (child) => child.tagName === current?.tagName,
    );
    const index = sameTag.indexOf(current) + 1;
    segments.unshift(`${current.tagName.toLowerCase()}[${index}]`);
    current = parent;
  }

  return `/${segments.join('/')}`;
}

/** 计算 shadowHosts（从最外层 Document 到最内层 ShadowRoot） */
function resolveShadowHosts(element: Element): string[] {
  const hosts: string[] = [];
  let node: Element = element;

  // 防御异常 DOM：最多向上 20 层
  for (let depth = 0; depth < 20; depth += 1) {
    const root = node.getRootNode();
    if (typeof ShadowRoot === 'undefined' || !(root instanceof ShadowRoot)) break;
    const host: Element = root.host as Element;
    if (!host) break;
    hosts.unshift(buildCssPathWithinRoot(host, selectorRootOf(host)));
    node = host;
  }

  return hosts;
}

/** 在（可能跨 Shadow Root 的）定位根内解析选择器 */
export function resolveElementBySelector(
  selector: Pick<ElementSelectorResult, 'css' | 'shadowHosts'>,
): { element: Element | null; matchCount: number } {
  let root: Document | ShadowRoot = document;

  for (const hostSelector of selector.shadowHosts || []) {
    const host: Element | null = safeQueryAll(root, hostSelector)?.[0] ?? null;
    if (!host) return { element: null, matchCount: 0 };
    const shadow: ShadowRoot | null = (host as HTMLElement).shadowRoot;
    if (!shadow) return { element: null, matchCount: 0 };
    root = shadow;
  }

  const matches = safeQueryAll(root, selector.css);
  if (!matches || matches.length === 0) return { element: null, matchCount: 0 };
  return { element: matches[0], matchCount: matches.length };
}

/** 通过 XPath 求值（仅 Document 根可用；Shadow DOM 返回 null） */
function evaluateXPath(xpath: string): Element | null {
  if (!xpath) return null;
  try {
    const result = document.evaluate(
      xpath,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    );
    const node = result.singleNodeValue;
    return node && node.nodeType === Node.ELEMENT_NODE ? (node as Element) : null;
  } catch {
    return null;
  }
}

/**
 * 生成元素选择器并完成二次校验。
 * 校验失败时会自动升级策略：id → CSS 路径 → 绝对 XPath。
 */
export function buildElementSelector(element: Element): ElementSelectorResult {
  const root = selectorRootOf(element);
  const shadowHosts = resolveShadowHosts(element);

  let css = '';
  let strategy: SelectorStrategy = 'css-path';
  const id = element.getAttribute('id') || '';

  if (isStableId(id)) {
    const idSelector = `#${escapeCssIdent(id)}`;
    if (isUniqueTarget(root, idSelector, element)) {
      css = idSelector;
      strategy = 'id';
    }
  }

  if (!css) {
    css = buildCssPathWithinRoot(element, root);
    strategy = 'css-path';
  }

  // Shadow DOM 内的局部 XPath 无法作为文档级回放路径：不返回以免误导模型 / 用户
  const xpath = shadowHosts.length === 0 ? buildXPathWithinRoot(element, root) : '';
  const resolved = resolveElementBySelector({ css, shadowHosts });
  let verified = resolved.matchCount === 1 && resolved.element === element;

  // 二次校验失败：用绝对 XPath 兜底（仅 Document 根可校验）
  if (!verified && xpath) {
    const xpathTarget = evaluateXPath(xpath);
    if (xpathTarget === element) {
      verified = true;
      strategy = 'xpath';
    }
  }

  return {
    css,
    xpath,
    shadowHosts,
    strategy,
    verified,
    matchCount: resolved.matchCount,
  };
}

/** 元素类型分类（决定 chip 图标，保持与 CapturedElementKind 同步） */
export function classifyElement(element: Element): CapturedElementKind {
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute('type') || '').toLowerCase();
  const role = (element.getAttribute('role') || '').toLowerCase();

  if (tag === 'input') {
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'range';
    if (type === 'file') return 'file';
    if (type === 'color') return 'color';
    if (type === 'date' || type === 'month' || type === 'week') return 'date';
    if (type === 'time') return 'time';
    if (type === 'datetime-local') return 'datetime';
    if (type === 'number') return 'number';
    if (type === 'password') return 'password';
    if (type === 'email') return 'email';
    if (type === 'search') return 'search';
    if (type === 'tel') return 'tel';
    if (type === 'url') return 'url';
    if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') {
      return 'button';
    }
    return 'text-input';
  }

  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'img' || tag === 'picture') return 'image';
  if (tag === 'video') return 'video';
  if (tag === 'audio') return 'audio';
  if (tag === 'table') return 'table';
  if (tag === 'ul' || tag === 'ol' || tag === 'dl') return 'list';
  if (tag === 'form') return 'form';
  if (tag === 'iframe' || tag === 'frame') return 'iframe';
  if (tag === 'canvas') return 'canvas';
  if (tag === 'svg') return 'svg';
  if (tag === 'pre' || tag === 'code') return 'code';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'p') return 'paragraph';
  if (tag === 'label') return 'label';
  if (role === 'switch') return 'switch';
  if (role === 'checkbox') return 'checkbox';
  if (role === 'radio') return 'radio';
  if (role === 'button' || role === 'menuitem') return 'button';
  if (role === 'textbox' || role === 'searchbox') return 'text-input';
  if (role === 'link') return 'link';
  if (role === 'img') return 'image';
  if (role === 'table') return 'table';
  if (role === 'list' || role === 'listitem') return 'list';

  if (
    ['div', 'span', 'section', 'article', 'main', 'aside', 'header', 'footer', 'nav'].includes(tag)
  ) {
    return 'container';
  }
  return 'other';
}

/** 读取元素可读文本（截断并按需忽略敏感输入） */
function readableText(element: Element, kind: CapturedElementKind, maxChars: number): string {
  if (kind === 'password') return '';
  const tag = element.tagName.toLowerCase();

  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const value = (element as HTMLInputElement).value || '';
    return value.trim().slice(0, maxChars);
  }

  const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
  return text.slice(0, maxChars);
}

/** 采集关键属性快照（只保留对模型理解有帮助且长度可控的字段） */
function collectAttributes(element: Element): Record<string, string> {
  const attributes: Record<string, string> = {};
  const keys = [
    'id',
    'name',
    'type',
    'role',
    'aria-label',
    'aria-placeholder',
    'placeholder',
    'alt',
    'href',
    'title',
    'data-testid',
  ];

  for (const key of keys) {
    const value = element.getAttribute(key) || '';
    if (!value) continue;
    attributes[key] = value.slice(0, 240);
  }

  if (element.tagName.toLowerCase() === 'input') {
    const inputType = (element.getAttribute('type') || 'text').toLowerCase();
    if (inputType !== 'password') {
      const value = (element as HTMLInputElement).value || '';
      if (value) attributes.value = value.slice(0, 120);
    }
  }

  return attributes;
}

/** 面向模型的可读描述 */
function buildDescription(
  element: Element,
  kind: CapturedElementKind,
  attributes: Record<string, string>,
  text: string,
): string {
  const kindLabel = KIND_LABELS[kind] || kind;
  const tag = element.tagName.toLowerCase();
  const label =
    attributes['aria-label'] ||
    attributes.placeholder ||
    attributes.alt ||
    attributes.name ||
    (attributes.id ? `#${attributes.id}` : '') ||
    text;

  const pieces = [`${kindLabel} <${tag}>`];
  if (label) pieces.push(`"${label.slice(0, 80)}"`);
  if (attributes.type) pieces.push(`type=${attributes.type}`);
  if (attributes.role) pieces.push(`role=${attributes.role}`);
  return pieces.join(' ');
}

const KIND_LABELS: Record<CapturedElementKind, string> = {
  'text-input': '文本输入框',
  textarea: '多行文本输入框',
  password: '密码输入框',
  number: '数字输入框',
  email: '邮箱输入框',
  search: '搜索输入框',
  tel: '电话输入框',
  url: 'URL 输入框',
  date: '日期选择器',
  time: '时间选择器',
  datetime: '日期时间选择器',
  color: '颜色选择器',
  range: '滑块',
  file: '文件上传',
  checkbox: '复选框',
  radio: '单选框',
  select: '下拉选择框',
  button: '按钮',
  link: '链接',
  image: '图片',
  video: '视频',
  audio: '音频',
  table: '表格',
  list: '列表',
  form: '表单',
  iframe: '内嵌框架',
  canvas: '画布',
  svg: '矢量图形',
  code: '代码块',
  heading: '标题',
  paragraph: '段落',
  container: '容器',
  switch: '开关',
  label: '标签',
  other: '元素',
};

/** 采集元素描述（用于 chip tooltip、模型上下文与弹窗展示） */
export function captureElementDescriptor(element: Element): CapturedElementDescriptor {
  const kind = classifyElement(element);
  const attributes = collectAttributes(element);
  const text = readableText(element, kind, 160);
  const rect = element.getBoundingClientRect();

  return {
    tagName: element.tagName.toLowerCase(),
    kind,
    description: buildDescription(element, kind, attributes, text),
    text: text || undefined,
    attributes,
    width: Math.max(0, Math.round(rect.width)),
    height: Math.max(0, Math.round(rect.height)),
  };
}

/** 深度命中测试：穿透开放 Shadow DOM，返回实际命中的最内层元素 */
export function deepElementFromPoint(x: number, y: number): Element | null {
  let current: Element | null = document.elementFromPoint(x, y);
  for (let depth = 0; depth < 20 && current; depth += 1) {
    const shadow = (current as HTMLElement).shadowRoot;
    if (!shadow) break;
    const inner = shadow.elementFromPoint(x, y);
    if (!inner || inner === current) break;
    current = inner;
  }
  return current;
}

/** 元素是否可见（用于过滤 0 尺寸 / display:none 节点） */
export function isVisibleElement(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  const style = window.getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none';
}
