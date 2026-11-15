/**
 * 工作区数据文件通道（results/）
 *
 * 所有「工具产出的结构化数据」统一落为 results/ 下的独立文件：js_run 的
 * run/crawl 执行结果、browser_extract_data 的 DOM 抓取结果、data_ref_tool
 * 的治理产物（merge/dedupe/project）。文件随会话工作区持久保存（跨浏览器
 * 重启，无暂存区 12 小时 TTL），xlsx_tool(dataFiles) 与 data_ref_tool(files)
 * 按路径直接消费，js_run(action="read") 按页核对——大批量数据全程不进模型
 * 上下文。
 *
 * 格式约定（统一真相源：tabular.ts）：
 *   - JSON：对象数组/二维数组，数据通道的默认格式；
 *   - CSV：RFC 4180，供表格软件与外部脚本直接消费（读取时解码为对象数组）；
 *   - Markdown：仅作为可读交付物（result 通道只接受 json/csv）。
 *
 * 上限约定（单一事实源在此）：
 *   - 单个结果/数据文件 ≤ WORKSPACE_DATA_FILE_MAX_BYTES（10MB）：超过即
 *     拒绝写入并引导在脚本内分批产出——分页读取引擎的上限（16MB）恒高于
 *     本值，保证落盘的结果文件永远可按页读取；
 *   - 文件数量与总容量由工作区配额（2048 条目 / 256MB，paths.ts）兜底，
 *     触达时以存储错误如实上报。
 */
import {
  WORKSPACE_RESULTS_DIR,
  appendWorkspaceResultFile,
  parseWorkspaceFilePath,
  readWorkspaceTextFile,
} from "./workspace-files";
import { csvToRecords, parseCsv } from "./tabular";
import { WorkspaceOperationError } from "@/utils/shared/error-details";

/** 执行结果与数据文件的统一字节上限（10MB） */
export const WORKSPACE_DATA_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** 结果文件的产生方：写入文件名前缀，也向模型标识数据来源 */
export type WorkspaceResultKind =
  "run" | "crawl" | "extract" | "merge" | "dedupe" | "project";

const RESULT_KINDS: readonly WorkspaceResultKind[] = [
  "run",
  "crawl",
  "extract",
  "merge",
  "dedupe",
  "project",
];

/** 结果文件的序列化格式（与读取通道能力一一对应） */
export type WorkspaceResultFormat = "json" | "csv" | "md";

/** result 通道允许的格式：Markdown 走 outputs/ 交付，不进数据通道 */
const RESULT_FORMATS: readonly WorkspaceResultFormat[] = ["json", "csv"];

const RESULT_MIME: Record<WorkspaceResultFormat, string> = {
  json: "application/json;charset=utf-8",
  csv: "text/csv;charset=utf-8",
  md: "text/markdown;charset=utf-8",
};

/** 格式 → MIME（results/ 写入与 outputs/ 交付共用，避免多处定义漂移） */
export function workspaceMimeForFormat(format: WorkspaceResultFormat): string {
  return RESULT_MIME[format];
}

/** 单次保存的命名重试次数（随机后缀碰撞概率 ~2^-24，重试只为绝对无覆盖） */
const NAME_ATTEMPTS = 4;

/**
 * 语义标签 → 文件名安全片段：剔除文件系统非法字符与控制字符、空白折叠为
 * 连字符；长度按字符截断（多字节 CJK 由工作区 255 字节名上限与总名长兜底）。
 */
