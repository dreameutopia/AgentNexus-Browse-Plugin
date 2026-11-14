import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';
import { loadPyodide } from 'pyodide';

const outfile = path.resolve('node_modules/.cache/python-workspace-test.mjs');
await build({
  stdin: {
    contents: `
      export { chatDatabase } from './entrypoints/sidepanel/core/context/chat-database';
      export { withPythonWorkspace } from './utils/python-workspace/python-filesystem';
      export { importWorkspaceFiles, readWorkspaceOutput, saveWorkspace, saveWorkspaceOutput } from './utils/python-workspace/store';
      export { markdownRenderer } from './entrypoints/sidepanel/utils/chat/markdown-renderer';
      export { pythonWorkerGlobals } from './utils/pyodide/python-worker-globals';
      export { encodeWorkspaceBackups, decodeWorkspaceBackups } from './entrypoints/sidepanel/utils/backup/workspace-backup';
      export { fileManager } from './utils/file-manager';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  loader: { '.css': 'empty' },
});
const dom = new JSDOM('<!doctype html><main></main>');
globalThis.document = dom.window.document;
globalThis.window = dom.window;
const { chatDatabase, withPythonWorkspace, importWorkspaceFiles, readWorkspaceOutput, saveWorkspace, saveWorkspaceOutput,
  markdownRenderer, pythonWorkerGlobals, encodeWorkspaceBackups, decodeWorkspaceBackups, fileManager } =
  await import(pathToFileURL(outfile).href);
const py = await loadPyodide({ jsglobals: pythonWorkerGlobals() });

try {
  await py.runPythonAsync(`
import asyncio, js
from js import Uint8Array
assert Uint8Array.new(3).length == 3
assert not hasattr(js, 'indexedDB')
assert not hasattr(js.globalThis, 'postMessage')
await asyncio.sleep(0.001)
`);
  for (const chatId of ['chat_a', 'chat_b']) {
    await chatDatabase.createSession({
      chatId, title: chatId, createdAt: 1, updatedAt: 1, messageCount: 0,
      lastMessagePreview: '', agentName: '', skillNames: [],
    });
  }
  const uploads = [
    { id: 'first', file: new File(['a,b\n1,2\n'], 'data.csv') },
    { id: 'second', file: new File([new Uint8Array([0, 255, 13])], 'data.csv') },
  ];
  const paths = await importWorkspaceFiles('chat_a', uploads);
  assert.deepEqual([...paths.values()], ['inputs/data.csv', 'inputs/data (2).csv']);
  assert.deepEqual(await importWorkspaceFiles('chat_a', uploads), paths, 'Retry reuses the assigned paths');

  await saveWorkspaceOutput('chat_a', 'outputs/tool.bin', new Blob([new Uint8Array([0, 255, 13])]));
  const cwd = py.FS.cwd();
  const run = (chatId, code) => withPythonWorkspace(py.FS, chatId, async () => {
    await py.runPythonAsync(code);
    return { ok: true };
  });
  const result = await run('chat_a', `
from pathlib import Path
import os
assert os.getcwd() == '/work-space/chat_a'
assert Path('inputs/data (2).csv').read_bytes() == bytes([0, 255, 13])
assert Path('outputs/tool.bin').read_bytes() == bytes([0, 255, 13])
Path('outputs/nested').mkdir()
Path('outputs/nested/报告 & data.csv').write_bytes(Path('inputs/data.csv').read_bytes())
`);
  const output = 'outputs/nested/报告 & data.csv';
  assert.deepEqual(result.workspaceOutputs, [output, 'outputs/tool.bin']);
  assert.equal(py.FS.cwd(), cwd, 'Caller working directory is restored');
  assert.equal((await readWorkspaceOutput('chat_a', output)).size, 8);
  await run('chat_a', `assert Path('outputs/nested/报告 & data.csv').read_bytes() == b'a,b\\n1,2\\n'`);
  await run('chat_b', `assert not Path('inputs/data.csv').exists()
assert not Path('/work-space/chat_a').exists()`);
  assert.equal(await readWorkspaceOutput('chat_b', output), null);
  assert.equal(await readWorkspaceOutput('chat_a', 'outputs/../inputs/data.csv'), null);

  await withPythonWorkspace(py.FS, 'chat_a', async () => {
    await py.runPythonAsync("Path('outputs/nested/报告 & data.csv').unlink()");
    return { ok: false };
  });
  assert.ok(await readWorkspaceOutput('chat_a', output), 'Failed runs discard file changes');
  await assert.rejects(run('chat_a', "Path('outputs/link').symlink_to('/home/pyodide')"), /leaves the workspace/);

  await run('chat_a', `
import csv, gzip, io, os, shutil, sqlite3, tempfile, zipfile
from contextlib import closing
from pathlib import Path
with open('inputs/data.csv', newline='') as source:
    rows = list(csv.reader(source))
assert rows == [['a', 'b'], ['1', '2']]
with tempfile.TemporaryDirectory() as temp:
    intermediate = Path(temp) / 'report.csv'
    intermediate.write_text('name,value\\na,10\\n', encoding='utf-8')
    shutil.copyfile(intermediate, 'outputs/.report.tmp')
    os.replace('outputs/.report.tmp', 'outputs/report.csv')
with gzip.open('outputs/report.csv.gz', 'wb') as output_file:
    output_file.write(Path('outputs/report.csv').read_bytes())
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.write('outputs/report.csv', 'report.csv')
Path('outputs/report.zip').write_bytes(buffer.getvalue())
with closing(sqlite3.connect('outputs/data.sqlite')) as db:
    db.execute('CREATE TABLE records (value INTEGER)')
    db.execute('INSERT INTO records VALUES (42)')
    db.commit()
Path('outputs/latest.csv').symlink_to('report.csv')
os.chmod('outputs/report.csv', 0o640)
os.utime('outputs/report.csv', (1234567890, 1234567890))
`);
  await run('chat_a', `
import stat
assert os.readlink('outputs/latest.csv') == 'report.csv'
assert Path('outputs/latest.csv').read_bytes() == gzip.decompress(Path('outputs/report.csv.gz').read_bytes())
assert stat.S_IMODE(os.stat('outputs/report.csv').st_mode) == 0o640
assert int(os.stat('outputs/report.csv').st_mtime) == 1234567890
with zipfile.ZipFile('outputs/report.zip') as archive:
    assert archive.read('report.csv') == Path('outputs/report.csv').read_bytes()
with closing(sqlite3.connect('outputs/data.sqlite')) as db:
    assert db.execute('SELECT value FROM records').fetchone() == (42,)
`);
  if (process.env.PYTHON_WORKSPACE_TEST_PACKAGES === '1') {
    try {
      await py.loadPackage(['numpy', 'pandas', 'pillow', 'micropip']);
      await py.runPythonAsync("import micropip; await micropip.install('openpyxl')");
    } catch (error) {
      throw new Error(`Optional package setup failed: ${String(error).slice(-1200)}`);
    }
    await run('chat_a', `
import numpy as np
import pandas as pd
from PIL import Image
with open('inputs/data.csv', 'rb') as source:
    frame = pd.read_csv(source)
frame.to_excel('outputs/table.xlsx', engine='openpyxl', index=False)
np.save('outputs/array.npy', frame.to_numpy())
with Image.new('RGB', (2, 3), 'red') as image:
    image.save('outputs/picture.png')
`);
    await run('chat_a', `
assert pd.read_excel('outputs/table.xlsx', engine='openpyxl').iloc[0].tolist() == [1, 2]
assert np.load('outputs/array.npy').tolist() == [[1, 2]]
with Image.open('outputs/picture.png') as image:
    assert image.size == (2, 3) and image.getpixel((0, 0)) == (255, 0, 0)
`);
  }
  assert.equal(await readWorkspaceOutput('chat_a', 'outputs/latest.csv'), null, 'Download only regular files');
  await assert.rejects(run('chat_a', "left_open = open('outputs/incomplete.txt', 'w'); left_open.write('buffered')"), /still open/);
  py.runPython('left_open.close()');
  assert.equal(await readWorkspaceOutput('chat_a', 'outputs/incomplete.txt'), null);
  const beforeRace = await chatDatabase.readWorkspace('chat_a');
  await importWorkspaceFiles('chat_a', [{ id: 'third', file: new File(['new'], 'new.txt') }]);
  await assert.rejects(saveWorkspace('chat_a', beforeRace.revision, beforeRace.entries), /changed during/);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(saveWorkspace('chat_a', undefined, [], cancelled.signal), { name: 'AbortError' });
  const beforeAbort = await chatDatabase.readWorkspace('chat_a');
  const abortDuringWrite = new AbortController();
  await assert.rejects(chatDatabase.updateWorkspace('chat_a', () => {
    abortDuringWrite.abort();
    return { snapshot: { revision: 'discarded', entries: [] }, result: undefined };
  }, abortDuringWrite.signal), { name: 'AbortError' });
  assert.equal((await chatDatabase.readWorkspace('chat_a')).revision, beforeAbort.revision);

  const host = dom.window.document.querySelector('main');
  const tag = '<workspace-file path="outputs/nested/报告 &amp; data.csv" />';
  host.innerHTML = markdownRenderer.renderMessage(tag, { workspaceChatId: 'chat_a' });
  const card = host.querySelector('.file-card');
  assert.equal(card.dataset.workspacePath, output);
  assert.equal(card.dataset.workspaceChat, 'chat_a');
  assert.equal(card.querySelector('.file-card-name').textContent, '报告 & data.csv');
  const clicked = new Promise(resolve => {
    dom.window.HTMLAnchorElement.prototype.click = function () {
      resolve({ href: this.href, name: this.download });
    };
  });
  card.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const download = await Promise.race([
    clicked,
    new Promise((_, reject) => dom.window.setTimeout(() => reject(new Error('Download did not start')), 1000)),
  ]);
  assert.equal(download.name, '报告 & data.csv');
  assert.equal(await (await fetch(download.href)).text(), 'a,b\n1,2\n');
  URL.revokeObjectURL(download.href);
  for (const literal of [
    '\x60' + tag + '\x60',
    '\x60\x60\x60xml\n' + tag + '\n\x60\x60\x60',
    '<workspace-file path="outputs/../inputs/data.csv" />',
    '<workspace-file path="outputs/file.csv" onclick="alert(1)" />',
    '<workspace-file path="https://example.test/file.csv" />',
  ]) {
    assert.doesNotMatch(markdownRenderer.renderMessage(literal, { workspaceChatId: 'chat_a' }), /data-workspace-path=/);
  }
  assert.doesNotMatch(markdownRenderer.renderMessage(tag), /data-workspace-path=/);
  assert.doesNotMatch(markdownRenderer.renderMessage('[file:Abc12345|Legacy.xlsx]'), /data-file-id=/);
  assert.doesNotMatch(markdownRenderer.renderMessage('[link](https://example.test "[file:Abc12345|legacy]")'), /data-file-id=/);
  assert.doesNotMatch(markdownRenderer.renderMessage('[link](https://example.test \'<workspace-file path="outputs/file.csv" />\')',
    { workspaceChatId: 'chat_a' }), /data-workspace-path=/);
  host.innerHTML = markdownRenderer.renderMessage('<workspace-file path=\'outputs/cost-$42$.csv\' />',
    { workspaceChatId: 'chat_a' });
  assert.equal(host.querySelector('.file-card').dataset.workspacePath, 'outputs/cost-$42$.csv');

  // Chrome storage uses JSON serialization. A naked ArrayBuffer previously became {}.
  let localStorageData = {};
  globalThis.chrome = {
    runtime: {},
    storage: { local: {
      get(_keys, callback) { callback(structuredClone(localStorageData)); },
      set(data, callback) { localStorageData = JSON.parse(JSON.stringify(data)); callback(); },
    } },
  };
  const legacyBytes = new Uint8Array([80, 75, 0, 255]);
  const legacyId = await fileManager.addFile('legacy.xlsx', legacyBytes.buffer, 'application/octet-stream');
  assert.deepEqual(new Uint8Array((await fileManager.getStoredFile(legacyId)).content), legacyBytes);

  const allowed = new Set(['chat_a']);
  const exported = JSON.parse(JSON.stringify(await encodeWorkspaceBackups(await chatDatabase.listWorkspaces(), allowed)));
  assert.equal(exported.length, 1);
  assert.throws(() => decodeWorkspaceBackups(exported, new Set(['chat_b']), false), /会话/);
  const tampered = structuredClone(exported);
  tampered[0].entries.find(entry => entry.data !== undefined).data = '!!??';
  assert.throws(() => decodeWorkspaceBackups(tampered, allowed, false), /文件/);
  const sessions = await chatDatabase.listAllSessions();
  const previous = await chatDatabase.restoreSessions(sessions, [], decodeWorkspaceBackups(exported, allowed, true));
  assert.equal(await (await readWorkspaceOutput('chat_a', output)).text(), 'a,b\n1,2\n');
  await chatDatabase.restoreSessions(sessions, [], previous);

  await chatDatabase.deleteSession('chat_a');
  await assert.rejects(importWorkspaceFiles('chat_a', uploads), /no longer exists/);
  await chatDatabase.createSession({
    chatId: 'chat_a', title: 'New session', createdAt: 2, updatedAt: 2, messageCount: 0,
    lastMessagePreview: '', agentName: '', skillNames: [],
  });
  assert.equal(await readWorkspaceOutput('chat_a', output), null, 'Deleting the chat removes its files');
  console.log('[python-workspace] Pyodide relative paths, binary imports, persistence, rollback and Markdown downloads passed.');
} finally {
  dom.window.close();
}
