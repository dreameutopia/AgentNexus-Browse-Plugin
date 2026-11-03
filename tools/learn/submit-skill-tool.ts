/**
 * submit_skill —— 网站学习阶段的终止型提交工具
 *
 * 双重职责：
 *   1. **结束信号**：metadata.terminal=true，成功执行后会话引擎在本轮工具
 *      全部执行完、结果已回传模型后正常收尾（不再发起下一次请求）；
 *   2. **技能草稿交付**：把学习阶段摸索出的流程结构化为可入库的 SkillDraft，
 *      由编排层接住后跳转管理中心预填、经用户确认后写入技能库。
 *
 * 为什么校验放在工具层而不是编排层：草稿在模型手里成形，参数不合法时
 * 必须**立即**以可读错误回传模型自纠——若等运行结束才校验，模型已经没有
 * 下一轮机会修正，只能整个学习作废。故本工具对任何字段问题一律返回
 * 「错误类型 + 原因 + 处置建议」的可控失败，且失败**不触发**终止
 * （terminal 只在 success 时生效）。
 *
 * 结果契约：
 *   - 成功：content 为模型可读的确认文本，data 携带完整 SkillDraft
 *     （编排层与 UI 消费的唯一数据源）；
 *   - 失败：error 为结构化文本，data.errorKind 供程序分类。
 */

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata, toolRegistry } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import {
  SKILL_NAME_PATTERN,
  SKILL_NAME_MAX_CHARS,
  SKILL_BODY_MAX_CHARS,
  SKILL_DESCRIPTION_MAX_CHARS,
} from '@/utils/skills/skill-types';
import { normalizeSkillName } from '@/utils/skills/frontmatter-parser';
import { normalizeCategory, normalizeTags } from '@/utils/agents/agent-types';
import type { LearnTargetMode, SkillDraft } from '@/utils/learn/learn-types';

const TOOL_NAME = 'submit_skill';

/** 模式 → tags 中的稳定标签（用户可见、可检索；模式的唯一持久化表达） */
const MODE_TAG: Record<LearnTargetMode, string> = {
  text: '文本模式',
  vision: '视觉模式',
};

/** 与 hub 技能编辑页一致的标签上限（agent-types 同源常量） */
const MAX_TAGS = 8;

/** 成功结果：content 供模型阅读，data 供程序消费 */
function skillSuccess(text: string, data: Record<string, unknown>): ToolResult {
  return {
    success: true,
    isError: false,
    content: [{ type: 'text', text }],
    data,
  };
}

/** 失败结果：错误类型 + 原因 + 处置建议（模型据此可一次修正） */
function skillFailure(kind: string, reason: string, hint: string): ToolResult {
  const text =
    `[${TOOL_NAME}] 提交失败\n` +
    `错误类型: ${kind}\n` +
    `原因: ${reason}\n` +
    `处置建议: ${hint}`;
  return {
    success: false,
    isError: true,
    error: text,
    content: [{ type: 'text', text }],
    data: { errorKind: kind },
  };
}

/** 入参防御：模型输出不可信，非对象形态收敛为可读参数错误 */
function asArgs(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  throw new Error(
    `arguments 必须为 JSON 对象，实际收到: ${Array.isArray(raw) ? 'array' : typeof raw}`,
  );
}

