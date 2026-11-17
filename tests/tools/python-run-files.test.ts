/**
 * python_run（run-only）与 file_util 文件引擎契约
 *
 * 覆盖五层防线：
 *   1. python_run 参数门：仅 run、跨 action 串参、未知键、pypi 审批顺序；
 *   2. 路径与内容边界（parseWorkspaceFilePath 穿越矩阵 + content 有界校验）；
 *   3. file_util 端到端（fake-indexeddb + 真实 chatDatabase/store 事务）：
 *      create 父目录与幂等拒绝、edit 两种模式与唯一/全量命中、$ 字面量安全、
 *      换行错配与未命中诊断、非 UTF-8 / 超大文件拒绝就地编辑、delete 目录拒绝、
 *      会话不存在映射、read/list 分页与缺失目录指引；
 *   4. run 存在性预检与依赖契约前置判定；
 *   5. 模块级 API 直测（workspace-files 复用面）。
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { extractContentText, projectToolPayload } from '@/common/tool-handler';
import { chatDatabase } from '@/entrypoints/sidepanel/core/context/chat-database';
import { PythonRunTool } from '@/tools/python/python-run-tool';
import { FileUtilTool } from '@/tools/file-util/file-util-tool';
import {
  createWorkspaceFile, deleteWorkspaceFile, editWorkspaceFile,
  parseWorkspaceFilePath, validateWorkspaceFileContent,
} from '@/utils/python-workspace/workspace-files';

const tool = new PythonRunTool();
const files = new FileUtilTool();
const text = (result: { content?: unknown }) => extractContentText(result.content);
const CHAT = 'python-run-files-chat';

// ──── 1. Schema 契约：python_run 只剩 run ────
const parameters = tool.openaiSchema.function.parameters as {
  properties: Record<string, { enum?: string[] } & Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
  anyOf?: unknown[];
};
assert.deepEqual(parameters.properties.action.enum, ['run'], 'python_run 只保留 run');
assert.deepEqual(parameters.required, ['action']);
assert.equal(parameters.additionalProperties, false);
assert.equal(parameters.anyOf?.length, 1, '只有 run 一个 action-specific required 分支');
assert.ok(parameters.properties.path, 'run 仍需要 path');
assert.equal(parameters.properties.content, undefined, 'content 已移出 python_run');
assert.equal(parameters.properties.index, undefined, 'index 已移出 python_run');
assert.equal(parameters.properties.offset, undefined, 'offset 已移出 python_run');

// file_util 完整接管
const fileParams = files.openaiSchema.function.parameters as {
  properties: Record<string, { enum?: string[] }>;
  anyOf?: unknown[];
};
assert.deepEqual(
  fileParams.properties.action.enum,
  ['read', 'create', 'append', 'edit', 'delete', 'copy', 'list', 'search', 'grep'],
  'file_util 覆盖全部文件能力',
);
assert.equal(fileParams.anyOf?.length, 9);

// ──── 2. python_run 参数门（先于存储） ────
const gate: Array<[unknown, RegExp, string]> = [
  [null, /PY_INVALID_ARGUMENTS/, '非对象参数'],
  [{ action: 'destroy', path: 'a.py' }, /PY_INVALID_ARGUMENTS/, '非法 action'],
  [{ action: 'create', path: 'a.txt', content: 'x' }, /PY_INVALID_ARGUMENTS/, '文件创建已下线'],
  [{ action: 'read', path: 'a.txt' }, /PY_INVALID_ARGUMENTS/, '文件读取已下线'],
  [{ action: 'list' }, /PY_INVALID_ARGUMENTS/, '目录盘点已下线'],
  [{ action: 'run', path: 'a.py' }, /PY_CONTEXT/, '无会话上下文'],
  [{ action: 'run' }, /PY_INVALID_SCRIPT/, 'run 缺 path'],
  [{ action: 'run', path: 'a.py', content: 'x' }, /PY_INVALID_ARGUMENTS/, 'run 夹带 content'],
  [{ action: 'run', path: 'a.py', replaceAll: true }, /PY_INVALID_ARGUMENTS/, 'run 夹带 replaceAll'],
  [{ action: 'run', path: 'a.py', offset: 0 }, /PY_INVALID_ARGUMENTS/, 'run 夹带分页参数'],
  [{ action: 'run', path: 'a.py', timeoutSeconds: '60' }, /PY_INVALID_ARGUMENTS/, 'timeoutSeconds 非数字'],
  [{ action: 'run', path: 'a.py', typo_key: 1 }, /未知参数.*typo_key/, '未知键严格拒绝'],
  [{ action: 'run', path: 'notes.txt' }, /PY_INVALID_SCRIPT/, 'run 非 .py（解析期，不触存储）'],
  [{ action: 'constructor', path: 'a.py' }, /PY_INVALID_ARGUMENTS/, '原型链键名 action 不得命中白名单'],
  [{ action: 'toString', path: 'a.py' }, /PY_INVALID_ARGUMENTS/, '原型链键名 action（toString）同样拒绝'],
];
for (const [args, expected, label] of gate) {
  const context = label === '无会话上下文' ? {} : { chatId: CHAT };
  assert.match(text(await tool.execute(args, context)), expected, label);
}

// 跨 action 串参的错误必须回传该 action 的合法参数集（模型据此无需猜测即可改对）
const crossAction = text(
  await tool.execute({ action: 'run', path: 'a.py', content: 'x' }, { chatId: CHAT }),
);
assert.match(crossAction, /仅接受|该 action 仅接受/, '串参错误回传合法参数集');
assert.match(crossAction, /timeoutSeconds/, '合法参数集包含 run 专属参数');

// ──── 3. 路径穿越矩阵（纯函数） ────
const escapeAttempts = [
  '../secret', 'a/../../b', '/etc/passwd', 'C:\\Windows\\system32', 'C:evil.txt',
  'a//b', './script.py', 'a\\b', '', 'nul\0byte', 'x'.repeat(1100),
  'scripts/./run.py', 'outputs/..', ' padded.txt', 'trailing.txt ', 'both.txt\t',
];
for (const bad of escapeAttempts) {
  assert.throws(() => parseWorkspaceFilePath(bad), /\[WORKSPACE_INVALID_PATH\]/, `拒绝 ${JSON.stringify(bad.slice(0, 40))}`);
}
assert.equal(parseWorkspaceFilePath('scripts/run.py'), 'scripts/run.py');
assert.equal(parseWorkspaceFilePath('outputs/报告 & data.csv'), 'outputs/报告 & data.csv');
assert.equal(parseWorkspaceFilePath('skills/ed25519:pub/plug/skill-1/scripts/a.py'), 'skills/ed25519:pub/plug/skill-1/scripts/a.py');

// ──── 4. 内容边界（纯函数） ────
assert.throws(() => validateWorkspaceFileContent(123, 'content'), /\[WORKSPACE_INVALID_CONTENT\]/);
assert.throws(() => validateWorkspaceFileContent('a\0b', 'content'), /\[WORKSPACE_INVALID_CONTENT\]/);
assert.throws(() => validateWorkspaceFileContent('lone\ud800surrogate', 'content'), /\[WORKSPACE_INVALID_CONTENT\]/);
assert.throws(() => validateWorkspaceFileContent('x'.repeat(200_001), 'content'), /\[WORKSPACE_FILE_TOO_LARGE\]/);
assert.equal(validateWorkspaceFileContent('', 'content'), '', '空文件合法');

// ──── 5. file_util 端到端文件操作（真实存储事务） ────
await chatDatabase.createSession({
  chatId: CHAT, title: 'files', createdAt: 1, updatedAt: 1,
  messageCount: 0, lastMessagePreview: '', agentName: '',
});

const deliverable = await files.execute({ action: 'create', path: 'outputs/manual.csv', content: 'name,count\na,2' }, { chatId: CHAT });
assert.equal(deliverable.success, true);
assert.equal(deliverable.data.file.marker, '<workspace-file path="outputs/manual.csv" />');
assert.deepEqual(deliverable.data.files, [deliverable.data.file]);
const projected = projectToolPayload(deliverable);
assert.equal(projected.kind, 'payload');
if (projected.kind === 'payload') assert.match(String(projected.value.text), /已创建/);
const revisedDeliverable = await files.execute({ action: 'edit', path: 'outputs/manual.csv', find: 'a,2', replace: 'a,3' }, { chatId: CHAT });
assert.equal(revisedDeliverable.data.file.path, 'outputs/manual.csv');
assert.match(text(revisedDeliverable), /<workspace-file /);

const created = await files.execute(
  { action: 'create', path: 'scripts/hello.py', content: 'print("hi")\n' },
  { chatId: CHAT },
);
assert.equal(created.success, true, text(created));
assert.match(text(created), /scripts\/hello\.py/);
let snapshot = await chatDatabase.readWorkspace(CHAT);
assert.ok(snapshot?.entries.some(entry => entry.path === 'scripts' && entry.blob === null), '自动创建父目录');
assert.ok(snapshot?.entries.some(entry => entry.path === 'scripts/hello.py' && entry.blob), '文件落盘');

assert.match(
  text(await files.execute({ action: 'create', path: 'scripts/hello.py', content: 'x' }, { chatId: CHAT })),
  /FILE_EXISTS/,
  '重复 create 拒绝',
);

const edited = await files.execute(
  { action: 'edit', path: 'scripts/hello.py', find: 'hi', replace: 'hello workspace' },
  { chatId: CHAT },
);
assert.equal(edited.success, true, text(edited));
assert.match(text(edited), /唯一命中替换/);
snapshot = await chatDatabase.readWorkspace(CHAT);
assert.equal(
  await snapshot!.entries.find(entry => entry.path === 'scripts/hello.py')!.blob!.text(),
  'print("hello workspace")\n',
  'find/replace 精确替换',
);

await files.execute({ action: 'create', path: 'dup.txt', content: 'aa aa' }, { chatId: CHAT });
assert.match(
  text(await files.execute({ action: 'edit', path: 'dup.txt', find: 'aa', replace: 'b' }, { chatId: CHAT })),
  /INVALID_EDIT/,
  '多命中拒绝',
);
assert.match(
  text(await files.execute({ action: 'edit', path: 'missing.txt', content: 'x' }, { chatId: CHAT })),
  /FILE_NOT_FOUND/,
);
assert.equal(
  (await files.execute({ action: 'edit', path: 'dup.txt', content: 'fresh' }, { chatId: CHAT })).success,
  true,
  'content 全量重写',
);

assert.match(text(await files.execute({ action: 'delete', path: 'scripts' }, { chatId: CHAT })), /目录/, '目录不能被删除');
assert.match(text(await files.execute({ action: 'delete', path: 'missing.txt' }, { chatId: CHAT })), /文件不存在|FILE_NOT_FOUND/);
assert.equal((await files.execute({ action: 'delete', path: 'dup.txt' }, { chatId: CHAT })).success, true);
snapshot = await chatDatabase.readWorkspace(CHAT);
assert.ok(!snapshot?.entries.some(entry => entry.path === 'dup.txt'), '删除生效');
assert.ok(snapshot?.entries.some(entry => entry.path === 'scripts' && entry.blob === null), '父目录保留');
assert.ok(snapshot?.entries.some(entry => entry.path === 'scripts/hello.py'), '其余文件不受影响');

assert.match(
  text(await files.execute({ action: 'create', path: 'x.txt', content: 'y' }, { chatId: 'no-such-chat-xyz' })),
  /CONTEXT/,
  '会话不存在 → 可读错误',
);

// ──── 5a. read / list：分页与盘点语义 ────
await files.execute({ action: 'create', path: 'docs/note.md', content: '第一页内容'.repeat(500) }, { chatId: CHAT });
const readResult = await files.execute({ action: 'read', path: 'docs/note.md' }, { chatId: CHAT });
assert.equal(readResult.success, true, text(readResult));
assert.match(text(readResult), /docs\/note\.md 第 1\//, 'read 回执点名文件与页码');
assert.match(text(readResult), /第一页内容/, 'read 回执包含页正文');
assert.equal(
  (readResult.data as { content?: string }).content,
  undefined,
  '正文只在回执文本一份（data 不重复载荷）',
);
assert.equal((readResult.data as { pageCount: number }).pageCount >= 1, true, 'read 回传 pageCount');
assert.ok((readResult.data as { sha256: string }).sha256, 'read 回传 sha256（供 expectedHash 使用）');

const listResult = await files.execute({ action: 'list', path: 'docs' }, { chatId: CHAT });
assert.equal(listResult.success, true, text(listResult));
const listed = (listResult.data as { entries: { path: string }[] }).entries;
assert.ok(listed.some((entry) => entry.path === 'docs/note.md'), 'list 列出目录内文件');
assert.ok(
  (listResult.data as { total: number }).total >= 1,
  'list 回传 total',
);
assert.doesNotMatch(
  text(listResult),
  /docs\/note\.md/,
  'list 回执正文不复述条目明细（明细只在 data.entries 一份）',
);

const rootList = await files.execute({ action: 'list' }, { chatId: CHAT });
assert.equal(rootList.success, true, text(rootList));
assert.ok(
  (rootList.data as { entries: { path: string }[] }).entries.some((e) => e.path === 'docs'),
  'list 省略 path 列根目录',
);

const missingDir = text(await files.execute({ action: 'list', path: 'not-created-yet' }, { chatId: CHAT }));
assert.match(missingDir, /DIR_NOT_FOUND/, '缺失目录 → DIR_NOT_FOUND（不是未预期异常）');
assert.match(missingDir, /不存在/, 'list 缺失目录显式报错');
assert.match(missingDir, /根目录/, 'list 缺失目录给出下一步');

const fileAsDir = text(await files.execute({ action: 'list', path: 'docs/note.md' }, { chatId: CHAT }));
assert.match(fileAsDir, /NOT_A_DIRECTORY/, '文件当目录 → NOT_A_DIRECTORY');
assert.match(fileAsDir, /file_util\(action="read"/, '错误给出读取文件的正确调用');

// ──── 5a-2. run 存在性预检与依赖契约前置判定 ────
assert.match(
  text(await tool.execute({ action: 'run', path: 'scripts/missing.py' }, { chatId: CHAT })),
  /PY_FILE_NOT_FOUND/,
);
assert.match(
  text(await tool.execute({ action: 'run', path: 'scripts/hello.py', dependencyMode: 'pypi' }, { chatId: CHAT })),
  /PY_DEPENDENCY_APPROVAL_REQUIRED/,
  'pypi 未审批先于存在性之后、环境之前拦截',
);
const unresolved = text(
  await tool.execute(
    { action: 'run', path: 'scripts/hello.py', requirements: ['definitely-not-in-catalog-pkg>=1'] },
    { chatId: CHAT },
  ),
);
assert.match(unresolved, /PY_DEPENDENCY_UNRESOLVABLE/, '目录外包在 catalog 模式下前置判定');
assert.match(unresolved, /definitely-not-in-catalog-pkg/, '前置判定点名具体包名');
assert.match(unresolved, /dependencyMode="pypi"/, '前置判定给出具体参数（不是"检查依赖"这类空指引）');
assert.doesNotMatch(
  text(
    await tool.execute(
      { action: 'run', path: 'scripts/hello.py', requirements: ['numpy'] },
      { chatId: CHAT },
    ),
  ),
  /PY_DEPENDENCY_UNRESOLVABLE/,
  '官方目录内的包不被前置判定拦下',
);

// ──── 5b. 编辑体验深挖（对齐 Claude Code Edit 语义） ────
assert.match(
  text(await files.execute({ action: 'create', path: 'inputs', content: 'x' }, { chatId: CHAT })),
  /INVALID_PATH[\s\S]*保留目录/,
  'inputs 保留目录拒绝作为文件创建',
);

const dollarEdit = await files.execute(
  { action: 'edit', path: 'scripts/hello.py', find: 'hello workspace', replace: '$&$1' },
  { chatId: CHAT },
);
assert.equal(dollarEdit.success, true, text(dollarEdit));
snapshot = await chatDatabase.readWorkspace(CHAT);
assert.equal(
  await snapshot!.entries.find(entry => entry.path === 'scripts/hello.py')!.blob!.text(),
  'print("$&$1")\n',
  '替换文本 $&/$1 保持字面量',
);

assert.match(
  text(await files.execute({ action: 'edit', path: 'scripts/hello.py', find: 'does_not_exist', replace: 'x' }, { chatId: CHAT })),
  /逐字符精确匹配/,
  '未命中给出精确匹配指引',
);

await files.execute({ action: 'create', path: 'lines.txt', content: 'one\ntwo\none' }, { chatId: CHAT });
const allEdit = await files.execute(
  { action: 'edit', path: 'lines.txt', find: 'one', replace: 'ONE', replaceAll: true },
  { chatId: CHAT },
);
assert.equal(allEdit.success, true, text(allEdit));
assert.match(text(allEdit), /替换 2 处/, 'replaceAll 回执命中计数');
snapshot = await chatDatabase.readWorkspace(CHAT);
assert.equal(
  await snapshot!.entries.find(entry => entry.path === 'lines.txt')!.blob!.text(),
  'ONE\ntwo\nONE',
  'replaceAll 全量替换生效',
);
await files.execute({ action: 'delete', path: 'lines.txt' }, { chatId: CHAT });

await files.execute({ action: 'create', path: 'crlf.txt', content: 'alpha\r\nbeta\r\n' }, { chatId: CHAT });
assert.match(
  text(await files.execute({ action: 'edit', path: 'crlf.txt', find: 'alpha\nbeta', replace: 'x' }, { chatId: CHAT })),
  /CRLF/,
  'CRLF/LF 错配给出换行指引',
);
await files.execute({ action: 'delete', path: 'crlf.txt' }, { chatId: CHAT });

// 注入非常规字节：非 UTF-8 文本拒绝就地编辑（杜绝静默乱码改写）
await chatDatabase.updateWorkspace(CHAT, current => ({
  snapshot: {
    revision: crypto.randomUUID(),
    entries: [...(current?.entries ?? []), { path: 'binary.txt', blob: new Blob([new Uint8Array([0xff, 0xfe, 0x41, 0x00])]) }],
  },
  result: undefined,
}));
assert.match(
  text(await files.execute({ action: 'edit', path: 'binary.txt', find: 'A', replace: 'B' }, { chatId: CHAT })),
  /UTF-8/,
  '非 UTF-8 文件拒绝就地编辑',
);

// 注入超大文本：find/replace 拒绝整读（content 重写不受此限——内容有 200k 上限）
await chatDatabase.updateWorkspace(CHAT, current => ({
  snapshot: {
    revision: crypto.randomUUID(),
    entries: [...(current?.entries ?? []), { path: 'huge.txt', blob: new Blob([new Uint8Array(9 * 1024 * 1024)]) }],
  },
  result: undefined,
}));
assert.match(
  text(await files.execute({ action: 'edit', path: 'huge.txt', find: 'a', replace: 'b' }, { chatId: CHAT })),
  /就地编辑上限/,
  '超大文件拒绝就地编辑',
);
assert.equal(
  (await files.execute({ action: 'edit', path: 'huge.txt', content: 'shrunk' }, { chatId: CHAT })).success,
  true,
  'content 全量重写可用于把超大文件缩到界限内',
);
await files.execute({ action: 'delete', path: 'huge.txt' }, { chatId: CHAT });
await files.execute({ action: 'delete', path: 'binary.txt' }, { chatId: CHAT });

// ──── 6. 模块级 API 直测（工具之外的复用面） ────
const stat = await createWorkspaceFile(CHAT, 'data/plain.txt', 'abc');
assert.equal(stat.path, 'data/plain.txt');
assert.equal(stat.bytes, 3);
const rewritten = await editWorkspaceFile(CHAT, 'data/plain.txt', { content: 'xyz' });
assert.equal(rewritten.bytes, 3);
assert.equal(rewritten.replaced, undefined);
await deleteWorkspaceFile(CHAT, 'data/plain.txt');
assert.match(await (async () => {
  try {
    await deleteWorkspaceFile(CHAT, 'data/plain.txt');
    return 'no-throw';
  } catch (error) {
    return String(error);
  }
})(), /WORKSPACE_FILE_NOT_FOUND/, '重复删除拒绝');

console.log('[python-run-files] run-only schema, param gates, path traversal matrix, content bounds, file_util end-to-end CRUD, run prechecks passed.');
