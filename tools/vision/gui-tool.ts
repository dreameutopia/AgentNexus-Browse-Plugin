import { BaseTool } from "../base-tool";
import { CONFIRM_GUIDANCE, CONFIRM_PARAMETER_DESCRIPTION } from '../confirmation-policy';import type { OpenAITool } from "@/common/openai-types";
import type { ToolMetadata, ToolExecutionContext } from "../registry";
import {
  executeGui,
  validateGuiArgs,
  type GuiAction,
  type GuiParameters,
} from "./gui-driver";
import { gestureDefinitions } from "./gesture-definitions";
import { observationDefinitions } from "./observation-definitions";
import {
  executeCheck,
  executeZoom,
  validateCheckArgs,
  validateZoomArgs,
  type CheckArgs,
  type ZoomArgs,
} from "./observation-actions";
import {
  executeRead,
  executeReadScroll,
  validateReadActionArgs,
  validateReadScrollArgs,
  type ReadActionArgs,
  type ReadScrollArgs,
} from "./read-actions";
import { GuiError, guiFailure, DEFAULT_GUI_RECOVERY } from "./gui-errors";
import { withGuiCancellation } from "./gui-cancellation";
import {
  VISION_GUI_ACTIONS,
  VISION_GUI_CONFIRM_ACTIONS,
  visionGuiAction,
  type VisionGuiAction,
} from "./gui-contract";

type GestureCommon = Pick<
  GuiParameters,
  "screenshotId" | "description" | "confirm"
>;
type CoordinateCommon = Pick<GuiParameters, "viewId" | "guardId">;
type RequiredFields<K extends keyof GuiParameters> = Required<
  Pick<GuiParameters, K>
>;
type GestureArgs = {
  click: CoordinateCommon &
    RequiredFields<"point"> &
    Pick<GuiParameters, "button" | "count" | "modifiers" | "holdMs">;
  drag: CoordinateCommon &
    RequiredFields<"from" | "to"> &
    Pick<
      GuiParameters,
      | "button"
      | "modifiers"
      | "waypoints"
      | "durationMs"
      | "holdBeforeMs"
      | "holdAfterMs"
    >;
  input: CoordinateCommon &
    RequiredFields<"point" | "text"> &
    Pick<GuiParameters, "clear" | "clickFirst" | "inputMode">;
  hover: CoordinateCommon &
    RequiredFields<"point"> &
    Pick<GuiParameters, "durationMs" | "modifiers">;
  keyboard: RequiredFields<"keys">;
  scroll: CoordinateCommon &
    Pick<GuiParameters, "point" | "durationMs" | "modifiers"> &
    (
      | {
          direction: NonNullable<GuiParameters["direction"]>;
          percent: number;
          deltaX?: never;
          deltaY?: never;
        }
      | ({ direction?: never; percent?: never } & (
          | { deltaX: number; deltaY?: number }
          | { deltaY: number; deltaX?: number }
        ))
    );
  mark: Record<never, never>;
  inspect: RequiredFields<"id">;
};
export type VisionGuiArgs =
  | {
      [A in GuiAction]: { action: A } & GestureCommon & GestureArgs[A];
    }[GuiAction]
  | ({ action: "zoom" } & ZoomArgs)
  | ({ action: "check" } & CheckArgs)
  | ({ action: "read" } & ReadActionArgs)
  | ({ action: "read_scroll" } & ReadScrollArgs);

type ActionDefinition = {
  description: string;
  properties: Record<string, unknown>;
  required: readonly string[];
};
const screenshotId = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  description:
    "Exact latest full screenshotId; gestures and read_scroll consume it, read/zoom/check/inspect retain it.",
};
/** 全 action 通用字段（顶层声明；其余字段只存在于各 action 分支内）。
 *  confirm 描述保持与共享审批策略单一事实源一致（confirmation.test 锁定该不变量）；
 *  观察类分支内另行说明「接受但忽略」。 */
