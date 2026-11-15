import assert from "node:assert/strict";
import {
  readPageFrames,
  executeScriptBounded,
  PageReadError,
  isFrameReadReport,
} from "../../tools/common/frame-read";
import { classifyInjectionError, normalizeInjectionArgs, injectionErrorText } from "../../tools/common/script-injection";

const saved = globalThis.chrome;
const savedWarn = console.warn;
const calls: any[] = [];
const logs: any[] = [];
const never = () => new Promise<any>(() => {});
const frame = (id: number, result: unknown = { text: `frame ${id}` }) => ({
  frameId: id,
  documentId: `doc-${id}`,
  result,
});
const request = {
  target: { tabId: 7, allFrames: true },
  func: () => ({ text: "read" }),
  world: "ISOLATED" as const,
};
const fast = { discoveryTimeoutMs: 15, frameTimeoutMs: 15, timeoutMs: 100 };
function mock(
  read: (id: number) => any = (id) => [frame(id)],
  discovery: () => any = () => [
    frame(0, { url: "https://example.org/?secret=1" }),
    frame(38, { url: "about:blank" }),
  ],
) {
  calls.length = 0;
  (globalThis as any).chrome = {
    webNavigation: {
      getAllFrames: async () => [
        { frameId: 0, documentId: "doc-0", url: "https://example.org/" },
      ],
    },
    scripting: {
      executeScript: async (r: any) => {
        calls.push(r);
        assert.equal(r.injectImmediately, true);
        if (r.target.allFrames) return discovery();
        const id = r.target.documentIds
          ? Number(r.target.documentIds[0].slice(4))
          : r.target.frameIds[0];
        return read(id);
      },
    },
  };
}
try {
  console.warn = (...args) => {
    logs.push(args);
  };
  mock();
  const both = await readPageFrames(request, fast);
  assert.deepEqual(
    both.map((r) => r.frameId),
    [0, 38],
    "about:blank omitted by webNavigation is still collected",
  );
  assert.equal(both.frameDiagnostics.status, "complete");
  assert.ok(
    calls
      .filter((r) => !r.target.allFrames)
      .every((r) => r.target.documentIds && !r.target.frameIds),
    "discovered document is pinned",
  );

  mock((id) => {
    if (id === 38) throw new Error("Cannot access contents of the page");
    return [frame(id)];
  });
  const partial = await readPageFrames(request, fast);
  assert.deepEqual(
    partial.map((r) => r.frameId),
    [0],
  );
  assert.equal(partial.frameDiagnostics.status, "partial");
  assert.equal(partial.frameDiagnostics.issues[0].frameId, 38);
  assert.equal(partial.frameDiagnostics.issues[0].code, "PERMISSION_DENIED");

  let late: (v: unknown) => void = () => {};
  mock((id) =>
    id === 38
      ? new Promise((resolve) => {
          late = resolve;
        })
      : [frame(id)],
  );
  const timed = await readPageFrames(request, fast);
  assert.equal(timed.frameDiagnostics.issues[0].code, "INJECTION_TIMEOUT");
  const frozen = JSON.stringify(timed);
  const frozenReport = JSON.stringify(timed.frameDiagnostics);
  late([frame(38)]);
  await new Promise((r) => setTimeout(r, 1));
  assert.equal(
    JSON.stringify(timed),
    frozen,
    "late replies cannot alter delivered results",
  );
  assert.equal(JSON.stringify(timed.frameDiagnostics), frozenReport);

  mock((id) => [frame(id)], never);
  const fallback = await readPageFrames(request, fast);
  assert.deepEqual(
    fallback.map((r) => r.frameId),
    [0],
  );
  assert.equal(fallback.frameDiagnostics.discoveryComplete, false);
  assert.equal(fallback.frameDiagnostics.issues[0].stage, "discovery");

  mock(() => []);
  await assert.rejects(
    readPageFrames(request, fast),
    (e: any) =>
      e instanceof PageReadError &&
      e.frameDiagnostics.issues.every((i: any) => i.code === "NO_RESULT"),
  );
  mock((id) => [{ ...frame(id), documentId: "replacement-document" }]);
  await assert.rejects(readPageFrames(request, fast), (e: any) =>
    e.frameDiagnostics.issues.every((i: any) => i.code === "FRAME_CHANGED"),
  );
  mock((id) => [{ ...frame(id), error: "payload threw" }]);
  await assert.rejects(readPageFrames(request, fast), (e: any) =>
    e.frameDiagnostics.issues.every((i: any) => i.code === "PAYLOAD_EXCEPTION"),
  );
  mock(() => {
    throw new Error("No tab with id: 7");
  });
  await assert.rejects(readPageFrames(request, fast), (e: any) =>
    e.frameDiagnostics.issues.every((i: any) => i.code === "TAB_GONE"),
  );

  mock();
  const capped = await readPageFrames(request, { ...fast, maxFrames: 1 });
  assert.deepEqual(
    capped.map((r) => r.frameId),
    [0],
  );
  assert.equal(capped.frameDiagnostics.issues[0].code, "FRAME_LIMIT");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    readPageFrames(
      { ...request, target: { tabId: 7 } },
      { ...fast, signal: controller.signal },
    ),
    (e: any) => e.frameDiagnostics.issues[0].code === "ABORTED",
  );

  mock(never, () =>
    Array.from({ length: 20 }, (_, id) => frame(id, { url: "about:blank" })),
  );
  const start = Date.now();
  await assert.rejects(
    readPageFrames(request, { ...fast, timeoutMs: 25, frameTimeoutMs: 100 }),
    PageReadError,
  );
  assert.ok(
    Date.now() - start < 500,
    "total deadline covers frame scheduling waves",
  );

  mock();
  assert.throws(
    () =>
      executeScriptBounded({
        target: { tabId: 7 },
        func: () => 1,
        args: [() => 1],
      }),
    /function/,
  );
  assert.equal(
    calls.length,
    0,
    "invalid arguments are rejected before dispatch",
  );
  assert.equal(
    classifyInjectionError(new Error("No frame with id: 38")).code,
    "FRAME_REMOVED",
  );
  assert.equal(
    classifyInjectionError(
      new Error("INJECTION_TIMEOUT: dispatch may still run"),
    ).outcomeUncertain,
    true,
  );
  assert.ok(
    !JSON.stringify(logs).includes("secret=1"),
    "query strings are not logged",
  );
  mock();
  const explicitDocument = await readPageFrames({ ...request, target: { tabId: 7, documentIds: ['doc-38'] } }, fast);
  assert.deepEqual(explicitDocument.map(row => row.frameId), [38], 'explicit documents never fall back to main frame');
  await readPageFrames({ ...request, injectImmediately: false }, fast);
  assert.ok(calls.every(call => call.injectImmediately === true), 'read collection always avoids idle scheduling');

  for (const invalid of [0, -1, NaN, Infinity]) {
    mock();
    await assert.rejects(readPageFrames(request, { ...fast, timeoutMs: invalid }), (error: any) => error.frameDiagnostics.issues[0].code === 'INVALID_ARGUMENT');
    assert.equal(calls.length, 0, 'invalid budgets cannot dispatch reads');
  }
  mock(() => ({ invalid: true }));
  await assert.rejects(readPageFrames(request, fast), (error: any) => error.frameDiagnostics.issues.every((i: any) => i.code === 'INVALID_RESULT'));
  mock(id => [frame(id)], () => ({ malformed: true }));
  const discoveryFallback = await readPageFrames(request, fast);
  assert.equal(discoveryFallback[0].frameId, 0);
  assert.equal(discoveryFallback.frameDiagnostics.discoveryComplete, false);

  mock(never);
  const abortController = new AbortController();
  const abortPending = readPageFrames(request, { ...fast, frameTimeoutMs: 1000, timeoutMs: 2000, signal: abortController.signal });
  setTimeout(() => abortController.abort(), 5);
  const abortStart = performance.now();
  await assert.rejects(abortPending, (error: any) => error.frameDiagnostics.issues.some((i: any) => i.code === 'ABORTED'));
  assert.ok(performance.now() - abortStart < 500, 'abort interrupts in-flight waits rather than waiting for frame timeouts');

  mock();
  const boundedContent = await readPageFrames(request, { ...fast, concurrency: 1, maxResultChars: 1, measureResult: () => 1 });
  assert.deepEqual(boundedContent.map(row => row.frameId), [0]);
  assert.equal(boundedContent.frameDiagnostics.issues[0].code, 'RESULT_BUDGET_EXCEEDED');

  const hostile = new Proxy({}, { get() { throw new Error('getter failed'); }, getPrototypeOf() { throw new Error('prototype failed'); }, ownKeys() { throw new Error('keys failed'); } });
  assert.equal(injectionErrorText(hostile), 'Unserializable error value');
  mock(id => { if (id === 38) throw hostile; return [frame(id)]; });
  const unknownFailure = await readPageFrames(request, fast);
  assert.equal(unknownFailure[0].frameId, 0);
  assert.equal(unknownFailure.frameDiagnostics.issues[0].message, 'Unserializable error value');
  const prototypeInput = JSON.parse('{"__proto__":{"polluted":true},"normal":1}');
  const prototypeOutput = normalizeInjectionArgs([prototypeInput])[0] as any;
  assert.equal(Object.hasOwn(prototypeOutput, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(prototypeOutput), Object.prototype);
  assert.equal(({} as any).polluted, undefined);
  assert.deepEqual(normalizeInjectionArgs([new Array(2)]), [[null, null]], 'sparse arrays use JSON null semantics');
  assert.throws(() => normalizeInjectionArgs([Array.from({ length: 21000 }, () => 'x')]), /serialization budget/);
  assert.equal(isFrameReadReport(both.frameDiagnostics), true);
  assert.equal(isFrameReadReport({ ...both.frameDiagnostics, documents: [{ frameId: -1 }] }), false);
  assert.equal(isFrameReadReport({ ...both.frameDiagnostics, issues: [{ stage: 'read', code: 'FAILED', message: 'failure', elementIds: [42] }] }), false);
  console.log(
    "[frame-read] partial success, blank frames, identity, timeout, late reply, limits, and error classification passed",
  );
} finally {
  globalThis.chrome = saved;
  console.warn = savedWarn;
}
