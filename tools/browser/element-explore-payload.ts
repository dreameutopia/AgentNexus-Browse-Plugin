/**
 * DOM 关系探索荷载（browser_dom_explore 注入函数）
 *
 * ⚠️ 注入约束（与 element-scan-payload 相同）：本函数经
 * chrome.scripting.executeScript({ func }) 序列化注入页面 ISOLATED 世界执行，
 * 闭包与模块作用域不会随之带入——函数体内只能引用自身参数、函数体内声明的
 * 嵌套声明与页面全局对象，绝不能引用任何模块级常量/辅助函数。
 *
 * 复用 browser_observe 建立的元素引用注册表（document.__agentNexusReferences）：
 *   - 种子元素必须来自最近的枚举（browser_observe 任意视图，或本工具此前
 *     返回的新引用）——注册表不存在或引用失效（签名/URL/过期不符）即报错，
 *     绝不静默换目标；
 *   - 探索发现的新元素注册进同一注册表并返回新 elementId，可直接用于
 *     browser_interact 操作、browser_observe(view=element) 深查、以及本工具
 *     的后续探索（如对重复容器执行 children 展开字段结构）。
 *
 * 四种 action：
 *   - parent：祖先链逐层摘要（含「同构兄弟数」，帮助识别重复容器层）；
 *   - children：直接/多层子元素（BFS，深度 1..3，visibleOnly 可滤隐藏）；
 *   - siblings：同父兄弟元素全列（标注种子位置）；
 *   - similar：相似元素发现——从种子向上找最近「重复容器组」（同标签且
 *     class Jaccard ≥ 0.5 的兄弟 ≥ 2），返回每个容器内与种子等位/最相似的
 *     元素；种子本身是重复项时直接返回同构兄弟组。附带可直接用于
 *     browser_page_exec 批量抓取的生成选择器与实测匹配数。
 *
 * 防御性约定：所有遍历有界（层数/节点数/容器数上限），超限置 truncated 并
 * 说明收窄方式；任何错误以 { error } 返回，绝不抛出中断宿主。
 */

/** 探索发现的单个元素摘要（elementId 已注册进共享注册表） */
export interface ExploreElementSummary {
  elementId: string;
  tag: string;
  classes?: string;
  id?: string;
  role?: string;
  /** 有界文本摘要（≤80 字符，收集阶段提前截断，不物化大子树字符串） */
  text?: string;
  /** 关键属性提示（href/value/data-testid 等，紧凑单行） */
  attrs?: string;
  /** 直接子元素数 */
  childCount: number;
  visible: boolean;
  /** parent：距种子层数（1 起）；children：BFS 深度（1 起）；其余 0 */
  depth: number;
  /** 列表内序号（从 1 起，按 DOM 顺序） */
  index: number;
  /** 是否为种子元素本身 */
  isSeed?: boolean;
  /** 仅 parent：本层在父下的同构兄弟数（≥2 提示重复容器） */
  repeatsInParent?: number;
}

/** similar 模式的重复模式信息与生成选择器 */
export interface ExplorePattern {
  /** self=种子本身即重复项；descendant=种子位于重复容器内部 */
  mode: 'self' | 'descendant';
  /** descendant 模式：种子所在重复容器的引用（可对其执行 children 展开字段） */
  containerElementId?: string;
  containerTag?: string;
  containerClasses?: string;
  /** 重复容器组总数（visibleOnly 滤除前） */
  containerCount: number;
  /** 容器组选择器（best-effort；与 combinedSelector 二选一存在） */
  selector?: string;
  /** descendant 模式：容器内目标元素的相对选择器 */
  innerSelector?: string;
  /** 完整批量抓取选择器（selector / selector + ' ' + innerSelector） */
  combinedSelector?: string;
  /** 实测选择器在 frame（含 shadow root）内的匹配数，供模型核对覆盖 */
  selectorMatchCount?: number;
}

/** 荷载返回结果（宿主侧补 frameId 与分页封装） */
export interface ExplorePayloadResult {
  fingerprint?: string;
  error?: string;
  /** parent 专用：祖先层摘要（含种子自身为第 0 层） */
  levels?: ExploreElementSummary[];
  /** children / siblings / similar：发现元素列表（DOM 顺序） */
  elements?: ExploreElementSummary[];
  /** 列表总数（分页前） */
  total?: number;
  /** 触达采集上限被截断 */
  truncated?: boolean;
  note?: string;
  /** similar 专用 */
  pattern?: ExplorePattern;
  noPattern?: boolean;
}

