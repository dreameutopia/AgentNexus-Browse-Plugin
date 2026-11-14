/**
 * 数据治理工具（data_ref_tool）
 *
 * 「数据源 → 治理 → 导出」通道的中间层。两类数据源、一种产物：
 *   - refs：数据暂存区批次（dataRef，8 位 ID；browser_network_capture 捕获的
 *     响应正文等，浏览器会话内约 12 小时有效）；
 *   - files：工作区数据文件（js_run run/crawl 的执行结果与既往治理产物，
 *     results/ 下持久保存；也接受脚本产出的任意工作区 JSON 数组文件）。
 *
 * 治理动作（产物统一为 results/ 下的新结果文件——持久、可再治理、可导出）：
 *   - list   ：盘点暂存区批次（refs 侧；工作区文件用 js_run action="list"）；
 *   - info   ：查看单个数据源的字段结构与首行预览（ref 或 file 二选一）；
 *   - merge  ：把多个数据源按顺序拼接成一个结果文件；
 *   - project：把复合数据**投影为一张关系表**——路径指向对象时提升为单行
 *              记录；指向数组时每个元素成为一行，并可用 carry 把父级字段
 *              按来源路径带成列（关系模型的外键）；
 *   - dedupe ：按主键字段（或整行）去重——滚动增量抓取产生重复行的治理通道
 *              （多源 dedupe 即「拼接+去重」一步完成，可替代 merge）；
 *   - delete ：清理暂存区批次（结果文件用 js_run action="delete" 删除）。
 *
 * 设计约束：任何 action 都不把全量数据回传对话——数据只在数据源与
 * xlsx_tool（dataFiles/dataRef 表）之间流转，彻底避免模型转抄造成的
 * 丢失/捏造/输错。行级语义内核在 utils/data-ref-rows.ts（纯函数）。
 */

import { BaseTool } from "../base-tool";
import { ToolMetadata, type ToolExecutionContext } from "../registry";
import { OpenAITool } from "@/common/openai-types";
import { ToolResult } from "@/common/tool-handler";
import { dataRefStore, type DataRefEntry } from "@/utils/data-ref-store";
import {
  analyzeValue,
  concatRowParts,
  dedupeRows,
  projectRows,
  validateByFields,
  type ShapeMeta,
} from "@/utils/data-ref-rows";
import {
  readWorkspaceDataFile,
  saveWorkspaceResultFile,
} from "@/utils/python-workspace/data-files";
import { requireWorkspaceChatId } from "@/utils/python-workspace/artifact-contract";

/** 单次 merge/dedupe/project 的数据源上限（防止一次拼接过长拖垮存储） */
const MAX_MERGE_BATCHES = 50;

const ACTION_ENUM = [
  "list",
  "info",
  "merge",
  "project",
  "dedupe",
  "delete",
] as const;

/**
 * 按 action 的参数白名单（对齐 js_run 的 keys 契约）：跨 action 误传参数
 * 显式拒绝而不是静默忽略——「传了但没生效」会让模型误以为已按预期执行。
 */
const ACTION_PARAMS: Record<(typeof ACTION_ENUM)[number], readonly string[]> = {
  list: [],
  info: ["ref", "file"],
  merge: ["refs", "files", "label"],
  project: ["ref", "file", "path", "carry", "flatten", "label"],
  dedupe: ["refs", "files", "by", "label"],
  delete: ["ref", "refs"],
};

/** 首行/单值预览的字符上限（info 场景；全量数据永不回传） */
const PREVIEW_CHARS = 300;

/**
 * 错误信息用的安全值预览：JSON 化失败（BigInt/循环引用等程序化入参）时
 * 回落 String()——错误构造路径自身绝不允许抛错。
 */
function previewValue(value: unknown): string {
  try {
    const text = JSON.stringify(value ?? null);
    return typeof text === "string" ? text : String(value);
  } catch {
    return String(value);
  }
}

function truncatePreview(value: unknown): string | null {
  try {
    const text = JSON.stringify(value ?? null);
    if (typeof text !== "string") return null;
    return text.length <= PREVIEW_CHARS
      ? text
      : `${text.slice(0, PREVIEW_CHARS)}…`;
  } catch {
    return null;
  }
}