function sanitizeResultLabel(label: string): string {
  // eslint-disable-next-line no-control-regex -- 刻意匹配控制字符以清理文件名
  const ILLEGAL_LABEL_CHARS = /[\u0000-\u001F\u007F\\/:*?"<>|[\]]/g;
  return label
    .replace(ILLEGAL_LABEL_CHARS, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** 本地时间紧凑戳（YYYYMMDD-HHmmss-SSS）：文件名按时间排序即按产出顺序排序 */
function resultTimestamp(now: Date): string {
  const pad = (value: number, width = 2): string =>
    String(value).padStart(width, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`
  );
}

/** 6 位十六进制随机后缀（crypto 随机，非 Math.random） */
function randomSuffix(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface WorkspaceResultFile {
  path: string;
  bytes: number;
}

/**
 * 把一份已序列化的结果写为 results/ 下的独立文件。
 *
 * 命名 `<kind>-<时间戳>-<随机后缀>[-<标签>].<ext>`：时间戳保证按名排序即
 * 按产出顺序；随机后缀 + 事务内存在性检查（appendWorkspaceResultFile 的
 * FILE_EXISTS）+ 换名重试，保证绝不覆盖既有结果。超限（>10MB）/配额触达/
 * 存储失败原样上抛——调用方整单报错并保留预览与统计，防止模型把未落盘
 * 数据当作完整结果继续流转。
 */
export async function saveWorkspaceResultText(
  chatId: string,
  kind: WorkspaceResultKind,
  label: unknown,
  text: string,
  format: WorkspaceResultFormat = "json",
  signal?: AbortSignal,
): Promise<WorkspaceResultFile & { format: WorkspaceResultFormat }> {
  if (!RESULT_KINDS.includes(kind)) {
    throw new WorkspaceOperationError(
      "INVALID_ARGUMENTS",
      `未知结果类型：${String(kind)}`,
    );
  }
  if (!RESULT_FORMATS.includes(format)) {
    throw new WorkspaceOperationError(
      "INVALID_ARGUMENTS",
      `结果通道只接受 ${RESULT_FORMATS.join("/")} 格式（收到 ${String(format)}）；Markdown 交付物请保存到 outputs/`,
    );
  }
  if (typeof text !== "string" || text === "") {
    throw new WorkspaceOperationError(
      "INVALID_CONTENT",
      "结果为空：没有可保存的数据",
    );
  }
  const normalizedLabel =
    typeof label === "string" ? sanitizeResultLabel(label) : "";
  const extension = format === "csv" ? "csv" : "json";
  let lastError: unknown;
  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
    const path = `${WORKSPACE_RESULTS_DIR}/${kind}-${resultTimestamp(new Date())}-${randomSuffix()}${normalizedLabel ? `-${normalizedLabel}` : ""}.${extension}`;
    try {
      const saved = await appendWorkspaceResultFile(
        chatId,
        path,
        text,
        WORKSPACE_DATA_FILE_MAX_BYTES,
        signal,
        RESULT_MIME[format],
      );
      return { ...saved, format };
    } catch (error) {
      // 只有命名碰撞才值得换名重试；其余（超限/配额/存储）如实上抛
      if (
        error instanceof WorkspaceOperationError &&
        error.code === "FILE_EXISTS"
      ) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw new WorkspaceOperationError(
    "STORAGE_ERROR",
    `结果文件命名重试 ${NAME_ATTEMPTS} 次仍冲突`,
    lastError,
  );
}

/** JSON 结果的便捷入口（js_run / data_ref_tool 既有调用方） */
export async function saveWorkspaceResultFile(
  chatId: string,
  kind: WorkspaceResultKind,
  label: unknown,
  json: string,
  signal?: AbortSignal,
): Promise<WorkspaceResultFile> {
  const { path, bytes } = await saveWorkspaceResultText(
    chatId,
    kind,
    label,
    json,
    "json",
    signal,
  );
  return { path, bytes };
}

export interface WorkspaceDataFile {
  path: string;
  /** 解析后的数据值：JSON 原文，或 CSV 解码后的对象数组（形态校验由调用方执行） */
  value: unknown;
  bytes: number;
}

/**
 * 读取一个工作区数据文件（xlsx / data_ref_tool 的数据源读取入口）。
 *
 * 按扩展名分派：`.csv` 按 RFC 4180 解码为对象数组（表头作键）；其余按
 * JSON 解析。逐层给出可自助修复的错误：路径非法 / 文件不存在 / 超限 /
 * 非 UTF-8 / 解析失败。接受工作区任意路径——工具结果文件
 * （results/*.json|csv）、脚本产物与用户放入 inputs/ 的 csv/json 均可。
 */
export async function readWorkspaceDataFile(
  chatId: string,
  rawPath: unknown,
  signal?: AbortSignal,
): Promise<WorkspaceDataFile> {
  const path = parseWorkspaceFilePath(rawPath);
  const isCsv = /\.csv$/i.test(path);
  try {
    const file = await readWorkspaceTextFile(
      chatId,
      path,
      signal,
      WORKSPACE_DATA_FILE_MAX_BYTES,
    );
    let value: unknown;
    if (isCsv) {
      const table = parseCsv(file.content);
      if (!table.headers.length) {
        throw new WorkspaceOperationError(
          "INVALID_CONTENT",
          `CSV 数据文件 ${path} 为空或缺少表头行——第一行必须是逗号分隔的列名`,
        );
      }
      value = csvToRecords(table);
    } else {
      try {
        value = JSON.parse(file.content);
      } catch (error) {
        throw new WorkspaceOperationError(
          "INVALID_CONTENT",
          `数据文件 ${path} 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）——数据文件由工具产出或脚本生成；若是逗号分隔表格请使用 .csv 扩展名（按 RFC 4180 解析），不接受手工拼写的半成品`,
        );
      }
    }
    return { path, value, bytes: file.bytes };
  } catch (error) {
    // 统一错误语境：把共享文本加载器的措辞映射为「数据文件」语境，
    // 让模型无需理解底层实现即可自助修复
    if (error instanceof WorkspaceOperationError) {
      if (error.code === "FILE_NOT_FOUND") {
        throw new WorkspaceOperationError(
          "FILE_NOT_FOUND",
          `数据文件不存在或不是普通文件：${path}（用 js_run(action="list") 盘点现有文件）`,
          error,
        );
      }
      if (error.code === "FILE_TOO_LARGE") {
        throw new WorkspaceOperationError(
          "FILE_TOO_LARGE",
          `数据文件 ${path} 超过单文件 ${WORKSPACE_DATA_FILE_MAX_BYTES / 1024 / 1024}MB 上限——请在脚本内分批产出后分批导出`,
          error,
        );
      }
      if (error.code === "INVALID_CONTENT" && error.message.includes("UTF-8")) {
        // 共享加载器的解码错误是「就地编辑」语境，数据文件语境须可自助修复
        throw new WorkspaceOperationError(
          "INVALID_CONTENT",
          `数据文件 ${path} 不是 UTF-8 文本（JSON/CSV 数据文件须为 UTF-8 编码的纯文本）——若需处理二进制内容请在脚本内按原始字节读取`,
          error,
        );
      }
    }
    throw error;
  }
}
