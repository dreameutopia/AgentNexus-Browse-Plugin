/**
 * 工具审批原因分类测试
 *
 * 覆盖审批弹窗的「智能识别」链路——同一道人审门背后是完全不同的事，
 * 文案必须按命中原因分档，而不是一律「破坏性或不可逆」：
 *
 *   ① python_run 的 dependencyMode="pypi" → 'dependency-install'，
 *      且 detail 点名要装的包（装 xlrd 不破坏任何数据，说成破坏性是误导）；
 *      preflight / catalog 不触发审批
 *   ② note_tool(action="delete") → 'action'，detail 为命中的 action 名
 *   ③ browser_interact / js_run 的敏感意图 → 'confirm'，detail 为命中的字段名；
 *      confirm=true 但无敏感字段 → 有原因无细节（走降级文案）
 *   ④ 未注册工具 → required=false + reason='unknown'
 *   ⑤ requiresApproval 与 classifyApproval 同源：两者是同一次判定的两个投影，
 *      绝不各判各的（漂移 = 文案说装依赖、门却按删除放行）
 *   ⑥ 会话引擎把原因码与细节原样交给审批回调（弹窗文案的唯一输入）
 *
 * 运行：node tests/tools/run.mjs
 */

import assert from 'node:assert/strict';
import { OpenAIToolsConverter } from '../../entrypoints/sidepanel/utils/tools/openai-tools-converter';
import {
  ConversationEngine,
  type ToolApprovalRequest,
} from '../../entrypoints/sidepanel/core/conversation/conversation-engine';
import type { ToolApprovalReason } from '../../tools/approval-reason';

type Verdict = { required: boolean; reason: ToolApprovalReason; detail?: string };
const classify = (name: string, args?: unknown): Verdict =>
  OpenAIToolsConverter.classifyApproval(name, args);

// ── ① 依赖安装：点名包，且不误伤 preflight / catalog ──────────────────────
const install = classify('python_run', {
  action: 'run', path: 'scripts/read_xls.py', requirements: ['xlrd'], dependencyMode: 'pypi',
});
assert.equal(install.required, true, 'pypi 安装必须过人审门');
assert.equal(install.reason, 'dependency-install');
assert.equal(install.detail, 'xlrd', '弹窗要点名装的是哪个包');

// wheels 同样是进沙箱的第三方代码，也要点名
assert.equal(
  classify('python_run', {
    action: 'run', path: 'scripts/a.py', dependencyMode: 'pypi',
    wheels: ['./pkgs/foo-1.0-py3-none-any.whl'],
  }).detail,
  './pkgs/foo-1.0-py3-none-any.whl',
);

// 未列包名：有原因、无细节 → UI 走 messageWithoutDetail 降级，绝不渲染出字面 {detail}
const bare = classify('python_run', { action: 'run', path: 'scripts/a.py', dependencyMode: 'pypi' });
assert.equal(bare.reason, 'dependency-install');
assert.equal(bare.detail, undefined);

// 静态预检不安装不执行 → 不审批；官方目录模式 → 不审批
assert.equal(
  classify('python_run', { action: 'run', path: 'scripts/a.py', dependencyMode: 'pypi', preflight: true }).required,
  false, 'preflight 不触发审批',
);
assert.equal(
  classify('python_run', { action: 'run', path: 'scripts/a.py' }).required,
  false, 'catalog 模式不触发审批',
);

// ── ② action 级：点名命中的 action ────────────────────────────────────────
const removed = classify('note_tool', { action: 'delete', noteId: 'n1' });
assert.equal(removed.required, true);
assert.equal(removed.reason, 'action');
assert.equal(removed.detail, 'delete');
assert.equal(classify('note_tool', { action: 'list' }).required, false, '读操作不过人审门');

// ── ③ 参数语义级：点名命中的敏感字段 ─────────────────────────────────────
const sensitive = classify('browser_interact', { action: 'click', description: '确认支付订单' });
assert.equal(sensitive.required, true);
assert.equal(sensitive.reason, 'confirm');
assert.equal(sensitive.detail, 'description', '说明是哪个字段触发的，用户才能核对');

// 模型显式 confirm=true 但意图字段干净 → 有原因、无细节（降级文案）
const explicit = classify('js_run', { action: 'run', path: 'scripts/x.js', confirm: true });
assert.equal(explicit.required, true);
assert.equal(explicit.reason, 'confirm');
assert.equal(explicit.detail, undefined);

