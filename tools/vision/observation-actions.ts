import type { ToolExecutionContext } from "../registry";
import { buildSuccessPayload } from '@/common/tool-handler';
import { withReadSnapshot } from "./gui-driver";
import { toViewport, relativePoint, finiteRange } from "./coordinates";
import { cropOriginalImage } from "./image-region";
import { checkPagePayload, type VisualExpectation } from "./check-payload";
import {
  imageRegion,
  mapViewPoint,
  registerTargetGuard,
  registerView,
  type ImageRegion,
} from "./observation-model";
import { bounded, GuiError, guiFailure } from "./gui-errors";
import { withGuiCancellation } from "./gui-cancellation";

export interface CheckArgs {
  screenshotId: string;
  point?: { x: number; y: number };
  viewId?: string;
  expect?: VisualExpectation;
  timeoutMs?: number;
  stableMs?: number;
}
export interface ZoomArgs {
  screenshotId: string;
  region: ImageRegion;
  scale?: number;
}
export function validateZoomArgs(raw: unknown): ZoomArgs {
  const args = validateObject(raw, [
    "screenshotId",
    "region",
    "scale",
  ]) as unknown as ZoomArgs;
  imageRegion(args.region);
  if (args.scale !== undefined) finiteRange(args.scale, "scale", 1, 4);
  return structuredClone(args);
}
function validateObject(
  raw: unknown,
  fields: string[],
): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new GuiError("INVALID_ARGUMENT", "Parameters must be an object");
  if (Object.keys(raw).some((k) => !fields.includes(k)))
    throw new GuiError(
      "INVALID_ARGUMENT",
      "Unexpected observation parameters",
      { allowedFields: fields },
    );
  const args = raw as Record<string, unknown>;
  if (
    typeof args.screenshotId !== "string" ||
    !args.screenshotId ||
    args.screenshotId.length > 128
  )
    throw new GuiError("INVALID_ARGUMENT", "Latest screenshotId is required");
  return args;
}
export function validateCheckArgs(raw: unknown): CheckArgs {
  const args = validateObject(raw, [
    "screenshotId",
    "point",
    "viewId",
    "expect",
    "timeoutMs",
    "stableMs",
  ]) as unknown as CheckArgs;
  if (args.point !== undefined) relativePoint(args.point);
  if (
    args.viewId !== undefined &&
    (typeof args.viewId !== "string" ||
      !args.viewId ||
      args.viewId.length > 128 ||
      !args.point)
  )
    throw new GuiError(
      "INVALID_ARGUMENT",
      "viewId requires a point and a nonempty view ID",
    );
  if (args.timeoutMs !== undefined)
    finiteRange(args.timeoutMs, "timeoutMs", 0, 5000);
  if (args.stableMs !== undefined)
    finiteRange(args.stableMs, "stableMs", 0, 500);
  if (args.expect !== undefined) {
    if (
      !args.expect ||
      typeof args.expect !== "object" ||
      Array.isArray(args.expect)
    )
      throw new GuiError("INVALID_ARGUMENT", "expect must be an object");
    const fields = [
      "urlIncludes",
      "textIncludes",
      "nameIncludes",
      "enabled",
      "editable",
      "checked",
      "valueEquals",
    ];
    if (Object.keys(args.expect).some((k) => !fields.includes(k)))
      throw new GuiError("INVALID_ARGUMENT", "Unsupported expectation", {
        allowedFields: fields,
      });
    for (const [key, value] of Object.entries(args.expect)) {
      if (["enabled", "editable", "checked"].includes(key)) {
        if (typeof value !== "boolean")
          throw new GuiError("INVALID_ARGUMENT", `${key} must be boolean`);
      } else if (
        typeof value !== "string" ||
        value.length > 1000 ||
        (key !== "valueEquals" && !value.trim())
      )
        throw new GuiError("INVALID_ARGUMENT", `${key} requires bounded text`);
      if (!["urlIncludes", "textIncludes"].includes(key) && !args.point)
        throw new GuiError("INVALID_ARGUMENT", `${key} requires a point`);
    }
  }
  return structuredClone(args);
}
export async function executeZoom(
  raw: ZoomArgs,
  context?: ToolExecutionContext,
) {
  try {
    const args = validateZoomArgs(raw);
    const data = await withGuiCancellation(
      context?.requestId,
      (signal) =>
        withReadSnapshot(args.screenshotId, false, signal, async (s, image) => {
          const cropped = await cropOriginalImage(
            image,
            args.region,
            args.scale ?? 2,
          );
          const viewId = registerView(s.id, cropped.region);
          return {
            ...cropped,
            screenshotId: s.id,
            sourceScreenshotId: s.id,
            sourceCapturedAt: s.time,
            viewId,
            imageKind: "region",
            text: `Zoom viewId=${viewId}, parent screenshotId=${s.id}; crop region=${JSON.stringify(cropped.region)} in full-image 0..1000 coordinates. To act on a crop point use parent screenshotId AND viewId. Without viewId every point means FULL screenshot coordinates. Rounding-adjusted region is authoritative; no new pixels were captured.`,
          };
        }),
      context?.signal,
    );
    const { screenshot: _image, ...metadata } = data;
    return {
      success: true,
      data,
      content: [{ type: "text" as const, text: JSON.stringify(metadata) }],
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("background context"))
      throw error;
    return guiFailure(error, { action: "zoom" });
  }
}

