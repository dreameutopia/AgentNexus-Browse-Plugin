import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requiresConfirmApproval } from '../../tools/confirm-guard';
import { CONFIRM_GUIDANCE, CONFIRM_PARAMETER_DESCRIPTION } from '../../tools/confirmation-policy';
import { OpenAIToolsConverter } from '../../entrypoints/sidepanel/utils/tools/openai-tools-converter';
import { toolRegistry } from '../../tools/registry';
import { ConversationEngine } from '../../entrypoints/sidepanel/core/conversation/conversation-engine';

for (const description of [
  '点击搜索按钮，提交搜索', '输入搜索词', '发送搜索请求', '提交筛选条件',
  '打开职位详情', '点击立即沟通，发送用户要求的普通问候', '发布用户指定的普通内容',
  '删除搜索词', '移除筛选条件', '获取公开 API 数据', '读取任务所需的职位列表',
  '打开登录页', '打开支付记录页面', '点击支付方式设置', '查询 API Key 使用文档',
]) assert.equal(requiresConfirmApproval(true, { description }), false, description);
for (const description of [
  '确认支付订单', '点击购买按钮', '发起转账', '申请退款', '使用账号密码登录',
  '填写验证码', '获取 API Key', '读取访问密钥', '复制 Token', '导出 Cookie',
  '修改账号安全设置', '撤销访问权限', '发送客户个人信息', '删除重要数据',
  '注销账号', 'export api key', 'use saved credentials',
]) assert.equal(requiresConfirmApproval(true, { description, confirm: false }), true, description);
assert.equal(requiresConfirmApproval(false, { confirm: true, description: '支付订单' }), false);
assert.equal(requiresConfirmApproval(true, { confirm: true, description: '普通操作' }), true);
assert.equal(requiresConfirmApproval(true, { selector: '#支付', xpath: '//button[@name="删除"]', value: '支付密码', code: '读取密钥' }), false);

for (const name of ['browser_interact', 'browser_page_exec', 'vision_gui', 'browser_network_request']) {
  const schema = toolRegistry.getTool(name)!.openaiSchema.function;
  assert.ok(schema.description?.includes(CONFIRM_GUIDANCE), `${name} shares tool-level policy`);
  assert.equal((schema.parameters.properties as any).confirm.description, CONFIRM_PARAMETER_DESCRIPTION);
}
for (const file of ['utils/agents/element-interaction-sop.ts', 'utils/agents/vision-gui-prompt.ts',
  'utils/agents/presets/vision-action.ts', 'utils/learn/learn-prompts.ts'])
  assert.doesNotMatch(readFileSync(file, 'utf8'), /confirm\s*[=:]\s*true/, `${file} must not duplicate confirmation policy`);

// Exercise the real execution gateway: wait for a user's decision before a
// sensitive action; ordinary searches run without opening an approval request.
let executed = 0, approve: ((value: boolean) => void) | undefined;
const engine = new ConversationEngine({
  requiresApproval: (name: string, args: unknown) => OpenAIToolsConverter.requiresApproval(name, args),
  executeTool: async () => { executed++; return { success: true, data: {} }; },
} as any) as any;
const runtime = { chatId: 'learning-approval', toolIds: ['browser_interact'], vision: null,
  limits: { maxDurationMs: 60000, toolTimeoutMs: 1000 } };
const execute = (description: string, options: any = {}) => engine.executeToolCalls(runtime,
  { abortController: new AbortController(), dynamicToolIds: new Set(), record: { toolCalls: [], parts: [] }, toolCallCount: 0 },
  [{ id: 'approval-call', type: 'function', function: { name: 'browser_interact',
    arguments: JSON.stringify({ action: 'click', description }) } }], options, () => {}, Date.now() + 60000);
await execute('提交搜索');
assert.equal(executed, 1);
const missing = await execute('确认支付订单');
assert.match(missing.messages[0].content, /APPROVAL_UNAVAILABLE/);
assert.equal(executed, 1);
for (const allowed of [true, false]) {
  const pending = execute('确认支付订单', { onToolApproval: () => new Promise<boolean>(resolve => { approve = resolve; }) });
  await Promise.resolve();
  assert.equal(executed, allowed ? 1 : 2, 'Sensitive action must wait for the callback');
  approve!(allowed);
  const result = await pending;
  if (!allowed) assert.match(result.messages[0].content, /APPROVAL_NOT_GRANTED/);
}
assert.equal(executed, 2, 'Denied operation never executes');
console.log('[confirmation] Shared tool policy, ordinary search exemptions, risk signals and real approval gateway passed.');
