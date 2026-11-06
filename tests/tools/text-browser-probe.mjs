/** Real Chromium text-only test: browser input, AX, frame DOM and response bodies. No screenshots. */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { browserBuildTarget } from '../../scripts/browser-build-target.mjs';

const bundle = path.resolve('node_modules/.cache/text-browser-driver.mjs');
await build({
  entryPoints: ['tests/tools/text-browser-entry.ts'],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: browserBuildTarget,
  minify: true,
});

const executable = [
  process.env.TEXT_CHROMIUM_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => p && existsSync(p));
if (!executable)
  throw new Error('Set TEXT_CHROMIUM_PATH to a Chromium executable');
const profile = mkdtempSync(path.join(tmpdir(), 'agentnexus-text-probe-'));
const child = spawn(
  executable,
  [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { windowsHide: true },
);
const server = createServer((req, res) => {
  if (req.url === '/api/cells') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ range: 'B2', values: [['服务器数据']] }));
    return;
  }
  if (req.url === '/child') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<input aria-label="子页面输入">');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(
    '<!doctype html><style>body{margin:10px;font:16px sans-serif}#pane{width:220px;height:70px;overflow:auto}#inside{width:900px;height:500px}#grid{border:1px solid;padding:20px}textarea{position:fixed;left:-100px;top:-100px;width:1px;height:1px}</style>\n<input id="namebox" aria-label="名称框"><button id="button">原生按钮</button><div id="grid" role="grid" tabindex="0" aria-label="工作表一"><div role="row"><span id="cell" role="gridcell" aria-rowindex="2" aria-colindex="2">初始值</span></div></div><textarea id="editor" aria-label="单元格编辑器"></textarea><div id="pane" role="region" aria-label="滚动容器"><div id="inside">内容</div></div><iframe src="/child"></iframe><div id="shadow"></div>\n<script>window.nativeKeys=[];window.buttonHits=0;button.onclick=()=>buttonHits++;document.addEventListener(\'keydown\',e=>nativeKeys.push({key:e.key,trusted:e.isTrusted}));namebox.onkeydown=e=>{if(e.key===\'Enter\'){e.preventDefault();grid.dataset.range=namebox.value;grid.focus();}};grid.onkeydown=e=>{if(e.key===\'F2\'||e.key===\'Enter\'){e.preventDefault();editor.value=cell.textContent;editor.focus();}};editor.onkeydown=e=>{if(e.key===\'Enter\'){e.preventDefault();cell.textContent=editor.value;grid.focus();}};shadow.attachShadow({mode:\'open\'}).innerHTML=\'<input aria-label="影子输入">\';</script>',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const contexts = new Map();
