/**
 * 网站学习工具模块
 *
 * 两个终止型（terminal）提交工具，分别作为学习段与验证段的结束信号：
 *   - submit_skill       学习段：交付技能草稿并结束学习；
 *   - submit_validation  验证段：交付验收结论并结束验证。
 *
 * 终止语义由 ToolMetadata.terminal 声明、会话引擎统一消费
 * （见 conversation-engine 的 stopAfterRound），本模块不与引擎耦合。
 * 两工具只在学习场景预设（tool-presets 的 siteLearn*）中出现，
 * 普通对话不会注入，故不会误伤日常会话。
 */

import { toolRegistry } from '../registry';
import { SubmitSkillTool, submitSkillTool } from './submit-skill-tool';
import { SubmitValidationTool, submitValidationTool } from './submit-validation-tool';

/** 注册网站学习工具 */
export function registerLearnTools(): void {
  toolRegistry.register(submitSkillTool);
  toolRegistry.register(submitValidationTool);
}

export { SubmitSkillTool, submitSkillTool };
export { SubmitValidationTool, submitValidationTool };
