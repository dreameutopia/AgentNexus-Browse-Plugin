import { JSDOM } from 'jsdom';
import { DomExploreTool } from '../../tools/browser/dom-explore-tool';
import { elementScanPayload } from '../../tools/automation/shared/element-scan-payload';
import { elementExplorePayload } from '../../tools/browser/element-explore-payload';

/**
 * browser_dom_explore 单元测试：真实 JSDOM DOM + 序列化注入（与
 * element-interaction.test.ts 同款宿主适配：payload 以 func.toString()
 * 在干净作用域求值，验证自包含约束），覆盖：
 *   - parent / children / siblings / similar 四 action 的荷载级行为
 *   - similar 两种模式（self / descendant）、生成选择器、noPattern
 *   - visibleOnly 过滤、depth 展开、采集上限截断
 *   - 宿主层：分页快照（40/页）、STALE 语义、参数防御、与 observe 引用互通
 */
export async function testDomExplore(
  check: (condition: boolean, label: string, detail?: unknown) => void,
  eq: (actual: unknown, expected: unknown, label: string) => void
): Promise<void> {
  const savedChrome = globalThis.chrome;
  const globals = [
    'document',
    'window',
    'Node',
    'Element',
    'ShadowRoot',
    'XPathResult',
    'CSS',
    'MouseEvent',
    'Event',
    'getComputedStyle',
  ];
  const saved = globals.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
  );

  // —— 夹具：50 张可见商品卡 + 1 张隐藏卡 + 页面唯一按钮 ——
  const cardHtml = (i: number) =>
    `<div class="product-card" data-testid="sku"><h3 class="title">商品${i}<span class="badge">热卖</span></h3><span class="price">¥${i}</span><a class="buy" href="/buy/${i}">购买${i}</a><button class="fav" title="收藏${i}">收藏</button></div>`;
  const dom = new JSDOM(
    '<!DOCTYPE html><body><div class="list-wrap">' +
      Array.from({ length: 50 }, (_, i) => cardHtml(i + 1)).join('') +
      '<div class="product-card" data-testid="sku" style="display:none"><h3 class="title">隐藏卡</h3><button class="fav">隐藏收藏</button></div>' +
      '</div><div class="sidebar"><button id="unique-btn">唯一按钮</button></div></body>',
    { url: 'https://fixture.example/list', pretendToBeVisual: true }
  );
  const win = dom.window;
  Object.defineProperty(win.crypto, 'randomUUID', { value: undefined });
  // JSDOM 无布局：以「祖先链上任一 display:none → 零尺寸」模拟可见性
  // （isVisible 同时检查 computed style 与 rect，rect 判定即可覆盖级联隐藏）
  const zeroRect = {
    left: 0, top: 0, right: 0, bottom: 0, x: 0, y: 0,
    width: 0, height: 0, toJSON() {},
  } as DOMRect;
  win.Element.prototype.getBoundingClientRect = function () {
    let node: Element | null = this as Element;
    while (node) {
      if ((node as HTMLElement).style?.display === 'none') return zeroRect;
      node = node.parentElement;
    }
    return {
      left: 0, top: 0, right: 80, bottom: 30, x: 0, y: 0,
      width: 80, height: 30, toJSON() {},
    } as DOMRect;
  };
  win.Element.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
  };
  (win.document as any).elementFromPoint = () => null;
  const install = (): void => {
    Object.assign(globalThis, {
      document: win.document,
      window: win,
      Node: win.Node,
      Element: win.Element,
      ShadowRoot: win.ShadowRoot,
      XPathResult: win.XPathResult,
      CSS: { escape: (s: string) => s.replace(/[^a-z0-9_-]/gi, (c) => '\\' + c) },
      MouseEvent: win.MouseEvent,
      Event: win.Event,
      getComputedStyle: win.getComputedStyle.bind(win),
    });
  };
  const restore = (): void => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  };

  /** 以注入语义执行任意 payload（干净作用域 eval，等价 chrome.scripting 序列化） */
  const runPayload = <T>(fn: (...args: any[]) => T, args: unknown[]): T => {
    install();
    try {
      const revived = (0, eval)('(' + fn.toString() + ')');
      return revived(...args);
    } finally {
      restore();
    }
  };

  const data = (r: any): any => r.data ?? {};
  const tabId = 11;

  try {
    // ── 前置：observe 枚举建立注册表，取第一张卡的收藏按钮作种子 ──
    const scan = runPayload(elementScanPayload, ['buttons', '', '', tabId]);
    check(scan.elements.length > 50, '枚举建立注册表并返回卡片按钮', scan.elements.length);
    const seed = scan.elements.find((e: any) => e.description.startsWith('收藏1'))!;
    check(!!seed, '定位到种子元素（收藏按钮）');
    const unique = scan.elements.find((e: any) => e.description === '唯一按钮')!;

    // ── 荷载级：action=parent ──
    const parent = runPayload(elementExplorePayload, ['parent', seed.elementId, 3, 1, false, tabId]);
    check(!parent.error, 'parent 不报错', parent.error);
    eq(parent.levels!.length, 4, 'parent 含种子共 4 层（种子+card+wrap+body 截止）');
    eq(parent.levels![0].isSeed, true, '第 0 层是种子');
    eq(parent.levels![0].repeatsInParent, 1, '收藏按钮在卡片内唯一（同构兄弟 1）');
    eq(parent.levels![1].tag, 'div', '第 1 层是卡片容器');
    eq(parent.levels![1].repeatsInParent, 51, '卡片容器层同构兄弟 51（含隐藏卡）');
    check(!!parent.levels![1].elementId.match(/^anx:/), '新层引用已注册');
    eq(parent.levels![2].tag, 'div', '第 2 层是列表包裹层');
    check(parent.levels!.every((l) => l.elementId), '每层都有可继续探索的引用');

    // ── 荷载级：action=children（depth 展开 + visibleOnly） ──
    const cardId = parent.levels![1].elementId;
    const children = runPayload(elementExplorePayload, ['children', cardId, 3, 2, true, tabId]);
    check(!children.error, 'children 不报错', children.error);
    eq(children.total, 5, '卡片 depth=2 子元素共 5 个（h3/span/a/button + badge）');
    eq(children.elements!.filter((e) => e.depth === 1).length, 4, '深度 1 恰好 4 个直接子元素');
    const badge = children.elements!.find((e) => e.classes === 'badge');
    check(!!badge && badge.depth === 2, '深度 2 发现 badge（h3 内嵌套）');
    check(!!children.elements!.find((e) => e.classes === 'buy')?.attrs?.includes('href=/buy/1'), '链接元素带 href 提示');

    // ── 荷载级：action=siblings ──
    const title = children.elements!.find((e) => e.classes === 'title')!;
    const siblings = runPayload(elementExplorePayload, ['siblings', title.elementId, 3, 1, true, tabId]);
    eq(siblings.total, 4, '标题元素的同父兄弟共 4 个');
    eq(siblings.elements!.find((s) => s.isSeed)?.tag, 'h3', '种子（标题）在兄弟列表中标记');

    // ── 荷载级：action=similar（descendant 模式：种子在重复容器内） ──
    const simTitle = runPayload(elementExplorePayload, ['similar', title.elementId, 3, 1, true, tabId]);
    check(!simTitle.error && !simTitle.noPattern, 'similar(descendant) 发现重复模式');
    eq(simTitle.pattern!.mode, 'descendant', '标题位于容器内 → descendant 模式');
    eq(simTitle.pattern!.containerTag, 'div', '重复容器是卡片 div');
    eq(simTitle.total, 50, '可见匹配 50 个（隐藏卡被 visibleOnly 过滤）');
    eq(simTitle.elements![0].tag, 'h3', '匹配元素与种子同标签');
    check(
      simTitle.elements!.every((e) => (e.text ?? '').startsWith('商品') || e.isSeed),
      '每个容器内取到等位标题'
    );
    eq(simTitle.pattern!.selector, '.product-card', '容器组选择器取公共稳定 class');
    eq(simTitle.pattern!.innerSelector, '.title', '容器内相对选择器');
    eq(simTitle.pattern!.combinedSelector, '.product-card .title', '组合选择器拼接');
    // 选择器按 DOM 匹配（不感知可见性）：51 = 50 可见 + 1 隐藏卡，由模型按容器数核对
    eq(simTitle.pattern!.selectorMatchCount, 51, '选择器实测匹配 51（含隐藏卡节点）');
    check(String(simTitle.note).includes('51'), 'note 说明实测匹配数');

    // visibleOnly=false 时包含隐藏卡
    const simAll = runPayload(elementExplorePayload, ['similar', title.elementId, 3, 1, false, tabId]);
    eq(simAll.total, 51, 'visibleOnly=false 包含隐藏卡（51）');
    check(String(simAll.note).includes('隐藏') === false, '未过滤时不产生隐藏说明', simAll.note);

    // ── 荷载级：action=similar（self 模式：种子即重复项） ──
    const simCard = runPayload(elementExplorePayload, ['similar', cardId, 3, 1, true, tabId]);
    eq(simCard.pattern!.mode, 'self', '卡片本身是重复项 → self 模式');
    eq(simCard.total, 50, 'self 模式匹配 50 张可见卡');
    eq(simCard.pattern!.combinedSelector, '.product-card', 'self 模式选择器直达重复项');

    // ── 荷载级：similar 无重复模式 ──
    const noPattern = runPayload(elementExplorePayload, ['similar', unique.elementId, 3, 1, true, tabId]);
    eq(noPattern.noPattern, true, '唯一元素无重复模式');
    check(String(noPattern.note).includes('parent'), 'noPattern 引导改用 parent/siblings');

    // ── 荷载级：shadow DOM 跨界（种子在 shadow 内、重复容器在 light DOM） ──
    const shadowWrap = win.document.createElement('div');
    for (let i = 1; i <= 3; i++) {
      const host = win.document.createElement('div');
      host.className = 'shadow-card';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML =
        `<h3 class="stitle">影子标题${i}</h3><button class="sfav">影子收藏${i}</button>`;
      shadowWrap.appendChild(host);
    }
    win.document.body.appendChild(shadowWrap);
    const shadowScan = runPayload(elementScanPayload, ['buttons', '', '', tabId]);
    const shadowSeed = shadowScan.elements.find((e: any) =>
      e.description.startsWith('影子收藏1')
    );
    check(!!shadowSeed, '扫描进入 shadow root 发现按钮');
    const simShadow = runPayload(elementExplorePayload, ['similar', shadowSeed!.elementId, 3, 1, true, tabId]);
    check(
      !simShadow.error && !simShadow.noPattern,
      'shadow 种子不崩溃且发现重复模式（contains 不跨 shadow 的缺陷已修复）',
      simShadow.error ?? simShadow.note
    );
    eq(simShadow.pattern!.mode, 'descendant', 'shadow 种子 → descendant 模式（容器在 light DOM）');
    eq(simShadow.pattern!.containerCount, 3, 'shadow 卡片组容器数 3');
    eq(simShadow.total, 3, '跨 shadow 等位匹配全部 3 张影子卡');
    check(
      String(simShadow.note).includes('Shadow DOM') ||
        (simShadow.pattern!.selectorMatchCount ?? 1) === 0,
      '选择器计数如实反映 shadow 不可达（文档级查询为 0）'
    );
    const shadowChildren = runPayload(elementExplorePayload, [
      'children', simShadow.pattern!.containerElementId!, 3, 1, true, tabId,
    ]);
    eq(shadowChildren.total, 2, 'children 合并宿主 shadow 顶层子元素（h3+button）');

    // ── 荷载级：注册表缺失与引用失效防御 ──
    // （runPayload 会重装主窗口全局，这里直接以 fresh DOM 求值模拟「另一文档无注册表」）
    const freshDom = new JSDOM('<!DOCTYPE html><body><button>x</button></body>', {
      url: 'https://fixture.example/other',
      pretendToBeVisual: true,
    });
    const savedDocument = globalThis.document;
    const savedWindow = globalThis.window;
    Object.assign(globalThis, {
      document: freshDom.window.document,
      window: freshDom.window,
    });
    const noRegistry = (0, eval)('(' + elementExplorePayload.toString() + ')')(
      'parent', 'anx:1:a:1', 3, 1, false, tabId
    );
    Object.assign(globalThis, { document: savedDocument, window: savedWindow });
    check(String(noRegistry.error).includes('NO_REGISTRY'), '无注册表时报错并引导先 observe');

    // ── 宿主级：chrome.scripting 桩把 payload 路由到 JSDOM ──
    globalThis.chrome = {
      ...(savedChrome as any),
      tabs: {
        ...(savedChrome as any)?.tabs,
        query: async () => [{ id: tabId, url: 'https://fixture.example/list' }],
      },
      scripting: {
        executeScript: async (options: any) => {
          install();
          try {
            const fn = (0, eval)('(' + options.func.toString() + ')');
            return [
              { frameId: options.target.frameIds?.[0] ?? 0, result: await fn(...options.args) },
            ];
          } finally {
            restore();
          }
        },
      },
    };
    const tool = new DomExploreTool();
    const dataOf = (r: any) => r.data ?? {};

    // 参数防御：非法引用/未知参数/action 专属参数误用
    for (const [args, label] of [
      [{ action: 'parent', elementId: 'not-a-ref', frameId: 0 }, '非 anx 引用被拒绝'],
      [{ action: 'parent', elementId: seed.elementId }, '缺 frameId 被拒绝'],
      [{ action: 'children', elementId: seed.elementId, frameId: 0, levels: 2 }, 'children 不接受 levels'],
      [{ action: 'similar', elementId: seed.elementId, frameId: 0, depth: 2 }, 'similar 不接受 depth'],
      [{ action: 'parent', elementId: seed.elementId, frameId: 0, page: 1 }, 'parent 不分页'],
      [{ action: 'parent', elementId: seed.elementId, frameId: 0, bogus: 1 }, '未知参数被拒绝'],
    ] as [any, string][]) {
      const rejected = await tool.execute(args);
      check(!rejected.success, label, rejected.error);
    }

    // parent 宿主响应
    const parentHost = await tool.execute({ action: 'parent', elementId: seed.elementId, frameId: 0, levels: 2 });
    check(parentHost.success, '宿主 parent 成功', parentHost.error);
    const parentData = dataOf(parentHost);
    check(String(parentData.levels).includes('同构兄弟'), 'parent 表格含同构兄弟列');
    check(
      String(parentData.hint).includes('similar') && String(parentData.hint).includes('疑似重复容器'),
      'parent 命中重复层时引导 similar/children'
    );

    // similar 宿主响应 + 分页（50 匹配 → 2 页）
    const page1 = await tool.execute({ action: 'similar', elementId: title.elementId, frameId: 0 });
    check(page1.success, '宿主 similar 成功', page1.error);
    const p1 = dataOf(page1);
    eq(p1.totalElements, 50, 'similar 总数 50');
    eq(p1.page, 1, '默认第 1 页');
    eq(p1.totalPages, 2, '50 条 / 40 每页 = 2 页');
    eq(p1.nextPage, 2, 'nextPage 指向第 2 页');
    eq(p1.pattern.containerCount, 51, 'pattern 报告容器组总数（过滤前）');
    check(
      String(p1.hint).includes("querySelectorAll('.product-card .title')"),
      'hint 给出可直接使用的批量抓取调用'
    );
    check(String(p1.hint).includes('browser_observe(view="element")'), 'hint 引导单元素深查');

    const page2 = await tool.execute({ action: 'similar', elementId: title.elementId, frameId: 0, snapshotId: p1.snapshotId, page: 2 });
    check(page2.success, '快照续读第 2 页成功', page2.error);
    const p2 = dataOf(page2);
    eq(p2.totalElements, 50, '续读总数不变（快照冻结）');
    eq(p2.nextPage, null, '第 2 页是末页');
    const idsInTable = (d: any): string[] =>
      String(d.elements).match(/anx:\d+:[a-f0-9-]+:\d+/g) ?? [];
    eq(idsInTable(p1).length + idsInTable(p2).length, 50, '两页覆盖全部匹配');
    eq(new Set([...idsInTable(p1), ...idsInTable(p2)]).size, 50, '分页无重复');

    // 改变 action / visibleOnly → STALE_SNAPSHOT
    check(
      !(await tool.execute({ action: 'siblings', elementId: title.elementId, frameId: 0, snapshotId: p1.snapshotId, page: 1 })).success,
      '快照绑定 action，改变即 STALE'
    );
    check(
      !(await tool.execute({ action: 'similar', elementId: title.elementId, frameId: 0, snapshotId: p1.snapshotId, page: 1, visibleOnly: false })).success,
      '快照绑定 visibleOnly，改变即 STALE'
    );
    check(
      !(await tool.execute({ action: 'similar', elementId: title.elementId, frameId: 0, snapshotId: p1.snapshotId, page: 3 })).success,
      '页码越界不重复末页'
    );
    check(
      !(await tool.execute({ action: 'similar', elementId: title.elementId, frameId: 0, page: 2 })).success,
      '无快照不能从第 2 页开始'
    );

    // children / siblings 宿主冒烟（须在结构性变化前执行）
    const childHost = await tool.execute({ action: 'children', elementId: cardId, frameId: 0, depth: 2 });
    check(childHost.success, '宿主 children 成功', childHost.error);
    eq(dataOf(childHost).totalElements, 5, 'children 总数与荷载一致');
    const sibHost = await tool.execute({ action: 'siblings', elementId: title.elementId, frameId: 0 });
    check(sibHost.success, '宿主 siblings 成功', sibHost.error);
    eq(dataOf(sibHost).totalElements, 4, 'siblings 总数与荷载一致');

    // visibleOnly=false：隐藏节点进快照且交付成功（身份核验不含可见性——
    // 旧实现用可交互校验会让每次含隐藏节点的交付误报 STALE）
    const hiddenP1 = await tool.execute({ action: 'similar', elementId: title.elementId, frameId: 0, visibleOnly: false });
    check(hiddenP1.success, 'visibleOnly=false 宿主执行成功', hiddenP1.error);
    eq(dataOf(hiddenP1).totalElements, 51, 'visibleOnly=false 包含隐藏卡（51）');
    const hiddenP2 = await tool.execute({
      action: 'similar', elementId: title.elementId, frameId: 0,
      visibleOnly: false, snapshotId: dataOf(hiddenP1).snapshotId, page: 2,
    });
    check(hiddenP2.success, 'visibleOnly=false 快照续读交付成功（隐藏节点不误报 STALE）', hiddenP2.error);
    eq(dataOf(hiddenP2).totalPages, 2, '51 条仍为 2 页');

    // depth 快照绑定：改变 depth 不能复用旧快照（否则静默返回旧深度的冻结数据）
    const childDepth1 = await tool.execute({ action: 'children', elementId: cardId, frameId: 0, depth: 1 });
    check(childDepth1.success, 'children depth=1 成功', childDepth1.error);
    eq(dataOf(childDepth1).totalElements, 4, 'depth=1 只展开直接子元素');
    check(
      !(await tool.execute({
        action: 'children', elementId: cardId, frameId: 0, depth: 2,
        snapshotId: dataOf(childDepth1).snapshotId, page: 1,
      })).success,
      '改变 depth 不能复用旧快照'
    );

    // 新采集 + DOM 结构性变化 → 交付前核验失败（STALE_ELEMENTS）
    const fresh = await tool.execute({ action: 'similar', elementId: title.elementId, frameId: 0 });
    const freshData = dataOf(fresh);
    // document.URL 不变但节点身份变化：replaceWith 克隆使第一张卡的原节点脱离文档
    const firstCard = win.document.querySelector('.product-card')!;
    firstCard.replaceWith(firstCard.cloneNode(true));
    // 第 1 页包含第一张卡的匹配（种子等位标题），其引用随原节点脱离而失效
    const stale = await tool.execute({
      action: 'similar', elementId: title.elementId, frameId: 0,
      snapshotId: freshData.snapshotId, page: 1,
    });
    check(!stale.success, '容器替换使旧快照交付核验失败', stale.error);
    check(String(stale.error).includes('STALE'), '错误携带 STALE 语义引导重采');
  } finally {
    globalThis.chrome = savedChrome;
    restore();
  }
}
