/**
 * 数据通道治理 + xlsx 数据源混排契约测试
 *
 * 覆盖三块：
 *   1. data-ref-store 治理能力：
 *      - dedupe：按 by 字段去重（顺序稳定/统计准确/缺字段行保守保留/字段并集
 *        校验/形态混用拒绝/单批次无重复不产生新批次/整行去重）；
 *      - extract：信封响应按点分路径提取列表（路径不存在回显可用字段/非数组
 *        目标拒绝/数组下标路径/源批次非破坏保留）；
 *      - merge 经共享 collectRowParts 重构后错误文案不回归；
 *   2. data_ref_tool 动作契约：action 枚举含 extract/dedupe、参数防御
 *      （refs 形状/trim、by、path）、统计回传（stats）、无重复不建新批次的
 *      no-change 语义、单值（信封）批次 info 引导指向 extract；
 *   3. xlsx_tool 数据源统一：
 *      - create_from_data 混排（dataRef 表 + 手写公式汇总表）一次生成；
 *      - create 支持 dataRef 表（复杂工作簿一站式）；
 *      - 单表数据来源二选一、create_from_data 至少一个 dataRef 表、
 *        fields 仅对 dataRef 有效、空表拒绝、typo 字段拒绝（回归）；
 *      - 跨 action 参数互斥（markdown↔sheets）、records 拒绝
 *        firstRowAsHeader、null 工作表精准报错；
 *      - extract 路径规范化（trim/空段拒绝/下标纯数字）；
 *      - openaiSchema 已声明 dataRef/fields（模型可见的数据源契约）。
 *
 * 运行：由 tools.test.ts 末尾动态引入（chrome 全局桩已就位）。
 */

import assert from 'node:assert/strict';

import { dataRefStore } from '../../utils/data-ref-store';
import { dataRefTool } from '../../tools/data/data-ref-tool';
import { xlsxTool } from '../../tools/office/xlsx-tool';

/** 工具结果正文文本（content[0].text；错误结果即错误消息本身） */
const textOf = (r: { content?: Array<{ type: string; text?: string }>; error?: string }): string =>
  r.content?.[0]?.text ?? r.error ?? '';

/** 工具结果数据载荷（成功结果的 data，错误结果为空对象） */
const dataOf = (r: { data?: Record<string, unknown> }): Record<string, unknown> =>
  r.data ?? {};

// ==================== 1. data-ref-store：dedupe ====================

await dataRefStore.remove('all');

// 1.1 按 by 字段跨批次去重：顺序稳定、统计准确
{
  const p1 = await dataRefStore.save(
    [{ id: 'a', v: 1 }, { id: 'b', v: 2 }],
    '页1',
  );
  const p2 = await dataRefStore.save(
    [{ id: 'b', v: 2 }, { id: 'c', v: 3 }],
    '页2',
  );
  assert.ok(p1.ok && p2.ok, '前置批次保存成功');

  const result = await dataRefStore.dedupe(
    [p1.meta.id, p2.meta.id],
    ['id'],
    '去重',
  );
  assert.ok(result.ok, '跨批次按 id 去重成功');
  if (result.ok) {
    assert.equal(result.originalRows, 4, '原始 4 行');
    assert.equal(result.removed, 1, '删除 1 条重复');
    assert.equal(result.uniqueRows, 3, '保留 3 行');
    assert.equal(result.keptWithoutKey, 0, '无缺字段行');
    assert.equal(result.meta.rowCount, 3, '新批次行数 3');
    const entry = await dataRefStore.get(result.meta.id);
    assert.ok(entry, '新批次可读回');
    const rows = JSON.parse(entry!.json) as Array<{ id: string }>;
    assert.deepEqual(
      rows.map(r => r.id),
      ['a', 'b', 'c'],
      '保留首次出现且顺序稳定',
    );
  }
}

