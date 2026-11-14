/** system-context 回归：<system_context> 注入结构 / URL 截断 / 转义 /
 * 激活网页查询在任何失败路径下返回 null 绝不抛出 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = process.cwd();
const output = path.resolve('node_modules/.cache/system-context-regression.mjs');
mkdirSync(path.dirname(output), { recursive: true });
await build({
  stdin: {
    contents: "export * from './entrypoints/sidepanel/utils/system-context.ts';",
    loader: 'ts',
    resolveDir: root,
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const {
  appendSystemContext,
  queryActivePageInfo,
  formatSystemTimestamp,
  ACTIVE_PAGE_URL_MAX_CHARS,
} = await import(pathToFileURL(output).href);

// —— 1. 注入结构：外层 source="auto_injected" + 时间/网页各自标签隔离 ——
{
  const out = appendSystemContext('你好', {
    now: new Date(2026, 10, 11, 14, 32, 5),
    activePage: { url: 'https://example.com/a?x=1&y=2', title: 'Example' },
  });
  assert.ok(out.startsWith('你好\n\n<system_context source="auto_injected">'), '正文后空行接外层标签，且带自动注入标识');
  assert.match(out, /<current_time>2026-11-11 14:32:05（UTC[+-]\d{2}:\d{2} · \S+ · [^）]+）<\/current_time>/, '时间标签含本地时间与时区三元组');
  assert.ok(out.includes('<url>https://example.com/a?x=1&y=2</url>'), 'URL 原样保留 & （模型可直接复制查询参数）');
  assert.ok(out.includes('<title>Example</title>'), '标题独立标签');
  assert.ok(out.trimEnd().endsWith('</system_context>'), '外层标签闭合');
  const order = ['<system_context', '<current_time>', '<active_page>', '</active_page>', '</system_context>'];
  assert.deepEqual(order.map(tag => out.indexOf(tag)).sort((a, b) => a - b), order.map(tag => out.indexOf(tag)), '标签层级顺序合法（无交叉嵌套）');
}

// —— 2. 激活页缺失：unavailable 占位，标签结构恒定 ——
{
  const out = appendSystemContext('Q', { now: new Date(2026, 10, 11, 0, 0, 0), activePage: null });
  assert.ok(out.includes('<active_page>unavailable</active_page>'), 'null 时整段退化为 unavailable');
  assert.ok(out.includes('<current_time>'), '时间标签不受影响');
}

// —— 3. URL 截断：总长恒 ≤ 上限，且带省略号明示截断 ——
{
  const longUrl = `https://example.com/${'a'.repeat(800)}`;
  const out = appendSystemContext('Q', { now: new Date(2026, 10, 11, 0, 0, 0), activePage: { url: longUrl, title: 't' } });
  const urlLine = out.split('\n').find(line => line.startsWith('<url>'));
  const inner = urlLine.slice('<url>'.length, -'</url>'.length);
  assert.equal(inner.length, ACTIVE_PAGE_URL_MAX_CHARS, '截断后总长恰为上限');
  assert.ok(inner.endsWith('…'), '截断点带省略号');
}

// —— 4. 转义：标题尖括号不得逃逸成标签；URL 不受影响 ——
{
  const out = appendSystemContext('Q', {
    now: new Date(2026, 10, 11, 0, 0, 0),
    activePage: { url: 'https://example.com/?q=<script>', title: '</system_context><b>' },
  });
  assert.ok(!out.includes('<b>'), '标题中的裸尖括号被转义');
  assert.ok(out.includes('&lt;b>'), '标题转义为 &lt;');
  assert.ok(out.includes('<url>https://example.com/?q=&lt;script></url>'), 'URL 中 < 同样转义，& 不动');
}

// —— 5. 激活网页查询：无 chrome / 查询抛错 / 空结果一律 null，绝不抛出 ——
{
  const saved = globalThis.chrome;
  try {
    delete globalThis.chrome;
    assert.equal(await queryActivePageInfo(), null, '无 chrome API（node 测试环境）返回 null');

    globalThis.chrome = { tabs: { query: async () => { throw new Error('boom'); } } };
    assert.equal(await queryActivePageInfo(), null, '查询抛错返回 null');

    globalThis.chrome = { tabs: { query: async () => [] } };
    assert.equal(await queryActivePageInfo(), null, '无激活标签返回 null');

    globalThis.chrome = { tabs: { query: async () => [{}] } };
    assert.equal(await queryActivePageInfo(), null, '标签缺 url/title 返回 null');

    // chrome:// 设置页（浏览器自身页面）：URL 与标题照常可读，不特判不抛错
    globalThis.chrome = {
      tabs: { query: async () => [{ url: 'chrome://settings/appearance', title: '外观 - 设置' }] },
    };
    assert.deepEqual(
      await queryActivePageInfo(),
      { url: 'chrome://settings/appearance', title: '外观 - 设置' },
      '浏览器自身页面正常返回',
    );
  } finally {
    if (saved === undefined) delete globalThis.chrome;
    else globalThis.chrome = saved;
  }
}

// —— 6. 时间戳格式：本地时间 + UTC 偏移 + IANA ID + 城市名 ——
{
  assert.match(
    formatSystemTimestamp(new Date(2026, 10, 11, 9, 5, 3)),
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}（UTC[+-]\d{2}:\d{2} · \S+ · \S+）$/,
    '时间三元组格式稳定（逐字稳定是 prompt cache 的前提）',
  );
}

console.log('[system-context] 注入结构 / 截断转义 / 查询兜底 / 时间格式全部通过。');
