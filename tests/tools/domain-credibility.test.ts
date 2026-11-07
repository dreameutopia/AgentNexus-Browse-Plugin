/**
 * 域名可信度评估（domain-credibility）单元测试
 *
 * 覆盖：
 *   1. 分层判定：权威 TLD / A 表 / B 表 / C 表 / D 表 / 未评级的命中与优先级
 *   2. 子域匹配：子域继承注册域档位；同 suffix 不同域不受影响
 *   3. 输入防御：空串 / 非法 URL / 无协议裸域名 / 路径参数不参与判定
 *   4. 标注形态：badge 含档位与一句话定位，可直接进结果表单元格
 *   5. 与搜索结果的装配契约：annotate 路径不破坏既有字段（web-search-tool 侧
 *      的 annotateCredibility 为私有函数，此处以 credibilityBadge 契约代测）
 *
 * 运行：node tests/tools/run.mjs   （或 npm run test:tools）
 */

import assert from 'node:assert/strict';
import {
  assessDomainCredibility,
  credibilityBadge,
} from '../../utils/search/domain-credibility';

// ── 1. 分层判定 ──

assert.equal(assessDomainCredibility('https://www.whitehouse.gov/briefing/').tier, 'A', '美国政府 TLD → A');
assert.equal(assessDomainCredibility('https://www.tsinghua.edu.cn/admission').tier, 'A', '中国教育 TLD → A');
assert.equal(assessDomainCredibility('https://www.mod.gov.cn/').tier, 'A', '政府二级后缀 → A');
assert.equal(assessDomainCredibility('https://arxiv.org/abs/2402.14207').tier, 'A', '预印本 → A');
assert.equal(assessDomainCredibility('https://www.nature.com/articles/s41586').tier, 'A', '一级学术出版 → A');
assert.notEqual(assessDomainCredibility('https://arxiv.org.cn.fake.com/x').tier, 'A', '后缀伪造域名不误判（真实域是 fake.com）');

assert.equal(assessDomainCredibility('https://www.reuters.com/world/china/').tier, 'B', '通讯社 → B');
assert.equal(assessDomainCredibility('https://developer.mozilla.org/zh-CN/docs/Web').tier, 'B', '官方技术文档 → B');
assert.equal(assessDomainCredibility('https://www.caixin.com/a/101').tier, 'B', '中文主流媒体 → B');

assert.equal(assessDomainCredibility('https://zh.wikipedia.org/wiki/AI').tier, 'C', '百科 → C');
assert.equal(assessDomainCredibility('https://blog.csdn.net/user/article/details/1').tier, 'C', 'CSDN → C');
assert.equal(assessDomainCredibility('https://github.com/anthropics/claude-code').tier, 'C', 'GitHub 仓库 → C');
assert.equal(assessDomainCredibility('https://stackoverflow.com/q/123').tier, 'C', 'StackOverflow → C');

assert.equal(assessDomainCredibility('https://tieba.baidu.com/p/1').tier, 'D', '贴吧 → D');
assert.equal(assessDomainCredibility('https://someone.blogspot.com/2026/01/x.html').tier, 'D', '自媒体托管 → D');

// 未评级：未知域名归 '?' 而不是猜低（未知 ≠ 差）
assert.equal(assessDomainCredibility('https://www.some-random-site-2026.com/article').tier, '?', '未知域名 → ?');

// ── 2. 子域匹配与优先级 ──

assert.equal(assessDomainCredibility('https://docs.python.org/3/').tier, 'B', '子域继承注册域档位');
assert.equal(assessDomainCredibility('https://pmc.ncbi.nlm.nih.gov/articles/1').tier, 'A', '深层子域（nih.gov 教育医疗体系）');
// D 表条目 blogspot.com 命中子域，优先于未评级
assert.equal(assessDomainCredibility('https://a.b.blogspot.com/').tier, 'D', '多级子域仍命中 D 表');
// 高层表优先于低层表（同域名不会同时命中两张表，此处验证判定顺序无歧义）
assert.equal(assessDomainCredibility('https://wenku.baidu.com/view/1').tier, 'D', 'D 表精确条目优先于其母域（baidu.com 不在任何表）');

// ── 3. 输入防御（不抛错是硬契约：该函数跑在搜索装配热路径上） ──

assert.equal(assessDomainCredibility('').tier, '?', '空串不抛错');
assert.equal(assessDomainCredibility('   ').tier, '?', '纯空白不抛错');
assert.equal(assessDomainCredibility('not a url ://').tier, '?', '非法 URL 不抛错');
assert.equal(assessDomainCredibility('nature.com').tier, 'A', '无协议裸域名仍可判定');
assert.equal(assessDomainCredibility('https://nature.com/path?q=x#frag').tier, 'A', '路径/查询/锚点不参与判定');
assert.equal(assessDomainCredibility('HTTPS://ARXIV.ORG/X').tier, 'A', '大小写不敏感');

// ── 4. 标注形态（结果表单元格契约） ──

const badge = credibilityBadge('https://arxiv.org/abs/1');
assert.ok(badge.startsWith('A·权威'), 'badge 以档位开头');
assert.ok(badge.includes('（') && badge.includes('）'), 'badge 含一句话定位');
assert.ok(credibilityBadge('https://nowhere-xyz-123.com/').includes('?'), '未评级 badge 含 ?');
for (const [url, expectTier] of [
  ['https://www.imf.org/en/Publications', 'A'],
  ['https://go.dev/blog/survey', 'B'],
  ['https://juejin.cn/post/1', 'C'],
] as const) {
  assert.equal(assessDomainCredibility(url).tier, expectTier);
  assert.ok(assessDomainCredibility(url).reason.length > 0, '每档位必须带判定依据文案');
}

console.log('[tools] domain-credibility: 分层判定 / 子域匹配 / 输入防御 / 标注形态 passed.');
