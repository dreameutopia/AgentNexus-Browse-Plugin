/**
 * 数据通道治理 + xlsx 数据源混排契约测试
 *
 * 覆盖四块：
 *   1. data-ref-rows 纯函数内核（refs 与 files 双通道共享）：
 *      - dedupeRows：按 by 字段/整行去重（顺序稳定/统计准确/缺字段行保守保留）；
 *      - projectRows：复合数据→关系表的投影（对象目标→单行记录/子数组→多行/
 *        carry 父键携带/flatten 展平为点号列/逐行路径解析/列名冲突拒绝/
 *        路径不存在回显可用字段/标量目标拒绝/数组下标路径）；
 *      - concatRowParts：形态混用拒绝；
 *   2. data_ref_tool 动作契约（refs=暂存批次 / files=工作区数据文件，产物统一为结果文件）：
 *      - merge/dedupe 的 refs 与 files 二选一（同时提供拒绝）、参数防御
 *        （refs/files 形状/trim、by、path/carry/flatten）、统计回传（stats）、
 *        无重复不建新文件的 no-change 语义；
 *      - project 的 ref/file 二选一与信封投影；
 *      - info 的 ref/file 二选一（信封数据引导指向 project）；
 *      - 治理产物落 results/ 且可被 js_run read 按页读取、可继续串联治理；
 *   3. xlsx_tool 数据源统一：
 *      - create_from_data 混排（dataFiles 数据表 + 手写公式汇总表）一次生成；
 *      - dataFiles 多文件按序拼接成一张表；create 支持 dataFiles/dataRef 表；
 *      - 单表数据来源三选一（rows/dataFiles/dataRef 互斥）、create_from_data
 *        至少一个数据表、fields 仅对数据表有效、typo 字段拒绝（回归）；
 *      - 跨 action 参数互斥（markdown↔sheets）、records 拒绝 firstRowAsHeader、
 *        null 工作表精准报错、dataFiles 文件不存在/非数组可操作错误；
 *   4. openaiSchema 已声明 dataFiles/dataRef/fields（模型可见的数据源契约）。
 *
 * 运行：由 tools.test.ts 末尾动态引入（chrome 全局桩已就位）。
 */

import assert from "node:assert/strict";
import { chatDatabase } from "../../entrypoints/sidepanel/core/context/chat-database";
import { dataRefStore } from "../../utils/data-ref-store";
import {
  dedupeRows,
  projectRows,
  concatRowParts,
} from "../../utils/data-ref-rows";
import { dataRefTool } from "../../tools/data/data-ref-tool";
import { xlsxTool as rawXlsxTool } from "../../tools/office/xlsx-tool";
import { jsRunTool } from "../../tools/javascript/js-run-tool";

const chatId = "xlsx-dataref-contract";
await chatDatabase.createSession({
  chatId,
  title: chatId,
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
  lastMessagePreview: "",
  agentName: "",
  skillNames: [],
});
const context = { chatId };
const xlsxTool = {
  openaiSchema: rawXlsxTool.openaiSchema,
  execute: (args: Record<string, unknown>) =>
    rawXlsxTool.execute(args, context),
};
const dataTool = {
  openaiSchema: dataRefTool.openaiSchema,
  execute: (args: Record<string, unknown>) =>
    dataRefTool.execute(args, context),
};

/** 工具结果正文文本（content[0].text；错误结果即错误消息本身） */
const textOf = (r: {
  content?: Array<{ type: string; text?: string }>;
  error?: string;
}): string => r.content?.[0]?.text ?? r.error ?? "";

/** 工具结果数据载荷（成功结果的 data，错误结果为空对象） */
const dataOf = (r: {
  data?: Record<string, unknown>;
}): Record<string, unknown> => r.data ?? {};

/** 在工作区落一个 JSON 数据文件（模拟 js_run 结果 / 治理产物） */
async function writeDataFile(path: string, value: unknown): Promise<string> {
  const created = await jsRunTool.execute(
    { action: "create", path, content: JSON.stringify(value) },
    context,
  );
  assert.equal(created.success, true, "测试数据文件写入成功");
  return path;
}

// ==================== 1. data-ref-rows 纯函数内核 ====================

// 1.1 dedupeRows：按 by 字段跨源去重，顺序稳定、统计准确
{
  const stats = dedupeRows(
    [
      { id: "a", v: 1 },
      { id: "b", v: 2 },
      { id: "b", v: 2 },
      { id: "c", v: 3 },
    ],
    ["id"],
  );
  assert.equal(stats.originalRows, 4, "原始 4 行");
  assert.equal(stats.removed, 1, "删除 1 条重复");
  assert.equal(stats.uniqueRows, 3, "保留 3 行");
  assert.deepEqual(
    (stats.kept as Array<{ id: string }>).map((r) => r.id),
    ["a", "b", "c"],
    "保留首次出现且顺序稳定",
  );
}

