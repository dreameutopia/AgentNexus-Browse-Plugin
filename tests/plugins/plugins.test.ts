import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { canonicalize } from 'json-canonicalize';
import { base32, sha256, verifyPackage } from '../../utils/plugins/package';
import { PluginRepository } from '../../utils/plugins/repository';
import { PluginService } from '../../utils/plugins/service';
import { strictJson } from '../../utils/plugins/json';
import { checkSchema, validateArguments } from '../../utils/plugins/schema';
import { readArchive, safePath } from '../../utils/plugins/archive';
import { wireNames } from '../../utils/plugins/wire-names';
import { computeAvailability } from '../../utils/plugins/dependencies';
import { PluginExecutionGateway } from '../../entrypoints/background/plugins/execution';
import { toolRegistry } from '../../tools/registry';
import { publicHttps } from '../../utils/plugins/network';
import { initPluginHost } from '../../entrypoints/background/plugins/host';
import {
  githubRelease,
  downloadCandidate,
  fetchCatalog,
} from '../../utils/plugins/github';
import {
  applyPluginSnapshot,
  getPluginSnapshot,
  pluginToolCeiling,
} from '../../utils/plugins/catalog';

let passed = 0;
async function test(name: string, action: () => unknown) {
  await action();
  console.log(`PASS ${++passed}: ${name}`);
}
const pair = generateKeyPairSync('ed25519');
async function bundle(
  version = '1.0.0',
  opts: {
    pair?: typeof pair;
    change?: string;
    dependencies?: Record<string, string>;
    extra?: Record<string, Uint8Array>;
    id?: string;
    mcp?: boolean;
  } = {},
) {
  const keys = opts.pair ?? pair,
    publicKey = keys.publicKey.export({ format: 'jwk' }),
    publisher = `ed25519:${base32(Buffer.from(publicKey.x!, 'base64url'))}`;
  const manifest = {
    manifestVersion: 1,
    publisher: { id: publisher, displayName: 'Publisher' },
    id: opts.id ?? 'research',
    displayName: 'Research',
    version,
    engines: { agentnexus: '>=0.0.1 <1.0.0', pluginApi: '^1.0.0' },
    license: 'MIT',
    capabilities: {
      hostTools: ['builtin/browser_get_page_text'],
      network: [],
      secretSlots: [],
    },
    contributes: {
      tools: [{ id: 'search', path: 'tools/search.json' }],
      skills: [{ id: 'research', path: 'skills/research/SKILL.md' }],
      agents: [{ id: 'researcher', path: 'agents/researcher.json' }],
    },
    dependencies: opts.dependencies ?? {},
    optionalDependencies: {},
  };
  if (opts.mcp)
    manifest.capabilities.network = ['https://mcp.example.com'] as never[];
  const files: Record<string, Uint8Array> = {
    'plugin.json': strToU8(JSON.stringify(manifest)),
    'tools/search.json': strToU8(
      JSON.stringify({
        description: opts.change ?? 'Read page',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        executor: opts.mcp
          ? {
              type: 'mcp',
              url: 'https://mcp.example.com/mcp',
              remoteName: 'search',
            }
          : { type: 'host-alias', target: 'builtin/browser_get_page_text' },
      }),
    ),
    'skills/research/SKILL.md': strToU8(
      '---\nname: research\ndescription: Research\nallowed-tools: ./search\n---\nUse {{tool:search}} to read evidence.',
    ),
    'agents/researcher.json': strToU8(
      JSON.stringify({
        name: 'Researcher',
        system: 'Use {{tool:search}}',
        tools: ['./search'],
        skills: ['./research'],
      }),
    ),
    ...opts.extra,
  };
  const integrity = {
    version: 1,
    files: await Promise.all(
      Object.keys(files)
        .sort()
        .map(async (path) => ({
          path,
          size: files[path].length,
          sha256: await sha256(files[path]),
        })),
    ),
  };
  files['integrity.json'] = strToU8(canonicalize(integrity));
  files['signature.json'] = strToU8(
    JSON.stringify({
      algorithm: 'Ed25519',
      publicKey: Buffer.from(publicKey.x!, 'base64url').toString('base64'),
      signature: sign(
        null,
        Buffer.from('AgentNexusPlugin/v1\n' + canonicalize(integrity)),
        keys.privateKey,
      ).toString('base64'),
    }),
  );
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([n, b]) => [
        n,
        [b, { mtime: new Date('2000-01-01T00:00:00Z') }],
      ]),
    ),
  );
}
const a = await bundle(),
  b = await bundle('1.1.0'),
  verified = await verifyPackage(a, '0.0.1');