// 1.2 整行去重（省略 by）：matrix 形态
{
  await dataRefStore.remove('all');
  const m1 = await dataRefStore.save([[1, 2], [3, 4]]);
  const m2 = await dataRefStore.save([[3, 4], [5, 6]]);
  assert.ok(m1.ok && m2.ok);
  const result = await dataRefStore.dedupe([m1.meta.id, m2.meta.id]);
  assert.ok(result.ok, 'matrix 整行去重成功');
  if (result.ok) {
    assert.equal(result.removed, 1, 'matrix 删除 1 条重复');
    assert.equal(result.uniqueRows, 3, 'matrix 保留 3 行');
    assert.equal(result.meta.kind, 'matrix', '形态保持 matrix');
  }
}

// 1.3 by 字段不存在：拒绝并回显实际字段（与 xlsx fields 同口径）
{
  await dataRefStore.remove('all');
  const batch = await dataRefStore.save([{ id: 1, name: 'x' }]);
  assert.ok(batch.ok);
  const bad = await dataRefStore.dedupe([batch.meta.id], ['idd']);
  assert.equal(bad.ok, false, '拼错的 by 字段被拒绝');
  if (!bad.ok) {
    assert.ok(bad.reason.includes('不在批次字段列表'), '错误提示含字段校验语义', bad.reason);
    assert.ok(bad.reason.includes('id'), '错误提示回显实际字段', bad.reason);
  }
}

// 1.4 by 仅适用对象数组：matrix 拒绝
{
  await dataRefStore.remove('all');
  const m = await dataRefStore.save([[1], [1]]);
  assert.ok(m.ok);
  const bad = await dataRefStore.dedupe([m.meta.id], ['id']);
  assert.equal(bad.ok, false, 'matrix + by 被拒绝');
  if (!bad.ok) {
    assert.ok(bad.reason.includes('仅适用于对象数组'), '错误可读', bad.reason);
  }
}

// 1.5 形态混用拒绝（共享 collectRowParts 后文案不回归）
{
  await dataRefStore.remove('all');
  const r1 = await dataRefStore.save([{ a: 1 }]);
  const r2 = await dataRefStore.save([[1, 2]]);
  assert.ok(r1.ok && r2.ok);
  const mixed = await dataRefStore.dedupe([r1.meta.id, r2.meta.id]);
  assert.equal(mixed.ok, false, '形态混用被拒绝');
  if (!mixed.ok) {
    assert.ok(mixed.reason.includes('形态不一致'), 'dedupe 形态错误文案与 merge 同源', mixed.reason);
  }
  const missing = await dataRefStore.dedupe(['zzzzzzzz']);
  assert.equal(missing.ok, false, '缺失引用被拒绝');
  if (!missing.ok) {
    assert.ok(missing.reason.includes('不存在或已过期'), '缺失引用错误不回归', missing.reason);
  }
  // merge 重构后的回归断言（原有契约）
  const merged = await dataRefStore.merge(['zzzzzzzz']);
  assert.equal(merged.ok, false, 'merge 缺失引用仍被拒绝');
  if (!merged.ok) {
    assert.ok(merged.reason.includes('不存在或已过期'), 'merge 缺失引用文案不回归', merged.reason);
  }
}

// 1.6 缺 by 字段的行保守保留：绝不因键缺失误删
{
  await dataRefStore.remove('all');
  const batch = await dataRefStore.save([
    { id: 'a', v: 1 },
    { v: 2 }, // 缺 id
    { v: 2 }, // 缺 id 且内容与上一行相同——仍保留（无法证明重复）
    { id: 'a', v: 9 }, // 与首行同 id → 删除
  ]);
  assert.ok(batch.ok);
  const result = await dataRefStore.dedupe([batch.meta.id], ['id']);
  assert.ok(result.ok, '含缺字段行的去重成功');
  if (result.ok) {
    assert.equal(result.removed, 1, '仅删除可证明的重复');
    assert.equal(result.keptWithoutKey, 2, '两行缺 id 被保留');
    assert.equal(result.uniqueRows, 3, '保留 3 行');
    assert.notEqual(result.meta.id, batch.meta.id, '有删除时新建了批次');
  }
}

