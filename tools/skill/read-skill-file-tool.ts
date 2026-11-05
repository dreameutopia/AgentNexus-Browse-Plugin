import { migrateVisionToolPrompt } from '@/utils/tools/vision-tool-migration';
/**
 * read_skill_file 工具（渐进式披露第 3 层：按需资源加载）
 *
 * 读取技能目录内的文件（references/、assets/ 下的文本文件，或 SKILL.md 原文）。
 * 安全模型：路径必须精确命中该技能已注册的 files 键（白名单制，
 * 天然免疫 "../" 路径穿越）。
 *
 * 分页（与 load_skill 正文同一套实现，见 utils/skills/skill-pagination）：
 *   - 每页约 SKILL_PAGE_TOKEN_BUDGET（3000）token，页码参数 page 缺省第 1 页；
 *   - 响应载荷携带分页元信息（页码 / 总页数 / 全文・本页・剩余字数），
 *     content 本体保持纯净（不把页脚混进文件内容），模型按 page 续读。
 *
 * 入参与 load_skill 同构：技能标识（name-id）/ 裸 id / 纯名称三态宽容解析；
 * path 缺省读 SKILL.md（技能入口原文，含 frontmatter）。
 */

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { resolveSkill } from '@/utils/skills/skill-store';
import { modelSkillIdOf } from '@/utils/skills/skill-types';
import {
  SKILL_PAGE_TOKEN_BUDGET,
  normalizeSkillPageParam,
  paginateSkillText,
} from '@/utils/skills/skill-pagination';

const PARAM_DESCRIPTION =
  `读取技能（skill）目录内的文件内容（纯文本，按页返回，每页约 ${SKILL_PAGE_TOKEN_BUDGET} token）。` +
  'path 必须是 load_skill 返回的资源清单中列出的相对路径；缺省读 "SKILL.md"（技能入口原文，含 frontmatter）。' +
  '未读完时按返回中的总页数继续传 page 读取。';

export class ReadSkillFileTool extends BaseTool {
  name = 'read_skill_file';

  metadata: ToolMetadata = {
    name: 'read_skill_file',
    description: PARAM_DESCRIPTION,
    category: 'skill',
    version: '1.1.0',
    author: 'AgentNexus',
    tags: ['skill', 'resource', 'read'],
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'read_skill_file',
      description: PARAM_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description: '技能标识，使用 <available-skills> 清单或 load_skill 返回的标识',
          },
          path: {
            type: 'string',
            description: '文件相对路径，如 "references/REFERENCE.md"；缺省读 "SKILL.md"',
          },
          page: {
            type: 'integer',
            description: `页码，默认 1（每页约 ${SKILL_PAGE_TOKEN_BUDGET} token；上次返回提示还有剩余时传 page=N 续读）`,
          },
        },
        required: ['skill_name'],
      },
    },
  };

  async execute(params: {
    skill_name: string;
    path?: string;
    page?: number | string;
  }): Promise<ToolResult> {
    // 参数防御：模型偶发传数字 / null 等脏形态，统一收敛为字符串而不是抛
    // TypeError 击穿工具链（报错信息保持可自纠）
    const rawRef = params?.skill_name;
    const skillRef = (typeof rawRef === 'string' ? rawRef : String(rawRef ?? '')).trim();
    const rawPath = params?.path;
    const path = ((typeof rawPath === 'string' ? rawPath : String(rawPath ?? '')).trim() || 'SKILL.md') as string;

    if (!skillRef) {
      return this.createErrorResponse('缺少参数 skill_name');
    }
    const page = normalizeSkillPageParam(params?.page);

    const skill = resolveSkill(skillRef);
    if (!skill || !skill.enabled) {
      const refPreview = skillRef.length > 80 ? `${skillRef.slice(0, 80)}…` : skillRef;
      return this.createErrorResponse(`技能 "${refPreview}" 不存在`);
    }

    // 白名单精确匹配：files 的键即该技能目录的全部合法路径。
    // 内容必须为字符串（插件技能等第三方数据防御）：键存在但内容非字符串
    // 视为数据损坏，与「不存在」分开报错，避免「列在清单里却说没有」的自相矛盾。
    const rawSource = skill.files?.[path];
    if (rawSource !== undefined && typeof rawSource !== 'string') {
      const pathPreview = path.length > 120 ? `${path.slice(0, 120)}…` : path;
      console.warn(`[read_skill_file] 技能 "${skill.name}" 的文件 "${pathPreview}" 内容非文本，已拒绝读取`);
      return this.createErrorResponse(`技能 "${skill.name}" 中文件 "${pathPreview}" 的内容不是文本（数据损坏），无法读取`);
    }
    const content =
      typeof rawSource === 'string' ? (/\.md$/i.test(path) ? migrateVisionToolPrompt(rawSource) : rawSource) : undefined;
    if (content === undefined) {
      const pathPreview = path.length > 120 ? `${path.slice(0, 120)}…` : path;
      const available = Object.keys(skill.files ?? {}).join(', ');
      return this.createErrorResponse(
        `技能 "${skill.name}" 中不存在文件 "${pathPreview}"。可用文件: ${available}`,
      );
    }

    const paged = paginateSkillText(content, page);
    if (!paged.ok) {
      return this.createErrorResponse(
        `文件 "${path}" 共 ${paged.pageCount} 页（每页约 ${SKILL_PAGE_TOKEN_BUDGET} token），不存在第 ${page} 页`,
      );
    }

    const truncated = paged.page.pageCount > paged.page.page;
    const payload: Record<string, unknown> = {
      skill: skill.name,
      path,
      content: paged.page.content,
      pagination: {
        page: paged.page.page,
        pageCount: paged.page.pageCount,
        totalChars: paged.page.totalChars,
        currentChars: paged.page.currentChars,
        remainingChars: paged.page.remainingChars,
      },
      truncated,
    };
    if (truncated) {
      // 续读指引放独立字段，不混入 content（文件内容保持纯净）
      payload.hint = `文件共 ${paged.page.pageCount} 页，本页为第 ${paged.page.page} 页（${paged.page.currentChars} 字，剩余 ${paged.page.remainingChars} 字）。继续读取：read_skill_file(skill_name="${modelSkillIdOf(skill)}", path="${path}", page=${paged.page.page + 1})`;
    }

    return this.createSuccessResponse(
      payload,
      truncated
        ? `已读取 ${skill.name}/${path}（第 ${paged.page.page}/${paged.page.pageCount} 页）`
        : `已读取 ${skill.name}/${path}`,
    );
  }
}

export const readSkillFileTool = new ReadSkillFileTool();
