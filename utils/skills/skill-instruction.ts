import { migrateVisionToolPrompt } from '../tools/vision-tool-migration';
/**
 * 技能指令装配（L2 正文的唯一实现）
 *
 * 两条入口共用同一份装配逻辑，保证「模型拿到的技能指令」逐字一致：
 *   1. load_skill 工具（模型在 available-skills 清单命中后自主加载）；
 *   2. 合成激活轮（用户在输入框用 / 预选技能时，会话引擎自动封装一轮
 *      load_skill 调用注入模型上下文，见 skill-engine.buildActivationRound）。
 *
 * 两条入口的产物差异仅在承载形式（ToolResult vs 合成 tool 消息），指令正文、
 * 资源文件清单、环境说明与优先级约定完全同源——模型无法也不需要区分
 * 「自己调的」与「系统代调的」。
 *
 * 分页（渐进式披露的读取层，见 utils/skills/skill-pagination）：
 *   - 正文按 SKILL_PAGE_TOKEN_BUDGET（≈3000 token）分页注入，默认第 1 页；
 *     超出一页时页脚提示页码 / 字数 / 续读调用，模型按页码续读；
 *   - 资源文件（references/ 等）不随激活注入，清单带各文件字数，模型经
 *     read_skill_file 按相对路径分页读取（path 缺省读 SKILL.md）。
 *
 * 分层：本文件只依赖 skill-types / skill-pagination（纯函数与常量）与
 * common/tool-handler 的响应拼装函数，不触碰存储层与工具注册表，可被
 * tools/（低层工具）与 core/（高层装配）同时引用而不产生环。
 */

import type { SkillRecord } from './skill-types';
import { modelSkillIdOf } from './skill-types';
import {
  SKILL_PAGE_TOKEN_BUDGET,
  countSkillChars,
  paginateSkillText,
  type SkillPageInfo,
} from './skill-pagination';
import { buildSuccessPayload } from '@/common/tool-handler';

/**
 * 优先级约定：技能正文随身携带，而不是挂在 system prompt 的技能分区上。
 * 原 <activated-skills> 分区已删除（改为合成 load_skill 轮），这条约定必须
 * 跟着技能正文走，才能在「预激活」与「模型自加载」两条路径上都成立。
 */
const SKILL_CONFLICT_NOTICE =
  '优先级约定：用户本轮指令 > 技能的专项指令 > 当前智能体的通用工作流。' +
  '本技能是针对特定任务的深化指令，执行相关任务时以其流程为准（覆盖智能体的通用流程）；' +
  '若技能内容与用户本轮指令冲突，以用户指令为准。';

/** load_skill 成功响应的结构化载荷（content 文本与 data 字段同源）。
 *  用 type 而非 interface：需整体作为 Record<string, unknown> 传给
 *  buildSuccessPayload（interface 没有隐式索引签名，type 才有）。 */
export type SkillInstructionResult = {
  /** 模型标识 `${name}-${id}`（工具入参与清单标识） */
  skill: string;
  id: string;
  name: string;
  description: string;
  /** 完整指令正文（优先级约定 + 正文当前页 + 分页页脚 + 资源文件清单 + 环境说明） */
  instruction: string;
  /** 正文分页元信息（页码 / 总页数 / 字数口径） */
  pagination: SkillPageInfo;
  /** 本次注入省略了后续内容（= 当前页不是末页） */
  truncated: boolean;
};

/** 请求页码超出正文总页数（load_skill 捕获后转为可自纠的工具报错） */
export class SkillPageOutOfRangeError extends Error {
  readonly pageCount: number;
  readonly requestedPage: number;

  constructor(requestedPage: number, pageCount: number) {
    super(`技能正文共 ${pageCount} 页（每页约 ${SKILL_PAGE_TOKEN_BUDGET} token），不存在第 ${requestedPage} 页`);
    this.name = 'SkillPageOutOfRangeError';
    this.requestedPage = requestedPage;
    this.pageCount = pageCount;
  }
}

/** 成功提示文案（与 load_skill 工具的响应 message 同源，两处共用） */
export function skillLoadSuccessMessage(result: SkillInstructionResult): string {
  return result.truncated
    ? `已加载技能 ${result.name}（正文第 ${result.pagination.page}/${result.pagination.pageCount} 页）`
    : `已加载技能 ${result.name}`;
}

/** 正文分页页脚：页码 / 字数 / 续读指引（当前页非末页时追加） */
function formatBodyPaginationFooter(info: SkillPageInfo, modelId: string): string {
  return (
    `[技能正文分页] 第 ${info.page}/${info.pageCount} 页 · 本页 ${info.currentChars} 字 · ` +
    `正文共 ${info.totalChars} 字 · 剩余 ${info.remainingChars} 字\n` +
    `继续读取下一页：load_skill(skill_name="${modelId}", page=${info.page + 1})`
  );
}

