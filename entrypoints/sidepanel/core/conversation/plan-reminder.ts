/**
 * 计划状态提醒（plan status reminder）——纯判定与消息构造
 *
 * 与 vision-feedback.ts 同构的「引擎旁路纯函数」模块：
 *   - needsPlanReminder：判定本轮工具执行后是否需要向模型注入计划状态提醒；
 *   - buildPlanReminder：构造合成 user 消息（紧凑清单 + 核对补标指令）。
 *
 * 为什么需要（根因）：计划准则只存在于 system prompt（远端指令，显著度随
 * 上下文增长持续衰减），工具循环中没有近端强化——模型埋头执行时无从被提醒，
 * 倾向把状态标注攒到最后批量补标。本模块把「计划状态」重新呈现到上下文尾部
 * （just-in-time 注入 + recency：对齐 Manus 尾部重写 todo 与 Claude Code 的
 * stale reminder 实践），且只在「模型连续工作而未维护计划」时注入——频率
 * 间隔防每轮刷屏（Manus 的频率教训：过于频繁的 todo 维护会吃掉约三分之
 * 一的动作预算）。
 *
 * 消息为 user 角色合成消息（与 vision 续拍 / finalize 的 [System status]
 * 同构），由引擎在主循环「连续失败守卫之后、vision 续拍之前」追加到尾部：
 * 不改动任何前缀消息，不破坏上下文缓存。引擎接线见 conversation-engine。
 *
 * 正文只携带指针，不复述判定标准与后果清单：补标指令之外附一条覆写逃生口
 * ——计划前提整体失效时改用 create 重建（何时允许覆写的权威句在 plan-prompt
 * 「计划重建」小节，机制与后果的权威句在 plan-tool 工具描述）。没有这条
 * 逃生口，本提醒会无条件命令模型维护一份前提已死的计划，与合法覆写相冲突。
 */

import type { PlanItem } from '@/utils/plan/plan-store';
import { PLAN_TOOL_ID } from '@/tools/plan/plan-prompt';
import type { ChatMessage } from '../../utils/ai/ai-chat-api';

/** 两次提醒之间的最小轮次间隔（引擎运行内轮次计数；防每轮注入刷屏） */
export const PLAN_REMINDER_MIN_ROUND_GAP = 2;

/** 提醒正文中单条步骤文本的截断上限（字符）——30 项 × 300 字符的最坏情况必须钳制 */
const PLAN_REMINDER_STEP_MAX_CHARS = 120;

/** 提醒正文清单的总长度软上限（字符）——超出时截断并注明用 read 取全量 */
const PLAN_REMINDER_MAX_CHARS = 2400;

/** 状态中文标签（与 plan-tool 的 STATUS_LABELS 同口径，独立成表避免工具实例耦合） */
const STATUS_LABELS: Record<PlanItem['status'], string> = {
  pending: '待执行',
  in_progress: '进行中',
  done: '已完成',
  failed: '失败',
};

/** 单轮工具调用形态（接受字符串名或协议 tool_calls 元素；与 VisionCall 同风格） */
export type PlanRoundCall = string | { function?: { name?: unknown } };

function callName(call: PlanRoundCall): string {
  if (typeof call === 'string') return call;
  const name = call.function?.name;
  return typeof name === 'string' ? name : '';
}

export interface PlanReminderInput {
  /** 当前会话计划项（引擎读 plan-store：与 plan_tool 同一内存实例，状态恒同步） */
  items: readonly PlanItem[];
  /** 本轮模型发起的工具调用（判定「有实际工作 / 是否维护过计划」；含失败尝试） */
  roundCalls: readonly PlanRoundCall[];
  /** 当前轮次（1 起，与引擎 totalIterations 同源） */
  iteration: number;
  /** 最近一次提醒注入所在轮次（本次运行内尚无则为 0） */
  lastReminderRound: number;
}

/**
 * 是否需要注入计划状态提醒（以下全部满足）：
 *   1. 计划存在且有未到终态的项（pending / in_progress）——全 done/failed 或
 *      无计划时无事可提醒；
 *   2. 本轮调用过至少一个非 plan_tool 工具——纯计划维护轮或纯文本轮不注入；
 *   3. 本轮没有任何 plan_tool 调用（含失败尝试）——模型正在维护计划时不打扰；
 *   4. 距上次注入 ≥ PLAN_REMINDER_MIN_ROUND_GAP 轮——频率间隔防刷屏。
 */
export function needsPlanReminder(input: PlanReminderInput): boolean {
  const hasOpenItems = input.items.some(
    item => item.status === 'pending' || item.status === 'in_progress',
  );
  if (!hasOpenItems) return false;
  let touchedPlan = false;
  let didWork = false;
  for (const call of input.roundCalls) {
    const name = callName(call);
    if (!name) continue;
    if (name === PLAN_TOOL_ID) touchedPlan = true;
    else didWork = true;
  }
  if (touchedPlan || !didWork) return false;
  return input.iteration - input.lastReminderRound >= PLAN_REMINDER_MIN_ROUND_GAP;
}

/**
 * 构造计划状态提醒消息（user 角色合成消息；引擎负责 push history 与持久化）。
 * 清单为空返回 null（与 needsPlanReminder 的前置条件互为兜底）。
 * 单条步骤与整份清单均有截断上限：提醒是注意力锚点而非全量数据，细节用
 * plan_tool read 按需获取。
 */
export function buildPlanReminder(items: readonly PlanItem[]): ChatMessage | null {
  if (items.length === 0) return null;
  const lines: string[] = [];
  let total = 0;
  for (const item of items) {
    const step =
      item.step.length > PLAN_REMINDER_STEP_MAX_CHARS
        ? `${item.step.slice(0, PLAN_REMINDER_STEP_MAX_CHARS)}…`
        : item.step;
    const line = `${item.id}. [${STATUS_LABELS[item.status]}] ${step}`;
    if (total + line.length > PLAN_REMINDER_MAX_CHARS) {
      lines.push('（其余项已省略，用 plan_tool read 读取全量计划）');
      break;
    }
    lines.push(line);
    total += line.length;
  }
  return {
    role: 'user',
    content:
      '<plan-status-reminder>\n' +
      '当前计划状态：\n' +
      `${lines.join('\n')}\n` +
      '若其中有实际已经完成或已经失败但尚未标注的项，必须先用 plan_tool edit 标注（done 附简要成果 / failed 附失败原因），然后才能继续下一步动作；开始新步骤前先标 in_progress。\n' +
      '若计划前提已整体失效（目标变更 / 路径整体错误），不要继续维护旧计划——改用 plan_tool create 一次性重建后再继续（判定标准见任务计划准则「计划重建」小节，旧状态会全部丢失且不可恢复）。\n' +
      '</plan-status-reminder>',
  };
}
