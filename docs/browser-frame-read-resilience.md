# Browser frame reads: collection and failure isolation

## Evidence and references

The Alibaba SSO diagnosis established that an immediate injection entered the
same `about:blank` document where a default injection never entered its function
during the observation window. The main document executed normally. This proves
a pre-execution scheduling stall, not a DOM scanning loop. It does not establish
the Chromium internal lifecycle cause.

- [Chrome scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting#method-executeScript): default scheduling is document_idle; injectImmediately skips that wait; returned promises are awaited.
- [Chrome webNavigation](https://developer.chrome.com/docs/extensions/reference/api/webNavigation#frame_ids): frame IDs survive navigation, document IDs identify individual documents; navigation/BFCache events have distinct lifecycles.
- [Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts): isolated-world variables are separate from page variables; related about/data/blob documents and host permissions have distinct rules.
- [Extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle): workers can stop and lose globals. In-memory snapshots are session conveniences, not durable storage; missing snapshots require a fresh query.
- [WebExtensions executeScript](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript): permission and per-frame error behavior differ between browsers. Handle rejected calls, missing rows and returned error rows separately.
- [Playwright actionability](https://playwright.dev/docs/actionability) and [locators](https://playwright.dev/docs/locators): node identity, visibility, enabled/inert state and event reception can change between discovery and use. Observation validates references before delivery; actions must still validate at execution time.

## Read pipeline

`tools/common/frame-read.ts` supplies `readPageFrames` for read-only functions.

1. For all-frame reads, bounded webNavigation enumeration and a minimal immediate
   injection run together. Their union covers navigation-known but inaccessible
   documents as well as initial blank documents omitted by navigation enumeration.
   Discovery failure is reported, never silently called complete.
2. Read each discovered document separately, pinned by documentId where provided.
   Never replace a disappeared document with a newly navigated one without a new
   query. Prioritize the main frame; use four concurrent reads, at most 128 frames,
   3.5 seconds per frame, and a 12-second total collection budget by default.
3. Return successes in stable frame order. Preserve frame-specific timeout,
   permission, missing-result, function-error and document-change information.
   Log failures with operation/frame/document identity and sanitized URL metadata.
4. A fully failed collection throws `PageReadError` with the same diagnostic
   report. A partial collection returns usable data and the report.

Discovery has its own 1.2-second budget. Unknown or unavailable discovery is
explicitly partial. A successful read of an empty document is different from a
missing value. The collector does not reload pages, delete iframes, change
permissions, switch execution worlds, attach a debugger, or replay a payload.

`executeScriptBounded` is the separate one-dispatch wrapper for actions, file
injection and arbitrary script execution. It bounds scheduling and result waits
and defaults to immediate injection. It never falls back or retries. Script and
element-wait tools retain their requested timeout plus transport allowance.
An action timeout means **execution may still be in progress**, not that it was
never dispatched.

## Outputs and scope

Text, read_website, HTML, page information, resource and upload-control reads expose
`frameDiagnostics`. Text pagination caches preserve the report. Markdown
archives retain a `.frames.json` diagnostic sidecar; file continuation verifies
its schema and SHA-256 against the current text before applying that report. Missing,
corrupt or mismatched metadata is reported without discarding readable text. DOM exploration
preserves cross-frame lookup coverage with its snapshot. Observe returns phase
reports (scan, document validation, reference validation, optional focus), `partial`
and `omittedElements`. It preserves frozen page membership and only delivers
references that passed current document/node checks. New frames are explicitly
outside a frozen snapshot; a fresh query includes them. Failed focus collection
does not discard verified controls.

Example failure record:

```json
{
  "frameId": 38,
  "documentId": "document-identity",
  "url": "about:blank",
  "stage": "read",
  "code": "INJECTION_TIMEOUT",
  "message": "Wait exceeded its budget; dispatched code may still run"
}
```

`status: complete` describes successful collection of discovered documents, not
complete website content. Rendered DOM cannot promise unrendered virtual rows,
canvas text, future SPA updates or inaccessible roots. `coverage.complete` remains
false. DOM and Markdown traversals have cooperative time/node/size budgets and
report truncation. AX collection and cross-tab search also have total budgets.
Permission failures stay permission failures; no bypass is attempted.

## Review of failure boundaries

| Scenario | Behavior |
| --- | --- |
| Default idle injection never enters a blank child | Read payloads use immediate per-document injection; discovery and reads have separate deadlines. |
| Renderer/API promise never settles | Stop waiting within the configured budget; retain completed frames and identify the timed-out phase/document. |
| Cancel before dispatch or while queued | Do not dispatch expired work; cancel pending waits promptly. Already dispatched code cannot be recalled. |
| Navigation, removed frame, replaced seed | Pin document identity when available and registered node identity after lookup; reject stale references rather than substitute a target. |
| One stale control among healthy controls | Omit the invalid reference and report element scope; preserve verified controls from that frame. |
| Mutation during optional focus read | Collect focus before final reference validation; focus failure preserves independently verified controls. |
| Many frames or large DOM/text/table | Limit concurrency, frames, traversal and retained text; report skipped/truncated coverage. Limits bound work, not website completeness. |
| Cyclic shadow hit/focus chains | Detect repeated nodes and depth overflow; return a readable failure instead of looping. |
| Missing permission or protected page | Return the original permission/restriction classification; no permission expansion or fallback action replay. |
| Invalid result/error/serialization shape | Validate transport and domain payloads; isolate malformed frames; bound error text and serialization traversal. |
| Same URL in multiple tabs or a new document | Upload cache reuse checks tab/document identities; page one recollects. |
| Changed archived text or invalid metadata | Verify body hash and report schema; return readable text with a diagnostic note when provenance cannot be verified. |
| Action/API timeout after dispatch | Report uncertain execution; never automatically repeat a click, fill, submit or arbitrary script. |
| Extension worker restart | In-memory snapshots may be unavailable; request a fresh collection. Archived text keeps its separate diagnostic metadata. |

Frame failures, coverage truncation and individual element omissions have separate
scopes. The code cannot infer a Chromium internal cause from an API that only
returns a timeout or generic error; diagnostics record the observed failure and
its location instead of asserting an unverified root cause.

## Regression checks

- `tests/tools/frame-read.test.ts`: initial blank discovery, independently failing
  frames, stalled discovery/read calls, total budget, late replies, document
  replacement, empty/exceptional results, argument validation, cancellation and
  frame limits, explicit document targets, retained-content budgets, hostile error
  objects and safe serialization of sparse arrays and literal `__proto__` keys.
- `tests/tools/frame-read-tools.test.ts`: partial text/HTML/control results,
  stale-frame and per-element omission, all-stale rejection, focus failure,
  mutation during focus collection, and cancelled/expired queue work.
- `tests/tools/element-interaction.test.ts`: pagination and fresh per-frame scans,
  including explicit new-frame coverage for frozen snapshots and cyclic shadow hit testing.
- `tests/tools/dom-explore.test.ts`: replacing a seed between lookup and exploration
  reports a stale reference rather than silently selecting the replacement node.
- `tests/tools/tools.test.ts`: archived-content continuation with invalid metadata
  schemas and changed body hashes.
- `npm run test:frame-read-browser`: actual extension `chrome.scripting` APIs in
  a temporary Chromium profile (Edge by default on Windows), including real
  Markdown/control payloads, a pending blank document, denied host and a payload
  that never settles. No user's extension/profile is loaded by the test.
- `npm run compile`, `npm run test:tools`, `npm run test:text-browser`.

Latest review verification (2026-11-15): TypeScript checking passed; the full tool
runner passed 2,445 checks with zero failures; both real-browser probes passed;
the Chrome MV3 production build completed. (The duplicate `MAX_FIELDS` auto-import
and static/dynamic chunk warnings noted then were fixed on 2026-11-18.) These checks
do not replace testing the original authenticated SSO session after extension reload.

Browser timeouts end the extension's wait; they cannot terminate a synchronous
renderer task. Cooperative payload budgets reduce that risk but cannot interrupt
one blocking native DOM call or regular-expression evaluation. Late API replies
cannot mutate the results already returned to a caller. Expired queued text work
is not dispatched later, and active gesture locks are never forcibly released.

For the original SSO page, rebuild/reload the extension and repeat both tools in
the user's authenticated browser. Verify that the blank child either succeeds
immediately or is identified in a partial report while main-page results survive.
