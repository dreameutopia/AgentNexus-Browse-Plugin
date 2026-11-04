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
 * 分层：本文件只依赖 skill-types（纯类型与常量）与 common/tool-handler 的
 * 响应拼装函数，不触碰存储层与工具注册表，可被 tools/（低层工具）与
 * core/（高层装配）同时引用而不产生环。
 */

import type { SkillRecord } from './skill-types';
import { SKILL_BODY_MAX_CHARS, modelSkillIdOf } from './skill-types';
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
  /** 完整指令正文（优先级约定 + 正文 + 资源文件清单 + 环境说明） */
  instruction: string;
  /** 正文是否因超过 SKILL_BODY_MAX_CHARS 被截断 */
  truncated: boolean;
};

/** 成功提示文案（与 load_skill 工具的响应 message 同源，两处共用） */
export function skillLoadSuccessMessage(result: SkillInstructionResult): string {
  return `已加载技能 ${result.name}`;
}

/**
 * 装配单个技能的完整指令（软截断 + 附属资源清单 + 环境限制说明 + 优先级约定）。
 *
 * 截断阈值与 load_skill 的历史行为一致（SKILL_BODY_MAX_CHARS），截断时附
 * read_skill_file 的取原文指引；正文是用户可编辑自由文本，此处不做 XML 分区
 * 转义——指令只进 tool 消息，不再嵌入 system prompt 的分区结构。
 */
export function buildSkillInstruction(skill: SkillRecord): SkillInstructionResult {
  const body = migrateVisionToolPrompt(skill.body.trim());
  const truncated = body.length > SKILL_BODY_MAX_CHARS;
  const modelId = modelSkillIdOf(skill);

  const sections: string[] = [SKILL_CONFLICT_NOTICE];

  // 正文（超长软截断 + 取原文指引）。空正文（存储层未强制非空）不产生空段，
  // 分节统一用 \n\n 连接，任何输入形态下都不会出现连续空行
  if (body) {
    sections.push(
      truncated
        ? body.slice(0, SKILL_BODY_MAX_CHARS) +
          `\n\n[注：技能正文超过 ${SKILL_BODY_MAX_CHARS} 字符，已截断。可调用 read_skill_file(skill_name="${modelId}", path="SKILL.md") 读取原文。]`
        : body,
    );
  }

  // 附属资源文件清单（第 3 层入口提示）
  const resourceFiles = Object.keys(skill.files).filter(f => f !== 'SKILL.md');
  if (resourceFiles.length > 0) {
    sections.push(
      `# 技能资源文件\n该技能附带以下资源文件，需要时可调用 read_skill_file(skill_name="${modelId}", path="...") 按需读取：\n${resourceFiles.map(f => `- ${f}`).join('\n')}`,
    );
  }

  // 环境限制说明（每次激活都带上，避免模型尝试执行脚本）
  sections.push(
    `# 环境说明\n当前运行环境为浏览器扩展（无终端与本地文件系统）。技能中如提及脚本（scripts/），本环境不执行脚本，请依据指令文字与可用工具完成任务。技能预授权工具：${skill.allowedTools.length > 0 ? skill.allowedTools.join(' ') : '（未声明，沿用会话现有工具）'}`,
  );

  return {
    skill: modelId,
    id: skill.id,
    name: skill.name,
    description: skill.description,
    // 优先级约定置顶：模型读到正文前先知道「谁说了算」
    instruction: sections.join('\n\n'),
    truncated,
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