/**
 * 从技能记录安全取出正文与文件表。
 *
 * 自定义 / 预置技能经存储层校验，body 与 files 恒为字符串 / 字符串表；
 * 插件技能（source='plugin'）的数据跨越信任边界（第三方包），契约层类型
 * 不等于运行时保证——此处收敛形状而不是让 TypeError 击穿装配链
 * （激活轮的调用方对单条失败会跳过该技能，但错误越可读越易排查）。
 */
function safeSkillParts(skill: SkillRecord): { body: string; files: Record<string, string> } {
  const body = typeof skill?.body === 'string' ? skill.body : '';
  const rawFiles = skill?.files;
  const files: Record<string, string> =
    rawFiles && typeof rawFiles === 'object' && !Array.isArray(rawFiles) ? rawFiles : {};
  return { body, files };
}

/**
 * 装配单个技能的完整指令（正文分页 + 附属资源清单 + 环境限制说明 + 优先级约定）。
 *
 * @param skill 技能记录
 * @param page  正文页码（默认 1；超出总页数抛 SkillPageOutOfRangeError）
 *
 * 正文是用户可编辑自由文本，此处不做 XML 分区转义——指令只进 tool 消息，
 * 不再嵌入 system prompt 的分区结构。空正文（存储层未强制非空）不产生空段，
 * 分节统一用 \n\n 连接，任何输入形态下都不会出现连续空行。
 */
export function buildSkillInstruction(skill: SkillRecord, page: number = 1): SkillInstructionResult {
  const { body: rawBody, files } = safeSkillParts(skill);
  const body = migrateVisionToolPrompt(rawBody.trim());
  const paged = paginateSkillText(body, page);
  if (!paged.ok) {
    throw new SkillPageOutOfRangeError(page, paged.pageCount);
  }
  const modelId = modelSkillIdOf(skill);

  const sections: string[] = [SKILL_CONFLICT_NOTICE];

  if (paged.page.content) {
    sections.push(paged.page.content);
    // 非末页才提示续读：末页的「下一页」是不存在的调用，提示即误导
    if (paged.page.page < paged.page.pageCount) {
      sections.push(formatBodyPaginationFooter(paged.page, modelId));
    }
  }

  // 附属资源文件清单（第 3 层入口提示；带各文件字数，模型据此决定是否分页读取）。
  // 非字符串内容（插件数据防御）跳过——清单里的路径必须可读，列出不可读项即误导。
  const resourceFiles = Object.entries(files).filter(
    ([path, content]) => path !== 'SKILL.md' && typeof content === 'string',
  );
  if (resourceFiles.length > 0) {
    const listing = resourceFiles
      .map(([path, content]) => `- ${path}（${countSkillChars(content)} 字）`)
      .join('\n');
    const sample = resourceFiles[0][0];
    sections.push(
      `# 技能资源文件\n` +
        `该技能附带以下资源文件（括号内为字数）。需要时用 read_skill_file 分页读取` +
        `（每页约 ${SKILL_PAGE_TOKEN_BUDGET} token，path 缺省读 SKILL.md）：\n` +
        `${listing}\n` +
        `调用示例：read_skill_file(skill_name="${modelId}", path="${sample}", page=1)`,
    );
  }

  // 环境限制说明（每次激活都带上，避免模型尝试执行脚本）
  const allowedTools = Array.isArray(skill?.allowedTools)
    ? skill.allowedTools.filter((id): id is string => typeof id === 'string')
    : [];
  sections.push(
    `# 环境说明\n当前运行环境为浏览器扩展（无终端与本地文件系统）：技能中的 scripts/ 等脚本一律不执行，` +
      `只能作为文字参考阅读；references/ 等资源文件均为纯文本，按需分页读取。` +
      `技能预授权工具：${allowedTools.length > 0 ? allowedTools.join(' ') : '（未声明，沿用会话现有工具）'}`,
  );

  return {
    skill: modelId,
    id: skill.id,
    name: skill.name,
    description: skill.description,
    // 优先级约定置顶：模型读到正文前先知道「谁说了算」
    instruction: sections.join('\n\n'),
    pagination: {
      page: paged.page.page,
      pageCount: paged.page.pageCount,
      totalChars: paged.page.totalChars,
      currentChars: paged.page.currentChars,
      remainingChars: paged.page.remainingChars,
    },
    truncated: paged.page.page < paged.page.pageCount,
  };
}

/**
 * 合成激活轮回传给模型的 tool 结果消息 content。
 *
 * 由 `buildSuccessPayload`（BaseTool.createSuccessResponse 同一函数）拼装，
 * 因此与真实 load_skill 调用的回传**逐字相同**：`content[0].text` 是
 * `{ message, ...载荷 }` 的 pretty JSON，`data` 是同一份载荷。模型无法也
 * 不需要区分「自己调的」与「系统代调的」。
 */
export function skillLoadToolContent(result: SkillInstructionResult): string {
  const payload = buildSuccessPayload(result, skillLoadSuccessMessage(result));
  return JSON.stringify({ success: true, ...payload });
}