// 1.7 单批次无重复：no-change（不产生新批次，meta 原样返回）
{
  await dataRefStore.remove('all');
  const batch = await dataRefStore.save([{ id: 1 }, { id: 2 }]);
  assert.ok(batch.ok);
  const before = (await dataRefStore.list()).length;
  const result = await dataRefStore.dedupe([batch.meta.id], ['id']);
  assert.ok(result.ok, '无重复时仍返回成功');
  if (result.ok) {
    assert.equal(result.removed, 0, '删除数为 0');
    assert.equal(result.meta.id, batch.meta.id, 'meta 原样返回');
    assert.equal(result.originalRows, 2, '统计原始行数');
    assert.equal(result.uniqueRows, 2, '统计保留行数');
  }
  const after = (await dataRefStore.list()).length;
  assert.equal(after, before, 'no-change 不产生新批次');
}

// 1.8 by 参数防御（用有效 ref，确保走到 by 校验而非引用校验）
{
  await dataRefStore.remove('all');
  const batch = await dataRefStore.save([{ id: 1 }]);
  assert.ok(batch.ok);
  const badBy = await dataRefStore.dedupe([batch.meta.id], [] as string[]);
  assert.equal(badBy.ok, false, '空 by 数组被拒绝');
  if (!badBy.ok) assert.ok(badBy.reason.includes('by 必须'), 'by 错误可读', badBy.reason);
  // 错误优先级：by 形状错误先于引用存在性错误（参数错误不被数据错误掩盖）
  const precedence = await dataRefStore.dedupe(['zzzzzzzz'], [] as string[]);
  assert.equal(precedence.ok, false, '非法 by + 非法 ref 组合被拒绝');
  if (!precedence.ok) {
    assert.ok(precedence.reason.includes('by 必须'), 'by 形状错误优先报出', precedence.reason);
  }
}

// ==================== 2. data-ref-store：extract ====================

await dataRefStore.remove('all');

// 2.1 信封响应按路径提取列表（capture 链路的核心场景）
{
  const envelope = await dataRefStore.save(
    { code: 0, data: { items: [{ id: 1 }, { id: 2 }], cursor: 'x' } },
    '网络响应',
  );
  assert.ok(envelope.ok, '信封批次保存成功');
  const extracted = await dataRefStore.extract(envelope.meta.id, 'data.items');
  assert.ok(extracted.ok, '按 data.items 提取成功');
  if (extracted.ok) {
    assert.equal(extracted.meta.kind, 'records', '提取结果为 records');
    assert.equal(extracted.meta.rowCount, 2, '提取 2 行');
    const source = await dataRefStore.get(envelope.meta.id);
    assert.ok(source, '源批次非破坏保留');
  }
}

// 2.2 路径含数组下标
{
  await dataRefStore.remove('all');
  const nested = await dataRefStore.save({ pages: [[{ v: 1 }], [{ v: 2 }, { v: 3 }]] });
  assert.ok(nested.ok);
  const extracted = await dataRefStore.extract(nested.meta.id, 'pages.1');
  assert.ok(extracted.ok, '数组下标路径提取成功');
  if (extracted.ok) {
    assert.equal(extracted.meta.rowCount, 2, '提取第 2 页的 2 行');
  }
}

// 2.3 路径不存在：回显该层可用字段（模型自助修正）
{
  await dataRefStore.remove('all');
  const envelope = await dataRefStore.save({ data: { list: [] } });
  assert.ok(envelope.ok);
  const bad = await dataRefStore.extract(envelope.meta.id, 'data.items');
  assert.equal(bad.ok, false, '错误路径被拒绝');
  if (!bad.ok) {
    assert.ok(bad.reason.includes('该层可用字段'), '错误回显可用字段', bad.reason);
    assert.ok(bad.reason.includes('list'), '回显包含实际字段名', bad.reason);
  }
}

// 2.4 非数组目标拒绝
{
  await dataRefStore.remove('all');
  const scalar = await dataRefStore.save({ data: { total: 42 } });
  assert.ok(scalar.ok);
  const bad = await dataRefStore.extract(scalar.meta.id, 'data.total');
  assert.equal(bad.ok, false, '非数组目标被拒绝');
  if (!bad.ok) assert.ok(bad.reason.includes('只接受数组'), '错误可读', bad.reason);
}

