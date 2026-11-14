import assert from 'node:assert/strict';
import { withNamedLock } from '@/utils/shared/async-lock';
import { withTimeBudget, abortable } from '@/utils/shared/abort';
import { errorDetails, toolErrorDetails, WorkspaceOperationError } from '@/utils/shared/error-details';
import { applyTextEdit, parseTextEdits } from '@/utils/python-workspace/text-edit';
import { isWorkspaceRelativePath, checkWorkspaceLimits } from '@/utils/python-workspace/paths';
import { validateSkillBinaries, validateSkillFolders } from '@/utils/skills/skill-resources';
import { updateSkillFrontmatter, parseFrontmatter } from '@/utils/skills/frontmatter-parser';
import { isPythonHostResult } from '@/utils/pyodide/python-host-protocol';
import { waitForTabReady } from '@/tools/browser/page-load';

assert.throws(() => applyTextEdit('aaa', { find: 'aa', replace: 'b' }), /命中多次/);
assert.throws(() => applyTextEdit('a\na\na', { find: 'a\na', replace: 'b', matchMode: 'indentation' }), /命中多次/);
assert.throws(() => applyTextEdit('  end', { find: 'end\n', replace: 'done\n', matchMode: 'indentation' }), /未命中/);
assert.equal(applyTextEdit('\tif (x) {\r\n\t  old();\r\n\t}\r\n', { find: 'if (x) {\n  old();\n}\n', replace: 'if (x) {\n  newer();\n}\n', matchMode: 'indentation' }).text, '\tif (x) {\r\n\t  newer();\r\n\t}\r\n');
assert.throws(() => parseTextEdits([{ find: 'a', replace: '\ud800' }]), /Unicode/);
assert.equal(isWorkspaceRelativePath('中'.repeat(86) + '.txt'), false);
assert.equal(isWorkspaceRelativePath('中'.repeat(80) + '.txt'), true);
assert.throws(() => checkWorkspaceLimits(1, Number.NaN), /Invalid/);
assert.throws(() => validateSkillBinaries({ 'resources/a': 'AA=A' }, {}), /encoding/);
assert.throws(() => validateSkillBinaries(undefined, { a: '', 'a/b': '' }), /conflict/);
assert.throws(() => validateSkillFolders(['a/b'], { a: '' }), /parent/);
const body = '\r\n  unchanged\r\n';
const document = updateSkillFrontmatter('---\r\nname: fixture\r\ndescription: old\r\nx-marker: keep\r\n---\r\n' + body, { description: 'new "quoted" value' });
assert.ok(document.endsWith(body));
assert.ok(document.includes('x-marker: keep'));
assert.equal(parseFrontmatter(document).data.description, 'new "quoted" value');
assert.equal(toolErrorDetails(new WorkspaceOperationError('CONFLICT', 'user text PY_INVALID_PATH'), 'JS'), '[JS_CONFLICT] user text PY_INVALID_PATH');
const cyclic: { cause?: unknown } = {}; cyclic.cause = cyclic;
assert.ok(errorDetails(cyclic).length < 4001);
assert.equal(isPythonHostResult({ error: 'bad', outcome: {} }), false);

let invoked = false;
await assert.rejects(withTimeBudget(0, async () => { invoked = true; }), { name: 'TimeoutError' });
assert.equal(invoked, false);
const late = new AbortController();
let rejectLate!: (reason: Error) => void;
const waiting = abortable(new Promise<void>((_resolve, reject) => { rejectLate = reject; }), late.signal);
late.abort();
await assert.rejects(waiting, { name: 'AbortError' });
rejectLate(new Error('late rejection must be observed'));

let release!: () => void, queuedInvoked = false;
const first = withNamedLock('workspace-defenses', () => new Promise<void>(resolve => { release = resolve; }));
while (!release) await Promise.resolve();
const controller = new AbortController();
const second = withNamedLock('workspace-defenses', async () => { queuedInvoked = true; }, controller.signal);
controller.abort();
await assert.rejects(second, { name: 'AbortError' });
release(); await first;
await withNamedLock('workspace-defenses', async () => assert.equal(queuedInvoked, false));
const getTab = chrome.tabs.get;
try {
  chrome.tabs.get = (() => new Promise(() => {})) as typeof getTab;
  const ready = await waitForTabReady(1, { timeoutMs: 20 });
  assert.equal(ready.ready, false, '浏览器 API 挂起也必须受等待预算限制');
} finally { chrome.tabs.get = getTab; }
console.log('[workspace-defenses] Editor ambiguity, CRLF/tabs, manifests, bounded errors and cancellation passed.');
