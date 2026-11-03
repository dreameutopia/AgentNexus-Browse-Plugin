/**
 * read_skill_file 工具（渐进式披露第 3 层：按需资源加载）
 *
 * 读取技能目录内的资源文件（references/、assets/ 下的文本文件，或 SKILL.md 原文）。
 * 安全模型：路径必须精确命中该技能已注册的 files 键（白名单制，
 * 天然免疫 "../" 路径穿越），且内容超限时截断。
 *
 * 入参与 load_skill 同构：技能标识（name-id）/ 裸 id / 纯名称三态宽容解析。
 */

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { resolveSkill } from '@/utils/skills/skill-store';
import { SKILL_FILE_MAX_CHARS } from '@/utils/skills/skill-types';

export class ReadSkillFileTool extends BaseTool {
  name = 'read_skill_file';

  metadata: ToolMetadata = {
    name: 'read_skill_file',
    description: '读取技能（skill）目录内的资源文件内容（文本）。用于按需加载技能的参考文档、模板等资源。',
    category: 'skill',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['skill', 'resource', 'read'],
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'read_skill_file',
      description: '读取技能（skill）目录内的资源文件内容（文本）。path 必须是 load_skill 返回的资源清单中列出的相对路径，或 "SKILL.md"。',
      parameters: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description: '技能标识，使用 <available-skills> 清单或 load_skill 返回的标识',
          },
          path: {
            type: 'string',
            description: '文件相对路径，如 "references/REFERENCE.md" 或 "SKILL.md"',
          },
        },
        required: ['skill_name', 'path'],
      },
    },
  };

  async execute(params: { skill_name: string; path: string }): Promise<ToolResult> {
    const skillRef = params?.skill_name?.trim();
    const path = params?.path?.trim();

    if (!skillRef || !path) {
      return this.createErrorResponse('缺少参数 skill_name 或 path');
    }

    const skill = resolveSkill(skillRef);
    if (!skill) {
      const refPreview = skillRef.length > 80 ? `${skillRef.slice(0, 80)}…` : skillRef;
      return this.createErrorResponse(`技能 "${refPreview}" 不存在`);
    }

    // 白名单精确匹配：files 的键即该技能目录的全部合法路径
    const content = skill.files[path];
    if (content === undefined) {
      const pathPreview = path.length > 120 ? `${path.slice(0, 120)}…` : path;
      const available = Object.keys(skill.files).join(', ');
      return this.createErrorResponse(
        `技能 "${skill.name}" 中不存在文件 "${pathPreview}"。可用文件: ${available}`,
      );
    }

    const truncated = content.length > SKILL_FILE_MAX_CHARS;
    const fileContent = truncated
      ? content.slice(0, SKILL_FILE_MAX_CHARS) +
        `\n\n[注：文件超过 ${SKILL_FILE_MAX_CHARS} 字符，已截断]`
      : content;

    return this.createSuccessResponse(
      {
        skill: skill.name,
        path,
        content: fileContent,
        truncated,
      },
      `已读取 ${skill.name}/${path}`,
    );
  }
}

export const readSkillFileTool = new ReadSkillFileTool();
