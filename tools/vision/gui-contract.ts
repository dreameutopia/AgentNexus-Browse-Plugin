/** Public action identities and lifecycle rules. No browser/runtime dependencies. */
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
/** Unknown/malformed actions conservatively trigger screenshot recovery. */
export function visionGuiRefresh(args: unknown): "none" | "after" {
  const action = visionGuiAction(args);
  return action && ["inspect", "zoom", "check"].includes(action)
    ? "none"
    : "after";
}
