/**
 * Pyodide 运行时管理器（扩展页 / 专用 Worker · 混合加载核心）
 *
 * ==================== 加载架构 ====================
 *
 * 「空壳引子」（随扩展打包，经 Vite 懒加载 chunk）：
 *   pyodide.mjs 加载器 + pyodide.asm.mjs Emscripten 胶水 + pyodide-lock.json
 *   → 全部为本地 JS/JSON，满足 MV3 script-src 'self'；
 *
 * 「重型载荷」（用户显式触发下载，缓存进 IndexedDB）：
 *   pyodide.asm.wasm（约 9.4MB）+ python_stdlib.zip（约 2.5MB）+ 各包 wheel
 *   → 以 URL 为键缓存；所有可执行 JS 仍来自包内，wasm 编译依赖
 *     CSP 的 'wasm-unsafe-eval'（MV3 明确允许）。
 *
 * ==================== 关键机制 ====================
 *
 * 1. fetch 拦截（严格前缀限定）：pyodide 加载器在浏览器中所有资源获取
 *    （wasm / stdlib / 锁文件 / wheel）都走全局 fetch。启动前对
 *    globalThis.fetch 做一次包装：命中缓存 URL → 直接以 IndexedDB 字节
 *    构造 Response（零网络、断网可用）；未命中 → 原生 fetch 并对允许
 *    来源做写透缓存（wheel 下载后自动沉淀，二次免下载）。
 *    模型 API / SSE 流等其它 URL 不受任何影响。
 * 2. createPyodideModule：把打包在包内的 Emscripten 模块工厂直接传入
 *    loadPyodide，跳过加载器对 `${indexURL}pyodide.asm.mjs` 的动态
 *    import()（扩展 CSP 禁止远程脚本，这是官方推荐的替代通道）。
 * 3. 锁文件本地化：lockFileContents 传入打包的 pyodide-lock.json，
 *    packageBaseUrl 指向 CDN——包解析零网络，wheel 下载自带 sha256
 *    子资源完整性校验（原生 fetch 的 integrity 语义）。
 * 4. 超时中断：SharedArrayBuffer 中断缓冲区 + 打包的
 *    py-interrupt-worker.js（另一线程超时写入 2/SIGINT），CPython 在
 *    字节码循环中轮询并抛出 KeyboardInterrupt——纯 JS 计时器在 Python
 *    死循环期间无法触发，这是官方唯一可行的中断方案。
 * 5. 执行串行化：单一解释器实例，runCode 经 Promise 链排队，
 *    并发工具调用不会交叉污染 stdout 捕获。
 *
 * ==================== 生命周期 ====================
 *
 * - 管理中心使用页面运行时。聊天运行由离屏宿主管理专用 Worker，
 *   Worker 可独立回收，IndexedDB 中的会话工作区与运行时缓存继续保留。
 * - 无法原地"卸载"wasm 实例；uninstallPackages 仅更新清单与缓存，
 *   当前实例中模块残留至下次重载（已在 UI 中说明）。
 * - 彻底删除走 purgePyodideEnvironment：清缓存 + 清 micropip 清单 +
 *   状态回落 + 丢弃本页单例 + 通知离屏宿主回收 Worker，五步齐下方无遗漏。
 */

import type { PyodideInterface } from 'pyodide';
import {
  PYODIDE_CACHE_FILE_MAX_BYTES,
  PYODIDE_CACHEABLE_URL_PREFIXES,
  PYODIDE_CDN_BASE,
  PYODIDE_OUTPUT_CAP_BYTES,
  PYODIDE_PYTHON_VERSION,
  PYTHON_RUN_DEFAULT_TIMEOUT_MS,
  PYTHON_RUN_MAX_TIMEOUT_MS,
} from './pyodide-config';
import { clearFiles, deleteFile, getFile, putFile } from './pyodide-cache';
import {
  getPyodideEnvState,
  updatePyodideEnvIfCurrent,
  resetPyodideEnvState,
  withPyodideEnvLock,
  watchPyodideEnv,
  type PyodideInstalledPackage,
  type PyodideEnvState,
} from './pyodide-env';
import { stagePythonWorkspace, withPythonWorkspace, WorkspaceRuntimeError } from '@/utils/python-workspace/python-filesystem';
import type { WorkspaceEntry, WorkspaceSnapshot } from '@/utils/python-workspace/paths';
import { pythonWorkerGlobals } from './python-worker-globals';
import {
  clearMicropipManifest,
  micropipManifestKey,
  probeMicropipPackages,
  readMicropipManifest,
  recordMicropipPackages,
  restoreMicropipPackages,
  type MicropipPackage,
} from './pyodide-micropip';

