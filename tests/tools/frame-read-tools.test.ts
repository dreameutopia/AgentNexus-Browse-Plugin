import assert from "node:assert/strict";
import { BrowserObserveTool } from "../../tools/browser/observe";
import {
  GetPageTextTool,
  GetPageHTMLTool,
} from "../../tools/base/page-info-tool";
import { parseCsv } from "../../utils/python-workspace/tabular";
import { exclusiveText } from "../../tools/browser/text-runtime";

const saved = globalThis.chrome;
const warn = console.warn;
let childScan = false;
let childStale = false;
let focusFails = false;
let primaryStale = false;
let phase = "text";
let focusMutates = false;
let invalidOne = false;
const record = (id: number) => ({
  type: "button",
  description: `button ${id}`,
  context: "",
  elementId: `anx:7:nonce:${id}`,
  score: 1,
  matchedRegex: null,
  matchedXpath: null,
  isHit: false,
});
try {
  console.warn = () => {};
  (globalThis as any).chrome = {
    ...saved,
    tabs: {
      ...saved.tabs,
      query: async () => [{ id: 7, url: "https://example.org/" }],
    },
    webNavigation: {
      getAllFrames: async () => [{ frameId: 0, documentId: "doc-0" }],
    },
    scripting: {
      executeScript: async (request: any) => {
        assert.equal(request.injectImmediately, true);
        if (request.target.allFrames)
          return [0, 38].map((id) => ({
            frameId: id,
            documentId: `doc-${id}`,
            result: { url: id ? "about:blank" : "https://example.org/" },
          }));
        const id = request.target.documentIds
          ? Number(request.target.documentIds[0].slice(4))
          : request.target.frameIds[0];
        const name = request.func.name;
        if (id === 38 && !childScan)
          throw new Error("Cannot access contents of the page");
        let result: any;
        if (name === "structuredPagePayload")
          result = {
            markdown: "healthy page content",
            title: "Page",
            url: "https://example.org/",
            truncated: false,
            shadowRoots: 0,
          };
        else if (name === "elementScanPayload")
          result = { elements: invalidOne && id === 0 ? [record(0), record(1)] : [record(id)], fingerprint: `fp-${id}` };
        else if (name === "validateElementReferences")
          result = {
            valid: !(id ? childStale : primaryStale),
            fingerprint: `fp-${id}`,
            semantics: [],
            ...(invalidOne && id === 0 && request.args[0]?.length ? { valid: false, validElementIds: [record(0).elementId], invalidElementIds: [record(1).elementId] } : {}),
          };
        else if (name === "focusedTextPayload") {
          if (focusMutates) primaryStale = true;
          if (focusFails) throw new Error("focus unavailable");
          result = null;
        } else if (phase === "html") result = "<p>healthy HTML</p>";
        else throw new Error(`Unexpected payload ${name}`);
        return [{ frameId: id, documentId: `doc-${id}`, result }];
      },
    },
  };
  const text = await new GetPageTextTool().execute({});
  assert.equal(text.success, true);
  assert.ok(
    parseCsv(text.data.content).rows[0][0].includes("healthy page content"),
  );
  assert.equal(text.data.frameDiagnostics.status, "partial");
  assert.equal(text.data.frameDiagnostics.issues[0].frameId, 38);
  assert.equal(text.data.frameDiagnostics.issues[0].code, "PERMISSION_DENIED");

  const observed = await new BrowserObserveTool().execute({ view: "controls" });
  assert.equal(observed.success, true, observed.error ?? "observe failed");
  assert.ok(observed.data.elements.includes("button 0"));
  assert.equal(observed.data.partial, true);

  childScan = true;
  childStale = true;
  focusFails = true;
  const staleChild = await new BrowserObserveTool().execute({
    view: "controls",
  });
  assert.equal(staleChild.success, true, staleChild.error ?? "observe failed");
  assert.ok(staleChild.data.elements.includes("button 0"));
  assert.ok(!staleChild.data.elements.includes("button 38"));
  assert.equal(staleChild.data.omittedElements, 1);
  assert.ok(
    staleChild.data.frameDiagnostics.some(
      (r: any) => r.operation === "observe-focus" && r.status === "failed",
    ),
    "optional focus failure retains valid controls",
  );

  primaryStale = true;
  const staleAll = await new BrowserObserveTool().execute({ view: "controls" });
  assert.equal(staleAll.success, false, "no stale references may be delivered");
  assert.ok(
    staleAll.data.frameDiagnostics,
    "validation-only failures retain precise diagnostics",
  );

  childScan = false;
  phase = "html";
  const html = await new GetPageHTMLTool().execute({ includeIframes: true });
  assert.equal(html.success, true);
  assert.ok(html.data.content.includes("healthy HTML"));
  assert.equal(html.data.frameDiagnostics.status, "partial");

  primaryStale = false; childStale = false; childScan = false; focusFails = false; invalidOne = true;
  const singleStale = await new BrowserObserveTool().execute({ view: 'controls' });
  assert.equal(singleStale.success, true, singleStale.error ?? 'partial references should survive');
  assert.ok(singleStale.data.elements.includes('button 0'));
  assert.ok(!singleStale.data.elements.includes('button 1'));
  assert.equal(singleStale.data.omittedElements, 1);
  invalidOne = false; focusMutates = true;
  const changedDuringFocus = await new BrowserObserveTool().execute({ view: 'controls' });
  assert.equal(changedDuringFocus.success, false, 'async focus reads must occur before final reference validation');
  focusMutates = false;

  let release: () => void = () => {};
  const active = exclusiveText(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  let replayed = false;
  await assert.rejects(
    exclusiveText(async () => {
      replayed = true;
    }, 5),
    /QUEUE_TIMEOUT/,
  );
  release();
  await active;
  await exclusiveText(async () => {});
  assert.equal(
    replayed,
    false,
    "expired queued reads are not dispatched later",
  );
  const queuedAbort = new AbortController();
  let releaseAgain: () => void = () => {};
  const blocker = exclusiveText(() => new Promise<void>(resolve => { releaseAgain = resolve; }));
  await Promise.resolve();
  let cancelledRan = false;
  const cancelledQueue = exclusiveText(async () => { cancelledRan = true; }, 1000, queuedAbort.signal);
  queuedAbort.abort();
  await assert.rejects(cancelledQueue, /ABORTED/);
  releaseAgain(); await blocker; await exclusiveText(async () => {});
  assert.equal(cancelledRan, false, 'cancelled queued work never executes after lock release');
  console.log(
    "[frame-read-tools] text/HTML partial success, invalid-frame isolation, optional focus, stale-reference rejection, and queue expiry passed",
  );
} finally {
  globalThis.chrome = saved;
  console.warn = warn;
}
