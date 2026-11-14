/**
 * 计划统一工具（plan_tool）
 *
 * 会话级任务计划的唯一操作入口：长难任务的步骤清单与执行状态跟踪。
 * action 语义（与 plan-store 的存储操作一一对应）：
 *   - create：建立计划；已有计划时为覆写式重建（一次调用原子替换整份计划；
 *     何时允许覆写的判定标准由 plan-prompt 的「计划重建」小节统一定义，
 *     机制与后果的权威句在本文件工具描述——三层分工见 plan-prompt 文件头）；
 *   - add：追加步骤（计划不存在时自动建立）；
 *   - edit：标注单项状态（pending / in_progress / done / failed；failed 必填
 *     message 记录失败原因——硬校验，错误信息可读可自纠）；
 *   - delete：按 id 列表删除条目；
 *   - read：读取全量计划（id + 步骤 + 状态 + 标注信息）。
 *
 * 会话上下文：execute 的第二参数 context.chatId 由会话引擎在工具执行时注入
 * （并发运行各自隔离）；缺省回落 plan-store 的活跃会话兜底绑定。两者皆空时
 * 返回可读错误（正常链路不应发生，防御外部调用方）。
 *
 * 结果契约：成功结果的 data 恒含 action / chatId / items（每项含 id），
 * 消息正文（content）为模型可直接阅读的计划清单文本；失败结果为
 * 「工具名 + 操作 + 错误类型 + 原因 + 处置建议」结构化文本。
 */

import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata, type ToolExecutionContext } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { BaseTool } from '../base-tool';
import {
  createPlan,
  addPlanItems,
  editPlanItem,
  deletePlanItems,
  getPlan,
  getActivePlanChatId,
  isPlanItemStatus,
  PLAN_MAX_ITEMS,
  PLAN_STEP_MAX_CHARS,
  PLAN_MESSAGE_MAX_CHARS,
  type PlanItem,
  type PlanItemStatus,
} from '@/utils/plan/plan-store';

const TOOL_NAME = 'plan_tool';

type PlanAction = 'create' | 'add' | 'edit' | 'delete' | 'read';

const ACTION_LIST: PlanAction[] = ['create', 'add', 'edit', 'delete', 'read'];

function isPlanAction(value: unknown): value is PlanAction {
  return typeof value === 'string' && (ACTION_LIST as string[]).includes(value);
}

/** 状态的模型可读标签（正文清单用） */
const STATUS_LABELS: Record<PlanItemStatus, string> = {
  pending: '待执行',
  in_progress: '进行中',
  done: '已完成',
  failed: '失败',
};

/** 成功结果：content（模型阅读的清单文本）与 data（程序消费）双通道 */
function planSuccess(text: string, data: Record<string, unknown>): ToolResult {
  return {
    success: true,
    isError: false,
    content: [{ type: 'text', text }],
    data,
    // 清单正文（模型读的那份）在 content，data 是结构化计划项——正题在 content
    primary: 'content',
  };
}

/** 失败结果：错误类型 + 原因 + 处置建议的结构化文本（可分析可自纠） */
function planFailure(operation: string, kind: string, reason: string, hint?: string): ToolResult {
  const text =
    `[${TOOL_NAME}] ${operation}失败\n` +
    `错误类型: ${kind}\n` +
    `原因: ${reason}` +
    (hint ? `\n处置建议: ${hint}` : '');
  return {
    success: false,
    isError: true,
    error: text,
    content: [{ type: 'text', text }],
    data: { errorKind: kind, operation },
    // 失败说明只在 content 里——正题在 content
    primary: 'content',
  };
}

/** 入参防御：模型输出不可信，非对象形态收敛为可读参数错误 */
function asArgs(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  throw new Error(
    `arguments 必须为 JSON 对象，实际收到: ${Array.isArray(raw) ? 'array' : typeof raw}`,
  );
}

/** 步骤数组形态校验（必须是非空数组；逐项清洗——非法/重复项丢弃——在 store 层完成） */
function requireStepsArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `steps 必须为非空数组（1-${PLAN_MAX_ITEMS} 项，元素为步骤文本字符串；空/非字符串/重复项会被丢弃），实际收到: ${JSON.stringify(value ?? null)}`,
    );
  }
  return value;
}

