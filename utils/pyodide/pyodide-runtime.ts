/**
 * Pyodide 运行时管理器（扩展页单例 · 混合加载核心）
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
 * - 运行时驻留当前页面（sidepanel）：侧边栏关闭即整体释放内存，
 *   平时不占任何资源；IndexedDB 缓存跨会话持久。
 * - 无法原地"卸载"wasm 实例；uninstallPackages 仅更新清单与缓存，
 *   当前实例中模块残留至下次重载（已在 UI 中说明）。
 */

import type { PyodideInterface } from 'pyodide';
import {
  PYODIDE_CACHE_FILE_MAX_BYTES,
  PYODIDE_CACHEABLE_URL_PREFIXES,
  PYODIDE_CDN_BASE,
  PYODIDE_OUTPUT_CAP_BYTES,
  PYODIDE_PYTHON_VERSION,
} from './pyodide-config';
import { deleteFile, getFile, putFile } from './pyodide-cache';
import {
  getPyodideEnvState,
  updatePyodideEnvState,
  type PyodideInstalledPackage,
} from './pyodide-env';

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

    const response = await nativeFetch(input, init);
    if (response.ok && response.body) {
      // 写透缓存：克隆响应体异步落盘，不阻塞调用方；失败静默（缓存只是加速层）
      const copy = response.clone();
      void copy
        .arrayBuffer()
        .then(buffer => {
          if (buffer.byteLength === 0 || buffer.byteLength > PYODIDE_CACHE_FILE_MAX_BYTES) return;
          return putFile({
            url,
            data: buffer,
            contentType: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
            size: buffer.byteLength,
            storedAt: Date.now(),
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
  buffer: Int32Array;
  /** 本次武装以来 Worker 是否已写入 SIGINT（超时判定的事实来源） */
  firedSinceArm: boolean;
}

interface BootedRuntime {
  pyodide: PyodideInterface;
  /** 启动期输出（诊断启动失败用） */
  bootLog: string[];
  interrupt: InterruptController | null;
  /** 是否具备跨域隔离（决定超时中断能力） */
  crossOriginIsolated: boolean;
}

let booted: BootedRuntime | null = null;
let bootPromise: Promise<BootedRuntime> | null = null;

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
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    const controller: InterruptController = { worker, buffer, firedSinceArm: false };
    worker.onmessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === 'fired') {
        controller.firedSinceArm = true;
      }
    };
    return controller;
  } catch {
    return null;
  }
}

/**
 * 启动 Pyodide 运行时（幂等，多调用共享同一 Promise）。
 * 失败不缓存 rejection：下次调用自动重试。
 */
export function ensurePyodideRuntime(): Promise<BootedRuntime> {
  assertWindowContext();
  if (booted) return Promise.resolve(booted);
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
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

    runtime.interrupt = createInterruptController();
    if (runtime.interrupt) {
      runtime.pyodide.setInterruptBuffer(runtime.interrupt.buffer);
    }

    // 恢复已安装包（缓存命中时零网络；个别缺失按可失败项忽略）
    const state = await getPyodideEnvState();
    const savedNames = state.packages.map(pkg => pkg.name).filter(name => name !== 'micropip');
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

    booted = runtime;
    return runtime;
  })();

  bootPromise.catch(() => {
    bootPromise = null;
  });
  return bootPromise;
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
async function recordAutoLoadedPackages(names: string[]): Promise<void> {
  try {
    const catalog = await getPackageCatalog();
    const catalogIndex = new Map(catalog.map(entry => [entry.name.toLowerCase(), entry]));
    const state = await getPyodideEnvState();
    const merged = new Map(state.packages.map(pkg => [pkg.name, pkg]));
    for (const name of names) {
      const entry = catalogIndex.get(name.trim().toLowerCase());
      if (!entry) continue;
      merged.set(entry.name, merged.get(entry.name) ?? { name: entry.name, version: entry.version, installedAt: Date.now() });
    }
    if (merged.size !== state.packages.length) {
      await updatePyodideEnvState({ packages: [...merged.values()] });
    }
  } catch {
    // 清单回写失败不影响执行本身
  }
}

// ==================== 包安装 / 卸载 ====================

/** 安装锁文件目录中的包（wheel 走缓存层，含 sha256 完整性校验） */
export async function installPackages(names: string[]): Promise<PyodideInstalledPackage[]> {
  if (names.length === 0) return [];
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
  const state = await getPyodideEnvState();
  const merged = new Map(state.packages.map(pkg => [pkg.name, pkg]));
  for (const pkg of installed) {
    merged.set(pkg.name, merged.get(pkg.name) ?? pkg);
  }
  await updatePyodideEnvState({ packages: [...merged.values()] });
  return installed;
}