interface WorkerScriptExecution {
  preflight: boolean;
  run: (pyodide: PyodideInterface, loadImports: (source: string) => Promise<void>, signal?: AbortSignal) => Promise<void>;
}

// ==================== 错误码（调用方可 grep 定位） ====================

/** 当前上下文不是扩展页（如 background Service Worker，无 DOM/wasm 长驻条件） */
export const PY_ERR_CONTEXT = 'PY_CONTEXT_NOT_SUPPORTED';
/** 环境未就绪（未下载或未通过核验） */
export const PY_ERR_NOT_READY = 'PY_ENV_NOT_READY';
/** 运行时启动失败 */
export const PY_ERR_BOOT = 'PY_BOOT_FAILED';
/** 代码执行超时（SIGINT 中断） */
export const PY_ERR_TIMEOUT = 'PY_EXEC_TIMEOUT';
/** Python 抛出异常 */
export const PY_ERR_PYTHON = 'PY_EXEC_ERROR';
export const PY_ERR_WORKSPACE = 'PY_WORKSPACE_ERROR';
export const PY_ERR_WORKSPACE_RUNTIME = 'PY_WORKSPACE_RUNTIME';

/** 抛出带错误码的错误（工具层据此构造可读结果） */
function codeError(code: string, message: string): Error {
  return new Error(`[${code}] ${message}`);
}

// ==================== fetch 拦截（缓存层） ====================

let fetchIntercepted = false;

/** URL 是否属于 Pyodide 缓存域（严格前缀匹配，避免影响其它请求） */
function isCacheableUrl(url: string): boolean {
  return PYODIDE_CACHEABLE_URL_PREFIXES.some(prefix => url.startsWith(prefix));
}

/** 从 fetch 入参中提取 URL 字符串 */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * 安装 scoped fetch 拦截（每页面一次）。
 * 命中缓存 → 合成 Response（content-type 还原，保证 instantiateStreaming 可用）；
 * 未命中 → 原生 fetch（保留 integrity 等全部 init）+ 允许来源的写透缓存。
 */
function installFetchInterception(): void {
  if (fetchIntercepted || typeof globalThis.fetch !== 'function') return;
  fetchIntercepted = true;
  const nativeFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (!isCacheableUrl(url)) {
      return nativeFetch(input, init);
    }

    const cached = await getFile(url);
    if (cached) {
      return new Response(cached.data, {
        status: 200,
        headers: { 'content-type': cached.contentType },
      });
    }

    const environment = typeof window === 'undefined' ? undefined : await getPyodideEnvState();
    const response = await nativeFetch(input, init);
    if (response.ok && response.body) {
      // 写透缓存：克隆响应体异步落盘，不阻塞调用方；失败静默（缓存只是加速层）
      const copy = response.clone();
      void copy
        .arrayBuffer()
        .then(buffer => {
          if (buffer.byteLength === 0 || buffer.byteLength > PYODIDE_CACHE_FILE_MAX_BYTES) return;
          const write = () => putFile({
            url,
            data: buffer,
            contentType: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
            size: buffer.byteLength,
            storedAt: Date.now(),
          });
          if (!environment) return write();
          return withPyodideEnvLock(async () => {
            const current = await getPyodideEnvState();
            if (current.environmentId === environment.environmentId && current.status !== 'idle') await write();
          });
        })
        .catch(() => undefined);
    }
    return response;
  }) as typeof fetch;
}

// ==================== 运行时单例 ====================

interface InterruptController {
  worker: Worker;
}

interface BootedRuntime {
  pyodide: PyodideInterface;
  /** 启动期输出（诊断启动失败用） */
  bootLog: string[];
  interrupt: InterruptController | null;
  /** 是否具备跨域隔离（决定超时中断能力） */
  crossOriginIsolated: boolean;
  /** 已按当前 micropip 清单完成恢复的指纹（清单变化才重新恢复，见 pyodide-micropip） */
  micropipRestoredKey?: string;
}

let booted: BootedRuntime | null = null;
let bootPromise: Promise<BootedRuntime> | null = null;
/**
 * 运行时代数：resetPyodideRuntime 时递增。在途 boot 若跨越了重置，
 * 完成后不再回填单例——否则删除环境的瞬间正在启动的旧实例会"复活"，
 * 让重装后的页面继续带着旧包（缓存已清但 import 仍命中的假象）。
 */
let runtimeGeneration = 0;

/** 执行串行化队列（单一解释器，防并发交叉） */
let runQueue: Promise<unknown> = Promise.resolve();

/** 断言运行在扩展页（sidepanel/hub 等 DOM 上下文） */
function assertWindowContext(): void {
  if (typeof window === 'undefined') {
    throw codeError(
      PY_ERR_CONTEXT,
      'Python 运行时只能运行在扩展页面（侧边栏）上下文；后台 Service Worker 无长驻条件。请在侧边栏会话中使用该工具。',
    );
  }
}

