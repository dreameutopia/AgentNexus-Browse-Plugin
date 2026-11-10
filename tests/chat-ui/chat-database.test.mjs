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
  assert.equal((await factory.databases())[0].version, Math.max(3, version));
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
  (await open({ open: originalOpen }, name, 3)).close();
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
  externalUpgrade.onupgradeneeded = () => externalUpgrade.result.createObjectStore('pythonWorkspaces');
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

console.log('[chat-database] Fresh and legacy sessions, migrations, newer schemas, blocked opens and stream snapshots passed.');
