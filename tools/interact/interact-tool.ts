/**
 * interact 交互工具
 *
 * 对齐 Claude Code（AskUserQuestion）/ Codex 桌面端的人机交互实践：
 * 模型在「需要用户决策 / 需要敏感操作授权 / 缺少必要信息」时调用本工具，
 * 界面弹出询问窗口——用户可点选预设选项，也始终可以输入自定义答复。
 *
 * 执行链路：参数清洗 → 经 UI 桥接（interact-ui-bridge）交给 sidepanel 弹窗 →
 * 等待真实用户操作 → 把收敛结果（答复 / 拒绝 / 超时）转写回模型可读的
 * ToolResult。等待时长由 UI 层按用户设置（默认 20 分钟，可配置）控制，
 * 本层不做超时（conversation-engine 对交互工具豁免了统一工具超时）。
 *
 * 防御性设计：
 *   - 参数逐字段清洗（宽容类型收敛 / 去空白 / 长度钳制 / 选项去重与截断），
 *     任何形态的脏入参都转为可读错误结果，不抛异常中断对话；
 *   - UI 处理器未注册（background 等无弹窗上下文）时立即返回错误结果；
 *   - 处理器异常与非对象返回值同样收敛为失败结果，绝不悬挂 Promise、
 *     不让实现缺陷外溢为晦涩的 TypeError；
 *   - 收敛结果经形态校验后才转写（answered=true 必须携带非空字符串答复）。
 */

import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import {
  getInteractHandler,
  type InteractOption,
  type InteractRequest,
  type InteractResolution,
} from './interact-ui-bridge';

// ==================== 参数清洗常量 ====================

/** 各字段长度上限（防模型输出超长文本撑爆弹窗与上下文） */
const QUESTION_MAX_CHARS = 1000;
const CONTEXT_MAX_CHARS = 2000;
const OPTION_LABEL_MAX_CHARS = 120;
const OPTION_DESC_MAX_CHARS = 300;
/** 选项数量上限（对齐 Claude Code AskUserQuestion 的 4-5 项惯例；schema 侧同值约束） */
const MAX_OPTIONS = 5;

/**
 * 宽容收敛为文本：字符串去空白；有限数字 / 布尔转字符串（模型偶发以标量
 * 传字符串字段，属可无损修复的偏差，直接拒绝反而制造无效往返）；其余
 * 类型（null/undefined/对象/数组/NaN）返回 undefined 由调用方按缺失处理。
 */
function toText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