const eventListeners = [];
const protocolCalls = [];
let socket;
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Chromium startup timeout')),
      15000,
    );
    child.once('error', reject);
    child.stderr.on('data', (chunk) => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('exit', (code) => reject(new Error(`Chromium exited: ${code}`)));
  });
  const base = String(url)
    .replace(/^ws:/, 'http:')
    .replace(/\/devtools\/browser\/.*/, '');
  const target = await (
    await fetch(
      `${base}/json/new?${encodeURIComponent(`http://127.0.0.1:${server.address().port}`)}`,
      { method: 'PUT' },
    )
  ).json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (
      msg.method === 'Runtime.executionContextCreated' &&
      msg.params.context.auxData?.isDefault
    )
      contexts.set(msg.params.context.auxData.frameId, msg.params.context.id);
    if (msg.method) {
      eventListeners.forEach((f) => f({ tabId: 1 }, msg.method, msg.params));
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timeout`));
        }, 8000);
      protocolCalls.push(method);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', {
    url: `http://127.0.0.1:${server.address().port}`,
  });
  await evaluate(
    'new Promise(r=>document.readyState==="complete"?r():addEventListener("load",r,{once:true}))',
  );
  await send('Page.bringToFront');
  const memory = new Map();
  const area = {
    get: async (key) => ({ [key]: memory.get(key) }),
    set: async (values) => {
      for (const [k, v] of Object.entries(values))
        memory.set(k, structuredClone(v));
    },
  };
  const detachListeners = [];
  globalThis.chrome = {
    tabs: {
      query: async () => [
        {
          id: 1,
          windowId: 1,
          url: `http://127.0.0.1:${server.address().port}`,
        },
      ],
    },
    storage: { session: area, local: area },
    runtime: {
      getManifest: () => ({ manifest_version: 3 }),
      getPlatformInfo: async () => ({
        os: process.platform === 'darwin' ? 'mac' : 'win',
      }),
    },
    debugger: {
      attach: async () => {},
      detach: async () => {
        detachListeners.forEach((f) => f({ tabId: 1 }));
      },
      onEvent: { addListener: (f) => eventListeners.push(f) },
      onDetach: { addListener: (f) => detachListeners.push(f) },
      sendCommand: (_target, method, params) => send(method, params),
    },
    scripting: {
      executeScript: async ({ func, args = [], target: scope, world }) => {
        // JSON.stringify alone would silently turn undefined into null and
        // conceal the Chrome args[2] serialization failure for click.
        for (const [index, arg] of args.entries())
          assert.notEqual(
            arg,
            undefined,
            `injection args[${index}] is unserializable`,
          );
        const tree = await send('Page.getFrameTree');
        const frames = [];
        const visit = (node) => {
          frames.push(node.frame);
          node.childFrames?.forEach(visit);
        };
        visit(tree.frameTree);
        const output = [];
        for (const [frameId, frame] of frames.entries()) {
          if (!scope.allFrames && !(scope.frameIds ?? [0]).includes(frameId))
            continue;
          const isolated = await send('Page.createIsolatedWorld', {
            frameId: frame.id,
            worldName: 'agentnexus-text-test',
          });
          const result = await send('Runtime.evaluate', {
            expression: `(${func.toString()})(...${JSON.stringify(args)})`,
            contextId:
              world === 'MAIN'
                ? contexts.get(frame.id)
                : isolated.executionContextId,
            returnByValue: true,
            awaitPromise: true,
          });
          if (result.exceptionDetails)
            throw new Error(JSON.stringify(result.exceptionDetails));
          output.push({ frameId, result: result.result.value });
        }
        return output;
      },
    },
  };
  const driver = await import(pathToFileURL(bundle).href);
  const observe = new driver.BrowserObserveTool(),
    interact = new driver.BrowserInteractTool(),
    network = new driver.NetworkObserverTool();
  const ok = (r) => {
    assert.equal(r.success, true, r.error);
    return r.data;
  };
  const refByName = async (name, view = 'inputs') => {
    const data = ok(await observe.execute({ view, regex: name }));
    const line = String(data.elements)
      .split('\n')
      .find((line) => line.includes(name) && line.includes('anx:'));
    assert.ok(line, 'missing ' + name + ': ' + JSON.stringify(data));
    const elementId = line.match(/anx:\d+:[a-f0-9-]+:\d+/)[0];
    const frameId = Number(
      line
        .split('|')
        .map((x) => x.trim())
        .filter(Boolean)[5],
    );
    return { elementId, frameId };
  };
  try {
    const button = await refByName('原生按钮', 'buttons');
    ok(
      await interact.execute({
        action: 'click',
        ...button,
        description: '点击原生按钮（无 value 参数）',
      }),
    );
    assert.equal(await evaluate('buttonHits'), 1);
    await evaluate('buttonHits=0');
    const namebox = await refByName('名称框');
    ok(
      await interact.execute({
        action: 'focus',
        ...namebox,
        description: '聚焦名称框',
      }),
    );
    assert.equal(await evaluate('document.activeElement===namebox'), true);
    ok(
      await interact.execute({
        action: 'fill',
        ...namebox,
        value: 'B2',
        description: '定位单元格',
      }),
    );
    const navigated = ok(
      await interact.execute({
        action: 'keys',
        ...namebox,
        keys: ['Enter'],
        description: '进入目标范围',
      }),
    );
    assert.equal(await evaluate('grid.dataset.range'), 'B2');
    const gridFocus = navigated.focus.find((f) => f.tag === 'div');
    assert.ok(gridFocus);
    const edited = ok(
      await interact.execute({
        action: 'keys',
        elementId: gridFocus.elementId,
        frameId: gridFocus.frameId,
        keys: ['F2'],
        description: '进入编辑模式',
      }),
    );
    const editor = edited.focus.find((f) => f.tag === 'textarea');
    assert.ok(editor);
    ok(
      await interact.execute({
        action: 'keys',
        elementId: editor.elementId,
        frameId: editor.frameId,
        keys: ['Mod', 'A'],
        description: '全选当前单元格编辑内容',
      }),
    );
    assert.equal(
      await evaluate(
        'editor.selectionStart===0&&editor.selectionEnd===editor.value.length',
      ),
      true,
      'Mod+A must actually select the editor contents',
    );
    ok(
      await interact.execute({
        action: 'type',
        elementId: editor.elementId,
        frameId: editor.frameId,
        value: '实际浏览器🙂',
        clear: false,
        description: '填写 B2',
      }),
    );
    ok(
      await interact.execute({
        action: 'keys',
        elementId: editor.elementId,
        frameId: editor.frameId,
        keys: ['Enter'],
        description: '确认编辑',
      }),
    );
    assert.equal(await evaluate('cell.textContent'), '实际浏览器🙂');
    ok(
      await interact.execute({
        action: 'fill',
        ...namebox,
        value: '',
        description: '验证标点输入',
      }),
    );
    ok(
      await interact.execute({
        action: 'keys',
        ...namebox,
        keys: ['Shift', '1'],
        description: '输入 US 键位感叹号',
      }),
    );
    assert.equal(
      await evaluate('namebox.value'),
      '!',
      'Shift+1 must insert the mapped punctuation',
    );
    assert.ok(await evaluate('nativeKeys.some(e=>e.key==="F2"&&e.trusted)'));
    const ax = ok(
      await observe.execute({ view: 'accessibility', regex: '原生按钮' }),
    );
    const axButton = ax.elements.find(
      (e) => e.role === 'button' && e.name === '原生按钮',
    );
    assert.ok(axButton);
    ok(
      await interact.execute({
        action: 'keys',
        elementId: axButton.elementId,
        keys: ['Enter'],
        description: '打开按钮',
      }),
    );
    assert.equal(await evaluate('buttonHits'), 1);
    const structure = ok(
      await observe.execute({ view: 'structure', regex: '滚动容器' }),
    );
    const scrollLine = String(structure.elements)
      .split('\n')
      .find((l) => l.includes('滚动容器') && l.includes('anx:'));
    const pane = {
      elementId: scrollLine.match(/anx:\d+:[a-f0-9-]+:\d+/)[0],
      frameId: 0,
    };
    const scrolled = ok(
      await interact.execute({
        action: 'scroll',
        ...pane,
        deltaX: 100,
        deltaY: 100,
        description: '滚动表格容器',
      }),
    );
    assert.equal(scrolled.moved, true);
    assert.ok(await evaluate('pane.scrollLeft>0&&pane.scrollTop>0'));
    const child = await refByName('子页面输入');
    assert.equal(child.frameId, 1);
    ok(
      await interact.execute({
        action: 'fill',
        ...child,
        value: 'frame data',
        description: '填写子页面',
      }),
    );
    const shadow = await refByName('影子输入');
    ok(
      await interact.execute({
        action: 'fill',
        ...shadow,
        value: 'shadow data',
        description: '填写影子控件',
      }),
    );
    assert.equal(
      await evaluate('shadow.shadowRoot.querySelector("input").value'),
      'shadow data',
    );
    const capture = ok(
      await network.execute({ action: 'start', urlIncludes: '/api/' }),
    );
    await evaluate('fetch("/api/cells").then(r=>r.json())');
    let read;
    for (let i = 0; i < 20; i++) {
      read = ok(
        await network.execute({ action: 'read', captureId: capture.captureId }),
      );
      if (read.entries.some((e) => e.dataRef)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(
      read.entries.some((e) => e.dataRef && e.preview.includes('服务器数据')),
      'network body missing',
    );
    ok(await network.execute({ action: 'stop', captureId: capture.captureId }));
    assert.ok(
      !protocolCalls.some((method) => /captureScreenshot/.test(method)),
    );
    await evaluate(`(() => {
      const host=document.createElement('section');
      host.innerHTML='<button aria-label="关闭控件测试" id="semanticClose">关闭</button><input id="semanticCheck" type="checkbox" aria-label="语义勾选"><select id="semanticMulti" multiple aria-label="语义多选"><option value="a" selected>甲</option><option value="b" selected>乙</option><option value="c">丙</option></select><input id="semanticDate" aria-label="语义日期" type="date" max="2026-11-30"><button id="semanticCombo" role="combobox" aria-label="语义组合框" aria-expanded="false" aria-controls="semanticPortal">展开</button><div id="semanticPortal" role="listbox" aria-label="语义选项列表" style="display:none"><div id="semanticOption" role="option" aria-selected="false">选项一</div></div>';
      document.body.append(host);
      semanticCheck.indeterminate=true;
      window.semanticClicks=0;semanticCheck.onclick=()=>semanticClicks++;
      semanticCombo.addEventListener('pointerdown',event=>{event.preventDefault();semanticCombo.setAttribute('aria-expanded','true');semanticPortal.style.display='block';});
      semanticOption.onclick=()=>semanticOption.setAttribute('aria-selected','true');
    })()`);
    const semantic = async (action, ref, args = {}) =>
      interact.execute({
        action,
        ...ref,
        ...args,
        description: '真实浏览器语义交互验证',
      });
    const checkedRef = await refByName('语义勾选', 'controls');
    const initial = ok(await observe.execute({ categories: ['checkbox'] }));
    assert.ok(initial.details.some((item) => item.checked === 'mixed'));
    ok(await semantic('set_checked', checkedRef, { checked: true }));
    const unchanged = ok(
      await semantic('set_checked', await refByName('语义勾选', 'controls'), {
        checked: true,
      }),
    );
    assert.equal(unchanged.changed, false);
    assert.equal(await evaluate('semanticClicks'), 1);
    const multiRef = await refByName('语义多选', 'controls');
    ok(await semantic('select', multiRef, { values: ['a', '丙'] }));
    assert.deepEqual(
      await evaluate('Array.from(semanticMulti.selectedOptions,o=>o.value)'),
      ['a', 'c'],
    );
    assert.equal(
      (
        await semantic('fill', await refByName('语义多选', 'controls'), {
          value: '乙',
        })
      ).success,
      false,
    );
    ok(
      await semantic('fill', await refByName('语义日期', 'controls'), {
        value: '2026-11-20',
      }),
    );
    assert.equal(
      (
        await semantic('fill', await refByName('语义日期', 'controls'), {
          value: '2026-12-20',
        })
      ).success,
      false,
    );
    // Pointer-down is sufficient to open Radix-like controls. Do not click twice.
    ok(
      await semantic(
        'set_expanded',
        await refByName('语义组合框', 'controls'),
        { expanded: true },
      ),
    );
    const expandedRef = await refByName('语义组合框', 'controls');
    ok(await semantic('select', expandedRef, { values: ['选项一'] }));
    assert.equal(
      await evaluate('semanticOption.getAttribute("aria-selected")'),
      'true',
    );
    await evaluate(
      `semanticOption.setAttribute('aria-selected','false');semanticOption.onclick=()=>{semanticCombo.textContent='选项一';semanticCombo.setAttribute('aria-expanded','false');semanticPortal.remove();};`,
    );
    const unmounted = ok(
      await semantic('select', await refByName('语义组合框', 'controls'), {
        values: ['选项一'],
      }),
    );
    assert.equal(unmounted.state.verification, 'owner_value');
    const axControls = ok(
      await observe.execute({
        view: 'accessibility',
        categories: ['checkbox', 'multiselect', 'date'],
      }),
    );
    assert.ok(
      axControls.elements.some((item) => item.category === 'multiselect'),
    );
    assert.ok(
      axControls.elements.some(
        (item) =>
          item.category === 'checkbox' && item.states.checked === 'true',
      ),
    );
    assert.equal(
      (
        await observe.execute({
          snapshotId: axControls.snapshotId,
          categories: ['close'],
        })
      ).success,
      false,
    );
    // A framework replacing the node during change must never produce a verified success.
    await evaluate(
      'semanticCheck.onclick=()=>semanticCheck.replaceWith(semanticCheck.cloneNode(true))',
    );
    const replaced = await semantic(
      'set_checked',
      await refByName('语义勾选', 'controls'),
      { checked: false },
    );
    assert.equal(replaced.success, false);
    assert.equal(replaced.data.outcome, 'unknown');
    await evaluate(`(() => {
      const host=document.createElement('section');
      host.innerHTML='<div data-date-range id="rangeProof"><input type="date" aria-label="区间开始" value="2026-11-05"><input type="date" aria-label="区间结束" value="2026-11-09"></div><div data-calendar role="grid" aria-label="十一月日历"><div role="row"><button id="calendarProof" role="gridcell" aria-label="2026年11月6日" aria-selected="false" data-date="2026-11-06" aria-rowindex="2" aria-colindex="6">6</button></div></div><div id="virtualProof" role="treegrid" aria-label="多维表格" aria-rowcount="1000000" aria-colcount="50"><div role="row" aria-rowindex="500"><div id="cellProof" role="gridcell" aria-label="业务单元格" aria-colindex="23" tabindex="0">原值</div></div></div>';
      document.body.append(host);
      calendarProof.onclick=()=>calendarProof.setAttribute('aria-selected','true');
    })()`);
    const rangeProof=ok(await observe.execute({categories:['date-range']}));
    assert.ok(rangeProof.details.some(item=>item.fields?.length===2));
    ok(await semantic('fill',await refByName('区间开始','controls'),{value:'2026-11-06'}));
    ok(await semantic('fill',await refByName('区间结束','controls'),{value:'2026-11-10'}));
    const calendarProof=ok(await observe.execute({categories:['calendar']}));
    assert.ok(calendarProof.details.some(item=>item.states['data-date']==='2026-11-06'));
    ok(await semantic('set_selected',await refByName('2026年11月6日','controls'),{selected:true}));
    const virtualProof=ok(await observe.execute({view:'structure',regex:'多维表格'}));
    assert.ok(virtualProof.details.some(item=>item.states.rowcount==='1000000'));
    const oldCellProof=await refByName('业务单元格','controls');
    await evaluate('cellProof.parentElement.setAttribute("aria-rowindex","501")');
    assert.equal((await semantic('click',oldCellProof)).success,false);
    await evaluate(`(() => {const button=document.createElement('button');button.setAttribute('role','checkbox');button.setAttribute('aria-checked','false');button.setAttribute('aria-label','取消兼容鼠标事件');button.textContent='取消兼容鼠标事件';document.body.append(button);window.compatibilityMouseCount=0;button.onpointerdown=event=>event.preventDefault();button.onmousedown=()=>compatibilityMouseCount++;button.onclick=()=>button.setAttribute('aria-checked','true');})()`);
    ok(await semantic('set_checked',await refByName('取消兼容鼠标事件','controls'),{checked:true}));
    assert.equal(await evaluate('compatibilityMouseCount'),0,'cancelled pointerdown suppresses compatibility mousedown');
    if (!process.env.TEXT_SEMANTIC_ONLY) {
      const exec = new driver.PageExecTool();
      const scalar = ok(await exec.execute({code:'window.execCount=(window.execCount||0)+1; return window.execCount;'}));
      assert.equal(scalar.resultType,'json-preview');
      assert.equal(scalar.dataRefTrigger,'default');
      assert.equal(JSON.parse(scalar.result),1);
      const scalarRead = ok(await exec.execute({readRef:typeof scalar.dataRef === 'string' ? scalar.dataRef : scalar.dataRef.id}));
      assert.equal(JSON.parse(scalarRead.content),1,'default storage preserves the scalar type');
      assert.equal(await evaluate('window.execCount'),1,'reading storage must not replay execution');
      const bulk = ok(
        await exec.execute({
          code: 'return Array.from({length:300},(_,i)=>({row:i,value:"完整记录"}));',
          strategy: 'scripting',
          world: 'ISOLATED',
          saveResult: true,
        }),
      );
      assert.ok(
        bulk.dataRef,
        'serialized injection must preserve full JSON in dataRef',
      );
      const bulkRef =
        typeof bulk.dataRef === 'string' ? bulk.dataRef : bulk.dataRef.id;
      const bulkTail = ok(
        await exec.execute({
          readRef: bulkRef,
          offset: bulk.totalChars - 300,
          limit: 300,
        }),
      );
      assert.ok(
        bulkTail.content.includes('"row":299'),
        'dataRef must contain rows beyond sanitized preview limit',
      );
      const childResult = ok(await exec.execute({
            code: 'return document.querySelector("input").getAttribute("aria-label");',
            frameId: 1,
            strategy: 'scripting',
            world: 'ISOLATED',
          }));
      assert.equal(JSON.parse(childResult.result),'子页面输入');
      assert.equal(childResult.frameId,1,'child-frame execution preserves routing');
      const cspError = await exec.execute({
        code: 'window.cspCount=(window.cspCount||0)+1;throw new Error("Refused to evaluate because unsafe-eval violates Content Security Policy");',
      });
      assert.equal(cspError.success, false);
      assert.equal(
        await evaluate('window.cspCount'),
        1,
        'runtime CSP-looking errors must not replay',
      );
      const runtimeError = await exec.execute({
        code: 'window.errorCount=(window.errorCount||0)+1; throw new Error("Illegal return statement from application");',
      });
      assert.equal(runtimeError.success, false);
      assert.equal(
        await evaluate('window.errorCount'),
        1,
        'runtime errors must not replay',
      );
      const originalInject = chrome.scripting.executeScript;
      chrome.scripting.executeScript = async (options) => {
        await originalInject(options);
        return [{ frameId: 0, result: undefined }];
      };
      const noResult = await exec.execute({
        code: 'window.noResultCount=(window.noResultCount||0)+1;return window.noResultCount;',
      });
      chrome.scripting.executeScript = originalInject;
      assert.equal(noResult.success, false);
      assert.equal(
        await evaluate('window.noResultCount'),
        1,
        'no-result failures must not replay',
      );
      // Emulate an injection that runs but loses its return value. Never call
      // this stale or replay it: the input event may already have taken effect.
      await evaluate(
        'window.fillEvents=0;namebox.addEventListener("input",()=>fillEvents++)',
      );
      chrome.scripting.executeScript = async (options) => {
        const rows = await originalInject(options);
        return options.target.allFrames ? rows : [{ frameId: 0 }];
      };
      const noFillResult = await interact.execute({
        action: 'fill',
        ...namebox,
        value: '已生效',
        description: '验证无结果时不重放输入',
      });
      const noFocusResult = await interact.execute({
        action: 'focus',
        ...namebox,
        description: '验证无结果时不误报失效引用',
      });
      chrome.scripting.executeScript = originalInject;
      for (const failed of [noFillResult, noFocusResult]) {
        assert.equal(failed.success, false);
        assert.match(failed.error, /INJECTION_NO_RESULT/);
        assert.doesNotMatch(failed.error, /STALE_ELEMENT/);
      }
      assert.equal(
        await evaluate('fillEvents'),
        1,
        'uncertain fill must not replay',
      );
      assert.equal(await evaluate('namebox.value'), '已生效');
      const text = ok(await new driver.GetPageTextTool().execute({}));
      assert.equal(text.coverage.frames.length, 2);
      assert.ok(text.textContent.includes('实际浏览器🙂'));
    }
    console.log(
      '[text-browser] Native/ARIA semantic controls, idempotence, pointer-down expansion, portal selection, multi-select, date constraints, AX categories, replacement recovery, trusted keys, iframe/shadow and response capture passed; zero screenshots.',
    );
  } finally {
    await driver.cdpSession.detachAll();
  }
} finally {
  socket?.close();
  child.kill();
  await new Promise((resolve) => server.close(resolve));
}
