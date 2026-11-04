import assert from "node:assert/strict";
import {
  VisionGuiTool,
  validateVisionGuiArgs,
} from "../../tools/vision/gui-tool";
import { VISION_GUI_ACTIONS } from "../../tools/vision/gui-contract";
import { toolRegistry } from "../../tools/registry";
import { OpenAIToolsConverter } from "../../entrypoints/sidepanel/utils/tools/openai-tools-converter";
import {
  needsVisionRefresh,
  takeVisionToolImage,
} from "../../entrypoints/sidepanel/core/conversation/vision-feedback";
import {
  normalizeToolIds,
  normalizeAgentConfig,
} from "../../utils/agents/agent-types";
import { normalizeAllowedToolList } from "../../utils/skills/skill-types";
import { migrateVisionToolPrompt } from "../../utils/tools/vision-tool-migration";
import { resolveActionDefinition } from "../../entrypoints/sidepanel/components/tool/types";
import { categories } from "../../entrypoints/sidepanel/components/tool/tool-definitions";

const gui = new VisionGuiTool();
const point = { x: 0.25, y: 1000 };
const valid = {
  click: {
    point,
    button: "middle",
    count: 3,
    modifiers: ["Shift"],
    holdMs: 3000,
  },
  drag: {
    from: point,
    to: { x: 1000, y: 0 },
    waypoints: Array.from({ length: 128 }, () => point),
    durationMs: 3000,
    holdBeforeMs: 0,
    holdAfterMs: 3000,
    button: "right",
    modifiers: ["Alt"],
  },
  input: {
    point,
    text: "你好👩‍💻",
    clear: true,
    clickFirst: false,
    inputMode: "text",
  },
  hover: { point, durationMs: 200, modifiers: ["Control"] },
  keyboard: { keys: ["ControlRight", "ShiftLeft", "NumpadEnter"] },
  scroll: {
    point,
    deltaX: 1.5,
    deltaY: -20000,
    durationMs: 200,
    modifiers: ["Alt"],
  },
  mark: {},
  inspect: { id: 1 },
  zoom: { region: { x: 0, y: 0, width: 1000, height: 1000 }, scale: 4 },
  check: {
    point,
    timeoutMs: 5000,
    stableMs: 500,
    expect: {
      urlIncludes: "example",
      textIncludes: "ready",
      nameIncludes: "Save",
      enabled: true,
      editable: false,
      checked: false,
      valueEquals: "",
    },
  },
};
assert.deepEqual(Object.keys(valid), [...VISION_GUI_ACTIONS]);
assert.equal(toolRegistry.getTool("vision_gui")?.name, "vision_gui");
for (const action of VISION_GUI_ACTIONS) {
  assert.equal(
    toolRegistry.getTool(`vision_${action}`),
    undefined,
    "Legacy tools must not remain executable",
  );
  validateVisionGuiArgs({ action, screenshotId: "s", ...valid[action] });
  const call = {
    function: { name: "vision_gui", arguments: JSON.stringify({ action }) },
  };
  assert.equal(
    needsVisionRefresh([call], [], () => "none"),
    !["inspect", "zoom", "check"].includes(action),
    `${action} lifecycle overrides whole-tool metadata`,
  );
  assert.equal(
    OpenAIToolsConverter.requiresApproval("vision_gui", {
      action,
      confirm: true,
      description: "删除",
    }),
    ["click", "drag", "input", "keyboard", "scroll"].includes(action),
    `${action} preserves semantic approval`,
  );
  assert.equal(
    OpenAIToolsConverter.requiresApproval("vision_gui", {
      action,
      description: "删除",
    }),
    ["click", "drag", "input", "keyboard", "scroll"].includes(action),
    `${action} preserves keyword fallback`,
  );
  assert.equal(
    OpenAIToolsConverter.requiresApproval("vision_gui", {
      action,
      description: "打开菜单",
    }),
    false,
  );
  const branch = gui.openaiSchema.function.parameters.anyOf!.find(
    (b) => (b.properties as any).action.enum[0] === action,
  )!;
  assert.ok(branch && branch.additionalProperties === false);
  for (const key of branch.required as string[]) {
    const missing: Record<string, unknown> = {
      action,
      screenshotId: "s",
      ...valid[action],
    };
    delete missing[key];
    assert.throws(
      () => validateVisionGuiArgs(missing),
      `${action} requires ${key}`,
    );
  }
  for (const foreign of [
    "code",
    "tabId",
    "parameters",
    "screenshotMode",
    "elementId",
  ]) {
    assert.throws(
      () =>
        validateVisionGuiArgs({
          action,
          screenshotId: "s",
          ...valid[action],
          [foreign]: "bad",
        }),
      `${action} rejects ${foreign}`,
    );
  }
}
for (const raw of [
  null,
  [],
  true,
  "click",
  {},
  { action: "constructor" },
  { action: "__proto__" },
  { action: "click", screenshotId: "s", point: { x: NaN, y: 1 } },
  { action: "scroll", screenshotId: "s", deltaX: 0, deltaY: 0 },
  {
    action: "scroll",
    screenshotId: "s",
    direction: "down",
    percent: 30,
    deltaY: 1,
  },
  { action: "keyboard", screenshotId: "s", keys: ["Ctrl", "ControlLeft"] },
  { action: "input", screenshotId: "s", point, text: "\n", inputMode: "keys" },
  {
    action: "drag",
    screenshotId: "s",
    ...valid.drag,
    waypoints: Array(129).fill(point),
  },
  { action: "hover", screenshotId: "s", point, durationMs: Infinity },
  { action: "inspect", screenshotId: "s", id: 1, point },
  {
    action: "zoom",
    screenshotId: "s",
    ...valid.zoom,
    region: { x: 999, y: 0, width: 2, height: 1 },
  },
  { action: "check", screenshotId: "s", viewId: "", point },
  { action: "check", screenshotId: "s", expect: { enabled: true } },
  { action: "check", screenshotId: "s", expect: { textIncludes: " " } },
  { action: "check", screenshotId: "s", timeoutMs: 5001 },
  { action: "zoom", screenshotId: "s", ...valid.zoom, confirm: true },
  { action: "click", screenshotId: "s", ...valid.click, expect: {} },
]) {
  const result = await gui.execute(raw);
  assert.equal(result.success, false, JSON.stringify(raw));
  assert.equal(result.data!.diagnostic.code, "INVALID_ARGUMENT");
  assert.equal(result.data!.diagnostic.retryAutomatically, false);
}
const immutable = {
  action: "drag",
  screenshotId: "s",
  ...structuredClone(valid.drag),
};
const validated = validateVisionGuiArgs(immutable);
immutable.waypoints[0].x = 999;
assert.equal((validated.parameters as any).waypoints[0].x, 0.25);
validateVisionGuiArgs({ action: "input", screenshotId: "s", point, text: "" });
validateVisionGuiArgs({
  action: "scroll",
  screenshotId: "s",
  direction: "left",
  percent: 0.001,
});
const call = (action: string) => ({
  function: { name: "vision_gui", arguments: JSON.stringify({ action }) },
});
assert.equal(
  needsVisionRefresh([call("click"), call("check")], [], () => "none"),
  true,
  "Read after gesture must not cancel pending capture",
);
assert.equal(
  needsVisionRefresh(
    [{ function: { name: "vision_gui", arguments: "{" } }],
    [],
    () => "none",
  ),
  true,
);
const fake = {
  success: true,
  data: { screenshot: "data:image/png;base64,cG5n", text: "crop" },
};
assert.equal(
  takeVisionToolImage(fake, 0, "vision_gui", { action: "check" }),
  null,
  "Non-zoom GUI result cannot impersonate image producer",
);
assert.equal(
  takeVisionToolImage(fake, 0, "vision_gui", { action: "zoom" })?.kind,
  "region",
);
assert.equal(
  needsVisionRefresh(
    [call("click"), call("zoom")],
    [{ callIndex: 1, image: "crop", description: "crop", kind: "region" }],
    () => "none",
  ),
  true,
);
const legacy = VISION_GUI_ACTIONS.map((a) => `vision_${a}`);
assert.deepEqual(
  normalizeToolIds([...legacy, "vision_gui", "vision_read_zoom"]),
  ["vision_gui", "vision_read_zoom"],
);
assert.deepEqual(normalizeAllowedToolList(legacy), ["vision_gui"]);
const prompt = migrateVisionToolPrompt(
  "vision_click(point); vision_read_zoom; vision_check(expect)",
);
assert.ok(
  prompt.includes('vision_gui(action="click", point)') &&
    prompt.includes("vision_read_zoom"),
);
assert.equal(
  migrateVisionToolPrompt(prompt),
  prompt,
  "Migration is idempotent",
);
assert.equal(
  normalizeAgentConfig({
    id: "custom",
    name: "custom",
    system: "vision_click",
    tools: legacy,
  })?.system,
  'vision_gui(action="click")',
);
const ui = categories
  .flatMap((c) => c.tools)
  .find((t) => t.name === "vision_gui")!;
const drag = resolveActionDefinition(ui, "drag");
assert.ok(
  drag.required.includes("from") && !Object.hasOwn(drag.parameters, "text"),
);
assert.deepEqual(
  Object.keys(resolveActionDefinition(ui, undefined).parameters),
  ["action"],
);
assert.deepEqual(
  Object.keys(resolveActionDefinition(ui, "constructor").parameters),
  ["action"],
);
console.log(
  "[vision-gui] All ten actions, action boundaries, approval, lifecycle, image provenance, migration and test-panel schemas passed.",
);

assert.equal(
  migrateVisionToolPrompt(
    'vision_click({"screenshotId":"s","point":{"x":1,"y":2}})',
  ),
  'vision_gui({"action":"click","screenshotId":"s","point":{"x":1,"y":2}})',
);
assert.equal(
  migrateVisionToolPrompt("vision_mark({})"),
  'vision_gui({"action":"mark"})',
);
