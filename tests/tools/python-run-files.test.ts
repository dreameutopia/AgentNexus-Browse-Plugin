/**
 * python_run 文件操作契约（v2 四 action）
 *
 * 覆盖四层防线：
 *   1. 工具参数门（action/未知键/跨参数隔离/replaceAll·content 形态）——先于一切存储访问；
 *   2. 路径与内容边界（parseWorkspaceFilePath 穿越矩阵 + content 有界校验）——纯函数直测；
 *   3. 端到端文件操作（fake-indexeddb + 真实 chatDatabase/store 事务）：
 *      create 父目录与幂等拒绝、edit 两种模式与唯一/全量命中、$ 字面量安全、
 *      换行错配与未命中诊断、非 UTF-8 / 超大文件拒绝就地编辑、delete 目录拒绝、
 *      会话不存在映射、run 存在性预检；
 *   4. 模块级 API 直测（workspace-files 复用面）。
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { extractContentText, projectToolPayload } from '@/common/tool-handler';
import { chatDatabase } from '@/entrypoints/sidepanel/core/context/chat-database';
import { PythonRunTool } from '@/tools/python/python-run-tool';
import {
  createWorkspaceFile, deleteWorkspaceFile, editWorkspaceFile,
  parseWorkspaceFilePath, validateWorkspaceFileContent,
} from '@/utils/python-workspace/workspace-files';

const tool = new PythonRunTool();
const text = (result: { content?: unknown }) => extractContentText(result.content);
const CHAT = 'python-run-files-chat';

// ──── 1. Schema 契约 ────
const parameters = tool.openaiSchema.function.parameters as {
  properties: Record<string, { enum?: string[] } & Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
  anyOf?: unknown[];
};
assert.deepEqual(
  parameters.properties.action.enum,
  ['create', 'edit', 'delete', 'run'],
);
assert.ok(parameters.required?.includes('action') && parameters.required?.includes('path'));
assert.equal(parameters.additionalProperties, false);
assert.equal(parameters.anyOf?.length, 4, 'four action-specific required branches');
assert.ok(parameters.properties.content && parameters.properties.find && parameters.properties.replace);

// ──── 2. 参数门（先于存储） ────
const gate: Array<[unknown, RegExp, string]> = [
  [null, /PY_INVALID_ARGUMENTS/, '非对象参数'],
  [{ action: 'destroy', path: 'a.py' }, /PY_INVALID_ARGUMENTS/, '非法 action'],
  [{ action: 'run', path: 'a.py' }, /PY_CONTEXT/, '无会话上下文'],
  [{ action: 'run' }, /PY_INVALID_SCRIPT/, 'run 缺 path'],
  [{ action: 'create', path: 'a.txt' }, /PY_INVALID_ARGUMENTS/, 'create 缺 content'],
  [{ action: 'create', path: 'a.txt', content: 'x', find: 'y', replace: 'z' }, /PY_INVALID_ARGUMENTS/, 'create 夹带 find/replace'],
  [{ action: 'create', path: 'a.txt', content: 'x', replaceAll: true }, /PY_INVALID_ARGUMENTS/, 'create 夹带 replaceAll'],
  [{ action: 'delete', path: 'a.py', timeoutSeconds: 5 }, /PY_INVALID_ARGUMENTS/, 'delete 夹带运行参数'],
  [{ action: 'delete', path: 'a.py', content: 'x' }, /PY_INVALID_ARGUMENTS/, 'delete 夹带 content'],
  [{ action: 'delete', path: 'a.py', replaceAll: true }, /PY_INVALID_ARGUMENTS/, 'delete 夹带 replaceAll'],
  [{ action: 'run', path: 'a.py', content: 'x' }, /PY_INVALID_ARGUMENTS/, 'run 夹带 content'],
  [{ action: 'run', path: 'a.py', replaceAll: true }, /PY_INVALID_ARGUMENTS/, 'run 夹带 replaceAll'],
  [{ action: 'run', path: 'a.py', timeoutSeconds: '60' }, /PY_INVALID_ARGUMENTS/, 'timeoutSeconds 非数字'],
  [{ action: 'edit', path: 'a.py', find: 'x' }, /PY_INVALID_ARGUMENTS/, 'find 缺 replace'],
  [{ action: 'edit', path: 'a.py', replace: 'y' }, /PY_INVALID_ARGUMENTS/, 'replace 缺 find'],
  [{ action: 'edit', path: 'a.py', content: 'x', find: 'y', replace: 'z' }, /PY_INVALID_ARGUMENTS/, 'edit 二选一冲突'],
  [{ action: 'edit', path: 'a.py' }, /PY_INVALID_ARGUMENTS/, 'edit 缺 content 与 find'],
  [{ action: 'edit', path: 'a.py', find: 'x', replace: 'y', replaceAll: 'yes' }, /PY_INVALID_ARGUMENTS/, 'replaceAll 非布尔'],
  [{ action: 'edit', path: 'a.py', content: 'x', replaceAll: true }, /PY_INVALID_ARGUMENTS/, 'replaceAll 缺 find/replace'],
  [{ action: 'create', path: 'a.txt', content: 'x', typo_key: 1 }, /未知参数.*typo_key/, '未知键严格拒绝'],
  [{ action: 'run', path: 'notes.txt' }, /PY_INVALID_SCRIPT/, 'run 非 .py（解析期，不触存储）'],
];
for (const [args, expected, label] of gate) {
  const context = label === '无会话上下文' ? {} : { chatId: CHAT };
  assert.match(text(await tool.execute(args, context)), expected, label);
}

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

// ──── 5. 端到端文件操作（真实存储事务） ────
await chatDatabase.createSession({
  chatId: CHAT, title: 'files', createdAt: 1, updatedAt: 1,
  messageCount: 0, lastMessagePreview: '', agentName: '', skillNames: [],
});

const deliverable = await tool.execute({ action: 'create', path: 'outputs/manual.csv', content: 'name,count\na,2' }, { chatId: CHAT });
assert.equal(deliverable.success, true);
assert.equal(deliverable.data.file.marker, '<workspace-file path="outputs/manual.csv" />');
assert.deepEqual(deliverable.data.files, [deliverable.data.file]);
const projected = projectToolPayload(deliverable);
assert.equal(projected.kind, 'payload');
if (projected.kind === 'payload') assert.match(String(projected.value.text), /已创建工作区文件/);
const revisedDeliverable = await tool.execute({ action: 'edit', path: 'outputs/manual.csv', find: 'a,2', replace: 'a,3' }, { chatId: CHAT });
assert.equal(revisedDeliverable.data.file.path, 'outputs/manual.csv');
assert.match(text(revisedDeliverable), /<workspace-file /);

const created = await tool.execute(
  { action: 'create', path: 'scripts/hello.py', content: 'print("hi")\n' },
  { chatId: CHAT },
);
assert.equal(created.success, true, text(created));
assert.match(text(created), /scripts\/hello\.py/);
let snapshot = await chatDatabase.readWorkspace(CHAT);
assert.ok(snapshot?.entries.some(entry => entry.path === 'scripts' && entry.blob === null), '自动创建父目录');
assert.ok(snapshot?.entries.some(entry => entry.path === 'scripts/hello.py' && entry.blob), '文件落盘');

assert.match(
  text(await tool.execute({ action: 'create', path: 'scripts/hello.py', content: 'x' }, { chatId: CHAT })),
  /PY_FILE_EXISTS/,
  '重复 create 拒绝',
);

const edited = await tool.execute(
  { action: 'edit', path: 'scripts/hello.py', find: 'hi', replace: 'hello workspace' },
  { chatId: CHAT },
);
assert.equal(edited.success, true, text(edited));
assert.match(text(edited), /唯一命中替换/);
snapshot = await chatDatabase.readWorkspace(CHAT);
assert.equal(
  await snapshot!.entries.find(entry => entry.path === 'scripts/hello.py')!.blob!.text(),
  'print("hello workspace")\n',
  'find/replace 精确替换（$ 模式不被二次解释由实现保证，这里验证内容）',
);

await tool.execute({ action: 'create', path: 'dup.txt', content: 'aa aa' }, { chatId: CHAT });
assert.match(
  text(await tool.execute({ action: 'edit', path: 'dup.txt', find: 'aa', replace: 'b' }, { chatId: CHAT })),
  /PY_INVALID_EDIT/,
  '多命中拒绝',
);
assert.match(
  text(await tool.execute({ action: 'edit', path: 'missing.txt', content: 'x' }, { chatId: CHAT })),
  /PY_FILE_NOT_FOUND/,
);
assert.equal(
  (await tool.execute({ action: 'edit', path: 'dup.txt', content: 'fresh' }, { chatId: CHAT })).success,
  true,
  'content 全量重写',
);

assert.match(text(await tool.execute({ action: 'delete', path: 'scripts' }, { chatId: CHAT })), /PY_DELETE_DIRECTORY/);
assert.match(text(await tool.execute({ action: 'delete', path: 'missing.txt' }, { chatId: CHAT })), /PY_FILE_NOT_FOUND/);
assert.equal((await tool.execute({ action: 'delete', path: 'dup.txt' }, { chatId: CHAT })).success, true);
snapshot = await chatDatabase.readWorkspace(CHAT);
assert.ok(!snapshot?.entries.some(entry => entry.path === 'dup.txt'), '删除生效');
assert.ok(snapshot?.entries.some(entry => entry.path === 'scripts' && entry.blob === null), '父目录保留');
assert.ok(snapshot?.entries.some(entry => entry.path === 'scripts/hello.py'), '其余文件不受影响');

assert.match(
  text(await tool.execute({ action: 'create', path: 'x.txt', content: 'y' }, { chatId: 'no-such-chat-xyz' })),
  /PY_CONTEXT/,
  '会话不存在 → 可读错误',
);

// run 存在性预检（parse → 审批 → 存在性，先于环境/宿主）
assert.match(
  text(await tool.execute({ action: 'run', path: 'scripts/missing.py' }, { chatId: CHAT })),
  /PY_FILE_NOT_FOUND/,
);
assert.match(
  text(await tool.execute({ action: 'run', path: 'scripts/hello.py', dependencyMode: 'pypi' }, { chatId: CHAT })),
  /PY_DEPENDENCY_APPROVAL_REQUIRED/,
  'pypi 未审批先于存在性之后、环境之前拦截',
);

// ──── 5b. 编辑体验深挖（对齐 Claude Code Edit 语义） ────
// 保留目录不能被创建为文件
assert.match(
  text(await tool.execute({ action: 'create', path: 'inputs', content: 'x' }, { chatId: CHAT })),
  /PY_INVALID_PATH[\s\S]*保留目录/,
  'inputs 保留目录拒绝作为文件创建',
);

// $ 模式安全：替换文本中的 $&/$1 按字面写入，不被 String.replace 二次解释
const dollarEdit = await tool.execute(
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

// 未命中诊断：给出逐字符精确匹配（含缩进/空白）的修复指引
assert.match(
  text(await tool.execute({ action: 'edit', path: 'scripts/hello.py', find: 'does_not_exist', replace: 'x' }, { chatId: CHAT })),
  /逐字符精确匹配/,
  '未命中给出精确匹配指引',
);

// replaceAll：多命中全量替换 + 计数回执
await tool.execute({ action: 'create', path: 'lines.txt', content: 'one\ntwo\none' }, { chatId: CHAT });
const allEdit = await tool.execute(
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
await tool.execute({ action: 'delete', path: 'lines.txt' }, { chatId: CHAT });

// 换行风格错配：CRLF 文件 + LF find → 明确指引，不静默失败
await tool.execute({ action: 'create', path: 'crlf.txt', content: 'alpha\r\nbeta\r\n' }, { chatId: CHAT });
assert.match(
  text(await tool.execute({ action: 'edit', path: 'crlf.txt', find: 'alpha\nbeta', replace: 'x' }, { chatId: CHAT })),
  /CRLF/,
  'CRLF/LF 错配给出换行指引',
);
await tool.execute({ action: 'delete', path: 'crlf.txt' }, { chatId: CHAT });

// 注入非常规字节：非 UTF-8 文件拒绝就地编辑（杜绝静默乱码改写）
await chatDatabase.updateWorkspace(CHAT, current => ({
  snapshot: {
    revision: crypto.randomUUID(),
    entries: [...(current?.entries ?? []), { path: 'binary.bin', blob: new Blob([new Uint8Array([0xff, 0xfe, 0x41, 0x00])]) }],
  },
  result: undefined,
}));
assert.match(
  text(await tool.execute({ action: 'edit', path: 'binary.bin', find: 'A', replace: 'B' }, { chatId: CHAT })),
  /UTF-8/,
  '非 UTF-8 文件拒绝就地编辑',
);

// 注入超大文件：find/replace 拒绝整读（内容全量重写不受此限——结果有 200k 上限）
await chatDatabase.updateWorkspace(CHAT, current => ({
  snapshot: {
    revision: crypto.randomUUID(),
    entries: [...(current?.entries ?? []), { path: 'huge.bin', blob: new Blob([new Uint8Array(9 * 1024 * 1024)]) }],
  },
  result: undefined,
}));
assert.match(
  text(await tool.execute({ action: 'edit', path: 'huge.bin', find: 'a', replace: 'b' }, { chatId: CHAT })),
  /就地编辑上限/,
  '超大文件拒绝就地编辑',
);
assert.equal(
  (await tool.execute({ action: 'edit', path: 'huge.bin', content: 'shrunk' }, { chatId: CHAT })).success,
  true,
  'content 全量重写可用于把超大文件缩到界限内',
);
await tool.execute({ action: 'delete', path: 'huge.bin' }, { chatId: CHAT });
await tool.execute({ action: 'delete', path: 'binary.bin' }, { chatId: CHAT });

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

console.log('[python-run-files] Schema, param gates, path traversal matrix, content bounds, end-to-end create/edit/delete, run prechecks passed.');
