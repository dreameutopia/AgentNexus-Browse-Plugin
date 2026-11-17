/**
 * interact 工具域出口
 *
 * 组成：
 *   - interact-ui-bridge  工具 ↔ UI 桥接（上下文无关，sidepanel 外亦可安全引入）
 *   - interact-tool       工具定义与执行（参数清洗 + 结果转写）
 *   - interact-prompt     固定注入契约（系统提示词分区 + 核心工具 ID + 推荐项规则文案）
 *   - interact-options    推荐项归一（多选项唯一 / 首位 / 带标注的执行侧不变量）
 */

import { toolRegistry } from '../registry';
import { interactTool } from './interact-tool';

/** 注册 interact 工具（registerAllTools 统一调用；重复注册按后写覆盖） */
export function registerInteractTools(): void {
  toolRegistry.register(interactTool);
}

export { interactTool, InteractTool, MULTI_ANSWER_SEPARATOR } from './interact-tool';
export {
  registerInteractHandler,
  getInteractHandler,
  type InteractOption,
  type InteractRequest,
  type InteractResolution,
  type InteractUnansweredStatus,
  type InteractHandler,
} from './interact-ui-bridge';
export {
  CORE_INTERACT_TOOL_IDS,
  INTERACTIVE_TOOL_NAMES,
  INTERACT_SYSTEM_PROMPT_SECTION,
  RECOMMENDED_OPTION_RULE,
} from './interact-prompt';
export { normalizeRecommendedOption, hasRecommendedMarker } from './interact-options';
