/** Public action identities and lifecycle rules. No browser/runtime dependencies.
 * 12 actions in three families:
 *   - gestures (click/drag/input/hover/keyboard/scroll): consume the source screenshot;
 *   - observation (mark/inspect/zoom/check/read): retain the source screenshot;
 *   - reading-scroll (read_scroll): DOM scroll for reading — consumes the source
 *     snapshot like a gesture (the viewport moved) but never asks for approval. */

/** 工具身份的单一事实源：注册名、开关注入归一、提示词钩子检测一律引用此常量，
 * 杜绝字面量散落造成的口径漂移。 */
export const VISION_GUI_TOOL_ID = "vision_gui";

export const VISION_GUI_ACTIONS = [
  "click",
  "drag",
  "input",
  "hover",
  "keyboard",
  "scroll",
  "mark",
  "inspect",
  "zoom",
  "check",
  "read",
  "read_scroll",
] as const;
export type VisionGuiAction = (typeof VISION_GUI_ACTIONS)[number];
export const VISION_GUI_CONFIRM_ACTIONS = [
  "click",
  "drag",
  "input",
  "keyboard",
  "scroll",
] as const;
export function visionGuiAction(args: unknown): VisionGuiAction | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args))
    return undefined;
  const action = (args as Record<string, unknown>).action;
  return typeof action === "string" &&
    VISION_GUI_ACTIONS.includes(action as VisionGuiAction)
    ? (action as VisionGuiAction)
    : undefined;
}
/** Unknown/malformed actions conservatively trigger screenshot recovery.
 * "none" = pure observation that never moves the page or spends the snapshot
 * (inspect/zoom/check/read); everything else — including read_scroll, which
 * changes the viewport — refreshes. */
export function visionGuiRefresh(args: unknown): "none" | "after" {
  const action = visionGuiAction(args);
  return action && ["inspect", "zoom", "check", "read"].includes(action)
    ? "none"
    : "after";
}
