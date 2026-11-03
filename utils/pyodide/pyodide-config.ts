/**
 * Pyodide 混合加载配置（唯一事实源）
 *
 * 版本锚定策略：
 * - JS 引导层（pyodide.mjs 加载器 + pyodide.asm.mjs Emscripten 胶水 + 锁文件）
 *   来自 npm 包 pyodide@PYODIDE_VERSION，经 Vite 打包随扩展分发（"空壳引子"），
 *   不触发现商店"远程托管代码"限制——所有可执行 JS 均在包内。
 * - 重型载荷（pyodide.asm.wasm 约 9.4MB + python_stdlib.zip 约 2.5MB）与
 *   各 Python 包 wheel 按用户显式操作从 jsDelivr CDN 下载，缓存进 IndexedDB，
 *   二次使用零网络（"重型载荷"层）。锁文件提供每个 wheel 的 sha256，
 *   loadPackage 下载时自动做子资源完整性校验。
 *
 * 版本升级方法：改 PYODIDE_VERSION + npm install pyodide@<同一版本>，
 * 两处必须一致（loadPyodide 的 checkAPIVersion 会校验 JS 层与 wasm 层匹配）。
 */

/** 随扩展打包的 pyodide npm 包版本（与 CDN 下载的 wasm/包版本严格一致） */
export const PYODIDE_VERSION = '314.0.7';

/** 该发行版内置的 CPython 主版本（校验用） */
export const PYODIDE_PYTHON_VERSION = '3.14';

/** jsDelivr 上的 Pyodide 全量发行目录（wasm / stdlib / wheel 均按 URL 寻址缓存） */
export const PYODIDE_CDN_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/** 按需下载的核心运行时文件（blob 内容类型影响 instantiateStreaming 可用性） */
export interface PyodideCoreFile {
  /** 下载 URL */
  url: string;
  /** 展示文件名 */
  label: string;
  /** 缓存/响应的 Content-Type */
  contentType: string;
}

export const PYODIDE_CORE_FILES: readonly PyodideCoreFile[] = [
  { url: `${PYODIDE_CDN_BASE}pyodide.asm.wasm`, label: 'pyodide.asm.wasm', contentType: 'application/wasm' },
  { url: `${PYODIDE_CDN_BASE}python_stdlib.zip`, label: 'python_stdlib.zip', contentType: 'application/zip' },
];

/** 核心文件预计下载量（UI 提示用；wasm≈9.4MB + stdlib≈2.5MB） */
export const PYODIDE_CORE_DOWNLOAD_HINT_MB = 12;

/**
 * 设置页包管理中置顶展示的常用包（与锁文件条目名对齐）。
 * 展示时会校验其确实存在于锁文件目录中。
 */
export const PYODIDE_FEATURED_PACKAGES: readonly string[] = [
  'numpy',
  'pandas',
  'scipy',
  'matplotlib',
  'scikit-learn',
  'sympy',
  'networkx',
  'pillow',
  'regex',
  'pyyaml',
  'requests',
  'beautifulsoup4',
  'lxml',
  'sqlalchemy',
  'micropip',
];

/** chrome.storage.local 中 Python 环境状态的键名 */
export const PYODIDE_ENV_STORAGE_KEY = 'pyodide_env_state';

// ──── 防御性上限 ────

/** 单次执行代码长度上限（字符） */
export const PYODIDE_MAX_CODE_LENGTH = 200_000;

/** python_run 工具默认/最大执行超时（毫秒） */
export const PYTHON_RUN_DEFAULT_TIMEOUT_MS = 60_000;
export const PYTHON_RUN_MAX_TIMEOUT_MS = 180_000;

/** 单路输出（stdout / stderr）捕获上限（字节），超出截断并标注 */
export const PYODIDE_OUTPUT_CAP_BYTES = 64 * 1024;

/** 单文件写缓存上限（超过则跳过缓存，如超大 wheel） */
export const PYODIDE_CACHE_FILE_MAX_BYTES = 300 * 1024 * 1024;

/**
 * fetch 拦截层允许写缓存的远端来源（严格前缀匹配）：
 * - jsDelivr Pyodide 发行目录：核心文件与官方 wheel；
 * - files.pythonhosted.org / pypi.org：micropip 安装纯 Python 包时拉取。
 * 其余一切 URL（模型 API、SSE 流等）一律直连，不受影响。
 */
export const PYODIDE_CACHEABLE_URL_PREFIXES: readonly string[] = [
  PYODIDE_CDN_BASE,
  'https://files.pythonhosted.org/',
  'https://pypi.org/',
];
