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
  read: {},
  read_scroll: { direction: "down", containerPercent: 75 },
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
    needsVisionRefresh([call], [], () => true),
    !["inspect", "zoom", "check", "read"].includes(action),
    `${action} lifecycle overrides whole-tool metadata`,
  );
  assert.equal(
    OpenAIToolsConverter.requiresApproval("vision_gui", {
      action,
      confirm: true,
      description: "删除重要数据",
    }),
    ["click", "drag", "input", "keyboard", "scroll"].includes(action),
    `${action} preserves semantic approval`,
  );
  assert.equal(
    OpenAIToolsConverter.requiresApproval("vision_gui", {
      action,
      description: "删除重要数据",
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
  { action: "read_scroll", screenshotId: "s" },
  { action: "read_scroll", screenshotId: "s", direction: "down", containerPercent: 0 },
  { action: "read_scroll", screenshotId: "s", direction: "down", containerPercent: 101 },
  // 百分比分名：容器相对用 containerPercent，视口相对的 percent 属于手势 scroll
  { action: "read_scroll", screenshotId: "s", direction: "down", percent: 50 },
  { action: "read", screenshotId: "s", point: { x: 0, y: 0, z: 1 } },
  { action: "read", point: { x: 0, y: 0 } },
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
  needsVisionRefresh([call("click"), call("check")], [], () => true),
  true,
  "Read after gesture must not cancel pending capture",
);
assert.equal(
  needsVisionRefresh(
    [{ function: { name: "vision_gui", arguments: "{" } }],
    [],
    () => true,
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
    () => true,
  ),
  true,
);
const ui = categories
  .flatMap((c) => c.tools)
  .find((t) => t.name === "vision_gui")!;
// 顶层合并 schema 是各 action 分支的并集：同名参数若语义不同必须分名，
// 否则后合并者会覆盖前者（手势 scroll 的 percent 视口相对 vs 阅读式滚动的
// 容器相对）——顶层就会对某一族 action 谎报取值范围。
{
  const params = new VisionGuiTool().openaiSchema.function.parameters as {
    properties: Record<string, { minimum?: number; maximum?: number }>;
  };
  assert.equal(params.properties.percent.minimum, 0.001, '顶层 percent 保持手势 scroll 的视口相对范围');
  assert.equal(params.properties.percent.maximum, 300);
  assert.equal(params.properties.containerPercent.minimum, 1, '容器相对百分比独立命名');
  assert.equal(params.properties.containerPercent.maximum, 100);
}
const drag = resolveActionDefinition(ui, "drag");
assert.ok(
  drag.required.includes("from") && !Object.hasOwn(drag.parameters, "text"),
);
const read = resolveActionDefinition(ui, "read");
assert.ok(
  read.required.includes("screenshotId") && Object.hasOwn(read.parameters, "region"),
  "Merged read observation is reachable from the test panel",
);
assert.equal(
  takeVisionToolImage(
    { success: true, data: { screenshot: "data:image/png;base64,cG5n", text: "dom" } },
    0,
    "vision_gui",
    { action: "read" },
  ),
  null,
  "Read observation never impersonates an image producer",
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
  "[vision-gui] All twelve actions, action boundaries, approval, lifecycle, image provenance and test-panel schemas passed.",
);
