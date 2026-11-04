import type { GuiAction } from "./gui-driver";

const point = {
  type: "object",
  additionalProperties: false,
  properties: {
    x: { type: "number", minimum: 0, maximum: 1000 },
    y: { type: "number", minimum: 0, maximum: 1000 },
  },
  required: ["x", "y"],
  description:
    "Point relative to entire latest screenshot, x from left, y from top; 0..1000, NOT pixels.",
};
const modifiers = {
  type: "array",
  maxItems: 4,
  uniqueItems: true,
  items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] },
  description:
    "Hold these keys throughout this mouse gesture, then release safely (e.g. Shift-click or Alt-drag).",
};
const button = {
  type: "string",
  enum: ["left", "right", "middle"],
  default: "left",
};
const hold = {
  type: "number",
  minimum: 0,
  maximum: 3000,
  description:
    "Optional hold time in milliseconds; omitted uses a short variable pause.",
};
export const gestureDefinitions: Record<
  GuiAction,
  { description: string; properties: Record<string, any>; required: string[] }
> = {
  click: {
    description:
      "Browser input click: left/right/middle single/double/triple click, modifier keys and optional long press.",
    properties: {
      point,
      button,
      modifiers,
      holdMs: hold,
      count: { type: "integer", minimum: 1, maximum: 3, default: 1 },
    },
    required: ["point"],
  },
  drag: {
    description:
      "Drag precise relative start to end in a straight line with acceleration/deceleration. After pressing, dwell randomly 500..1500ms before moving; dwell independently 500..1500ms at destination before release. Optional waypoints define a freehand path of straight eased segments (all must be visited); durationMs is the TOTAL path movement duration, excluding end holds. Supports buttons/modifiers; explicit holdBeforeMs/holdAfterMs override each random dwell.",
    properties: {
      from: point,
      to: point,
      button,
      modifiers,
      waypoints: { type: "array", maxItems: 128, items: point },
      holdBeforeMs: { ...hold, description: "Hold after mouse-down before movement, 0..3000ms; omitted independently randomizes 500..1500ms." },
      holdAfterMs: { ...hold, description: "Hold at destination before mouse-up, 0..3000ms; omitted independently randomizes 500..1500ms." },
    },
    required: ["from", "to"],
  },
  scroll: {
    description:
      "Move cursor into optional target component, then smooth wheel input. Choose direction+percent OR deltaX/deltaY in CSS pixels (both axes supported). Percent uses full viewport height/width. Omitted point uses viewport center. Modifiers apply to the wheel (e.g. browser/page zoom); inspect next screenshot.",
    properties: {
      point,
      modifiers,
      direction: { type: "string", enum: ["up", "down", "left", "right"] },
      percent: { type: "number", minimum: 0.001, maximum: 300 },
      deltaX: { type: "number", minimum: -20000, maximum: 20000 },
      deltaY: { type: "number", minimum: -20000, maximum: 20000 },
    },
    required: [],
  },
  input: {
    description:
      'Input at a relative editable point. text mode (default) inserts Unicode graphemes; keys mode emits real printable ASCII keyDown/input/keyUp for editors depending on keyboard handlers (US key mapping). Enter/Tab must use vision_gui(action="keyboard"); no automatic submit.',
    properties: {
      point,
      text: { type: "string", maxLength: 10000 },
      clickFirst: { type: "boolean", default: true },
      clear: { type: "boolean", default: false },
      inputMode: { type: "string", enum: ["text", "keys"], default: "text" },
    },
    required: ["point", "text"],
  },
  hover: {
    description:
      "Hover relative point to expose menus/tooltips; durationMs controls dwell. Optional modifier keys.",
    properties: { point, modifiers },
    required: ["point"],
  },
  keyboard: {
    description:
      'Press/release one simultaneous key chord, not a sequence. Supports Control/Shift/Alt/Meta (also Left/Right suffix), Enter/Tab/Escape/Backspace/Delete, ArrowLeft/Up/Right/Down, Home/End/PageUp/PageDown/Insert, CapsLock/NumLock/ScrollLock/ContextMenu/Pause/PrintScreen, Space, F1-F24, ASCII letters/digits/punctuation, Numpad0-9/Enter/Add/Subtract/Multiply/Divide/Decimal. Aliases: Ctrl, Cmd/Command/Win/Super=Meta, Option=Alt, Esc, Return, Del, Ins, Spacebar, Left/Up/Right/Down, PgUp/PgDn. Shift for uppercase/shifted symbols is inferred; use lowercase shortcut letters to avoid unintended Shift. US character mapping. Examples ["Control","a"], ["Control","Shift","z"], ["Shift","Tab"]. Use Meta instead of Control for macOS application shortcuts. Acts on current page focus; focus the intended control first. Clipboard access and browser/OS-reserved shortcuts are not guaranteed by page-level CDP. Use browser/navigation tools for tabs, URL and reload. Observe a fresh screenshot after each chord; never blindly repeat a submit.',
    properties: {
      keys: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        uniqueItems: true,
        items: { type: "string", minLength: 1, maxLength: 32 },
        description:
          'One chord, e.g. ["Control","Shift","ArrowLeft"]. Each named/physical key must be unique, including aliases. Separate sequential chords into separate observed actions.',
      },
    },
    required: ["keys"],
  },
  mark: {
    description:
      'Queue DOM numbered boxes for NEXT automatic screenshot only. Use new screenshotId and vision_gui(action="inspect") for selector/XPath/attributes. Canvas pixels may have no DOM marks.',
    properties: {},
    required: [],
  },
  inspect: {
    description:
      "Read numbered element: frameId, scoped CSS selector/XPath, shadow hosts, attributes, text, rect, editable/disabled/checked state, select options, ancestry. IDs are inspection-only; interact using coordinates.",
    properties: {
      id: { type: "integer", minimum: 1 },
    },
    required: ["id"],
  },
};
