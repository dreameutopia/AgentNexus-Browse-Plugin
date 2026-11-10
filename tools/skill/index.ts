/**
 * 技能（Skill）工具集合
 * 提供技能加载、文本分页读取和会话工作区资源复制。
 */

import { toolRegistry } from '../registry';
import { skillTool } from './skill-tool';

// 注册函数
export function registerSkillTools() {
  toolRegistry.register(skillTool);
}

export { skillTool };
