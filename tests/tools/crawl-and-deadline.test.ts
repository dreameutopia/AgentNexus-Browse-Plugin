/**
 * 批量抓取（js_run action="crawl"）与引擎零成本豁免的契约测试
 *
 * 覆盖两块：
 *   1. crawl 语义（tools/browser/crawl-runner.ts）：
 *      - 逐目标账本：每个目标都有条目（含「未执行」），状态分类正确；
 *      - 失败隔离：某目标失败不影响其余目标；
 *      - 风控页：标记 blocked + requiresHuman，并**停止**后续抓取（不绕过）；
 *      - 身份核验：expectUrlIncludes / expectTextIncludes 不符即判 drifted；
 *      - 熔断：连续失败达阈值后剩余目标标 skipped；
 *      - 结果行带来源列（_target/_url/_index），可与其它表按来源列关联；
 *      - 节奏：目标间随机停顿（抖动而非固定间隔）。
 *   2. 引擎零成本豁免（core/tools/tool-execution-engine.ts）：
 *      - 运行时长上限到达后，zeroCostStateTool 仍放行（计划/笔记类状态写入
 *        不能被截断——否则模型无法把已完成步骤标注为 done）；
 *      - 非零成本工具照旧被截断。
 *
 * 运行：由 tools.test.ts 末尾动态引入（chrome 全局桩已就位）。
 */

import assert from 'node:assert/strict';
import {
  ToolExecutionEngine,
  type ToolBatchOptions,
} from '../../entrypoints/sidepanel/core/tools/tool-execution-engine';
import { runCrawlBatch, pickDelay, summarize } from '../../tools/browser/crawl-runner';
import type { CrawlTargetInput } from '../../tools/browser/crawl-runner';

// ───────────────────────── chrome 全局桩 ─────────────────────────

/** 标签页状态：url 与注入结果由测试控制 */
interface FakeTab {
  id: number;
  url: string;
  status: string;
}

const fakeTabs = new Map<number, FakeTab>();
/** 注入脚本的返回值（按调用序号排队；用尽后返回最后一个） */
let scriptResults: unknown[] = [];
/** 注入脚本的抛错（按调用序号排队） */
let scriptErrors: (string | null)[] = [];
/** 注入调用计数 */
let scriptCalls = 0;
/** 风控探测命中的标签页（url 命中即视为验证页） */
let challengeUrls: string[] = [];
/** 每次导航后立即就绪（默认 true；false 时需要轮询到 timeout） */
let readyImmediately = true;

const realChrome = (globalThis as any).chrome;

(globalThis as any).chrome = {
  ...(realChrome ?? {}),
  tabs: {
    query: async () => {
      const first = [...fakeTabs.values()][0];
      return first ? [{ id: first.id, url: first.url }] : [];
    },
    get: async (id: number) => {
      const tab = fakeTabs.get(id);
      if (!tab) throw new Error(`no tab ${id}`);
      return tab;
    },
    update: async (id: number, props: { url?: string }) => {
      const tab = fakeTabs.get(id);
      if (!tab) throw new Error(`no tab ${id}`);
      if (props.url) tab.url = props.url;
      tab.status = 'complete';
      return tab;
    },
    create: async () => {
      const tab: FakeTab = { id: 900 + fakeTabs.size, url: 'about:blank', status: 'complete' };
      fakeTabs.set(tab.id, tab);
      return tab;
    },
  },
  scripting: {
    executeScript: async (options: any) => {
      if (options.func?.name === 'pageContainsText') return [{ result: options.args[0] === '正常正文内容' }];
      // 三类调用方靠「是否带 args」区分：
      //   1. 脚本执行（page-script-runner）：args = [expression, timeout, await, capture, limit]
      //   2. 风控探测（challenge-detect）：world='ISOLATED'，无 args
      //   3. 就绪探测（page-load）：func 读 document.readyState，无 args、无 world
      if (Array.isArray(options?.args)) {
        scriptCalls++;
        // 复刻 pageConsoleEvaluate 的返回形态：成功 {success:true,value,type,rawJson}，
        // 失败 {success:false,error}——引擎按 success 判定成败。
        const error = scriptErrors[scriptCalls - 1] ?? null;
        if (error) return [{ result: { success: false, error } }];
        const value =
          scriptResults.length === 0
            ? null
            : scriptResults[Math.min(scriptCalls - 1, scriptResults.length - 1)];
        return [
          {
            result: {
              success: true,
              value,
              type: value === null ? 'object' : typeof value,
              rawJson: JSON.stringify(value ?? null),
            },
          },
        ];
      }
      if (options?.world === 'ISOLATED') {
        const tab = fakeTabs.get(options.target.tabId);
        const url = tab?.url ?? '';
        const hit = challengeUrls.some(marker => url.includes(marker));
        return [
          {
            result: {
              title: hit ? 'Just a moment...' : '正常页面',
              body: hit ? 'Checking your browser' : '正常正文内容',
            },
          },
        ];
      }
      // 就绪探测
      return [{ result: 'complete' }];
    },
  },
};