// 普通提交/搜索不因 confirm 语义被拦
assert.equal(
  classify('browser_interact', { action: 'click', description: '点击搜索按钮，提交搜索' }).required,
  false, '普通操作不触发审批',
);

// ── ④ 未注册工具：不审批、原因未知 ────────────────────────────────────────
assert.deepEqual(classify('no_such_tool', { action: 'run' }), { required: false, reason: 'unknown' });

// ── ⑤ 两个入口必须同源（同一份判定的两个投影） ───────────────────────────
const samples: Array<[string, unknown]> = [
  ['python_run', { action: 'run', path: 'scripts/a.py', requirements: ['xlrd'], dependencyMode: 'pypi' }],
  ['python_run', { action: 'run', path: 'scripts/a.py', dependencyMode: 'pypi', preflight: true }],
  ['note_tool', { action: 'delete', noteId: 'n1' }],
  ['note_tool', { action: 'list' }],
  ['browser_interact', { action: 'click', description: '确认支付订单' }],
  ['browser_interact', { action: 'click', description: '点击搜索按钮' }],
  ['js_run', { action: 'run', path: 'scripts/x.js', confirm: true }],
  ['js_run', { action: 'edit', path: 'scripts/x.js', content: '普通文本' }],
  ['no_such_tool', {}],
];
for (const [name, args] of samples) {
  assert.equal(
    OpenAIToolsConverter.requiresApproval(name, args),
    classify(name, args).required,
    `requiresApproval 与 classifyApproval 不一致: ${name} ${JSON.stringify(args)}`,
  );
}