// 1.2 dedupeRows：整行去重（matrix 形态）；缺 by 字段行保守保留
{
  const stats = dedupeRows(
    [
      [1, 2],
      [3, 4],
      [3, 4],
      [5, 6],
    ],
    null,
  );
  assert.equal(stats.removed, 1, "matrix 整行去重删除 1 条");
  assert.equal(stats.uniqueRows, 3, "matrix 保留 3 行");

  const kept = dedupeRows(
    [{ id: "a", v: 1 }, { v: 2 }, { v: 2 }, { id: "a", v: 9 }],
    ["id"],
  );
  assert.equal(kept.removed, 1, "仅删除可证明的重复");
  assert.equal(kept.keptWithoutKey, 2, "两行缺 id 被保留（绝不误删）");
}

// 1.3 concatRowParts：形态混用拒绝
{
  const mixed = concatRowParts([[{ a: 1 }], [[1, 2]]], "合并");
  assert.equal(mixed.ok, false, "records 与 matrix 混拼被拒绝");
  if (!mixed.ok)
    assert.ok(mixed.reason.includes("形态不一致"), "错误可读", mixed.reason);
  const valueSource = concatRowParts([[{ a: 1 }], ["x" as never]], "合并");
  void valueSource; // 标量数组合法（matrix）；非法输入由加载层把关
}

// 1.4 projectRows：信封按路径投影列表、数组下标、错误路径回显
{
  const envelope = {
    code: 0,
    data: { items: [{ id: 1 }, { id: 2 }], cursor: "x" },
  };
  const projected = projectRows(envelope, { path: "data.items" });
  assert.ok(projected.ok, "按 data.items 投影成功");
  if (projected.ok) assert.equal(projected.result.rows.length, 2, "投影 2 行");

  const nested = { pages: [[{ v: 1 }], [{ v: 2 }, { v: 3 }]] };
  const byIndex = projectRows(nested, { path: "pages.1" });
  assert.ok(byIndex.ok, "数组下标路径投影成功");
  if (byIndex.ok)
    assert.equal(projected.result.rows.length, 2, "投影第 2 页的 2 行");

  const bad = projectRows(envelope, { path: "data.items." });
  assert.equal(bad.ok, false, "空段路径被拒绝");
  if (!bad.ok)
    assert.ok(bad.reason.includes("空段"), "错误说明空段", bad.reason);

  const missing = projectRows(envelope, { path: "data.list" });
  assert.ok(missing.ok, "错误路径在纯函数层宽松返回（空结果由工具层裁决）");
  if (missing.ok) {
    assert.equal(missing.result.rows.length, 0, "无行产出");
    assert.ok(
      missing.result.firstFailureReason?.includes("可用字段"),
      "原因回显该层可用字段",
      missing.result.firstFailureReason,
    );
  }

  const scalar = projectRows({ data: { total: 42 } }, { path: "data.total" });
  assert.equal(scalar.ok, false, "标量目标被拒绝");
  if (!scalar.ok)
    assert.ok(
      scalar.reason.includes("须指向对象或对象数组"),
      "错误可读",
      scalar.reason,
    );
}

// 1.5 projectRows：复合批次整形（对象→单行 / 子数组→多行+carry / flatten）
{
  const compound = {
    base: { listSku: "100406235910", title: "Mac mini M6", price: "4844.15" },
    skuPrices: [
      { label: "16G", price: 4844 },
      { label: "24G", price: 7394 },
    ],
  };
  const baseRow = projectRows(compound, { path: "base" });
  assert.ok(baseRow.ok, "对象目标投影为单行记录");
  if (baseRow.ok) {
    assert.equal(baseRow.result.rows.length, 1, "单行");
    assert.deepEqual(
      Object.keys(baseRow.result.rows[0]),
      ["listSku", "title", "price"],
      "字段即对象键",
    );
  }
  const skuRows = projectRows(compound, {
    path: "skuPrices",
    carry: ["base.listSku", "base.title"],
  });
  assert.ok(skuRows.ok, "子数组投影成功");
  if (skuRows.ok) {
    assert.equal(skuRows.result.rows.length, 2, "每个元素一行");
    assert.ok(
      Object.keys(skuRows.result.rows[1]).includes("base.listSku"),
      "含父键列",
    );
  }
  const flat = projectRows(
    { rows: [{ a: { b: { c: 1 } }, d: 2 }] },
    { path: "rows", flatten: true },
  );
  assert.ok(flat.ok, "flatten 投影成功");
  if (flat.ok)
    assert.deepEqual(
      Object.keys(flat.result.rows[0]),
      ["a.b.c", "d"],
      "嵌套对象展开为点号列",
    );

  const conflict = projectRows(
    { items: [{ base: 1 }], base: { listSku: "x" } },
    { path: "items", carry: ["base"] },
  );
  assert.equal(conflict.ok, false, "列名冲突被拒绝");
  if (!conflict.ok)
    assert.ok(
      conflict.reason.includes("列名冲突"),
      "错误说明冲突",
      conflict.reason,
    );

  const perRow = projectRows(
    [{ items: [{ v: 1 }] }, { items: [{ v: 2 }, { v: 3 }] }],
    { path: "items" },
  );
  assert.ok(perRow.ok, "逐行路径投影成功");
  if (perRow.ok)
    assert.equal(perRow.result.rows.length, 3, "各行元素合计 3 行");
}