function resetFakeBrowser(): void {
  fakeTabs.clear();
  fakeTabs.set(1, { id: 1, url: 'about:blank', status: 'complete' });
  scriptResults = [];
  scriptErrors = [];
  scriptCalls = 0;
  challengeUrls = [];
  readyImmediately = true;
}

// ───────────────────────── 1. crawl 语义 ─────────────────────────

// 1.1 全目标成功：逐目标账本 + 结果行带来源列
{
  resetFakeBrowser();
  scriptResults = [{ title: 'A' }, { title: 'B' }, { title: 'C' }];
  const targets: CrawlTargetInput[] = [
    { url: 'https://example.com/1', label: '一' },
    { url: 'https://example.com/2', label: '二' },
    { url: 'https://example.com/3', label: '三' },
  ];
  const outcome = await runCrawlBatch({
    targets,
    code: 'return { title: document.title };',
    args: [],
    targetTimeoutMs: 5000,
    totalTimeoutMs: 60_000,
    paceMinMs: 0,
    paceMaxMs: 0,
    world: 'auto',
    strategy: 'auto',
    awaitPromise: true,
    tabId: 1,
  });

  assert.equal(outcome.ledger.length, 3, '每个目标都有账本条目');
  assert.ok(outcome.ledger.every(r => r.status === 'ok'), '全部成功');
  assert.equal(outcome.rows.length, 3, '每个目标一行数据');
  assert.equal(outcome.rows[0]._target, '一', '结果行带 _target 来源列');
  assert.equal(outcome.rows[0]._url, 'https://example.com/1', '结果行带 _url 来源列');
  assert.equal(outcome.rows[0]._index, 0, '结果行带 _index 来源列');
  assert.equal(outcome.rows[0].title, 'A', '结果行含脚本返回字段');
  assert.equal(outcome.summary.ok, 3, '汇总统计成功数');
  assert.equal(outcome.summary.total, 3, '汇总统计总数');
}

// 1.2 失败隔离：中间目标抛错，其余照常
{
  resetFakeBrowser();
  scriptResults = [Array.from({ length: 350 }, (_, index) => ({ index, _url: 'original-source' }))];
  const options = { targets: [{ url: 'https://example.com/full', expectTextIncludes: '正常正文内容' }], code: 'return [];', targetTimeoutMs: 1000, totalTimeoutMs: 5000, paceMinMs: 0, paceMaxMs: 0, world: 'auto' as const, strategy: 'scripting' as const, awaitPromise: true, tabId: 1, frameId: 2 };
  const outcome = await runCrawlBatch(options);
  assert.equal(outcome.rows.length, 350, '完整数据不得被预览行数截断');
  assert.deepEqual(outcome.rows[0]._source_conflicts, { _url: 'original-source' });
  resetFakeBrowser();
  const drifted = await runCrawlBatch({ ...options, targets: [{ url: 'https://example.com/full', expectTextIncludes: 'missing-body' }] });
  assert.equal(drifted.ledger[0].status, 'drifted');
  assert.equal(scriptCalls, 0, '正文身份校验失败时不得执行脚本');
}