await test('signed package, canonical identities and reference compilation', () => {
  assert.equal(verified.tools[0].ref, `${verified.key}/search`);
  assert.equal(verified.skills[0].allowedTools[0], verified.tools[0].ref);
  assert(verified.agents[0].system.includes(verified.tools[0].ref));
});
await test('publisher namespace separates identically named plugins', async () => {
  const other = await verifyPackage(
    await bundle('1.0.0', { pair: generateKeyPairSync('ed25519') }),
    '0.0.1',
  );
  assert.notEqual(other.key, verified.key);
});
await test('tampering and corrupt ZIP fail without producing contributions', async () => {
  const files = readArchive(a);
  files.set('tools/search.json', strToU8('{}'));
  await assert.rejects(
    verifyPackage(zipSync(Object.fromEntries(files)), '0.0.1'),
    /INTEGRITY_MISMATCH/,
  );
  const bad = a.slice();
  bad[40] ^= 0xff;
  await assert.rejects(verifyPackage(bad, '0.0.1'));
});
await test('strict JSON rejects duplicate keys, unsafe keys and depth attacks', () => {
  for (const s of [
    '{"a":1,"a":2}',
    '{"__proto__":{}}',
    '['.repeat(40) + '0' + ']'.repeat(40),
    '1e999',
    '{"a":1}{}',
  ])
    assert.throws(() => strictJson(s));
  assert.deepEqual(
    [...(strictJson(JSON.stringify([1, true, 'a"b'])) as any[])],
    [1, true, 'a"b'],
  );
});
await test('unsafe paths, symlink names and case-folded collisions rejected', async () => {
  for (const p of [
    '../x',
    'C:/x',
    '/x',
    'a\\x',
    'a/%2e%2e/x',
    'a//x',
    'nul.json',
  ])
    assert.throws(() => safePath(p));
  await assert.rejects(
    verifyPackage(
      await bundle('1.0.0', { extra: { 'TOOLS/SEARCH.JSON': strToU8('{}') } }),
      '0.0.1',
    ),
    /DUPLICATE/,
  );
});
await test('schema interpreter fails closed on unsupported and expensive features', () => {
  assert.throws(() => checkSchema({ type: 'object', $ref: 'https://evil' }));
  assert.throws(() =>
    checkSchema({
      type: 'object',
      properties: { x: { type: 'string', pattern: '(a+)+' } },
    }),
  );
  const s = {
    type: 'object',
    properties: { x: { type: 'integer', minimum: 1 } },
    required: ['x'],
    additionalProperties: false,
  };
  checkSchema(s);
  validateArguments(s, { x: 2 });
  assert.throws(() => validateArguments(s, { x: 0 }));
  assert.throws(() => validateArguments(s, { x: 2, y: 1 }));
});
const repo = new PluginRepository(`plugins-test-${crypto.randomUUID()}`),
  service = new PluginService(repo, '0.0.1');
