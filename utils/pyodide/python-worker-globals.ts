/**
 * Public JS bridge for conversation Python. Keep browser storage, worker messaging,
 * extension APIs and the privileged worker global off the normal Python import surface.
 * This is defense in depth within a same-origin Worker.
 */
export function pythonWorkerGlobals(restrictedFetch?: typeof fetch): object {
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
    if (restrictedFetch && name === 'XMLHttpRequest') continue;
    if (globals[name] !== undefined) api[name] = globals[name];
  }
  api.fetch = restrictedFetch ?? globalThis.fetch.bind(globalThis);
  api.setTimeout = globalThis.setTimeout.bind(globalThis);
  api.clearTimeout = globalThis.clearTimeout.bind(globalThis);
  api.setInterval = globalThis.setInterval.bind(globalThis);
  api.clearInterval = globalThis.clearInterval.bind(globalThis);
  api.queueMicrotask = globalThis.queueMicrotask.bind(globalThis);
  if (typeof createImageBitmap === 'function') api.createImageBitmap = createImageBitmap.bind(globalThis);
  api.globalThis = api;
  api.self = api;
  return Object.freeze(api);
}

/** Only the host's dependency phase can use the public index over the normal Python JS bridge. */
export function createScriptNetwork() {
  let installing = false;
  const fetch = globalThis.fetch.bind(globalThis);
  const restrictedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const publicWheelSource =
      (url.origin === 'https://pypi.org' && url.pathname.startsWith('/simple/')) ||
      (url.origin === 'https://files.pythonhosted.org' && url.pathname.startsWith('/packages/'));
    if (!installing || !publicWheelSource || !['GET', 'HEAD'].includes(request.method)) {
      throw new Error('Skill script network access is unavailable. Only the dependency resolver may fetch public PyPI wheels.');
    }
    return fetch(request, { credentials: 'omit', redirect: 'error' });
  };
  return {
    globals: pythonWorkerGlobals(restrictedFetch),
    async withPublicIndex<T>(install: () => Promise<T>): Promise<T> {
      installing = true;
      try {
        return await install();
      } finally {
        installing = false;
      }
    },
  };
}
