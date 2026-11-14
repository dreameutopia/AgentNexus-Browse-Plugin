import assert from 'node:assert/strict';
import { build } from 'esbuild';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';

const outfile = path.resolve('node_modules/.cache/workspace-artifacts-test.mjs');
await build({
  stdin: {
    contents: `
      export { chatDatabase } from './entrypoints/sidepanel/core/context/chat-database';
      export { saveWorkspaceOutput, readWorkspaceOutput } from './utils/python-workspace/store';
      export { workspaceArtifact } from './utils/python-workspace/artifact-contract';
      export { fetchArtifactBlob } from './utils/python-workspace/artifact-fetch';
      export { XlsxTool } from './tools/office/xlsx-tool';
      export { dataRefStore } from './utils/data-ref-store';
      export { MermaidRendererTool } from './tools/code/mermaid-renderer';
      export { BrowserResourcesTool } from './tools/browser/resources';
      export { downloadDB } from './utils/download-database';
      export { markdownRenderer } from './entrypoints/sidepanel/utils/chat/markdown-renderer';
      export { encodeWorkspaceBackups, decodeWorkspaceBackups } from './entrypoints/sidepanel/utils/backup/workspace-backup';
      export { installFileCardHandler } from './entrypoints/sidepanel/utils/chat/file-card';
      export { projectToolPayload } from './common/tool-handler';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true, platform: 'node', format: 'esm', outfile,
  external: ['exceljs/dist/exceljs.min.js'], loader: { '.css': 'empty' },
});
let browserDownloads = 0;
globalThis.chrome = {
  runtime: {
    getURL: value => 'chrome-extension://test/' + value,
    sendMessage(_message, callback) {
      callback({ ok: true, dataUrl: 'data:image/png;base64,AQD/', width: 1, height: 1, durationMs: 1 });
    },
  },
  offscreen: { createDocument: async () => {}, hasDocument: async () => true },
  downloads: { download: async () => ++browserDownloads },
};
const api = await import(pathToFileURL(outfile).href);
const { chatDatabase, saveWorkspaceOutput, readWorkspaceOutput, workspaceArtifact } = api;
const makeChat = chatId => chatDatabase.createSession({
  chatId, title: chatId, createdAt: 1, updatedAt: 1, messageCount: 0,
  lastMessagePreview: '', agentName: '', skillNames: [],
});
await makeChat('a');
await makeChat('b');
const bytes = new Blob([new Uint8Array([0, 255, 13])], { type: 'application/octet-stream' });
const file = await saveWorkspaceOutput('a', 'outputs/nested/报告 & "test".bin', bytes);
assert.match(file.marker, /&amp; &quot;test&quot;/);
assert.equal(file.sizeBytes, 3);
assert.deepEqual(new Uint8Array(await (await readWorkspaceOutput('a', file.path)).arrayBuffer()), new Uint8Array([0, 255, 13]));
assert.equal(await readWorkspaceOutput('b', file.path), null);
const repeated = await Promise.all([1, 2, 3].map(() => saveWorkspaceOutput('a', 'outputs/report.csv', bytes)));
assert.deepEqual(repeated.map(item => item.path), ['outputs/report.csv', 'outputs/report (2).csv', 'outputs/report (3).csv']);
for (const path of ['inputs/no.csv', 'outputs/../no.csv', '/outputs/no.csv', 'outputs/C:/../no.csv']) {
  await assert.rejects(saveWorkspaceOutput('a', path, bytes));
  assert.throws(() => workspaceArtifact(path));
}
await assert.rejects(saveWorkspaceOutput('', 'outputs/no.csv', bytes), /WORKSPACE_CONTEXT_REQUIRED/);
await saveWorkspaceOutput('a', 'outputs/parent', bytes);
await assert.rejects(saveWorkspaceOutput('a', 'outputs/parent/no.csv', bytes), /not a directory/);
await chatDatabase.updateWorkspace('a', current => ({
  snapshot: { revision: crypto.randomUUID(), entries: [...current.entries, { path: 'outputs/link', blob: null, link: '../inputs' }] }, result: undefined,
}));
await assert.rejects(saveWorkspaceOutput('a', 'outputs/link/no.csv', bytes), /not a directory/);
const cancelled = AbortSignal.abort();
await assert.rejects(saveWorkspaceOutput('a', 'outputs/cancel.csv', bytes, cancelled));
assert.equal(await readWorkspaceOutput('a', 'outputs/cancel.csv'), null);

// Excel and Mermaid need no Python installation, and return the same artifact wire contract.
const xlsx = new api.XlsxTool();
const request = { action: 'create', filename: 'sales', sheet: { name: 'Data', rows: [['name', 'count'], ['a', 2]] } };
assert.equal((await xlsx.execute(request)).success, false, 'A producer cannot fall back to a global file library');
const excel = await xlsx.execute(request, { chatId: 'a' });
assert.equal(excel.success, true, JSON.stringify(excel));
assert.equal(excel.data.file.path, 'outputs/sales.xlsx');
assert.deepEqual(excel.data.files, [excel.data.file]);
assert.equal(await readWorkspaceOutput('b', excel.data.file.path), null);
assert.ok((await readWorkspaceOutput('a', excel.data.file.path)).size > 0);
const batch = await api.dataRefStore.save([{ name: 'a', count: 2 }]);
assert.equal(batch.ok, true);
const batchExcel = await xlsx.execute({ action: 'create_from_data', filename: 'batch', sheet: { name: 'Data', dataRef: batch.meta.id } }, { chatId: 'a' });
assert.equal(batchExcel.success, true, JSON.stringify(batchExcel));
assert.equal(batchExcel.data.file.path, 'outputs/batch.xlsx');
const markdownExcel = await xlsx.execute({ action: 'create_from_markdown', filename: 'markdown', markdown: '|name|count|\n|---|---|\n|a|2|' }, { chatId: 'a' });
assert.equal(markdownExcel.success, true, JSON.stringify(markdownExcel));
const originalDownload = chrome.downloads.download;
chrome.downloads.download = async () => { throw Error('Downloads blocked'); };
try {
  const savedWithWarning = await xlsx.execute({ ...request, autoDownload: true }, { chatId: 'a' });
  assert.equal(savedWithWarning.success, true);
  assert.equal(savedWithWarning.data.file.path, 'outputs/sales (2).xlsx');
  assert.equal(savedWithWarning.data.autoDownloaded, false);
  assert.match(savedWithWarning.data.warnings.join(' '), /Downloads blocked/);
  assert.ok(await readWorkspaceOutput('a', savedWithWarning.data.file.path));
} finally {
  chrome.downloads.download = originalDownload;
}
const diagram = await new api.MermaidRendererTool().execute({ mermaidCode: 'graph LR; A-->B' }, { chatId: 'a' });
assert.equal(diagram.success, true, JSON.stringify(diagram));
assert.equal(diagram.data.file.path, 'outputs/mermaid-diagram.png');
assert.match(api.projectToolPayload(diagram).value.text, /Mermaid/);
assert.equal(browserDownloads, 0, 'Generating an artifact does not download it onto the computer');

const originalFetch = globalThis.fetch;
const resources = new api.BrowserResourcesTool();
try {
  globalThis.fetch = async () => new Response(new Uint8Array([0, 255, 13]), { headers: { 'content-type': 'application/pdf' } });
  const fetched = await resources.execute({ action: 'fetch', url: 'https://example.test/data.pdf' }, { chatId: 'a' });
  assert.equal(fetched.success, true, JSON.stringify(fetched));
  assert.equal(fetched.data.file.path, 'outputs/data.pdf');
  assert.equal((await readWorkspaceOutput('a', fetched.data.file.path)).type, 'application/pdf');
  assert.equal((await resources.execute({ action: 'fetch', url: 'https://example.test/data.pdf' })).success, false);
  globalThis.fetch = async () => new Response('', { status: 403 });
  const denied = await resources.execute({ action: 'fetch', url: 'https://example.test/denied.pdf' }, { chatId: 'a' });
  assert.equal(denied.success, false);
  assert.equal(await readWorkspaceOutput('a', 'outputs/denied.pdf'), null);
  globalThis.fetch = async () => new Response('', { headers: { 'content-length': String(129 * 1024 * 1024) } });
  await assert.rejects(api.fetchArtifactBlob('https://example.test/huge'), /size limit/);
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(129 * 1024 * 1024)); controller.close(); } }));
  await assert.rejects(api.fetchArtifactBlob('https://example.test/unbounded'), /size limit/);
} finally {
  globalThis.fetch = originalFetch;
}
await api.downloadDB.addFile({ id: 'capture', filename: 'source.pdf', sourcePageUrl: 'https://example.test', mimeType: bytes.type, capturedAt: 1, blobData: bytes });
const exported = await resources.execute({ action: 'export', fileId: 'capture' }, { chatId: 'a' });
assert.equal(exported.success, true, JSON.stringify(exported));
assert.equal(exported.data.file.path, 'outputs/source.pdf');
assert.equal(await readWorkspaceOutput('b', exported.data.file.path), null);
assert.equal(browserDownloads, 0);

const dom = new JSDOM('<main></main>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
api.installFileCardHandler();
try {
  const host = document.querySelector('main');
  for (const enableMarkdown of [true, false]) {
    host.innerHTML = api.markdownRenderer.renderMessage(file.marker, { workspaceChatId: 'a', enableMarkdown });
    const card = host.querySelector('.file-card');
    assert.equal(card.dataset.workspacePath, file.path);
    assert.equal(card.dataset.workspaceChat, 'a');
    assert.equal(card.querySelector('.file-card-name').textContent, file.name);
  }
  host.innerHTML = api.markdownRenderer.renderMessage(excel.data.file.marker, { workspaceChatId: 'a' });
  const downloaded = new Promise(resolve => { dom.window.HTMLAnchorElement.prototype.click = function () { resolve({ name: this.download, href: this.href }); }; });
  host.querySelector('.file-card').click();
  const clicked = await Promise.race([downloaded, new Promise((_, reject) => dom.window.setTimeout(() => reject(Error('No card download')), 1000))]);
  assert.equal(clicked.name, 'sales.xlsx');
  assert.ok((await (await fetch(clicked.href)).blob()).size > 0);
  URL.revokeObjectURL(clicked.href);
  assert.doesNotMatch(api.markdownRenderer.renderMessage('[file:Abc12345|Legacy.xlsx]'), /data-file-id=/);
  assert.doesNotMatch(api.markdownRenderer.renderMessage(file.marker), /data-workspace-path=/);
  const backup = await api.encodeWorkspaceBackups(await chatDatabase.listWorkspaces(), new Set(['a']));
  assert.equal(api.decodeWorkspaceBackups(JSON.parse(JSON.stringify(backup)), new Set(['a']), true).length, 1);
  await chatDatabase.deleteSession('a');
  await assert.rejects(saveWorkspaceOutput('a', 'outputs/resurrect.csv', bytes), /no longer exists/);
  assert.equal(await readWorkspaceOutput('a', excel.data.file.path), null);
  console.log('[workspace-artifacts] Runtime-independent Excel, diagrams, resources, isolation, collisions, cancellation, quotas, backups, and card downloads passed.');
} finally {
  dom.window.close();
}
