import { BrowserObserveTool } from '../../tools/browser/observe';
import { BrowserInteractTool } from '../../tools/browser/interact';
import { JSDOM } from 'jsdom';
import { testComplexControls } from './complex-controls.test';
import { elementScanPayload } from '../../tools/automation/shared/element-scan-payload';
import type { ReferenceDocument } from '../../tools/automation/shared/element-reference';

/** Real DOM + serialized injections through the public tools, including host routing. */
export async function testElementInteraction(
  check: (condition: boolean, label: string, detail?: unknown) => void,
  eq: (actual: unknown, expected: unknown, label: string) => void,
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
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const frames = new Map<number, JSDOM>();
  const allDoms: JSDOM[] = [];
  let tabId = 11;
  let scanCount = 0;
  let browserAccessCount = 0;
  let tabUrlOverride: string | undefined;
  let injectionError = false;
  let actionInjectionError = false;
  let incomplete = false;
  let beforeValidation: (() => void) | undefined;
  const create = (
    html: string,
    url = 'https://fixture.example/page',
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
        query: async () => {
          browserAccessCount++;
          return [
            {
              id: tabId,
              url: tabUrlOverride ?? frames.get(0)!.window.location.href,
            },
          ];
        },
      },
      scripting: {
        ...savedChrome.scripting,
        executeScript: async (options: any) => {
          browserAccessCount++;
          if (injectionError) throw new Error('frame navigating');
          if (actionInjectionError && options.func.name === 'domActionPayload')
            throw new Error('action response timed out');
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
        (_, i) => `<button id="duplicate" data-key="${i}">编辑 ${i}</button>`,
      ).join('') +
        '<input placeholder="账号"><select><option value="a">甲</option></select>',
    );
    frames.set(0, dom);
    frames.set(
      7,
      create('<button>iframe 按钮</button>', 'https://frame.example/'),
    );
    const getter = new BrowserObserveTool('buttons');
    for (const args of [
      { action: 'scroll', deltaY: 800, description: '滚动文档' },
      { action: 'click', elementId: 'anx:11:test:1', description: '点目标' },
      {
        action: 'click',
        elementId: 'not-a-reference',
        frameId: 0,
        description: '点目标',
      },
    ]) {
      const accesses = browserAccessCount;
      const rejected = await interact.execute(args as any);
      eq(rejected.data?.outcome, 'not_dispatched', '参数拒绝明确告知未派发');
      eq(rejected.data?.errorKind, 'INVALID_ARGUMENT', '参数拒绝可直接修正');
      eq(
        browserAccessCount,
        accesses,
        '参数错误不访问浏览器，不制造焦点或页面副作用',
      );
      check(
        !rejected.error?.includes('可能部分生效'),
        '未派发错误不误导模型重复观察',
      );
    }
    const actionRef = (await scan('buttons'))[0].elementId;
    actionInjectionError = true;
    const uncertain = await click.execute({
      elementId: actionRef,
      frameId: 0,
      description: '打开目标',
    });
    actionInjectionError = false;
    eq(
      uncertain.data?.outcome,
      'unknown',
      '动作注入后的超时仍保守标记效果未知',
    );
    check(
      uncertain.error?.includes('可能部分生效') === true,
      '不允许对效果未知的操作盲目重试',
    );
    const schema = getter.openaiSchema.function.parameters;
    const [enumeration, element] = schema.anyOf! as Array<{
      properties: Record<string, any>;
      required?: string[];
      additionalProperties: boolean;
    }>;
    check(
      !enumeration.properties.elementId &&
        !enumeration.properties.frameId &&
        enumeration.additionalProperties === false,
      '枚举 schema 分支禁止节点与 frame 参数',
    );
    eq(
      element.required,
      ['view', 'elementId', 'frameId'],
      '详情 schema 要求显式 view 和完整 DOM 引用',
    );
    eq(
      Object.keys(element.properties),
      ['view', 'elementId', 'frameId'],
      '详情 schema 不暴露过滤和分页参数',
    );
    check(
      element.additionalProperties === false,
      '详情 schema 禁止混入其它参数',
    );
    eq(
      schema.properties.frameId.type,
      'integer',
      'FrameId schema 与运行时整数约束一致',
    );
    eq(schema.properties.frameId.minimum, 0, 'FrameId schema 允许主文档 0');
    check(
      !('default' in schema.properties.page) &&
        !('default' in schema.properties.view),
      '不通过 schema 默认值给节点详情补 page 或给快照续读补 view',
    );
    for (const view of [
      undefined,
      ...enumeration.properties.view.enum,
    ] as const) {
      for (const reference of [
        { frameId: 0 },
        { frameId: 7 },
        { frameId: null },
        { elementId: '' },
        { elementId: 'anx:11:document:1' },
        { elementId: null, frameId: null },
      ]) {
        const before = browserAccessCount;
        const invalid = await getter.execute({
          ...(view ? { view } : {}),
          regex: '编辑',
          ...reference,
        } as any);
        check(
          !invalid.success &&
            invalid.error?.includes('INVALID_ARGUMENT') === true &&
            invalid.error.includes('删除这些字段'),
          `${view ?? '默认'} 枚举拒绝 ${JSON.stringify(reference)} 并给出删除字段的修复指引`,
        );
        eq(browserAccessCount, before, '错误组合在访问浏览器前被拦截');
      }
    }
    const first = await getter.execute();
    check(first.success, '真实全帧采集通过交付前二次核验', first.error);
    const frameNode = (await scan('buttons', 7))[0];
    const detail = await getter.execute({
      view: 'element',
      elementId: frameNode.elementId,
      frameId: 7,
    });
    check(
      detail.success,
      '指定元素属性通过序列化荷载跨 frame 读取',
      detail.error,
    );
    const mainNode = (await scan('buttons', 0))[0];
    check(
      (
        await getter.execute({
          view: 'element',
          elementId: mainNode.elementId,
          frameId: 0,
        })
      ).success,
      '节点详情接受显式 frameId=0',
    );
    for (const extra of [
      { regex: '' },
      { xpath: '' },
      { page: 1 },
      { snapshotId: '' },
    ]) {
      const before = browserAccessCount;
      const invalid = await getter.execute({
        view: 'element',
        elementId: mainNode.elementId,
        frameId: 0,
        ...extra,
      });
      check(
        !invalid.success &&
          invalid.error?.includes(Object.keys(extra)[0]) === true &&
          invalid.error.includes('仅保留 view、elementId、frameId'),
        '节点详情拒绝多余字段并提供最小重试参数',
      );
      eq(browserAccessCount, before, '详情参数混用在访问浏览器前被拦截');
    }
    for (const frameId of [undefined, null, -1, 0.5]) {
      const before = browserAccessCount;
      check(
        !(
          await getter.execute({
            view: 'element',
            elementId: mainNode.elementId,
            frameId,
          } as any)
        ).success,
        `节点详情拒绝缺失或无效 FrameId: ${frameId}`,
      );
      eq(browserAccessCount, before, '不猜测节点所属 frame');
    }
    eq(
      data(detail).frameUrl,
      'https://frame.example/',
      '元素属性保留来源 frame URL',
    );
    eq(data(detail).text, 'iframe 按钮', '元素属性回传真实文字');
    check(typeof data(detail).xpath === 'string', '元素属性回传可重采 XPath');
    check(
      !(
        await getter.execute({
          view: 'element',
          elementId: frameNode.elementId,
          frameId: 0,
        })
      ).success,
      '错误 frame 不能读取引用',
    );
    check(
      !(
        await getter.execute({
          view: 'element',
          elementId: frameNode.elementId,
          frameId: 7,
          xpath: '//button',
        })
      ).success,
      '指定元素属性禁止混合过滤参数',
    );
    check(
      !(
        await getter.execute({ view: 'element', elementId: 'ax:1', frameId: 7 })
      ).success,
      '指定元素属性不接受 AX 引用',
    );
    check(
      (await getter.execute(null as any)).success,
      'null 参数按默认新查询执行',
    );
    check(
      !(await getter.execute({ regex: 123 as any })).success,
      '错误 regex 类型被拒绝',
    );
    check(
      !(await getter.execute({ xpath: {} as any })).success,
      '错误 XPath 类型被拒绝',
    );
    check(
      !(await getter.execute({ snapshotId: [] as any })).success,
      '错误 snapshotId 类型被拒绝',
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
    check(
      first.success && second.success,
      '默认枚举和省略 view 的快照续读继续正常工作',
    );
    check(
      data(first).hint.includes('枚举不传 elementId/frameId') &&
        !data(first).hint.includes('操作时原样传'),
      '枚举返回提示不再泛化引用参数要求',
    );
    const third = await getter.execute({
      snapshotId: data(first).snapshotId,
      page: 3,
    });
    eq(
      [...ids(first), ...ids(second), ...ids(third)].length,
      86,
      '三页覆盖主文档和 iframe',
    );
    eq(
      new Set([...ids(first), ...ids(second), ...ids(third)]).size,
      86,
      '重复 HTML id 不影响 ElementId 唯一性与分页无重复',
    );
    check(String(data(second).elements).includes('| 41 |'), '行号跨页连续');
    const unrelated = dom.window.document.createElement('span');
    unrelated.textContent = '计时器变化';
    dom.window.document.body.append(unrelated);
    check(
      (await getter.execute({ snapshotId: data(first).snapshotId, page: 2 }))
        .success,
      '无关 DOM 变化不使冻结分页重排或失效',
    );
    frames.set(9, create('<button>新增 frame</button>'));
    check(
      !(await getter.execute({ snapshotId: data(first).snapshotId, page: 2 }))
        .success,
      '新增 frame 使跨文档快照失效',
    );
    frames.delete(9);
    eq(data(third).nextPage, null, '末页明确 nextPage=null');
    check(!(await getter.execute({ page: 2 })).success, '不带快照不能翻页');
    check(
      !(await getter.execute({ page: Infinity })).success,
      '无限页码被拒绝',
    );
    check(!(await getter.execute({ page: 1.5 })).success, '小数页码被拒绝');
    check(
      !(await getter.execute({ snapshotId: data(first).snapshotId, page: 99 }))
        .success,
      '越界不重复返回最后一页',
    );
    const filtered = await getter.execute({ regex: '编辑 42' });
    eq(data(filtered).totalHits, 1, '过滤命中统计');
    eq(
      ids(filtered)[0],
      (await scan('buttons')).find((e) => e.description === '编辑 42')
        ?.elementId,
      '同节点跨查询 ID 一致',
    );
    check(
      !(
        await getter.execute({
          snapshotId: data(filtered).snapshotId,
          regex: '',
        })
      ).success,
      '清除过滤条件不能混用快照',
    );
    check(
      !(
        await getter.execute({
          snapshotId: data(filtered).snapshotId,
          regex: '别的条件',
        })
      ).success,
      '改变过滤条件不能混用快照',
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
      '非法正则返回可读错误',
    );
    check(
      !(await getter.execute({ xpath: '//*[' })).success,
      '非法 XPath 返回可读错误',
    );
    const inputGetter = new BrowserObserveTool('inputs');
    check(
      !(
        await inputGetter.execute({
          view: 'inputs',
          snapshotId: data(first).snapshotId,
        })
      ).success,
      '按钮/输入快照不混用',
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
      '原节点重排后仍准确点击原节点',
    );
    eq(clicked, 1, '点击不会随位置漂移到其他节点');
    check(
      !(
        await getter.execute({
          snapshotId: data(beforeAction).snapshotId,
          page: 2,
        })
      ).success,
      '操作使旧分页快照失效',
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
      '同结构同属性替换节点使旧 ID 失效',
    );
    const changed = (await scan('buttons')).find(
      (e) => e.description === '编辑 2',
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
      '原节点文字变更拒绝静默误操作',
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
      '错误 frame 不会命中其他目标',
    );
    check(
      (
        await click.execute({
          elementId: frameElement.elementId,
          frameId: 7,
          description: '打开',
        })
      ).success,
      '正确 iframe 可直接操作',
    );
    frames.set(
      7,
      create(
        '<button>复用 frameId 的新文档</button>',
        'https://frame.example/',
      ),
    );
    check(
      !(
        await click.execute({
          elementId: frameElement.elementId,
          frameId: 7,
          description: '打开',
        })
      ).success,
      'frameId 复用且 URL 相同不能复用旧节点引用',
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
      'iframe 卸载给出失败而非成功',
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
      '活动标签切换拒绝旧 tab 引用',
    );
    tabId = 11;
    const beforeNavigate = await getter.execute();
    dom.window.history.pushState({}, '', '/other');
    check(
      !(await getter.execute({ snapshotId: data(beforeNavigate).snapshotId }))
        .success,
      'SPA URL 变化拒绝旧快照',
    );
    check(
      !(
        await click.execute({
          elementId: active,
          frameId: 0,
          description: '打开',
        })
      ).success,
      'SPA URL 变化拒绝旧元素引用',
    );
    // A replacement document at the exact same URL must never inherit node identity.
    const replacement = create(
      '<button>新文档</button>',
      dom.window.location.href,
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
      '同 URL 文档替换拒绝旧引用',
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
      '标准输入通过原生 setter 写入并回读',
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
      '只读输入拒绝填充',
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
      '框架回退值不谎报填充成功',
    );
    const selectId = inputRecords.find((e) => e.type === 'select')!.elementId;
    check(
      (await fill.execute({ elementId: selectId, frameId: 0, value: '甲' }))
        .success,
      'select 按选项文字填充',
    );
    check(
      !(
        await fill.execute({
          elementId: selectId,
          frameId: 0,
          value: '缺少选项',
        })
      ).success,
      'select 不存在选项明确失败',
    );

    const host = dom.window.document.createElement('div');
    dom.window.document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<button id="同样 id">影子按钮</button><input placeholder="影子输入">';
    const shadow = (await scan('buttons')).find(
      (e) => e.description === '影子按钮',
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
      'open Shadow DOM 直接节点引用可执行',
    );
    const shadowInput = (await scan('inputs')).find(
      (e) => e.description === '影子输入',
    )!;
    check(
      (
        await fill.execute({
          elementId: shadowInput.elementId,
          frameId: 0,
          value: 'shadow',
        })
      ).success,
      'open Shadow DOM 输入可执行',
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
      (e) => e.description === '封闭影子按钮',
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
      'closed Shadow DOM 引用交互与采集一致',
    );
    const closedInput = (await scan('inputs')).find(
      (e) => e.description === '封闭影子输入',
    )!;
    check(
      (
        await fill.execute({
          elementId: closedInput.elementId,
          frameId: 0,
          value: 'closed',
        })
      ).success,
      'closed Shadow DOM 输入可回读',
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
      structure.error,
    );
    check(
      JSON.stringify(data(structure)).includes('只读内容'),
      'structure 返回只读值供决策使用',
    );
    const pending = await getter.execute();
    beforeValidation = () =>
      (dom.window.document as ReferenceDocument)
        .__agentNexusReferences!.resolve(ids(pending)[0])!
        .remove();
    check(
      !(await getter.execute({ snapshotId: data(pending).snapshotId })).success,
      '交付前移除目标会被二次校验拦截',
    );
    const hiddenPending = await getter.execute();
    beforeValidation = () =>
      (dom.window.document as ReferenceDocument)
        .__agentNexusReferences!.resolve(ids(hiddenPending)[0])!
        .setAttribute('data-hidden', '');
    check(
      !(await getter.execute({ snapshotId: data(hiddenPending).snapshotId }))
        .success,
      '交付前变为不可见会被二次校验拦截',
    );
    check(
      !(
        await click.execute({
          elementId: '#duplicate',
          frameId: 0,
          description: '打开',
        })
      ).success,
      '拒绝将 CSS 当 elementId',
    );
    check(
      !(
        await click.execute({
          elementId: active,
          frameId: NaN,
          description: '打开',
        })
      ).success,
      '非法 frameId 被入口防御拦截',
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
      '特殊字符数字开头 ID 不影响节点定位',
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
      'SVG 控件没有 click 方法时仍可派发点击',
    );
    check(
      (await scan('inputs')).some(
        (el) => el.type === 'input_text' && el.description === '大写类型',
      ),
      '标准化 input.type 处理非规范大小写',
    );
    const racing = dom.window.document.createElement('button');
    racing.textContent = '事件竞态';
    dom.window.document.body.append(racing);
    const racingId = (await scan('buttons')).find(
      (el) => el.description === '事件竞态',
    )!.elementId;
    let racingClicks = 0;
    racing.addEventListener('click', () => racingClicks++);
    racing.addEventListener('mousedown', () =>
      racing.replaceWith(racing.cloneNode(true)),
    );
    check(
      !(
        await click.execute({
          elementId: racingId,
          frameId: 0,
          description: '打开事件竞态',
        })
      ).success,
      'mousedown 替换节点后停止点击',
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
      (el) => el.description === '滚动竞态',
    )!.elementId;
    check(
      !(
        await click.execute({
          elementId: offscreenId,
          frameId: 0,
          description: '打开滚动竞态',
        })
      ).success,
      '滚动引发节点替换时拒绝继续点击',
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
      'pagehide/BFCache 生命周期清除旧引用',
    );

    const originalNow = Date.now;
    const expirySnapshot = await getter.execute();
    const expiryId = ids(expirySnapshot)[0];
    try {
      Date.now = () => originalNow() + 121_000;
      check(
        !(await getter.execute({ snapshotId: data(expirySnapshot).snapshotId }))
          .success,
        '过期快照拒绝续读',
      );
      check(
        !(
          await click.execute({
            elementId: expiryId,
            frameId: 0,
            description: '打开',
          })
        ).success,
        '过期元素 ID 拒绝执行',
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
      '容量淘汰旧快照后明确失败',
    );
    const inspectorDom = create(
      '<label for="q">商品关键词</label><input id="q" placeholder="关键词"><input type="password" value="secret"><select><option value="a" selected>选项甲</option></select><div id="host"></div>',
    );
    frames.clear();
    frames.set(0, inspectorDom);
    const inputs = await scan('inputs');
    const inputDetails = [];
    for (const item of inputs)
      inputDetails.push(
        data(
          await getter.execute({
            view: 'element',
            elementId: item.elementId,
            frameId: 0,
          }),
        ),
      );
    const keyword = inputDetails.find((item) => item.attributes?.id === 'q');
    eq(keyword?.labels, ['商品关键词'], '属性查询补充关联 label 线索');
    check(
      inputDetails.some(
        (item) =>
          item.attributes?.type === 'password' &&
          item.value === undefined &&
          !('value' in item.attributes),
      ),
      '属性查询不返回密码值',
    );
    check(
      inputDetails.some(
        (item) => item.tag === 'select' && item.options?.[0]?.selected,
      ),
      '属性查询回传下拉选项实际状态',
    );
    const staleInput = inputs[0];
    inspectorDom.window.document.getElementById('q')!.remove();
    check(
      !(
        await getter.execute({
          view: 'element',
          elementId: staleInput.elementId,
          frameId: 0,
        })
      ).success,
      '属性查询拒绝已移除元素',
    );
    const inspectedShadow = inspectorDom.window.document
      .getElementById('host')!
      .attachShadow({ mode: 'open' });
    inspectedShadow.innerHTML = '<button>展开设置</button>';
    const shadowNode = (await scan('buttons')).find((item) =>
      item.description.includes('展开设置'),
    )!;
    const shadowDetail = data(
      await getter.execute({
        view: 'element',
        elementId: shadowNode.elementId,
        frameId: 0,
      }),
    );
    check(
      shadowDetail.xpath === null && shadowDetail.shadow.hosts.length === 1,
      'Shadow 属性查询明确作用域，不伪造文档 XPath',
    );
    const quotedButton = inspectorDom.window.document.createElement('button');
    quotedButton.setAttribute('aria-label', `搜索'和"引号`);
    quotedButton.textContent = '带引号按钮';
    inspectorDom.window.document.body.append(quotedButton);
    const quotedRef = (await scan('buttons')).find((item) =>
      item.description.includes('引号'),
    )!;
    const quotedDetail = data(
      await getter.execute({
        view: 'element',
        elementId: quotedRef.elementId,
        frameId: 0,
      }),
    );
    check(
      inspectorDom.window.document.evaluate(
        quotedDetail.xpath,
        inspectorDom.window.document,
        null,
        inspectorDom.window.XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      ).singleNodeValue === quotedButton,
      'XPath 正确转义同时含单双引号的属性',
    );

    // Semantic controls: public tools + serialized payloads, including multi-call routing.
    const controlsDom = create(`
      <input id="date" type="date" max="2026-11-30" aria-label="预约日期">
      <select id="multi" multiple aria-label="兴趣"><option value="a" selected>读书</option><option value="b" selected>运动</option><option value="c">音乐</option><optgroup disabled><option value="d">禁选</option></optgroup></select>
      <input id="cb" type="checkbox" aria-label="协议"><input id="r" type="radio" name="kind" aria-label="个人">
      <label for="hiddenCb" id="labelCb">隐藏输入的可见标签</label><input id="hiddenCb" type="checkbox" data-hidden>
      <button id="combo" role="combobox" aria-controls="portal" aria-expanded="false">城市</button>
      <div id="portal" role="listbox" aria-label="传送列表"><div id="one" role="option" aria-selected="false">杭州</div><div id="duplicate" role="option" aria-selected="false">杭州</div><div id="two" role="option" aria-selected="false">苏州</div></div>
      <div role="listbox"><div role="option" aria-selected="false">苏州</div></div>
      <button id="close" aria-label="关闭">×</button><button id="ordinary">普通操作</button>
      <div id="sw" role="switch" aria-checked="false" tabindex="0">提醒</div>
      <button id="toggle" aria-pressed="false">加粗</button><details><summary id="summary">展开详情</summary>详情</details>
      <div id="pointer" style="cursor:pointer">框架事件入口<span>子图标</span></div>
      <div aria-disabled="true"><div id="disabledOption" role="option" aria-selected="false">禁用子项</div></div>
      <input id="secret" type="password" value="never-disclose" aria-label="密码">
      <button id="dataCheck" role="checkbox" data-state="unchecked">框架勾选</button>
      <div id="dataOption" role="option" data-headlessui-state="">框架选项</div>
      <input id="suggestion" list="suggestions" aria-label="原生建议"><datalist id="suggestions"><option value="alpha">阿尔法</option></datalist>
    `);
    frames.clear();
    frames.set(0, controlsDom);
    const observer = new BrowserObserveTool();
    const document = controlsDom.window.document;
    const reference = async (
      id: string,
      view: 'controls' | 'structure' = 'controls',
    ) => {
      const result = await observer.execute({ view });
      check(result.success, '语义采集成功 ' + id, result.error);
      for (const detail of data(result).details || []) {
        const inspected = data(
          await observer.execute({
            view: 'element',
            elementId: detail.elementId,
            frameId: 0,
          }),
        );
        if (inspected.attributes?.id === id)
          return { elementId: detail.elementId, frameId: 0 };
      }
      throw new Error('missing semantic fixture ' + id);
    };
    const perform = (action: any, ref: any, rest: any = {}) =>
      interact.execute({
        action,
        ...ref,
        ...rest,
        description: '测试语义控件',
      });
    const observed = await observer.execute({});
    const details = data(observed).details;
    check(
      details.some((d: any) => d.category === 'date'),
      '默认感知保留日期类别',
    );
    check(
      details.some((d: any) => d.category === 'combobox'),
      '原生 button 的 combobox 角色优先保留',
    );
    check(
      details.some(
        (d: any) =>
          d.category === 'multiselect' && d.selectedValues.join(',') === 'a,b',
      ),
      '多选集合完整感知',
    );
    const multiDetail = details.find((d: any) => d.category === 'multiselect');
    check(
      multiDetail.options.find((o: any) => o.value === 'd').disabled,
      '继承 optgroup 禁用状态',
    );
    check(
      !JSON.stringify(data(observed)).includes('never-disclose'),
      '语义状态不泄漏密码',
    );
    check(
      details.findIndex((d: any) => d.category === 'close') <
        details.findIndex((d: any) => d.name === '普通操作'),
      '关闭操作提高优先级',
    );
    const closeOnly = await observer.execute({ categories: ['close'] });
    eq(data(closeOnly).totalElements, 1, '类别严格筛选');
    check(
      (await observer.execute({ snapshotId: data(closeOnly).snapshotId }))
        .success,
      '类别续读继承',
    );
    check(
      !(
        await observer.execute({
          snapshotId: data(closeOnly).snapshotId,
          categories: ['radio'],
        })
      ).success,
      '类别改变不能续读旧快照',
    );
    for (const categories of [[], ['bogus'], ['radio', 'radio'], null, 'radio'])
      check(
        !(await observer.execute({ categories } as any)).success,
        '防御非法类别 ' + JSON.stringify(categories),
      );
    check(
      !(
        await observer.execute({
          view: 'element',
          ...(await reference('cb')),
          categories: ['checkbox'],
        } as any)
      ).success,
      '节点详情不接受类别筛选',
    );
    const cb = await reference('cb');
    const oldSnapshot = await observer.execute({ categories: ['checkbox'] });
    (document.getElementById('cb') as HTMLInputElement).indeterminate = true;
    const refreshed = await observer.execute({
      snapshotId: data(oldSnapshot).snapshotId,
    });
    check(
      data(refreshed).details.some((d: any) => d.checked === 'mixed'),
      '冻结成员快照实时刷新原生半选状态',
    );
    const badFill = await perform('fill', cb, { value: 'false' });
    check(
      !badFill.success && data(badFill).outcome === 'not_dispatched',
      'checkbox fill 拒绝且不修改 value',
    );
    eq(
      (document.getElementById('cb') as HTMLInputElement).value,
      'on',
      'checkbox value 未被错误 fill 污染',
    );
    let clicks = 0;
    document.getElementById('cb')!.addEventListener('click', () => clicks++);
    check(
      (await perform('set_checked', cb, { checked: true })).success,
      '半选 checkbox 按目标勾选',
    );
    const noOp = await perform('set_checked', await reference('cb'), {
      checked: true,
    });
    check(noOp.success && data(noOp).changed === false, '重复目标状态无副作用');
    eq(clicks, 1, '幂等设置只点击一次');
    check(
      !(await observer.execute({ snapshotId: data(oldSnapshot).snapshotId }))
        .success,
      '状态操作后旧快照失效',
    );
    check(
      !(await perform('set_checked', await reference('r'), { checked: false }))
        .success,
      'radio 不能单独取消',
    );
    check(
      (
        await perform('set_checked', await reference('labelCb'), {
          checked: true,
        })
      ).success,
      '可见 label 操作隐藏原生 checkbox',
    );
    const multi = await reference('multi');
    check(
      !(await perform('fill', multi, { value: '音乐' })).success,
      '拒绝单字符串覆盖多选集合',
    );
    check(
      (await perform('select', multi, { values: ['读书', 'c'] })).success,
      '原生多选按 value/文字设置集合',
    );
    eq(
      Array.from(
        (document.getElementById('multi') as HTMLSelectElement).selectedOptions,
        (o) => o.value,
      ),
      ['a', 'c'],
      '多选保留明确选中集合',
    );
    check(
      !(
        await perform('select', await reference('multi'), {
          values: ['a', '禁选'],
        })
      ).success,
      '先验证全部选项再修改集合',
    );
    eq(
      Array.from(
        (document.getElementById('multi') as HTMLSelectElement).selectedOptions,
        (o) => o.value,
      ),
      ['a', 'c'],
      '失败选择不会部分修改集合',
    );
    check(
      (await perform('select', await reference('multi'), { values: [] }))
        .success,
      '多选空数组清空集合',
    );
    check(
      (await perform('fill', await reference('date'), { value: '2026-11-20' }))
        .success,
      '合法日期填充',
    );
    check(
      !(await perform('fill', await reference('date'), { value: '2026-12-20' }))
        .success,
      '日期越界不能误报成功',
    );
    document
      .getElementById('combo')!
      .addEventListener('click', () =>
        document
          .getElementById('combo')!
          .setAttribute(
            'aria-expanded',
            document.getElementById('combo')!.getAttribute('aria-expanded') ===
              'true'
              ? 'false'
              : 'true',
          ),
      );
    for (const id of ['one', 'duplicate', 'two'])
      document
        .getElementById(id)!
        .addEventListener('click', () =>
          document.getElementById(id)!.setAttribute('aria-selected', 'true'),
        );
    check(
      (
        await perform('set_expanded', await reference('combo'), {
          expanded: true,
        })
      ).success,
      '展开后核对状态',
    );
    check(
      !(await perform('select', await reference('combo'), { values: ['杭州'] }))
        .success,
      '关联弹层重名选项拒绝猜测',
    );
    check(
      (await perform('select', await reference('combo'), { values: ['苏州'] }))
        .success,
      'Portal 只在明确关联列表选中，不受页面同名项干扰',
    );
    check(
      (
        await perform('set_selected', await reference('two'), {
          selected: true,
        })
      ).success,
      '已选 option 幂等设置',
    );
    document
      .getElementById('sw')!
      .addEventListener('click', () =>
        document.getElementById('sw')!.setAttribute('aria-checked', 'true'),
      );
    check(
      (await perform('set_checked', await reference('sw'), { checked: true }))
        .success,
      '自定义 switch 通过框架事件设置',
    );
    document
      .getElementById('toggle')!
      .addEventListener('click', () =>
        document.getElementById('toggle')!.setAttribute('aria-pressed', 'true'),
      );
    check(
      (
        await perform('set_checked', await reference('toggle'), {
          checked: true,
        })
      ).success,
      'toggle 使用 aria-pressed 回读',
    );
    check(
      (
        await perform('set_expanded', await reference('summary'), {
          expanded: true,
        })
      ).success,
      '原生 details/summary 展开',
    );
    check(
      !!(await reference('pointer')),
      '发现无 onclick 属性的 pointer 框架入口',
    );
    const disabledState = data(
      await observer.execute({
        view: 'element',
        ...(await reference('disabledOption', 'structure')),
      }),
    );
    check(disabledState.semantics.states.disabled, '继承祖先 aria-disabled');
    check(
      !(
        await perform(
          'set_selected',
          await reference('disabledOption', 'structure'),
          { selected: true },
        )
      ).success,
      '禁止操作继承禁用项',
    );
    document
      .getElementById('dataCheck')!
      .addEventListener('click', () =>
        document
          .getElementById('dataCheck')!
          .setAttribute('data-state', 'checked'),
      );
    check(
      (
        await perform('set_checked', await reference('dataCheck'), {
          checked: true,
        })
      ).success,
      'Radix data-state 补充状态可回读',
    );
    document
      .getElementById('dataOption')!
      .addEventListener('click', () =>
        document
          .getElementById('dataOption')!
          .setAttribute('data-headlessui-state', 'selected'),
      );
    check(
      (
        await perform('set_selected', await reference('dataOption'), {
          selected: true,
        })
      ).success,
      'Headless UI 状态令牌可回读',
    );
    const suggestion = data(
      await observer.execute({
        view: 'element',
        ...(await reference('suggestion')),
      }),
    );
    check(
      suggestion.semantics.category === 'combobox' &&
        suggestion.semantics.states.suggestions[0].value === 'alpha',
      '原生 datalist 建议及关联感知',
    );
    const isolated = document.createElement('div');
    isolated.innerHTML =
      '<button id="unlinked" role="combobox" aria-expanded="false">未关联列表</button><button id="changing" role="checkbox" aria-checked="false">变更角色</button><select id="focusRace"><option value="x">X</option><option value="y">Y</option></select><div id="falseDisabled" role="checkbox" data-disabled="false" aria-checked="false">可用</div>';
    document.body.append(isolated);
    const unlinked = await perform('select', await reference('unlinked'), {
      values: ['苏州'],
    });
    check(
      !unlinked.success && data(unlinked).outcome === 'not_dispatched',
      '无关联组合框不会全页误选',
    );
    document.getElementById('changing')!.addEventListener('click', () => {
      document.getElementById('changing')!.setAttribute('role', 'button');
      document.getElementById('changing')!.setAttribute('aria-checked', 'true');
    });
    check(
      !(
        await perform('set_checked', await reference('changing'), {
          checked: true,
        })
      ).success,
      '事件改变控件角色不能误报状态成功',
    );
    document.getElementById('focusRace')!.addEventListener('focus', () => {
      (
        document.querySelector(
          '#focusRace option[value="y"]',
        ) as HTMLOptionElement
      ).disabled = true;
    });
    check(
      !(
        await perform('select', await reference('focusRace'), { values: ['y'] })
      ).success,
      '聚焦时禁用目标选项会停止选择',
    );
    eq(
      (document.getElementById('focusRace') as HTMLSelectElement).value,
      'x',
      '选项竞态不改动已选值',
    );
    check(
      !data(
        await observer.execute({
          view: 'element',
          ...(await reference('falseDisabled')),
        }),
      ).semantics.states.disabled,
      'data-disabled=false 不误判禁用',
    );
    const shadowGuardHost = document.createElement('div');
    document.body.append(shadowGuardHost);
    shadowGuardHost.attachShadow({ mode: 'open' }).innerHTML =
      '<input id="shadowGuard" type="checkbox" aria-label="影子禁用防御">';
    const shadowGuard = await reference('shadowGuard');
    shadowGuardHost.setAttribute('inert', '');
    check(
      !(await perform('set_checked', shadowGuard, { checked: true })).success,
      'Shadow host 的 inert 阻止内部合成事件操作',
    );
    check(
      !(shadowGuardHost.shadowRoot!.querySelector('input') as HTMLInputElement)
        .checked,
      '影子禁用控件状态未被修改',
    );
    for (const params of [
      { action: 'set_checked' },
      { action: 'select', values: ['a', 'a'] },
      { action: 'set_expanded', expanded: 'true' },
      { action: 'set_selected', selected: null },
    ]) {
      const accesses = browserAccessCount;
      check(
        !(
          await interact.execute({
            ...params,
            ...cb,
            description: '校验参数',
          } as any)
        ).success,
        '语义参数错误前置拒绝',
      );
      eq(browserAccessCount, accesses, '参数错误不访问浏览器');
    }
    const boundedDom = create(
      '<select aria-label="有界选项"><option value="' +
        'v'.repeat(900) +
        '">' +
        '文'.repeat(900) +
        '</option></select>',
    );
    frames.clear();
    frames.set(0, boundedDom);
    const bounded = data(await observer.execute({})).details[0];
    check(
      bounded.options[0].text.length === 500 &&
        bounded.options[0].textTruncated,
      '超长选项文字有界并明确截断',
    );
    check(
      bounded.options[0].value.length === 500 &&
        bounded.options[0].valueTruncated,
      '超长选项值有界并明确截断',
    );
    check(
      bounded.valueTruncated && bounded.selectedValuesTruncated,
      '当前值和选中集合明确标记截断',
    );
  } finally {
    globalThis.chrome = savedChrome;
    restore();
    for (const dom of allDoms) dom.window.close();
  }
  await testComplexControls(check, eq);
}