// ── ⑥ 会话引擎把原因原样交给审批回调（弹窗文案的唯一输入） ───────────────
// 用持有对象而非裸变量承接：回调里的赋值不参与 TS 控制流分析，
// `let seen: X | undefined` 再赋值会被收窄，读取时报 never。
const approved: { request?: ToolApprovalRequest } = {};
const denied: { request?: ToolApprovalRequest } = {};
let executed = 0;
const engine = new ConversationEngine({
  requiresApproval: (name: string, args: unknown) => OpenAIToolsConverter.requiresApproval(name, args),
  approvalReason: (name: string, args: unknown) => OpenAIToolsConverter.classifyApproval(name, args),
  executeTool: async () => { executed++; return { success: true, data: {} }; },
} as any) as any;
const runtime = {
  chatId: 'approval-reason', toolIds: ['python_run'], vision: null,
  limits: { maxDurationMs: 60000, toolTimeoutMs: 1000 },
};
const run = (name: string, args: Record<string, unknown>, options: Record<string, unknown> = {}) =>
  engine.executeToolCalls(
    runtime,
    { abortController: new AbortController(), dynamicToolIds: new Set(), record: { toolCalls: [], parts: [] }, toolCallCount: 0 },
    [{ id: 'reason-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    options, () => {}, Date.now() + 60000,
  );

await run('python_run',
  { action: 'run', path: 'scripts/read_xls.py', requirements: ['xlrd'], dependencyMode: 'pypi' },
  { onToolApproval: async (request: ToolApprovalRequest) => { approved.request = request; return true; } });
assert.equal(executed, 1, '批准后才执行');
assert.equal(approved.request?.reason, 'dependency-install');
assert.equal(approved.request?.reasonDetail, 'xlrd');
assert.equal(approved.request?.name, 'python_run');
assert.ok(approved.request?.argumentsPreview.includes('xlrd'), '参数预览保留，用户可自行核对');

// 拒绝路径同样带原因（拒绝后模型收到 APPROVAL_NOT_GRANTED，弹窗文案已按原因分档）
const rejection = await run('python_run',
  { action: 'run', path: 'scripts/read_xls.py', requirements: ['xlrd'], dependencyMode: 'pypi' },
  { onToolApproval: async (request: ToolApprovalRequest) => { denied.request = request; return false; } });
assert.equal(executed, 1, '拒绝后不执行');
assert.equal(denied.request?.reason, 'dependency-install');
assert.match(rejection.messages[0].content, /APPROVAL_NOT_GRANTED/);

// 未注入 approvalReason（老测试桩的形态）时：审批门照常工作，只是不带原因
const legacySeen: { request?: ToolApprovalRequest } = {};
const legacy = new ConversationEngine({
  requiresApproval: () => true,
  executeTool: async () => ({ success: true, data: {} }),
} as any) as any;
await legacy.executeToolCalls(
  runtime,
  { abortController: new AbortController(), dynamicToolIds: new Set(), record: { toolCalls: [], parts: [] }, toolCallCount: 0 },
  [{ id: 'legacy-call', type: 'function', function: { name: 'python_run', arguments: JSON.stringify({ action: 'run', path: 'scripts/a.py' }) } }],
  { onToolApproval: async (request: ToolApprovalRequest) => { legacySeen.request = request; return true; } },
  () => {}, Date.now() + 60000,
);
assert.equal(legacySeen.request?.reason, undefined, '缺原因时 reason 缺省，UI 走通用文案');
assert.equal(legacySeen.request?.reasonDetail, undefined);

// ── ⑦ 文案分档：每个原因 × 有/无 detail 都能取到存在的 key，且占位符全部填上 ─
// 漏配 messageWithoutDetail 时 interpolate 会把字面「{detail}」渲染给用户，
// 这类错误编译期不报错、i18n 目录体检也查不到（key 本身是存在的），只能在这里拦。
const { selectToolApprovalCopy, TOOL_APPROVAL_COPY } = await import(
  '../../entrypoints/sidepanel/utils/tools/approval-copy'
);
const { t: tCore } = await import('../../utils/i18n/core');
const zhCatalog = (await import('../../utils/i18n/locales/zh-CN')).default;
const enCatalog = (await import('../../utils/i18n/locales/en')).default;

/** 目录 → 点路径 → 原文（与 tests/i18n 同口径） */
function leaves(node: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (typeof node === 'string') { if (prefix) out[prefix] = node; return out; }
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return out;
  for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
    leaves(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}
const catalogs = { 'zh-CN': leaves(zhCatalog), en: leaves(enCatalog) };

const reasons = Object.keys(TOOL_APPROVAL_COPY) as ToolApprovalReason[];
assert.deepEqual(
  [...reasons].sort(),
  ['action', 'confirm', 'dependency-install', 'plugin-call', 'plugin-session', 'tool', 'unknown'].sort(),
  '原因码与文案分档表必须一一对应（新增原因码而漏配文案会在这里失败）',
);

for (const reason of reasons) {
  for (const detail of ['', 'xlrd', 'delete', 'description', 'some/plugin-key']) {
    const copy = selectToolApprovalCopy({
      name: 'python_run', argumentsPreview: '{"action":"run"}', reason, reasonDetail: detail,
    });
    assert.equal(typeof copy.titleKey, 'string', `${reason} 必须选出标题 key`);
    for (const [locale, catalog] of Object.entries(catalogs)) {
      const title = catalog[copy.titleKey];
      const message = catalog[copy.messageKey];
      assert.ok(title !== undefined, `${locale} 缺标题 key: ${copy.titleKey}`);
      assert.ok(message !== undefined, `${locale} 缺正文 key: ${copy.messageKey}`);
      for (const raw of [title, message]) {
        const placeholders = [...raw.matchAll(/\{(\w+)\}/g)].map(match => match[1]);
        for (const name of placeholders) {
          assert.ok(
            name in copy.params && String(copy.params[name]).length > 0,
            `${locale}/${reason}/detail=${detail || '(空)'}: 占位符 {${name}} 未填上 → 会渲染字面量`,
          );
        }
      }
      assert.ok(message.length > 30, `${locale}/${reason} 正文过短，疑似取错 key`);
    }
    // 真实渲染路径（当前语言）也不能残留占位符。
    // 只查占位符名本身：参数预览是 JSON，本来就带花括号（{"action":"run"}）。
    for (const text of [tCore(copy.titleKey), tCore(copy.messageKey, copy.params)]) {
      assert.ok(!/\{(name|args|detail)\}/.test(text), `${reason} 渲染残留占位符: ${text}`);
      assert.ok(!text.includes('undefined'), `${reason} 渲染出现 undefined: ${text}`);
    }
  }
}

console.log('[approval-reason] Dependency/action/confirm/plugin reason split, same-source gating, engine passthrough and copy selection passed.');