/** 元数据 → 一行可读摘要（list 输出用） */
function describeMeta(meta: {
  id: string;
  label?: string;
  kind: string;
  rowCount?: number;
  cols?: number;
  fields?: string[];
  bytes: number;
  createdAt: number;
}): string {
  const label = meta.label ? `「${meta.label}」` : "(无标签)";
  const shape =
    meta.kind === "records"
      ? `对象数组 ${meta.rowCount ?? "?"} 行 × ${(meta.fields ?? []).length} 字段`
      : meta.kind === "matrix"
        ? `二维数组 ${meta.rowCount ?? "?"} 行 × ${meta.cols ?? "?"} 列`
        : "单值(非表格数据)";
  const size =
    meta.bytes >= 1024 * 1024
      ? `${(meta.bytes / 1024 / 1024).toFixed(2)}MB`
      : `${(meta.bytes / 1024).toFixed(1)}KB`;
  const time = new Date(meta.createdAt).toLocaleString("zh-CN", {
    hour12: false,
  });
  return `${meta.id} | ${label} | ${shape} | ${size} | ${time}`;
}

/** 形态统计 → 人读摘要（merge/dedupe/project 完成消息用） */
function describeShape(shape: ShapeMeta): string {
  if ((shape.rowCount ?? 0) === 0) return "0 行（空数据）";
  return shape.kind === "records"
    ? `${shape.rowCount} 行 × ${(shape.fields ?? []).length} 字段`
    : shape.kind === "matrix"
      ? `${shape.rowCount} 行 × ${shape.cols ?? "?"} 列`
      : "单值";
}

/** 治理产物的统一下一步引导（xlsx 数据源 dataFiles；治理链可继续串联） */
function resultFileGuide(path: string): string {
  return (
    `后续：xlsx_tool(action="create_from_data", sheets:[{name, dataFiles:["${path}"], fields, headers}]) 直接导出；` +
    `继续治理（合并/去重/投影）把 "${path}" 放进 refs/files 即可；分页核对用 js_run(action="read", path="${path}", index=N)。`
  );
}

/** 已加载的行数据 + 来源字段元数据（by 校验用） */
interface LoadedSources {
  parts: unknown[][];
  /** 来源的字段并集元数据（refs 取存储侧 meta；files 现场计算） */
  fieldsSources: { fields?: string[] }[];
  /** 数据源总个数 */
  count: number;
}

/**
 * 数据源列表形状校验（refs / files 共用）：非空数组、未超上限、全为非空
 * 字符串 → null（无错）。kindLabel 是本参数名，otherLabel 是互斥的另一参数
 * 名——缺参错误同时引导两者，让模型一次看清选择面。
 */
function sourceListTypeError(
  raw: unknown,
  kindLabel: "refs" | "files",
  verb: string,
): string | null {
  const thisDesc =
    kindLabel === "refs"
      ? "refs（暂存批次 ID 数组）"
      : "files（工作区数据文件路径数组）";
  const otherDesc =
    kindLabel === "refs"
      ? "files（工作区数据文件路径数组）"
      : "refs（暂存批次 ID 数组）";
  if (!Array.isArray(raw) || raw.length === 0) {
    return `${verb}需要提供 ${thisDesc} 或 ${otherDesc}，二者互斥（按数据先后顺序排列）`;
  }
  if (raw.length > MAX_MERGE_BATCHES) {
    return `单次最多${verb} ${MAX_MERGE_BATCHES} 个数据源，实际收到 ${raw.length} 个——请分组处理`;
  }
  if (!raw.every((item) => typeof item === "string" && item.trim())) {
    return kindLabel === "refs"
      ? "refs 必须全部是非空字符串批次 ID"
      : "files 必须全部是非空字符串的工作区相对路径";
  }
  return null;
}

export class DataRefTool extends BaseTool {
  name = "data_ref_tool";