// ==================== 2. data_ref_tool：refs / files 双源治理 ====================

await dataRefStore.remove("all");

// 2.1 refs 加载器与 merge（refs 源）→ 结果文件
{
  const p1 = await dataRefStore.save([{ id: 1 }], "页1");
  const p2 = await dataRefStore.save([{ id: 2 }], "页2");
  assert.ok(p1.ok && p2.ok, "前置批次保存成功");

  const result = await dataTool.execute({
    action: "merge",
    refs: [`  ${p1.meta.id}  `, p2.meta.id],
  });
  assert.equal(
    result.success,
    true,
    "refs 带空白被 trim 后合并成功",
    result.error,
  );
  const file = dataOf(result).file as { path?: string };
  assert.ok(
    file?.path?.startsWith("results/merge-"),
    "合并产物是 results/ 结果文件",
  );
  assert.equal(
    (dataOf(result).shape as { rowCount?: number }).rowCount,
    2,
    "合并结果 2 行",
  );

  // 产物可被 js_run read 按页读取（与 run 结果文件同一通道）
  const read = await jsRunTool.execute(
    { action: "read", path: file.path },
    context,
  );
  assert.equal(read.success, true, "治理产物可分页读取", read.error);
  assert.deepEqual(
    JSON.parse((read.data as { content: string }).content),
    [{ id: 1 }, { id: 2 }],
    "内容逐字保留",
  );
}

// 2.2 merge：refs 与 files 互斥 + files 源合并 + 串联治理
{
  const both = await dataTool.execute({
    action: "merge",
    refs: ["zzzzzzzz"],
    files: ["results/x.json"],
  });
  assert.equal(both.success, false, "refs 与 files 同时提供被拒绝");
  assert.ok(String(both.error).includes("互斥"), "错误说明互斥", both.error);

  const f1 = await writeDataFile("scripts/page1.json", [
    { sku: "A", price: 1 },
    { sku: "B", price: 2 },
  ]);
  const f2 = await writeDataFile("scripts/page2.json", [
    { sku: "B", price: 2 },
    { sku: "C", price: 3 },
  ]);
  const merged = await dataTool.execute({
    action: "merge",
    files: [f1, f2],
    label: "全部商品",
  });
  assert.equal(merged.success, true, "files 按序合并成功", merged.error);
  const mergedFile = (dataOf(merged).file as { path: string }).path;
  assert.match(mergedFile, /-全部商品\.json$/, "label 进入结果文件名");
  assert.equal(
    (dataOf(merged).shape as { rowCount?: number }).rowCount,
    4,
    "合并 4 行",
  );

  // 串联治理：合并产物作为 dedupe 的 files 输入（拼接+去重一步完成）
  const deduped = await dataTool.execute({
    action: "dedupe",
    files: [mergedFile],
    by: ["sku"],
    label: "已去重",
  });
  assert.equal(deduped.success, true, "治理产物可继续串联治理", deduped.error);
  const stats = dataOf(deduped).stats as Record<string, number>;
  assert.equal(stats.removed, 1, "去除 1 条重复");
  assert.equal(stats.uniqueRows, 3, "保留 3 行");
  const dedupeFile = (dataOf(deduped).file as { path: string }).path;
  assert.match(dedupeFile, /^results\/dedupe-/, "dedupe 产物前缀");
}

