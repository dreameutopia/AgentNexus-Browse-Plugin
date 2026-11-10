// 打包管理中心「使用监控 + Python 环境」预览入口
// （.vue SFC 经 compiler-sfc 编译 + 真实渲染器全链路）
// 产物落在 node_modules/.cache（仓库内缓存目录，天然被 git 忽略），不进版本库
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { parse, compileScript } from '@vue/compiler-sfc';

const root = process.cwd();
const outDir = path.join(root, 'node_modules', '.cache');
fs.mkdirSync(outDir, { recursive: true });

// ── 桩：用量统计引擎（模拟一份已水合的快照） ──
const USAGE_STUB = `
const listeners = new Set();

const counters = {
  cacheHitRequests: 62,
  cacheObservedRequests: 104,
  continuationInputTokens: 402000,
  continuationCachedTokens: 261000,
  continuationCacheRequests: 33,
  requests: 128,
  success: 119,
  failed: 6,
  aborted: 3,
  inputTokens: 1250000,
  outputTokens: 318000,
  totalTokens: 1568000,
  cachedInputTokens: 486000,
  cacheReportedRequests: 104,
  cacheEligibleInputTokens: 902000,
  reasoningTokens: 46500,
};

const models = [
  { provider: 'openai', model: 'gpt-4.1', requests: 46, success: 44, failed: 1, aborted: 1,
    inputTokens: 612000, outputTokens: 168000, totalTokens: 780000, cachedInputTokens: 302000,
    cacheEligibleInputTokens: 470000, cacheHitRequests: 28, cacheObservedRequests: 38,
    continuationInputTokens: 214000, continuationCachedTokens: 148000, continuationCacheRequests: 18,
    reasoningTokens: 21000, channelId: 'ch-openai', channelLabel: 'OpenAI 官方', agentId: '网页调研助手',
    lastUsedAt: Date.now() - 60000 },
  { provider: 'anthropic', model: 'claude-sonnet-4.5', requests: 38, success: 36, failed: 2, aborted: 0,
    inputTokens: 402000, outputTokens: 96000, totalTokens: 498000, cachedInputTokens: 142000,
    cacheEligibleInputTokens: 288000, cacheHitRequests: 21, cacheObservedRequests: 31,
    continuationInputTokens: 118000, continuationCachedTokens: 76000, continuationCacheRequests: 11,
    reasoningTokens: 25500, channelId: 'ch-anthropic', channelLabel: 'Anthropic 官方', agentId: '网页调研助手',
    lastUsedAt: Date.now() - 240000 },
  { provider: 'openai', model: 'gpt-4.1-mini', requests: 27, success: 26, failed: 0, aborted: 1,
    inputTokens: 158000, outputTokens: 31000, totalTokens: 189000, cachedInputTokens: 42000,
    cacheEligibleInputTokens: 96000, cacheHitRequests: 13, cacheObservedRequests: 24,
    continuationInputTokens: 70000, continuationCachedTokens: 37000, continuationCacheRequests: 4,
    reasoningTokens: 0, channelId: 'ch-openai', channelLabel: 'OpenAI 官方', agentId: '',
    lastUsedAt: Date.now() - 900000 },
  { provider: 'gemini', model: 'gemini-2.5-pro', requests: 17, success: 13, failed: 3, aborted: 1,
    inputTokens: 78000, outputTokens: 23000, totalTokens: 101000, cachedInputTokens: 0,
    cacheEligibleInputTokens: 48000, cacheHitRequests: 0, cacheObservedRequests: 11,
    continuationInputTokens: 0, continuationCachedTokens: 0, continuationCacheRequests: 0,
    reasoningTokens: 0, channelId: 'ch-gemini', channelLabel: 'Gemini 中转', agentId: '数据整理',
    lastUsedAt: Date.now() - 3600000 },
];

const scopes = [
  { provider: 'openai', model: 'gpt-4.1', requestKind: 'chat', channelId: 'ch-openai', channelLabel: 'OpenAI 官方', agentId: '网页调研助手',
    requests: 31, success: 30, failed: 0, aborted: 1, inputTokens: 430000, outputTokens: 118000, totalTokens: 548000,
    cachedInputTokens: 226000, cacheEligibleInputTokens: 318000, cacheHitRequests: 19, cacheObservedRequests: 26,
    continuationInputTokens: 150000, continuationCachedTokens: 102000, continuationCacheRequests: 12, lastUsedAt: Date.now() - 60000 },
  { provider: 'anthropic', model: 'claude-sonnet-4.5', requestKind: 'chat', channelId: 'ch-anthropic', channelLabel: 'Anthropic 官方', agentId: '网页调研助手',
    requests: 28, success: 27, failed: 1, aborted: 0, inputTokens: 296000, outputTokens: 74000, totalTokens: 370000,
    cachedInputTokens: 104000, cacheEligibleInputTokens: 208000, cacheHitRequests: 16, cacheObservedRequests: 23,
    continuationInputTokens: 86000, continuationCachedTokens: 57000, continuationCacheRequests: 9, lastUsedAt: Date.now() - 240000 },
  { provider: 'openai', model: 'gpt-4.1-mini', requestKind: 'chat', channelId: 'ch-openai', channelLabel: 'OpenAI 官方', agentId: '',
    requests: 27, success: 26, failed: 0, aborted: 1, inputTokens: 158000, outputTokens: 31000, totalTokens: 189000,
    cachedInputTokens: 42000, cacheEligibleInputTokens: 96000, cacheHitRequests: 13, cacheObservedRequests: 24,
    continuationInputTokens: 70000, continuationCachedTokens: 37000, continuationCacheRequests: 4, lastUsedAt: Date.now() - 900000 },
  { provider: 'gemini', model: 'gemini-2.5-pro', requestKind: 'chat', channelId: 'ch-gemini', channelLabel: 'Gemini 中转', agentId: '数据整理',
    requests: 17, success: 13, failed: 3, aborted: 1, inputTokens: 78000, outputTokens: 23000, totalTokens: 101000,
    cachedInputTokens: 0, cacheEligibleInputTokens: 48000, cacheHitRequests: 0, cacheObservedRequests: 11,
    continuationInputTokens: 0, continuationCachedTokens: 0, continuationCacheRequests: 0, lastUsedAt: Date.now() - 3600000 },
];

const recentRequests = [
  { at: Date.now() - 60000, provider: 'openai', model: 'gpt-4.1', kind: 'chat', outcome: 'success', channelId: 'ch-openai', channelLabel: 'OpenAI 官方', agentId: '网页调研助手', runId: 'run-8f2c1a90d3', iteration: 3, prefixChanged: false, trimmed: false, compacted: false, usage: { inputTokens: 18400, outputTokens: 3200, cachedInputTokens: 9600, totalTokens: 21600 } },
  { at: Date.now() - 240000, provider: 'anthropic', model: 'claude-sonnet-4.5', kind: 'chat', outcome: 'success', channelId: 'ch-anthropic', channelLabel: 'Anthropic 官方', agentId: '网页调研助手', runId: 'run-8f2c1a90d3', iteration: 2, prefixChanged: true, trimmed: true, compacted: false, usage: { inputTokens: 9600, outputTokens: 1400, cachedInputTokens: 4200, totalTokens: 11000 } },
  { at: Date.now() - 300000, provider: 'gemini', model: 'gemini-2.5-pro', kind: 'chat', outcome: 'failed', channelId: 'ch-gemini', channelLabel: 'Gemini 中转', agentId: '数据整理', runId: 'run-77ab4410ce', iteration: 1, prefixChanged: false, trimmed: false, compacted: false, usage: { inputTokens: 1200, outputTokens: 0, totalTokens: 1200 } },
  { at: Date.now() - 620000, provider: 'openai', model: 'gpt-4.1-mini', kind: 'chat', outcome: 'success', channelId: 'ch-openai', channelLabel: 'OpenAI 官方', agentId: '', runId: 'run-5c19d0aa62', iteration: 1, prefixChanged: false, trimmed: false, compacted: false, usage: { inputTokens: 3400, outputTokens: 900, cachedInputTokens: 0, totalTokens: 4300 } },
  { at: Date.now() - 900000, provider: 'openai', model: 'gpt-4.1-mini', kind: 'probe', outcome: 'success', channelId: 'ch-openai', channelLabel: 'OpenAI 官方', agentId: '', iteration: 1, usage: { inputTokens: 120, outputTokens: 0, totalTokens: 120 } },
  { at: Date.now() - 1500000, provider: 'anthropic', model: 'claude-sonnet-4.5', kind: 'chat', outcome: 'aborted', channelId: 'ch-anthropic', channelLabel: 'Anthropic 官方', agentId: '网页调研助手', runId: 'run-2be9077fd1', iteration: 4, prefixChanged: false, trimmed: false, compacted: true, usage: { inputTokens: 7600, outputTokens: 0, cachedInputTokens: 3100, totalTokens: 7600 } },
];

const recentErrors = [
  { at: Date.now() - 300000, provider: 'gemini', model: 'gemini-2.5-pro', kind: 'chat', summary: 'HTTP 429：上游限流，已自动重试 2 次后放弃' },
  { at: Date.now() - 2200000, provider: 'anthropic', model: 'claude-sonnet-4.5', kind: 'chat', summary: '流中断：连接在收到完成事件前被重置' },
  { at: Date.now() - 5400000, provider: 'openai', model: 'gpt-4.1', kind: 'chat', summary: '请求超时（120s）：模型响应过慢' },
];

function buildSnapshot() {
  return {
    scopes: JSON.parse(JSON.stringify(scopes)),
    recentRequests: JSON.parse(JSON.stringify(recentRequests)),
    schemaVersion: 2,
    startedAt: Date.now() - 86400000 * 3,
    updatedAt: Date.now(),
    totals: Object.assign({}, counters),
    models: JSON.parse(JSON.stringify(models)).map(m => ({ ...m, share: 0 })),
    recentErrors: JSON.parse(JSON.stringify(recentErrors)),
    hydrated: true,
  };
}

let snapshot = buildSnapshot();

export const aiUsageMetrics = {
  getSnapshot() { return snapshot; },
  subscribe(listener) {
    listeners.add(listener);
    listener(snapshot);
    return () => listeners.delete(listener);
  },
  reset() {
    snapshot = buildSnapshot();
    snapshot.totals = { ...counters, requests: 0, success: 0, failed: 0, aborted: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 };
    snapshot.models = [];
    snapshot.scopes = [];
    snapshot.recentRequests = [];
    snapshot.recentErrors = [];
    listeners.forEach(l => l(snapshot));
  },
};
`;

