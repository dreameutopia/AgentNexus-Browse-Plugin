/**
 * vision_gui 只读观察 action：read / read_scroll。
 *
 * 由原独立工具 vision_read / vision_read_scroll 合并而来（vision_read_zoom 并入
 * 既有 zoom、vision_read_wait 已下线），执行仍走与 zoom/check 相同的共享管线：
 * withReadSnapshot（截图身份 + 过期/几何核验 + exclusiveGui 串行）+
 * visionReadPayload（隔离世界的无副作用载荷）。read 保留源截图（consume=false），
 * read_scroll 消耗源截图（consume=true——视口已移动，与手势同语义）。
 *
 * 与 gesture 通道的边界：不发任何 click/focus/wheel/keyboard 事件；
 * read_scroll 用 elementFromPoint + shadow 穿透 + 同源 iframe 下钻做定向
 * DOM scrollTo，报告真实位移，到容器边界不改滚父容器——这是手势 scroll
 * （CDP mouseWheel，按视口百分比）不具备的能力，两者语义不同、并存。
 * 百分比因此分名：手势用 percent（视口相对），阅读式滚动用 containerPercent
 * （目标容器相对）——同名会污染合并后的顶层 schema（两套取值范围互斥）。
 */
import type { ToolExecutionContext } from "../registry";
import type { ToolResult } from "@/common/tool-handler";
import { withReadSnapshot } from "./gui-driver";
import { toViewport, relativePoint, finiteRange, type Viewport } from "./coordinates";
import { imageRegion, type ImageRegion } from "./observation-model";
import { validateObservationObject } from "./observation-actions";
import { visionReadPayload } from "./read-payload";
import { bounded, GuiError, guiFailure } from "./gui-errors";
import { withGuiCancellation } from "./gui-cancellation";

export interface ReadActionArgs {
  screenshotId: string;
  point?: { x: number; y: number };
  region?: ImageRegion;
}
export interface ReadScrollArgs {
  screenshotId: string;
  point?: { x: number; y: number };
  direction: "up" | "down" | "left" | "right";
  /** 目标容器滚动百分比（1..100，默认 75）——与手势 scroll 的 percent（视口相对）分名 */
  containerPercent?: number;
}

/** 只读观察的 action 名（与工具 schema 的 action 取值一致，用于诊断上下文）。 */
export type ObservationAction = "read" | "read_scroll";

export function validateReadActionArgs(raw: unknown): ReadActionArgs {
  const args = validateObservationObject(raw, [
    "screenshotId",
    "point",
    "region",
  ]) as unknown as ReadActionArgs;
  if (args.point !== undefined) relativePoint(args.point);
  // 用归一化后的 region 覆盖原值（imageRegion 已核验键集与边界）
  if (args.region !== undefined) args.region = imageRegion(args.region);
  if (args.point && args.region)
    throw new GuiError("INVALID_ARGUMENT", "Choose point OR region");
  return structuredClone(args);
}

export function validateReadScrollArgs(raw: unknown): ReadScrollArgs {
  const args = validateObservationObject(raw, [
    "screenshotId",
    "point",
    "direction",
    "containerPercent",
  ]) as unknown as ReadScrollArgs;
  if (args.point !== undefined) relativePoint(args.point);
  if (!["up", "down", "left", "right"].includes(args.direction as string))
    throw new GuiError("INVALID_ARGUMENT", "direction must be up/down/left/right");
  if (args.containerPercent !== undefined)
    finiteRange(args.containerPercent, "containerPercent", 1, 100);
  return structuredClone(args);
}

/** 只读观察的统一执行体：隔离世界单次脚本 + 2.5s 有界等待。 */
async function observePayload(
  action: ObservationAction,
  args: ReadActionArgs | ReadScrollArgs,
  tabId: number,
  viewport: Viewport,
): Promise<Record<string, unknown>> {
  const point =
    "point" in args && args.point ? toViewport(args.point, viewport) : undefined;
  const region =
    action === "read" && "region" in args && args.region
      ? {
          x: (args.region.x / 1000) * viewport.width,
          y: (args.region.y / 1000) * viewport.height,
          width: (args.region.width / 1000) * viewport.width,
          height: (args.region.height / 1000) * viewport.height,
        }
      : undefined;
  const direction =
    action === "read_scroll" ? (args as ReadScrollArgs).direction : undefined;
  const containerPercent =
    action === "read_scroll" ? (args as ReadScrollArgs).containerPercent : undefined;
  // 有界等待承担取消语义：超时/取消后结果不再被消费（与原实现一致）。
  // 载荷内的分支名沿用 read/scroll（read_scroll 映射到载荷的 scroll 分支）。
  const results = await bounded(
    chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: "ISOLATED",
      func: visionReadPayload,
      args: [
        action === "read" ? "read" : "scroll",
        { point, region, direction, containerPercent },
      ],
    }),
    2500,
    "Read-only page observation",
  );
  if (!results[0]?.result)
    throw new GuiError("TARGET_UNAVAILABLE", "Observation returned no data");
  return results[0].result as Record<string, unknown>;
}

/** 失败诊断上下文：只带可安全序列化的凭据（模型可能传任意形态的参数）。 */
function failureContext(action: string, raw: unknown): Record<string, unknown> {
  const id =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).screenshotId
      : undefined;
  return {
    action,
    ...(typeof id === "string" && id.length <= 128 ? { screenshotId: id } : {}),
  };
}

/**
 * read / read_scroll 的共同执行路径：校验 → 快照核验 → 隔离世界观察 → 回传。
 * consume 由 action 决定：read 保留源截图，read_scroll 消耗（视口已移动）。
 */
export async function executeObservation(
  action: ObservationAction,
  raw: unknown,
  context?: ToolExecutionContext,
): Promise<ToolResult> {
  try {
    const args =
      action === "read"
        ? validateReadActionArgs(raw)
        : validateReadScrollArgs(raw);
    const data = await withGuiCancellation(
      context?.requestId,
      (signal) =>
        withReadSnapshot(
          args.screenshotId,
          action === "read_scroll",
          signal,
          async (s) => {
            const payload = await observePayload(action, args, s.tabId, s.viewport);
            return { ...payload, sourceScreenshotId: s.id, observedAt: Date.now() };
          },
        ),
      context?.signal,
    );
    const { screenshot: _image, ...metadata } = data as typeof data & {
      screenshot?: string;
    };
    return {
      success: true,
      data,
      content: [{ type: "text" as const, text: JSON.stringify(metadata) }],
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("background context"))
      throw error;
    return guiFailure(error, failureContext(action, raw));
  }
}

export function executeRead(
  raw: unknown,
  context?: ToolExecutionContext,
): Promise<ToolResult> {
  return executeObservation("read", raw, context);
}

export function executeReadScroll(
  raw: unknown,
  context?: ToolExecutionContext,
): Promise<ToolResult> {
  return executeObservation("read_scroll", raw, context);
}