// 2.5 参数防御：非法 ref / path
{
  const noRef = await dataRefStore.extract('zzzzzzzz', 'a.b');
  assert.equal(noRef.ok, false, '不存在的引用被拒绝');
  const noPath = await dataRefStore.extract('zzzzzzzz', '');
  assert.equal(noPath.ok, false, '空路径被拒绝');
  if (!noPath.ok) assert.ok(noPath.reason.includes('path'), 'path 错误可读', noPath.reason);
}

// 2.6 路径规范化与严格分段：整体 trim 生效、空段显式拒绝、下标须纯数字
{
  await dataRefStore.remove('all');
  const envelope = await dataRefStore.save({ data: { items: [{ id: 1 }] } });
  assert.ok(envelope.ok);
  const padded = await dataRefStore.extract(envelope.meta.id, '  data.items  ');
  assert.ok(padded.ok, '首尾空白被规范化后提取成功');
  if (padded.ok) assert.equal(padded.meta.rowCount, 1, '规范化路径提取 1 行');

  for (const badPath of ['data..items', 'data.items.', '.data.items']) {
    const bad = await dataRefStore.extract(envelope.meta.id, badPath);
    assert.equal(bad.ok, false, `空段路径 "${badPath}" 被拒绝`);
    if (!bad.ok) assert.ok(bad.reason.includes('空段'), '错误说明空段', bad.reason);
  }
}

// 2.7 数组下标严格校验：非纯数字与越界分别报出可定位原因
{
  await dataRefStore.remove('all');
  const nested = await dataRefStore.save({ pages: [[{ v: 1 }]] });
  assert.ok(nested.ok);
  const scientific = await dataRefStore.extract(nested.meta.id, 'pages.1e0');
  assert.equal(scientific.ok, false, '"1e0" 不被接受为下标');
  if (!scientific.ok) assert.ok(scientific.reason.includes('纯数字'), '错误说明下标格式', scientific.reason);
  const outOfRange = await dataRefStore.extract(nested.meta.id, 'pages.9');
  assert.equal(outOfRange.ok, false, '越界下标被拒绝');
  if (!outOfRange.ok) assert.ok(outOfRange.reason.includes('越界'), '错误说明越界', outOfRange.reason);
}

// ==================== 3. data_ref_tool：动作契约 ====================

// 3.1 Schema：action 枚举与参数声明完整
{
  const schema = dataRefTool.openaiSchema.function;
  const actionProp = schema.parameters.properties?.action as { enum?: string[] };
  assert.ok(Array.isArray(actionProp.enum), 'action 枚举存在');
  assert.ok(actionProp.enum!.includes('extract'), '枚举含 extract');
  assert.ok(actionProp.enum!.includes('dedupe'), '枚举含 dedupe');
  const props = schema.parameters.properties as Record<string, unknown>;
  assert.ok(props.path, '声明 path 参数');
  assert.ok(props.by, '声明 by 参数');
}

// 3.2 未知 action 错误列出新动作
{
  const bad = await dataRefTool.execute({ action: 'dedupeX' });
  assert.equal(bad.success, false, '未知 action 被拒绝');
  assert.ok(String(bad.error).includes('dedupe'), '错误回显可用动作含 dedupe', bad.error);
}

// 3.3 dedupe：参数防御
{
  const noRefs = await dataRefTool.execute({ action: 'dedupe' });
  assert.equal(noRefs.success, false, '缺 refs 被拒绝');
  assert.ok(String(noRefs.error).includes('refs'), '错误引导 refs', noRefs.error);

  const badRefs = await dataRefTool.execute({ action: 'dedupe', refs: [123] });
  assert.equal(badRefs.success, false, '非字符串 refs 被拒绝');

  const badBy = await dataRefTool.execute({ action: 'dedupe', refs: ['zzzzzzzz'], by: 'id' });
  assert.equal(badBy.success, false, '非数组 by 被拒绝');
  assert.ok(String(badBy.error).includes('by'), '错误引导 by', badBy.error);
}

