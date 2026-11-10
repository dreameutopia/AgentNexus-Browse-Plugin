/**
 * 智能体启用 / 停用单元测试
 *
 * 覆盖：
 *   1. 默认全部启用（记录缺省 enabled 即启用）；
 *   2. 预置智能体可停用（不可编辑 → 走启停覆盖表），停用态在列表出口可见；
 *   3. 自定义智能体可停用（启停写在记录自身，随自定义列表持久化）；
 *   4. 停用的智能体被「可被选中」过滤（@ 选择器只列启用中的）；
 *   5. 跨上下文同步：其它上下文写入启停覆盖 → 本上下文立即反映并广播变更；
 *   6. 重新启用后恢复可见，且不影响其它智能体。
 *
 * 运行：node tests/hub/run.mjs   （或 npm run test:hub）
 */

import assert from 'node:assert/strict';
import { filterEnabledAgents, type AgentConfig } from '../../utils/agents/agent-types';

/** chrome.storage / localStorage 替身（记录写入并可模拟跨上下文变更推送） */
const storage: Record<string, unknown> = {};
const changeListeners = new Set<(changes: Record<string, { newValue?: unknown }>, area: string) => void>();
(globalThis as any).chrome = {
  storage: {
    local: {
      async get(keys?: string | string[]) {
        const names = keys === undefined ? Object.keys(storage) : typeof keys === 'string' ? [keys] : keys;
        return Object.fromEntries(names.filter(name => name in storage).map(name => [name, storage[name]]));
      },
      async set(values: Record<string, unknown>) {
        const changes: Record<string, { newValue?: unknown }> = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { newValue: value };
          storage[key] = value;
        }
        // 模拟跨上下文推送（本上下文也会收到，由指纹跳过自事件）
        for (const listener of changeListeners) listener(changes, 'local');
      },
      async remove(key: string) { delete storage[key]; },
    },
    onChanged: {
      addListener(listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void) {
        changeListeners.add(listener);
      },
      removeListener(listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void) {
        changeListeners.delete(listener);
      },
    },
  },
};
(globalThis as any).localStorage = {
  getItem: (key: string) => (key in storage ? (storage[key] as string) : null),
  setItem: (key: string, value: string) => { storage[key] = value; },
  removeItem: (key: string) => { delete storage[key]; },
};

// 存储层在模块初始化时即订阅跨上下文同步——必须先装好 chrome 替身再动态导入
const store = await import('../../utils/agents/agent-store');
const {
  PRESET_AGENTS,
  getAllAgents,
  isAgentEnabled,
  onAgentsChange,
  setAgentConfig,
  setAgentEnabled,
} = store;

// ── 1. 默认全部启用 ──
const initial = getAllAgents();
assert.ok(initial.length > 0, '智能体表非空');
assert.ok(
  initial.every(agent => agent.enabled !== false),
  '默认全部启用（enabled 缺省即启用）',
);
assert.ok(initial.every(agent => isAgentEnabled(agent.id)), 'isAgentEnabled 默认全为启用');

// ── 2. 预置智能体可停用 ──
const preset = PRESET_AGENTS[0];
assert.ok(preset, '存在预置智能体');
assert.equal(setAgentEnabled(preset.id, false), true, '预置智能体停用成功');
assert.equal(isAgentEnabled(preset.id), false, '停用后 isAgentEnabled 为 false');
const afterDisable = getAllAgents();
const disabledEntry = afterDisable.find(agent => agent.id === preset.id);
assert.ok(disabledEntry, '停用后的预置智能体仍在列表中（管理中心仍可见）');
assert.equal(disabledEntry.enabled, false, '停用态在列表出口可见');
assert.ok(
  PRESET_AGENTS.every(agent => agent.enabled === undefined),
  '预置表本身不被改写（冻结表保持原样）',
);

// ── 3. 自定义智能体可停用（启停写入记录自身） ──
const customId = 'custom-enable-case';
const write = setAgentConfig({
  id: customId,
  name: 'custom-enable-case',
  description: '启停用例',
  system: '你是测试用智能体。',
  tools: [],
  category: 'general',
  tags: [],
});
assert.ok(write.ok, '自定义智能体写入成功');
assert.equal(setAgentEnabled(customId, false), true, '自定义智能体停用成功');
const customEntry = getAllAgents().find(agent => agent.id === customId);
assert.equal(customEntry?.enabled, false, '自定义智能体停用态写入记录');
const persisted = storage['agentNexusCustomAgents'];
assert.ok(Array.isArray(persisted), '自定义列表已持久化');
assert.ok(
  (persisted as AgentConfig[]).some(agent => agent.id === customId && agent.enabled === false),
  '停用态随自定义列表持久化（重启后仍停用）',
);

// ── 4. 停用的智能体不被「可被选中」过滤放行 ──
const selectable = filterEnabledAgents(getAllAgents());
assert.ok(
  !selectable.some(agent => agent.id === preset.id),
  '停用的预置智能体不出现在可被选中列表（@ 选择器）',
);
assert.ok(
  !selectable.some(agent => agent.id === customId),
  '停用的自定义智能体不出现在可被选中列表',
);
assert.ok(
  selectable.some(agent => agent.id !== preset.id && agent.id !== customId),
  '未停用的智能体仍在可被选中列表中',
);

// ── 5. 跨上下文同步：对端写入启停覆盖 → 本上下文立即反映并广播 ──
const preset2 = PRESET_AGENTS[1];
assert.ok(preset2, '存在第二个预置智能体');
let notified = 0;
const unsubscribe = onAgentsChange(() => { notified += 1; });
storage['agentNexusAgentEnableOverrides'] = { [preset2.id]: false };
for (const listener of changeListeners) {
  listener({ 'agentNexusAgentEnableOverrides': { newValue: storage['agentNexusAgentEnableOverrides'] } }, 'local');
}
assert.equal(isAgentEnabled(preset2.id), false, '对端停用 → 本上下文立即反映');
assert.ok(notified > 0, '启停变化广播了变更（侧边栏列表随之刷新）');
unsubscribe();

// ── 6. 重新启用后恢复可见，且不影响其它智能体 ──
assert.equal(setAgentEnabled(preset.id, true), true, '重新启用成功');
assert.equal(isAgentEnabled(preset.id), true, '重新启用后 isAgentEnabled 为 true');
assert.equal(isAgentEnabled(customId), false, '重新启用一个不影响其它智能体');
assert.ok(
  filterEnabledAgents(getAllAgents()).some(agent => agent.id === preset.id),
  '重新启用后重新出现在可被选中列表',
);

console.log('[hub] 智能体启停：默认启用、预置 / 自定义可停用、@ 选择器过滤、跨上下文同步、重新启用 —— 通过');
