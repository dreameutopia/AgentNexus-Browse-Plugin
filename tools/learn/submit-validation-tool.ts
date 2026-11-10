/**
 * submit_validation —— 网站学习验证阶段的终止型提交工具
 *
 * 与 submit_skill 同构（terminal 终止型 + 结构化校验 + 可控失败回传），
 * 职责是独立抽样验收与有证据的通用修订；完整替换正文经过结构守卫后由编排应用。
 *
 * 结果去向由编排层决定：
 *   - passed=true  → 进入技能落盘（跳转管理中心预填）；
 *   - passed=false → 交用户决策「重新学习」或「仍要创建」。
 * 两种去向都依赖 issues 的具体性——故 passed=false 时 issues 非空是硬校验：
 * 一个没有问题清单的「不通过」无法支撑任何决策。
 *
 * 失败（参数不合法）不触发终止：模型可在下一轮修正后重新提交。
 */

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import type { ValidationReport } from '@/utils/learn/learn-types';
import { parseValidationRevision } from '@/utils/learn/learn-validate';
import { SKILL_BODY_MAX_CHARS } from '@/utils/skills/skill-types';

const TOOL_NAME = 'submit_validation';

/** 单条问题的最大长度（防止模型粘贴整页日志撑爆结果） */
const ISSUE_MAX_CHARS = 500;
/** 问题条数上限 */
const ISSUE_MAX_COUNT = 20;

/** 成功结果：content 供模型阅读，data 供程序消费 */
function validationSuccess(text: string, data: Record<string, unknown>): ToolResult {
  return {
    success: true,
    isError: false,
    content: [{ type: 'text', text }],
    data,
    // 回执正文在 content，data 是结构化回执字段——正题在 content
    primary: 'content',
  };
}

/** 失败结果：错误类型 + 原因 + 处置建议 */
function validationFailure(kind: string, reason: string, hint: string): ToolResult {
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
    // 失败说明在 content——正题在 content
    primary: 'content',
  };
}

function asArgs(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  throw new Error(
    `arguments 必须为 JSON 对象，实际收到: ${Array.isArray(raw) ? 'array' : typeof raw}`,
  );
}

/** Reject malformed evidence/problems instead of silently losing their meaning. */
function stringList(value: unknown, field: string, maxCount: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxCount || value.some(item => typeof item !== 'string' || !item.trim() || item.length > ISSUE_MAX_CHARS))
    throw new Error(`${field} 必须为最多 ${maxCount} 条非空字符串，每条不超过 ${ISSUE_MAX_CHARS} 字符；请保留关键事实后重试`);
  return value.map(item => item.trim());
}

export class SubmitValidationTool extends BaseTool {
  name = TOOL_NAME;

