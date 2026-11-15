/** Real extension API regression: pending blank frame, permission failure, stalled payload.
 * Separate temporary profile and extension; no connection to the user's extension.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const executable = [
  process.env.FRAME_READ_CHROMIUM_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find((p) => p && existsSync(p));
if (!executable)
  throw new Error(
    "Set FRAME_READ_CHROMIUM_PATH to an extension-capable Chromium executable",
  );
const dir = mkdtempSync(path.join(tmpdir(), "agentnexus-frame-read-"));
writeFileSync(
  path.join(dir, "manifest.json"),
  JSON.stringify({
    manifest_version: 3,
    name: "AgentNexus frame read regression",
    version: "1.0",
    background: { service_worker: "anx-frame-read-worker.js" },
    permissions: ["scripting", "tabs", "webNavigation"],
    host_permissions: ["http://127.0.0.1/*"],
  }),
);
await build({
  stdin: {
    contents:
      'export * from "./tools/common/frame-read"; export {structuredPagePayload} from "./tools/browser/structured-page-payload"; export {elementScanPayload} from "./tools/automation/shared/element-scan-payload";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "iife",
  globalName: "FrameReads",
  target: "es2022",
  outfile: path.join(dir, "anx-frame-read-worker.js"),
  footer: { js: "chrome.runtime.onInstalled.addListener(()=>{});" },
});
const pendingResponses = new Set();
const server = createServer((req, res) => {
  if (req.url === "/stall") {
    pendingResponses.add(res);
    res.on("close", () => pendingResponses.delete(res));
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    req.url === "/ok"
      ? "<p>healthy child</p>"
      : '<!doctype html><p>healthy main</p><button>Login button</button><input aria-label="Account"><iframe src="/ok"></iframe><iframe src="/stall"></iframe>',
  );
});
await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;
const child = spawn(
  executable,
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${path.join(dir, "profile")}`,
    `--disable-extensions-except=${dir}`,
    `--load-extension=${dir}`,
    "about:blank",
  ],
  { windowsHide: true },
);
const sockets = [];
async function connect(url) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data),
      task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timer);
    message.error
      ? task.reject(new Error(JSON.stringify(message.error)))
      : task.resolve(message.result);
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} deadline exceeded`));
      }, 6000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
}
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Chromium startup deadline exceeded")),
      10000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stderr.on("data", (data) => {
      const match = String(data).match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  const base = endpoint
    .replace(/^ws:/, "http:")
    .replace(/\/devtools\/browser\/.*/, "");
  let targets, worker;
  for (let i = 0; i < 30; i++) {
    targets = await (await fetch(base + "/json/list")).json();
    worker = targets.find(
      (t) =>
        t.type === "service_worker" &&
        t.url.endsWith("/anx-frame-read-worker.js"),
    );
    if (worker) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(
    worker,
    "Browser did not load the temporary extension; use an extension-capable Chromium build",
  );
  const page = await connect(
    targets.find((t) => t.type === "page").webSocketDebuggerUrl,
  );
  const extension = await connect(worker.webSocketDebuggerUrl);
  const evaluate = async (expression) => {
    const result = await extension("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await page("Page.enable");
  await page("Page.navigate", { url: pageUrl });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await evaluate(
    `(async()=>{globalThis.tabId=(await chrome.tabs.query({})).find(t=>t.url?.startsWith(${JSON.stringify(pageUrl)})).id})()`,
  );
  const collect = (func, args = []) =>
    evaluate(
      `(async()=>{const r=await FrameReads.readPageFrames({target:{tabId,allFrames:true},func:${func},args:${JSON.stringify(args)}},{operation:'real-browser-regression',timeoutMs:2500,frameTimeoutMs:500,discoveryTimeoutMs:600});return {frames:[...r],report:r.frameDiagnostics};})()`,
    );

  const healthy = await collect(
    '()=>({url:document.URL,text:document.body?.textContent||""})',
  );
  assert.ok(
    healthy.frames.some(
      (f) => f.frameId === 0 && f.result.text.includes("healthy main"),
    ),
  );
  assert.ok(
    healthy.frames.some((f) => f.result.text.includes("healthy child")),
  );
  assert.ok(
    healthy.frames.some((f) => f.result.url === "about:blank"),
    "initial blank document is collected while child navigation is pending",
  );
  const text = await collect("FrameReads.structuredPagePayload");
  assert.ok(
    text.frames.some(
      (f) => f.frameId === 0 && f.result.markdown.includes("healthy main"),
    ),
  );
  const controls = await collect("FrameReads.elementScanPayload", [
    "controls",
    "",
    "",
    7,
  ]);
  assert.ok(
    controls.frames.some(
      (f) =>
        f.frameId === 0 &&
        f.result.elements.some((e) => e.description.includes("Login button")),
    ),
  );

  const stalled = await collect(
    '()=>location.pathname==="/ok"?new Promise(()=>{}):({url:document.URL,text:document.body?.textContent||""})',
  );
  assert.ok(stalled.frames.some((f) => f.frameId === 0));
  assert.equal(stalled.report.status, "partial");
  assert.ok(
    stalled.report.issues.some(
      (i) => i.code === "INJECTION_TIMEOUT" && i.url.endsWith("/ok"),
    ),
  );

  await page("Runtime.evaluate", {
    expression: `(()=>{const f=document.createElement('iframe');f.src='http://127.0.0.2:${server.address().port}/ok';document.body.append(f)})()`,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const denied = await collect(
    '()=>({url:document.URL,text:document.body?.textContent||""})',
  );
  assert.ok(denied.frames.some((f) => f.frameId === 0));
  assert.ok(denied.report.issues.some((i) => i.code === "PERMISSION_DENIED"));
  console.log(
    "[frame-read-browser] Real chrome.scripting APIs passed: pending about:blank, healthy-frame retention, payload timeout and permission isolation",
  );
} finally {
  sockets.forEach((socket) => socket.close());
  child.kill();
  pendingResponses.forEach((response) => response.destroy());
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
