import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import 'fake-indexeddb/auto';
const outfile = path.resolve('node_modules/.cache/js-run-contract.mjs');
await build({ stdin: { contents: `
  export { JsRunTool } from './tools/javascript/js-run-tool';
  export { PythonRunTool } from './tools/python/python-run-tool';
  export { chatDatabase } from './entrypoints/sidepanel/core/context/chat-database';
  export { readWorkspaceTextFile, readWorkspaceFilePage, WORKSPACE_READ_PAGE_CHARS } from './utils/python-workspace/workspace-files';
  export { saveWorkspaceResultFile, WORKSPACE_DATA_FILE_MAX_BYTES } from './utils/python-workspace/data-files';
  export { CORE_SESSION_TOOL_IDS, SCENARIO_PRESETS, getPresetToolIds } from './utils/tools/tool-presets';
  export { normalizeToolIds, normalizeAgentConfig } from './utils/agents/agent-types';
  export { normalizeAllowedToolList } from './utils/skills/skill-types';
  export { runtimeBuilder } from './entrypoints/sidepanel/core/runtime/runtime-builder';
  export { modelRegistry } from './entrypoints/sidepanel/utils/channels';
  export { openaiToolsConverter } from './entrypoints/sidepanel/utils/tools/openai-tools-converter';
  export { needsVisionRefresh } from './entrypoints/sidepanel/core/conversation/vision-feedback';
  export { registerAllTools, toolRegistry } from './tools';
  export { initToolsManagerListener } from './entrypoints/background/tools/tools-manager-listener';
  export { executeTool } from './entrypoints/sidepanel/utils/tools/openai-tools/tool-executor';
  export { cdpSession } from './tools/browser/cdp-session';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile, external: ['jsdom'],
    loader: { '.css': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty' },
    plugins: [{ name: 'glob', setup(b) { b.onLoad({ filter: /\.(ts|js)$/ }, args => { if (args.path.includes('node_modules'))
                return; const source = fs.readFileSync(args.path, 'utf-8'); if (source.includes('import.meta.glob'))
                return { contents: 'const __glob = () => ({});\n' + source.replace(/import\.meta\.glob/g, '__glob'), loader: 'ts' }; }); } }],
});
const stored = {};
const storage = {
    async get(keys, callback) { const value = keys == null ? structuredClone(stored) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in stored).map(key => [key, structuredClone(stored[key])])); callback?.(value); return value; },
    async set(value, callback) { Object.assign(stored, structuredClone(value)); callback?.(); },
    async remove(keys, callback) { for (const key of Array.isArray(keys) ? keys : [keys])
        delete stored[key]; callback?.(); },
};
const listeners = new Set();
const events = () => ({ addListener() { }, removeListener() { } });
const worlds = new Map();
let injections = [], failProbe = false, pageFailure = false, cdpCalls = 0;
function world(id, kind) {
    const key = id + ':' + kind;
    if (!worlds.has(key)) {
        const context = vm.createContext({ setTimeout, clearTimeout });
        context.window = context;
        worlds.set(key, context);
    }
    return worlds.get(key);
}
globalThis.chrome = {
    runtime: { id: 'test', getManifest: () => ({}), getURL: p => 'chrome-extension://test/' + p, getPlatformInfo: async () => ({}),
        onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) }, sendMessage: async () => undefined,
    },
    storage: { local: storage, session: storage, onChanged: events() },
    tabs: { query: async () => [{ id: 1, url: 'https://example.test' }], get: async (id) => ({ id, url: 'https://example.test' }), onRemoved: events(), onUpdated: events() },
    scripting: { async executeScript(request) {
            injections.push(request);
            if (failProbe)
                return [{ result: { success: false, safeFallback: true, error: 'CSP denied eval' } }];
            if (pageFailure)
                return [{ result: { success: false, safeFallback: false, error: 'CSP failure inside user script' } }];
            const ctx = world(request.target.tabId, request.world);
            ctx.__args = request.args;
            const result = await vm.runInContext('(' + request.func.toString() + ')(...__args)', ctx);
            return [{ frameId: request.target.frameIds[0], result }];
        } },
    debugger: { attach: async () => { }, detach: async () => { }, sendCommand: async () => ({}), onDetach: events(), onEvent: events() },
    permissions: { contains: async () => true },
};
globalThis.browser = chrome;
const api = await import(pathToFileURL(outfile).href);
api.registerAllTools();
const js = new api.JsRunTool(), py = new api.PythonRunTool();
for (const chatId of ['js-a', 'js-b'])
    await api.chatDatabase.createSession({ chatId, title: chatId, createdAt: 1, updatedAt: 1, messageCount: 0, lastMessagePreview: '', agentName: '', skillNames: [] });
const context = { chatId: 'js-a' };
const call = (args, ctx = context) => js.execute(args, ctx);
const text = r => r.error ?? r.content?.filter(c => c.type === 'text').map(c => c.text).join(' ') ?? '';
const create = async (path, content) => { const r = await call({ action: 'create', path, content }); assert.equal(r.success, true, text(r)); };
for (const args of [null, { action: 'run', code: 'return 1' }, { action: 'create', path: '../x.js', content: '' }, { action: 'run', path: 'scripts/a.js', content: 'return 1' }, { action: 'edit', path: 'a.txt', find: 'x' }, { action: 'create', path: 'a.txt', content: 1 }, { action: 'list', limit: -1 }, { action: 'read' }, { action: 'read', path: 'a.txt', index: 0 }, { action: 'read', path: 'a.txt', readRef: 'abcd1234' }, { action: 'run', path: 'scripts/a.js', saveResult: false }])
    assert.equal((await call(args)).success, false, JSON.stringify(args));
assert.equal((await js.execute({ action: 'create', path: 'a.txt', content: 'x' })).success, false);
await create('scripts/collect.js', 'return { page: $args[0].page, values: $args[1], count: (window.count = (window.count || 0) + 1) };');
const run = await call({ action: 'run', path: 'scripts/collect.js', args: [{ page: 2 }, ['a', 'b']], tabId: 12, frameId: 3, world: 'ISOLATED', strategy: 'scripting', timeout: 1234, label: 'batch' });
assert.equal(run.success, true, text(run));
assert.equal(run.data.script.path, 'scripts/collect.js');
assert.equal(JSON.parse(run.data.result).page, 2);
assert.equal(run.data.dataRef, undefined, 'run 不再产生 dataRef 暂存批次');
assert.ok(run.data.resultFile, 'run 携带结果文件');
assert.match(run.data.resultFile.path, /^results\/run-[\w-]+-batch\.json$/);
assert.equal(run.data.shape.kind, 'value');
assert.doesNotMatch(text(run), /index=2/, '不足 2000 字符的结果不出现续读提醒');
assert.deepEqual(injections.at(-1).target, { tabId: 12, frameIds: [3] });
assert.equal(injections.at(-1).world, 'ISOLATED');
assert.equal(injections.at(-1).args[1], 1234);
// 结果文件可按页读取：第 1 页 = 全量 JSON 前 2000 字符
const runJson = JSON.stringify({ page: 2, values: ['a', 'b'], count: 1 });
const runRead = await call({ action: 'read', path: run.data.resultFile.path });
assert.equal(runRead.success, true, text(runRead));
assert.equal(runRead.data.index, 1, 'index 缺省为 1');
assert.equal(runRead.data.content, runJson);
assert.equal(runRead.data.pageCount, 1);
assert.equal(runRead.data.hasMore, false);
const repeated = await call({ action: 'run', path: 'scripts/collect.js', args: [{ page: 3 }, []], tabId: 12, frameId: 3, world: 'ISOLATED', strategy: 'scripting' });
assert.equal(JSON.parse(repeated.data.result).count, 2, 'Same page world persists while parameters change');
assert.equal((await call({ action: 'run', path: 'scripts/collect.js', args: [{ page: 3 }, []] }, { chatId: 'js-b' })).success, false, 'Cross-chat scripts are unavailable');
await create('scripts/large.js', 'return "x".repeat($args[0]);');
const large = await call({ action: 'run', path: 'scripts/large.js', args: [3000] });
assert.equal(large.success, true, text(large));
assert.equal(large.data.result.length, 2000);
assert.equal(large.data.resultTruncated, true);
assert.equal(large.data.totalChars, 3002);
assert.ok(large.data.resultFile, '超限结果也落盘为结果文件');
assert.match(text(large), /index=2/, '超 2000 字符的结果提示从 index=2 续读');
assert.equal(large.data.result.length + (await call({ action: 'read', path: large.data.resultFile.path, index: 2 })).data.content.length, 3002, 'read 续读覆盖剩余字符');
const small = await call({ action: 'run', path: 'scripts/large.js', args: [2] });
assert.equal(small.data.result, '"xx"', '不足 2000 字符的结果全量返回');
assert.ok(small.data.resultFile, '小结果同样落盘（无论大小）');
const badBefore = injections.length;
for (const args of [[NaN], [undefined], [1n], new Array(2)])
    assert.equal((await call({ action: 'run', path: 'scripts/large.js', args })).success, false);
assert.equal(injections.length, badBefore, 'Invalid dynamic parameters never execute');
const originalEvaluate = api.cdpSession.evaluate;
api.cdpSession.evaluate = async () => { cdpCalls++; return { ok: true, value: { via: 'cdp' }, type: 'object' }; };
try {
    failProbe = true;
    const fallback = await call({ action: 'run', path: 'scripts/large.js', args: [2] });
    assert.equal(fallback.success, true, text(fallback));
    assert.equal(cdpCalls, 1);
    failProbe = false;
    pageFailure = true;
    assert.equal((await call({ action: 'run', path: 'scripts/large.js', args: [2] })).success, false);
    assert.equal(cdpCalls, 1, 'A user-script failure is never replayed in another engine');
    pageFailure = false;
    assert.equal((await call({ action: 'run', path: 'scripts/large.js', strategy: 'cdp' })).success, true);
    assert.equal(cdpCalls, 2);
}
finally {
    api.cdpSession.evaluate = originalEvaluate;
    failProbe = false;
    pageFailure = false;
}
await create('config/deep.yaml', 'root:\r\n\tsection:\r\n\t\tvalue: old\r\n\t\tother: stay\r\n');
let read = await call({ action: 'read', path: 'config/deep.yaml' });
const edited = await call({ action: 'edit', path: 'config/deep.yaml', expectedHash: read.data.sha256, find: 'section:\n\tvalue: old', replace: 'section:\n\tvalue: $&\n\tnew: yes', matchMode: 'indentation' });
assert.equal(edited.success, true, text(edited));
read = await call({ action: 'read', path: 'config/deep.yaml' });
assert.equal(read.data.content, 'root:\r\n\tsection:\r\n\t\tvalue: $&\r\n\t\tnew: yes\r\n\t\tother: stay\r\n');
const before = read.data.content;
assert.equal((await call({ action: 'edit', path: 'config/deep.yaml', edits: [{ find: 'value: $&', replace: 'value: changed' }, { find: 'missing', replace: 'bad' }] })).success, false);
assert.equal((await call({ action: 'read', path: 'config/deep.yaml' })).data.content, before, 'Batch edits roll back as one operation');
assert.equal((await call({ action: 'edit', path: 'config/deep.yaml', content: 'bad', expectedHash: '0'.repeat(64) })).success, false);
const shared = await py.execute({ action: 'edit', path: 'config/deep.yaml', edits: [{ find: 'value: $&', replace: 'value: python' }, { find: 'other: stay', replace: 'other: shared' }] }, context);
assert.equal(shared.success, true, text(shared));
assert.match((await call({ action: 'read', path: 'config/deep.yaml' })).data.content, /value: python/);
await create('dup.md', 'same same');
assert.equal((await call({ action: 'edit', path: 'dup.md', find: 'same', replace: 'x' })).success, false);
assert.equal((await call({ action: 'edit', path: 'dup.md', find: 'same', replace: '$1', replaceAll: true })).data.replaced, 2);
await create('outputs/test.txt', 'download');
assert.match((await call({ action: 'read', path: 'outputs/test.txt' })).data.content, /download/);
const listing = await call({ action: 'list', path: 'config' });
assert.equal(listing.data.entries[0].path, 'config/deep.yaml');
assert.equal((await call({ action: 'delete', path: 'config' })).success, false);
assert.equal((await call({ action: 'delete', path: 'dup.md' })).success, true);
assert.equal((await call({ action: 'read', path: 'dup.md' })).success, false);
// ── 分页引擎：页码定界 / 代理对边界 / 越界显式报错 ──
await create('pages.txt', 'a'.repeat(2000) + 'b'.repeat(2000) + 'tail');
const p1 = await call({ action: 'read', path: 'pages.txt' });
assert.equal(p1.data.pageCount, 3, '4003 字符按 2000/页分为 3 页');
assert.equal(p1.data.content, 'a'.repeat(2000));
assert.equal(p1.data.nextIndex, 2);
const p2 = await call({ action: 'read', path: 'pages.txt', index: 2 });
assert.equal(p2.data.content, 'b'.repeat(2000));
assert.equal(p2.data.hasMore, true);
const p3 = await call({ action: 'read', path: 'pages.txt', index: 3 });
assert.equal(p3.data.content, 'tail');
assert.equal(p3.data.hasMore, false);
assert.equal(p3.data.nextIndex, undefined);
const p4 = await call({ action: 'read', path: 'pages.txt', index: 4 });
assert.equal(p4.success, false, 'index 超出总页数显式报错');
assert.match(text(p4), /3 页/);
await create('boundary.txt', 'x'.repeat(1999) + '😀' + 'yyy');
const b1 = await call({ action: 'read', path: 'boundary.txt' });
assert.equal(b1.data.content, 'x'.repeat(1999), '页边界收缩一位避免拆开代理对');
assert.equal(b1.data.pageCount, 2);
const b2 = await call({ action: 'read', path: 'boundary.txt', index: 2 });
assert.equal(b2.data.content, '😀yyy', '续页包含完整代理对');
await create('unicode.txt', '😀汉字');
const unicode = await call({ action: 'read', path: 'unicode.txt', index: 1 });
assert.equal(unicode.data.content, '😀汉字');
assert.equal(unicode.data.pageCount, 1);
await create('empty.txt', '');
const emptyRead = await call({ action: 'read', path: 'empty.txt' });
assert.equal(emptyRead.success, true, '空文件读取不报错');
assert.equal(emptyRead.data.pageCount, 0);
assert.equal(emptyRead.data.content, '');
// ── results/ 目录治理：手工 create/edit 拒绝、read/list/delete 放行 ──
assert.equal((await call({ action: 'create', path: 'results/forged.json', content: '[]' })).success, false);
assert.match(text(await call({ action: 'create', path: 'results/forged.json', content: '[]' })), /results/);
assert.equal((await call({ action: 'edit', path: run.data.resultFile.path, find: 'page', replace: 'forged' })).success, false);
const resultsList = await call({ action: 'list', path: 'results' });
assert.ok(resultsList.data.entries.length >= 3, '结果文件进入 list 盘点');
assert.ok(resultsList.data.entries.every(entry => entry.path.startsWith('results/')));
assert.equal((await call({ action: 'delete', path: small.data.resultFile.path })).success, true, '结果文件可删除清理');
assert.equal((await call({ action: 'read', path: small.data.resultFile.path })).success, false, '删除后读取失败');
await create('indent.txt', '    alpha\r\n      beta\r\nnext\r\n');
const indent = await call({ action: 'edit', path: 'indent.txt', find: 'alpha\n  beta\n', replace: 'alpha\n  gamma\n', matchMode: 'indentation' });
assert.equal(indent.success, true, text(indent));
assert.equal((await call({ action: 'read', path: 'indent.txt' })).data.content, '    alpha\r\n      gamma\r\nnext\r\n');
await create('bom.txt', '﻿keep value');
assert.equal((await call({ action: 'edit', path: 'bom.txt', find: 'value', replace: 'changed' })).success, true);
assert.equal((await call({ action: 'read', path: 'bom.txt' })).data.content, '﻿keep changed');
const stale = await call({ action: 'read', path: 'scripts/large.js' });
assert.equal((await call({ action: 'run', path: 'scripts/large.js', expectedHash: '0'.repeat(64) })).success, false);
assert.equal((await call({ action: 'run', path: 'scripts/large.js', expectedHash: stale.data.sha256, args: [1], awaitPromise: false })).success, true);
assert.equal(injections.at(-1).args[2], false, 'Promise waiting mode is forwarded unchanged');
await create('scripts/slow.js', 'window.starts=(window.starts||0)+1; await new Promise(resolve=>setTimeout(resolve,$args[0])); window.done=true; return 1;');
const timed = await call({ action: 'run', path: 'scripts/slow.js', args: [1100], timeout: 1000, tabId: 21 });
assert.equal(timed.success, false);
assert.match(text(timed), /超时/);
await new Promise(resolve => setTimeout(resolve, 150));
assert.equal(world(21, 'MAIN').starts, 1);
assert.equal(world(21, 'MAIN').done, true, 'Timeout never claims to have stopped page work or replays it');
const originalTerminate = api.cdpSession.terminateExecution;
const savedEvaluate = api.cdpSession.evaluate;
let releaseCancelled, enteredCancelled, terminated = 0;
const entered = new Promise(resolve => { enteredCancelled = resolve; });
api.cdpSession.evaluate = async () => { enteredCancelled(); return new Promise(resolve => { releaseCancelled = resolve; }); };
api.cdpSession.terminateExecution = async () => { terminated++; releaseCancelled({ ok: false, error: 'Execution terminated' }); };
try {
    const controller = new AbortController();
    const pending = call({ action: 'run', path: 'scripts/large.js', args: [2], strategy: 'cdp' }, { ...context, signal: controller.signal });
    await entered;
    controller.abort();
    assert.equal((await pending).success, false);
    assert.equal(terminated, 1, 'Cancellation reaches the executing CDP engine');
}
finally {
    api.cdpSession.evaluate = savedEvaluate;
    api.cdpSession.terminateExecution = originalTerminate;
}
assert.equal((await call({ action: 'run', path: 'scripts/large.js' }, { ...context, toolPolicy: 'vision-assistant' })).success, false);
assert.ok(!js.getSchema({ toolPolicy: 'vision-assistant' }).function.parameters.properties.action.enum.includes('run'));
assert.equal(api.needsVisionRefresh([{ function: { name: 'js_run', arguments: JSON.stringify({ action: 'edit' }) } }], [], () => false), false);
assert.equal(api.needsVisionRefresh([{ function: { name: 'js_run', arguments: JSON.stringify({ action: 'run' }) } }], [], () => false), true);
assert.ok(api.CORE_SESSION_TOOL_IDS.includes('js_run'));
assert.ok(Object.values(api.SCENARIO_PRESETS).every(ids => !ids.includes('browser_page_exec') && !ids.includes('js_run')));
assert.deepEqual(api.getPresetToolIds('all', () => ['js_run', 'browser_page_exec', 'plan_tool']), ['plan_tool']);
assert.deepEqual(api.normalizeToolIds(['js_run', 'browser_page_exec', 'browser_observe']), ['browser_observe']);
assert.deepEqual(api.normalizeAllowedToolList(['js_run', 'js_run']), ['js_run']);
assert.deepEqual(api.openaiToolsConverter.getToolsByIds(['browser_page_exec']), []);
assert.ok(!api.openaiToolsConverter.getAvailableToolIds().includes('browser_page_exec'));
assert.ok(!api.openaiToolsConverter.getAllTools().some(tool => tool.function.name === 'browser_page_exec'));
assert.equal(api.openaiToolsConverter.requiresApproval('js_run', { action: 'run', confirm: true }), true);
assert.equal(api.openaiToolsConverter.requiresApproval('js_run', { action: 'edit', path: 'script.js', content: 'sensitive words' }), false);
api.modelRegistry.require = () => ({ contextThreshold: 32000 });
const runtime = await api.runtimeBuilder.build({ chatId: 'js-a', userInput: 'test', agentName: null, skillNames: [], priorRecords: [], extraToolIds: ['browser_page_exec'], agentSystemOverride: 'Use js_run' });
assert.equal(runtime.toolIds.filter(id => id === 'js_run').length, 1);
assert.ok(!runtime.toolIds.includes('browser_page_exec'));
assert.equal(runtime.systemPrompt.split('<workspace-scripting>').length - 1, 1);
assert.doesNotMatch(runtime.systemPrompt, /browser_page_exec/);
const observer = await api.runtimeBuilder.build({ chatId: 'js-a', userInput: 'test', agentName: '视觉助手', skillNames: [], priorRecords: [] });
assert.ok(observer.toolIds.includes('js_run'));
// Exercise the real extension message router: session IDs are context, never model parameters.
api.initToolsManagerListener();
chrome.runtime.sendMessage = async (message) => {
    if (message.type !== 'js_run')
        return;
    assert.equal(message.__scriptContext.chatId, 'js-a');
    const previous = globalThis.document;
    delete globalThis.document;
    try {
        return await new Promise(resolve => { for (const listener of listeners)
            listener(message, { id: 'test', url: 'chrome-extension://test/sidepanel.html' }, resolve); });
    }
    finally {
        globalThis.document = previous;
    }
};
globalThis.document = {};
const forwarded = await api.executeTool('js_run', { action: 'run', path: 'scripts/large.js', args: [2] }, context);
delete globalThis.document;
assert.equal(forwarded.success, true, text(forwarded));
assert.ok(forwarded.data.resultFile, '后台转发路径同样落盘结果文件');
await api.chatDatabase.deleteSession('js-a');
assert.equal((await call({ action: 'run', path: 'scripts/large.js' })).success, false);
console.log('[js-run] File-backed execution, CSP/frame/args parity, paginated read, persistent result files, shared atomic editor, context routing, visibility and policy boundaries passed.');
