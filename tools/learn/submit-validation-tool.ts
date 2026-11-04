/**
 * submit_validation —— 网站学习验证阶段的终止型提交工具
 *
 * 与 submit_skill 同构（terminal 终止型 + 结构化校验 + 可控失败回传），
 * 但职责是**验收**：验证阶段由目标操作模式对应的执行智能体（文本通用助手 /
 * 视觉通用助手）按技能指引盲测一遍，本工具承接其结论并结束该阶段。
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
  };
}

function asArgs(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  throw new Error(
    `arguments 必须为 JSON 对象，实际收到: ${Array.isArray(raw) ? 'array' : typeof raw}`,
  );
}

/** 问题清单清洗：丢弃非字符串、去首尾空白、逐条截断、去空、限条数 */
function normalizeIssues(value: unknown): { issues: string[]; truncated: number } {
  if (value === undefined || value === null) return { issues: [], truncated: 0 };
  if (!Array.isArray(value)) {
    throw new Error(`issues 必须是字符串数组，实际收到: ${typeof value}`);
  }
  const issues: string[] = [];
  let truncated = 0;
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (issues.length >= ISSUE_MAX_COUNT) break;
    if (trimmed.length > ISSUE_MAX_CHARS) {
      issues.push(`${trimmed.slice(0, ISSUE_MAX_CHARS)}…`);
      truncated += 1;
    } else {
      issues.push(trimmed);
    }
  }
  return { issues, truncated };
}

export class SubmitValidationTool extends BaseTool {
  name = TOOL_NAME;

  metadata: ToolMetadata = {
    name: TOOL_NAME,
    description: '提交技能验证结论并结束当前验证阶段',
    category: 'learn',
    version: '1.0.0',
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
        '必须在完整按技能指引执行过目标任务之后调用。参数不合法会返回可读错误且**不会**' +
        '结束验证，请按错误提示修正后重新提交。',
      parameters: {
        type: 'object',
        properties: {
          passed: {
            type: 'boolean',
            description:
              '技能是否有效：true=严格按技能步骤成功完成了目标任务；' +
              'false=存在关键步骤无法完成（定位失败 / 顺序错误 / 遗漏分支 / 坑点未提示）。',
          },
          issues: {
            type: 'array',
            items: { type: 'string' },
            description:
              `不通过时的具体问题清单（每条一行，≤${ISSUE_MAX_CHARS} 字符，最多 ${ISSUE_MAX_COUNT} 条），` +
              '写清「哪一步 + 期望什么 + 实际发生什么」，供决策与后续修订使用。通过时可省略或传空数组。',
          },
          score: {
            type: 'number',
            description: '可选：0-100 的完成度评分（定位命中率与步骤可执行性的综合），通过与否仍以 passed 为准。',
          },
          summary: {
            type: 'string',
            description: '可选：一句话验证结论（按技能执行的总体感受、最薄弱的环节）。',
          },
        },
        required: ['passed', 'issues'],
      },
    },
  };

  async execute(rawArgs: unknown): Promise<ToolResult> {
    let operation = '参数校验';
    try {
      const args = asArgs(rawArgs);

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

      // ── issues：清洗 + 不通过时硬校验非空 ──
      operation = '校验 issues';
      const { issues, truncated } = normalizeIssues(args.issues);
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

      const report: ValidationReport = {
        passed,
        issues,
        ...(score !== undefined ? { score } : {}),
        ...(summary ? { summary } : {}),
      };

      const truncatedNote = truncated > 0 ? `\n注意：${truncated} 条问题超长已截断至 ${ISSUE_MAX_CHARS} 字符。` : '';
      const head = passed
        ? `验证通过：按技能指引成功完成目标任务（${issues.length > 0 ? `另有 ${issues.length} 条改进建议` : '无遗留问题'}）。`
        : `验证未通过：发现 ${issues.length} 个问题。`;
      const issueList = issues.length > 0
        ? `\n\n问题清单：\n${issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')}`
        : '';

      return validationSuccess(
        `${head}${truncatedNote}${issueList}\n\n验证阶段结束，等待处理结论。`,
        { report },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log(`提交验证结论失败（${operation}）: ${reason}`, 'warn');
      return validationFailure(
        '参数错误',
        reason,
        '核对参数形态后重试：passed 为布尔值，issues 为字符串数组',
      );
    }
  }
}

export const submitValidationTool = new SubmitValidationTool();