// ── 桩：协议驱动注册表（只保留展示名） ──
const DRIVER_STUB = `
const LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  ollama: 'Ollama',
  openai_responses: 'OpenAI Responses',
};
export const driverRegistry = {
  tryGet(id) {
    return LABELS[id] ? { meta: { label: LABELS[id] } } : undefined;
  },
};
`;

// ── 桩：Pyodide 全家桶（模拟已就绪环境 + 目录 + 安装结果） ──
const PYODIDE_STUB = `
export const PYODIDE_VERSION = '0.28.3';
export const PYODIDE_CORE_FILES = [
  { label: 'python_stdlib.zip', url: 'https://cdn.jsdelivr.net/pyodide/v0.28.3/full/python_stdlib.zip', contentType: 'application/zip' },
  { label: 'python311.wasm', url: 'https://cdn.jsdelivr.net/pyodide/v0.28.3/full/python311.wasm', contentType: 'application/wasm' },
  { label: 'pyodide.asm.wasm', url: 'https://cdn.jsdelivr.net/pyodide/v0.28.3/full/pyodide.asm.wasm', contentType: 'application/wasm' },
];
export const PYODIDE_FEATURED_PACKAGES = ['numpy', 'pandas', 'scikit-learn', 'matplotlib', 'requests', 'pillow'];
export const DEFAULT_PYODIDE_ENV_STATE = { status: 'idle', pythonVersion: '', version: PYODIDE_VERSION, verifiedAt: 0, packages: [], lastError: '', skillScriptsEnabled: false };

let envState = {
  status: 'ready',
  pythonVersion: '3.14.0',
  version: PYODIDE_VERSION,
  verifiedAt: Date.now() - 3600000,
  skillScriptsEnabled: false,
  packages: [
    { name: 'numpy', version: '2.3.1' },
    { name: 'pandas', version: '2.3.0' },
  ],
  lastError: '',
};
const envListeners = new Set();

export async function getPyodideEnvState() { return JSON.parse(JSON.stringify(envState)); }
export async function updatePyodideEnvState(patch) {
  envState = { ...envState, ...patch };
  envListeners.forEach(l => l(JSON.parse(JSON.stringify(envState))));
  return JSON.parse(JSON.stringify(envState));
}
export function watchPyodideEnv(listener) {
  envListeners.add(listener);
  return () => envListeners.delete(listener);
}
export async function setSkillScriptsEnabled(enabled) {
  if (enabled && envState.status !== 'ready') throw new Error('Python runtime is not ready');
  envState = { ...envState, skillScriptsEnabled: enabled };
  envListeners.forEach(l => l(JSON.parse(JSON.stringify(envState))));
  return JSON.parse(JSON.stringify(envState));
}
export async function isSkillScriptSupportEnabled() { return !!envState.skillScriptsEnabled; }
export async function ensurePyodideRuntime() { return {}; }
export async function verifyPyodideRuntime() { return { pythonVersion: '3.14.0', implementation: 'CPython', checksumOk: true }; }
export async function clearFiles() { envState = { ...DEFAULT_PYODIDE_ENV_STATE }; }
export async function purgePyodideEnvironment() {
  await clearFiles();
  await clearMicropipManifest();
  await updatePyodideEnvState({ ...DEFAULT_PYODIDE_ENV_STATE, skillScriptsEnabled: false });
}
export async function downloadPyodideFile() {}
export async function listFileMeta() {
  return [
    { name: 'python_stdlib.zip', size: 5242880 },
    { name: 'python311.wasm', size: 6815744 },
    { name: 'pyodide.asm.wasm', size: 3145728 },
  ];
}
export async function runPythonCode(code) {
  return {
    ok: true,
    stdout: '{\\n  "python": "3.14.0",\\n  "sum_1_to_100": 5050\\n}',
    stderr: '',
    result: "{'python': '3.14.0', 'sum_1_to_100': 5050}",
    durationMs: 412,
    timedOut: false,
    errorName: '',
    errorDetail: '',
  };
}
export async function getPackageCatalog() {
  return [
    { name: 'numpy', version: '2.3.1', fileName: 'numpy-2.3.1.whl', imports: ['numpy'], depends: [], sha256: 'a'.repeat(64) },
    { name: 'pandas', version: '2.3.0', fileName: 'pandas-2.3.0.whl', imports: ['pandas'], depends: ['numpy'], sha256: 'b'.repeat(64) },
    { name: 'scikit-learn', version: '1.6.1', fileName: 'scikit_learn-1.6.1.whl', imports: ['sklearn'], depends: ['numpy', 'scipy'], sha256: 'c'.repeat(64) },
    { name: 'matplotlib', version: '3.9.2', fileName: 'matplotlib-3.9.2.whl', imports: ['matplotlib', 'plt'], depends: ['numpy'], sha256: 'd'.repeat(64) },
    { name: 'requests', version: '2.32.3', fileName: 'requests-2.32.3.whl', imports: ['requests'], depends: [], sha256: 'e'.repeat(64) },
    { name: 'pillow', version: '11.0.0', fileName: 'pillow-11.0.0.whl', imports: ['PIL', 'Image'], depends: [], sha256: 'f'.repeat(64) },
    { name: 'scipy', version: '1.14.1', fileName: 'scipy-1.14.1.whl', imports: ['scipy'], depends: ['numpy'], sha256: '1'.repeat(64) },
    { name: 'beautifulsoup4', version: '4.12.3', fileName: 'beautifulsoup4-4.12.3.whl', imports: ['bs4'], depends: [], sha256: '2'.repeat(64) },
    { name: 'lxml', version: '5.3.0', fileName: 'lxml-5.3.0.whl', imports: ['lxml'], depends: [], sha256: '3'.repeat(64) },
  ];
}
export async function installPackages(names) {
  return names.map(name => ({ name, version: '1.0.0' }));
}
export async function uninstallPackages() {}

// ── 批量预下载（模拟：进度打满 + 200ms 延迟让进度条可见） ──
export const PYODIDE_CDN_BASE = 'https://cdn.example/pyodide/full/';
export async function preloadWheels(items, options) {
  const total = items.length;
  for (let i = 1; i <= total; i++) {
    await new Promise(resolve => setTimeout(resolve, 40));
    options?.onProgress?.({ done: i, total, bytes: i * 1024 * 512, current: items[i - 1]?.name ?? '' });
  }
  return { succeeded: total, cached: Math.min(2, total), downloaded: Math.max(0, total - 2), bytes: total * 1024 * 512, failures: [], cancelled: false };
}

// ── micropip 复用清单 ──
let micropipState = {
  globalReuse: true,
  packages: [
    { name: 'openpyxl', version: '3.1.5', url: 'https://x/openpyxl.whl', sha256: '4'.repeat(64), installedAt: Date.now() - 86400000 },
    { name: 'et_xmlfile', version: '2.0.0', url: 'https://x/et_xmlfile.whl', sha256: '5'.repeat(64), installedAt: Date.now() - 86400000 },
  ],
};
const micropipListeners = new Set();
function emitMicropip() { micropipListeners.forEach(l => l(JSON.parse(JSON.stringify(micropipState)))); }
export async function readMicropipManifest() { return JSON.parse(JSON.stringify(micropipState.packages)); }
export async function getMicropipGlobalReuse() { return micropipState.globalReuse; }
export async function setMicropipGlobalReuse(v) { micropipState = { ...micropipState, globalReuse: v }; emitMicropip(); }
export async function removeMicropipPackage(name) { micropipState = { ...micropipState, packages: micropipState.packages.filter(p => p.name !== name) }; emitMicropip(); }
export async function clearMicropipManifest() { micropipState = { ...micropipState, packages: [] }; emitMicropip(); }
export function watchMicropipState(listener) { micropipListeners.add(listener); return () => micropipListeners.delete(listener); }
`;

