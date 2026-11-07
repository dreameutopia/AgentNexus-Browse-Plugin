/**
 * plan_tool 契约 + 计划状态提醒判定 + plan-store 水合测试
 *
 * 覆盖三块（对应「plan_tool 逐项实时更新」三层修复）：
 *   1. 工具契约：五动作行为、failed 必填 message 硬校验、未知 id 回显当前
 *      清单（自纠路径）、create 整体替换提示、状态变更时旧标注作废、
 *      会话上下文缺失防御；
 *   2. plan-reminder 纯函数：needsPlanReminder 的触发条件组合（开放项 /
 *      实际工作 / 本轮未维护计划 / 频率间隔）与 buildPlanReminder 的消息
 *      构造（状态标签、单条与总量截断、空清单 null）；
 *   3. ensurePlansHydrated：worker 冷启动（内存为空 + chrome.storage 有
 *      持久化数据）水合恢复 + 幂等（二次调用不重复读 storage）。
 *
 * 运行：由 tools.test.ts 末尾动态引入（chrome 全局桩已就位）。
 */

import assert from 'node:assert/strict';

import { planTool } from '../../tools/plan/plan-tool';
import { PLAN_TOOL_ID, PLAN_SYSTEM_PROMPT_SECTION } from '../../tools/plan/plan-prompt';
import {
  dropPlan,
  ensurePlansHydrated,
  getPlan,
  setActivePlanChat,
} from '../../utils/plan/plan-store';
import {
  buildPlanReminder,
  needsPlanReminder,
  PLAN_REMINDER_MIN_ROUND_GAP,
  type PlanReminderInput,
} from '../../entrypoints/sidepanel/core/conversation/plan-reminder';
import type { PlanItem } from '../../utils/plan/plan-store';

/** 工具结果正文文本（content 可选；测试断言统一走此取值，兼容 strict 检查） */
const textOf = (r: { content?: Array<{ type: string; text?: string }> }): string =>
  r.content?.[0]?.text ?? '';

// ==================== 1. plan_tool 契约 ====================

const chatId = 'plan-contract-chat';
dropPlan(chatId);

// create：建项 + id 分配 + 正文清单
let result = await planTool.execute(
  { action: 'create', steps: ['检索平台A', '检索平台B', '汇总有效来源'] },
  { chatId },
);
assert.equal(result.success, true, 'create 应成功');
assert.equal(result.isError, false);
assert.ok(textOf(result).includes('计划已建立（共 3 项）'), 'create 正文含建立提示');
assert.deepEqual(
  (result.data.items as PlanItem[]).map(item => item.id),
  ['1', '2', '3'],
  'create 分配自增 id',
);

// read：计数摘要
result = await planTool.execute({ action: 'read' }, { chatId });
assert.equal(result.success, true);
assert.ok(textOf(result).includes('共 3 项，已完成 0'), 'read 正文含计数');

// edit：缺 id 拒绝
result = await planTool.execute({ action: 'edit', status: 'done' }, { chatId });
assert.equal(result.success, false);
assert.ok(result.error?.includes('缺少参数 id'), '缺 id 给可读错误');

// edit：非法 status 拒绝
result = await planTool.execute({ action: 'edit', id: '1', status: 'ok' }, { chatId });
assert.equal(result.success, false);
assert.ok(result.error?.includes('status 必须为'), '非法 status 给可读错误');

// edit：failed 无 message 硬校验拒绝
result = await planTool.execute({ action: 'edit', id: '1', status: 'failed' }, { chatId });
assert.equal(result.success, false);
assert.ok(result.error?.includes('message 必填'), 'failed 必填 message');

// edit：未知 id → 错误正文回显当前清单（自纠路径）
result = await planTool.execute({ action: 'edit', id: '99', status: 'done' }, { chatId });
assert.equal(result.success, false);
assert.ok(result.error?.includes('目标不存在'), '未知 id 报目标不存在');
assert.ok(result.error?.includes('检索平台A'), '未知 id 错误回显当前清单');

// edit：done 附成果 → 改回 in_progress 不带 message → 旧标注作废
result = await planTool.execute(
  { action: 'edit', id: '1', status: 'done', message: '已取得 5 条来源' },
  { chatId },
);
assert.equal(result.success, true, 'done 标注成功');
assert.equal((result.data.item as PlanItem).message, '已取得 5 条来源', 'done message 记录成果');
result = await planTool.execute({ action: 'edit', id: '1', status: 'in_progress' }, { chatId });
assert.equal(result.success, true);
assert.equal((result.data.item as PlanItem).status, 'in_progress');
assert.equal('message' in (result.data.item as PlanItem), false, '状态变更且未带 message 时旧标注作废');