  metadata: ToolMetadata = {
    name: "data_ref_tool",
    description:
      "治理批量抓取数据：盘点/查看字段结构/按序合并/关系化投影/按键去重/清理；数据源支持暂存批次（refs）与工作区数据文件（files），产物统一为持久结果文件，全量数据不进对话",
    category: "data",
    version: "1.3.0",
    author: "AgentNexus",
    displayName: "数据治理通道",
    tags: ["data", "scrape", "rpa", "batch", "xlsx", "results"],
    permissions: ["storage"],
    // 纯数据管理，不触碰页面：视觉循环无需重拍
    noVisionRecapture: true,
  };

  openaiSchema: OpenAITool = {
    type: "function",
    function: {
      name: "data_ref_tool",
      description:
        "治理批量抓取数据：合并、关系化投影、按键去重、字段结构查看与批次清理；任何 action 都不回传全量数据。" +
        "两类数据源：refs=暂存批次 ID（browser_network_capture 捕获的响应正文等，浏览器会话内约 12 小时有效）；" +
        "files=工作区数据文件路径（js_run run/crawl 执行结果自动保存于 results/，跨浏览器重启持久；治理产物也是结果文件，可继续串联治理）。" +
        "merge/dedupe 用 refs 或 files（二选一，按数据先后顺序）；project/info 用 ref 或 file（二选一）。" +
        '治理产物统一保存为 results/ 下的新结果文件，用 xlsx_tool(action="create_from_data", sheets[].dataFiles=[路径]) 直接导出；' +
        '分页核对数据片段用 js_run(action="read", path=路径, index=N)（每页 ≤2000 字符）。' +
        "action=dedupe 可替代 merge：多源拼接+去重一步完成（滚动增量/多轮抓取出现重复行时优先 dedupe，by 指定主键字段，整行去重省略 by）；" +
        "action=project 把复合数据（信封响应、一格两表）投影为关系表：path 指向对象得单行记录、指向数组每个元素一行，" +
        "carry 把父级字段按来源路径带成列（子表与父表的关联键），flatten=true 展平嵌套对象为点号列；" +
        'action=list 盘点暂存批次（工作区文件用 js_run action="list"）；action=delete 清理批次（结果文件用 js_run action="delete"）。',
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [...ACTION_ENUM],
            description:
              "操作类型：list=盘点暂存批次 / info=查看数据源结构 / merge=按序合并 / project=关系化投影 / dedupe=按键去重 / delete=清理批次",
          },
          ref: {
            type: "string",
            description:
              "暂存批次 ID（info、project 的数据源；与 file 二选一；delete 可与 refs 二选一）",
          },
          refs: {
            type: "array",
            description:
              "暂存批次 ID 列表（merge、dedupe 的数据源，与 files 二选一，按数据先后顺序排列；delete 可批量删除）",
            items: { type: "string" },
          },
          file: {
            type: "string",
            description:
              '工作区数据文件路径（info、project 的数据源；与 ref 二选一，如 "results/run-20261114-093015-8f2a-样本.json"）',
          },
          files: {
            type: "array",
            description:
              "工作区数据文件路径列表（merge、dedupe 的数据源，与 refs 二选一，按数据先后顺序排列）",
            items: { type: "string" },
          },
          path: {
            type: "string",
            description:
              'project 可选：点分路径，指向对象或对象数组（如 "data.items"、"base"、"skuPrices"）；支持数组下标（"pages.1"）；缺省 = 数据本身',
          },
          carry: {
            type: "array",
            description:
              'project 可选：父级字段的点分路径数组（如 ["base.listSku","base.url"]）——解析结果按来源路径命名为列附在每一行上，构成子表与父表的关联键',
            items: { type: "string" },
          },
          flatten: {
            type: "boolean",
            description:
              "project 可选：是否把行内嵌套对象展开为点号列（默认 false，嵌套值原样保留）",
          },
          by: {
            type: "array",
            description:
              'dedupe 可选：去重字段名列表（如 ["id"]）；省略则整行去重。缺字段的行会原样保留，不会被误删',
            items: { type: "string" },
          },
          label: {
            type: "string",
            description:
              "merge/project/dedupe 生成结果文件的语义后缀（可选，如「全部商品-已去重」），出现在文件名中便于辨识",
          },
        },
        required: ["action"],
      },
    },
  };

  async execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const action = args?.action;
    if (
      typeof action !== "string" ||
      !ACTION_ENUM.includes(action as (typeof ACTION_ENUM)[number])
    ) {
      return this.createErrorResponse(
        `action 必须是 ${ACTION_ENUM.join(" / ")}，实际收到 ${previewValue(action)}`,
      );
    }
    // 参数白名单先于语义校验：纯参数错误不被数据错误掩盖
    const allowedParams = ACTION_PARAMS[action as (typeof ACTION_ENUM)[number]];
    if (args && typeof args === "object" && !Array.isArray(args)) {
      const unexpected = Object.keys(args).filter(
        (key) => key !== "action" && !allowedParams.includes(key),
      );
      if (unexpected.length) {
        return this.createErrorResponse(
          `action=${action} 不接受参数：${unexpected.join(", ")}（可用参数：${
            allowedParams.length > 0 ? allowedParams.join("、") : "无"
          }）`,
        );
      }
    }

    try {
      switch (action) {
        case "list":
          return this.handleList();
        case "info":
          return await this.handleInfo(args, context);
        case "merge":
          return await this.handleMerge(args, context);
        case "project":
          return await this.handleProject(args, context);
        case "dedupe":
          return await this.handleDedupe(args, context);
        case "delete":
          return this.handleDelete(args.ref, args.refs);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`执行失败：${message}`, "error");
      return this.createErrorResponse(message);
    }
    // 类型完备性兜底（switch 已穷尽 action 枚举）
    return this.createErrorResponse(`未知 action: ${String(action)}`);
  }

  /** list：暂存区批次的元数据盘点（工作区数据文件走 js_run list） */
  private async handleList(): Promise<ToolResult> {
    const metas = await dataRefStore.list();
    if (metas.length === 0) {
      return this.createSuccessResponse(
        { count: 0 },
        '暂存区为空（暂存批次由 browser_network_capture 等被动捕获产生）。js_run run/crawl 的执行结果是工作区 results/ 文件，用 js_run(action="list", path="results") 盘点。',
      );
    }
    const totalBytes = metas.reduce((sum, m) => sum + m.bytes, 0);
    const lines = metas.map(describeMeta).join("\n");
    return this.createSuccessResponse(
      { count: metas.length, totalBytes, refs: metas },
      `暂存区共 ${metas.length} 个批次（合计 ${(totalBytes / 1024 / 1024).toFixed(2)}MB）：\n${lines}\n` +
        '导出用 xlsx_tool(action="create_from_data")；多批次治理（merge/dedupe/project）产物为持久结果文件；工作区结果文件用 js_run(action="list", path="results") 盘点。',
    );
  }

  /** label 类型校验（merge/project/dedupe 共用）：未提供/字符串 → null，其它 → 错误文案 */
  private labelTypeError(label: unknown): string | null {
    if (label === undefined || label === null || typeof label === "string")
      return null;
    return `label 必须是字符串，实际收到 ${Array.isArray(label) ? "数组" : typeof label}`;
  }

  /**
   * 加载行数据源（merge/dedupe 共用）：refs 与 files 二选一（同时提供拒绝——
   * 拼接顺序会有歧义）。refs 从暂存区加载；files 从工作区读取并要求是数组。
   */
  private async loadRowSources(
    args: Record<string, unknown>,
    verb: string,
    context?: ToolExecutionContext,
  ): Promise<LoadedSources | { error: string }> {
    const hasRefs = args.refs !== undefined;
    const hasFiles = args.files !== undefined;
    if (hasRefs === hasFiles) {
      return {
        error: `${verb}需要提供 refs（批次 ID 列表）或 files（工作区数据文件路径列表），二者互斥（同时提供时拼接顺序有歧义）`,
      };
    }
    if (hasRefs) {
      const shapeError = sourceListTypeError(args.refs, "refs", verb);
      if (shapeError) return { error: shapeError };
      const refIds = (args.refs as string[]).map((r) => r.trim());
      const collected = await dataRefStore.collectRowParts(refIds, verb);
      if (!collected.ok) return { error: collected.reason };
      return {
        parts: collected.parts,
        fieldsSources: collected.sources.map((entry) => ({
          fields: entry.fields,
        })),
        count: refIds.length,
      };
    }
    const shapeError = sourceListTypeError(args.files, "files", verb);
    if (shapeError) return { error: shapeError };
    const chatId = requireWorkspaceChatId(context?.chatId);
    const paths = (args.files as string[]).map((f) => f.trim());
    const parts: unknown[][] = [];
    const fieldsSources: { fields?: string[] }[] = [];
    for (const raw of paths) {
      const loaded = await readWorkspaceDataFile(chatId, raw, context?.signal);
      if (!Array.isArray(loaded.value)) {
        return {
          error:
            `数据文件 ${loaded.path} 不是数组数据（形态：${analyzeValue(loaded.value).kind === "value" ? "单值/对象" : "未知"}），无法与数组数据${verb}` +
            '——信封/复合结构请先用 action="project" 投影为关系表',
        };
      }
      parts.push(loaded.value);
      fieldsSources.push({ fields: analyzeValue(loaded.value).fields });
    }
    return { parts, fieldsSources, count: paths.length };
  }

  /** info：数据源（ref 或 file 二选一）的字段结构 + 首行预览（不含全量数据） */
  private async handleInfo(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const { ref, file } = args;
    const hasRef = ref !== undefined && ref !== null;
    const hasFile = file !== undefined && file !== null;
    if (hasRef === hasFile) {
      return this.createErrorResponse(
        "info 需要提供 ref（暂存批次 ID）或 file（工作区数据文件路径），二者互斥",
      );
    }
    if (hasRef) {
      if (typeof ref !== "string" || !ref.trim()) {
        return this.createErrorResponse(
          "info 的 ref 必须是非空字符串（暂存批次 ID）",
        );
      }
      const entry = await dataRefStore.get(ref.trim());
      if (!entry) {
        const existing = await dataRefStore.list();
        const hint =
          existing.length > 0
            ? `当前可用批次：\n${existing.map(describeMeta).join("\n")}`
            : "暂存区为空（数据可能已随浏览器会话过期，请重新捕获）。";
        return this.createErrorResponse(
          `引用 "${ref}" 不存在或已过期。${hint}`,
        );
      }
      const { json: _json, ...meta } = entry;
      return this.createSuccessResponse(
        {
          ref: meta,
          fields: meta.fields ?? [],
          preview: meta.preview ?? null,
          guide: this.infoGuide(meta.kind, `ref=${meta.id}`),
        },
        `批次 ${meta.id}${meta.label ? `「${meta.label}」` : ""}：${describeMeta(entry)}`,
      );
    }
    if (typeof file !== "string" || !file.trim()) {
      return this.createErrorResponse(
        "info 的 file 必须是非空字符串（工作区数据文件路径）",
      );
    }
    const chatId = requireWorkspaceChatId(context?.chatId);
    const loaded = await readWorkspaceDataFile(
      chatId,
      file.trim(),
      context?.signal,
    );
    const shape = analyzeValue(loaded.value);
    const previewSource =
      Array.isArray(loaded.value) && loaded.value.length > 0
        ? loaded.value[0]
        : loaded.value;
    const preview = truncatePreview(previewSource);
    return this.createSuccessResponse(
      {
        file: {
          path: loaded.path,
          bytes: loaded.bytes,
          kind: shape.kind,
          rowCount: shape.rowCount,
          cols: shape.cols,
          fields: shape.fields ?? [],
        },
        fields: shape.fields ?? [],
        preview,
        guide: this.infoGuide(shape.kind, `file="${loaded.path}"`),
      },
      `数据文件 ${loaded.path}：${describeShape(shape)}（${loaded.bytes} 字节）`,
    );
  }

  /** info 的形态分支引导（ref/file 共用；sourceExpr 是回显数据源的表达式） */
  private infoGuide(kind: string, sourceExpr: string): string {
    if (kind === "records") {
      return '这是对象数组数据：xlsx_tool(create_from_data) 的数据表可用 fields 指定导出列与顺序、headers 指定表头文案（fields 拼写错误会被校验拒绝）。注意：字段值若是嵌套对象/数组，导出时会以 JSON 文本写入单元格——需要拆列请用 action="project" 配合 flatten=true 展平。';
    }
    if (kind === "matrix") {
      return "这是二维数组数据：xlsx_tool(create_from_data) 的数据表可用 headers 指定表头，或 firstRowAsHeader=true 把首行当表头。";
    }
    return `该数据源不是表格形态（单值/信封对象）：若其内部含列表，用 data_ref_tool(action="project", ${sourceExpr}, path=列表所在路径) 投影为表格；若是单对象，省略 path 或指向该对象即得到一行记录。若是普通文本/标量，请在抓取脚本中返回对象数组或二维数组。`;
  }

  /** merge：把多个数据源按顺序拼接成一个结果文件 */
  private async handleMerge(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const labelError = this.labelTypeError(args.label);
    if (labelError) return this.createErrorResponse(labelError);
    const loaded = await this.loadRowSources(args, "合并", context);
    if ("error" in loaded) return this.createErrorResponse(loaded.error);

    const concat = concatRowParts(loaded.parts, "合并");
    if (!concat.ok) return this.createErrorResponse(concat.reason);

    const chatId = requireWorkspaceChatId(context?.chatId);
    const saved = await saveWorkspaceResultFile(
      chatId,
      "merge",
      args.label,
      JSON.stringify(concat.rows),
      context?.signal,
    );
    const shape = analyzeValue(concat.rows);
    return this.createSuccessResponse(
      { file: { ...saved }, shape },
      `✅ 合并完成：${loaded.count} 个数据源 → 结果文件 ${saved.path}（${describeShape(shape)}，${saved.bytes} 字节，随会话工作区持久保存）。\n${resultFileGuide(saved.path)}`,
    );
  }

  /**
   * project：把复合数据源投影为一张关系表（对象→单行 / 子数组→多行 + 父键携带）。
   *
   * 这是「一格两表」数据（{base:{…}, skuPrices:[…]}）的正解：base 部分
   * 直接成为一张表，skuPrices 部分逐元素成行并携带 base 的字段作为关联列——
   * 不必重抓页面，也不必在导出时手工补分组标记。源数据非破坏。
   */
  private async handleProject(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const { ref, file, path, carry, flatten, label } = args;
    const hasRef = ref !== undefined && ref !== null;
    const hasFile = file !== undefined && file !== null;
    if (hasRef === hasFile) {
      return this.createErrorResponse(
        "project 需要提供 ref（暂存批次 ID）或 file（工作区数据文件路径），二者互斥",
      );
    }
    const labelError = this.labelTypeError(label);
    if (labelError) return this.createErrorResponse(labelError);
    if (path !== undefined && path !== null && typeof path !== "string") {
      return this.createErrorResponse(
        'project 的 path 必须是字符串（点分路径，如 "data.items"，支持数组下标 "a.0.b"）',
      );
    }
    if (carry !== undefined && carry !== null) {
      if (!Array.isArray(carry) || !carry.every((p) => typeof p === "string")) {
        return this.createErrorResponse(
          'project 的 carry 必须是字符串数组（父级字段的点分路径列表，如 ["base.listSku"]）',
        );
      }
    }
    if (
      flatten !== undefined &&
      flatten !== null &&
      typeof flatten !== "boolean"
    ) {
      return this.createErrorResponse("project 的 flatten 必须是布尔值");
    }

    const chatId = requireWorkspaceChatId(context?.chatId);
    let sourceValue: unknown;
    let sourceExpr: string;
    if (hasRef) {
      if (typeof ref !== "string" || !ref.trim()) {
        return this.createErrorResponse(
          "project 的 ref 必须是非空字符串（暂存批次 ID）",
        );
      }
      const entry: DataRefEntry | null = await dataRefStore.get(ref.trim());
      if (!entry) {
        const existing = await dataRefStore.list();
        const hint =
          existing.length > 0
            ? `当前可用批次：\n${existing.slice(0, 10).map(describeMeta).join("\n")}`
            : "暂存区为空（数据可能已随浏览器会话过期，请重新捕获）。";
        return this.createErrorResponse(
          `引用 "${ref}" 不存在或已过期。${hint}`,
        );
      }
      try {
        sourceValue = JSON.parse(entry.json);
      } catch {
        return this.createErrorResponse(`引用 "${ref}" 数据已损坏，无法投影`);
      }
      sourceExpr = `ref=${entry.id}`;
    } else {
      if (typeof file !== "string" || !file.trim()) {
        return this.createErrorResponse(
          "project 的 file 必须是非空字符串（工作区数据文件路径）",
        );
      }
      const loaded = await readWorkspaceDataFile(
        chatId,
        file.trim(),
        context?.signal,
      );
      sourceValue = loaded.value;
      sourceExpr = `file="${loaded.path}"`;
    }

    const projected = projectRows(sourceValue, {
      ...(typeof path === "string" ? { path } : {}),
      ...(Array.isArray(carry) ? { carry: carry as string[] } : {}),
      ...(typeof flatten === "boolean" ? { flatten } : {}),
    });
    if (!projected.ok) return this.createErrorResponse(projected.reason);
    const { rows, missingCount, nonObjectCount, firstFailureReason } =
      projected.result;
    if (rows.length === 0) {
      return this.createErrorResponse(
        `投影结果为空（${missingCount} 行在指定路径上没有值）` +
          (firstFailureReason ? `：${firstFailureReason}` : "") +
          `——请先用 action="info"（${sourceExpr}）核对数据结构与路径`,
      );
    }

    const saved = await saveWorkspaceResultFile(
      chatId,
      "project",
      label,
      JSON.stringify(rows),
      context?.signal,
    );
    const shape = analyzeValue(rows);
    const pathText =
      typeof path === "string" && path.trim()
        ? `路径 "${path.trim()}"`
        : "数据本身";
    const carryText =
      Array.isArray(carry) && carry.length
        ? `；携带父键列：${carry.map((c) => `"${String(c).trim()}"`).join("、")}`
        : "";
    const skippedNote =
      missingCount > 0 || nonObjectCount > 0
        ? `（${missingCount} 行路径无值、${nonObjectCount} 个非对象元素被跳过）`
        : "";
    return this.createSuccessResponse(
      { file: { ...saved }, shape, source: sourceExpr },
      `✅ 投影完成：${pathText} → 结果文件 ${saved.path}（${describeShape(shape)}${skippedNote}）${carryText}；源数据保留未动。\n${resultFileGuide(saved.path)}`,
    );
  }

  /** dedupe：把多个数据源按序拼接并去重，产出统计可核验的结果文件 */
  private async handleDedupe(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const { by, label } = args;
    const labelError = this.labelTypeError(label);
    if (labelError) return this.createErrorResponse(labelError);
    if (by !== undefined && by !== null) {
      if (
        !Array.isArray(by) ||
        by.length === 0 ||
        !by.every((k) => typeof k === "string" && k.trim().length > 0)
      ) {
        return this.createErrorResponse(
          'by 必须是非空字符串数组（去重字段名列表，如 ["id"]）；整行去重请省略 by',
        );
      }
    }
    const loaded = await this.loadRowSources(args, "去重", context);
    if ("error" in loaded) return this.createErrorResponse(loaded.error);

    const concat = concatRowParts(loaded.parts, "去重");
    if (!concat.ok) return this.createErrorResponse(concat.reason);
    const rows = concat.rows;

    let byFields: string[] | null = null;
    if (by !== undefined && by !== null) {
      const kind = analyzeValue(rows).kind;
      if (kind !== "records") {
        return this.createErrorResponse(
          "by 仅适用于对象数组数据（二维数组请省略 by，按整行去重）",
        );
      }
      byFields = (by as string[]).map((k) => k.trim());
      // by 字段存在性校验先于行处理（与 xlsx fields 同口径；并集截断时跳过）
      const unionError = validateByFields(byFields, loaded.fieldsSources);
      if (unionError) return this.createErrorResponse(unionError);
    }

    const stats = dedupeRows(rows, byFields);
    const sourceLabel =
      args.files !== undefined
        ? (args.files as string[]).length === 1
          ? `数据文件 ${(args.files as string[])[0].trim()}`
          : `${(args.files as string[]).length} 个数据文件`
        : (args.refs as string[]).length === 1
          ? `批次 ${(args.refs as string[])[0].trim()}`
          : `${(args.refs as string[]).length} 个批次`;

    // 单数据源且无重复：不产生新文件（沿用源数据源导出即可，避免无谓翻倍）
    if (loaded.count === 1 && stats.removed === 0) {
      const keptNote =
        stats.keptWithoutKey > 0
          ? `（${stats.keptWithoutKey} 行因缺少 by 字段无法判定重复，已原样保留）`
          : "";
      const emptyNote = stats.originalRows === 0;
      return this.createSuccessResponse(
        {
          created: false,
          stats: {
            originalRows: stats.originalRows,
            uniqueRows: stats.uniqueRows,
            removed: 0,
            keptWithoutKey: stats.keptWithoutKey,
          },
        },
        emptyNote
          ? `${sourceLabel}为空数据（0 行），无需去重，未产生新文件。`
          : `未发现重复：${stats.originalRows} 行全部唯一，沿用${sourceLabel}导出即可${keptNote}，未产生新文件。`,
      );
    }

    const chatId = requireWorkspaceChatId(context?.chatId);
    const saved = await saveWorkspaceResultFile(
      chatId,
      "dedupe",
      label,
      JSON.stringify(stats.kept),
      context?.signal,
    );
    const shape = analyzeValue(stats.kept);
    const keptNote =
      stats.keptWithoutKey > 0
        ? `；${stats.keptWithoutKey} 行因缺少 by 字段无法判定重复，已原样保留`
        : "";
    return this.createSuccessResponse(
      {
        file: { ...saved },
        shape,
        stats: {
          originalRows: stats.originalRows,
          uniqueRows: stats.uniqueRows,
          removed: stats.removed,
          keptWithoutKey: stats.keptWithoutKey,
        },
        created: true,
      },
      `✅ 去重完成：${stats.originalRows} 行 → ${stats.uniqueRows} 行（去除 ${stats.removed} 条重复${keptNote}）。\n` +
        `结果文件 ${saved.path}（${describeShape(shape)}），${resultFileGuide(saved.path)}`,
    );
  }

  /** delete：清理暂存批次（单个/批量/全部；工作区结果文件用 js_run delete） */
  private async handleDelete(ref: unknown, refs: unknown): Promise<ToolResult> {
    const parsed = this.parseDeleteIds(ref, refs);
    if ("error" in parsed) return this.createErrorResponse(parsed.error);
    const count = await dataRefStore.remove(parsed.ids);
    return this.createSuccessResponse(
      { deleted: count },
      count > 0
        ? `已删除 ${count} 个暂存批次。工作区结果文件（results/）请用 js_run(action="delete", path=文件路径) 删除。`
        : "没有匹配的批次被删除（ID 可能已过期）。",
    );
  }

  /**
   * delete 入参解析：ref（单个）/ refs（批量，全部为 "all" 视为清空）/
   * ref="all"（清空全部）三选一。返回判别联合，杜绝「合法字面量被当成
   * 错误文案」的歧义（"all" 本身就是字符串）。
   */
  private parseDeleteIds(
    ref: unknown,
    refs: unknown,
  ): { ids: string[] | "all" } | { error: string } {
    if (ref === "all") return { ids: "all" };
    if (Array.isArray(refs) && refs.length > 0) {
      if (refs.every((r) => r === "all")) return { ids: "all" };
      if (refs.every((r) => typeof r === "string" && r.trim())) {
        return { ids: (refs as string[]).map((r) => r.trim()) };
      }
      return { error: 'refs 必须全部是字符串批次 ID（或全部为 "all" 清空）' };
    }
    if (typeof ref === "string" && ref.trim()) return { ids: [ref.trim()] };
    return {
      error:
        'delete 需要提供 ref（单个批次 ID）、refs（批量）或 ref="all"（清空全部暂存批次）；工作区结果文件用 js_run(action="delete") 删除',
    };
  }
}

export const dataRefTool = new DataRefTool();