/** 创建超时中断器（跨域隔离可用时）；不可用时返回 null（软超时降级） */
function createInterruptController(): InterruptController | null {
  try {
    if (typeof SharedArrayBuffer === 'undefined' || !globalThis.crossOriginIsolated) return null;
    const worker = new Worker(chrome.runtime.getURL('py-interrupt-worker.js'));
    return { worker };
  } catch {
    return null;
  }
}

/**
 * 启动 Pyodide 运行时（幂等，多调用共享同一 Promise）。
 * 失败不缓存 rejection：下次调用自动重试。
 */
let watchingLocalRuntime = false;
export function ensurePyodideRuntime(workerState?: PyodideEnvState): Promise<BootedRuntime> {
  if (!workerState) {
    assertWindowContext();
    if (!watchingLocalRuntime && typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      watchPyodideEnv((state, previous) => {
        if (state.environmentId !== previous.environmentId) resetPyodideRuntime();
      });
      watchingLocalRuntime = true;
    }
  }
  if (booted) return Promise.resolve(booted);
  if (bootPromise) return bootPromise;

  const generation = runtimeGeneration;
  const task: Promise<BootedRuntime> = (async () => {
    installFetchInterception();

    // 空壳引子三件套（本地懒加载 chunk；版本由 npm 包锚定）
    const [loaderModule, asmModule, lockModule] = await Promise.all([
      import('pyodide'),
      import('pyodide/pyodide.asm.mjs'),
      import('pyodide/pyodide-lock.json'),
    ]);

    const bootLog: string[] = [];
    const runtime: BootedRuntime = {
      pyodide: null as unknown as PyodideInterface,
      bootLog,
      interrupt: null,
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
    };

    try {
      runtime.pyodide = await loaderModule.loadPyodide({
        indexURL: PYODIDE_CDN_BASE,
        // 关键：包内 Emscripten 工厂直传，跳过对 CDN 的动态 import()
        createPyodideModule: asmModule.default,
        // 锁文件本地化：包解析零网络；wheel 相对路径按 CDN 基址解析
        lockFileContents: lockModule.default as unknown as NonNullable<
          Parameters<typeof loaderModule.loadPyodide>[0]
        >['lockFileContents'],
        packageBaseUrl: PYODIDE_CDN_BASE,
        ...(workerState ? { jsglobals: pythonWorkerGlobals() } : {}),
        stdout: (msg: string) => bootLog.push(msg),
        stderr: (msg: string) => bootLog.push(`[stderr] ${msg}`),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw codeError(
        PY_ERR_BOOT,
        `Pyodide 启动失败：${message}${bootLog.length ? `\n启动日志尾: ${bootLog.slice(-5).join(' | ')}` : ''}`,
      );
    }

    runtime.interrupt = workerState ? null : createInterruptController();

    // 页面运行时恢复已安装包（缓存命中时零网络；个别缺失按可失败项忽略）。
    // Worker 跳过：脚本按 import/requirements 惰性加载，避免启动即装满目录包。
    const state = workerState ?? await getPyodideEnvState();
    const savedNames = workerState ? [] : state.packages.map(pkg => pkg.name).filter(name => name !== 'micropip');
    if (savedNames.length > 0) {
      try {
        await runtime.pyodide.loadPackage(savedNames);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        bootLog.push(`[restore] 恢复已安装包失败（忽略，逐个重试）: ${message}`);
        for (const name of savedNames) {
          try {
            await runtime.pyodide.loadPackage(name);
          } catch {
            // 单包失败不阻塞启动：调用方执行 import 时会得到明确 ImportError
          }
        }
      }
    }

    // 代数匹配才回填单例：期间若发生 resetPyodideRuntime，旧实例只交给
    // 本次等待者用完即弃，不进入后续 ensurePyodideRuntime 的复用路径
    if (generation === runtimeGeneration) booted = runtime;
    return runtime;
  })();

  bootPromise = task;
  task.catch(() => {
    // 只清理属于自己的失败：reset 后可能已有新 boot 接管单例槽位
    if (bootPromise === task) bootPromise = null;
  });
  return task;
}

/**
 * 丢弃本上下文已启动的解释器单例（彻底删除环境用）。
 *
 * 无法原地卸载 wasm：在途执行持有的引用会照常跑完；本函数只保证
 * 之后的 ensurePyodideRuntime 重新走完整 boot（从空缓存 / 空包清单起步），
 * 不再复用带旧包的实例。在途 boot 的结果因代数不匹配不会回填。
 */
export function resetPyodideRuntime(): void {
  runtimeGeneration += 1;
  booted?.interrupt?.worker.terminate();
  booted = null;
  bootPromise = null;
}

/**
 * 彻底删除 Python 环境（管理中心「删除Python环境」的唯一编排入口）。
 *
 * 五步齐下，缺一即"删除不完整"：
 * 1. 清空 IndexedDB 文件缓存——运行时 wasm/stdlib + 全部 wheel，
 *    含 fetch 写透缓存沉淀的 micropip wheel（micropip 缓存的字节面）；
 * 2. 清空 micropip 复用清单——local + session 双区（micropip 缓存的
 *    记账面；不清则重装后旧包按清单自动"复活"）；
 * 3. 环境状态回落 idle——已装包清单归零，跨上下文广播；
 * 4. 丢弃本页解释器单例——否则同页重装后旧实例里的包仍可 import；
 * 5. 通知离屏宿主回收 Worker——聊天路径内存残留随回收清空。
 *
 * 先发布停用状态，再回收运行时并清缓存。清理异常由调用方展示。
 */
export async function purgePyodideEnvironment(): Promise<void> {
  await resetPyodideEnvState(async () => {
    resetPyodideRuntime();
    const results = await Promise.allSettled([clearFiles(), clearMicropipManifest(true)]);
    const failed = results.filter(result => result.status === 'rejected');
    if (failed.length) throw new Error(failed.map(result => String(result.reason)).join(' / '));
  });
}

/** 当前是否已在本页面启动（不触发启动动作） */
export function isPyodideRuntimeActive(): boolean {
  return booted !== null;
}

// ==================== 包目录（锁文件驱动） ====================

export interface PyodideCatalogEntry {
  name: string;
  version: string;
  fileName: string;
  depends: string[];
  imports: string[];
  /** wheel 的 sha256（锁文件提供；预下载校验用） */
  sha256: string;
}

/** 解析打包锁文件为可选包目录（仅类型为 package 的安装条目） */
export async function getPackageCatalog(): Promise<PyodideCatalogEntry[]> {
  const lockModule = await import('pyodide/pyodide-lock.json');
  const packages = lockModule.default.packages;
  return Object.values(packages)
    .filter(entry => entry.package_type === 'package')
    .map(entry => ({
      name: entry.name,
      version: entry.version,
      fileName: entry.file_name,
      depends: entry.depends,
      imports: entry.imports,
      sha256: entry.sha256 ?? '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 在目录中查找包（规范化小写比较） */
export async function findCatalogEntry(name: string): Promise<PyodideCatalogEntry | null> {
  const catalog = await getPackageCatalog();
  const key = name.trim().toLowerCase();
  return catalog.find(entry => entry.name.toLowerCase() === key) ?? null;
}

/** 把工具执行时自动加载的包并入环境清单（版本从锁文件目录补齐；失败静默） */
export async function recordAutoLoadedPackages(names: string[], environmentId: string): Promise<void> {
  try {
    const catalog = await getPackageCatalog();
    const catalogIndex = new Map(catalog.map(entry => [entry.name.toLowerCase(), entry]));
    await updatePyodideEnvIfCurrent(environmentId, state => {
      if (state.status !== 'ready') return {};
      const additions = names.flatMap(name => {
        const entry = catalogIndex.get(name.trim().toLowerCase());
        return entry ? [{ name: entry.name, version: entry.version, installedAt: Date.now() }] : [];
      });
      return mergeInstalledPackages(state, additions);
    });
  } catch {
    // 清单回写失败不影响执行本身
  }
}

function mergeInstalledPackages(state: PyodideEnvState, additions: readonly PyodideInstalledPackage[]) {
  const merged = new Map(state.packages.map(pkg => [pkg.name, pkg]));
  for (const pkg of additions) if (!merged.has(pkg.name)) merged.set(pkg.name, pkg);
  return merged.size === state.packages.length ? {} : { packages: [...merged.values()] };
}

export async function recordCurrentMicropipPackages(packages: readonly MicropipPackage[], environmentId: string): Promise<void> {
  try {
    await withPyodideEnvLock(async () => {
      const state = await getPyodideEnvState();
      if (state.status === 'ready' && state.environmentId === environmentId) await recordMicropipPackages(packages);
    });
  } catch {
    // Package reuse is optional and cannot invalidate an otherwise successful run.
  }
}

// ==================== 包安装 / 卸载 ====================

/** 安装锁文件目录中的包（wheel 走缓存层，含 sha256 完整性校验） */
export async function installPackages(names: string[]): Promise<PyodideInstalledPackage[]> {
  if (names.length === 0) return [];
  const state = await getPyodideEnvState();
  if (state.status !== 'ready') throw codeError(PY_ERR_NOT_READY, 'Python environment is not ready');
  const runtime = await ensurePyodideRuntime();

  const catalog = await getPackageCatalog();
  const catalogIndex = new Map(catalog.map(entry => [entry.name.toLowerCase(), entry]));

  const valid = names
    .map(name => name.trim())
    .filter(name => name.length > 0)
    .map(name => catalogIndex.get(name.toLowerCase()))
    .filter((entry): entry is PyodideCatalogEntry => entry !== undefined);

  if (valid.length === 0) return [];

  await runtime.pyodide.loadPackage(valid.map(entry => entry.name));

  const installed: PyodideInstalledPackage[] = valid.map(entry => ({
    name: entry.name,
    version: entry.version,
    installedAt: Date.now(),
  }));

  // 与既有清单合并去重（保留最早 installedAt）
  const updated = await updatePyodideEnvIfCurrent(state.environmentId, current =>
    current.status === 'ready' ? mergeInstalledPackages(current, installed) : {});
  if (updated?.status !== 'ready') throw codeError(PY_ERR_NOT_READY, 'Python environment changed during package installation');
  return installed;
}

/**
 * 卸载包：更新清单并删除对应 wheel 缓存。
 * 注意：当前已加载实例中的模块会残留到页面重载后才彻底消失。
 */
export async function uninstallPackages(names: string[]): Promise<void> {
  const state = await getPyodideEnvState();
  const removing = new Set(names.map(name => name.trim().toLowerCase()));
  const updated = await updatePyodideEnvIfCurrent(state.environmentId, current => ({
    packages: current.packages.filter(pkg => !removing.has(pkg.name.toLowerCase())),
  }));
  if (!updated) return;
  for (const name of removing) {
    const entry = await findCatalogEntry(name);
    if (!entry) continue;
    try {
      await withPyodideEnvLock(async () => {
        const current = await getPyodideEnvState();
        if (current.environmentId === state.environmentId && !current.packages.some(pkg => pkg.name.toLowerCase() === name)) {
          await deleteFile(`${PYODIDE_CDN_BASE}${entry.fileName}`);
        }
      });
    } catch {
      // 缓存删除失败不阻塞：磁盘条目孤儿不影响正确性
    }
  }
}

// ==================== 核验（功能级冒烟测试） ====================

export interface PyodideVerifyResult {
  pythonVersion: string;
  implementation: string;
  checksumOk: boolean;
}

/**
 * 功能核验：解释器版本 / 实现名 / 标准库计算 / stdout 通路全链路检查。
 * 通过后由调用方写入 env 状态 ready。
 */
export async function verifyPyodideRuntime(): Promise<PyodideVerifyResult> {
  const runtime = await ensurePyodideRuntime();
  const outcome = await runPythonCodeInternal(
    runtime,
    [
      'import sys, json',
      'print(json.dumps({',
      '    "python": ".".join(map(str, sys.version_info[:3])),',
      '    "impl": sys.implementation.name,',
      '    "sum": sum(range(1, 101)),',
      '}))',
    ].join('\n'),
    { timeoutMs: 30_000 },
  );
  if (!outcome.ok) {
    throw codeError(PY_ERR_BOOT, `核验脚本执行失败：${outcome.errorDetail || outcome.errorName}`);
  }
  let parsed: { python?: string; impl?: string; sum?: number };
  try {
    parsed = JSON.parse(outcome.stdout.trim().split('\n').pop() || '{}');
  } catch {
    throw codeError(PY_ERR_BOOT, `核验输出无法解析：${outcome.stdout.slice(0, 200)}`);
  }
  if (parsed.impl !== 'cpython' || parsed.sum !== 5050) {
    throw codeError(PY_ERR_BOOT, `核验结果异常：${JSON.stringify(parsed)}`);
  }
  if (!parsed.python || !parsed.python.startsWith(PYODIDE_PYTHON_VERSION)) {
    throw codeError(
      PY_ERR_BOOT,
      `解释器版本不符：期望 ${PYODIDE_PYTHON_VERSION}.x，实际 ${parsed.python ?? '未知'}`,
    );
  }
  return { pythonVersion: parsed.python, implementation: parsed.impl, checksumOk: true };
}

// ==================== 代码执行 ====================

export interface PythonRunOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** 末表达式 repr（无则空串） */
  result: string;
  durationMs: number;
  timedOut: boolean;
  /** Python 异常类型行（如 "ValueError: ..."） */
  errorName: string;
  /** 完整 traceback（截断） */
  errorDetail: string;
  /** 本次执行自动加载的包（loadPackagesFromImports） */
  autoLoadedPackages: string[];
  packageWarning?: string;
  /**
   * 执行后探测到的 micropip 安装包（代码触及 micropip 时才有）。
   * 页路径由本模块直接记账；worker 路径经协议回传，由 python-run-tool 记账。
   */
  micropipPackages?: MicropipPackage[];
  workspaceOutputs?: string[];
}

/** 捕获缓冲：按行累积 + 字节上限截断 */
const outputEncoder = new TextEncoder();
const outputDecoder = new TextDecoder();
const OUTPUT_TRUNCATED = '…（输出超出上限已截断）';

function clipOutput(text: string, capBytes: number): { text: string; bytes: number; truncated: boolean } {
  const buffer = new Uint8Array(Math.min(capBytes, text.length * 3));
  const { read, written } = outputEncoder.encodeInto(text, buffer);
  return read === text.length
    ? { text, bytes: written, truncated: false }
    : { text: outputDecoder.decode(buffer.subarray(0, written)), bytes: written, truncated: true };
}

function createCapture(capBytes: number) {
  const lines: string[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    push(line: string) {
      if (truncated) return;
      const separator = lines.length ? 1 : 0;
      const remaining = capBytes - bytes - separator;
      const clipped = remaining < 0 ? { text: '', bytes: 0, truncated: true } : clipOutput(line, remaining);
      if (remaining >= 0) {
        bytes += clipped.bytes + separator;
        lines.push(clipped.text);
      }
      if (clipped.truncated) {
        truncated = true;
        lines.push(OUTPUT_TRUNCATED);
      }
    },
    text: () => lines.join('\n'),
  };
}

/** 安全 repr 末表达式（销毁临时 PyProxy，防泄漏） */
function reprResult(pyodide: PyodideInterface, value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  let reprFn: { (v: unknown): unknown; destroy?: () => void } | undefined;
  let resultProxy: unknown;
  try {
    reprFn = pyodide.globals.get('repr') as (v: unknown) => unknown & { destroy?: () => void };
    resultProxy = reprFn(value);
    return String(resultProxy);
  } catch {
    return String(value);
  } finally {
    try {
      if (resultProxy && typeof (resultProxy as { destroy?: () => void }).destroy === 'function') {
        (resultProxy as { destroy: () => void }).destroy();
      }
    } catch {
      /* ignore */
    }
    try {
      if (value && typeof (value as { destroy?: () => void }).destroy === 'function') {
        (value as { destroy: () => void }).destroy();
      }
    } catch {
      /* ignore */
    }
  }
}

/** 内部执行体（不排队，调用方负责串行化） */
async function runPythonCodeInternal(
  runtime: BootedRuntime,
  code: string,
  options: {
    timeoutMs: number;
    environmentId?: string;
    workerState?: PyodideEnvState;
    signal?: AbortSignal;
    script?: WorkerScriptExecution;
    /** micropip 复用清单（页路径本地读取；worker 路径由宿主经消息传入） */
    micropipManifest?: MicropipPackage[];
  },
): Promise<PythonRunOutcome> {
  const startedAt = Date.now();
  const stdoutCapture = createCapture(PYODIDE_OUTPUT_CAP_BYTES);
  const stderrCapture = createCapture(PYODIDE_OUTPUT_CAP_BYTES);
  const autoLoadedPackages: string[] = [];
  let packageWarning: string | undefined;

  // 恢复 micropip 复用清单：清单指纹与上次一致则整段跳过（零成本）。
  // 运行期网络已放开，页面直跑与 worker 脚本运行统一恢复；恢复输出走
  // setStdout 之前的默认通道（bootLog/noop），不污染用户 stdout。
  const manifest = options.micropipManifest;
  if (!options.script?.preflight && manifest && manifest.length > 0) {
    const manifestKey = micropipManifestKey(manifest);
    if (runtime.micropipRestoredKey !== manifestKey) {
      try {
        const restored = await restoreMicropipPackages(runtime.pyodide, manifest, options.signal);
        if (restored.warnings.length) {
          // 有警告不记指纹 → 下次执行重试（自愈瞬时网络故障）；警告随结果透出
          packageWarning = [packageWarning, `micropip 恢复：${restored.warnings.join('；')}`]
            .filter(Boolean)
            .join('\n');
        } else {
          runtime.micropipRestoredKey = manifestKey;
        }
      } catch (error) {
        // 恢复模块承诺不抛错，这里兜底防御（如 pyodide 实例异常态）
        const message = error instanceof Error ? error.message : String(error);
        packageWarning = [packageWarning, `micropip 恢复异常：${message.slice(0, 500)}`]
          .filter(Boolean)
          .join('\n');
      }
    }
  }

  // 自动按需加载代码导入的锁文件包（缓存命中零网络；失败不阻塞执行）
  const loadImports = async (source: string) => {
    try {
      const loaded = await runtime.pyodide.loadPackagesFromImports(source);
      if (Array.isArray(loaded)) {
        autoLoadedPackages.push(
          ...loaded
            .map(item => (typeof item === 'string' ? item : item?.name))
            .filter((name): name is string => typeof name === 'string' && name.length > 0),
        );
      }
    } catch (error) {
      // 追加而非覆盖：恢复阶段的警告不得被自动加载失败挤掉
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      packageWarning = [packageWarning, message].filter(Boolean).join('\n');
    }
  };
  if (!options.script) await loadImports(code);

  options.signal?.throwIfAborted();
  const pyodide = runtime.pyodide;
  pyodide.setStdout({ batched: line => stdoutCapture.push(line) });
  pyodide.setStderr({ batched: line => stderrCapture.push(line) });

  // 自动加载的包回写环境清单：下次启动才能自动恢复（wheel 已在缓存层沉淀）
  if (autoLoadedPackages.length > 0 && !options.workerState && options.environmentId) {
    void recordAutoLoadedPackages(autoLoadedPackages, options.environmentId);
  }

  let timedOut = false;
  let interrupted = false;
  const { interrupt } = runtime;
  const buffer = interrupt ? new Int32Array(new SharedArrayBuffer(8)) : undefined;
  if (interrupt && buffer) {
    pyodide.setInterruptBuffer(buffer);
    interrupt.worker.postMessage({ type: 'arm', timeoutMs: options.timeoutMs, buffer: buffer.buffer });
  }

  let resultText = '';
  let errorName = '';
  let errorDetail = '';

  const abort = () => interruptPythonRun();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.script) {
      await options.script.run(pyodide, loadImports, options.signal);
    } else {
      const value = await pyodide.runPythonAsync(code);
      const clipped = clipOutput(reprResult(pyodide, value), PYODIDE_OUTPUT_CAP_BYTES);
      resultText = clipped.text + (clipped.truncated ? OUTPUT_TRUNCATED : '');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // PythonError.message 自带完整 traceback；取末行作为类型行
    const lines = message.trim().split('\n');
    errorName = lines[lines.length - 1]?.slice(0, 300) ?? 'PythonError';
    errorDetail = message.length > 8000 ? `${message.slice(0, 4000)}\n…\n${message.slice(-4000)}` : message;
  } finally {
    options.signal?.removeEventListener('abort', abort);
    if (interrupt && buffer) {
      const reason = Atomics.load(buffer, 1);
      timedOut = reason === 1;
      interrupted = reason === 2;
      interrupt.worker.postMessage({ type: 'disarm' });
      // The next run uses a different buffer, so a late SIGINT can't reach it.
      // Pyodide documents undefined for disabling interrupts; its npm declaration omits it.
      (pyodide.setInterruptBuffer as (buffer?: Int32Array) => void)(undefined);
    }
    pyodide.setStdout({ batched: () => undefined });
    pyodide.setStderr({ batched: () => undefined });
  }

  options.signal?.throwIfAborted();
  if (interrupted) throw codeError('PY_EXEC_CANCELLED', 'Python execution was cancelled');

  // 探测 micropip 安装痕迹并入账（纯本地遍历 distributions；micropip 未加载时
  // 快速失败返回空，天然只对真正用过 micropip 的运行产生开销）：
  // - 页上下文（无 workerState）直接写清单；worker 上下文经 outcome 回传，
  //   由 python-run-tool（SW，有 storage）记账——镜像 autoLoadedPackages 分流。
  // - 即使本次执行失败（errorName 非空），已装包也应入清单（装了就是装了）。
  let micropipPackages: MicropipPackage[] | undefined;
  const probed = await probeMicropipPackages(pyodide);
  if (probed.length) {
    micropipPackages = probed;
    if (!options.workerState && options.environmentId) void recordCurrentMicropipPackages(probed, options.environmentId).catch(error => console.warn('[Pyodide] Could not persist installed packages:', error));
  }

  return {
    ok: !errorName && !timedOut,
    stdout: stdoutCapture.text(),
    stderr: stderrCapture.text(),
    result: resultText,
    durationMs: Date.now() - startedAt,
    timedOut,
    errorName,
    errorDetail,
    autoLoadedPackages,
    packageWarning,
    micropipPackages,
  };
}

/**
 * 立即中断当前正在运行的 Python 代码（用户停止 / 引擎强制终止）。
 *
 * 与超时中断同源（SharedArrayBuffer + SIGINT），但**不等超时定时器**：
 * 用户点停止即刻生效——解释器在字节码求值循环里轮询中断缓冲区，
 * 因此连同步死循环都能被掐断（这正是主线程计时器做不到的）。
 *
 * 幂等且尽力而为：无在途执行 / 运行环境未跨域隔离（无中断能力）时静默返回
 * false——终止钩子的失败不得影响引擎侧的结算。
 */
export function interruptPythonRun(): boolean {
  const runtime = booted;
  const interrupt = runtime?.interrupt;
  if (!runtime || !interrupt) return false;
  try {
    // 不携带 buffer：Worker 只在「已武装」时才会写入 SIGINT（armedBuffer 由
    // arm/disarm 消息维护）。若这里硬塞 buffer，会在**没有 Python 在跑**的
    // 时刻写入信号——下一次执行开跑前虽会复位缓冲区，但那段窗口里任何
    // 读到该缓冲区的解释器都会收到一个来路不明的 SIGINT。
    interrupt.worker.postMessage({ type: 'interrupt' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 执行 Python 代码（对外入口：自动串行化 + 环境就绪校验）。
 * @param code Python 源码（支持顶层 await）
 * @param options.timeoutMs 超时（跨域隔离可用时经 SIGINT 强制中断）
 * @param options.micropipManifest 覆盖自动读取的 micropip 清单（测试/特殊调用用；省略时从 storage 读取）
 */
export async function runPythonCode(
  code: string,
  options: { timeoutMs?: number; chatId?: string; signal?: AbortSignal; micropipManifest?: MicropipPackage[] } = {},
): Promise<PythonRunOutcome> {
  // 页上下文有 chrome：自动读取 micropip 复用清单（读取永不抛错，失败回退空清单=不恢复）
  const micropipManifest = options.micropipManifest ?? await readMicropipManifest();
  return withPythonRun(code, { ...options, micropipManifest }, (runtime, run, state) => options.chatId
    ? runWorkspaceOperation(() => withPythonWorkspace(runtime.pyodide.FS, options.chatId!, run, options.signal, commit =>
      withPyodideEnvLock(async () => {
        const current = await getPyodideEnvState();
        if (current.status !== 'ready' || current.environmentId !== state.environmentId) {
          throw new Error('Python environment changed before the workspace commit');
        }
        await commit();
      }, options.signal),
    ))
    : run());
}

export function runPythonInWorker(
  options: {
    timeoutMs: number;
    chatId: string;
    workerState: PyodideEnvState;
    snapshot?: WorkspaceSnapshot;
    script: WorkerScriptExecution;
    /** 宿主（offscreen，无 storage 访问权）经环境策略应答读取后经消息传入 */
    micropipManifest?: MicropipPackage[];
  },
): Promise<{ outcome: PythonRunOutcome; entries?: WorkspaceEntry[] }> {
  return withPythonRun('', options, async (runtime, run) =>
    runWorkspaceOperation(() => stagePythonWorkspace(
      runtime.pyodide.FS, options.chatId, options.snapshot, run, undefined, !options.script.preflight,
    )));
}

async function runWorkspaceOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof WorkspaceRuntimeError) {
      booted?.interrupt?.worker.terminate();
      booted = null;
      bootPromise = null;
      throw codeError(PY_ERR_WORKSPACE_RUNTIME, error.message);
    }
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw codeError(PY_ERR_WORKSPACE, error instanceof Error ? error.message : String(error));
  }
}

async function withPythonRun<T>(
  code: string,
  options: {
    timeoutMs?: number;
    workerState?: PyodideEnvState;
    signal?: AbortSignal;
    script?: WorkerScriptExecution;
    micropipManifest?: MicropipPackage[];
  },
  execute: (runtime: BootedRuntime, run: () => Promise<PythonRunOutcome>, state: PyodideEnvState) => Promise<T>,
): Promise<T> {
  if (!options.workerState) assertWindowContext();

  const state = options.workerState ?? await getPyodideEnvState();
  if (state.status !== 'ready') {
    throw codeError(PY_ERR_NOT_READY, 'Python 环境未就绪：请先在设置 → Python 环境中下载并核验。');
  }

  const requestedTimeout = options.timeoutMs;
  const timeoutMs = typeof requestedTimeout === 'number' && Number.isFinite(requestedTimeout)
    ? Math.max(1_000, Math.min(requestedTimeout, PYTHON_RUN_MAX_TIMEOUT_MS))
    : PYTHON_RUN_DEFAULT_TIMEOUT_MS;

  // 串行化：并发调用依次执行（finally 放行后续）
  const previous = runQueue;
  let release!: () => void;
  runQueue = new Promise<void>(resolve => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    options.signal?.throwIfAborted();
    if (!options.workerState) {
      const current = await getPyodideEnvState();
      if (current.status !== 'ready' || current.environmentId !== state.environmentId) {
        throw codeError(PY_ERR_NOT_READY, 'Python environment changed while the request was queued');
      }
    }
    const runtime = await ensurePyodideRuntime(options.workerState);
    return await execute(runtime, () => runPythonCodeInternal(runtime, code, {
      ...options, timeoutMs, environmentId: state.environmentId,
    }), state);
  } finally {
    release();
  }
}