await test('install and duplicate import are atomic and idempotent', async () => {
  const preview = await service.preview(a);
  const next = await service.install(
    a,
    preview.generation,
    preview.plugin.digest,
  );
  assert.equal(next.generation, 1);
  assert.equal((await service.install(a, 1, verified.digest)).generation, 1);
  assert.equal((await service.snapshot()).packages.length, 1);
});
await test('same version with different content is rejected', async () => {
  await assert.rejects(
    service.preview(await bundle('1.0.0', { change: 'changed' })),
    /VERSION_CONTENT_CONFLICT/,
  );
  assert.equal((await service.snapshot()).generation, 1);
});
await test('stale previews cannot overwrite a concurrent mutation', async () => {
  const preview = await service.preview(b);
  await service.setEnabled(verified.key, false, preview.generation);
  await assert.rejects(
    service.install(b, preview.generation, preview.plugin.digest),
    /STALE_PREVIEW/,
  );
  assert.equal(
    (await service.snapshot()).packages[0].manifest.version,
    '1.0.0',
  );
});
await test('disabled plugin stays disabled after update, downgrade requires known rollback', async () => {
  const preview = await service.preview(b);
  await service.install(b, preview.generation, preview.plugin.digest);
  assert.equal((await service.snapshot()).packages[0].enabled, false);
  await assert.rejects(service.preview(a), /DOWNGRADE/);
  assert.equal(
    (await service.preview(a, undefined, true)).plugin.manifest.version,
    '1.0.0',
  );
});
await test('CAS across independent repository instances serializes writers', async () => {
  const state = await repo.read();
  const results = await Promise.allSettled([
    repo.commit(state.generation, state.packages),
    new PluginRepository((repo as any).name).commit(
      state.generation,
      state.packages,
    ),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});
await test('missing dependencies cannot become active', async () => {
  const missing = `${verified.manifest.publisher.id}/missing`;
  const bytes = await bundle('1.0.0', {
    id: 'dependent',
    dependencies: { [missing]: '^1.0.0' },
  });
  const preview = await service.preview(bytes);
  await assert.rejects(
    service.install(bytes, preview.generation, preview.plugin.digest),
    /DEPENDENCY_BLOCKED/,
  );
});
await test('wire names are unique, legal and preserve canonical history', () => {
  const name = verified.tools[0].ref;
  const tools = [
    {
      type: 'function' as const,
      function: {
        name,
        description: 'test',
        parameters: { type: 'object' as const, properties: {} },
      },
    },
  ];
  const messages = [
    {
      role: 'assistant',
      tool_calls: [
        { id: '1', type: 'function', function: { name, arguments: '{}' } },
      ],
    },
    { role: 'tool', name, tool_call_id: '1', content: 'ok' },
  ];
  (messages[0] as any).nativeReplay = {
    provider: 'claude',
    items: [{ type: 'tool_use', id: '1', name, input: {} }],
  };
  const wire = wireNames(tools, messages);
  assert.match(wire.tools[0].function.name, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.equal(
    wire.decodeCall(wire.messages[0].tool_calls[0]).function.name,
    name,
  );
  assert.equal(messages[0].tool_calls![0].function.name, name);
  assert.equal(
    wire.messages[0].nativeReplay.items[0].name,
    wire.tools[0].function.name,
  );
  assert.equal(
    wire.decodeMessage(wire.messages[0]).nativeReplay.items[0].name,
    name,
  );
});
await test('execution requires approval, current grant and matching contract', async () => {
  let state = await service.snapshot();
  state = await service.setEnabled(verified.key, true, state.generation);
  const p = state.packages[0],
    gateway = new PluginExecutionGateway(service, async () => undefined),
    bindings = { [p.key]: { digest: p.digest, epoch: p.epoch } };
  const denied = await gateway.execute(p.tools[0].ref, {}, {});
  assert.equal(denied.success, false);
  const bad = await gateway.execute(
    p.tools[0].ref,
    {},
    {
      pluginApproved: true,
      pluginBindings: { [p.key]: { digest: '0'.repeat(64), epoch: p.epoch } },
    },
  );
  assert.match(JSON.stringify(bad), /VERSION_CHANGED/);
});
await test('network restrictions reject private addresses and credentials', () => {
  for (const url of [
    'http://example.com',
    'https://127.0.0.1',
    'https://[::1]',
    'https://localhost',
    'https://user:pass@example.com',
  ])
    assert.throws(() => publicHttps(url));
  assert.equal(
    publicHttps('https://example.com/mcp').origin,
    'https://example.com',
  );
});
await test('uninstall removes contributions and a fresh service sees committed state', async () => {
  const state = await service.snapshot();
  await service.uninstall(verified.key, state.generation);
  assert.equal(
    (await new PluginService(repo, '0.0.1').snapshot()).packages.length,
    0,
  );
  assert.equal(await repo.release(verified.key, '1.0.0'), undefined);
});
await test('real host-alias execution is aborted and late results suppressed on disable', async () => {
  const preview = await service.preview(a);
  await service.install(a, preview.generation, preview.plugin.digest);
  let state = await service.snapshot();
  const plugin = state.packages[0];
  let release!: () => void, begun!: () => void;
  const started = new Promise<void>((r) => {
    begun = r;
  });
  const target = {
    name: 'browser_get_page_text',
    metadata: {
      name: 'browser_get_page_text',
      description: 'test',
      category: 'browser',
      version: '1',
    },
    openaiSchema: {
      type: 'function' as const,
      function: {
        name: 'browser_get_page_text',
        description: 'test',
        parameters: { type: 'object' as const, properties: {} },
      },
    },
    execute: async () => {
      begun();
      await new Promise<void>((r) => {
        release = r;
      });
      return { success: true, data: 'late' };
    },
  };
  toolRegistry.register(target);
  const gateway = new PluginExecutionGateway(service, async () => undefined),
    promise = gateway.execute(
      plugin.tools[0].ref,
      {},
      {
        pluginApproved: true,
        pluginBindings: {
          [plugin.key]: { digest: plugin.digest, epoch: plugin.epoch },
        },
      },
    );
  await started;
  state = await service.setEnabled(plugin.key, false, state.generation);
  gateway.reconcile(state);
  const result = await promise;
  assert.equal(result.success, false);
  release();
});
await test('GitHub release discovery pins repository identity and package digest', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/repos/test/research'))
      return Response.json({ id: 123, full_name: 'test/research' });
    if (url.includes('/releases?'))
      return Response.json([
        {
          tag_name: 'v1.0.0',
          assets: [
            {
              name: 'plugin.anplugin',
              size: a.length,
              digest: `sha256:${verified.digest}`,
              browser_download_url:
                'https://github.com/test/research/releases/download/v1.0.0/plugin.anplugin',
            },
          ],
        },
      ]);
    const response = new Response(a as BodyInit);
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  try {
    const candidate = await githubRelease('https://github.com/test/research');
    assert.equal(candidate.source?.repositoryId, 123);
    assert.equal(
      await sha256(await downloadCandidate(candidate)),
      verified.digest,
    );
    await assert.rejects(
      githubRelease('https://github.com/test/research', undefined, 456),
      /REPOSITORY_CHANGED/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
await test('signed catalog rejects stale sequences and verifies its independently pinned key', async () => {
  const payload = {
      version: 1,
      sequence: 4,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      plugins: [],
    },
    pub = pair.publicKey.export({ format: 'jwk' });
  const body = {
      ...payload,
      signature: sign(
        null,
        Buffer.from('AgentNexusCatalog/v1\n' + canonicalize(payload)),
        pair.privateKey,
      ).toString('base64'),
    },
    original = globalThis.fetch;
  globalThis.fetch = async () => Response.json(body);
  try {
    assert.equal(
      (
        await fetchCatalog(
          'https://catalog.example/index.json',
          Buffer.from(pub.x!, 'base64url').toString('base64'),
          4,
        )
      ).sequence,
      4,
    );
    await assert.rejects(
      fetchCatalog(
        'https://catalog.example/index.json',
        Buffer.from(pub.x!, 'base64url').toString('base64'),
        5,
      ),
      /REPLAYED/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
const bgListeners: any[] = [],
  bgStorage = new Map<any, any>();
await test('official catalog constants stay well-formed in both deployment states', async () => {
  const {
    OFFICIAL_CATALOG_PUBLIC_KEY,
    OFFICIAL_CATALOG_URL,
    isOfficialCatalogConfigured,
  } = await import('../../utils/plugins/official-catalog');
  if (!isOfficialCatalogConfigured()) {
    // 尚未部署：两常量必须同时为空（发现页据此优雅降级）
    assert.equal(OFFICIAL_CATALOG_URL, '');
    assert.equal(OFFICIAL_CATALOG_PUBLIC_KEY, '');
  } else {
    // 已部署：URL 为 HTTPS，公钥 Base64 解码恰为 32 字节（Ed25519）
    assert.equal(new URL(OFFICIAL_CATALOG_URL).protocol, 'https:');
    assert.equal(Buffer.from(OFFICIAL_CATALOG_PUBLIC_KEY, 'base64').length, 32);
  }
});
await test('background protocol rejects content-script senders and supports install/export/disabled restore', async () => {
  (globalThis as any).chrome = {
    runtime: {
      id: 'test',
      getURL: (p: string) => `chrome-extension://test${p}`,
      onMessage: { addListener: (fn: any) => bgListeners.push(fn) },
      sendMessage: async () => undefined,
    },
    storage: {
      local: {
        get: async (k: any) =>
          k === null ? Object.fromEntries(bgStorage) : { [k]: bgStorage.get(k) },
        set: async (v: any) =>
          Object.entries(v).forEach(([k, v]) => bgStorage.set(k, v)),
        remove: async (k: any) => {
          for (const item of Array.isArray(k) ? k : [k]) bgStorage.delete(item);
        },
      },
    },
  };
  await initPluginHost();
  const request = (
    operation: string,
    payload: any = {},
    url = 'chrome-extension://test/hub.html',
  ) =>
    new Promise<any>((resolve) =>
      bgListeners[0](
        { type: 'agentnexus.plugins.v1', operation, payload },
        { id: 'test', url },
        resolve,
      ),
    );
  assert.equal(
    (await request('snapshot', {}, 'https://example.com/hub.html')).code,
    'PLUGIN_SENDER_REJECTED',
  );
  assert.equal(
    (await request('snapshot', {}, 'file:///hub.html')).code,
    'PLUGIN_SENDER_REJECTED',
  );
  const data = Buffer.from(a).toString('base64'),
    preview = await request('preview', { data });
  assert.equal(preview.ok, true);
  const installed = await request('install', {
    data,
    generation: preview.value.generation,
    digest: preview.value.plugin.digest,
  });
  assert.equal(installed.ok, true);
  const ceiling = pluginToolCeiling(verified.key)!;
  assert(ceiling.includes(verified.tools[0].ref));
  assert(ceiling.includes('browser_get_page_text'));
  assert(!ceiling.includes('browser_page_exec'));
  assert.equal((await request('export', { key: verified.key })).value, data);
  const backup = await request('backup-export');
  const restored = await request('backup-restore', {
    archives: backup.value,
    strategy: 'replace',
  });
  assert.equal(restored.ok, true);
  assert.equal((await request('snapshot')).value.packages[0].enabled, false);
  assert.equal(
    (await request('backup-rollback', { token: restored.value })).ok,
    true,
  );
  assert.equal((await request('snapshot')).value.packages[0].enabled, true);
});
await test('check-updates throttles, detects newer releases and aborts on rate limits', async () => {
  const send = (operation: string, payload: any = {}) =>
      new Promise<any>((resolve) =>
        bgListeners[0](
          { type: 'agentnexus.plugins.v1', operation, payload },
          { id: 'test', url: 'chrome-extension://test/hub.html' },
          resolve,
        ),
      ),
    bytes = await bundle('1.0.0', { id: 'update-me' }),
    package_ = await verifyPackage(bytes, '0.0.1'),
    newerDigest = 'ab'.repeat(32);
  let phase: 'install' | 'newer' | 'ratelimited' = 'install',
    apiCalls = 0;
  const originalFetch = globalThis.fetch,
    realNow = Date.now;
  const release = (tag: string, digest: string) => ({
    tag_name: tag,
    assets: [
      {
        name: 'plugin.anplugin',
        size: bytes.length,
        digest: `sha256:${digest}`,
        browser_download_url: `https://github.com/test/updater/releases/download/${tag}/plugin.anplugin`,
      },
    ],
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://api.github.com/')) {
      apiCalls++;
      if (phase === 'ratelimited') return new Response(null, { status: 403 });
      if (url.endsWith('/repos/test/updater'))
        return Response.json({ id: 777, full_name: 'test/updater' });
      if (url.includes('/releases?'))
        return Response.json(
          phase === 'newer'
            ? [release('v1.0.0', package_.digest), release('v2.0.0', newerDigest)]
            : [release('v1.0.0', package_.digest)],
        );
    }
    const response = new Response(bytes as BodyInit);
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  try {
    // 经 github-install 安装，包记录携带 GitHub 来源（source）
    const preview = await send('github-preview', {
      repository: 'https://github.com/test/updater',
    });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(
      (
        await send('github-install', {
          repository: 'https://github.com/test/updater',
          key: preview.value.preview.plugin.key,
          generation: preview.value.preview.generation,
          digest: preview.value.preview.plugin.digest,
        })
      ).ok,
      true,
    );
    // 跳过 github() 的 5 分钟内存缓存后目录出现 v2.0.0
    Date.now = () => realNow() + 400_000;
    phase = 'newer';
    bgStorage.set('plugin-updates:lastCheck', Date.now() - 7 * 3600_000);
    const updates = await send('check-updates');
    assert.equal(updates.ok, true, JSON.stringify(updates));
    assert.deepEqual(updates.value, [
      { key: package_.key, version: '2.0.0', digest: newerDigest },
    ]);
    // 6 小时内静默跳过：不发任何请求
    const calls = apiCalls;
    bgStorage.set('plugin-updates:lastCheck', Date.now());
    assert.deepEqual((await send('check-updates')).value, []);
    assert.equal(apiCalls, calls);
    // GitHub 限流（403）：首个仓库即中止批次，不继续请求其余插件
    // （再推 400 秒让 github() 缓存过期，确保请求真正发出并被 403 拒绝）
    Date.now = () => realNow() + 800_000;
    phase = 'ratelimited';
    bgStorage.set('plugin-updates:lastCheck', Date.now() - 7 * 3600_000);
    assert.deepEqual((await send('check-updates')).value, []);
    assert.equal(apiCalls, calls + 1);
  } finally {
    Date.now = realNow;
    globalThis.fetch = originalFetch;
  }
  // 清理：卸载带来源的测试插件，不污染后续用例的包计数
  const snapshot = await send('snapshot');
  await send('uninstall', {
    key: package_.key,
    generation: snapshot.value.generation,
  });
});
await test('MCP initialize, list and call use pinned schema and block drift', async () => {
  const bytes = await bundle('1.0.0', { id: 'remote-research', mcp: true }),
    preview = await service.preview(bytes);
  await service.install(bytes, preview.generation, preview.plugin.digest);
  const plugin = (await service.snapshot()).packages.find((p) =>
      p.key.endsWith('/remote-research'),
    )!,
    gateway = new PluginExecutionGateway(service, async () => undefined),
    original = fetch;
  let drift = false,
    called = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    const message = JSON.parse(String(init?.body ?? '{}'));
    if (message.method === 'notifications/initialized')
      return new Response(null, { status: 202 });
    let result: any;
    if (message.method === 'initialize')
      result = {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1.0.0' },
      };
    else if (message.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'search',
            inputSchema: drift
              ? { type: 'object', properties: { changed: { type: 'string' } } }
              : plugin.tools[0].inputSchema,
          },
        ],
      };
    else if (message.method === 'tools/call') {
      called++;
      result = { content: [{ type: 'text', text: 'fixture result' }] };
    } else return new Response(null, { status: 405 });
    return Response.json({ jsonrpc: '2.0', id: message.id, result });
  };
  try {
    const context = {
      pluginApproved: true,
      pluginBindings: {
        [plugin.key]: { digest: plugin.digest, epoch: plugin.epoch },
      },
    };
    const success = await gateway.execute(plugin.tools[0].ref, {}, context);
    assert.equal(success.success, true, JSON.stringify(success));
    assert.equal(called, 1);
    drift = true;
    const failure = await gateway.execute(plugin.tools[0].ref, {}, context);
    assert.equal(failure.success, false);
    assert.match(JSON.stringify(failure), /SCHEMA_CHANGED/);
    assert.equal(called, 1);
  } finally {
    globalThis.fetch = original;
  }
});
await test('transaction abort leaves prior state and release records intact', async () => {
  const before = await repo.dump();
  const record = before.releases[0];
  assert(record);
  await assert.rejects(
    repo.restore(before.state.generation, [], [record, record]),
  );
  const after = await repo.dump();
  assert.equal(after.state.generation, before.state.generation);
  assert.equal(after.releases.length, before.releases.length);
  assert.deepEqual(after.state.packages, before.state.packages);
});
await test('declared ZIP expansion limits reject highly compressed oversized files', () => {
  const bomb = zipSync(
    { 'large.txt': new Uint8Array(6 * 1024 ** 2) },
    { level: 9 },
  );
  assert(bomb.length < 100_000);
  assert.throws(() => readArchive(bomb), /ZIP_LIMIT/);
});
await test('500 plugins / 5000 contributed tools publish without collisions and reject atomic replacement conflicts', () => {
  const baseline = process.memoryUsage().heapUsed,
    start = performance.now();
  const packages = Array.from({ length: 500 }, (_, i) => {
    const p = structuredClone(verified) as any;
    p.key = `${verified.manifest.publisher.id}/plugin-${i}`;
    p.manifest.id = `plugin-${i}`;
    p.enabled = true;
    p.epoch = 1;
    p.installedAt = Date.now();
    p.skills = [];
    p.agents = [];
    p.tools = Array.from({ length: 10 }, (_, j) => ({
      ...verified.tools[0],
      id: `tool-${j}`,
      ref: `${p.key}/tool-${j}`,
    }));
    return p;
  });
  applyPluginSnapshot({ generation: 10000, packages });
  assert.equal(
    toolRegistry.getAll().filter((t) => t.metadata.plugin).length,
    5000,
  );
  assert.equal(
    new Set(toolRegistry.getToolIds()).size,
    toolRegistry.getToolIds().length,
  );
  const bad = structuredClone(packages);
  bad[1].tools[0].ref = bad[0].tools[0].ref;
  assert.throws(
    () => applyPluginSnapshot({ generation: 10001, packages: bad }),
    /CONFLICT/,
  );
  assert.equal(getPluginSnapshot().generation, 10000);
  console.log(
    `Catalog benchmark: ${(performance.now() - start).toFixed(1)}ms; heap delta ${((process.memoryUsage().heapUsed - baseline) / 1024 ** 2).toFixed(1)}MiB (Node fixture, not a browser SLA)`,
  );
});
console.log(`${passed} plugin invariant tests passed.`);
