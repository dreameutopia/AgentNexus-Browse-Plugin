import { BrowserObserveTool } from '../../tools/browser/observe';
import { BrowserInteractTool } from '../../tools/browser/interact';
import { JSDOM } from 'jsdom';
import { elementScanPayload } from '../../tools/automation/shared/element-scan-payload';
import type { ReferenceDocument } from '../../tools/automation/shared/element-reference';

/** Real DOM + serialized injections through the public tools, including host routing. */
export async function testElementInteraction(
  check: (condition: boolean, label: string, detail?: unknown) => void,
  eq: (actual: unknown, expected: unknown, label: string) => void
): Promise<void> {
  const savedChrome = globalThis.chrome;
  const globals = [
    'document',
    'window',
    'Node',
    'Element',
    'XPathResult',
    'CSS',
    'MouseEvent',
    'Event',
    'getComputedStyle',
  ];
  const saved = globals.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
  );
  const frames = new Map<number, JSDOM>();
  const allDoms: JSDOM[] = [];
  let tabId = 11;
  let scanCount = 0;
  let tabUrlOverride: string | undefined;
  let injectionError = false;
  let incomplete = false;
  let beforeValidation: (() => void) | undefined;
  const create = (
    html: string,
    url = 'https://fixture.example/page'
  ): JSDOM => {
    const dom = new JSDOM('<!DOCTYPE html><body>' + html, {
      url,
      pretendToBeVisual: true,
    });
    allDoms.push(dom);
    const win = dom.window;
    // HTTP pages may not expose randomUUID; reference issuance must still work.
    Object.defineProperty(win.crypto, 'randomUUID', { value: undefined });
    win.Element.prototype.getBoundingClientRect = function () {
      const hidden = (this as Element).hasAttribute('data-hidden');
      return {
        left: 10,
        top: 10,
        right: hidden ? 10 : 90,
        bottom: hidden ? 10 : 40,
        x: 10,
        y: 10,
        width: hidden ? 0 : 80,
        height: hidden ? 0 : 30,
        toJSON() {},
      } as DOMRect;
    };
    win.Element.prototype.getClientRects = function () {
      return [this.getBoundingClientRect()] as unknown as DOMRectList;
    };
    // Layout is intentionally independent from order; obstruction gets its own test.
    (win.document as any).elementFromPoint = () => null;
    return dom;
  };
  const install = (dom: JSDOM): void => {
    const win = dom.window;
    Object.assign(globalThis, {
      document: win.document,
      window: win,
      Node: win.Node,
      Element: win.Element,
      XPathResult: win.XPathResult,
      CSS: {
        escape: (s: string) => s.replace(/[^a-z0-9_-]/gi, (c) => '\\' + c),
      },
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
  const data = (r: any): any => r.data ?? {};
  const ids = (r: any): string[] =>
    String(data(r).elements).match(/anx:\d+:[a-f0-9-]+:\d+/g) ?? [];
  const scan = async (mode: 'buttons' | 'inputs', frameId = 0) => {
    const dom = frames.get(frameId)!;
    install(dom);
    try {
      return elementScanPayload(mode, '', '', tabId).elements;
    } finally {
      restore();
    }
  };
  const interact = new BrowserInteractTool();
  const click = {
    execute: (p: any) => interact.execute({ action: 'click', ...p }),
  };
  const fill = {
    execute: (p: any) =>
      interact.execute({ action: 'fill', description: '填写测试控件', ...p }),
  };
  try {
    globalThis.chrome = {
      ...savedChrome,
      tabs: {
        ...savedChrome.tabs,
        query: async () => [
          {
            id: tabId,
            url: tabUrlOverride ?? frames.get(0)!.window.location.href,
          },
        ],
      },
      scripting: {
        ...savedChrome.scripting,
        executeScript: async (options: any) => {
          if (injectionError) throw new Error('frame navigating');
          if (incomplete) return [{ frameId: 0, result: undefined }];
          if (options.func.name === 'elementScanPayload') scanCount++;
          if (
            options.func.name === 'validateElementReferences' &&
            beforeValidation
          ) {
            const mutate = beforeValidation;
            beforeValidation = undefined;
            mutate();
          }
          const results = [];
          for (const frameId of options.target.allFrames
            ? [...frames.keys()]
            : options.target.frameIds) {
            const dom = frames.get(frameId);
            if (!dom) continue;
            install(dom);
            try {
              // Re-evaluate source exactly as chrome.scripting does: no module closures.
              const fn = (0, eval)('(' + options.func.toString() + ')');
              results.push({ frameId, result: await fn(...options.args) });
            } finally {
              restore();
            }
          }
          return results;
        },
      },
    } as unknown as typeof chrome;
    const dom = create(
      Array.from(
        { length: 85 },
        (_, i) => `<button id="duplicate" data-key="${i}">编辑 ${i}</button>`
      ).join('') +
        '<input placeholder="账号"><select><option value="a">甲</option></select>'
    );
    frames.set(0, dom);
    frames.set(
      7,
      create('<button>iframe 按钮</button>', 'https://frame.example/')
    );
    const getter = new BrowserObserveTool('buttons');
    const first = await getter.execute();
    check(first.success, '真实全帧采集通过交付前二次核验', first.error);
    check(
      (await getter.execute(null as any)).success,
      'null 参数按默认新查询执行'
    );
    check(
      !(await getter.execute({ regex: 123 as any })).success,
      '错误 regex 类型被拒绝'
    );
    check(
      !(await getter.execute({ xpath: {} as any })).success,
      '错误 XPath 类型被拒绝'
    );
    check(
      !(await getter.execute({ snapshotId: [] as any })).success,
      '错误 snapshotId 类型被拒绝'
    );
    tabUrlOverride = 'about:blank';
    check(!(await getter.execute()).success, '空白页先行拦截');
    tabUrlOverride = 'chrome://settings/';
    check(!(await getter.execute()).success, '受限页先行拦截');
    tabUrlOverride = undefined;
    injectionError = true;
    check(!(await getter.execute()).success, '注入异常转换为可读失败');
    injectionError = false;
    incomplete = true;
    check(!(await getter.execute()).success, '缺失 frame 结果不会写成成功快照');
    incomplete = false;
    const second = await getter.execute({
      snapshotId: data(first).snapshotId,
      page: 2,
    });
    const third = await getter.execute({
      snapshotId: data(first).snapshotId,
      page: 3,
    });
    eq(
      [...ids(first), ...ids(second), ...ids(third)].length,
      86,
      '三页覆盖主文档和 iframe'
    );
    eq(
      new Set([...ids(first), ...ids(second), ...ids(third)]).size,
      86,
      '重复 HTML id 不影响 ElementId 唯一性与分页无重复'
    );
    check(String(data(second).elements).includes('| 41 |'), '行号跨页连续');
    const unrelated = dom.window.document.createElement('span');
    unrelated.textContent = '计时器变化';
    dom.window.document.body.append(unrelated);
    check(
      (await getter.execute({ snapshotId: data(first).snapshotId, page: 2 }))
        .success,
      '无关 DOM 变化不使冻结分页重排或失效'
    );
    frames.set(9, create('<button>新增 frame</button>'));
    check(
      !(await getter.execute({ snapshotId: data(first).snapshotId, page: 2 }))
        .success,
      '新增 frame 使跨文档快照失效'
    );
    frames.delete(9);
    eq(data(third).nextPage, null, '末页明确 nextPage=null');
    check(!(await getter.execute({ page: 2 })).success, '不带快照不能翻页');
    check(
      !(await getter.execute({ page: Infinity })).success,
      '无限页码被拒绝'
    );
    check(!(await getter.execute({ page: 1.5 })).success, '小数页码被拒绝');
    check(
      !(await getter.execute({ snapshotId: data(first).snapshotId, page: 99 }))
        .success,
      '越界不重复返回最后一页'
    );
    const filtered = await getter.execute({ regex: '编辑 42' });
    eq(data(filtered).totalHits, 1, '过滤命中统计');
    eq(
      ids(filtered)[0],
      (await scan('buttons')).find((e) => e.description === '编辑 42')
        ?.elementId,
      '同节点跨查询 ID 一致'
    );
    check(
      !(
        await getter.execute({
          snapshotId: data(filtered).snapshotId,
          regex: '',
        })
      ).success,
      '清除过滤条件不能混用快照'
    );
    check(
      !(
        await getter.execute({
          snapshotId: data(filtered).snapshotId,
          regex: '别的条件',
        })
      ).success,
      '改变过滤条件不能混用快照'
    );
    const unfiltered = await getter.execute();
    eq(data(unfiltered).filtered, false, '省略快照和条件执行全新无过滤采集');
    const count = scanCount;
    await getter.execute();
    eq(scanCount, count + 1, '新请求始终新采集，不读取隐式查询缓存');
    const noHit = await getter.execute({ regex: '不存在的文本' });
    eq(data(noHit).totalHits, 0, '零命中保留候选并明确统计');
    eq(ids(noHit).length, 40, '零命中仍有候选');
    check(
      !(await getter.execute({ regex: '(' })).success,
      '非法正则返回可读错误'
    );
    check(
      !(await getter.execute({ xpath: '//*[' })).success,
      '非法 XPath 返回可读错误'
    );
    const inputGetter = new BrowserObserveTool('inputs');
    check(
      !(
        await inputGetter.execute({
          view: 'inputs',
          snapshotId: data(first).snapshotId,
        })
      ).success,
      '按钮/输入快照不混用'
    );

    const button = dom.window.document.querySelector('button')!;
    const originalId = (await scan('buttons'))[0].elementId;
    const beforeAction = await getter.execute();
    let clicked = 0;
    button.addEventListener('click', () => clicked++);
    dom.window.document.body.append(button);
    check(
      (
        await click.execute({
          elementId: originalId,
          frameId: 0,
          description: '打开编辑',
        })
      ).success,
      '原节点重排后仍准确点击原节点'
    );
    eq(clicked, 1, '点击不会随位置漂移到其他节点');
    check(
      !(
        await getter.execute({
          snapshotId: data(beforeAction).snapshotId,
          page: 2,
        })
      ).success,
      '操作使旧分页快照失效'
    );
    const records = await scan('buttons');
    const target = records.find((e) => e.description === '编辑 1')!;
    const targetNode = dom.window.document.querySelector('[data-key="1"]')!;
    targetNode.replaceWith(targetNode.cloneNode(true));
    check(
      !(
        await click.execute({
          elementId: target.elementId,
          frameId: 0,
          description: '编辑记录',
        })
      ).success,
      '同结构同属性替换节点使旧 ID 失效'
    );
    const changed = (await scan('buttons')).find(
      (e) => e.description === '编辑 2'
    )!;
    dom.window.document.querySelector('[data-key="2"]')!.textContent = '删除';
    check(
      !(
        await click.execute({
          elementId: changed.elementId,
          frameId: 0,
          description: '编辑',
        })
      ).success,
      '原节点文字变更拒绝静默误操作'
    );
    const frameElement = (await scan('buttons', 7))[0];
    check(
      !(
        await click.execute({
          elementId: frameElement.elementId,
          frameId: 0,
          description: '打开',
        })
      ).success,
      '错误 frame 不会命中其他目标'
    );
    check(
      (
        await click.execute({
          elementId: frameElement.elementId,
          frameId: 7,
          description: '打开',
        })
      ).success,
      '正确 iframe 可直接操作'
    );
    frames.set(
      7,
      create('<button>复用 frameId 的新文档</button>', 'https://frame.example/')
    );
    check(
      !(
        await click.execute({
          elementId: frameElement.elementId,
          frameId: 7,
          description: '打开',
        })
      ).success,
      'frameId 复用且 URL 相同不能复用旧节点引用'
    );
    frames.delete(7);
    check(
      !(
        await click.execute({
          elementId: frameElement.elementId,
          frameId: 7,
          description: '打开',
        })
      ).success,
      'iframe 卸载给出失败而非成功'
    );
    const active = (await scan('buttons'))[0].elementId;
    tabId = 12;
    check(
      !(
        await click.execute({
          elementId: active,
          frameId: 0,
          description: '打开',
        })
      ).success,
      '活动标签切换拒绝旧 tab 引用'
    );
    tabId = 11;
    const beforeNavigate = await getter.execute();
    dom.window.history.pushState({}, '', '/other');
    check(
      !(await getter.execute({ snapshotId: data(beforeNavigate).snapshotId }))
        .success,
      'SPA URL 变化拒绝旧快照'
    );
    check(
      !(
        await click.execute({
          elementId: active,
          frameId: 0,
          description: '打开',
        })
      ).success,
      'SPA URL 变化拒绝旧元素引用'
    );
    // A replacement document at the exact same URL must never inherit node identity.
    const replacement = create(
      '<button>新文档</button>',
      dom.window.location.href
    );
    frames.set(0, replacement);
    check(
      !(
        await click.execute({
          elementId: active,
          frameId: 0,
          description: '打开',
        })
      ).success,
      '同 URL 文档替换拒绝旧引用'
    );

    frames.set(0, dom);
    const inputRecords = await scan('inputs');
    const input = inputRecords.find((e) => e.type === 'input_text')!;
    check(
      (
        await fill.execute({
          elementId: input.elementId,
          frameId: 0,
          value: '测试',
        })
      ).success,
      '标准输入通过原生 setter 写入并回读'
    );
    const inputNode = dom.window.document.querySelector('input')!;
    inputNode.readOnly = true;
    check(
      !(
        await fill.execute({
          elementId: input.elementId,
          frameId: 0,
          value: '不可写',
        })
      ).success,
      '只读输入拒绝填充'
    );
    inputNode.readOnly = false;
    inputNode.addEventListener('input', () => {
      inputNode.value = '';
    });
    check(
      !(
        await fill.execute({
          elementId: input.elementId,
          frameId: 0,
          value: '被框架拒绝',
        })
      ).success,
      '框架回退值不谎报填充成功'
    );
    const selectId = inputRecords.find((e) => e.type === 'select')!.elementId;
    check(
      (await fill.execute({ elementId: selectId, frameId: 0, value: '甲' }))
        .success,
      'select 按选项文字填充'
    );
    check(
      !(
        await fill.execute({
          elementId: selectId,
          frameId: 0,
          value: '缺少选项',
        })
      ).success,
      'select 不存在选项明确失败'
    );

    const host = dom.window.document.createElement('div');
    dom.window.document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<button id="同样 id">影子按钮</button><input placeholder="影子输入">';
    const shadow = (await scan('buttons')).find(
      (e) => e.description === '影子按钮'
    );
    check(!!shadow, 'open Shadow DOM 按钮可采集');
    check(
      (
        await click.execute({
          elementId: shadow!.elementId,
          frameId: 0,
          description: '打开影子按钮',
        })
      ).success,
      'open Shadow DOM 直接节点引用可执行'
    );
    const shadowInput = (await scan('inputs')).find(
      (e) => e.description === '影子输入'
    )!;
    check(
      (
        await fill.execute({
          elementId: shadowInput.elementId,
          frameId: 0,
          value: 'shadow',
        })
      ).success,
      'open Shadow DOM 输入可执行'
    );
    const closedHost = dom.window.document.createElement('section');
    dom.window.document.body.append(closedHost);
    const closedRoot = closedHost.attachShadow({ mode: 'closed' });
    closedRoot.innerHTML =
      '<button>封闭影子按钮</button><input placeholder="封闭影子输入">';
    (globalThis.chrome as any).dom = {
      openOrClosedShadowRoot: (node: Element) =>
        node === closedHost ? closedRoot : node.shadowRoot,
    };
    const closedButton = (await scan('buttons')).find(
      (e) => e.description === '封闭影子按钮'
    );
    check(!!closedButton, '扩展 API 可遍历 closed Shadow DOM');
    check(
      (
        await click.execute({
          elementId: closedButton!.elementId,
          frameId: 0,
          description: '操作封闭影子按钮',
        })
      ).success,
      'closed Shadow DOM 引用交互与采集一致'
    );
    const closedInput = (await scan('inputs')).find(
      (e) => e.description === '封闭影子输入'
    )!;
    check(
      (
        await fill.execute({
          elementId: closedInput.elementId,
          frameId: 0,
          value: 'closed',
        })
      ).success,
      'closed Shadow DOM 输入可回读'
    );
    const readonly = dom.window.document.createElement('input');
    readonly.readOnly = true;
    readonly.value = '只读内容';
    readonly.setAttribute('aria-label', '只读字段');
    dom.window.document.body.append(readonly);
    const structure = await getter.execute({ view: 'structure' });
    check(
      structure.success,
      'structure 接受只读与不可操作信息节点',
      structure.error
    );
    check(
      JSON.stringify(data(structure)).includes('只读内容'),
      'structure 返回只读值供决策使用'
    );
    const pending = await getter.execute();
    beforeValidation = () =>
      (dom.window.document as ReferenceDocument)
        .__agentNexusReferences!.resolve(ids(pending)[0])!
        .remove();
    check(
      !(await getter.execute({ snapshotId: data(pending).snapshotId })).success,
      '交付前移除目标会被二次校验拦截'
    );
    const hiddenPending = await getter.execute();
    beforeValidation = () =>
      (dom.window.document as ReferenceDocument)
        .__agentNexusReferences!.resolve(ids(hiddenPending)[0])!
        .setAttribute('data-hidden', '');
    check(
      !(await getter.execute({ snapshotId: data(hiddenPending).snapshotId }))
        .success,
      '交付前变为不可见会被二次校验拦截'
    );
    check(
      !(
        await click.execute({
          elementId: '#duplicate',
          frameId: 0,
          description: '打开',
        })
      ).success,
      '拒绝将 CSS 当 elementId'
    );
    check(
      !(
        await click.execute({
          elementId: active,
          frameId: NaN,
          description: '打开',
        })
      ).success,
      '非法 frameId 被入口防御拦截'
    );
    const exotic = dom.window.document.createElement('section');
    exotic.innerHTML =
      '<button id="123 : 非标准 id">特殊 ID</button><input type="TEXT" placeholder="大写类型"><svg role="button" aria-label="SVG 按钮"></svg>';
    dom.window.document.body.append(exotic);
    const exoticButtons = await scan('buttons');
    const unusual = exoticButtons.find((el) => el.description === '特殊 ID')!;
    check(
      (
        await click.execute({
          elementId: unusual.elementId,
          frameId: 0,
          description: '打开特殊 ID 按钮',
        })
      ).success,
      '特殊字符数字开头 ID 不影响节点定位'
    );
    const svg = exoticButtons.find((el) => el.description === 'SVG 按钮')!;
    check(
      (
        await click.execute({
          elementId: svg.elementId,
          frameId: 0,
          description: '打开 SVG 控件',
        })
      ).success,
      'SVG 控件没有 click 方法时仍可派发点击'
    );
    check(
      (await scan('inputs')).some(
        (el) => el.type === 'input_text' && el.description === '大写类型'
      ),
      '标准化 input.type 处理非规范大小写'
    );
    const racing = dom.window.document.createElement('button');
    racing.textContent = '事件竞态';
    dom.window.document.body.append(racing);
    const racingId = (await scan('buttons')).find(
      (el) => el.description === '事件竞态'
    )!.elementId;
    let racingClicks = 0;
    racing.addEventListener('click', () => racingClicks++);
    racing.addEventListener('mousedown', () =>
      racing.replaceWith(racing.cloneNode(true))
    );
    check(
      !(
        await click.execute({
          elementId: racingId,
          frameId: 0,
          description: '打开事件竞态',
        })
      ).success,
      'mousedown 替换节点后停止点击'
    );
    eq(racingClicks, 0, '事件竞态不继续调用旧节点 click');
    const offscreen = dom.window.document.createElement('button');
    offscreen.textContent = '滚动竞态';
    dom.window.document.body.append(offscreen);
    offscreen.getBoundingClientRect = () => ({
      left: 10,
      top: 2000,
      right: 90,
      bottom: 2030,
      x: 10,
      y: 2000,
      width: 80,
      height: 30,
      toJSON() {},
    });
    offscreen.scrollIntoView = () =>
      offscreen.replaceWith(offscreen.cloneNode(true));
    const offscreenId = (await scan('buttons')).find(
      (el) => el.description === '滚动竞态'
    )!.elementId;
    check(
      !(
        await click.execute({
          elementId: offscreenId,
          frameId: 0,
          description: '打开滚动竞态',
        })
      ).success,
      '滚动引发节点替换时拒绝继续点击'
    );
    const bfcacheRef = (await scan('buttons'))[0].elementId;
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    check(
      !(
        await click.execute({
          elementId: bfcacheRef,
          frameId: 0,
          description: '打开',
        })
      ).success,
      'pagehide/BFCache 生命周期清除旧引用'
    );

    const originalNow = Date.now;
    const expirySnapshot = await getter.execute();
    const expiryId = ids(expirySnapshot)[0];
    try {
      Date.now = () => originalNow() + 121_000;
      check(
        !(await getter.execute({ snapshotId: data(expirySnapshot).snapshotId }))
          .success,
        '过期快照拒绝续读'
      );
      check(
        !(
          await click.execute({
            elementId: expiryId,
            frameId: 0,
            description: '打开',
          })
        ).success,
        '过期元素 ID 拒绝执行'
      );
    } finally {
      Date.now = originalNow;
    }
    const slots = [];
    for (let i = 0; i < 9; i++)
      slots.push(await getter.execute({ regex: '编辑 ' + i }));
    check(
      !(await getter.execute({ snapshotId: data(slots[0]).snapshotId }))
        .success,
      '容量淘汰旧快照后明确失败'
    );
  } finally {
    globalThis.chrome = savedChrome;
    restore();
    for (const dom of allDoms) dom.window.close();
  }
}