// 3.4 dedupe：成功路径与统计回传
{
  await dataRefStore.remove('all');
  const p1 = await dataRefStore.save([{ id: 'x' }, { id: 'y' }]);
  const p2 = await dataRefStore.save([{ id: 'y' }, { id: 'z' }]);
  assert.ok(p1.ok && p2.ok);
  const result = await dataRefTool.execute({
    action: 'dedupe',
    refs: [p1.meta.id, p2.meta.id],
    by: ['id'],
    label: '全部-去重',
  });
  assert.equal(result.success, true, 'dedupe 执行成功', result.error);
  const stats = dataOf(result).stats as Record<string, number> | undefined;
  assert.ok(stats, '响应携带 stats');
  assert.equal(stats!.removed, 1, 'stats.removed=1');
  assert.equal(stats!.originalRows, 4, 'stats.originalRows=4');
  assert.equal(stats!.uniqueRows, 3, 'stats.uniqueRows=3');
  assert.equal(dataOf(result).created, true, 'created=true');
  assert.ok(textOf(result).includes('去重完成'), '正文含完成提示', textOf(result));
}

// 3.5 dedupe：单批次无重复 no-change 语义
{
  await dataRefStore.remove('all');
  const batch = await dataRefStore.save([{ id: 1 }]);
  assert.ok(batch.ok);
  const result = await dataRefTool.execute({ action: 'dedupe', refs: [batch.meta.id], by: ['id'] });
  assert.equal(result.success, true, 'no-change 仍成功', result.error);
  assert.equal(dataOf(result).created, false, 'created=false');
  assert.ok(textOf(result).includes('未发现重复'), '正文说明未产生新批次', textOf(result));
}

// 3.6 extract：参数防御 + 成功路径
{
  const noPath = await dataRefTool.execute({ action: 'extract', ref: 'zzzzzzzz' });
  assert.equal(noPath.success, false, '缺 path 被拒绝');
  assert.ok(String(noPath.error).includes('path'), '错误引导 path', noPath.error);

  await dataRefStore.remove('all');
  const envelope = await dataRefStore.save({ data: { rows: [{ k: 1 }] } });
  assert.ok(envelope.ok);
  const result = await dataRefTool.execute({
    action: 'extract',
    ref: envelope.meta.id,
    path: 'data.rows',
  });
  assert.equal(result.success, true, 'extract 执行成功', result.error);
  const ref = dataOf(result).ref as { id?: string; rowCount?: number } | undefined;
  assert.ok(ref?.id, '响应携带新批次');
  assert.equal(ref!.rowCount, 1, '新批次 1 行');
  assert.equal(dataOf(result).sourceRef, envelope.meta.id, '回显源批次');
  assert.ok(textOf(result).includes('提取完成'), '正文含完成提示', textOf(result));
}

// 3.7 merge：与 dedupe 同源的 refs 形状校验 + 自动 trim
{
  const noRefs = await dataRefTool.execute({ action: 'merge' });
  assert.equal(noRefs.success, false, 'merge 缺 refs 被拒绝');
  assert.ok(String(noRefs.error).includes('refs'), '错误引导 refs', noRefs.error);

  const badRefs = await dataRefTool.execute({ action: 'merge', refs: [123] });
  assert.equal(badRefs.success, false, 'merge 非字符串 refs 被拒绝');
  assert.ok(String(badRefs.error).includes('字符串'), '错误说明元素类型', badRefs.error);

  await dataRefStore.remove('all');
  const p1 = await dataRefStore.save([{ id: 1 }]);
  const p2 = await dataRefStore.save([{ id: 2 }]);
  assert.ok(p1.ok && p2.ok);
  const padded = await dataRefTool.execute({
    action: 'merge',
    refs: [`  ${p1.meta.id}  `, p2.meta.id],
  });
  assert.equal(padded.success, true, '带空白的 refs 被 trim 后合并成功', padded.error);
  const mergedRef = dataOf(padded).ref as { rowCount?: number } | undefined;
  assert.equal(mergedRef?.rowCount, 2, '合并结果 2 行');
}