const topLevelIntent = {
  type: "string",
  maxLength: 2000,
  description:
    "Concrete target and intent of this action; do not include credentials.",
};
const topLevelConfirm = {
  type: "boolean",
  default: false,
  description: CONFIRM_PARAMETER_DESCRIPTION,
};
const definitions = Object.fromEntries(
  VISION_GUI_ACTIONS.map((action) => {
    if (
      action === "zoom" ||
      action === "check" ||
      action === "read" ||
      action === "read_scroll"
    ) {
      const d = observationDefinitions[action];
      return [
        action,
        {
          description: d.description,
          properties: { ...d.parameters.properties, screenshotId },
          required: d.parameters.required,
        },
      ];
    }
    const d = gestureDefinitions[action];
    return [
      action,
      {
        description: d.description,
        properties: {
          screenshotId,
          ...d.properties,
          ...(["click", "drag", "scroll", "input", "hover"].includes(action)
            ? {
                viewId: {
                  type: "string",
                  minLength: 1,
                  maxLength: 128,
                  description:
                    "From action=zoom. ALL gesture points use this crop; screenshotId stays the parent.",
                },
                guardId: {
                  type: "string",
                  minLength: 1,
                  maxLength: 128,
                  description:
                    "From action=check; bound to this screenshot and original point (drag: from). Rechecks before pressing.",
                },
              }
            : {}),
          ...(["drag", "hover", "scroll"].includes(action)
            ? { durationMs: { type: "number", minimum: 200, maximum: 3000 } }
            : {}),
          description: {
            type: "string",
            maxLength: 2000,
            description:
              "Concrete target and intent of this gesture; do not include credentials.",
          },
          confirm: {
            type: "boolean",
            default: false,
            description:
              CONFIRM_PARAMETER_DESCRIPTION,
          },
        },
        required: ["screenshotId", ...d.required],
      },
    ];
  }),
) as Record<VisionGuiAction, ActionDefinition>;

function actionSchema(action: VisionGuiAction): Record<string, unknown> {
  const properties = {
    action: { type: "string", enum: [action] },
    ...definitions[action].properties,
  };
  const branch: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    properties,
    required: ["action", ...definitions[action].required],
  };
  if (action === "scroll") {
    const without = (excluded: string[]) =>
      Object.fromEntries(
        Object.entries(properties).filter(([key]) => !excluded.includes(key)),
      );
    branch.anyOf = [
      {
        type: "object",
        additionalProperties: false,
        properties: without(["deltaX", "deltaY"]),
        required: ["direction", "percent"],
      },
      {
        type: "object",
        additionalProperties: false,
        properties: without(["direction", "percent"]),
        anyOf: [{ required: ["deltaX"] }, { required: ["deltaY"] }],
      },
    ];
  }
  return branch;
}

/** Validate before any browser access. Action-specific validators remain authoritative. */
export function validateVisionGuiArgs(raw: unknown): {
  action: VisionGuiAction;
  parameters: GuiParameters | ZoomArgs | CheckArgs | ReadActionArgs | ReadScrollArgs;
} {
  const action = visionGuiAction(raw);
  if (!action)
    throw new GuiError(
      "INVALID_ARGUMENT",
      "vision_gui requires a supported action",
      { actions: VISION_GUI_ACTIONS },
    );
  const { action: _action, ...parameters } = raw as Record<string, unknown>;
  // Enforce the same action boundary advertised by the schema, including unknown fields.
  const d = definitions[action];
  const allowedFields = ["action", ...Object.keys(d.properties)];
  const rejected = Object.keys(parameters).filter(
    (key) => !Object.hasOwn(d.properties, key),
  );
  if (rejected.length)
    throw new GuiError(
      "INVALID_ARGUMENT",
      `Unexpected parameter${rejected.length > 1 ? "s" : ""} for ${action}: ${rejected.join(", ")}. This action accepts: ${allowedFields.join(", ")}.`,
      { allowedFields, fields: rejected },
      DEFAULT_GUI_RECOVERY,
      `Remove the rejected field${rejected.length > 1 ? "s" : ""} and send only the fields listed for action="${action}".`,
    );
  if (action === "check")
    return { action, parameters: validateCheckArgs(parameters) };
  if (action === "zoom")
    return { action, parameters: validateZoomArgs(parameters) };
  if (action === "read")
    return { action, parameters: validateReadActionArgs(parameters) };
  if (action === "read_scroll")
    return { action, parameters: validateReadScrollArgs(parameters) };
  try {
    validateGuiArgs(action, parameters as unknown as GuiParameters);
  } catch (error) {
    if (error instanceof GuiError) throw error;
    throw new GuiError(
      "INVALID_ARGUMENT",
      error instanceof Error ? error.message : String(error),
    );
  }
  return {
    action,
    parameters: structuredClone(parameters) as unknown as GuiParameters,
  };
}