/**
 * ⚠️ 自包含约定：采集上限常量在函数体内声明（COLLECT_LIMIT 等）——注入
 * 序列化只携带函数体，模块级常量不会随之进入页面；因此不在模块级定义它们。
 */
export function elementExplorePayload(
  action: 'parent' | 'children' | 'siblings' | 'similar',
  elementId: string,
  levels: number,
  depth: number,
  visibleOnly: boolean,
  tabId: number
): ExplorePayloadResult {
  // —— 注入内上限常量（与模块级声明同步；见上方自包含约定） ——
  const COLLECT_LIMIT = 400;
  const CONTAINER_LIMIT = 500;
  const SCAN_LIMIT = 300;
  const PARENT_MAX_LEVELS = 8;

  // —— 注册表必须已由 browser_observe 建立：绝不自行创建（会覆盖既有引用表） ——
  const registry = (document as { __agentNexusReferences?: any })
    .__agentNexusReferences;
  if (!registry) {
    return {
      error:
        'NO_REGISTRY：当前 frame 尚未建立元素引用——请先 browser_observe 枚举（任意视图），再基于返回的 ElementId + frameId 探索。',
    };
  }
  const fingerprint: string = registry.fingerprint();
  const seed: Element | null = registry.resolve(elementId);
  if (!seed) {
    return {
      fingerprint,
      error:
        'STALE_ELEMENT：引用已失效、属其它 frame 或页面已变化——请 browser_observe 重新枚举，原样复制同行 ElementId 与 FrameId。',
    };
  }

  // ═══════════ 共享工具（自包含，不引用模块绑定） ═══════════

  /** 开放/封闭 shadow root 获取（封闭根需扩展 API，失败则降级仅开放根） */
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

  /** 跨 shadow 边界取父节点 */
  const parentOf = (node: Element): Element | null => {
    const p = node.parentElement;
    if (p) return p;
    const root = node.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };

  /**
   * 跨 shadow 边界的「子元素」视图：宿主的 shadow 顶层子元素并入其直接子元素
   * （与 parentOf 的跨界语义对称——shadow 子元素的「父」即宿主）。
   * Element.contains 不跨越 shadow 边界，children 同样不跨，故必须显式合并。
   */
  const elementChildren = (el: Element): Element[] => {
    const direct = Array.from(el.children);
    const shadow = shadowOf(el);
    if (shadow) direct.push(...Array.from(shadow.children));
    return direct;
  };

  /** 跨 shadow 边界的包含判定（沿 parentOf 链上溯，有界） */
  const encloses = (ancestor: Element, node: Element): boolean => {
    let cur: Element | null = node;
    for (let guard = 0; cur && guard < 64; guard++) {
      if (cur === ancestor) return true;
      cur = parentOf(cur);
    }
    return false;
  };

  const classesOf = (el: Element): Set<string> => {
    const raw = el.getAttribute('class') || '';
    return new Set(raw.split(/\s+/).filter(Boolean));
  };

  const jaccard = (a: Set<string>, b: Set<string>): number => {
    let inter = 0;
    for (const c of a) if (b.has(c)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 1 : inter / union;
  };

  /** 同构兄弟判定：同标签 + class Jaccard ≥ 0.5（两个无 class 的同标签元素视为同构） */
  const isPeerOf = (candidate: Element, base: Element): boolean => {
    if (candidate === base) return false;
    if (candidate.localName !== base.localName) return false;
    return jaccard(classesOf(candidate), classesOf(base)) >= 0.5;
  };

  const isVisible = (el: Element): boolean => {
    try {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        !(Number.parseFloat(style.opacity) < 0.1) &&
        rect.width >= 1 &&
        rect.height >= 1
      );
    } catch {
      return false;
    }
  };

  /** 有界文本收集：手工遍历子树，凑满即停（绝不为大容器物化完整 textContent） */
  const textOf = (el: Element): string => {
    let out = '';
    const walk = (node: Node): void => {
      if (out.length >= 120) return;
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.textContent || '';
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        for (const child of Array.from(node.childNodes)) {
          if (out.length >= 120) return;
          walk(child);
        }
      }
    };
    walk(el);
    return out.trim().replace(/\s+/g, ' ').slice(0, 80);
  };

  /** 关键属性提示（紧凑单行，有界） */
  const attrsOf = (el: Element): string | undefined => {
    const parts: string[] = [];
    for (const name of [
      'data-testid',
      'data-test',
      'data-id',
      'name',
      'type',
    ]) {
      const v = el.getAttribute(name);
      if (v) parts.push(`${name}=${v.slice(0, 40)}`);
      if (parts.length >= 2) break;
    }
    const href = el.getAttribute('href');
    if (href) parts.push(`href=${href.slice(0, 60)}`);
    if ('value' in el) {
      const v = String((el as HTMLInputElement).value || '');
      // 密码框的 value 永不外泄
      if (v && el.getAttribute('type') !== 'password') parts.push(`value=${v.slice(0, 40)}`);
    }
    const out = parts.join(' ');
    return out ? out.slice(0, 120) : undefined;
  };

  /** 摘要 + 注册（新 elementId 进入共享注册表，可供后续工具引用） */
  const summarize = (
    el: Element,
    extra?: Partial<ExploreElementSummary>
  ): ExploreElementSummary => {
    const classes = [...classesOf(el)].slice(0, 3).join(' ');
    const role = el.getAttribute('role');
    const text = textOf(el);
    const attrs = attrsOf(el);
    return {
      elementId: registry.register(el),
      tag: el.localName,
      ...(classes ? { classes } : {}),
      ...(el.id ? { id: el.id } : {}),
      ...(role ? { role } : {}),
      ...(text ? { text } : {}),
      ...(attrs ? { attrs } : {}),
      childCount: el.children.length,
      visible: isVisible(el),
      depth: 0,
      index: 0,
      ...extra,
    };
  };

  // ═══════════ action=parent：祖先链逐层摘要 ═══════════
  if (action === 'parent') {
    const maxLevels = Math.min(
      Math.max(1, Math.floor(levels) || 3),
      PARENT_MAX_LEVELS
    );
    const out: ExploreElementSummary[] = [];
    // 第 0 层：种子自身（同构兄弟数即「种子是否处于重复组」的最直接信号；
    // 用 parentOf/elementChildren 保持跨 shadow 语义一致）
    const seedParent = parentOf(seed);
    out.push(
      summarize(seed, {
        depth: 0,
        index: 1,
        isSeed: true,
        repeatsInParent: seedParent
          ? 1 +
            elementChildren(seedParent).filter((s) => isPeerOf(s, seed)).length
          : 0,
      })
    );
    let current = parentOf(seed);
    for (let level = 1; current && level <= maxLevels; level++) {
      const parent = parentOf(current);
      out.push(
        summarize(current, {
          depth: level,
          index: level + 1,
          repeatsInParent: parent
            ? 1 +
              elementChildren(parent).filter((s) => isPeerOf(s, current!))
                .length
            : 0,
        })
      );
      if (current === document.body) break; // body 之上（html）无探索价值
      current = parent;
    }
    return { fingerprint, levels: out };
  }

  // ═══════════ action=children：BFS 子元素（深度 1..3） ═══════════
  if (action === 'children') {
    const maxDepth = Math.min(Math.max(1, Math.floor(depth) || 1), 3);
    const out: ExploreElementSummary[] = [];
    let hiddenSkipped = 0;
    let truncated = false;
    const queue: { el: Element; depth: number }[] = [
      { el: seed, depth: 0 },
    ];
    let index = 0;
    while (queue.length > 0) {
      const { el, depth: d } = queue.shift()!;
      for (const child of elementChildren(el)) {
        if (out.length >= COLLECT_LIMIT) {
          truncated = true;
          queue.length = 0;
          break;
        }
        if (visibleOnly && !isVisible(child)) {
          hiddenSkipped++;
          // 隐藏分支的子树一并跳过（visibleOnly 语义：整枝不探索）
          continue;
        }
        index++;
        out.push(summarize(child, { depth: d + 1, index }));
        if (d + 1 < maxDepth) queue.push({ el: child, depth: d + 1 });
      }
    }
    return {
      fingerprint,
      elements: out,
      total: out.length,
      ...(truncated ? { truncated: true } : {}),
      note:
        (truncated
          ? `子元素超过采集上限 ${COLLECT_LIMIT}，已截断——请减小 depth 或改对具体子容器逐层探索。`
          : '') +
        (hiddenSkipped > 0
          ? `${hiddenSkipped} 个隐藏子元素被过滤（visibleOnly=true）；需要查看隐藏结构时传 visibleOnly=false。`
          : ''),
    };
  }

  // ═══════════ action=siblings：同父兄弟全列 ═══════════
  if (action === 'siblings') {
    // parentOf 跨 shadow：shadow 顶层元素的兄弟即宿主的子元素
    const parent = parentOf(seed);
    if (!parent) {
      return {
        fingerprint,
        error:
          '种子元素没有可枚举的父级（已脱离文档且不在 shadow 结构内）——请重新枚举。',
      };
    }
    const out: ExploreElementSummary[] = [];
    let hiddenSkipped = 0;
    let truncated = false;
    let index = 0;
    for (const sib of elementChildren(parent)) {
      if (out.length >= COLLECT_LIMIT) {
        truncated = true;
        break;
      }
      if (visibleOnly && !isVisible(sib) && sib !== seed) {
        hiddenSkipped++;
        continue;
      }
      index++;
      out.push(
        summarize(sib, {
          index,
          ...(sib === seed ? { isSeed: true } : {}),
        })
      );
    }
    return {
      fingerprint,
      elements: out,
      total: out.length,
      ...(truncated ? { truncated: true } : {}),
      note:
        (truncated ? `兄弟元素超过采集上限 ${COLLECT_LIMIT}，已截断。` : '') +
        (hiddenSkipped > 0
          ? `${hiddenSkipped} 个隐藏兄弟被过滤；需要全部时传 visibleOnly=false。`
          : ''),
    };
  }

  // ═══════════ action=similar：重复模式发现（核心算法） ═══════════

  /** 种子相对容器的内容链（childIndex 逐层，O(depth)），供等位匹配。
   *  基于 parentElement（同根路径）：种子与容器跨 shadow 根时返回 []，
   *  由调用方回退到 scanCandidates 的 shadow 感知扫描。 */
  const pathOf = (el: Element, root: Element): number[] => {
    const chain: number[] = [];
    let node: Element | null = el;
    let guard = 0;
    while (node && node !== root && guard < 24) {
      const p: Element | null = node.parentElement;
      if (!p) break;
      chain.unshift(Array.prototype.indexOf.call(p.children, node));
      node = p;
      guard++;
    }
    return node === root ? chain : [];
  };
  /** 按 chain 走到容器内等位元素；标签不符或路径越界返回 null */
  const walkPath = (root: Element, chain: number[], tag: string): Element | null => {
    let node: Element = root;
    for (const idx of chain) {
      const children = node.children;
      if (idx < 0 || idx >= children.length) return null;
      node = children[idx];
    }
    return node.localName === tag ? node : null;
  };

  // —— 第 1 步：向上找最近的「重复容器组」（同标签同构兄弟 ≥ 2，含自身）。
  //      parentOf 跨 shadow：shadow 顶层元素可沿宿主继续上溯发现外层重复组 ——
  let groupMode: 'self' | 'descendant' = 'self';
  let group: Element[] = [];
  for (
    let node: Element | null = seed, up = 0;
    node && up < 10;
    node = parentOf(node), up++
  ) {
    const parent = parentOf(node);
    if (!parent) break;
    const siblings = elementChildren(parent); // 单次计算，peers 与输出共用同一视图
    const peers = siblings.filter((s) => isPeerOf(s, node));
    if (peers.length + 1 >= 2) {
      groupMode = node === seed ? 'self' : 'descendant';
      const members = new Set<Element>([node, ...peers]);
      // DOM 顺序输出
      group = siblings.filter((s) => members.has(s));
      break;
    }
  }
  if (group.length === 0) {
    return {
      fingerprint,
      noPattern: true,
      elements: [],
      total: 0,
      note:
        '未发现重复模式：种子的各级祖先下都没有 ≥2 个同构兄弟。该元素可能是页面唯一实例。可用 action="parent" 查看祖先结构，或 action="siblings" 查看同级差异。',
    };
  }
  // 截断前先记录真实容器总数（containerCount 必须报告全量而非截断值）
  const totalContainers = group.length;
  const groupTruncated = group.length > CONTAINER_LIMIT;
  if (groupTruncated) group = group.slice(0, CONTAINER_LIMIT);

  // —— 第 2 步：确定每个重复单元的匹配元素 ——
  let matches: Element[] = [];
  let seedContainer: Element | null = null;
  if (groupMode === 'self') {
    matches = group; // 种子本身就是重复项
  } else {
    // encloses 跨 shadow（Element.contains 不跨越 shadow 边界，不能用于此处）
    seedContainer = group.find((c) => c === seed || encloses(c, seed)) ?? null;
    if (!seedContainer) {
      // 理论不可达（组由种子的祖先链推出）；防御性兜底而非崩溃
      return {
        fingerprint,
        noPattern: true,
        elements: [],
        total: 0,
        note:
          '已发现重复容器组但无法定位种子所在容器（深层 shadow 结构）——请先 action="parent" 逐层确认容器，再以容器引用为种子执行 similar。',
      };
    }
    const container = seedContainer;
    const seedPath = pathOf(seed, container);
    const seedTag = seed.localName;
    /** 容器内同标签候选（含容器自身与其后代的 shadow root——querySelectorAll 不跨 shadow） */
    const scanCandidates = (c: Element): Element[] => {
      const found: Element[] = [];
      let visited = 0;
      const visit = (scope: ParentNode): void => {
        for (const el of Array.from(scope.querySelectorAll(seedTag))) {
          found.push(el);
          if (found.length >= SCAN_LIMIT) return;
        }
        // 递归进入后代 shadow root（访问量有界，防大容器全树扫描）
        for (const el of Array.from(scope.querySelectorAll('*'))) {
          if (++visited > 2000 || found.length >= SCAN_LIMIT) return;
          const shadow = shadowOf(el);
          if (shadow) visit(shadow);
        }
      };
      visit(c);
      // 容器自身的 shadow root 不会出现在自己的 querySelectorAll 结果里，单独访问
      const ownShadow = shadowOf(c);
      if (ownShadow) visit(ownShadow);
      return found.slice(0, SCAN_LIMIT);
    };
    for (const c of group) {
      if (c === container) {
        matches.push(seed);
        continue;
      }
      // 优先等位路径（快且准），失败再回退同标签扫描按 class 相似度取最佳
      let candidate: Element | null =
        seedPath.length > 0 ? walkPath(c, seedPath, seedTag) : null;
      if (!candidate) {
        let best: Element | null = null;
        let bestScore = -1;
        const seedClasses = classesOf(seed);
        for (const el of scanCandidates(c)) {
          const score = jaccard(classesOf(el), seedClasses);
          if (score > bestScore) {
            bestScore = score;
            best = el;
          }
        }
        candidate = best;
      }
      if (candidate) matches.push(candidate);
    }
  }

  // —— 第 3 步：visibleOnly 滤除 + 摘要（DOM 顺序） ——
  const out: ExploreElementSummary[] = [];
  let hiddenSkipped = 0;
  for (const m of matches) {
    if (visibleOnly && !isVisible(m) && m !== seed) {
      hiddenSkipped++;
      continue;
    }
    out.push(
      summarize(m, {
        index: out.length + 1,
        ...(m === seed ? { isSeed: true } : {}),
      })
    );
  }

  // —— 第 4 步：生成选择器（best-effort，附实测匹配数） ——
  const cssEscape = (value: string): string => {
    try {
      return CSS.escape(value);
    } catch {
      return value.replace(/[^a-z0-9_-]/gi, (ch) => '\\' + ch);
    }
  };
  /** class 稳定性过滤：剔除情绪化 css-*、长哈希段、数字开头的动态类 */
  const stableClasses = (el: Element): string[] =>
    [...classesOf(el)].filter(
      (c) =>
        !/^css-/i.test(c) &&
        !/[0-9a-f]{5,}/i.test(c) &&
        !/^\d/.test(c) &&
        c.length <= 40
    );
  /** 组内全部成员共享的稳定 class（首见顺序，取前 3） */
  const commonClasses = (members: Element[]): string[] => {
    if (members.length === 0) return [];
    let shared = stableClasses(members[0]);
    for (const m of members.slice(1)) {
      const own = new Set(stableClasses(m));
      shared = shared.filter((c) => own.has(c));
      if (shared.length === 0) break;
    }
    return shared.slice(0, 3);
  };
  /** 全部根（文档 + 开放 shadow root）下的选择器匹配计数 */
  const countMatches = (selector: string): number | undefined => {
    try {
      const roots: ParentNode[] = [document];
      for (let i = 0; i < roots.length && i < 200; i++) {
        roots[i].querySelectorAll('*').forEach((el) => {
          const shadow = shadowOf(el as Element);
          if (shadow) roots.push(shadow as ParentNode);
        });
      }
      let count = 0;
      for (const root of roots)
        count += root.querySelectorAll(selector).length;
      return count;
    } catch {
      return undefined;
    }
  };

  const pattern: ExplorePattern = {
    mode: groupMode,
    // 报告真实容器总数（截断前），配合 truncated 标记模型可判断覆盖
    containerCount: totalContainers,
  };
  const groupClasses = commonClasses(group);
  if (groupMode === 'descendant' && seedContainer) {
    pattern.containerElementId = registry.register(seedContainer);
    pattern.containerTag = seedContainer.localName;
    const cClasses = groupClasses.join('.');
    if (cClasses) pattern.containerClasses = cClasses;
  } else {
    pattern.containerTag = seed.localName;
    const cClasses = groupClasses.join('.');
    if (cClasses) pattern.containerClasses = cClasses;
  }

  let combined: string | undefined;
  if (groupClasses.length > 0) {
    pattern.selector = groupClasses.map((c) => '.' + cssEscape(c)).join('');
    if (groupMode === 'descendant') {
      const innerClasses = stableClasses(seed).slice(0, 3);
      pattern.innerSelector = innerClasses.length
        ? innerClasses.map((c) => '.' + cssEscape(c)).join('')
        : seed.localName;
      combined = `${pattern.selector} ${pattern.innerSelector}`;
    } else {
      combined = pattern.selector;
    }
  }
  if (combined) {
    pattern.combinedSelector = combined;
    pattern.selectorMatchCount = countMatches(combined);
  }

  return {
    fingerprint,
    elements: out,
    total: out.length,
    pattern,
    ...(groupTruncated || out.length >= COLLECT_LIMIT
      ? { truncated: true }
      : {}),
    note:
      (groupTruncated
        ? `重复容器组共 ${totalContainers} 个超过上限 ${CONTAINER_LIMIT}，已截断到前 ${CONTAINER_LIMIT} 个——请分段（滚动/翻页后重采）抓取。`
        : '') +
      (hiddenSkipped > 0
        ? `${hiddenSkipped} 个隐藏匹配被过滤；需要模板/隐藏节点时传 visibleOnly=false。`
        : '') +
      (pattern.combinedSelector
        ? `生成选择器实测匹配 ${pattern.selectorMatchCount ?? '?'} 个、容器组 ${totalContainers} 个——匹配数明显偏大说明选择器过宽（按容器遍历更稳）；偏小或为 0 常见于 Shadow DOM 结构（选择器不跨 shadow，需在 browser_page_exec 中逐 host 读 shadowRoot 后查询）。`
        : '结构无稳定公共 class，未生成选择器——可在 browser_page_exec 中按 tag+class 交集过滤，或对代表容器逐个 children 探索。'),
  };
}

/**
 * 交付前身份核验（browser_dom_explore 宿主注入）。
 *
 * 与 validateElementReferences 的关键差异：**只验证引用身份与文档指纹，不做
 * 可见性/可交互检查**——DOM 探索是结构工具，visibleOnly=false 时快照中
 * 合法包含隐藏节点（模板、未激活分页），用可见性校验会让每次交付都误报
 * STALE。节点仍连接、签名未变、文档未导航，引用就是有效的；可见性信息
 * 本身是快照数据的一部分（各元素自带 visible 标记）。
 *
 * 同样受注入自包含约束：只依赖 document 全局与注册表接口。
 */
export function validateExploreReferences(ids: string[]): {
  fingerprint: string;
  valid: boolean;
} {
  const registry = (
    document as { __agentNexusReferences?: { resolve(id: string): unknown; fingerprint(): string } }
  ).__agentNexusReferences;
  return {
    fingerprint: registry?.fingerprint() ?? '',
    valid:
      !!registry &&
      ids.every((id) => typeof id === 'string' && registry.resolve(id) !== null),
  };
}
