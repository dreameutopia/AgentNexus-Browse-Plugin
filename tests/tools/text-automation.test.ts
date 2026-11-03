import { BrowserObserveTool } from '../../tools/browser/observe';
import { BrowserInteractTool } from '../../tools/browser/interact';
import { NetworkObserverTool } from '../../tools/browser/network-observer';
import { cdpSession } from '../../tools/browser/cdp-session';
import { SCENARIO_PRESETS } from '../../utils/tools/tool-presets';
import { resolveTextKeys } from '../../tools/browser/text-keys';

export async function testTextAutomation(
  check: (c: boolean, label: string, detail?: unknown) => void,
  eq: (a: unknown, b: unknown, label: string) => void
) {
  for (const os of ['win', 'linux', 'mac']) {
    eq(
      resolveTextKeys(['Mod', 'A'], os).map((k) => k.key),
      [os === 'mac' ? 'Meta' : 'Control', 'a'],
      `Mod+A 正确映射 ${os} 且不隐式加 Shift`
    );
  }
  for (const [alias, key] of Object.entries({
    Ctrl: 'Control',
    Cmd: 'Meta',
    Option: 'Alt',
    Esc: 'Escape',
    Return: 'Enter',
    Del: 'Delete',
    PgUp: 'PageUp',
    PgDn: 'PageDown',
    Left: 'ArrowLeft',
    Spacebar: ' ',
  })) {
    eq(resolveTextKeys([alias])[0].key, key, `快捷键别名 ${alias}`);
  }
  for (let i = 1; i <= 24; i++)
    eq(
      resolveTextKeys([`f${i}`])[0].windowsVirtualKeyCode,
      111 + i,
      `功能键 F${i}`
    );
  for (const key of [
    'ContextMenu',
    'NumLock',
    'ScrollLock',
    'Pause',
    'PrintScreen',
    'Home',
    'End',
    'Insert',
    'Tab',
    'Backspace',
    'ArrowUp',
    'ArrowDown',
    'ArrowRight',
  ])
    check(!!resolveTextKeys([key])[0].code, `映射 ${key}`);
  for (const key of 'abcdefghijklmnopqrstuvwxyz0123456789`~!@#$%^&*()-_=+[]{}\\|;:\'",.<>/? ')
    check(
      !!resolveTextKeys([key]).find((k) => !k.modifier),
      `ASCII 键位 ${key}`
    );
  for (const bad of [
    ['Ctrl', 'Control', 'a'],
    ['Mod', 'Control', 'a'],
    ['F25'],
    ['MediaPlayPause'],
  ]) {
    let rejected = false;
    try {
      resolveTextKeys(bad, 'win');
    } catch {
      rejected = true;
    }
    check(rejected, `重复修饰键或不支持的键被拒绝 ${bad.join(',')}`);
  }
  const saved = globalThis.chrome;
  const events: ((source: any, method: string, params: any) => void)[] = [];
  const detach: ((source: any) => void)[] = [];
  const commands: { method: string; params: any }[] = [];
  let loader = 'doc-a',
    name = '执行按钮',
    failOnKey = false,
    failRelease = false;
  const backend = 10;
  let tabId = 1,
    focused = true;
  const node = () => ({
    nodeId: 'ax-1',
    backendDOMNodeId: backend,
    role: { value: 'button' },
    name: { value: name },
    properties: [{ name: 'focusable', value: { value: true } }],
  });
  const captureIds: string[] = [];
  const data = (r: any) => r.data || {};
  try {
    globalThis.chrome = {
      ...saved,
      runtime: {
        ...saved.runtime,
        getPlatformInfo: async () => ({
          os: 'win',
          arch: 'x86-64',
          nacl_arch: 'x86-64',
        }),
      },
      tabs: {
        ...saved.tabs,
        query: async () => [{ id: tabId, url: 'https://fixture.example/' }],
      },
      debugger: {
        attach: async () => {},
        detach: async () => {
          for (const f of detach) f({ tabId: 1 });
        },
        onDetach: { addListener: (f: any) => detach.push(f) },
        onEvent: { addListener: (f: any) => events.push(f) },
        sendCommand: async (_target: any, method: string, params: any = {}) => {
          commands.push({ method, params: structuredClone(params) });
          if (
            method === 'Input.dispatchKeyEvent' &&
            params.unmodifiedText?.length > 1
          )
            throw new Error('Invalid unmodifiedText');
          if (method === 'Page.getFrameTree')
            return { frameTree: { frame: { id: 'main', loaderId: loader } } };
          if (
            method === 'Accessibility.getFullAXTree' ||
            method === 'Accessibility.getPartialAXTree'
          )
            return { nodes: [node()] };
          if (method === 'DOM.resolveNode')
            return { object: { objectId: 'object-1' } };
          if (method === 'Runtime.callFunctionOn')
            return { result: { value: { focused, editable: true } } };
          if (
            method === 'Input.dispatchKeyEvent' &&
            params.type === 'keyDown' &&
            failOnKey
          )
            throw new Error('transport uncertain');
          if (
            method === 'Input.dispatchKeyEvent' &&
            params.type === 'keyUp' &&
            failRelease
          )
            throw new Error('release failed');
          if (method === 'Network.getResponseBody')
            return { body: '[{"cell":"A1","value":42}]', base64Encoded: false };
          return {};
        },
      },
      scripting: {
        ...saved.scripting,
        executeScript: async () => [{ frameId: 0, result: null }],
      },
    } as unknown as typeof chrome;
    check(
      !SCENARIO_PRESETS.automation.some(
        (id) =>
          id.startsWith('vision_') || id.includes('screenshot') || id === 'ocr'
      ),
      'Auto Action 工具集不含视觉能力'
    );
    const observe = new BrowserObserveTool(),
      interact = new BrowserInteractTool(),
      network = new NetworkObserverTool();
    const first = await observe.execute({ view: 'accessibility' });
    check(first.success, '辅助功能观察真实执行协议调用', first.error);
    check(
      commands.findIndex((c) => c.method === 'Accessibility.enable') <
        commands.findIndex((c) => c.method === 'Accessibility.getFullAXTree'),
      '读取 AX 树前启用域以保持节点编号稳定'
    );
    eq(data(first).elements[0].name, name, 'AX 语义被返回');
    const ref = data(first).elements[0].elementId;
    check(
      typeof ref === 'string' && ref.startsWith('ax:'),
      'AX 操作引用独立于 DOM 行号'
    );
    check(
      !(
        await observe.execute({
          view: 'accessibility',
          snapshotId: data(first).snapshotId,
          regex: 'changed',
        })
      ).success,
      'AX 快照过滤条件不可混用'
    );
    check(
      (await observe.execute({ snapshotId: data(first).snapshotId })).success,
      'AX 快照可自动路由续读'
    );
    check(
      !(
        await observe.execute({
          view: 'structure',
          snapshotId: data(first).snapshotId,
        })
      ).success,
      'AX/DOM 视图快照不能混用'
    );
    const keys = await interact.execute({
      action: 'keys',
      elementId: ref,
      keys: ['Control', 'j'],
      description: '定位名称框',
    });
    check(keys.success, '原生组合键按 AX 引用定位执行', keys.error);
    eq(
      commands
        .filter((c) => c.method === 'Input.dispatchKeyEvent')
        .map((c) => [c.params.type, c.params.key]),
      [
        ['keyDown', 'Control'],
        ['keyDown', 'j'],
        ['keyUp', 'j'],
        ['keyUp', 'Control'],
      ],
      '修饰键按正确顺序按下并反序释放'
    );
    check(
      !(await observe.execute({ snapshotId: data(first).snapshotId })).success,
      '交互后旧 AX 分页失效'
    );
    const fresh = await observe.execute({ view: 'accessibility' }),
      freshRef = data(fresh).elements[0].elementId;
    check(
      (
        await interact.execute({
          action: 'keys',
          elementId: freshRef,
          keys: ['F2'],
          description: '进入编辑',
        })
      ).success,
      '纯文本原生键盘支持 F2'
    );
    check(
      (
        await interact.execute({
          action: 'type',
          elementId: freshRef,
          value: '中文🙂',
          description: '输入编辑内容',
        })
      ).success,
      '原生文本插入不依赖图片'
    );
    eq(
      commands.find((c) => c.method === 'Input.insertText')?.params.text,
      '中文🙂',
      'Unicode 文本完整交给浏览器'
    );
    for (const [names, expectedKey, mask] of [
      [['Ctrl', 'A'], 'a', 2],
      [['Mod', 'Shift', 'Z'], 'Z', 10],
      [['Control', 'Shift', '1'], '!', 10],
      [['Option', 'ArrowDown'], 'ArrowDown', 1],
      [['Shift', 'Tab'], 'Tab', 8],
    ] as [string[], string, number][]) {
      const start = commands.length;
      const result = await interact.execute({
        action: 'keys',
        elementId: freshRef,
        keys: names,
        description: '验证常用快捷键',
      });
      check(result.success, `执行 ${names.join('+')}`, result.error);
      const main = commands
        .slice(start)
        .find(
          (c) =>
            c.method === 'Input.dispatchKeyEvent' &&
            c.params.type === 'keyDown' &&
            c.params.key === expectedKey
        );
      eq(main?.params.modifiers, mask, `主键语义与修饰位 ${names.join('+')}`);
      check(
        main?.params.text === undefined,
        '带 Control/Alt 的组合键不额外插入文字'
      );
    }
    const before = commands.length;
    check(
      !(
        await interact.execute({
          action: 'keys',
          elementId: freshRef,
          keys: ['a', 'b'],
          description: '错误组合',
        })
      ).success,
      '拒绝多个主键混成组合键'
    );
    eq(commands.length, before, '参数错误不触发协议副作用');
    check(
      !(
        await interact.execute({
          action: 'keys',
          elementId: freshRef,
          keys: ['Enter'],
          value: 'stray',
          description: '错误参数',
        } as any)
      ).success,
      '拒绝不属于 action 的参数'
    );
    focused = false;
    check(
      !(
        await interact.execute({
          action: 'type',
          elementId: freshRef,
          value: '禁止误输',
          description: '测试焦点',
        })
      ).success,
      '焦点不匹配停止原生输入'
    );
    focused = true;
    name = '删除按钮';
    check(
      !(
        await interact.execute({
          action: 'focus',
          elementId: freshRef,
          description: '打开',
        })
      ).success,
      'AX 名称变化使旧引用失效'
    );
    name = '执行按钮';
    loader = 'doc-b';
    check(
      !(
        await interact.execute({
          action: 'focus',
          elementId: freshRef,
          description: '打开',
        })
      ).success,
      '同 URL 新文档不能复用 AX 引用'
    );
    const newDoc = await observe.execute({ view: 'accessibility' }),
      newRef = data(newDoc).elements[0].elementId;
    tabId = 2;
    check(
      !(
        await interact.execute({
          action: 'focus',
          elementId: newRef,
          description: '打开',
        })
      ).success,
      'AX 引用拒绝跨 tab 使用'
    );
    tabId = 1;
    failOnKey = true;
    const failed = await interact.execute({
      action: 'keys',
      elementId: newRef,
      keys: ['Control', 'j'],
      description: '异常组合键',
    });
    check(!failed.success, '原生按键传输失败不会谎报成功');
    check(
      commands.some(
        (c) =>
          c.method === 'Input.dispatchKeyEvent' &&
          c.params.type === 'keyUp' &&
          c.params.key === 'Control'
      ),
      '按下不确定时仍尝试释放修饰键'
    );
    failRelease = true;
    const cleanupObserve = await observe.execute({ view: 'accessibility' });
    const cleanupRef = data(cleanupObserve).elements[0].elementId;
    const cleanup = await interact.execute({
      action: 'keys',
      elementId: cleanupRef,
      keys: ['Control', 'j'],
      description: '清理失败测试',
    });
    check(
      !cleanup.success && !cdpSession.hasSession(1),
      '释放失败会脱离不确定的调试会话'
    );
    failOnKey = false;
    failRelease = false;
    const aborted = new AbortController();
    aborted.abort();
    const afterDetach = await observe.execute({ view: 'accessibility' });
    const beforeAbort = commands.filter((c) =>
      c.method.startsWith('Input.')
    ).length;
    check(
      !(
        await interact.execute(
          {
            action: 'keys',
            elementId: data(afterDetach).elements[0].elementId,
            keys: ['Enter'],
            description: '取消测试',
          },
          { signal: aborted.signal }
        )
      ).success,
      '取消信号停止操作'
    );
    eq(
      commands.filter((c) => c.method.startsWith('Input.')).length,
      beforeAbort,
      '取消后不派发原生输入'
    );

    const parallel = await Promise.all([
      network.execute({ action: 'start', urlIncludes: '/api/' }),
      network.execute({ action: 'start' }),
    ]);
    eq(
      parallel.filter((r) => r.success).length,
      1,
      '并发启动同 tab 捕获只能成功一个'
    );
    const captureId = data(parallel.find((r) => r.success)).captureId;
    captureIds.push(captureId);
    const emit = (method: string, params: any) =>
      events.forEach((f) => f({ tabId: 1 }, method, params));
    emit('Network.requestWillBeSent', {
      requestId: 'ignored',
      request: { url: 'https://fixture.example/image.png', method: 'GET' },
    });
    emit('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://fixture.example/api/cells', method: 'GET' },
      type: 'Fetch',
      frameId: 'main',
    });
    emit('Network.responseReceived', {
      requestId: 'r1',
      response: { status: 200, mimeType: 'application/json' },
    });
    emit('Network.loadingFinished', {
      requestId: 'r1',
      encodedDataLength: 100,
    });
    await new Promise((r) => setTimeout(r, 20));
    const read = await network.execute({ action: 'read', captureId });
    eq(data(read).totalRequests, 1, 'URL 过滤只记录匹配请求');
    check(!!data(read).entries[0].dataRef?.id, '真实响应正文进入 dataRef');
    check(
      String(data(read).entries[0].preview).includes('A1'),
      '返回受限正文预览'
    );
    check(
      !(await network.execute({ action: 'read', captureId, limit: 21 }))
        .success,
      '网络读取分页容量防御'
    );
    check(
      !(await network.execute({ action: 'read', captureId: 'missing' }))
        .success,
      '未知捕获引用明确失败'
    );
    check(
      (await network.execute({ action: 'stop', captureId })).success,
      '停止真实 Network domain'
    );
    check(
      (await network.execute({ action: 'read', captureId })).success,
      '停止后可读取已有捕获结果'
    );
    const restarted = await network.execute({ action: 'start' });
    check(restarted.success, '停止后可启动新捕获');
    captureIds.push(data(restarted).captureId);
    const disables = commands.filter(
      (c) => c.method === 'Network.disable'
    ).length;
    await network.execute({ action: 'stop', captureId });
    eq(
      commands.filter((c) => c.method === 'Network.disable').length,
      disables,
      '重复停止旧捕获不能关闭新捕获的 Network 域'
    );
    check(
      !commands.some((c) => /captureScreenshot|captureSnapshot/.test(c.method)),
      '所有新能力不调用截图或视觉通道'
    );
  } finally {
    for (const id of captureIds)
      await new NetworkObserverTool()
        .execute({ action: 'stop', captureId: id })
        .catch(() => undefined);
    await cdpSession.detachAll();
    globalThis.chrome = saved;
  }
}