// 3.8 info：单值（信封）批次的引导指向 extract 而不是「重新抓取」
{
  await dataRefStore.remove('all');
  const envelope = await dataRefStore.save({ data: { items: [] } });
  assert.ok(envelope.ok);
  const result = await dataRefTool.execute({ action: 'info', ref: envelope.meta.id });
  assert.equal(result.success, true, 'info 执行成功', result.error);
  const guide = dataOf(result).guide as string | undefined;
  assert.ok(guide && guide.includes('extract'), '信封批次引导使用 extract', guide);
}

// ==================== 4. xlsx_tool：数据源统一 ====================

await dataRefStore.remove('all');
const batch = await dataRefStore.save(
  [{ title: '商品A', price: 9.9 }, { title: '商品B', price: 19.9 }],
  'SKU批次',
);
assert.ok(batch.ok, 'xlsx 前置批次保存成功');
const refId = batch.meta.id;

// 4.1 openaiSchema 已声明 dataRef/fields（模型可见的数据源契约）
{
  const schema = xlsxTool.openaiSchema.function;
  const sheetsProp = schema.parameters.properties?.sheets as {
    items?: { properties?: Record<string, unknown> };
  };
  assert.ok(sheetsProp.items?.properties?.dataRef, 'sheets 声明 dataRef');
  assert.ok(sheetsProp.items?.properties?.fields, 'sheets 声明 fields');
}

// 4.2 create_from_data 混排：dataRef 数据表 + 手写公式汇总表（一次生成）
{
  const result = await xlsxTool.execute({
    action: 'create_from_data',
    filename: '混排导出测试',
    sheets: [
      { name: '数据', dataRef: refId, fields: ['title', 'price'], headers: ['商品名', '价格'] },
      { name: '汇总', rows: [['合计'], [{ formula: 'SUM(数据!B2:B3)' }]] },
    ],
  });
  assert.equal(result.success, true, '混排工作簿生成成功', result.error);
  const sheets = dataOf(result).sheets as Array<{ name: string; rowCount: number }>;
  assert.equal(sheets.length, 2, '两张工作表');
  assert.equal(sheets[0].name, '数据', '数据表在前');
  assert.equal(sheets[0].rowCount, 3, '数据表 1 行表头 + 2 行数据（rowCount 为物理行数）');
  assert.equal(sheets[1].name, '汇总', '汇总表在后');
  const marker = (dataOf(result).file as { marker?: string } | undefined)?.marker;
  assert.ok(marker && /^\[file:[^|]+\|.+\.xlsx\]$/.test(marker), '文件标记格式正确', marker);
}

// 4.3 create 也支持 dataRef 表（复杂工作簿一站式）
{
  const result = await xlsxTool.execute({
    action: 'create',
    filename: 'create带dataRef测试',
    sheet: { name: '批次', dataRef: refId, zebra: true },
  });
  assert.equal(result.success, true, 'create + dataRef 成功', result.error);
  const sheets = dataOf(result).sheets as Array<{ rowCount: number }>;
  assert.equal(sheets.length, 1, '单表');
  assert.equal(sheets[0].rowCount, 3, 'dataRef 表默认带表头：1 表头 + 2 数据行');
}

// 4.4 单表数据来源二选一
{
  const result = await xlsxTool.execute({
    action: 'create',
    filename: '冲突来源测试',
    sheet: { name: '冲突', dataRef: refId, rows: [['x']] },
  });
  assert.equal(result.success, false, 'dataRef+rows 同表被拒绝');
  assert.ok(String(result.error).includes('二选一'), '错误说明二选一', result.error);
}

// 4.5 create_from_data 至少一个 dataRef 表
{
  const result = await xlsxTool.execute({
    action: 'create_from_data',
    filename: '纯手写测试',
    sheet: { name: '手写', rows: [['a'], ['b']] },
  });
  assert.equal(result.success, false, '纯手写 create_from_data 被拒绝');
  assert.ok(String(result.error).includes('dataRef'), '错误引导 dataRef', result.error);
}