/** 长度钳制：空值透传 undefined，超长截断（附截断标记，模型与用户可感知） */
function clampText(text: string | undefined, maxChars: number): string | undefined {
  if (text === undefined) return undefined;
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/**
 * 清洗单个选项的原始形态：
 *   - 字符串项（模型常见偏差 options: ["允许", "拒绝"]）宽容转为 { label }；
 *   - 对象项取 label / description，均经 toText + clampText 单次收敛。
 * label 缺失或清洗后为空 → 返回 null（调用方跳过）。
 */
function sanitizeOptionItem(item: unknown): InteractOption | null {
  const record =
    typeof item === 'string'
      ? ({ label: item } as Record<string, unknown>)
      : item !== null && typeof item === 'object'
        ? (item as Record<string, unknown>)
        : null;
  if (!record) return null;
  const label = clampText(toText(record.label), OPTION_LABEL_MAX_CHARS);
  if (!label) return null;
  const description = clampText(toText(record.description), OPTION_DESC_MAX_CHARS);
  return description !== undefined ? { label, description } : { label };
}

/** 清洗选项列表：宽容收敛 + 去空 + 按 label 去重 + 数量截断（保留前 MAX_OPTIONS 个） */
function sanitizeOptions(raw: unknown): InteractOption[] {
  if (!Array.isArray(raw)) return [];
  const options: InteractOption[] = [];
  const seenLabels = new Set<string>();
  for (const item of raw) {
    if (options.length >= MAX_OPTIONS) break;
    const option = sanitizeOptionItem(item);
    if (!option || seenLabels.has(option.label)) continue;
    seenLabels.add(option.label);
    options.push(option);
  }
  return options;
}

/** 收敛结果 → 模型可读文案（工具与用户之间唯一的语义翻译层） */
function resolutionToText(resolution: InteractResolution): string {
  if (resolution.answered) {
    const sourceLabel =
      resolution.source === 'custom' ? '自定义输入' : resolution.source === 'option' ? '选择预设选项' : '答复';
    return `用户已答复（来源：${sourceLabel}）：\n${resolution.answer ?? ''}`;
  }
  switch (resolution.status) {
    case 'declined':
      return (
        '用户明确拒绝了本次询问，未提供答复。\n' +
        '请勿就同一问题再次询问或变换措辞重试；请总结当前进展，结束本轮任务，或仅执行用户此前已明确授权的操作。'
      );
    case 'timeout':
      return (
        '用户超时未响应（可能暂时不在线，未能在等待时限内作答）。\n' +
        '如该决策对任务推进重要（尤其是敏感或不可逆操作），必须暂停相关工作：向用户说明当前进展与待决事项后结束本轮，等待用户回来再次发起。'
      );
    case 'dismissed':
    default:
      return (
        '本次询问被中断（用户停止了任务或切换了会话），未能获得答复。\n' +
        '请停止后续依赖该决策的操作，总结当前进展后结束。'
      );
  }
}

export class InteractTool extends BaseTool {
  name = 'interact';

  metadata: ToolMetadata = {
    name: 'interact',
    description:
      '向用户提问、澄清需求或请求手动处理：弹出询问窗口，等待预设选项或自定义答复。支持 confirm 的操作通过工具自身审批，不重复询问。',
    category: 'interact',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['interact', 'ask-user', 'confirmation', 'authorization'],
    // 纯对话工具（弹窗征询，不触碰页面）：视觉循环无需重拍
    noVisionRecapture: true,
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'interact',
      description:
        '向用户提问、请求补充信息或手动处理，界面弹窗等待选项或自定义答复。用于关键需求歧义、缺少必要信息或需要用户亲自登录/完成验证码；后者 sensitive=true，只请用户在网站中处理，不索取明文密码、验证码或密钥。支持 confirm 的执行工具按其统一说明传 confirm=true，由审批回调请求同一操作的授权，不先调用 interact 重复询问。搜索、筛选、导航、读取公开 API 等普通操作不需要授权询问。提供 options 时用户仍可自定义答复；同一问题不重复询问，拒绝或未答复后停止依赖该答复的操作。',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: '要问用户的问题，简洁明确（例如：「是否授权我使用已保存的账号登录？」）',
          },
          context: {
            type: 'string',
            description: '背景说明：为什么要问 / 即将执行什么操作及其后果，帮助用户判断（敏感授权时必填）',
          },
          options: {
            type: 'array',
            description: '候选选项（最多 5 个；可省略 = 开放式提问）。每个选项简洁且互斥',
            maxItems: MAX_OPTIONS,
            items: {
              type: 'object',
              properties: {
                label: {
                  type: 'string',
                  description: '选项文本（将作为答复提交）',
                },
                description: {
                  type: 'string',
                  description: '选项补充说明（帮助用户理解，不提交）',
                },
              },
              required: ['label'],
            },
          },
          sensitive: {
            type: 'boolean',
            description: '问题是否涉及资金、凭据、账号安全或隐私；true 仅改变询问警示样式，不替代执行工具的 confirm 审批。',
          },
        },
        required: ['question'],
      },
    },
  };

  async execute(raw: unknown, executionContext?: { chatId?: string }): Promise<ToolResult> {
    // ── 入参形态防御：非对象统一收敛为空对象（缺失 question 走可读错误） ──
    const args =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};

    const question = clampText(toText(args.question), QUESTION_MAX_CHARS);
    if (!question) {
      return this.createErrorResponse('缺少必填参数 question（要问用户的问题），请补全后重试');
    }
    const context = clampText(toText(args.context), CONTEXT_MAX_CHARS);
    const options = sanitizeOptions(args.options);
    // 宽容接受布尔 true 与字符串 "true"（模型偶发的类型偏差，语义无损）
    const sensitive = args.sensitive === true || args.sensitive === 'true';

    // ── UI 处理器就绪检查：无弹窗上下文（background 等）时立即失败，绝不悬挂 ──
    const handler = getInteractHandler();
    if (!handler) {
      return this.createErrorResponse(
        '当前上下文没有可用的用户界面（interact 需要在侧边栏对话界面中执行），无法向用户提问；请改为直接在回复中说明情况并结束本轮',
      );
    }

    const request: InteractRequest = {
      question,
      ...(context !== undefined ? { context } : {}),
      options,
      sensitive,
    };

    // ── 等待真实用户答复；处理器任何异常都收敛为失败结果 ──
    let resolution: InteractResolution;
    try {
      resolution = await handler(request, executionContext);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.createErrorResponse(`询问用户时发生异常: ${reason}`);
    }

    // ── 结果形态防御：处理器返回非对象（未来实现的缺陷）按询问被中断收敛，
    //    不让属性访问异常外溢为晦涩的 TypeError ──
    if (resolution === null || typeof resolution !== 'object') {
      console.warn('[interact] UI 处理器返回非法结果，已按询问被中断处理:', resolution);
      resolution = { answered: false, status: 'dismissed' };
    }

    // ── 结果防御：answered=true 必须携带非空字符串答复（非字符串形态按
    //    空答复处理 → 未答复收敛），否则按未答复收敛 ──
    const rawAnswer = resolution.answer;
    const answer = typeof rawAnswer === 'string' ? rawAnswer.trim() : '';
    if (resolution.answered && !answer) {
      resolution = { answered: false, status: 'dismissed' };
    }

    const text = resolutionToText(
      resolution.answered ? { ...resolution, answer } : resolution,
    );

    return {
      success: true,
      isError: false,
      content: [{ type: 'text', text }],
      data: {
        answered: resolution.answered,
        ...(resolution.answered
          ? { answer, source: resolution.source ?? 'custom' }
          : { status: resolution.status ?? 'dismissed' }),
        sensitive,
      },
    };
  }
}

export const interactTool = new InteractTool();