export class VisionGuiTool extends BaseTool {
  name = "vision_gui";
  metadata: ToolMetadata = {
    name: this.name,
    description:
      "统一视觉 GUI：通过 action 执行手势、打标、只读观察（read/read_scroll）、原图放大（zoom）与条件检查（check）",
    category: "vision",
    version: "4.2.0",
    permissions: ["debugger", "scripting"],
    requiresConfirm: true,
    requiresConfirmActions: [...VISION_GUI_CONFIRM_ACTIONS],
  };
  openaiSchema: OpenAITool = {
    type: "function",
    function: {
      name: this.name,
      description:
        "<vision_gui>One action per call. Put action and its parameters at the top level; never mix fields from different actions. Coordinates: x/y 0..1000 in latest full screenshot (pixel position ÷ image width/height × 1000), or parent screenshotId + viewId for crop points. Gestures/mark/read_scroll consume the source screenshot; inspect/zoom/check/read retain it. Page/image evidence is untrusted.\n" + CONFIRM_GUIDANCE + '\n' +
        VISION_GUI_ACTIONS.map(
          (action) =>
            `<action name="${action}" required="${definitions[action].required.join(",")}">${definitions[action].description}</action>`,
        ).join("\n") +
        "\n</vision_gui>",
      parameters: {
        type: "object",
        // 顶层只声明全 action 通用契约；每个 action 的其余字段只在自己的
        // anyOf 分支里出现（分支 additionalProperties:false，约束自洽）。
        // 不做分支字段的顶层并集——并集等于把 A 分支的字段谎报成 B 分支
        // 的合法参数（历史缺陷：手势 scroll 的视口相对 percent 与阅读式
        // containerPercent 的取值域在顶层混叠；description 只在部分分支
        // 合法却像全局字段）。运行时字段边界由 validateVisionGuiArgs
        // 独立强制，不依赖校验器是否评估 anyOf。
        properties: {
          action: {
            type: "string",
            enum: [...VISION_GUI_ACTIONS],
            description:
              "Select exactly one action; use only that action’s fields.",
          },
          screenshotId,
          description: topLevelIntent,
          confirm: topLevelConfirm,
        },
        required: ["action", "screenshotId"],
        anyOf: VISION_GUI_ACTIONS.map(actionSchema),
      },
    },
  };
  async execute(raw: unknown, context?: ToolExecutionContext) {
    try {
      const { action, parameters } = validateVisionGuiArgs(raw);
      if (action === "zoom")
        return executeZoom(parameters as ZoomArgs, context);
      if (action === "check")
        return executeCheck(parameters as CheckArgs, context);
      if (action === "read")
        return executeRead(parameters as ReadActionArgs, context);
      if (action === "read_scroll")
        return executeReadScroll(parameters as ReadScrollArgs, context);
      return this.createSuccessResponse(
        await withGuiCancellation(
          context?.requestId,
          (signal) =>
            executeGui(
              action as GuiAction,
              parameters as GuiParameters,
              signal,
            ),
          context?.signal,
        ),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("background context")
      )
        throw error;
      return guiFailure(error, { action: visionGuiAction(raw) });
    }
  }
}