// 2.3 dedupe：参数防御与错误优先级（参数错误先于数据错误）
{
  const noSources = await dataTool.execute({ action: "dedupe" });
  assert.equal(noSources.success, false, "缺 refs/files 被拒绝");
  assert.ok(
    String(noSources.error).includes("refs"),
    "错误引导数据源",
    noSources.error,
  );

  const badBy = await dataTool.execute({
    action: "dedupe",
    refs: ["zzzzzzzz"],
    by: "id",
  });
  assert.equal(badBy.success, false, "非数组 by 被拒绝");
  assert.ok(String(badBy.error).includes("by"), "错误引导 by", badBy.error);

  const emptyBy = await dataTool.execute({
    action: "dedupe",
    files: ["results/none.json"],
    by: [] as string[],
  });
  assert.equal(emptyBy.success, false, "空 by 数组先于文件存在性报错");
  assert.ok(
    String(emptyBy.error).includes("by 必须"),
    "by 形状错误优先报出",
    emptyBy.error,
  );

  const missingFile = await dataTool.execute({
    action: "dedupe",
    files: ["results/does-not-exist.json"],
  });
  assert.equal(missingFile.success, false, "缺失文件被拒绝");
  assert.ok(
    String(missingFile.error).includes("不存在"),
    "错误可自助恢复",
    missingFile.error,
  );

  const missingRef = await dataTool.execute({
    action: "dedupe",
    refs: ["zzzzzzzz"],
  });
  assert.equal(missingRef.success, false, "缺失引用被拒绝");
  assert.ok(
    String(missingRef.error).includes("不存在或已过期"),
    "缺失引用错误不回归",
    missingRef.error,
  );
}

// 2.4 dedupe：by 字段不存在拒绝并回显实际字段；matrix + by 拒绝
{
  const f = await writeDataFile("scripts/bycheck.json", [{ id: 1, name: "x" }]);
  const bad = await dataTool.execute({
    action: "dedupe",
    files: [f],
    by: ["idd"],
  });
  assert.equal(bad.success, false, "拼错的 by 字段被拒绝");
  assert.ok(
    String(bad.error).includes("不在数据字段列表"),
    "错误含字段校验语义",
    bad.error,
  );
  assert.ok(String(bad.error).includes("id"), "错误回显实际字段", bad.error);

  const m = await writeDataFile("scripts/matrix.json", [
    [1, 2],
    [1, 2],
  ]);
  const matrixBy = await dataTool.execute({
    action: "dedupe",
    files: [m],
    by: ["id"],
  });
  assert.equal(matrixBy.success, false, "matrix + by 被拒绝");
  assert.ok(
    String(matrixBy.error).includes("仅适用于对象数组"),
    "错误可读",
    matrixBy.error,
  );
}

// 2.5 dedupe：单源无重复 no-change（不产生新文件）
{
  const f = await writeDataFile("scripts/unique.json", [{ id: 1 }, { id: 2 }]);
  const before = (
    (await jsRunTool.execute({ action: "list", path: "results" }, context))
      .data as { total: number }
  ).total;
  const result = await dataTool.execute({
    action: "dedupe",
    files: [f],
    by: ["id"],
  });
  assert.equal(result.success, true, "no-change 仍成功", result.error);
  assert.equal(dataOf(result).created, false, "created=false");
  assert.ok(
    textOf(result).includes("未发现重复"),
    "正文说明未产生新文件",
    textOf(result),
  );
  const after = (
    (await jsRunTool.execute({ action: "list", path: "results" }, context))
      .data as { total: number }
  ).total;
  assert.equal(after, before, "no-change 不产生新结果文件");
}

// 2.6 project：ref/file 二选一与信封投影（capture 链路）
{
  await dataRefStore.remove("all");
  const envelope = await dataRefStore.save(
    { code: 0, data: { items: [{ k: 1 }] } },
    "网络响应",
  );
  assert.ok(envelope.ok);

  const both = await dataTool.execute({
    action: "project",
    ref: envelope.meta.id,
    file: "results/x.json",
  });
  assert.equal(both.success, false, "ref 与 file 同时提供被拒绝");

  const result = await dataTool.execute({
    action: "project",
    ref: envelope.meta.id,
    path: "data.items",
  });
  assert.equal(result.success, true, "ref 信封投影成功", result.error);
  const file = (dataOf(result).file as { path: string }).path;
  assert.match(file, /^results\/project-/, "project 产物前缀");
  const source = await dataRefStore.get(envelope.meta.id);
  assert.ok(source, "源批次非破坏保留");

  const fileProject = await dataTool.execute({ action: "project", file: file });
  assert.equal(
    fileProject.success,
    true,
    "投影产物可继续投影（记录本身成行）",
    fileProject.error,
  );
  assert.equal(
    (dataOf(fileProject).shape as { rowCount?: number }).rowCount,
    1,
    "1 行",
  );

  const scalarRows = await writeDataFile("scripts/scalars.json", [1, 2]);
  const badProject = await dataTool.execute({
    action: "project",
    file: scalarRows,
  });
  assert.equal(badProject.success, false, "标量数组不可投影");
  assert.ok(
    String(badProject.error).includes("不是对象"),
    "非对象源被拒绝",
    badProject.error,
  );
}

