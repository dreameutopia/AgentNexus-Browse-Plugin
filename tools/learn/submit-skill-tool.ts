/**
 * submit_skill —— 网站学习阶段的终止型提交工具
 *
 * 双重职责：
 *   1. **结束信号**：metadata.terminal=true，成功执行后会话引擎在本轮工具
 *      全部执行完、结果已回传模型后正常收尾（不再发起下一次请求）；
 *   2. **学习终态交付**：把学习阶段的结论结构化——
 *      status=success 交出可入库的技能草稿；
 *      status=failed / blocked 交出失败报告（原因 + 已探明的知识 + 下一步建议）。
 *
 * 为什么成功与失败要共用一个工具、而不是「成功用 submit_skill、失败靠模型
 * 自己说」：
 *   - 引擎只认 terminal 工具的**成功执行**。若失败没有工具出口，模型在
 *     探索受阻时唯一的收尾方式就是输出一句文本总结——引擎照常结束运行，
 *     终态被无视，编排层拿不到任何确定信息，用户只看到「没产出」。
 *   - 提交校验要求正文合格（七个小节、编号逐项对齐）。模型在受阻时往往
 *     正写不出合格正文，提交失败拿回的是参数错误——它既不知道可以体面
 *     收尾，也拿不到「卡在哪」的答案，于是反复重试直至放弃。
 *   - 现在失败是**一等终态**：不必交出合格正文就能收尾，只需说清卡在哪、
 *     为什么、已经探明了什么。失败同样有产出（findings），编排层也拿得到
 *     确定的原因（reason/detail），用户可以据此决定「重新学习」还是「结束」。
 *
 * 结果契约：
 *   - 成功：content 为模型可读的确认文本，data 携带 draft 或 failure；
 *   - 失败：error 为结构化文本，data.errorKind 供程序分类。
 *
 * 校验分层：字段形态问题一律返回「错误类型 + 原因 + 处置建议」的可控失败，
 * 且失败**不触发**终止（terminal 只在 success 时生效）——让模型当场自纠。
 * 但 status=failed/blocked 的提交是**成功执行**：它就是「本次学习的终态」。
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
import {
  LEARN_FAILURE_REASONS,
  SKILL_MAX_TAGS,
  SKILL_MODE_TAG,
  isHumanBlockedReason,
  type LearnFailureReason,
  type LearnFailureReport,
  type LearnSubmitStatus,
  type LearnTargetMode,
  type SkillDraft,
} from '@/utils/learn/learn-types';
import { isVisualSkillTool } from '@/utils/learn/learn-validate';
import { LEARN_SKILL_SECTIONS, validateLearnSkillBody } from '@/utils/learn/learn-output-contract';

const TOOL_NAME = 'submit_skill';

// 模式标签与标签上限的单一事实源在 learn-types（SKILL_MODE_TAG / SKILL_MAX_TAGS），
// 编排层对账草稿时引用同一份常量，两处不会漂移。

/** 失败原因枚举的说明文案（写进 schema，供模型按语义选择） */
const FAILURE_REASON_HINTS: Record<LearnFailureReason, string> = {
  'login-required': '需要登录、账号态失效或被登出',
  captcha: '遇到验证码、扫码、人机校验等只能由人完成的关卡',
  'permission-denied': '权限不足、被禁止访问或需要额外授权',
  'target-missing': '目标页面 / 目标元素不存在',
  'flow-broken': '流程与预期不符、中途断链、按钮无响应',
  'locator-unstable': '定位线索不稳定（每次刷新都变、无法重新采集）',
  'page-unreachable': '页面打不开、加载失败、网络或跨域问题',
  timeout: '始终未在时限内完成',
  other: '以上都不是，用 detail 说清卡点',
};

/** 单条「已探明知识」的最大长度（防止模型把整页日志塞进来） */
const FINDING_MAX_CHARS = 500;
/** 「已探明知识」的条数上限 */
const FINDING_MAX_COUNT = 20;
/** 失败详情的长度上限 */
const DETAIL_MAX_CHARS = 2000;
/** 「建议的下一步」的长度上限 */
const SUGGESTION_MAX_CHARS = 500;
/** 执行摘要的长度上限（草稿入库后随技能长期保存，不接受无界文本） */
const SUMMARY_MAX_CHARS = 500;

/**
 * 终态与原因分类的一致性提示（软提示，不拒绝提交）。
 *
 * 两处偏差都值得让模型看见，但都不该让一次终态提交失败——
 * 终态提交失败就等于「本次学习没有结论」，代价远大于分类偏差：
 * - status=blocked 但原因不是「必须由人完成」→ 终态选错了；
 * - status=failed 但原因是「必须由人完成」→ 终态选错了（应改用 blocked）。
 */