await build({
  entryPoints: [path.join(root, '.preview/hub-usage-python.ts')],
  outfile: path.join(outDir, 'hub-usage-python.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  loader: { '.css': 'empty' },
  logLevel: 'info',
  plugins: [
    {
      name: 'vue-sfc',
      setup(api) {
        api.onResolve({ filter: /\.vue$/ }, args => ({ path: path.resolve(args.resolveDir, args.path), namespace: 'vue-sfc' }));
        api.onLoad({ filter: /.*/, namespace: 'vue-sfc' }, args => {
          const { descriptor } = parse(fs.readFileSync(args.path, 'utf8'), { filename: args.path });
          const script = compileScript(descriptor, { id: 'hub-usage-python', inlineTemplate: true });
          return { contents: script.content, loader: 'ts', resolveDir: path.dirname(args.path) };
        });
      },
    },
    {
      name: 'preview-stubs',
      setup(api) {
        // 用量统计引擎
        api.onResolve({ filter: /usage-metrics-engine$/ }, () => ({ path: 'usage-stub', namespace: 'preview-stub' }));
        // 协议驱动注册表
        api.onResolve({ filter: /stream\/driver-registry$/ }, () => ({ path: 'driver-stub', namespace: 'preview-stub' }));
        // Pyodide 全家桶（配置 / 下载 / 缓存 / 环境 / 运行时 / 桶文件）
        api.onResolve({ filter: /pyodide/ }, () => ({ path: 'pyodide-stub', namespace: 'preview-stub' }));
        api.onLoad({ filter: /^usage-stub$/, namespace: 'preview-stub' }, () => ({ contents: USAGE_STUB, loader: 'ts' }));
        api.onLoad({ filter: /^driver-stub$/, namespace: 'preview-stub' }, () => ({ contents: DRIVER_STUB, loader: 'ts' }));
        api.onLoad({ filter: /^pyodide-stub$/, namespace: 'preview-stub' }, () => ({ contents: PYODIDE_STUB, loader: 'ts' }));
      },
    },
    {
      name: 'alias-at',
      setup(api) {
        api.onResolve({ filter: /^@\// }, args => {
          const base = path.join(root, args.path.slice(2));
          for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { path: candidate };
          }
          return { path: base };
        });
      },
    },
  ],
});