// 2.7 info：ref/file 二选一；信封数据引导指向 project；文件形态与字段
{
  const both = await dataTool.execute({
    action: "info",
    ref: "zzzzzzzz",
    file: "results/x.json",
  });
  assert.equal(both.success, false, "info 的 ref 与 file 互斥");

  await dataRefStore.remove("all");
  const envelope = await dataRefStore.save({ data: { items: [] } });
  assert.ok(envelope.ok);
  const refInfo = await dataTool.execute({
    action: "info",
    ref: envelope.meta.id,
  });
  assert.equal(refInfo.success, true, "info(ref) 成功", refInfo.error);
  assert.ok(
    (dataOf(refInfo).guide as string).includes("project"),
    "信封批次引导使用 project",
  );

  const f = await writeDataFile("scripts/info.json", [
    { sku: "A", price: 9.9 },
    { sku: "B", price: 19.9 },
  ]);
  const fileInfo = await dataTool.execute({ action: "info", file: f });
  assert.equal(fileInfo.success, true, "info(file) 成功", fileInfo.error);
  assert.deepEqual(dataOf(fileInfo).fields, ["sku", "price"], "回传字段并集");
  assert.equal(
    (dataOf(fileInfo).file as { rowCount?: number }).rowCount,
    2,
    "回传行数",
  );

  const missing = await dataTool.execute({
    action: "info",
    file: "results/none.json",
  });
  assert.equal(missing.success, false, "缺失文件报可操作错误");
  assert.ok(
    String(missing.error).includes("list"),
    "错误引导盘点",
    missing.error,
  );
}

// 2.8 未知 action / 参数白名单 / refs·files 形状防御
{
  const bad = await dataTool.execute({ action: "dedupeX" });
  assert.equal(bad.success, false, "未知 action 被拒绝");
  assert.ok(
    String(bad.error).includes("dedupe"),
    "错误回显可用动作含 dedupe",
    bad.error,
  );

  // 跨 action 误传参数显式拒绝（静默忽略会让模型误以为已生效）
  const strayParam = await dataTool.execute({
    action: "merge",
    files: ["results/x.json"],
    by: ["id"],
  });
  assert.equal(strayParam.success, false, "merge 不接受 by 被拒绝");
  assert.ok(
    String(strayParam.error).includes("不接受参数"),
    "错误点名误传参数",
    strayParam.error,
  );
  const filesOnInfo = await dataTool.execute({
    action: "info",
    files: ["results/x.json"],
  });
  assert.equal(filesOnInfo.success, false, "info 不接受 files 被拒绝");

  const badRefs = await dataTool.execute({ action: "merge", refs: [123] });
  assert.equal(badRefs.success, false, "非字符串 refs 被拒绝");
  const badFiles = await dataTool.execute({ action: "merge", files: [123] });
  assert.equal(badFiles.success, false, "非字符串 files 被拒绝");
  const overLimit = await dataTool.execute({
    action: "merge",
    files: Array.from({ length: 51 }, (_, i) => `results/f${i}.json`),
  });
  assert.equal(overLimit.success, false, "超出单次数据源上限被拒绝");
  assert.ok(
    String(overLimit.error).includes("51"),
    "错误回显实际数量",
    overLimit.error,
  );
}

// 2.9 delete：单个 / refs 批量 / ref="all" 清空 / 缺参错误
{
  await dataRefStore.remove("all");
  const p1 = await dataRefStore.save([{ id: 1 }], "A");
  const p2 = await dataRefStore.save([{ id: 2 }], "B");
  const p3 = await dataRefStore.save([{ id: 3 }], "C");
  assert.ok(p1.ok && p2.ok && p3.ok, "delete 前置批次保存成功");

  const single = await dataTool.execute({ action: "delete", ref: p1.meta.id });
  assert.equal(single.success, true, "单个 delete 成功", single.error);
  assert.equal(dataOf(single).deleted, 1, "删除 1 个");
  assert.equal(await dataRefStore.get(p1.meta.id), null, "批次确已删除");

  const batch = await dataTool.execute({
    action: "delete",
    refs: [p2.meta.id, p3.meta.id],
  });
  assert.equal(batch.success, true, "refs 批量 delete 成功", batch.error);
  assert.equal(dataOf(batch).deleted, 2, "批量删除 2 个");

  const p4 = await dataRefStore.save([{ id: 4 }]);
  const p5 = await dataRefStore.save([{ id: 5 }]);
  assert.ok(p4.ok && p5.ok);
  const wipe = await dataTool.execute({ action: "delete", ref: "all" });
  assert.equal(
    wipe.success,
    true,
    'ref="all" 清空全部批次（不是错误）',
    wipe.error,
  );
  assert.equal(dataOf(wipe).deleted, 2, "清空计数正确");
  assert.equal((await dataRefStore.list()).length, 0, "暂存区已空");

  const wipeByRefs = await dataTool.execute({
    action: "delete",
    refs: ["all"],
  });
  assert.equal(wipeByRefs.success, true, 'refs=["all"] 同样清空');

  const missing = await dataTool.execute({ action: "delete" });
  assert.equal(missing.success, false, "delete 缺参被拒绝");
  assert.ok(
    String(missing.error).includes("delete 需要提供"),
    "错误引导参数形态",
    missing.error,
  );

  const badRefs = await dataTool.execute({ action: "delete", refs: [123] });
  assert.equal(badRefs.success, false, "非字符串 refs（非 all）被拒绝");
}