// add：追加 + 重复文本丢弃
result = await planTool.execute(
  { action: 'add', steps: ['检索平台C', '检索平台A'] },
  { chatId },
);
assert.equal(result.success, true);
assert.equal((result.data.added as PlanItem[]).length, 1, '重复步骤被丢弃');
assert.equal(getPlan(chatId).length, 4, 'add 后共 4 项');

// delete：未知 id 显式回显，不静默吞掉
result = await planTool.execute({ action: 'delete', ids: ['2', '77'] }, { chatId });
assert.equal(result.success, true);
assert.equal(result.data.deleted, 1, '删除 1 项');
assert.deepEqual(result.data.unknown, ['77'], '未知 id 集中回显');

// create：已有计划时整体替换并显式提示
result = await planTool.execute(
  { action: 'create', steps: ['新步骤一', '新步骤二'] },
  { chatId },
);
assert.equal(result.success, true);
assert.equal(result.data.replaced, true, '重建标记 replaced');
assert.ok(textOf(result).includes('已重建计划'), '重建给显式提示');
assert.ok(textOf(result).includes('不要再次整体重建'), '重建提示引导改用演进操作');
dropPlan(chatId);

// 无会话上下文且无活跃会话兜底 → 可读错误（防御外部调用方）
const prevActiveChat = '';
setActivePlanChat(prevActiveChat);
result = await planTool.execute({ action: 'read' });
assert.equal(result.success, false);
assert.ok(result.error?.includes('会话上下文缺失'), '无上下文给可读错误');

// 非法 action
result = await planTool.execute({ action: 'unknown' }, { chatId });
assert.equal(result.success, false);
assert.ok(result.error?.includes('action 必须为'), '非法 action 给可读错误');

// ==================== 2. plan-reminder 纯函数 ====================

assert.equal(PLAN_TOOL_ID, 'plan_tool');
assert.ok(PLAN_SYSTEM_PROMPT_SECTION.includes('状态更新协议'), '系统提示词含硬性协议');
assert.ok(PLAN_SYSTEM_PROMPT_SECTION.includes('plan-status-reminder'), '系统提示词预告引擎提醒');
assert.ok(
  (planTool.openaiSchema.function.description as string).includes('更新纪律'),
  '工具描述携带更新纪律',
);

// 覆写创建三层契约锚（分工见 plan-prompt 文件头）：判定标准唯一权威在系统
// 提示词「计划重建」小节；机制与后果唯一权威在工具描述；引导层只带逃生口
assert.ok(PLAN_SYSTEM_PROMPT_SECTION.includes('计划重建'), '系统提示词含覆写判定小节');
assert.ok(PLAN_SYSTEM_PROMPT_SECTION.includes('两种情形允许覆写'), '判定标准写明正例边界');
const planSchemaText = planTool.openaiSchema.function.description as string;
assert.ok(planSchemaText.includes('覆写式重建'), '工具描述写明覆写机制');
assert.ok(planSchemaText.includes('不可恢复'), '工具描述写明后果');
assert.ok(planSchemaText.includes('id 只增不复用'), '工具描述写明 id 后果');

const openItems: PlanItem[] = [
  { id: '1', step: '打开三个平台检索来源', status: 'in_progress', updatedAt: 1 },
  { id: '2', step: '汇总有效来源', status: 'pending', updatedAt: 1 },
];
const terminalItems: PlanItem[] = [
  { id: '1', step: '已完结', status: 'done', updatedAt: 1 },
  { id: '2', step: '已失败', status: 'failed', updatedAt: 1 },
];

const reminderInput = (overrides: Partial<PlanReminderInput>): PlanReminderInput => ({
  items: openItems,
  roundCalls: [{ function: { name: 'browser_navigate' } }],
  iteration: 3,
  lastReminderRound: 0,
  ...overrides,
});