  metadata: ToolMetadata = {
    name: TOOL_NAME,
    description: '提交技能验证结论并结束当前验证阶段',
    category: 'learn',
    version: '1.1.0',
    author: 'AgentNexus',
    tags: ['learn', 'validation', 'submit', 'terminal'],
    // 终止型：成功执行即结束本轮运行（见文件头说明）
    terminal: true,
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAME,
      description:
        '提交对给定技能的验证结论并结束验证阶段。这是验证阶段唯一的结束方式——' +
        '先从起点按技能完成端到端抽样核验；批量任务用 2–3 条有差异的样本检查通用性，不执行整批，不重复发送/投递。' +
        '通过必须附实际 evidence（修订时可沿用 revision.evidence），且 issues 为空；定位错误、缺参、依赖缺失或未复核差异属于未解决问题，不能借环境额外能力绕过后当作原稿通过。纯可选建议放 suggestions，评分可省略。' +
        '发现问题可做针对当前任务的通用修订：默认路径与特殊条件分开写，受影响步骤重新验证通过后，passed=true 并通过 revision 提交完整替换正文、修改原因及实际证据；不得扩大任务或工具权限。未验证的修改不提交 revision，保留问题并传 passed=false。参数不合法会返回可读错误且**不会**' +
        '结束验证，请按错误提示修正后重新提交。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          passed: {
            type: 'boolean',
            description:
              '技能是否在声明范围内可复用：true=原文或修订后的流程已通过端到端及差异样本核验；' +
              'false=存在关键步骤无法完成（定位失败 / 顺序错误 / 遗漏分支 / 坑点未提示）。',
          },
          issues: {
            type: 'array', maxItems: ISSUE_MAX_COUNT,
            items: { type: 'string', minLength: 1, maxLength: ISSUE_MAX_CHARS },
            description:
              `问题清单（每条一行，≤${ISSUE_MAX_CHARS} 字符，最多 ${ISSUE_MAX_COUNT} 条），` +
              '写清「哪一步 + 期望什么 + 实际发生什么」，供决策与后续修订使用。' +
              'passed=false 时必填且不能为空（没有清单的「不通过」无法支撑决策）；' +
              'passed=true 时必须省略或为空数组；已修复的问题写入 revision.summary/evidence，不影响正确性的建议放 suggestions。',
          },
          suggestions: {
            type: 'array', maxItems: 6, items: { type: 'string', maxLength: ISSUE_MAX_CHARS },
            description: '可选，最多6条不影响执行正确性的改进建议。不得用建议掩盖未修复的步骤、定位、参数或工具依赖问题。',
          },
          evidence: {
            type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', maxLength: ISSUE_MAX_CHARS },
            description: 'passed=true 时必填（有 revision 时可省略并沿用 revision.evidence）：简述实际样本/差异状态、关键步骤与业务回执、未覆盖范围；不得仅写“成功”。已有写操作可只读核对，不为凑证据额外发送。',
          },
          score: {
            type: 'number',
            description: '可选：0-100 的可复用性评分（定位、步骤可执行性与差异样本复核的综合），不是整批完成比例，通过与否仍以 passed 为准。',
          },
          summary: {
            type: 'string',
            description: '可选：一句话验证结论（按技能执行的总体感受、最薄弱的环节）。',
          },
          revision: {
            type: 'object', additionalProperties: false,
            description: '可选，仅 passed=true 且修订后重新验证通过时提供。仅替换正文，保留原技能名称、任务范围、模式和 allowedTools；未修改则省略。',
            properties: {
              body: { type: 'string', maxLength: SKILL_BODY_MAX_CHARS, description: '完整 Markdown 正文，不含 frontmatter；保留目标、前置条件、完成计划、具体操作讲解、分支与坑点、完成判定、边界七节及对应编号。参数化通用步骤，说明特殊情况的识别条件与处理路径，标明未验证范围。' },
              summary: { type: 'string', maxLength: 500, description: '修改了什么、为什么是当前任务可复用的修正。' },
              evidence: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', maxLength: 500 }, description: '实际复核的样本差异、受影响步骤、观察到的结果和覆盖限制；不可用假设冒充证据。' },
            },
            required: ['body', 'summary', 'evidence'],
          },
        },
        // 只把 passed 列为必填：issues 的「不通过时必填」由工具层按 passed 分支校验。
        // 把它写进 schema 的 required 会让「通过且无遗留问题」的提交也必须带一个
        // 空数组——纯仪式要求，却给模型多一个可以踩空的参数位。
        required: ['passed'],
      },
    },
  };

  async execute(rawArgs: unknown): Promise<ToolResult> {
    let operation = '参数校验';
    try {
      const args = asArgs(rawArgs);
      if (Object.keys(args).some(key => !['passed', 'issues', 'suggestions', 'evidence', 'score', 'summary', 'revision'].includes(key)))
        throw new Error('存在未知参数；修订仅通过 revision 提交');

      // ── passed：严格布尔（字符串 "true" 不接受——静默强转会把失败判成通过）──
      operation = '校验 passed';
      if (typeof args.passed !== 'boolean') {
        return validationFailure(
          '参数错误',
          `passed 必须是布尔值 true/false，实际收到: ${JSON.stringify(args.passed ?? null)}`,
          '按验证结果显式传 true 或 false',
        );
      }
      const passed = args.passed;

      // ── Unresolved problems and optional suggestions have distinct meanings. ──
      operation = '校验 issues';
      const issues = stringList(args.issues, 'issues', ISSUE_MAX_COUNT);
      const suggestions = stringList(args.suggestions, 'suggestions', 6);
      if (passed && issues.length) throw new Error('passed=true 不允许未解决的 issues；修复并复核后提交 revision，或 passed=false。纯可选建议使用 suggestions');
      if (!passed && issues.length === 0) {
        return validationFailure(
          '参数错误',
          'passed=false 时 issues 不能为空——没有问题清单的「不通过」无法支撑「重新学习 / 仍要创建」的决策',
          '逐条列出卡住的步骤：第几步、期望什么、实际发生什么',
        );
      }

      // ── score：可选数值，范围钳制（脏值不阻断，钳制后回告）──
      const rawScore = args.score;
      let score: number | undefined;
      if (rawScore !== undefined && rawScore !== null) {
        if (typeof rawScore !== 'number' || !Number.isFinite(rawScore)) {
          return validationFailure(
            '参数错误',
            `score 必须是数字，实际收到: ${JSON.stringify(rawScore)}`,
            '不需要评分时省略 score 字段',
          );
        }
        score = Math.max(0, Math.min(100, Math.round(rawScore)));
      }

      // ── summary：可选字符串 ──
      const rawSummary = args.summary;
      if (rawSummary !== undefined && rawSummary !== null && typeof rawSummary !== 'string') {
        return validationFailure(
          '参数错误',
          `summary 必须为字符串，实际收到: ${Array.isArray(rawSummary) ? 'array' : typeof rawSummary}`,
          '不需要时省略 summary 字段',
        );
      }
      const summary = typeof rawSummary === 'string' ? rawSummary.trim() : '';
      operation = '校验修订与复核证据';
      if (args.revision !== undefined && !passed)
        throw new Error('revision 仅在修改后的流程已重新验证通过、passed=true 时接受；未证实的修改请记入 issues，原草稿会保留');
      const revision = args.revision === undefined ? undefined : parseValidationRevision(args.revision);
      const evidence = args.evidence === undefined ? revision?.evidence ?? [] : stringList(args.evidence, 'evidence', 6);
      if (passed && !evidence.length) throw new Error('passed=true 必须提供实际 evidence；修订可沿用 revision.evidence。没有复核证据时请继续核验或 passed=false 说明缺口');

      const report: ValidationReport = {
        passed,
        issues,
        ...(suggestions.length ? { suggestions } : {}),
        ...(evidence.length ? { evidence } : {}),
        ...(score !== undefined ? { score } : {}),
        ...(summary ? { summary } : {}),
        ...(revision ? { revision } : {}),
      };

      const head = passed
        ? `验证通过：${revision ? '修订后的' : '原'}技能已完成抽样复核（无未解决问题）。`
        : `验证未通过：发现 ${issues.length} 个问题。`;
      const issueList = issues.length > 0
        ? `\n\n问题清单：\n${issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')}`
        : '';
      const suggestionList = suggestions.length ? `\n\n可选建议：\n${suggestions.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : '';
      const evidenceList = evidence.length ? `\n\n复核证据与覆盖范围：\n${evidence.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : '';

      return validationSuccess(
        `${head}${issueList}${suggestionList}${evidenceList}\n\n验证阶段结束，等待处理结论。`,
        { report },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log(`提交验证结论失败（${operation}）: ${reason}`, 'warn');
      return validationFailure(
        '参数错误',
        reason,
        '按具体错误修正后重试：issues 只写未解决问题；通过须有实际 evidence，修订须已复核。无证据或有未解决问题则 passed=false',
      );
    }
  }
}

export const submitValidationTool = new SubmitValidationTool();