// Failure isolation.
{
  resetFakeBrowser();
  scriptErrors = [null, '脚本炸了', null];
  scriptResults = [{ v: 1 }, { v: 2 }, { v: 3 }];
  const outcome = await runCrawlBatch({
    targets: [
      { url: 'https://example.com/1' },
      { url: 'https://example.com/2' },
      { url: 'https://example.com/3' },
    ],
    code: 'return { v: 1 };',
    args: [],
    targetTimeoutMs: 5000,
    totalTimeoutMs: 60_000,
    paceMinMs: 0,
    paceMaxMs: 0,
    world: 'auto',
    strategy: 'auto',
    awaitPromise: true,
    tabId: 1,
  });

  assert.equal(outcome.ledger.length, 3, '失败不影响账本完整性');
  assert.equal(outcome.ledger[0].status, 'ok', '第一个目标成功');
  assert.equal(outcome.ledger[1].status, 'failed', '第二个目标失败');
  assert.ok(outcome.ledger[1].error?.includes('脚本炸了'), '失败原因可读', outcome.ledger[1].error);
  assert.equal(outcome.ledger[2].status, 'ok', '第三个目标照常执行（失败隔离）');
  assert.equal(outcome.rows.length, 2, '失败目标不产出数据行');
}

// 1.3 风控页：blocked + requiresHuman + 停止后续抓取
{
  resetFakeBrowser();
  challengeUrls = ['/risk_handler'];
  scriptResults = [{ v: 1 }];
  const outcome = await runCrawlBatch({
    targets: [
      { url: 'https://example.com/risk_handler/1' },
      { url: 'https://example.com/2' },
      { url: 'https://example.com/3' },
    ],
    code: 'return { v: 1 };',
    args: [],
    targetTimeoutMs: 5000,
    totalTimeoutMs: 60_000,
    paceMinMs: 0,
    paceMaxMs: 0,
    world: 'auto',
    strategy: 'auto',
    awaitPromise: true,
    tabId: 1,
  });

  assert.equal(outcome.ledger[0].status, 'blocked', '风控页标记 blocked');
  assert.equal(outcome.ledger[0].requiresHuman, true, 'blocked 要求人工处理');
  assert.equal(outcome.ledger[1].status, 'skipped', '风控后停止继续抓取');
  assert.equal(outcome.ledger[2].status, 'skipped', '风控后停止继续抓取');
  assert.ok(outcome.ledger[1].error?.includes('风控'), '未执行原因说明风控', outcome.ledger[1].error);
  assert.equal(scriptCalls, 0, '命中风控后不再执行任何脚本（不绕过）');
}

// 1.4 身份核验：expectUrlIncludes 不符即 drifted（站点改了链接结构）
{
  resetFakeBrowser();
  scriptResults = [{ v: 1 }];
  const outcome = await runCrawlBatch({
    targets: [
      { url: 'https://example.com/item/100', expectUrlIncludes: '/item/100' },
      { url: 'https://example.com/other', expectUrlIncludes: '/item/' },
    ],
    code: 'return { v: 1 };',
    args: [],
    targetTimeoutMs: 5000,
    totalTimeoutMs: 60_000,
    paceMinMs: 0,
    paceMaxMs: 0,
    world: 'auto',
    strategy: 'auto',
    awaitPromise: true,
    tabId: 1,
  });

  assert.equal(outcome.ledger[0].status, 'ok', 'URL 符合预期');
  assert.equal(outcome.ledger[1].status, 'drifted', 'URL 不符预期判 drifted');
  assert.ok(outcome.ledger[1].error?.includes('链接结构'), '漂移原因可读', outcome.ledger[1].error);
}

// 1.5 空结果：empty（软 404 / 选择器失配的典型信号），不伪装成功
{
  resetFakeBrowser();
  scriptResults = [null, { v: 1 }];
  const outcome = await runCrawlBatch({
    targets: [{ url: 'https://example.com/1' }, { url: 'https://example.com/2' }],
    code: 'return null;',
    args: [],
    targetTimeoutMs: 5000,
    totalTimeoutMs: 60_000,
    paceMinMs: 0,
    paceMaxMs: 0,
    world: 'auto',
    strategy: 'auto',
    awaitPromise: true,
    tabId: 1,
  });

  assert.equal(outcome.ledger[0].status, 'empty', '脚本返回空 → empty');
  assert.equal(outcome.ledger[1].status, 'ok', '后续目标不受影响');
  assert.equal(outcome.rows.length, 1, 'empty 目标不产出数据行');
}

