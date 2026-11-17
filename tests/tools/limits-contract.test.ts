/**
 * 限额默认值与会话运行时长上限的契约测试
 *
 * 覆盖本轮改动引入的三条契约：
 *   1. **默认值的单一事实源**：单工具超时默认 20 分钟、对话轮次默认 60 轮，
 *      且应用设置、运行时装配、引擎兜底三处不得漂移（任何一处仍是 30 分钟，
 *      排查时无从判断哪个是真值）。
 *   2. **普通对话不再有会话运行时长上限**：maxDurationMs 缺省即「不限」，
 *      时长守卫不触发、工具批次不设截止点——长耗时任务不再被截断成
 *      「已达本次运行时长上限，工具 X 未执行」。
 *   3. **显式时长预算仍生效**：装配方在 RuntimeLimits 上显式给出 maxDurationMs
 *      时，时长守卫与工具批次截止点照旧生效（长任务不能变成无界的）。
 *
 * 运行：由 tools.test.ts 末尾动态引入（chrome 全局桩已就位）。
 */

import assert from 'node:assert/strict';
import {
  MAX_ITERATIONS_DEFAULT,
  TOOL_TIMEOUT_DEFAULT_MINUTES,
} from '../../entrypoints/sidepanel/utils/channels/channel-types';
import {
  normalizeAppSettings,
} from '../../entrypoints/sidepanel/utils/channels/channel-validation';
import { toolExecutionEngine } from '../../entrypoints/sidepanel/core/tools/tool-execution-engine';
import {
  PYTHON_RUN_DEFAULT_TIMEOUT_MS,
  PYTHON_RUN_MAX_TIMEOUT_MS,
} from '../../utils/pyodide/pyodide-config';
import {
  PYTHON_RUN_ENGINE_TIMEOUT_MS,
  pythonRunEngineTimeout,
} from '../../tools/python/python-timeout-contract';

// ───────────────────────── 1. 默认值单一事实源 ─────────────────────────

{
  assert.equal(TOOL_TIMEOUT_DEFAULT_MINUTES, 20, '单工具超时默认 20 分钟');
  assert.equal(MAX_ITERATIONS_DEFAULT, 60, '对话轮次默认 60 轮');

  // 应用设置默认值与常量同源（设置层归一后的缺省值必须等于常量）
  const defaults = normalizeAppSettings(null);
  assert.equal(
    defaults.toolTimeoutMinutes,
    TOOL_TIMEOUT_DEFAULT_MINUTES,
    '应用设置的缺省单工具超时与常量一致',
  );
  assert.equal(
    defaults.maxIterations,
    MAX_ITERATIONS_DEFAULT,
    '应用设置的缺省轮次与常量一致',
  );

  // 引擎兜底值必须等于应用设置缺省值（否则「设置显示 20 分钟、实际兜底 30
  // 分钟」，两处漂移时无从判断哪个是真值）
  const runtimeDefaults = normalizeAppSettings(null);
  assert.equal(
    runtimeDefaults.toolTimeoutMinutes,
    TOOL_TIMEOUT_DEFAULT_MINUTES,
    '引擎兜底与设置缺省同源',
  );
}

// ───────────────────────── 2. python_run 上限与引擎地板 ─────────────────────────

{
  assert.equal(PYTHON_RUN_MAX_TIMEOUT_MS, 300_000, 'python_run 超时上限 300 秒');
  assert.equal(PYTHON_RUN_DEFAULT_TIMEOUT_MS, 60_000, 'python_run 默认超时仍是 60 秒');

  // 引擎层地板：工具声明的 300s 上限必须真实可达——用户把统一上界调到
  // 1 分钟时，引擎若仍按统一上界掐断，工具说明里的 300s 就是谎言。
  assert.ok(
    pythonRunEngineTimeout({}, 60_000) >= PYTHON_RUN_ENGINE_TIMEOUT_MS,
    '引擎地板不低于工具上限 + 缓冲',
  );
  assert.ok(
    pythonRunEngineTimeout({ timeoutSeconds: 300 }, 60_000) >= 300_000,
    '模型传 300s 时引擎不早于 300s 掐断',
  );
  // 统一上界更高时从设置（不反向收紧）
  assert.equal(
    pythonRunEngineTimeout({}, 45 * 60_000),
    45 * 60_000,
    '应用设置高于地板时从设置',
  );
  // 越界入参按工具层口径收敛，不得把超大值注入引擎定时器
  assert.equal(
    pythonRunEngineTimeout({ timeoutSeconds: 9_999_999 }, 60_000),
    PYTHON_RUN_ENGINE_TIMEOUT_MS,
    '越界 timeoutSeconds 收敛到工具上限',
  );
}

// ───────────────────────── 3. 普通对话无会话运行时长上限 ─────────────────────────

{
  // 引擎层：无 deadlineMs 即不截断——普通对话不传截止点，调用照常执行。
  const engine = toolExecutionEngine;
  const chatId = 'no-session-cap';
  const roundId = engine.beginRound(chatId);
  const executed: string[] = [];
  const result = await engine.runBatch({
    chatId,
    roundId,
    timeoutMs: 60_000,
    // 无 deadlineMs：任何调用都不因「会话运行时长上限」被跳过
    calls: [{ callId: 'c1', toolName: 'python_run', rawArgs: {} }],
    execute: async call => {
      executed.push(call.toolName);
      return { success: true, data: {} };
    },
  });
  assert.deepEqual(executed, ['python_run'], '无截止点时调用照常执行，不被跳过');
  assert.equal(result.outcomes[0].reason, 'completed', '调用正常完成');
  assert.ok(
    !String(result.outcomes[0].error ?? '').includes('运行时长上限'),
    '不产生「已达本次运行时长上限」文案',
  );
  engine.closeRound(chatId, roundId);
}

// ───────────────────────── 4. 显式时长预算仍生效 ─────────────────────────

{
  // 有截止点时（装配方显式给出 maxDurationMs）照旧截断未开始的调用
  const engine = toolExecutionEngine;
  const chatId = 'learn-session-cap';
  const roundId = engine.beginRound(chatId);
  const executed: string[] = [];
  const result = await engine.runBatch({
    chatId,
    roundId,
    timeoutMs: 60_000,
    deadlineMs: Date.now() - 1,
    maxDurationMs: 30 * 60_000,
    calls: [{ callId: 'c1', toolName: 'python_run', rawArgs: {} }],
    execute: async call => {
      executed.push(call.toolName);
      return { success: true, data: {} };
    },
  });
  assert.deepEqual(executed, [], '有截止点时未开始的调用不执行');
  assert.equal(result.outcomes[0].reason, 'deadline', '以 deadline 原因结算');
  assert.ok(
    String(result.outcomes[0].error ?? '').includes('运行时长上限'),
    '截断原因可读',
  );
  engine.closeRound(chatId, roundId);
}

console.log('[limits-contract] 全部断言通过');
