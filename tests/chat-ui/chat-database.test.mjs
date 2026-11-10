import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';

const outfile = path.resolve('node_modules/.cache/chat-database-test.mjs');
await build({
  stdin: {
    contents: `
      export { CHAT_DB_NAME, chatDatabase } from './entrypoints/sidepanel/core/context/chat-database';
      export { transcriptEngine } from './entrypoints/sidepanel/core/context/transcript-engine';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
});

const moduleUrl = pathToFileURL(outfile).href;
const historical = { chatId: 'old-chat', title: 'History', createdAt: 1, updatedAt: 1, messageCount: 1, lastMessagePreview: 'old' };
const oldMessage = {
  id: 'old-message', chatId: historical.chatId, seq: 9, role: 'assistant', content: 'old',
  parts: [], status: 'done', createdAt: 1, updatedAt: 1, imageRefs: ['a'.repeat(64)],
};
const workspace = { revision: 'legacy', files: [] };

function open(factory, name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onupgradeneeded = () => upgrade?.(request.result, request.transaction);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function seed(factory, name, version) {
  return open(factory, name, version, db => {
    const sessions = db.createObjectStore('sessions', { keyPath: 'chatId' });
    sessions.createIndex('updatedAt', 'updatedAt');
    // v4 起的会话表带归档分流索引（模拟真实 v4 库必须含它，否则结构校验会拒绝）
    if (version > 3) sessions.createIndex('byArchived', 'archivedAt');
    sessions.put(historical);
    const messages = db.createObjectStore('messages', { keyPath: 'id' });
    messages.createIndex('byChatSeq', ['chatId', 'seq'], { unique: true });
    messages.createIndex('chatId', 'chatId');
    if (version >= 2) messages.createIndex('byImageRef', 'imageRefs', { multiEntry: true });
    messages.put(oldMessage);
    if (version >= 3) db.createObjectStore('pythonWorkspaces').put(workspace, historical.chatId);
    if (version > 3) db.createObjectStore('newerFeature').put('keep', 'key');
  });
}

async function fixture(scenario) {
  const factory = new IDBFactory();
  globalThis.indexedDB = factory;
  const { CHAT_DB_NAME: name, chatDatabase: db, transcriptEngine: transcript } =
    await import(`${moduleUrl}?${scenario}`);
  return { factory, name, db, transcript };
}

for (const version of [0, 1, 2, 3, 4]) {
  const { factory, name, db, transcript } = await fixture(version);
  if (version) (await seed(factory, name, version)).close();
  if (version === 3) {
    await assert.rejects(open(factory, name, 2), { name: 'VersionError' });
  }
  const fresh = await transcript.createSession();
  const chatId = version ? historical.chatId : fresh.chatId;
  const issues = [];
  transcript.onPersistenceIssue(issue => issues.push(issue));
  if (version) {
    assert.deepEqual(await transcript.loadSessionRecords(chatId), [oldMessage]);
    assert.equal(await db.countMessagesReferencingImage(oldMessage.imageRefs[0]), 1);
    assert.deepEqual(await db.readWorkspace(chatId), version >= 3 ? workspace : undefined);
  }
  const user = await transcript.appendUserMessage(chatId, 'continue');
  assert.equal(user.seq, version ? 10 : 1);
  const assistant = await transcript.createAssistantRecord(chatId);
  assistant.content = 'partial';
  const pending = transcript.flush(assistant);
  assistant.content = 'complete';
  assistant.status = 'done';
  await Promise.all([pending, transcript.flush(assistant)]);
  assert.equal((await db.getMessage(assistant.id)).content, 'complete');
  assert.equal((await db.getSession(chatId)).messageCount, version ? 3 : 2);
  assert.equal((await db.getSession(chatId)).lastMessagePreview, 'complete');
  assert.deepEqual(issues, []);
  // 打开即对齐到当前最低 schema 版本（v4 起为归档索引 byArchived）；
  // 种子版本更高时保留种子版本（不得降版）
  assert.equal((await factory.databases())[0].version, Math.max(4, version));
  if (version === 4) {
    const newer = await open(factory, name, 4);
    assert.equal(newer.objectStoreNames.contains('newerFeature'), true);
    newer.close();
  }
}

{
  const { factory, name, db } = await fixture('live-upgrade');
  await db.createSession(historical);
  const upgraded = await open(factory, name, 4, connection => connection.createObjectStore('future'));
  upgraded.close();
  await db.patchSession(historical.chatId, { title: 'After versionchange' });
  assert.equal((await db.getSession(historical.chatId)).title, 'After versionchange');
}

{
  const { factory, name, db, transcript } = await fixture('blocked');
  const blocker = await seed(factory, name, 2);
  const originalOpen = factory.open.bind(factory);
  let openCount = 0;
  factory.open = (...args) => {
    openCount++;
    return originalOpen(...args);
  };
  const issues = [];
  transcript.onPersistenceIssue(issue => issues.push(issue));
  const assistant = { ...oldMessage, id: 'new-message', seq: 10, status: 'streaming' };
  const snapshots = Array.from({ length: 12 }, () => transcript.flush(assistant));
  await Promise.all(snapshots);
  await transcript.flush(assistant);
  assert.equal(openCount, 1, 'blocked snapshots share one native request');
  assert.equal(issues.length, 1, 'repeated snapshots report one degradation');
  blocker.close();
  // Queue behind the retained upgrade, then wait one turn for its success handler.
  // （与 chatDatabase 同版本排队：低版本打开会在升级完成后触发 VersionError）
  (await open({ open: originalOpen }, name, 4)).close();
  assistant.content = 'recovered';
  assistant.status = 'done';
  await transcript.flush(assistant);
  assert.equal(openCount, 1, 'the original request publishes its recovered connection');
  assert.equal((await db.getMessage(assistant.id)).content, 'recovered');
  assert.deepEqual(await db.getMessage(oldMessage.id), oldMessage);
}

{
  const { factory, name, db } = await fixture('queued-open');
  const blocker = await seed(factory, name, 2);
  const externalUpgrade = factory.open(name, 4);
  await new Promise(resolve => {
    externalUpgrade.onblocked = resolve;
  });
  const externalDone = new Promise((resolve, reject) => {
    externalUpgrade.onsuccess = () => {
      externalUpgrade.result.close();
      resolve();
    };
    externalUpgrade.onerror = () => reject(externalUpgrade.error);
  });
  externalUpgrade.onupgradeneeded = () => {
    externalUpgrade.result.createObjectStore('pythonWorkspaces');
    // 外部上下文的 v4 迁移同样要建归档索引（与当前 schema 一致），
    // 否则后续 chatDatabase 的同版本重连会因结构缺索引被拒。
    // 注意：升级事务挂在 request.transaction 上（db.transaction 是创建新事务的方法）
    externalUpgrade.transaction.objectStore('sessions').createIndex('byArchived', 'archivedAt');
  };
  await assert.rejects(db.getSession(historical.chatId), /连接超时/);
  blocker.close();
  await externalDone;
  // Wait until the queued request and its versionless retry have settled.
  (await open(factory, name, 4)).close();
  (await open(factory, name, 4)).close();
  assert.deepEqual(await db.getSession(historical.chatId), historical);
}

{
  const { factory, name, db } = await fixture('incompatible');
  (await seed(factory, name, 3)).close();
  const malformed = await open(factory, name, 4, (_connection, tx) => {
    const messages = tx.objectStore('messages');
    messages.deleteIndex('byChatSeq');
    messages.createIndex('byChatSeq', ['chatId', 'seq']);
  });
  malformed.close();
  await assert.rejects(db.createSession(historical), /v4.*不兼容/);
  const unchanged = await open(factory, name, 4);
  assert.equal(unchanged.transaction('messages').objectStore('messages').index('byChatSeq').unique, false);
  unchanged.close();
}

// ──── 归档分流（byArchived 索引）与内容搜索（真库语义，桩无法覆盖） ────
{
  const { db } = await fixture('archive-scope');
  const mk = (chatId, updatedAt) => ({
    chatId, title: chatId, createdAt: 1, updatedAt, messageCount: 0,
    lastMessagePreview: '', agentName: '', skillNames: [],
  });
  await db.createSession(mk('a1', 100));
  await db.createSession(mk('a2', 200));
  await db.createSession(mk('a3', 300));

  // 归档写入时间戳，常规视图立即排除（索引不收录键缺失的记录是分流的根基）
  const archived = await db.setSessionArchived('a2', true, 150);
  assert.equal(archived.archivedAt, 150, 'setSessionArchived 写入归档时间戳');
  assert.deepEqual((await db.listSessions({ scope: 'active' })).map(s => s.chatId), ['a3', 'a1'],
    '常规视图按 updatedAt 倒序且排除归档会话');
  assert.deepEqual((await db.listSessions({ scope: 'archived' })).map(s => s.chatId), ['a2'],
    '归档视图只含归档会话');
  assert.deepEqual((await db.listSessions({ scope: 'all' })).map(s => s.chatId), ['a3', 'a2', 'a1'],
    'all 视图含全部会话（备份口径）');

  // 归档视图按归档时刻倒序（与常规视图的排序键不同）
  await db.setSessionArchived('a1', true, 250);
  assert.deepEqual((await db.listSessions({ scope: 'archived' })).map(s => s.chatId), ['a1', 'a2'],
    '归档视图按归档时间倒序');
  assert.deepEqual((await db.listSessions({ scope: 'active' })).map(s => s.chatId), ['a3'],
    '归档后常规视图收敛');

  // 分页配额只计命中项：active 仅剩 1 条，offset 1 应为空而非被过滤项吃掉配额
  assert.deepEqual(await db.listSessions({ scope: 'active', limit: 5, offset: 1 }), [],
    'active 分页 offset 跳过的是命中项');

  // 取消归档：archivedAt 键真正删除（而非置 undefined —— 否则索引条目残留）
  const unarchived = await db.setSessionArchived('a2', false);
  assert.equal('archivedAt' in unarchived, false, '取消归档删除键而非置 undefined');
  assert.deepEqual((await db.listSessions({ scope: 'archived' })).map(s => s.chatId), ['a1'],
    '取消归档后离开归档视图');
  assert.deepEqual((await db.listSessions({ scope: 'all' })).map(s => s.chatId), ['a3', 'a2', 'a1'],
    'all 视图顺序不因归档态改变（按 updatedAt）');

  // patchSession 显式 undefined = 删键（归档态的另一条清除路径，与消息侧同口径）
  await db.setSessionArchived('a3', true, 400);
  const patched = await db.patchSession('a3', { title: 'renamed', archivedAt: undefined });
  assert.equal('archivedAt' in patched, false, 'patchSession 显式 undefined 删除 archivedAt');
  assert.equal(patched.title, 'renamed', '同一 patch 的其它字段正常落库');
  assert.deepEqual((await db.listSessions({ scope: 'active' })).map(s => s.chatId), ['a3', 'a2'],
    'patchSession 清除归档态后回到常规视图');

  // 内容搜索：大小写不敏感命中 / 片段上下文 / 未命中 null / 按会话隔离
  await db.saveMessage({
    id: 'm1', chatId: 'a1', seq: 1, role: 'user', content: '今天讨论了 Apple 发布会',
    parts: [], reasoning: '', toolCalls: [], status: 'done', createdAt: 1, updatedAt: 1,
  });
  await db.saveMessage({
    id: 'm2', chatId: 'a1', seq: 2, role: 'assistant', content: '好的，已整理要点',
    parts: [], reasoning: '', toolCalls: [], status: 'done', createdAt: 2, updatedAt: 2,
  });
  const hit = await db.findContentMatch('a1', 'apple');
  assert.ok(hit, '内容搜索命中（大小写不敏感）');
  assert.equal(hit.count, 1, '命中一条消息');
  assert.ok(hit.snippet.includes('Apple'), '片段携带命中上下文');
  assert.equal(await db.findContentMatch('a1', '不存在的词'), null, '未命中返回 null');
  assert.equal(await db.findContentMatch('a2', 'apple'), null, '内容搜索按会话隔离');
  assert.equal(await db.findContentMatch('a1', '  '), null, '空白关键词直接返回 null');
}

console.log('[chat-database] Fresh and legacy sessions, migrations, newer schemas, blocked opens, stream snapshots, archive scope and content search passed.');