// 4.6 fields 仅对 dataRef 有效（拒绝静默忽略）
{
  const result = await xlsxTool.execute({
    action: 'create',
    filename: '误用fields测试',
    sheet: { name: '手写', rows: [['a']], fields: ['x'] },
  });
  assert.equal(result.success, false, '手写表的 fields 被拒绝');
  assert.ok(String(result.error).includes('fields'), '错误说明 fields 语义', result.error);
}

// 4.7 dataRef 表允许 cells 叠加（数据区外注释）
{
  const result = await xlsxTool.execute({
    action: 'create_from_data',
    filename: 'cells叠加测试',
    sheets: [
      {
        name: '数据',
        dataRef: refId,
        cells: [{ ref: 'D1', v: '生成于测试' }],
      },
    ],
  });
  assert.equal(result.success, true, 'dataRef + cells 叠加成功', result.error);
}

// 4.8 typo 字段拒绝（回归：dataRef 字段硬校验仍在）
{
  const result = await xlsxTool.execute({
    action: 'create_from_data',
    filename: 'typo字段测试',
    sheet: { name: '数据', dataRef: refId, fields: ['titel'] },
  });
  assert.equal(result.success, false, '拼错字段被拒绝');
  assert.ok(String(result.error).includes('不在批次字段列表'), '错误回显字段校验', result.error);
}

// 4.9 空表拒绝（无 rows/dataRef/cells/headers）
{
  const result = await xlsxTool.execute({
    action: 'create',
    filename: '空表测试',
    sheet: { name: '空表' },
  });
  assert.equal(result.success, false, '空表被拒绝');
  assert.ok(String(result.error).includes('没有任何内容'), '错误说明内容缺失', result.error);
}

// 4.10 dataRef 引用不存在：可操作错误
{
  const result = await xlsxTool.execute({
    action: 'create_from_data',
    filename: '失效引用测试',
    sheet: { name: '数据', dataRef: 'zzzzzzzz' },
  });
  assert.equal(result.success, false, '失效 dataRef 被拒绝');
  assert.ok(String(result.error).includes('不存在或已过期'), '错误可自助恢复', result.error);
}

// 4.11 跨 action 参数互斥：markdown 只属于 create_from_markdown
{
  const withMarkdown = await xlsxTool.execute({
    action: 'create',
    filename: '误传markdown',
    markdown: '| a |\n| - |\n| 1 |',
    sheet: { name: '表', rows: [['x']] },
  });
  assert.equal(withMarkdown.success, false, 'create + markdown 被拒绝');
  assert.ok(String(withMarkdown.error).includes('仅适用于'), '错误说明参数归属', withMarkdown.error);

  const sheetsOnMarkdown = await xlsxTool.execute({
    action: 'create_from_markdown',
    filename: '误传sheets',
    markdown: '| a |\n| - |\n| 1 |',
    sheets: [{ name: '表', rows: [['x']] }],
  });
  assert.equal(sheetsOnMarkdown.success, false, 'create_from_markdown + sheets 被拒绝');
  assert.ok(String(sheetsOnMarkdown.error).includes('仅适用于'), '错误说明参数归属', sheetsOnMarkdown.error);
}

// 4.12 records 批次拒绝 firstRowAsHeader（其恒定自动生成表头，传了必被忽略）
{
  const result = await xlsxTool.execute({
    action: 'create_from_data',
    filename: '误传firstRowAsHeader',
    sheet: { name: '数据', dataRef: refId, firstRowAsHeader: true },
  });
  assert.equal(result.success, false, 'records + firstRowAsHeader 被拒绝');
  assert.ok(String(result.error).includes('firstRowAsHeader'), '错误定位到参数', result.error);
}

// 4.13 null 工作表报错文案精确（不显示成含混的 object）
{
  const result = await xlsxTool.execute({
    action: 'create',
    filename: 'null工作表',
    sheets: [null],
  });
  assert.equal(result.success, false, 'null 工作表被拒绝');
  assert.ok(String(result.error).includes('null'), '错误回显 null', result.error);
}

await dataRefStore.remove('all');