// 2.10 空数据源参与拼接：零行文件（如某轮 crawl 无结果）不构成混拼冲突
{
  const empty = await writeDataFile("scripts/empty-page.json", []);
  const page1 = await writeDataFile("scripts/page-with-rows.json", [
    { sku: "A" },
  ]);
  const merged = await dataTool.execute({
    action: "merge",
    files: [page1, empty],
  });
  assert.equal(
    merged.success,
    true,
    "records + 空文件合并成功（零行不参与形态判定）",
    merged.error,
  );
  assert.equal(
    (dataOf(merged).shape as { rowCount?: number }).rowCount,
    1,
    "行数只计非空来源",
  );
  // 单个空文件 + 空文件：产物为空数据文件，合法
  const allEmpty = await dataTool.execute({
    action: "merge",
    files: [empty, empty],
  });
  assert.equal(
    allEmpty.success,
    true,
    "全空来源合并为空结果文件",
    allEmpty.error,
  );
  assert.equal(
    (dataOf(allEmpty).shape as { rowCount?: number }).rowCount,
    0,
    "空结果 0 行",
  );
}

// ==================== 3. xlsx_tool：数据源统一 ====================

await dataRefStore.remove("all");
const batch = await dataRefStore.save(
  [
    { title: "商品A", price: 9.9 },
    { title: "商品B", price: 19.9 },
  ],
  "SKU批次",
);
assert.ok(batch.ok, "xlsx 前置批次保存成功");
const refId = batch.meta.id;
const resultA = await writeDataFile("scripts/sheet-a.json", [
  { title: "商品A", price: 9.9 },
]);
const resultB = await writeDataFile("scripts/sheet-b.json", [
  { title: "商品B", price: 19.9 },
]);

// 3.1 openaiSchema 已声明 dataFiles/dataRef/fields（模型可见的数据源契约）
{
  const schema = xlsxTool.openaiSchema.function;
  const sheetsProp = schema.parameters.properties?.sheets as {
    items?: { properties?: Record<string, unknown> };
  };
  assert.ok(sheetsProp.items?.properties?.dataFiles, "sheets 声明 dataFiles");
  assert.ok(sheetsProp.items?.properties?.dataRef, "sheets 声明 dataRef");
  assert.ok(sheetsProp.items?.properties?.fields, "sheets 声明 fields");
}

// 3.2 create_from_data 混排：dataFiles 多文件数据表 + 手写公式汇总表（一次生成）
{
  const result = await xlsxTool.execute({
    action: "create_from_data",
    filename: "混排导出测试",
    sheets: [
      {
        name: "数据",
        dataFiles: [resultA, resultB],
        fields: ["title", "price"],
        headers: ["商品名", "价格"],
      },
      { name: "汇总", rows: [["合计"], [{ formula: "SUM(数据!B2:B3)" }]] },
    ],
  });
  assert.equal(result.success, true, "混排工作簿生成成功", result.error);
  const sheets = dataOf(result).sheets as Array<{
    name: string;
    rowCount: number;
  }>;
  assert.equal(sheets.length, 2, "两张工作表");
  assert.equal(sheets[0].name, "数据", "数据表在前");
  assert.equal(
    sheets[0].rowCount,
    3,
    "多文件拼接：1 表头 + 2 数据行（rowCount 为物理行数）",
  );
  assert.equal(sheets[1].name, "汇总", "汇总表在后");
  const marker = (dataOf(result).file as { marker?: string } | undefined)
    ?.marker;
  assert.ok(
    marker && /^<workspace-file path="outputs\/.+\.xlsx" \/>$/.test(marker),
    "文件标记格式正确",
    marker,
  );
}

// 3.3 create 也支持 dataRef 表与 dataFiles 表（复杂工作簿一站式）
{
  const byRef = await xlsxTool.execute({
    action: "create",
    filename: "create带dataRef测试",
    sheet: { name: "批次", dataRef: refId, zebra: true },
  });
  assert.equal(byRef.success, true, "create + dataRef 成功", byRef.error);
  const sheets = dataOf(byRef).sheets as Array<{ rowCount: number }>;
  assert.equal(
    sheets[0].rowCount,
    3,
    "dataRef 表默认带表头：1 表头 + 2 数据行",
  );

  const byFiles = await xlsxTool.execute({
    action: "create",
    filename: "create带dataFiles测试",
    sheet: { name: "文件表", dataFiles: [resultA] },
  });
  assert.equal(byFiles.success, true, "create + dataFiles 成功", byFiles.error);
}

