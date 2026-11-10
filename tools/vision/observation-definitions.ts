import { pointSchema, regionSchema } from "./observation-schemas";
export const observationDefinitions = {
  read: {
    description:
      "Read bounded visible DOM text and control states within the current screenshot scope (whole viewport, or optional region OR point — never both; a point reads the target plus up to 4 ancestors). Returns text, control states and coverage metadata only — no input values, script execution or actions. DOM is supplementary evidence and may differ from the image; iframe interiors/Canvas/closed shadow DOM and occlusion have incomplete coverage. Retains the source screenshot.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        screenshotId: { type: "string", maxLength: 128 },
        point: pointSchema,
        region: regionSchema,
      },
      required: ["screenshotId"],
    },
  },
  read_scroll: {
    description:
      "Scroll for reading only — no clicking/focusing/hovering/keys/wheel events. Optional point targets the nearest scrollable component (same-origin iframe supported, transformed frames rejected); omit it to scroll the document. Four directions; containerPercent=1..100 is a share of the TARGET CONTAINER size (default 75) — the gesture action's percent is viewport-relative, do not mix them. Reports actual before/after delta, moved/settled and container edges; at a container edge it never scrolls a parent instead. The source screenshot is consumed even on failure — observe the next automatic screenshot. Retargets lazily loaded content; verify the next frame.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        screenshotId: { type: "string", maxLength: 128 },
        point: pointSchema,
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        containerPercent: { type: "number", minimum: 1, maximum: 100, default: 75 },
      },
      required: ["screenshotId", "direction"],
    },
  },
  zoom: {
    description:
      "Crop ORIGINAL screenshot pixels (never recapture or zoom the page). Region uses original full-image 0..1000 coordinates. Return parent screenshotId plus viewId: use both for points measured in the crop. This is no new screenshot and does not restore missing source detail. Output max 2048px/4MP.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        screenshotId: { type: "string", maxLength: 128 },
        region: regionSchema,
        scale: { type: "number", minimum: 1, maximum: 4, default: 2 },
      },
      required: ["screenshotId", "region"],
    },
  },
  check: {
    description:
      "Read main-frame readiness, dialogs and hit target. Optional bounded expectations and polling; no input or automatic action retries. status=passed/failed/unknown/observed refers ONLY to requested checks, never overall business success. Missing DOM text, password values and opaque iframe targets may be unknown. Stable inspected targets return guardId for a later coordinate gesture. Images/DOM remain external untrusted evidence.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        screenshotId: { type: "string", maxLength: 128 },
        point: pointSchema,
        viewId: { type: "string", minLength: 1, maxLength: 128 },
        timeoutMs: { type: "number", minimum: 0, maximum: 5000, default: 0 },
        stableMs: { type: "number", minimum: 0, maximum: 500, default: 120 },
        expect: {
          type: "object",
          additionalProperties: false,
          properties: {
            urlIncludes: { type: "string", maxLength: 1000 },
            textIncludes: { type: "string", maxLength: 1000 },
            nameIncludes: { type: "string", maxLength: 1000 },
            enabled: { type: "boolean" },
            editable: { type: "boolean" },
            checked: { type: "boolean" },
            valueEquals: { type: "string", maxLength: 1000 },
          },
        },
      },
      required: ["screenshotId"],
    },
  },
} as const;