/**
 * 卸载包：更新清单并删除对应 wheel 缓存。
 * 注意：当前已加载实例中的模块会残留到页面重载后才彻底消失。
 */
export async function uninstallPackages(names: string[]): Promise<void> {
  const state = await getPyodideEnvState();
  const removing = new Set(names.map(name => name.trim().toLowerCase()));
  await updatePyodideEnvState({
    packages: state.packages.filter(pkg => !removing.has(pkg.name.toLowerCase())),
  });
  for (const name of removing) {
    const entry = await findCatalogEntry(name);
    if (!entry) continue;
    try {
      await deleteFile(`${PYODIDE_CDN_BASE}${entry.fileName}`);
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
}

/** 捕获缓冲：按行累积 + 字节上限截断 */
function createCapture(capBytes: number) {
  const lines: string[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    push(line: string) {
      if (truncated) return;
      const size = line.length + 1;
      if (bytes + size > capBytes) {
        truncated = true;
        lines.push('…（输出超出上限已截断）');
        return;
      }
      bytes += size;
      lines.push(line);
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
  options: { timeoutMs: number },
): Promise<PythonRunOutcome> {
  const startedAt = Date.now();
  const stdoutCapture = createCapture(PYODIDE_OUTPUT_CAP_BYTES);
  const stderrCapture = createCapture(PYODIDE_OUTPUT_CAP_BYTES);
  const autoLoadedPackages: string[] = [];

  // 自动按需加载代码导入的锁文件包（缓存命中零网络；失败不阻塞执行）
  try {
    const loaded = await runtime.pyodide.loadPackagesFromImports(code);
    if (Array.isArray(loaded)) {
      // v314 返回 PackageData[]；兼容历史字符串数组形态
      autoLoadedPackages.push(
        ...loaded
          .map(item => (typeof item === 'string' ? item : item?.name))
          .filter((name): name is string => typeof name === 'string' && name.length > 0),
      );
    }
  } catch {
    // 解析失败忽略：交由解释器抛出可读的 ImportError
  }

  const pyodide = runtime.pyodide;
  pyodide.setStdout({ batched: line => stdoutCapture.push(line) });
  pyodide.setStderr({ batched: line => stderrCapture.push(line) });

  // 自动加载的包回写环境清单：下次启动才能自动恢复（wheel 已在缓存层沉淀）
  if (autoLoadedPackages.length > 0) {
    void recordAutoLoadedPackages(autoLoadedPackages);
  }

  let timedOut = false;
  const { interrupt } = runtime;
  if (interrupt) {
    interrupt.buffer[0] = 0;
    interrupt.firedSinceArm = false;
    interrupt.worker.postMessage({ type: 'arm', timeoutMs: options.timeoutMs, buffer: interrupt.buffer.buffer });
  }

  let resultText = '';
  let errorName = '';
  let errorDetail = '';

  try {
    const value = await pyodide.runPythonAsync(code);
    resultText = reprResult(pyodide, value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 超时判定：以 Worker 是否实际写入过 SIGINT 为事实来源（Pyodide 处理
    // 信号后会把缓冲区清零，不能靠缓冲区值判定）
    if (interrupt && interrupt.firedSinceArm) {
      timedOut = true;
    }
    // PythonError.message 自带完整 traceback；取末行作为类型行
    const lines = message.trim().split('\n');
    errorName = lines[lines.length - 1]?.slice(0, 300) ?? 'PythonError';
    errorDetail = message.length > 8000 ? `${message.slice(0, 4000)}\n…\n${message.slice(-4000)}` : message;
  } finally {
    if (interrupt) {
      interrupt.worker.postMessage({ type: 'disarm' });
      interrupt.buffer[0] = 0;
      interrupt.firedSinceArm = false;
    }
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
  };
}

/**
 * 执行 Python 代码（对外入口：自动串行化 + 环境就绪校验）。
 * @param code Python 源码（支持顶层 await）
 * @param options.timeoutMs 超时（跨域隔离可用时经 SIGINT 强制中断）
 */
export async function runPythonCode(code: string, options: { timeoutMs?: number } = {}): Promise<PythonRunOutcome> {
  assertWindowContext();

  const state = await getPyodideEnvState();
  if (state.status !== 'ready') {
    throw codeError(PY_ERR_NOT_READY, 'Python 环境未就绪：请先在设置 → Python 环境中下载并核验。');
  }

  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 60_000, 180_000));

  // 串行化：并发调用依次执行（finally 放行后续）
  const previous = runQueue;
  let release!: () => void;
  runQueue = new Promise<void>(resolve => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    const runtime = await ensurePyodideRuntime();
    return await runPythonCodeInternal(runtime, code, { timeoutMs });
  } finally {
    release();
  }
}