// 1.6 熔断：连续失败达阈值后剩余目标标 skipped
{
  resetFakeBrowser();
  scriptErrors = ['炸1', '炸2', '炸3', '炸4', '炸5'];
  const outcome = await runCrawlBatch({
    targets: Array.from({ length: 5 }, (_, i) => ({ url: `https://example.com/${i}` })),
    code: 'return { v: 1 };',
    args: [],
    targetTimeoutMs: 5000,
    totalTimeoutMs: 60_000,
    paceMinMs: 0,
    paceMaxMs: 0,
    world: 'auto',
    strategy: 'auto',
    awaitPromise: true,
    tabId: 1,
  });

  assert.equal(outcome.ledger[0].status, 'failed', '首个目标失败');
  assert.equal(outcome.ledger[1].status, 'failed', '第二个目标失败');
  assert.equal(outcome.ledger[2].status, 'failed', '第三个目标失败（达阈值）');
  assert.equal(outcome.ledger[3].status, 'skipped', '达阈值后熔断，剩余标 skipped');
  assert.equal(outcome.ledger[4].status, 'skipped', '达阈值后熔断，剩余标 skipped');
  assert.ok(outcome.ledger[3].error?.includes('熔断'), '熔断原因可读', outcome.ledger[3].error);
}

// 1.7 随机停顿是抖动（不是固定间隔）且落在给定区间内
{
  const samples = Array.from({ length: 50 }, () => pickDelay(1500, 5000));
  assert.ok(samples.every(s => s >= 1500 && s <= 5000), '停顿落在区间内');
  assert.ok(new Set(samples).size > 1, '停顿是随机抖动而非固定值');
  assert.equal(pickDelay(2000, 2000), 2000, '区间退化为单点时取该点');
  assert.equal(pickDelay(0, 0), 0, '0 表示关闭停顿');
}

// 1.8 汇总统计：skipped 不计入失败，但总数包含
{
  const summary = summarize([
    { index: 0, url: 'a', status: 'ok', durationMs: 1 },
    { index: 1, url: 'b', status: 'failed', durationMs: 1 },
    { index: 2, url: 'c', status: 'skipped', durationMs: 0 },
  ]);
  assert.equal(summary.total, 3, '总数含全部目标');
  assert.equal(summary.ok, 1, '成功数');
  assert.equal(summary.failed, 1, '失败数');
  assert.equal(summary.skipped, 1, '未执行数');
}

// ───────────────────────── 2. 引擎零成本豁免 ─────────────────────────

// 2.1 超过运行时长上限后，零成本状态工具仍放行
{
  const engine = new ToolExecutionEngine();
  const chatId = 'zero-cost-chat';
  const roundId = engine.beginRound(chatId);
  const executed: string[] = [];
  const batch = engine.runBatch({
    chatId,
    roundId,
    timeoutMs: 1000,
    // 截止点已过：任何非豁免工具都不得开始
    deadlineMs: Date.now() - 1,
    maxDurationMs: 10 * 60_000,
    calls: [
      { callId: 'c1', toolName: 'plan_tool', rawArgs: {}, zeroCostStateTool: true },
      { callId: 'c2', toolName: 'browser_page_exec', rawArgs: {}, zeroCostStateTool: false },
    ],
    execute: async (call) => {
      executed.push(call.toolName);
      return { success: true, data: {} };
    },
  });
  const result = await batch;
  assert.deepEqual(executed, ['plan_tool'], '零成本状态工具放行，长耗时工具被截断');
  assert.equal(result.outcomes[0].reason, 'completed', '零成本状态工具正常完成');
  assert.equal(result.outcomes[1].reason, 'deadline', '非零成本工具被运行时长上限截断');
  assert.ok(result.outcomes[1].error?.includes('运行时长上限'), '截断原因可读', result.outcomes[1].error);
  engine.closeRound(chatId, roundId);
}

// 2.2 未标记的工具照旧被截断（默认保守）
{
  const engine = new ToolExecutionEngine();
  const chatId = 'zero-cost-default-chat';
  const roundId = engine.beginRound(chatId);
  const executed: string[] = [];
  const result = await engine.runBatch({
    chatId,
    roundId,
    timeoutMs: 1000,
    deadlineMs: Date.now() - 1,
    maxDurationMs: 10 * 60_000,
    calls: [{ callId: 'c1', toolName: 'plan_tool', rawArgs: {} }],
    execute: async (call) => {
      executed.push(call.toolName);
      return { success: true, data: {} };
    },
  });
  await result;
  assert.deepEqual(executed, [], '未声明零成本的工具默认被截断（保守默认）');
  engine.closeRound(chatId, roundId);
}

console.log('[crawl-and-deadline] 全部断言通过');