// 触发：开放项 + 本轮有实际工作 + 未维护计划 + 间隔满足
assert.equal(needsPlanReminder(reminderInput({})), true, '标准触发场景');
assert.equal(
  needsPlanReminder(reminderInput({ roundCalls: ['web_search'] })),
  true,
  '字符串调用形态同样判定',
);
// 无计划 / 全部终态 → 不提醒
assert.equal(needsPlanReminder(reminderInput({ items: [] })), false, '无计划不提醒');
assert.equal(needsPlanReminder(reminderInput({ items: terminalItems })), false, '全终态不提醒');
// 本轮调用过 plan_tool（含与工作工具混合）→ 模型在维护计划，不打扰
assert.equal(
  needsPlanReminder(reminderInput({ roundCalls: ['plan_tool', 'browser_navigate'] })),
  false,
  '本轮维护过计划不提醒',
);
// 本轮只有 plan_tool（无实际工作）→ 不提醒
assert.equal(needsPlanReminder(reminderInput({ roundCalls: ['plan_tool'] })), false, '纯计划轮不提醒');
// 频率间隔：上一轮刚注入 → 不提醒
assert.equal(
  needsPlanReminder(reminderInput({ iteration: 3, lastReminderRound: 2 })),
  false,
  '间隔不足不提醒',
);
assert.equal(
  needsPlanReminder(reminderInput({ iteration: 3, lastReminderRound: 1 })),
  true,
  '间隔满足再提醒',
);
// 形态防御：无名调用不计入工作
assert.equal(
  needsPlanReminder(reminderInput({ roundCalls: [{ function: {} }, ''] })),
  false,
  '无名调用不算实际工作',
);

// buildPlanReminder：消息形态与状态标签
const reminder = buildPlanReminder(openItems)!;
assert.ok(reminder, '开放项清单构造出消息');
assert.equal(reminder.role, 'user');
const reminderText = reminder.content as string;
assert.ok(reminderText.startsWith('<plan-status-reminder>'), '提醒消息带 XML 标记');
assert.ok(reminderText.includes('[进行中] 打开三个平台检索来源'), '含状态标签与步骤');
assert.ok(reminderText.includes('[待执行] 汇总有效来源'), '含全部开放项');
assert.ok(reminderText.includes('plan_tool edit'), '含补标指令');
assert.ok(reminderText.includes('plan_tool create'), '含覆写逃生口');
assert.ok(reminderText.includes('计划重建'), '逃生口指向权威小节');
// 空清单 → null
assert.equal(buildPlanReminder([]), null, '空清单返回 null');
// 单条截断：超长步骤截到上限
const longStep = buildPlanReminder([
  { id: '1', step: '长'.repeat(500), status: 'pending', updatedAt: 1 },
])!.content as string;
assert.ok((longStep.match(/长/g) ?? []).length <= 121, '单条步骤截断到上限（120+省略号）');
// 总量截断：30 项长文本触发省略注记
const manyItems = Array.from({ length: 30 }, (_, index) => ({
  id: String(index + 1),
  step: '步骤文本'.repeat(30),
  status: 'pending' as const,
  updatedAt: 1,
}));
const capped = buildPlanReminder(manyItems)!.content as string;
assert.ok(capped.includes('其余项已省略'), '总量超限给出省略注记');
assert.ok(capped.length < 3000, '总量受软上限约束');

// ==================== 3. ensurePlansHydrated：worker 冷启动水合 + 幂等 ====================

// 等待本文件前段契约测试触发的去抖持久化（400ms）完成，避免与注入载荷竞态
await new Promise(resolve => setTimeout(resolve, 500));

// 桩实现约定见 tools.test.ts 的 createStorageArea：get(keys)/set(items) 共享
// 同一内存 Map；此处按键值对直接注入持久化载荷
const storageArea: {
  get: (keys?: unknown) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
} = (globalThis as { chrome: any }).chrome.storage.local;
const hydrationPayload = {
  v: 2,
  sessions: {
    'plan-hydrate-chat': {
      chatId: 'plan-hydrate-chat',
      items: [{ id: '1', step: '持久化步骤', status: 'pending', updatedAt: 1 }],
      nextItemId: 2,
      createdAt: 1,
      updatedAt: 2,
    },
  },
  dropped: {},
};
await storageArea.set({ agentNexusSessionPlans: hydrationPayload });
assert.equal(
  getPlan('plan-hydrate-chat').length,
  0,
  '水合前内存无该会话（模拟 worker 冷启动）',
);
await ensurePlansHydrated();
assert.deepEqual(
  getPlan('plan-hydrate-chat').map(item => item.step),
  ['持久化步骤'],
  '水合后恢复持久化计划',
);
// 幂等：二次调用不重复读 storage
const originalGet = storageArea.get.bind(storageArea);
let getCallCount = 0;
storageArea.get = async (keys?: unknown) => {
  getCallCount += 1;
  return originalGet(keys);
};
try {
  await ensurePlansHydrated();
  assert.equal(getCallCount, 0, '幂等：二次调用不重复读 storage');
} finally {
  storageArea.get = originalGet;
}
dropPlan('plan-hydrate-chat');

console.log('[plan] plan_tool 契约、提醒判定与水合测试通过');