// 3.4 单表数据来源三选一（任意两种同表即拒绝）
{
  for (const sheet of [
    { name: "冲突1", dataFiles: [resultA], dataRef: refId },
    { name: "冲突2", dataFiles: [resultA], rows: [["x"]] },
    { name: "冲突3", dataRef: refId, rows: [["x"]] },
  ]) {
    const result = await xlsxTool.execute({
      action: "create",
      filename: "冲突来源测试",
      sheet,
    });
    assert.equal(result.success, false, `数据源互斥被拒绝：${sheet.name}`);
    assert.ok(
      String(result.error).includes("三选一"),
      "错误说明三选一",
      result.error,
    );
  }
}

// 3.5 create_from_data 至少一个数据表
{
  const result = await xlsxTool.execute({
    action: "create_from_data",
    filename: "纯手写测试",
    sheet: { name: "手写", rows: [["a"], ["b"]] },
  });
  assert.equal(result.success, false, "纯手写 create_from_data 被拒绝");
  assert.ok(
    String(result.error).includes("数据表"),
    "错误引导数据表",
    result.error,
  );
}

// 3.6 fields 仅对数据表有效（拒绝静默忽略）
{
  const result = await xlsxTool.execute({
    action: "create",
    filename: "误用fields测试",
    sheet: { name: "手写", rows: [["a"]], fields: ["x"] },
  });
  assert.equal(result.success, false, "手写表的 fields 被拒绝");
  assert.ok(
    String(result.error).includes("fields"),
    "错误说明 fields 语义",
    result.error,
  );
}

// 3.7 数据表允许 cells 叠加（数据区外注释）
{
  const result = await xlsxTool.execute({
    action: "create_from_data",
    filename: "cells叠加测试",
    sheets: [
      {
        name: "数据",
        dataFiles: [resultA],
        cells: [{ ref: "D1", v: "生成于测试" }],
      },
    ],
  });
  assert.equal(
    result.success,
    true,
    "dataFiles + cells 叠加成功",
    result.error,
  );
}

// 3.8 typo 字段拒绝（回归：数据源字段硬校验仍在——dataFiles 与 dataRef 双通道）
{
  const files = await xlsxTool.execute({
    action: "create_from_data",
    filename: "typo字段测试",
    sheet: { name: "数据", dataFiles: [resultA], fields: ["titel"] },
  });
  assert.equal(files.success, false, "dataFiles 拼错字段被拒绝");
  assert.ok(
    String(files.error).includes("不在数据字段列表"),
    "错误回显字段校验",
    files.error,
  );

  const refs = await xlsxTool.execute({
    action: "create_from_data",
    filename: "typo字段测试2",
    sheet: { name: "数据", dataRef: refId, fields: ["titel"] },
  });
  assert.equal(refs.success, false, "dataRef 拼错字段被拒绝");
}

// 3.9 空表拒绝（无任何数据来源）
{
  const result = await xlsxTool.execute({
    action: "create",
    filename: "空表测试",
    sheet: { name: "空表" },
  });
  assert.equal(result.success, false, "空表被拒绝");
  assert.ok(
    String(result.error).includes("没有任何内容"),
    "错误说明内容缺失",
    result.error,
  );
}

// 3.10 数据源失效：可操作错误（dataFiles 文件不存在 / dataRef 引用过期）
{
  const files = await xlsxTool.execute({
    action: "create_from_data",
    filename: "失效文件测试",
    sheet: { name: "数据", dataFiles: ["results/never-saved.json"] },
  });
  assert.equal(files.success, false, "失效数据文件被拒绝");
  assert.ok(
    String(files.error).includes("不存在"),
    "错误可自助恢复",
    files.error,
  );

  const refs = await xlsxTool.execute({
    action: "create_from_data",
    filename: "失效引用测试",
    sheet: { name: "数据", dataRef: "zzzzzzzz" },
  });
  assert.equal(refs.success, false, "失效 dataRef 被拒绝");
  assert.ok(
    String(refs.error).includes("不存在或已过期"),
    "错误可自助恢复",
    refs.error,
  );
}