/** 非空字符串字段提取（显式区分「未传」与「传了空串」——两者都要报错但文案不同） */
function requireText(value: unknown, field: string): string {
  if (value === undefined || value === null) {
    throw new Error(`缺少必填字段 ${field}`);
  }
  if (typeof value !== 'string') {
    throw new Error(`字段 ${field} 必须是字符串，实际收到: ${Array.isArray(value) ? 'array' : typeof value}`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`字段 ${field} 不能为空`);
  return trimmed;
}

/** 字符串数组字段提取：丢弃非字符串与空白项，保序去重 */
function toStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`字段 ${field} 必须是字符串数组，实际收到: ${typeof value}`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export class SubmitSkillTool extends BaseTool {
  name = TOOL_NAME;

  metadata: ToolMetadata = {
    name: TOOL_NAME,
    description: '提交网站学习成果（技能草稿）并结束当前学习阶段',
    category: 'learn',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['learn', 'skill', 'submit', 'terminal'],
    // 终止型：成功执行即结束本轮运行（见文件头说明）
    terminal: true,
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAME,
      description:
        '提交本次网站学习的成果（技能草稿）并结束学习阶段。这是学习阶段唯一的结束方式——' +
        '只有在已完整跑通目标流程、并把每一步的定位信息与分支坑点都记录清楚后才调用。' +
        '参数不合法会返回可读错误且**不会**结束学习，请按错误提示修正后重新提交。',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              `技能名：全小写 kebab-case 英文（由站点域名 + 目标关键词提炼，如 boss-zhipin-apply），` +
              `≤${SKILL_NAME_MAX_CHARS} 字符，仅含 a-z 0-9 与连字符。`,
          },
          description: {
            type: 'string',
            description:
              `技能描述：一句话写清「做什么 + 何时使用」（中文），≤${SKILL_DESCRIPTION_MAX_CHARS} 字符。` +
              '它会出现在技能发现清单里，模型据此判断是否加载本技能。',
          },
          category: {
            type: 'string',
            description: '技能分类（与管理中心分类一致，如 automation / search / general / 自定义分类名）。',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: `中文标签，最多 ${MAX_TAGS} 个（模式标签会自动补上，无需手动添加）。`,
          },
          body: {
            type: 'string',
            description:
              `SKILL.md 正文（Markdown，不含 frontmatter），≤${SKILL_BODY_MAX_CHARS} 字符。` +
              '标准结构：## 目标 / ## 前置条件 / ## 工作流（编号步骤，每步写明工具调用形态与元素定位信息）/ ' +
              '## 分支与坑点 / ## 完成判定 / ## 边界。定位信息按目标操作模式书写（见 allowedTools 与 mode 说明）。',
          },
          allowedTools: {
            type: 'array',
            items: { type: 'string' },
            description:
              '执行本技能实际需要的工具 ID（非空，如 browser_interact、browser_observe）。' +
              '它决定该技能在哪些智能体的「/」引用清单中可见，务必如实填写，只写真正用到的。',
          },
          mode: {
            type: 'string',
            enum: ['text', 'vision'],
            description:
              '目标操作模式：text=技能交给纯文本模型使用（定位以 CSS 选择器/XPath + 元素文字为主）；' +
              'vision=技能交给视觉模型使用（可额外描述元素在界面中的位置区域）。',
          },
          summary: {
            type: 'string',
            description: '可选：一句话执行摘要（学到了什么、共几步、有哪些关键坑点），用于结果展示。',
          },
        },
        required: ['name', 'description', 'category', 'body', 'allowedTools', 'mode'],
      },
    },
  };

  async execute(rawArgs: unknown): Promise<ToolResult> {
    let operation = '参数校验';
    try {
      const args = asArgs(rawArgs);

      // ── mode：枚举白名单（脏值不静默回落，模型必须显式纠正）──
      operation = '校验 mode';
      const rawMode = args.mode;
      if (rawMode !== 'text' && rawMode !== 'vision') {
        return skillFailure(
          '参数错误',
          `mode 必须为 "text" 或 "vision"，实际收到: ${JSON.stringify(rawMode ?? null)}`,
          '按本次学习配置的目标操作模式原样传入 text 或 vision',
        );
      }
      const mode: LearnTargetMode = rawMode;

      // ── name：规范化后校验（任意输入先收敛，收敛后仍非法才拒绝）──
      operation = '校验 name';
      const rawName = requireText(args.name, 'name');
      const name = normalizeSkillName(rawName);
      if (!name || !SKILL_NAME_PATTERN.test(name)) {
        return skillFailure(
          '参数错误',
          `name 规范化后仍不合法（需匹配 ${SKILL_NAME_PATTERN}）: "${rawName}"`,
          '改用纯小写英文与连字符，例如 boss-zhipin-apply；不要包含中文、空格或下划线以外的符号',
        );
      }
      if (name.length > SKILL_NAME_MAX_CHARS) {
        return skillFailure(
          '参数错误',
          `name 长度 ${name.length} 超过上限 ${SKILL_NAME_MAX_CHARS}`,
          '缩短技能名，保留站点名 + 核心动作即可',
        );
      }

      // ── description ──
      operation = '校验 description';
      const description = requireText(args.description, 'description');
      if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
        return skillFailure(
          '参数错误',
          `description 长度 ${description.length} 超过上限 ${SKILL_DESCRIPTION_MAX_CHARS}`,
          '压缩为一句话：做什么 + 何时使用',
        );
      }

      // ── category（归一化；空值拒绝——入库不变量要求非空）──
      operation = '校验 category';
      const category = normalizeCategory(requireText(args.category, 'category'));
      if (!category) {
        return skillFailure(
          '参数错误',
          'category 规范化后为空',
          '传入分类名，如 automation / search / general，或自定义分类',
        );
      }

      // ── body（非空 + 长度上限；超长让模型精简而非静默截断——截断会砍掉尾部的完成判定）──
      operation = '校验 body';
      const body = requireText(args.body, 'body');
      if (body.length > SKILL_BODY_MAX_CHARS) {
        return skillFailure(
          '正文超长',
          `body 长度 ${body.length} 超过上限 ${SKILL_BODY_MAX_CHARS}（超出的部分会在注入时被截断，导致技能尾部步骤丢失）`,
          '精简正文：合并重复步骤、压缩示例与解释、坑点只保留会导致失败的关键项；结构小节标题保留',
        );
      }

      // ── allowedTools（非空 + 只保留已注册工具，未注册的显式回告）──
      operation = '校验 allowedTools';
      const declaredTools = toStringArray(args.allowedTools, 'allowedTools');
      if (declaredTools.length === 0) {
        return skillFailure(
          '参数错误',
          'allowedTools 为空——没有声明工具的技能不会出现在任何智能体的「/」引用清单中，建完也引用不到',
          '列出执行本技能真正用到的工具 ID（如 browser_interact、browser_observe、browser_navigate）',
        );
      }
      const knownTools: string[] = [];
      const unknownTools: string[] = [];
      for (const toolId of declaredTools) {
        (toolRegistry.getTool(toolId) ? knownTools : unknownTools).push(toolId);
      }
      if (knownTools.length === 0) {
        return skillFailure(
          '参数错误',
          `allowedTools 中没有已注册的工具: ${declaredTools.join(', ')}`,
          '工具 ID 必须与注册名完全一致（可参考工具测试面板中的名称），例如 browser_interact 而不是 click',
        );
      }

      // ── tags（归一化 + 自动补模式标签；模式标签是模式的唯一持久化表达）──
      operation = '校验 tags';
      const tags = normalizeTags(toStringArray(args.tags, 'tags')).slice(0, MAX_TAGS - 1);
      const modeTag = MODE_TAG[mode];
      if (!tags.includes(modeTag)) tags.push(modeTag);
      const finalTags = tags.slice(0, MAX_TAGS);

      // ── summary（可选）──
      const rawSummary = args.summary;
      if (rawSummary !== undefined && rawSummary !== null && typeof rawSummary !== 'string') {
        return skillFailure(
          '参数错误',
          `summary 必须为字符串，实际收到: ${Array.isArray(rawSummary) ? 'array' : typeof rawSummary}`,
          '不需要时省略 summary 字段',
        );
      }
      const summary = typeof rawSummary === 'string' ? rawSummary.trim() : '';

      const draft: SkillDraft = {
        name,
        description,
        category,
        tags: finalTags,
        body,
        allowedTools: knownTools,
        mode,
        ...(summary ? { summary } : {}),
      };

      const droppedNote = unknownTools.length > 0
        ? `\n注意：以下工具 ID 未注册，已从 allowedTools 中剔除: ${unknownTools.join(', ')}（若确需保留请先确认工具名）`
        : '';
      const renamedNote = name !== rawName
        ? `\n名称已规范化为 "${name}"（原始值 "${rawName}"）`
        : '';

      return skillSuccess(
        `技能草稿已提交，学习阶段结束。${renamedNote}${droppedNote}\n\n` +
          `name: ${name}\ncategory: ${category}\ntags: ${finalTags.join(' ')}\n` +
          `allowed-tools: ${knownTools.join(' ')}\nmode: ${mode}\n` +
          `正文 ${body.length} 字符。后续将由你确认后写入技能库。`,
        { draft },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log(`提交技能草稿失败（${operation}）: ${reason}`, 'warn');
      return skillFailure(
        '参数错误',
        reason,
        '核对各字段形态后重试：name/description/category/body 为字符串，tags/allowedTools 为字符串数组，mode 为 text 或 vision',
      );
    }
  }
}

export const submitSkillTool = new SubmitSkillTool();
