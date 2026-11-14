/**
 * Worker 内的 Python 全局对象面（防御纵深：同源 Worker 内也只暴露必要全局）。
 * 这是同一 Worker 内的纵深防御，不是权限边界——运行期网络已放开：
 * fetch 直通真实网络，脚本可联网取数、可在依赖阶段之外自行安装纯 Python 包
 * （声明式 requirements 的审批门在工具/宿主层，与此无关）。
 */
export function pythonWorkerGlobals(): object {
  const api = Object.create(null) as Record<string, unknown>;
  const names = [
    'AbortController', 'AbortSignal', 'Array', 'ArrayBuffer', 'Blob', 'Boolean',
    'console', 'crypto', 'DataView', 'Date', 'DOMException', 'Error', 'File', 'Float32Array', 'Float64Array',
    'FormData', 'Headers', 'ImageData', 'Int8Array', 'Int16Array', 'Int32Array',
    'JSON', 'Map', 'Math', 'Number', 'Object', 'OffscreenCanvas', 'performance', 'Promise', 'ReadableStream',
    'Reflect', 'RegExp', 'Request', 'Response', 'Set', 'String', 'Symbol', 'TextDecoder',
    'TextEncoder', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array',
    'URL', 'URLSearchParams', 'WeakMap', 'WeakRef', 'WeakSet', 'WritableStream', 'XMLHttpRequest',
  ] as const;
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of names) {
    if (globals[name] !== undefined) api[name] = globals[name];
  }
  api.fetch = globalThis.fetch.bind(globalThis);
  api.setTimeout = globalThis.setTimeout.bind(globalThis);
  api.clearTimeout = globalThis.clearTimeout.bind(globalThis);
  api.setInterval = globalThis.setInterval.bind(globalThis);
  api.clearInterval = globalThis.clearInterval.bind(globalThis);
  api.queueMicrotask = globalThis.queueMicrotask.bind(globalThis);
  if (typeof createImageBitmap === 'function') api.createImageBitmap = createImageBitmap;
  api.globalThis = api;
  api.self = api;
  return Object.freeze(api);
}
