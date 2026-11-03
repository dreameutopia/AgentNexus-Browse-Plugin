/**
 * 技能（Skill）工具集合
 * 提供 skill 的加载（load_skill）与资源读取（read_skill_file）能力，
 * 是无 bash/文件系统环境下渐进式披露的承载工具。
 */

import { toolRegistry } from '../registry';
import { LoadSkillTool, loadSkillTool } from './load-skill-tool';
import { ReadSkillFileTool, readSkillFileTool } from './read-skill-file-tool';

// 注册函数
export function registerSkillTools() {
  toolRegistry.register(loadSkillTool);
  toolRegistry.register(readSkillFileTool);
}

export {
  LoadSkillTool,
  loadSkillTool,
  ReadSkillFileTool,
  readSkillFileTool,
};