function consistencyNote(status: LearnSubmitStatus, reason: LearnFailureReason): string {
  const humanBlocked = isHumanBlockedReason(reason);
  if (status === 'blocked' && !humanBlocked) {
    return `\n注意：status=blocked 表示「必须由人完成」，但 reason=${reason} 属于流程自身的问题——终态与分类不一致，已按你提交的内容记录。`;
  }
  if (status === 'failed' && humanBlocked) {
    return `\n注意：reason=${reason} 属于必须由人完成的前置条件，更适合用 status=blocked 提交（本次已按 failed 记录）。`;
  }
  return '';
}

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
    description: '提交网站学习成果并结束当前学习阶段（成功交技能草稿，失败交失败原因）',
    category: 'learn',
    version: '1.1.0',
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
        '提交本次网站学习的终态并结束学习阶段。**无论成功还是失败，本阶段都只能靠调用本工具结束**，' +
        '不要用一段文字总结代替提交。\n' +
        'status=success：已经完整跑通目标流程，交出可入库的技能草稿（需填 name/description/category/body/allowedTools/mode）。\n' +
        'status=failed：流程本身没走通但原因已定位，**不必交正文**——填 reason（原因分类）、' +
        'detail（卡在哪一步、期望什么、实际什么）、findings（已经探明的可复用知识）与 suggestion（建议的下一步）。\n' +
        'status=blocked：被必须由人完成的前置条件挡住（登录、验证码、扫码、付费、授权），其余字段同 failed。\n' +
        '参数不合法会返回可读错误且**不会**结束学习，请按错误提示修正后重新提交。',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['success', 'failed', 'blocked'],
            description:
              '本次学习的终态：success=已跑通并产出技能；failed=流程没走通但原因已定位；' +
              'blocked=被必须由人完成的前置条件挡住（登录/验证码/扫码/付费/授权）。',
          },
          name: {
            type: 'string',
            description:
              `【status=success 必填】技能名必须为「平台-任务简短概述」，小写英文 kebab-case（如 pinduoduo-search-products），` +
              `≤${SKILL_NAME_MAX_CHARS} 字符，仅含 a-z 0-9 与连字符。`,
          },
          description: {
            type: 'string',
            description:
              `【status=success 必填】技能描述：一句话写清「做什么 + 何时使用」（中文），≤${SKILL_DESCRIPTION_MAX_CHARS} 字符。` +
              '它会出现在技能发现清单里，模型据此判断是否加载本技能。',
          },
          category: {
            type: 'string',
            description:
              '【status=success 必填】技能分类（与管理中心分类一致，如 automation / search / general / 自定义分类名）。',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: `【status=success 选填】中文标签，最多 ${SKILL_MAX_TAGS} 个（模式标签会自动补上，无需手动添加）。`,
          },
          body: {
            type: 'string',
            description:
              `【status=success 必填】SKILL.md 正文（Markdown，不含 frontmatter），≤${SKILL_BODY_MAX_CHARS} 字符。` +
              `依次包含 ${LEARN_SKILL_SECTIONS.map(title => `## ${title}`).join(' / ')}。` +
              '完成计划按 1.、2. 编号，具体操作讲解按 ### 1.、### 2. 逐项对应；每步写动作、原因、至少两条真实目标线索（优先 XPath+文字）、操作方式、成功判据与注意/恢复。视觉模式额外写位置和外观，保留文本能力。',
          },
          allowedTools: {
            type: 'array',
            items: { type: 'string' },
            description:
              '【status=success 必填】执行本技能实际需要的工具 ID（非空，如 browser_interact、browser_observe）。' +
              '它决定该技能在哪些智能体的「/」引用清单中可见，务必如实填写，只写真正用到的。',
          },
          mode: {
            type: 'string',
            enum: ['text', 'vision'],
            description:
              '【status=success 必填】目标操作模式：text=真实 XPath + 元素文字/属性，现场获取引用并操作；' +
              'vision=保留 XPath/文本交互，额外描述位置、外观和交互反馈。必须与本次目标模式一致。',
          },
          summary: {
            type: 'string',
            description: '【status=success 选填】一句话执行摘要（学到了什么、共几步、有哪些关键坑点），用于结果展示。',
          },
          reason: {
            type: 'string',
            enum: [...LEARN_FAILURE_REASONS],
            description:
              '【status=failed/blocked 必填】失败原因分类：' +
              Object.entries(FAILURE_REASON_HINTS)
                .map(([code, hint]) => `${code}=${hint}`)
                .join('；') +
              '。',
          },
          detail: {
            type: 'string',
            description:
              `【status=failed/blocked 必填】具体卡点：卡在哪一步、期望看到什么、实际发生了什么，` +
              `≤${DETAIL_MAX_CHARS} 字符。要写事实，不要写「失败了」这种空话。`,
          },
          findings: {
            type: 'array',
            items: { type: 'string' },
            description:
              `【status=failed/blocked 强烈建议】已经探明的可复用知识（每条 ≤${FINDING_MAX_CHARS} 字符，最多 ${FINDING_MAX_COUNT} 条）：` +
              '走通的步骤、确认过的定位线索、踩到的坑、已验证的分支。失败也有产出——这一项是本次学习留给用户的真正价值。',
          },
          suggestion: {
            type: 'string',
            description:
              '【status=failed/blocked 选填】建议的下一步：需要用户做什么（登录/过验证码）、或换个什么策略、' +
              '或把目标缩小到哪一步。',
          },
        },
        required: ['status'],
      },
    },
  };

  async execute(rawArgs: unknown): Promise<ToolResult> {
    let operation = '参数校验';
    try {
      const args = asArgs(rawArgs);

      // ── status：必填枚举（成功 / 失败 / 被阻断）──
      // 缺 status 时模型多半根本没想好「这次到底算不算学成」——用可读错误
      // 让它明确表态（可自纠，不终止），而不是默认按成功处理、拿正文校验
      // 去惩罚一个本来就失败了的提交。
      operation = '校验 status';
      const rawStatus = args.status;
      if (rawStatus !== 'success' && rawStatus !== 'failed' && rawStatus !== 'blocked') {
        return skillFailure(
          '参数错误',
          `status 必须为 "success"、"failed" 或 "blocked"，实际收到: ${JSON.stringify(rawStatus ?? null)}`,
          '跑通了就传 success；没跑通但原因已定位就传 failed（填 reason/detail/findings）；' +
            '被登录、验证码这类必须由人完成的条件挡住就传 blocked',
        );
      }
      const status: LearnSubmitStatus = rawStatus;

      // ── 失败 / 被阻断分支：不需要正文，只交失败报告 ──
      if (status !== 'success') {
        operation = '校验失败报告';
        const rawReason = args.reason;
        if (typeof rawReason !== 'string' || !(LEARN_FAILURE_REASONS as readonly string[]).includes(rawReason)) {
          return skillFailure(
            '参数错误',
            `reason 必须为 ${LEARN_FAILURE_REASONS.join(' / ')} 之一，实际收到: ${JSON.stringify(rawReason ?? null)}`,
            '按卡点性质选一个分类；实在对不上就用 other 并在 detail 里说清楚',
          );
        }
        const reason = rawReason as LearnFailureReason;
        // detail 单独校验（不走 requireText）：失败提交缺卡点说明是**语义缺失**
        // 而非形态错误，回执要明确告诉模型「失败提交必须说清卡在哪」。
        const rawDetail = args.detail;
        if (typeof rawDetail !== 'string' || !rawDetail.trim()) {
          return skillFailure(
            '参数错误',
            '失败提交必须给出非空的 detail（当前收到空值或非字符串）',
            'detail 写清「卡在哪一步 + 期望什么 + 实际发生了什么」——没有卡点说明的失败报告对用户毫无意义',
          );
        }
        const detail = rawDetail.trim().slice(0, DETAIL_MAX_CHARS);
        // findings 宽容处理：它本来就是「建议填」，形态不对不该把一次
        // 终态提交变成参数错误（模型会在这里反复重试，白白耗掉收尾轮的预算）
        const findings = Array.isArray(args.findings)
          ? args.findings
              .filter((item): item is string => typeof item === 'string')
              .map(item => item.trim().slice(0, FINDING_MAX_CHARS))
              .filter(Boolean)
              .slice(0, FINDING_MAX_COUNT)
          : [];
        const rawSuggestion = args.suggestion;
        if (rawSuggestion !== undefined && rawSuggestion !== null && typeof rawSuggestion !== 'string') {
          return skillFailure(
            '参数错误',
            `suggestion 必须为字符串，实际收到: ${Array.isArray(rawSuggestion) ? 'array' : typeof rawSuggestion}`,
            '不需要时省略 suggestion 字段',
          );
        }
        const suggestion = typeof rawSuggestion === 'string' ? rawSuggestion.trim().slice(0, SUGGESTION_MAX_CHARS) : '';

        const report: LearnFailureReport = {
          reason,
          detail,
          findings,
          ...(suggestion ? { suggestion } : {}),
        };

        const headline =
          status === 'blocked'
            ? '学习已终止：流程被必须由人完成的前置条件挡住。'
            : '学习已终止：流程未跑通，原因已记录。';
        const findingNote =
          findings.length > 0
            ? `已探明的可复用知识 ${findings.length} 条：\n${findings.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
            : '（未提供 findings——本次学习没有留下可复用的结论，建议补上已探明的步骤与线索。）';
        const suggestionNote = suggestion ? `\n建议的下一步：${suggestion}` : '';

        return skillSuccess(
          `${headline}\n` +
            `原因分类：${reason}（${FAILURE_REASON_HINTS[reason]}）\n` +
            `卡点详情：${detail}\n\n` +
            `${findingNote}${suggestionNote}\n\n` +
            `学习阶段结束，接下来由用户决定重新学习还是结束。` +
            // 分类与终态不一致时给出提示（不拒绝）：模型可能把「需要登录」
            // 误记成「流程中断」，这类偏差该被看见，但不该让一次终态提交失败。
            `${consistencyNote(status, reason)}`,
          { failure: report },
        );
      }

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
      if (!name.includes('-')) {
        return skillFailure('参数错误', 'name 缺少平台或任务概述', '使用「平台-任务简短概述」，例如 pinduoduo-search-products');
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
      const bodyIssues = validateLearnSkillBody(body);
      if (bodyIssues.length) {
        return skillFailure('正文结构错误', bodyIssues.join('；'), '补全完成计划与逐项对应的具体操作讲解，并保留全部必要小节；每步写清动作、原因、真实目标特征、成功判据和注意事项');
      }

      // ── allowedTools（非空，未知/学习内部/不符合目标能力的工具要求模型修正）──
      operation = '校验 allowedTools';
      const declaredTools = toStringArray(args.allowedTools, 'allowedTools');
      const internalTools = declaredTools.filter(id => ['submit_skill', 'submit_validation'].includes(id));
      const visualTools = declaredTools.filter(isVisualSkillTool);
      if (internalTools.length || (mode === 'text' && visualTools.length)) {
        return skillFailure('工具声明错误', `allowedTools 包含学习内部工具或文本模式不可依赖的视觉工具：${[...internalTools, ...(mode === 'text' ? visualTools : [])].join(', ')}`, '只声明最终技能执行所依赖的工具；视觉辅助探索使用的工具不必写进文本技能');
      }
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
      if (unknownTools.length > 0) {
        return skillFailure(
          '参数错误',
          `allowedTools 中有未注册的工具: ${unknownTools.join(', ')}`,
          '工具 ID 必须与注册名完全一致（可参考工具测试面板中的名称），例如 browser_interact 而不是 click',
        );
      }

      // ── tags（归一化 + 自动补模式标签；模式标签是模式的唯一持久化表达）──
      operation = '校验 tags';
      const tags = normalizeTags(toStringArray(args.tags, 'tags')).filter(tag => !Object.values(SKILL_MODE_TAG).includes(tag)).slice(0, SKILL_MAX_TAGS - 1);
      const modeTag = SKILL_MODE_TAG[mode];
      if (!tags.includes(modeTag)) tags.push(modeTag);
      const finalTags = tags.slice(0, SKILL_MAX_TAGS);

      // ── summary（可选；长度封顶，避免超长摘要被原样写进技能库）──
      operation = '校验 summary';
      const rawSummary = args.summary;
      if (rawSummary !== undefined && rawSummary !== null && typeof rawSummary !== 'string') {
        return skillFailure(
          '参数错误',
          `summary 必须为字符串，实际收到: ${Array.isArray(rawSummary) ? 'array' : typeof rawSummary}`,
          '不需要时省略 summary 字段',
        );
      }
      const summary = typeof rawSummary === 'string' ? rawSummary.trim() : '';
      if (summary.length > SUMMARY_MAX_CHARS) {
        return skillFailure(
          '参数错误',
          `summary 长度 ${summary.length} 超过上限 ${SUMMARY_MAX_CHARS}`,
          '压缩为一句话：学到了什么、共几步、有哪些关键坑点',
        );
      }

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

      const renamedNote = name !== rawName
        ? `\n名称已规范化为 "${name}"（原始值 "${rawName}"）`
        : '';

      return skillSuccess(
        `技能草稿已提交，学习阶段结束。${renamedNote}\n\n` +
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
        '核对各字段形态后重试：name/description/category/body 为字符串，tags/allowedTools 为字符串数组，mode 为 text 或 vision；' +
          '若本次学习本来就没跑通，直接改用 status=failed 并填 reason/detail/findings 收尾，不必强凑正文',
      );
    }
  }
}

export const submitSkillTool = new SubmitSkillTool();