/** 计划清单的模型可读文本（id + 状态 + 步骤 + 标注信息） */
function renderItems(items: readonly PlanItem[]): string {
  if (items.length === 0) return '（当前会话没有计划）';
  return items
    .map(
      item =>
        `${item.id}. [${STATUS_LABELS[item.status]}] ${item.step}` +
        (item.message ? `\n   标注: ${item.message}` : ''),
    )
    .join('\n');
}

export class PlanTool extends BaseTool {
  name = TOOL_NAME;

  metadata: ToolMetadata = {
    name: TOOL_NAME,
    description: '会话任务计划工具：create/add/edit/delete/read 管理当前会话的步骤清单与执行状态',
    category: 'plan',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['plan', 'todo', 'task-tracking'],
    // 全部操作均为会话内可逆状态变更，无需人审
    // 会话内存数据操作，不触碰页面：视觉循环无需重拍
    noVisionRecapture: true,
    // 零成本状态工具：运行时长上限到达后仍放行——否则模型无法把已完成的
    // 步骤标注为 done，计划状态与真实进度脱节（见 registry 的准入语义）
    zeroCostStateTool: true,
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAME,
      description:
        '管理当前会话的任务计划（步骤清单 + 执行状态），用于长难任务的方向保持与进度外显。通过 action 指定操作：\n' +
        '- create：建立计划（steps 为步骤文本数组）→ 返回全部计划项及各自 id。每会话一份；已有计划时为覆写式重建——一次调用原子替换整份计划（不要先 delete 清空再 create），原条目、状态与标注立即永久丢失、不可恢复，旧 id 全部失效且不会与新 id 冲突（id 只增不复用），已完成的工作本身不受影响。仅当计划前提整体失效（目标变更 / 路径整体坍塌）时选用，判定标准见系统提示词「计划重建」小节；计划大体仍对时一律 add/edit/delete 局部演进\n' +
        '- add：追加步骤（steps 数组）→ 返回新增项及 id\n' +
        '- edit：标注单项状态（id + status: pending/in_progress/done/failed；message 可选）。failed 时 message 必填，写清失败原因；done 时 message 简要写明成果\n' +
        '- delete：删除条目（ids 为 id 数组）\n' +
        '- read：读取全量计划（每项含 id、状态与标注信息）\n' +
        '更新纪律（硬性）：开始一项先标 in_progress；一项有结果（成功或失败皆算）后，下一步动作前必须先 edit 标注——done 附简要成果、failed 必附失败原因；失败也要立即标注，严禁攒到最后批量补标或提前标记未执行项；跨轮沿用既有计划（先 read 再按 id edit；create 是覆写式重建，仅限计划前提整体失效时）；id 只用工具返回值或错误信息回显值，edit 报「目标不存在」时按回显清单修正重试；3 步以上的多步任务才建计划。执行中若收到 <plan-status-reminder> 状态回显，先核对补标再继续。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ACTION_LIST,
            description: '要执行的计划操作',
          },
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: `create/add 的步骤文本数组（1-${PLAN_MAX_ITEMS} 项，单项 ≤${PLAN_STEP_MAX_CHARS} 字符）`,
          },
          id: {
            type: 'string',
            description: 'edit 操作的目标计划项 id',
          },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'done', 'failed'],
            description: 'edit 操作的目标状态',
          },
          message: {
            type: 'string',
            description: `状态标注信息（done=简要成果；failed=失败原因，必填；≤${PLAN_MESSAGE_MAX_CHARS} 字符）。省略=保持（状态变更时旧标注自动作废）；空字符串=主动清除标注`,
          },
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'delete 操作的目标 id 列表',
          },
        },
        required: ['action'],
      },
    },
  };

  /**
   * 执行计划操作。第二参数 context 由会话引擎注入（chatId 为会话隔离键）；
   * BaseTool 契约只声明第一参数，此处以可选参数扩展，对其它调用方零影响。
   */
  async execute(rawArgs: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
    let action = '';
    try {
      const args = asArgs(rawArgs);
      if (!isPlanAction(args.action)) {
        return planFailure(
          '参数校验',
          '参数错误',
          `action 必须为 ${ACTION_LIST.join(' / ')} 之一，实际收到: ${JSON.stringify(args.action ?? null)}`,
          '在 arguments 中显式传入 action 字段；五种操作共用本工具',
        );
      }
      action = args.action;

      // 会话上下文解析：引擎注入优先，活跃会话兜底；皆空给可读错误
      const chatId =
        (typeof context?.chatId === 'string' && context.chatId.trim()) || getActivePlanChatId();
      if (!chatId) {
        return planFailure(
          `计划操作(${action})`,
          '会话上下文缺失',
          '当前调用未携带会话标识，且无活跃会话兜底',
          '该工具只能在对话会话内使用；若在会话中遇到此错误请直接以文字回应说明情况',
        );
      }

      switch (action) {
        case 'create':
          return this.handleCreate(chatId, requireStepsArray(args.steps));
        case 'add':
          return this.handleAdd(chatId, requireStepsArray(args.steps));
        case 'edit':
          return this.handleEdit(chatId, args);
        case 'delete':
          return this.handleDelete(chatId, args);
        case 'read':
          return this.handleRead(chatId);
      }
      // isPlanAction 收窄后的理论不可达分支：防御性兜底，保证全路径有返回值
      return planFailure('参数校验', '参数错误', `未处理的 action: ${JSON.stringify(action)}`, '请传入受支持的 action');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log(`计划操作(${action || '未知 action'})失败: ${reason}`, 'warn');
      return planFailure(
        `计划操作(${action || '未知 action'})`,
        '参数错误',
        reason,
        '请核对参数形态后重试（steps/ids 须为字符串数组，id/status 为字符串）',
      );
    }
  }

  // ── create：覆写式重建（判定标准见 plan-prompt「计划重建」小节；
  //    结果正文显式提示后果，保留测试锚「已重建计划」/「不要再次整体重建」） ──

  private handleCreate(chatId: string, steps: readonly unknown[]): ToolResult {
    const { items, replaced, droppedCount } = createPlan(chatId, steps);
    if (items.length === 0) {
      return planFailure(
        '建立计划',
        '参数错误',
        `steps 中没有可用的步骤文本（需为非空字符串；重复文本会被合并；上限 ${PLAN_MAX_ITEMS} 项）`,
        '检查 steps 数组：每项应为一条可执行的步骤描述',
      );
    }
    const header = replaced
      ? `已重建计划（覆写创建：原计划及其全部状态被替换且不可恢复，共 ${items.length} 项；旧 id 已全部失效，只用本次返回的新 id 继续）。后续优先用 add/edit/delete 演进，不要再次整体重建。`
      : `计划已建立（共 ${items.length} 项）。`;
    const droppedNote =
      droppedCount > 0 ? `\n注意：${droppedCount} 条步骤因重复、为空或超出上限被丢弃。` : '';
    return planSuccess(`${header}${droppedNote}\n\n${renderItems(items)}`, {
      action: 'create',
      chatId,
      replaced,
      droppedCount,
      items,
    });
  }

  // ── add：追加（无计划自动建立） ──

  private handleAdd(chatId: string, steps: readonly unknown[]): ToolResult {
    const { items, created, droppedCount } = addPlanItems(chatId, steps);
    if (items.length === 0) {
      return planFailure(
        '追加步骤',
        '参数错误',
        `没有步骤被追加（steps 无可用文本${created ? '' : `，或计划已达 ${PLAN_MAX_ITEMS} 项上限`}）`,
        '检查 steps 数组；计划已满时用 delete 腾出空间或精简步骤',
      );
    }
    const header = created
      ? `当前会话尚无计划，已自动建立并录入 ${items.length} 项。`
      : `已追加 ${items.length} 项步骤。`;
    const droppedNote =
      droppedCount > 0 ? `\n注意：${droppedCount} 条步骤因重复、为空或超出上限被丢弃。` : '';
    // 单次读取：正文与 data 共用同一快照，保证两处内容严格一致
    const fullPlan = getPlan(chatId);
    return planSuccess(`${header}${droppedNote}\n\n${renderItems(fullPlan)}`, {
      action: 'add',
      chatId,
      created,
      droppedCount,
      added: items,
      items: fullPlan,
    });
  }

  // ── edit：状态标注（failed 必填原因） ──

  private handleEdit(chatId: string, args: Record<string, unknown>): ToolResult {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) {
      return planFailure('标注状态', '参数错误', '缺少参数 id（目标计划项 id）', 'id 必须来自 create/add/read 的返回值');
    }
    if (!isPlanItemStatus(args.status)) {
      return planFailure(
        '标注状态',
        '参数错误',
        `status 必须为 pending / in_progress / done / failed 之一，实际收到: ${JSON.stringify(args.status ?? null)}`,
        '开始执行标 in_progress，成功标 done，失败标 failed（failed 须附 message 原因），重做改回 pending',
      );
    }
    const status = args.status;
    // message 三态语义：未传 = 保持（状态变更时 store 自动作废旧标注）；
    // 传空串 = 主动清除标注；传非空 = 覆盖。传了但不是字符串 → 显式报错
    // （静默丢弃会让模型以为清除成功了）
    const rawMessage = args.message;
    if (rawMessage !== undefined && typeof rawMessage !== 'string') {
      return planFailure(
        '标注状态',
        '参数错误',
        `message 必须为字符串，实际收到: ${JSON.stringify(rawMessage)}`,
        '不需要标注信息时省略 message；要清除已有标注传空字符串 message=""',
      );
    }
    const message = typeof rawMessage === 'string' ? rawMessage.trim() : undefined;
    if (status === 'failed' && !message) {
      return planFailure(
        '标注状态',
        '参数错误',
        'status="failed" 时 message 必填（记录为什么失败、原因是什么）',
        '补上 message 后重试：一句话写清失败原因与已尝试的办法',
      );
    }

    const updated = editPlanItem(chatId, id, {
      status,
      ...(message !== undefined ? { message } : {}),
    });
    // 单次读取：自纠提示与 data 共用同一快照
    const fullPlan = getPlan(chatId);
    if (!updated) {
      // 附当前清单供模型自纠（省一次 read 往返）
      return planFailure(
        '标注状态',
        '目标不存在',
        `计划项 id "${id}" 不存在或当前会话尚无计划`,
        `核对 id 后重试；当前计划：\n${renderItems(fullPlan)}`,
      );
    }
    return planSuccess(
      `计划项 ${id} 已标注为 ${STATUS_LABELS[status]}${updated.message ? `（${updated.message}）` : ''}。\n\n${renderItems(fullPlan)}`,
      { action: 'edit', chatId, id, status, item: updated, items: fullPlan },
    );
  }

  // ── delete：批量删除（未知 id 显式回显，不静默吞掉） ──

  private handleDelete(chatId: string, args: Record<string, unknown>): ToolResult {
    if (!Array.isArray(args.ids) || args.ids.length === 0) {
      return planFailure('删除条目', '参数错误', '缺少参数 ids（待删除的计划项 id 数组）', 'ids 须为非空字符串数组，元素来自 create/add/read 的返回值');
    }
    const ids = args.ids
      .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      .map(id => id.trim());
    if (ids.length === 0) {
      return planFailure('删除条目', '参数错误', 'ids 数组中没有有效的 id（须为非空字符串）', '检查 ids 数组元素');
    }
    // 删除前快照：用于精确区分「已删除」与「本来就不存在」（未知 id 不静默吞掉）
    const before = getPlan(chatId);
    const knownIds = new Set(before.map(item => item.id));
    const unknown = [...new Set(ids)].filter(id => !knownIds.has(id));
    const deleted = deletePlanItems(chatId, ids);
    const unknownNote =
      unknown.length > 0 ? `\n以下 id 不存在（未影响其余删除）: ${unknown.join(', ')}` : '';
    // 单次读取：正文与 data 共用同一快照
    const remainingPlan = getPlan(chatId);
    return planSuccess(
      `已删除 ${deleted} 项。${unknownNote}\n\n${renderItems(remainingPlan)}`,
      { action: 'delete', chatId, deleted, unknown, items: remainingPlan },
    );
  }

  // ── read：全量读取 ──

  private handleRead(chatId: string): ToolResult {
    const items = getPlan(chatId);
    if (items.length === 0) {
      return planSuccess(
        '当前会话没有计划。多步任务请先用 action=create 建立。',
        { action: 'read', chatId, items },
      );
    }
    const done = items.filter(item => item.status === 'done').length;
    const failed = items.filter(item => item.status === 'failed').length;
    return planSuccess(
      `当前会话计划（共 ${items.length} 项，已完成 ${done}${failed > 0 ? `，失败 ${failed}` : ''}）：\n\n${renderItems(items)}`,
      { action: 'read', chatId, items },
    );
  }
}

// 导出工具实例
export const planTool = new PlanTool();