export async function executeCheck(
  raw: CheckArgs,
  context?: ToolExecutionContext,
) {
  try {
    const args = validateCheckArgs(raw);
    const data = await withGuiCancellation(
      context?.requestId,
      (signal) =>
        withReadSnapshot(
          args.screenshotId,
          false,
          signal,
          async (s, _image, guard) => {
            const point = args.point
              ? mapViewPoint(s.id, args.viewId, args.point)
              : undefined;
            const start = Date.now(),
              stableMs = args.stableMs ?? 120,
              end = start + Math.max(args.timeoutMs ?? 0, stableMs + 250);
            let previous = "",
              stableSince = start,
              samples = 0,
              last: ReturnType<typeof checkPagePayload> | undefined,
              stable = false;
            while (samples < 64) {
              await guard();
              const rows = await bounded(
                chrome.scripting.executeScript({
                  target: { tabId: s.tabId, frameIds: [0] },
                  world: "ISOLATED",
                  func: checkPagePayload,
                  args: [
                    point ? toViewport(point, s.viewport) : undefined,
                    args.expect ?? {},
                  ],
                }),
                2000,
                "Check visual target",
              );
              last = rows[0]?.result;
              samples++;
              if (!last)
                throw new GuiError(
                  "TARGET_UNAVAILABLE",
                  "Visual check returned no evidence",
                );
              const signature = JSON.stringify([
                last.target?.signature,
                last.page.readyState,
                last.loading.ariaBusyCount,
                last.dialogs,
              ]);
              if (signature !== previous) stableSince = Date.now();
              previous = signature;
              stable = samples >= 2 && Date.now() - stableSince >= stableMs;
              const allPassed =
                last.checks.length > 0 &&
                last.checks.every((c) => c.status === "passed");
              if (
                (stable &&
                  (allPassed || !Object.keys(args.expect ?? {}).length)) ||
                Date.now() >= end
              )
                break;
              const delay = Math.max(1, Math.min(100, end - Date.now()));
              await new Promise<void>((resolve) => {
                const done = () => {
                  clearTimeout(timer);
                  signal?.removeEventListener("abort", done);
                  resolve();
                };
                const timer = setTimeout(done, delay);
                signal?.addEventListener("abort", done, { once: true });
                if (signal?.aborted) done();
              });
            }
            await guard();
            if (!last)
              throw new GuiError(
                "INTERNAL_ERROR",
                "Visual check produced no samples",
              );
            const status = !last.checks.length
              ? "observed"
              : last.checks.some((c) => c.status === "failed")
                ? "failed"
                : last.checks.some((c) => c.status === "unknown")
                  ? "unknown"
                  : "passed";
            const guardId =
              point &&
              stable &&
              last.target?.enabled &&
              !last.target.opaqueFrame &&
              !last.target.opaqueContent &&
              (status === "observed" || status === "passed")
                ? registerTargetGuard(s.id, point, last.target.signature)
                : undefined;
            return {
              ...last,
              status,
              stable,
              guardId,
              screenshotId: s.id,
              actionPoint: point,
              coordinateSystem: "original full screenshot x/y 0..1000",
              sourceCapturedAt: s.time,
              observedAt: Date.now(),
              samples,
              elapsedMs: Date.now() - start,
              waitBudgetMs: end - start,
              text: `Checks=${status}; target/metadata stable=${stable}. Only the explicit requested conditions are evaluated. ${guardId ? `guardId=${guardId} binds this original action point and screenshot.` : "No target guard issued."} Unknown is not failure or proof of success. No gesture was sent.`,
            };
          },
        ),
      context?.signal,
    );
      return { success: true, ...buildSuccessPayload(data) };
  } catch (error) {
    if (error instanceof Error && error.message.includes("background context"))
      throw error;
    return guiFailure(error, { action: "check" });
  }
}
