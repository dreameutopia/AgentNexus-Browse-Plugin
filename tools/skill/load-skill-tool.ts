/**
 * load_skill 工具（渐进式披露第 2 层：激活）
 *
 * 模型在任务与 available-skills 清单中某技能匹配时调用，返回该技能的指令：
 * 优先级约定 + SKILL.md 正文（按 ≈3000 token 分页，默认第 1 页）+ 资源文件
 * 清单（带字数）+ 环境说明。正文超出一页时页脚提示页码与续读调用。
 * 装配逻辑与「用户用 / 预选技能时系统代发的合成激活轮」共用同一实现
 * （utils/skills/skill-instruction），两条路径的回传逐字同源。
 * 本环境无 bash/文件系统，该工具替代 Claude Code 中 Skill 工具的角色。
 *
 * 入参为清单中的「技能标识」（name-id，全局唯一）；同时宽容解析裸 id 与
 * 纯名称（人工输入 / 旧会话兼容），解析规则见 skill-store.resolveSkill。
 */

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { resolveSkill, getEnabledSkills } from '@/utils/skills/skill-store';
import { modelSkillIdOf } from '@/utils/skills/skill-types';
import {
  SkillPageOutOfRangeError,
  buildSkillInstruction,
  skillLoadSuccessMessage,
} from '@/utils/skills/skill-instruction';
import { normalizeSkillPageParam, SKILL_PAGE_TOKEN_BUDGET } from '@/utils/skills/skill-pagination';

const PARAM_DESCRIPTION =
  '加载技能（skill）的 SKILL.md 指令（按页返回，每页约 ' +
  `${SKILL_PAGE_TOKEN_BUDGET} token）。当系统提示中 <available-skills> 清单里有技能与当前任务相关时，` +
  '必须先调用本工具获取指令再执行任务；正文未读完时按返回中的页码继续传 page 读取下一页。';

export class LoadSkillTool extends BaseTool {
  name = 'load_skill';

  metadata: ToolMetadata = {
    name: 'load_skill',
    description: PARAM_DESCRIPTION,
    category: 'skill',
    version: '1.3.0',
    author: 'AgentNexus',
    tags: ['skill', 'instructions', 'agent-skills'],
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'load_skill',
      description: PARAM_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description: '技能标识，必须原样使用 <available-skills> 清单中列出的标识（如 "web-research-report-ab12cd34"）',
          },
          page: {
            type: 'integer',
            description: `正文页码，默认 1（每页约 ${SKILL_PAGE_TOKEN_BUDGET} token；上次返回提示还有后续页时传 page=N 续读）`,
          },
        },
        required: ['skill_name'],
      },
    },
  };

  async execute(params: { skill_name: string; page?: number | string }): Promise<ToolResult> {
    // 参数防御：模型偶发传数字 / null 等脏形态，统一收敛为字符串而不是抛
    // TypeError 击穿工具链（报错信息保持可自纠）
    const rawRef = params?.skill_name;
    const skillRef = (typeof rawRef === 'string' ? rawRef : String(rawRef ?? '')).trim();
    if (!skillRef) {
      return this.createErrorResponse('缺少参数 skill_name');
    }
    const page = normalizeSkillPageParam(params?.page);

    const skill = resolveSkill(skillRef);
    if (!skill || !skill.enabled) {
      // 报错带全量启用技能的规范标识，模型可据此自纠；入参超长时截断回显，
      // 防止模型幻觉粘贴大段文本把错误消息撑爆
      const refPreview = skillRef.length > 80 ? `${skillRef.slice(0, 80)}…` : skillRef;
      const available = getEnabledSkills().map(s => modelSkillIdOf(s)).join(', ') || '（无）';
      return this.createErrorResponse(
        `技能 "${refPreview}" 不存在或未启用。可用技能: ${available}`,
      );
    }

    // 指令装配与合成激活轮同源（utils/skills/skill-instruction）：
    // 正文分页、资源文件清单、环境说明与优先级约定只此一份实现
    try {
      const loaded = buildSkillInstruction(skill, page);
      return this.createSuccessResponse(loaded, skillLoadSuccessMessage(loaded));
    } catch (error) {
      if (error instanceof SkillPageOutOfRangeError) {
        return this.createErrorResponse(error.message);
      }
      throw error;
    }
  }
}

export const loadSkillTool = new LoadSkillTool();