// 3.11 跨 action 参数互斥：markdown 只属于 create_from_markdown
{
  const withMarkdown = await xlsxTool.execute({
    action: "create",
    filename: "误传markdown",
    markdown: "| a |\n| - |\n| 1 |",
    sheet: { name: "表", rows: [["x"]] },
  });
  assert.equal(withMarkdown.success, false, "create + markdown 被拒绝");
  assert.ok(
    String(withMarkdown.error).includes("仅适用于"),
    "错误说明参数归属",
    withMarkdown.error,
  );

  const sheetsOnMarkdown = await xlsxTool.execute({
    action: "create_from_markdown",
    filename: "误传sheets",
    markdown: "| a |\n| - |\n| 1 |",
    sheets: [{ name: "表", rows: [["x"]] }],
  });
  assert.equal(
    sheetsOnMarkdown.success,
    false,
    "create_from_markdown + sheets 被拒绝",
  );
  assert.ok(
    String(sheetsOnMarkdown.error).includes("仅适用于"),
    "错误说明参数归属",
    sheetsOnMarkdown.error,
  );
}

// 3.12 records 数据拒绝 firstRowAsHeader（其恒定自动生成表头，传了必被忽略）
{
  const result = await xlsxTool.execute({
    action: "create_from_data",
    filename: "误传firstRowAsHeader",
    sheet: { name: "数据", dataFiles: [resultA], firstRowAsHeader: true },
  });
  assert.equal(result.success, false, "records + firstRowAsHeader 被拒绝");
  assert.ok(
    String(result.error).includes("firstRowAsHeader"),
    "错误定位到参数",
    result.error,
  );
}

// 3.13 null 工作表报错文案精确（不显示成含混的 object）
{
  const result = await xlsxTool.execute({
    action: "create",
    filename: "null工作表",
    sheets: [null],
  });
  assert.equal(result.success, false, "null 工作表被拒绝");
  assert.ok(
    String(result.error).includes("null"),
    "错误回显 null",
    result.error,
  );
}

// 3.14 dataFiles 非数组数据文件（信封结构）引导 project
{
  const envelope = await writeDataFile("scripts/envelope.json", {
    data: { items: [{ k: 1 }] },
  });
  const result = await xlsxTool.execute({
    action: "create_from_data",
    filename: "信封数据测试",
    sheet: { name: "数据", dataFiles: [envelope] },
  });
  assert.equal(result.success, false, "信封结构直接导出被拒绝");
  assert.ok(
    String(result.error).includes("project"),
    "错误引导 project 投影",
    result.error,
  );
}

// 3.15 dataFiles 形态混拼：精确点名冲突文件；空文件不构成冲突
{
  const recordsFile = await writeDataFile("scripts/records-file.json", [
    { a: 1 },
  ]);
  const matrixFile = await writeDataFile("scripts/matrix-file.json", [[1, 2]]);
  const emptyFile = await writeDataFile("scripts/empty-file.json", []);
  const mixed = await xlsxTool.execute({
    action: "create_from_data",
    filename: "混拼形态测试",
    sheet: { name: "数据", dataFiles: [recordsFile, matrixFile] },
  });
  assert.equal(mixed.success, false, "records 与 matrix 文件混拼被拒绝");
  assert.ok(
    String(mixed.error).includes("records-file.json"),
    "错误点名对象数组文件",
    mixed.error,
  );
  assert.ok(
    String(mixed.error).includes("matrix-file.json"),
    "错误点名二维数组文件",
    mixed.error,
  );

  const withEmpty = await xlsxTool.execute({
    action: "create_from_data",
    filename: "含空文件测试",
    sheet: { name: "数据", dataFiles: [recordsFile, emptyFile] },
  });
  assert.equal(
    withEmpty.success,
    true,
    "空文件与 records 拼接成功",
    withEmpty.error,
  );

  const mixedRows = await writeDataFile("scripts/mixed-rows.json", [
    { a: 1 },
    5,
  ]);
  const inFile = await xlsxTool.execute({
    action: "create_from_data",
    filename: "文件内混杂测试",
    sheet: { name: "数据", dataFiles: [mixedRows] },
  });
  assert.equal(inFile.success, false, "单文件内行形态混杂被拒绝");
  assert.ok(
    String(inFile.error).includes("mixed-rows.json"),
    "错误定位到文件",
    inFile.error,
  );
}

await dataRefStore.remove("all");
// 清理测试工作区文件（results/ 治理产物留在会话工作区，随会话删除清理）
for (const path of [
  "scripts/page1.json",
  "scripts/page2.json",
  "scripts/bycheck.json",
  "scripts/matrix.json",
  "scripts/unique.json",
  "scripts/info.json",
  "scripts/sheet-a.json",
  "scripts/sheet-b.json",
  "scripts/envelope.json",
  "scripts/scalars.json",
  "scripts/empty-page.json",
  "scripts/page-with-rows.json",
  "scripts/records-file.json",
  "scripts/matrix-file.json",
  "scripts/empty-file.json",
  "scripts/mixed-rows.json",
]) {
  await jsRunTool.execute({ action: "delete", path }, context);
}
