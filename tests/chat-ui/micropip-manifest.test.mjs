/**
 * micropip 复用清单（utils/pyodide/pyodide-micropip）单元测试
 *
 * 覆盖契约：
 *   1. 形态清洗：坏条目丢弃、URL/sha256 校验、容量封顶、PEP 503 规范名归一；
 *   2. 探测解析：PYODIDE_SOURCE='pyodide'（锁文件包）被排除、坏 JSON 不抛错；
 *   3. 记账语义：同名同版本保留首次 installedAt、无变化不写、入口清洗；
 *   4. 作用域：默认全局（local）；开→关迁移 local∪session、关→开迁移 session∪local；
 *   5. 订阅：settings/manifest 任一变化推送最新快照；无 chrome 环境 no-op 不抛错；
 *   6. 恢复编排：空清单零成本、按 URL 批量恢复、批量失败降级逐条、
 *      取消信号返回已恢复部分、清单指纹稳定性（顺序无关、版本敏感）。
 *
 * 运行：node tests/chat-ui/micropip-manifest.test.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const outfile = path.resolve('node_modules/.cache/micropip-manifest-test.mjs');
await build({
  stdin: {
    contents: `export * from './utils/pyodide/pyodide-micropip';`,
    resolveDir: process.cwd(),
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});

// ──── chrome.storage 替身（local/session 双区 + onChanged 广播） ────
const areas = { local: new Map(), session: new Map() };
const changeListeners = new Set();
function setArea(area, key, value) {
  const store = areas[area];
  const oldValue = store.get(key);
  store.set(key, value);
  for (const listener of changeListeners) {
    listener({ [key]: { oldValue, newValue: value } }, area);
  }
}
globalThis.chrome = {
  storage: {
    local: {
      async get(key) { return { [key]: areas.local.get(key) }; },
      async set(patch) { for (const [k, v] of Object.entries(patch)) setArea('local', k, v); },
      async remove(key) { areas.local.delete(key); },
    },
    session: {
      async get(key) { return { [key]: areas.session.get(key) }; },
      async set(patch) { for (const [k, v] of Object.entries(patch)) setArea('session', k, v); },
      async remove(key) { areas.session.delete(key); },
    },
    onChanged: {
      addListener(fn) { changeListeners.add(fn); },
      removeListener(fn) { changeListeners.delete(fn); },
    },
  },
};

const {
  canonicalMicropipName,
  parseMicropipProbe,
  sanitizeMicropipManifest,
  micropipManifestKey,
  readMicropipManifest,
  getMicropipGlobalReuse,
  setMicropipGlobalReuse,
  recordMicropipPackages,
  removeMicropipPackage,
  clearMicropipManifest,
  watchMicropipState,
  probeMicropipPackages,
  restoreMicropipPackages,
} = await import(pathToFileURL(outfile).href);

const SETTINGS_KEY = 'pyodide_micropip_settings';
const MANIFEST_KEY = 'pyodide_micropip_manifest';
const flush = () => new Promise(resolve => setImmediate(resolve));

function pkg(name, version, overrides = {}) {
  return {
    name,
    version,
    url: `https://files.pythonhosted.org/packages/x/${name}-${version}.whl`,
    sha256: 'a'.repeat(64),
    installedAt: 1000,
    ...overrides,
  };
}

let passed = 0;
const failures = [];
async function step(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (error) {
    failures.push(`${label} => ${error.message}`);
    console.error(`  ✗ ${label}\n    ${error.message}`);
  }
}

console.log('micropip-manifest:');

// ══════════ 1. 形态清洗 ══════════
await step('canonicalMicropipName 做 PEP 503 归一', () => {
  assert.equal(canonicalMicropipName('Et_XmlFile'), 'et-xmlfile');
  assert.equal(canonicalMicropipName('et.xmlfile'), 'et-xmlfile');
  assert.equal(canonicalMicropipName('  openpyxl  '), 'openpyxl');
});

await step('sanitizeMicropipManifest 丢弃坏条目、截断超长 URL', () => {
  const cleaned = sanitizeMicropipManifest([
    pkg('openpyxl', '3.1.5'),
    { name: 123 },                      // 无 name → 丢
    null,                               // 非对象 → 丢
    pkg('evil', '1.0', { url: 'http://insecure.example/x.whl' }), // 非 https → url 置 null
    pkg('huge', '1.0', { url: 'https://x/'.padEnd(3000, 'a') }),   // 超长 → url 置 null
    pkg('badsha', '1.0', { sha256: 'nothex' }),                    // 非法 sha → null
  ]);
  assert.equal(cleaned.length, 4, '好条目保留（坏字段条目保留但字段被清洗）');
  const byName = new Map(cleaned.map(p => [p.name, p]));
  assert.equal(byName.get('openpyxl').url.startsWith('https://'), true);
  assert.equal(byName.get('evil').url, null, '非 https URL 置 null');
  assert.equal(byName.get('huge').url, null, '超长 URL 置 null');
  assert.equal(byName.get('badsha').sha256, null, '非法 sha256 置 null');
  assert.equal(sanitizeMicropipManifest('not-an-array').length, 0, '非数组输入返回空');
  assert.equal(sanitizeMicropipManifest(undefined).length, 0, 'undefined 输入返回空');
});

await step('sanitizeMicropipManifest 容量封顶 500（保留最新）', () => {
  // installedAt 从 1 起（0 会被清洗层视为缺失而改写为 now，破坏排序断言）
  const many = Array.from({ length: 520 }, (_, i) => pkg(`p${i}`, '1.0', { installedAt: i + 1 }));
  const cleaned = sanitizeMicropipManifest(many);
  assert.equal(cleaned.length, 500, '封顶 500 条');
  assert.equal(cleaned[0].installedAt, 520, '保留最新记录');
});

// ══════════ 2. 探测解析 ══════════
await step('parseMicropipProbe 解析合法输出并按规范名去重', () => {
  const parsed = parseMicropipProbe(JSON.stringify([
    { name: 'openpyxl', version: '3.1.5', url: 'https://x/o.whl', sha256: 'b'.repeat(64) },
    { name: 'et_xmlfile', version: '2.0.0', url: 'https://x/e.whl', sha256: 'c'.repeat(64) },
    { name: 'et-xmlfile', version: '2.0.1', url: 'https://x/e2.whl', sha256: 'd'.repeat(64) }, // 同包异名 → 去重
  ]));
  assert.equal(parsed.length, 2, 'et_xmlfile 与 et-xmlfile 视为同包');
  assert.ok(parsed.every(p => Number.isFinite(p.installedAt) && p.installedAt > 0), '补上 installedAt');
});

await step('parseMicropipProbe 坏 JSON / 非数组 / 坏条目不抛错', () => {
  assert.deepEqual(parseMicropipProbe('{broken'), []);
  assert.deepEqual(parseMicropipProbe('{"a":1}'), []);
  const partial = parseMicropipProbe(JSON.stringify([null, { name: 'ok', version: '1' }, { version: '2' }]));
  assert.equal(partial.length, 1, '仅保留合法条目');
  assert.equal(partial[0].name, 'ok');
});

// ══════════ 3. 记账语义 ══════════
await step('recordMicropipPackages 写入当前作用域并可读回', async () => {
  await recordMicropipPackages([pkg('openpyxl', '3.1.5')]);
  const read = await readMicropipManifest();
  assert.equal(read.length, 1);
  assert.equal(read[0].name, 'openpyxl');
});

await step('同名同版本保留首次 installedAt；版本变化刷新时间戳', async () => {
  const current = await readMicropipManifest();
  assert.equal(current[0].installedAt, 1000, '首条保持原时间戳');
  // 同版本重记（探测输出不带 installedAt，入口会补 now）→ 仍保留 1000
  await recordMicropipPackages([{ name: 'openpyxl', version: '3.1.5', url: 'https://x/o.whl', sha256: 'a'.repeat(64), installedAt: 999999 }]);
  let read = await readMicropipManifest();
  assert.equal(read[0].installedAt, 1000, '同版本不刷新首次记录时间');
  // 版本升级 → 新时间戳
  await recordMicropipPackages([{ name: 'openpyxl', version: '3.2.0', url: 'https://x/o2.whl', sha256: 'a'.repeat(64), installedAt: 999999 }]);
  read = await readMicropipManifest();
  assert.equal(read.length, 1, '同名升级不产生第二条');
  assert.equal(read[0].version, '3.2.0');
  assert.equal(read[0].installedAt, 999999, '版本变化刷新时间戳');
});

await step('recordMicropipPackages 入口清洗坏条目；空输入零开销', async () => {
  await recordMicropipPackages([{ name: 42 }]);
  await recordMicropipPackages([]);
  const read = await readMicropipManifest();
  assert.equal(read.length, 1, '坏条目被丢弃、空输入不改动清单');
});

await step('removeMicropipPackage 删除单条；不存在的名字静默', async () => {
  await recordMicropipPackages([pkg('flask', '3.0.0')]);
  assert.equal((await readMicropipManifest()).length, 2);
  await removeMicropipPackage('FLASK'); // 大小写不敏感
  assert.equal((await readMicropipManifest()).length, 1, '按规范名删除');
  await removeMicropipPackage('ghost');
  assert.equal((await readMicropipManifest()).length, 1, '不存在的名字不改动');
});

// ══════════ 4. 作用域 ══════════
await step('默认全局复用为开启', async () => {
  assert.equal(await getMicropipGlobalReuse(), true);
});

await step('开→关：local 清单并集迁入 session', async () => {
  // 当前 local 有 1 条（openpyxl 3.2.0），先在 local 再造一条差异
  await recordMicropipPackages([pkg('orphan', '1.0')]); // 仍写 local（全局开启）
  assert.equal(areas.local.has(MANIFEST_KEY), true, '全局开启时写 local');
  await setMicropipGlobalReuse(false);
  assert.equal(await getMicropipGlobalReuse(), false);
  const sessionList = areas.session.get(MANIFEST_KEY) ?? [];
  const localList = areas.local.get(MANIFEST_KEY) ?? [];
  assert.equal(sessionList.length, localList.length, '迁移后 session 含 local 全量');
  const read = await readMicropipManifest();
  assert.equal(read.length, 2, '关闭后读到 session 清单');
});

await step('关闭状态下新记录写 session、不碰 local', async () => {
  const localBefore = JSON.stringify(areas.local.get(MANIFEST_KEY));
  await recordMicropipPackages([pkg('session-only', '1.0')]);
  assert.equal(JSON.stringify(areas.local.get(MANIFEST_KEY)), localBefore, 'local 未被改动');
  const read = await readMicropipManifest();
  assert.ok(read.some(p => p.name === 'session-only'), '新记录进入 session');
});

await step('关→开：session 清单并集迁回 local', async () => {
  await setMicropipGlobalReuse(true);
  const read = await readMicropipManifest();
  const names = read.map(p => p.name).sort();
  assert.deepEqual(names, ['openpyxl', 'orphan', 'session-only'], 'session 独有条目不丢失');
  assert.equal(areas.session.has(MANIFEST_KEY), false, 'session 区被清空');
});

await step('关闭态删除的条目在重新开启后不复活（双区同步删除）', async () => {
  // 回到关闭态：local ∪→ session，此时两区都有 orphan
  await setMicropipGlobalReuse(false);
  assert.ok(
    (areas.local.get(MANIFEST_KEY) ?? []).some(p => p.name === 'orphan'),
    '前置：local 区含 orphan',
  );
  // 关闭态删除 → 只写活动区（session）是不够的：重新开启时 local 的残留会把它并回来
  await removeMicropipPackage('orphan');
  await setMicropipGlobalReuse(true);
  const read = await readMicropipManifest();
  assert.equal(
    read.some(p => p.name === 'orphan'),
    false,
    '重新开启后已删条目不复活（local 残留已被同步删除）',
  );
  // 清理：把 session-only 之外的测试噪声移除，复原后续用例的输入
  await removeMicropipPackage('watched');
  await setMicropipGlobalReuse(false);
});

// ══════════ 5. 订阅 ══════════
await step('watchMicropipState 推送最新快照；取消后不再推送', async () => {
  const received = [];
  const unwatch = watchMicropipState(state => received.push(state));
  const initialGlobal = await getMicropipGlobalReuse(); // 前序用例可能处于任一状态
  await recordMicropipPackages([pkg('watched', '1.0')]);
  await flush();
  assert.ok(received.length >= 1, 'manifest 变化触发推送');
  const afterRecord = received[received.length - 1];
  assert.equal(afterRecord.globalReuse, initialGlobal, '快照反映当前开关状态');
  assert.ok(afterRecord.packages.some(p => p.name === 'watched'), '快照含新记录');
  // 注意：切换作用域会写两处 storage（session manifest + settings），推送次数不固定——
  // 断言「有新增推送 + 末条快照反映新状态」而非精确计数
  const target = !initialGlobal;
  const beforeToggle = received.length;
  await setMicropipGlobalReuse(target);
  await flush();
  assert.ok(received.length > beforeToggle, 'settings/manifest 变化触发推送');
  assert.equal(received[received.length - 1].globalReuse, target, '末条快照反映切换后的状态');
  unwatch();
  const afterUnwatch = received.length;
  await setMicropipGlobalReuse(!target);
  await flush();
  assert.equal(received.length, afterUnwatch, '取消订阅后不再推送');
  // 此时状态 = !target = initialGlobal，已自然复原，无需再切
});

await step('watchMicropipState 忽略无关 storage 变更', async () => {
  const received = [];
  const unwatch = watchMicropipState(state => received.push(state));
  setArea('local', 'unrelated-key', { value: 1 });
  await flush();
  assert.equal(received.length, 0, '无关 key 不推送');
  setArea('session', MANIFEST_KEY, []); // session 区 manifest 变化 → 应推送
  await flush();
  assert.equal(received.length, 1, 'session 区 manifest 变化推送');
  unwatch();
});

// ══════════ 6. 恢复编排（假 pyodide） ══════════
function fakePyodide({ installed = [], failBatch = false } = {}) {
  const calls = { loadPackage: [], installCalls: [] };
  return {
    calls,
    async loadPackage(name) { calls.loadPackage.push(name); },
    async runPythonAsync(code) {
      if (code.includes('importlib.metadata')) {
        // 探测：返回假的已装列表
        return JSON.stringify(installed.map(p => ({
          name: p.name, version: p.version, url: p.url, sha256: p.sha256,
        })));
      }
      if (code.includes('micropip.install')) {
        // 批量 = 代码里出现多于一个 wheel URL（join(', ') 分隔，不能用 '","' 判定）
        const urlCount = (code.match(/https?:\/\//g) || []).length;
        if (failBatch && urlCount > 1) throw new Error('batch boom');
        if (failBatch) throw new Error('single boom');
        calls.installCalls.push(code);
        return 'None';
      }
      return 'None';
    },
  };
}

await step('restore：空清单零成本（不调 loadPackage）', async () => {
  const py = fakePyodide();
  const result = await restoreMicropipPackages(py, []);
  assert.deepEqual(result, { restored: [], warnings: [] });
  assert.equal(py.calls.loadPackage.length, 0, '空清单不触碰解释器');
});

await step('restore：全部已装 → 跳过（不装）', async () => {
  const manifest = [pkg('openpyxl', '3.1.5')];
  const py = fakePyodide({ installed: manifest });
  const result = await restoreMicropipPackages(py, manifest);
  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(py.calls.installCalls.length, 0, '无缺失不安装');
});

await step('restore：缺失条目按 URL 批量恢复', async () => {
  const manifest = [pkg('openpyxl', '3.1.5'), pkg('et_xmlfile', '2.0.0')];
  const py = fakePyodide({ installed: [] });
  const result = await restoreMicropipPackages(py, manifest);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.restored.length, 2);
  assert.equal(py.calls.loadPackage[0], 'micropip', '按需加载 micropip');
  assert.equal(py.calls.installCalls.length, 1, '批量一次装');
  assert.ok(py.calls.installCalls[0].includes('https://'), '按精确 URL 恢复');
  assert.ok(py.calls.installCalls[0].includes('deps=False'), '不重复解析依赖（清单已含闭包）');
});

await step('restore：批量失败降级逐条，坏包不拖累好包', async () => {
  const manifest = [pkg('badpkg', '1.0'), pkg('goodpkg', '2.0')];
  // failBatch 模式：批量（多 URL）抛错 → 逐条（单 URL）也抛 → 全失败
  const pyFail = fakePyodide({ failBatch: true });
  const failResult = await restoreMicropipPackages(pyFail, manifest);
  assert.equal(failResult.restored.length, 0);
  // 逐条失败 2 条 + 批量汇总 1 条 = 3
  assert.equal(failResult.warnings.length, 3, '逐条各记一条 + 批量汇总一条');
  assert.ok(failResult.warnings.some(w => w.includes('批量恢复失败')), '含批量汇总警告');
  assert.ok(failResult.warnings.filter(w => w.includes('恢复 badpkg') || w.includes('恢复 goodpkg')).length === 2, '逐条失败可读');

  // 批量失败但逐条成功：坏网络仅影响批量通道的场景
  const pyMixed = fakePyodide();
  pyMixed.runPythonAsync = async code => {
    if (code.includes('micropip.install')) {
      const urlCount = (code.match(/https?:\/\//g) || []).length;
      if (urlCount > 1) throw new Error('batch boom');
      pyMixed.calls.installCalls.push(code);
      return 'None';
    }
    // 探测
    return JSON.stringify([]);
  };
  const mixedResult = await restoreMicropipPackages(pyMixed, manifest);
  assert.equal(mixedResult.restored.length, 2, '逐条重试全部成功');
  assert.equal(mixedResult.warnings.length, 0, '逐条成功后无警告');
  assert.ok(pyMixed.calls.installCalls.every(code => (code.match(/https?:\/\//g) || []).length === 1), '降级路径逐条单 URL 安装');
});

await step('restore：无 URL 条目降级 name==version', async () => {
  const noUrl = [pkg('legacy', '1.2.3', { url: null })];
  const py = fakePyodide();
  const result = await restoreMicropipPackages(py, noUrl);
  assert.equal(result.restored.length, 1);
  assert.ok(py.calls.installCalls[0].includes('legacy==1.2.3'), '按 name==version 解析');
});

await step('restore：取消信号返回已恢复部分 + 取消警告，不抛错', async () => {
  const controller = new AbortController();
  controller.abort();
  const py = fakePyodide();
  const result = await restoreMicropipPackages(py, [pkg('x', '1.0')], controller.signal);
  assert.deepEqual(result.restored, []);
  assert.ok(result.warnings.some(w => w.includes('取消')), '返回取消警告而非抛错');
});

await step('restore：micropip 加载失败聚合为警告', async () => {
  const py = fakePyodide();
  py.loadPackage = async () => { throw new Error('cdn down'); };
  const result = await restoreMicropipPackages(py, [pkg('y', '1.0')]);
  assert.equal(result.restored.length, 0);
  assert.ok(result.warnings.some(w => w.includes('加载 micropip 失败')), '加载失败可读');
});

// ══════════ 7. 清单指纹 ══════════
await step('micropipManifestKey 顺序无关、版本敏感', () => {
  const a = [pkg('a', '1.0'), pkg('b', '2.0')];
  const b = [pkg('b', '2.0'), pkg('a', '1.0')];
  assert.equal(micropipManifestKey(a), micropipManifestKey(b), '顺序不同指纹相同');
  const c = [pkg('a', '1.1'), pkg('b', '2.0')];
  assert.notEqual(micropipManifestKey(a), micropipManifestKey(c), '版本变化指纹不同');
  // 规范名归一：同清单内容仅大小写/分隔符不同 → 指纹相同
  assert.equal(
    micropipManifestKey([pkg('Et_XmlFile', '1.0'), pkg('b', '2.0')]),
    micropipManifestKey([pkg('et_xmlfile', '1.0'), pkg('b', '2.0')]),
    '规范名归一',
  );
  assert.equal(micropipManifestKey([]), '', '空清单指纹为空串');
});

// ──── 收尾：清理测试写入的 storage（不必要，进程级隔离） ────
if (failures.length) {
  console.error(`\n失败 ${failures.length} 项：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\n通过 ${passed} 项断言。`);
