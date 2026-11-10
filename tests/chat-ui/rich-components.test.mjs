/**
 * 富组件体系回归测试（统一信封 + 注册表 + 派生 + 同步构建器 + fence 分发）
 *
 * 覆盖：
 *   1. 注册表完整性：语言名唯一、legacy / 原生 / 信封保留名查找正确；
 *   2. 提示词生成：默认集 / 能力裁剪 / 空集跳过 / 恒定性（前缀缓存安全）；
 *   3. 信封解析：严格 JSON、尾逗号与单引号修复、对象行 / 名值映射 / 包装
 *      解包、行长对齐、单元格收敛、上限（列 / 行 / 字符）、失败路径；
 *   4. 图表派生：图型推断（bar 默认 / line 时间序 / pie 占比语义）、显式
 *      kind 与非法 kind 回落、radar 转置、scatter 分组、gauge / funnel /
 *      heatmap、数值宽容解析、与净化器的组合（防御纵深）；
 *   5. 同步构建器：stat（涨跌方向只由 +/- 驱动、>6 行降级）、table（数值列
 *      右对齐、状态着色、不被 wrapTables 二次包裹）、timeline（状态列识别）、
 *      tree（层级 / 去重）、diff（行级着色 + 统计 + 转义）；
 *   6. markdown 渲染器集成：```component 信封（chart 骨架 / 同步组件 / 失败
 *      降级代码块）、legacy 围栏兼容、mermaid / diff 原生围栏、XSS 转义。
 *
 * 运行：node tests/chat-ui/rich-components.test.mjs   （或 npm run test:chat-ui）
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const outfile = path.resolve('node_modules/.cache/rich-components.mjs');
mkdirSync(path.dirname(outfile), { recursive: true });

await build({
  stdin: {
    contents: [
      "export { markdownRenderer } from './entrypoints/sidepanel/utils/chat/markdown-renderer';",
      "export { parseRichEnvelope } from './entrypoints/sidepanel/utils/chat/rich-components/envelope';",
      "export { deriveChartOption } from './entrypoints/sidepanel/utils/chat/rich-components/derive-chart';",
      "export { buildEnvelopeComponentBlock, buildDiffBlock } from './entrypoints/sidepanel/utils/chat/rich-components/component-blocks';",
      "export { RICH_COMPONENTS, findRichComponentByFenceLang, COMPONENT_FENCE_LANG } from './entrypoints/sidepanel/utils/chat/rich-components/registry';",
      "export { buildRichOutputSystemPrompt } from './entrypoints/sidepanel/utils/chat/rich-components/rich-output-prompt';",
      "export { sanitizeEchartsOptionJson } from './entrypoints/sidepanel/utils/chat/echarts-option-sanitizer';",
      "export { t, setLocale } from './utils/i18n/core';",
    ].join('\n'),
    loader: 'ts',
    resolveDir: root,
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  loader: { '.css': 'empty' },
  plugins: [
    {
      name: 'alias-at',
      setup(api) {
        api.onResolve({ filter: /^@\// }, args => {
          const base = path.join(root, args.path.slice(2));
          for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
            if (existsSync(candidate) && statSync(candidate).isFile()) return { path: candidate };
          }
          return { path: base };
        });
      },
    },
  ],
});

// —— DOM 环境（必须在导入被测模块之前就绪：markdown-renderer 加载时即安装 document 级委托）——
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test/' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'Node', 'MouseEvent', 'KeyboardEvent']) {
  globalThis[key] = dom.window[key];
}

const {
  markdownRenderer,
  parseRichEnvelope,
  deriveChartOption,
  buildEnvelopeComponentBlock,
  buildDiffBlock,
  RICH_COMPONENTS,
  findRichComponentByFenceLang,
  buildRichOutputSystemPrompt,
  COMPONENT_FENCE_LANG,
  sanitizeEchartsOptionJson,
  setLocale,
} = await import(pathToFileURL(outfile).href);

setLocale('zh-CN');

// ==================== 1. 注册表完整性 ====================

{
  const ids = RICH_COMPONENTS.map(spec => spec.id);
  assert.equal(new Set(ids).size, ids.length, '组件 id 必须唯一');

  assert.equal(findRichComponentByFenceLang('echarts')?.id, 'chart');
  assert.equal(findRichComponentByFenceLang('chart')?.id, 'chart', 'legacy 直连名 chart 归 chart');
  assert.equal(findRichComponentByFenceLang('stat-card')?.id, 'stat');
  assert.equal(findRichComponentByFenceLang('stats')?.id, 'stat');
  assert.equal(findRichComponentByFenceLang('mermaid')?.id, 'diagram');
  assert.equal(findRichComponentByFenceLang('puml')?.id, 'diagram');
  assert.equal(findRichComponentByFenceLang('diff')?.id, 'diff');
  assert.equal(findRichComponentByFenceLang(COMPONENT_FENCE_LANG), undefined, 'component 是信封保留名，不直连');
  assert.equal(findRichComponentByFenceLang('python'), undefined, '普通代码语言不命中注册表');

  const allLangs = RICH_COMPONENTS.flatMap(spec => [...spec.fenceLangs]);
  assert.equal(new Set(allLangs).size, allLangs.length, '围栏语言名不得跨组件重复');
}

// ==================== 2. 提示词生成 ====================

{
  const prompt = buildRichOutputSystemPrompt();
  assert.ok(prompt.startsWith('<rich-output-guidelines>'), '分区标签开头');
  assert.ok(prompt.endsWith('</rich-output-guidelines>'), '分区标签收尾');

  // 形式表：宿主支持的全部形式在一张表里给出（形式 / 适用场景 / 怎么写）
  assert.ok(prompt.includes('| 形式 | 适用场景 | 怎么写 |'), '形式表头在场');
  for (const spec of RICH_COMPONENTS) {
    // 信封组件教 type 值，原生组件教围栏名——两种形式都必须在提示词里可教
    const token = spec.form === 'envelope' ? spec.envelopeType : spec.fenceLangs[0];
    assert.ok(prompt.includes(token), `组件 ${spec.id} 的输出形式 ${token} 在提示词中可教`);
  }
  assert.ok(prompt.includes('`component` · `chart` |'), 'chart 行在场');
  assert.ok(prompt.includes('`component` · `stat` |'), 'stat 行在场');
  assert.ok(prompt.includes('`component` · `table` |'), 'table 行在场');
  assert.ok(prompt.includes('`component` · `timeline` |'), 'timeline 行在场');
  assert.ok(prompt.includes('`component` · `tree` |'), 'tree 行在场');
  assert.ok(prompt.includes('`component` · `insight` |'), 'insight 行在场');
  assert.ok(prompt.includes('`mermaid` 围栏 |'), 'mermaid 原生围栏行在场');
  assert.ok(prompt.includes('`diff` 围栏 |'), 'diff 原生围栏行在场');

  // 形状教学（模型照抄字段名即可）
  assert.ok(prompt.includes('"type":"chart"'), 'chart 示例在场（形状教学）');

  // 事实优先 / 交叉验证 / 来源标注 / 关键见解拆解：四条纪律必须在场
  assert.ok(prompt.includes('事实优先'), '事实优先在场');
  assert.ok(prompt.includes('严禁编造'), '数据纪律在场');
  assert.ok(prompt.includes('换一个独立来源'), '交叉验证纪律在场');
  assert.ok(prompt.includes('source'), '来源字段在场');
  assert.ok(prompt.includes('insight 组件逐条列出'), '关键见解拆解在场');

  // 不得教模型写图表 option 内部结构（宿主派生，外观由界面负责）
  assert.ok(!prompt.includes('series'), '不得再教模型写 series（宿主派生）');
  assert.ok(!prompt.includes('```echarts'), 'legacy 直连名不进提示词（只服务历史消息）');
  assert.ok(!prompt.includes('stat-card'), 'legacy 直连名不进提示词（只服务历史消息）');

  // 恒定性（同一输入产出逐字节相同——system 前缀缓存安全）
  assert.equal(prompt, buildRichOutputSystemPrompt(), '提示词生成必须恒定');

  // 能力裁剪：只教声明的组件
  const trimmed = buildRichOutputSystemPrompt(['chart', 'stat']);
  assert.ok(trimmed.includes('`component` · `stat` |'), '已声明组件在场');
  assert.ok(!trimmed.includes('`component` · `table` |'), '未声明组件不得出现在提示词');
  assert.ok(!trimmed.includes('mermaid'), '未声明 diagram 时原生围栏提示不出现');
  assert.ok(!trimmed.includes('insight'), '未声明 insight 时不得出现');

  // 显式空数组 = 整段不注入
  assert.equal(buildRichOutputSystemPrompt([]), '', '空能力集必须返回空串');

  // 未知 id 剔除后仍有命中则渲染
  const withBogus = buildRichOutputSystemPrompt(['chart', 'bogus-component']);
  assert.ok(withBogus.includes('`component` · `chart` |'), '合法 id 保留');
  assert.ok(!withBogus.includes('bogus-component'), '未知 id 不进提示词');
}

// ==================== 3. 信封解析 ====================

const CHART_JSON =
  '{"type":"chart","title":"近7日活跃","columns":["日期","新增","活跃"],"rows":[["周一",12,30],["周二",18,41]]}';

{
  const parsed = parseRichEnvelope(CHART_JSON);
  assert.ok(parsed.ok, '严格 JSON 必须解析成功');
  assert.equal(parsed.envelope.type, 'chart');
  assert.equal(parsed.envelope.columns.length, 3);
  assert.equal(parsed.envelope.rows.length, 2);
  assert.equal(parsed.envelope.rows[0][2], 30, '单元格原样保留（数组行）');
}

{
  // 尾逗号 + 全单引号（Python 习惯）→ 修复后解析成功
  const repaired = parseRichEnvelope("{'type':'stat','columns':['指标','值'],'rows':[['打卡','6 天'],],}");
  assert.ok(repaired.ok, `尾逗号 + 单引号应被修复：${repaired.ok ? '' : repaired.error}`);
  assert.equal(repaired.envelope.type, 'stat');
  assert.equal(repaired.envelope.rows.length, 1);
}

{
  // 混合引号（双引号串 + 单引号键）：字符串感知扫描器逐串转换，安全成功
  const mixed = parseRichEnvelope('{"type":"stat","columns":["指标","值"],\'rows\':[[\'打卡\',\'6\']]}');
  assert.ok(mixed.ok, `混合引号应由扫描器逐串修复：${mixed.ok ? '' : mixed.error}`);
  assert.deepEqual(mixed.envelope.rows, [['打卡', '6']]);
}

{
  // 字符串内容保护：串内的 ",]" 与撇号不被修复触碰（正则方案的致命缺陷）
  const protectedContent = parseRichEnvelope(
    "{'type':'table','columns':['数据','备注'],'rows':[['a,]','it\\'s ok'],]}",
  );
  assert.ok(protectedContent.ok, `串内尾逗号形态不得被误删：${protectedContent.ok ? '' : protectedContent.error}`);
  assert.equal(protectedContent.envelope.rows[0][0], 'a,]');
  assert.equal(protectedContent.envelope.rows[0][1], "it's ok");
}

{
  // rows 为对象数组 → 按列名映射
  const objRows = parseRichEnvelope(
    '{"type":"chart","columns":["日期","新增"],"rows":[{"日期":"周一","新增":12},{"日期":"周二","新增":18}]}',
  );
  assert.ok(objRows.ok);
  assert.deepEqual(objRows.envelope.rows, [['周一', 12], ['周二', 18]]);
}

{
  // rows 为名值映射 → 二元组（占比数据常见写法）
  const mapRows = parseRichEnvelope('{"type":"chart","columns":["状态","占比"],"rows":{"正常":92,"异常":8}}');
  assert.ok(mapRows.ok);
  assert.deepEqual(mapRows.envelope.rows, [['正常', 92], ['异常', 8]]);
}

{
  // {data:{...}} 双层包装解包
  const wrapped = parseRichEnvelope(
    '{"type":"chart","data":{"columns":["x","y"],"rows":[[1,2],[3,4]]}}',
  );
  assert.ok(wrapped.ok, `data 包装应解包：${wrapped.ok ? '' : wrapped.error}`);
  assert.equal(wrapped.envelope.rows.length, 2);
}

{
  // 行长对齐：短补 null、长截断；单元格对象 stringify 兜底
  const aligned = parseRichEnvelope(
    '{"type":"table","columns":["a","b","c"],"rows":[["only-a"],["a","b","c","d"],[{"k":1},true,null]]}',
  );
  assert.ok(aligned.ok);
  assert.deepEqual(aligned.envelope.rows[0], ['only-a', null, null], '短行补 null');
  assert.deepEqual(aligned.envelope.rows[1], ['a', 'b', 'c'], '长行截断');
  assert.equal(aligned.envelope.rows[2][0], '{"k":1}', '对象单元格 stringify');
  assert.equal(aligned.envelope.rows[2][1], true, '布尔保留');
}

{
  // 上限与失败路径
  assert.ok(!parseRichEnvelope('').ok, '空内容失败');
  assert.ok(!parseRichEnvelope('not json at all').ok, '非 JSON 失败');
  assert.ok(!parseRichEnvelope('[1,2,3]').ok, '非对象失败');
  assert.ok(!parseRichEnvelope('{"type":"hologram","columns":["a"],"rows":[[1]]}').ok, '未知 type 失败');
  assert.ok(!parseRichEnvelope('{"columns":["a"],"rows":[[1]]}').ok, '缺 type 失败');
  assert.ok(!parseRichEnvelope('{"type":"chart","rows":[[1]]}').ok, '缺 columns 失败');

  const wideCols = Array.from({ length: 13 }, (_, i) => `c${i}`).join('","');
  assert.ok(
    !parseRichEnvelope(`{"type":"table","columns":["${wideCols}"],"rows":[[1,2,3]]}`).ok,
    '列数超上限失败',
  );

  const manyRows = JSON.stringify({
    type: 'table',
    columns: ['a', 'b'],
    rows: Array.from({ length: 260 }, (_, i) => [i, i + 1]),
  });
  const clamped = parseRichEnvelope(manyRows);
  assert.ok(clamped.ok);
  assert.equal(clamped.envelope.rows.length, 200, '行数软截断到 200');

  // type 大小写宽容
  const upperType = parseRichEnvelope('{"type":"CHART","columns":["a","b"],"rows":[[1,2]]}');
  assert.ok(upperType.ok);
  assert.equal(upperType.envelope.type, 'chart');
}

// ==================== 4. 图表派生 ====================

function deriveFrom(json) {
  const parsed = parseRichEnvelope(json);
  assert.ok(parsed.ok, `信封必须先解析成功：${parsed.ok ? '' : parsed.error}`);
  return deriveChartOption(parsed.envelope);
}

{
  const { ok, option } = deriveFrom(CHART_JSON);
  assert.ok(ok);
  assert.equal(option.series.length, 2, '每个数值列一个系列');
  assert.equal(option.series[0].type, 'bar', '默认柱状');
  assert.deepEqual(option.series[0].data, [12, 18], '系列数据点数与类目轴严格同源');
  assert.deepEqual(option.xAxis.data, ['周一', '周二']);
  assert.equal(option.title.text, '近7日活跃');
}

{
  // 时间序首列 + ≥4 行 → 折线
  const { option } = deriveFrom(
    '{"type":"chart","columns":["日期","销量"],"rows":[["1月",3],["2月",5],["3月",8],["4月",13],["2026-05",21]]}',
  );
  assert.equal(option.series[0].type, 'line', '首列时间序自动折线');
}

{
  // 占比语义（列名）→ 饼图
  const { option } = deriveFrom(
    '{"type":"chart","columns":["状态","占比"],"rows":[["正常",70],["降级",20],["故障",10]]}',
  );
  assert.equal(option.series[0].type, 'pie');
  assert.deepEqual(option.series[0].data[0], { name: '正常', value: 70 });
}

{
  // 显式 kind 覆盖推断；非法 kind 回落推断
  const explicit = deriveFrom(
    '{"type":"chart","kind":"area","columns":["a","b"],"rows":[["x",1],["y",2]]}',
  );
  assert.equal(explicit.option.series[0].type, 'line', 'area 以 line 承载');
  assert.ok(explicit.option.series[0].areaStyle, 'area 带面积样式');

  const bogus = deriveFrom(
    '{"type":"chart","kind":"hologram","columns":["a","b"],"rows":[["x",1],["y",2]]}',
  );
  assert.equal(bogus.option.series[0].type, 'bar', '非法 kind 回落到推断');
}

{
  // radar 转置：行 = 维度，其余列 = 对照实体；空名行双侧同源剔除
  const { option } = deriveFrom(
    '{"type":"chart","kind":"radar","columns":["维度","方案A","方案B"],"rows":[["稳定",8,6],["",5,5],["速度",6,9],["上下文",9,5]]}',
  );
  assert.equal(option.radar.indicator.length, 3, '空名行从 indicator 剔除');
  assert.equal(option.series[0].data[0].value.length, 3, 'series 值与 indicator 严格同长（转置同源）');
  assert.deepEqual(option.series[0].data[0].value, [8, 6, 9]);
}

{
  // radar 全空名 → 结构性失败
  const allEmpty = deriveFrom(
    '{"type":"chart","kind":"radar","columns":["维度","A"],"rows":[["",1],["",2]]}',
  );
  assert.ok(!allEmpty.ok, '雷达图维度名全空必须失败');
}

{
  // scatter 三列分组
  const { option } = deriveFrom(
    '{"type":"chart","kind":"scatter","columns":["大小","耗时","类型"],"rows":[[120,450,"文章"],[95,380,"文章"],[340,900,"图集"]]}',
  );
  assert.equal(option.series.length, 2, '按第 3 列分组为多系列');
  assert.deepEqual(option.series[0].data, [[120, 450], [95, 380]]);
}

{
  // gauge：单值 + 上限
  const { option } = deriveFrom('{"type":"chart","kind":"gauge","columns":["指标","百分比"],"rows":[["已用",62]]}');
  assert.equal(option.series[0].data[0].value, 62);
  assert.equal(option.series[0].max, 100, '≤100 的值上限取 100');
}

{
  // funnel
  const { option } = deriveFrom(
    '{"type":"chart","kind":"funnel","columns":["环节","数量"],"rows":[["访问",1000],["注册",300],["付费",45]]}',
  );
  assert.equal(option.series[0].data.length, 3);
  assert.deepEqual(option.series[0].data[2], { name: '付费', value: 45 });
}

{
  // heatmap：坐标去重 + 三元组
  const { option } = deriveFrom(
    '{"type":"chart","kind":"heatmap","columns":["时段","页面","耗时"],"rows":[["早","首页",800],["早","详情",1200],["晚","首页",1500]]}',
  );
  assert.deepEqual(option.xAxis.data, ['早', '晚']);
  assert.deepEqual(option.yAxis.data, ['首页', '详情']);
  assert.deepEqual(option.series[0].data[1], [0, 1, 1200]);
}

{
  // 数值宽容解析与断点保留（含千分位）
  const { option } = deriveFrom(
    '{"type":"chart","columns":["项目","数值"],"rows":[["a","12.3%"],["b","1,240"],["c","不可解析"],["d",7]]}',
  );
  assert.deepEqual(option.series[0].data, [12.3, 1240, null, 7], '百分号剥离、千分位归一；不可解析为 null 断点');

  // 空列名兜底（图例不允许空串）
  const anonSeries = deriveFrom(
    '{"type":"chart","columns":["项目",""],"rows":[["a",1],["b",2]]}',
  );
  assert.equal(anonSeries.option.series[0].name, '系列1', '空列名回退为 系列N');

  // unit → 轴名
  const withUnit = deriveFrom(
    '{"type":"chart","unit":"ms","columns":["页面","耗时"],"rows":[["首页",820],["详情",900]]}',
  );
  assert.equal(withUnit.option.yAxis.name, 'ms');
}

{
  // 结构性失败
  assert.ok(!deriveChartOption(parseRichEnvelope('{"type":"chart","columns":["单列"],"rows":[["a"]]}').envelope).ok, '单列无法成图');
  const gaugeBad = deriveFrom('{"type":"chart","kind":"gauge","columns":["指标","值"],"rows":[["x","不数字"]]}');
  assert.ok(!gaugeBad.ok, '仪表盘数值不可解析必须失败');
}

{
  // 派生 → 净化 组合（防御纵深：派生产物仍能过净化器）
  const composed = (() => {
    const derived = deriveFrom(CHART_JSON);
    return sanitizeEchartsOptionJson(JSON.stringify(derived.option));
  })();
  assert.ok(composed.ok, `派生 option 必须能过净化器：${composed.ok ? '' : composed.error}`);
}

// ==================== 5. 同步构建器 ====================

function envelopeOf(json) {
  const parsed = parseRichEnvelope(json);
  assert.ok(parsed.ok, `信封解析失败：${parsed.ok ? '' : parsed.error}`);
  return parsed.envelope;
}

{
  const stat = buildEnvelopeComponentBlock(
    envelopeOf(
      '{"type":"stat","title":"周报","columns":["指标","值","环比","说明"],"rows":[["打卡","6 天","+1 天","最长 12 天"],["时长","5.4h","-8.2%","日均 46m"],["正确率","87.5%","持平","均值"]]}',
    ),
  );
  assert.ok(stat.includes('stat-card-block'));
  assert.ok(stat.includes('stat-card-trend up'), '+ 前缀渲染上升');
  assert.ok(stat.includes('stat-card-trend down'), '- 前缀渲染下降');
  // 持平（无 +/- 前缀）不得出现在 trend 容器里
  assert.ok(!/stat-card-trend[^>]*>.{0,80}持平/.test(stat), '中性趋势文本不渲染箭头');

  // >6 行降级
  const tooMany = buildEnvelopeComponentBlock(
    envelopeOf(
      `{"type":"stat","columns":["a","b"],"rows":${JSON.stringify(Array.from({ length: 7 }, (_, i) => [i, i]))}}`,
    ),
  );
  assert.equal(tooMany, null, '超过 6 行降级源码');
}

{
  const table = buildEnvelopeComponentBlock(
    envelopeOf(
      '{"type":"table","title":"审计","columns":["页面","耗时ms","状态"],"rows":[["首页",820,"良好"],["详情",4100,"超标"],["购物车",980,"通过"]]}',
    ),
  );
  assert.ok(table.includes('<table class="component-data-table">'), '表格带 class（防 wrapTables 二次包裹）');
  assert.ok(table.includes('<th class="num">耗时ms</th>'), '数值列右对齐类');
  assert.ok(table.includes('st-good'), '状态着色（良好）');
  assert.ok(table.includes('st-bad'), '状态着色（超标）');
}

{
  // XSS：模型文本全部转义
  const xss = buildEnvelopeComponentBlock(
    envelopeOf(
      '{"type":"table","columns":["x","y"],"rows":[["<script>alert(1)</script>","<img onerror=alert(2)>"]]}',
    ),
  );
  assert.ok(xss.includes('&lt;script&gt;'));
  assert.ok(!xss.includes('<script>'));
  assert.ok(!xss.includes('<img onerror'));
}

{
  const timeline = buildEnvelopeComponentBlock(
    envelopeOf(
      '{"type":"timeline","title":"执行过程","columns":["步骤","动作","状态","耗时"],"rows":[["1","打开页面","完成","2.1s"],["2","采集数据","进行中","31s"],["3","导出","失败","—"]]}',
    ),
  );
  assert.ok(timeline.includes('tl-item done'), '完成态');
  assert.ok(timeline.includes('tl-item active'), '进行中态');
  assert.ok(timeline.includes('tl-item fail'), '失败态');
  // 状态只从「状态」列读取：耗时列的 "—" 不影响状态
  assert.ok(timeline.includes('tl-title">1 · 打开页面'), '主文 = 前两列拼接');
}

{
  const tree = buildEnvelopeComponentBlock(
    envelopeOf(
      '{"type":"tree","columns":["路径","备注"],"rows":[["工作/",""],["工作/文档/","周报"],["工作/文档/a.md",""],["工作/文档/a.md","重复行"],["娱乐/",""]]}',
    ),
  );
  assert.equal((tree.match(/tree-row/g) || []).length, 4, '重复路径去重');
  assert.ok(tree.includes('data-depth="2"'));
  assert.ok(tree.includes('tree-branch'), '分支行标记');
  assert.ok(tree.includes('tree-note'), '备注渲染');
}

{
  const diff = buildDiffBlock('--- a/f.ts\n+++ b/f.ts\n@@ -1,2 +1,2 @@\n context\n-const MAX = 100;\n+const MAX = 200;\n+const MIN = 0;');
  assert.ok(diff.includes('diff-block'));
  assert.ok(diff.includes('diff-line del'));
  assert.ok(diff.includes('diff-line add'));
  assert.ok(diff.includes('diff-line meta'), 'hunk 行 meta');
  assert.ok(diff.includes('+2'), '新增统计');
  assert.ok(diff.includes('−1'), '删除统计');

  const diffXss = buildDiffBlock('+ <script>alert(1)</script>');
  assert.ok(diffXss.includes('&lt;script&gt;'));
  assert.ok(!diffXss.includes('<script>'));
}

// ==================== 5.5 insight 关键见解卡 + 组件级来源 ====================

{
  // 信封解析：insight 是合法 type，source 字段被保留
  const parsed = parseRichEnvelope(
    '{"type":"insight","title":"关键结论","source":"IDC 2026 报告","columns":["洞察","证据","来源","置信度"],"rows":[["需求回升","出货量 +18%","idc.example.com","高"]]}',
  );
  assert.ok(parsed.ok, 'insight 信封必须解析成功');
  assert.equal(parsed.envelope.type, 'insight');
  assert.equal(parsed.envelope.source, 'IDC 2026 报告', 'source 字段保留');
  assert.equal(parsed.envelope.rows.length, 1);

  // 组件构建：一条见解一卡（断言 + 证据 + 来源 + 置信度徽标）
  const html = buildEnvelopeComponentBlock(parsed.envelope);
  assert.ok(html !== null, 'insight 必须产出可信 HTML');
  assert.ok(html.includes('component-insight-block'), 'insight 容器在场');
  assert.ok(html.includes('ins-item'), '见解条目在场');
  assert.ok(html.includes('ins-claim'), '断言主文在场');
  assert.ok(html.includes('需求回升'), '断言文本在场');
  assert.ok(html.includes('ins-evidence'), '证据行在场');
  assert.ok(html.includes('ins-source'), '来源行在场');
  assert.ok(html.includes('ins-conf lv-high'), '置信度徽标按档位着色');
  assert.ok(html.includes('component-block-source'), '组件级来源脚注在场');
  assert.ok(html.includes('IDC 2026 报告'), '脚注内容在场');

  // XSS：模型内容全量转义
  const xss = buildEnvelopeComponentBlock(
    parseRichEnvelope(
      '{"type":"insight","columns":["洞察"],"rows":[["<script>alert(1)</script>"]]}',
    ).envelope,
  );
  assert.ok(xss !== null && xss.includes('&lt;script&gt;'), 'insight 内容必须转义');
  assert.ok(!xss.includes('<script>'), 'insight 不得出现裸 script 标签');

  // 列角色兜底：列名不规整时按位置补位（洞察 / 证据 / 来源 / 置信度）
  const positional = buildEnvelopeComponentBlock(
    parseRichEnvelope(
      '{"type":"insight","columns":["a","b","c","d"],"rows":[["结论","数字","链接","中"]]}',
    ).envelope,
  );
  assert.ok(positional !== null && positional.includes('ins-claim'), '兜底：第 1 列作断言');
  assert.ok(positional.includes('ins-evidence'), '兜底：第 2 列作证据');
  assert.ok(positional.includes('ins-source'), '兜底：第 3 列作来源');
  assert.ok(positional.includes('ins-conf lv-mid'), '兜底：第 4 列作置信度');

  // 置信度未识别 → 归「未验证」档，不美化
  const unknownConf = buildEnvelopeComponentBlock(
    parseRichEnvelope('{"type":"insight","columns":["洞察","置信度"],"rows":[["x","待复核"]]}').envelope,
  );
  assert.ok(unknownConf.includes('ins-conf lv-unknown'), '未识别置信度归未验证档');

  // 行数超限（>12）判建模错误 → 降级源码（调用方回落代码块）
  const tooMany = buildEnvelopeComponentBlock(
    parseRichEnvelope(
      JSON.stringify({
        type: 'insight',
        columns: ['洞察'],
        rows: Array.from({ length: 13 }, (_, i) => [`结论 ${i}`]),
      }),
    ).envelope,
  );
  assert.equal(tooMany, null, '超行数上限必须降级');

  // 组件级来源脚注：table 也带
  const tableWithSource = buildEnvelopeComponentBlock(
    parseRichEnvelope('{"type":"table","source":"统计局","columns":["a"],"rows":[["1"]]}').envelope,
  );
  assert.ok(tableWithSource.includes('component-block-source'), 'table 也渲染来源脚注');
  assert.ok(tableWithSource.includes('统计局'), '来源内容在场');

  // 未提供 source 时不渲染脚注（不出现「来源：无」噪音）
  const noSource = buildEnvelopeComponentBlock(
    parseRichEnvelope('{"type":"table","columns":["a"],"rows":[["1"]]}').envelope,
  );
  assert.ok(!noSource.includes('component-block-source'), '无来源时不得渲染脚注');
}

// ==================== 6.5 组件头部动作：单个「保存」按钮 ====================

{
  // 契约：富组件头部动作只有「保存」（无复制 / 无查看源码），且带定格文案 data-*
  const CASES = [
    ['信封 chart', '```component\n{"type":"chart","columns":["a","b"],"rows":[["x",1]]}\n```'],
    ['信封 stat', '```component\n{"type":"stat","columns":["a","b"],"rows":[["x","1"]]}\n```'],
    ['信封 table', '```component\n{"type":"table","columns":["a"],"rows":[["1"]]}\n```'],
    ['信封 timeline', '```component\n{"type":"timeline","columns":["步骤"],"rows":[["1"]]}\n```'],
    ['信封 tree', '```component\n{"type":"tree","columns":["路径"],"rows":[["a/b"]]}\n```'],
    ['信封 insight', '```component\n{"type":"insight","columns":["洞察"],"rows":[["结论"]]}\n```'],
    ['legacy stat-card', '```stat-card\n{"items":[{"label":"旧卡","value":"42"}]}\n```'],
    ['mermaid', '```mermaid\nflowchart LR\nA-->B\n```'],
    ['diff', '```diff\n+ 新增行\n```'],
  ];

  for (const [label, markdown] of CASES) {
    const html = markdownRenderer.renderMessage(markdown);
    assert.ok(html.includes('component-save-btn'), `${label}：保存按钮在场`);
    assert.ok(html.includes('data-save-idle-label='), `${label}：初始文案定格`);
    assert.ok(html.includes('data-save-done-label='), `${label}：完成文案定格`);
    // 复制与查看源码已从富组件头部移除（源码查看改为渲染失败时自动展开）
    assert.ok(!html.includes('chart-copy-btn') && !html.includes('diagram-copy-btn'), `${label}：无复制按钮`);
    assert.ok(!html.includes('chart-toggle-btn') && !html.includes('diagram-toggle-btn'), `${label}：无查看源码按钮`);
  }

  // 普通代码块仍走复制（不被「保存」替换）
  const plainCode = markdownRenderer.renderMessage('```js\nconst a = 1;\n```');
  assert.ok(plainCode.includes('code-copy-btn'), '普通代码块保留复制按钮');
  assert.ok(!plainCode.includes('component-save-btn'), '普通代码块不注入保存按钮');

  // 每个富组件根恰有一个保存按钮（不多不少——重复按钮会让用户存两次图）
  const table = markdownRenderer.renderMessage('```component\n{"type":"table","columns":["a"],"rows":[["1"]]}\n```');
  assert.equal((table.match(/class="[^"]*component-save-btn/g) || []).length, 1, 'table：恰一个保存按钮');
  const stat = markdownRenderer.renderMessage('```component\n{"type":"stat","columns":["a"],"rows":[["x","1"]]}\n```');
  assert.equal((stat.match(/class="[^"]*component-save-btn/g) || []).length, 1, 'stat：恰一个保存按钮');
}

// ==================== 6. markdown 渲染器集成 ====================

{
  // 信封 chart → 骨架（信封源码保真存 .chart-source）
  const chartHtml = markdownRenderer.renderMessage(`\`\`\`component\n${CHART_JSON}\n\`\`\``);
  assert.ok(chartHtml.includes('chart-block'), '信封 chart 产出图表块骨架');
  assert.ok(chartHtml.includes('data-chart-input="envelope"'), '信封输入模式标记');
  assert.ok(chartHtml.includes('data-chart-state="pending"'));
  assert.ok(chartHtml.includes('&quot;type&quot;:&quot;chart&quot;'), '源码以转义形态保存（chart-renderer 读取还原）');

  // 信封 stat → 同步可信 HTML
  const statHtml = markdownRenderer.renderMessage(
    '```component\n{"type":"stat","columns":["指标","值"],"rows":[["词汇量","214"]]}\n```',
  );
  assert.ok(statHtml.includes('stat-card-block'));
  assert.ok(statHtml.includes('214'));

  // 信封 insight → 关键见解卡
  const insightHtml = markdownRenderer.renderMessage(
    '```component\n{"type":"insight","source":"IDC 2026","columns":["洞察","证据","来源","置信度"],"rows":[["需求回升","出货量 +18%","idc.example.com","高"]]}\n```',
  );
  assert.ok(insightHtml.includes('component-insight-block'), 'insight 组件渲染');
  assert.ok(insightHtml.includes('ins-claim'), 'insight 断言在场');
  assert.ok(insightHtml.includes('IDC 2026'), 'insight 来源脚注在场');

  // 信封 chart 带 source → 图表块下方渲染来源脚注
  const chartWithSource = markdownRenderer.renderMessage(
    '```component\n{"type":"chart","source":"统计局 2026","columns":["日期","值"],"rows":[["周一",1],["周二",2]]}\n```',
  );
  assert.ok(chartWithSource.includes('component-block-source'), '图表来源脚注在场');
  assert.ok(chartWithSource.includes('统计局 2026'), '图表来源内容在场');

  // 信封解析失败 → 普通代码块降级（源码可见）
  const bad = markdownRenderer.renderMessage('```component\n{"type":"chart", not json\n```');
  assert.ok(bad.includes('code-block-wrapper'), '失败降级为代码块');
  assert.ok(bad.includes('COMPONENT'), '语言标签可见');

  // legacy 围栏兼容：历史消息继续渲染
  const legacyChart = markdownRenderer.renderMessage(
    '```echarts\n{"title":{"text":"旧图"},"xAxis":{"type":"category","data":["a"]},"series":[{"type":"bar","data":[1]}]}\n```',
  );
  assert.ok(legacyChart.includes('chart-block'));
  assert.ok(legacyChart.includes('data-chart-input="option"'), 'legacy 路径标记');

  const legacyStat = markdownRenderer.renderMessage(
    '```stat-card\n{"items":[{"label":"旧卡","value":"42"}]}\n```',
  );
  assert.ok(legacyStat.includes('stat-card-block'), 'legacy stat-card 兼容');

  // 原生围栏
  const mermaidHtml = markdownRenderer.renderMessage('```mermaid\nflowchart LR\nA-->B\n```');
  assert.ok(mermaidHtml.includes('diagram-block'), 'mermaid 原生围栏不受影响');

  const diffHtml = markdownRenderer.renderMessage('```diff\n+ 新增行\n- 删除行\n```');
  assert.ok(diffHtml.includes('diff-block'), 'diff 原生围栏渲染');

  // 信封 table 不被 wrapTables 二次包裹（无 table-block 工具栏注入）
  const tableHtml = markdownRenderer.renderMessage(
    '```component\n{"type":"table","columns":["a","b"],"rows":[["x",1],["y",2]]}\n```',
  );
  assert.ok(tableHtml.includes('component-data-table'));
  assert.ok(!tableHtml.includes('class="table-block"'), 'wrapTables 不得包裹组件表格');
  assert.ok(!tableHtml.includes('table-scroll-wrapper'), '组件表格不注入 Markdown 表格工具栏');

  // Markdown 普通表格仍走工具栏包裹（既有行为不回归）
  const mdTable = markdownRenderer.renderMessage('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.ok(mdTable.includes('table-block'), 'Markdown 表格工具栏行为保持');

  // 开关：enableRichCharts=false 时信封回落代码块
  const disabled = markdownRenderer.renderMessage(
    '```component\n{"type":"stat","columns":["a","b"],"rows":[["x","1"]]}\n```',
    { enableRichCharts: false },
  );
  assert.ok(disabled.includes('code-block-wrapper'), '关闭开关时信封降级代码块');
  assert.ok(!disabled.includes('stat-card-block'));
}

console.log('[chat-ui] Rich components: registry / prompt / envelope / chart derivation / sync blocks / fence dispatch passed.');
