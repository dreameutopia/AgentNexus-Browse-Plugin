/**
 * 会话工作区统一文件引擎（python_run 与 js_run 共用）
 *
 * 设计约束：
 * - 根目录恒为当前对话工作区：所有 path 经 parseWorkspaceFilePath 校验
 *   （isWorkspaceRelativePath：逐段拒绝 `.`/`..`/空段/反斜杠/控制符 + 盘符前缀），
 *   没有任何绝对路径出口；
 * - 与脚本执行共用同一把 withWorkspaceLock（跨上下文 navigator.locks）与
 *   saveWorkspace 的 revision CAS——文件操作与运行中的工作区写入互斥、可回滚；
 * - 内部错误使用 [WORKSPACE_*]，在 JS/Python 工具边界映射为对应工具错误。
 *
 * 编辑语义对齐 Claude Code 的 Edit 工具体验：
 * - find 与文件内容**逐字符精确匹配**（含缩进、空白与换行），必须唯一命中
 *   （除非 replaceAll）；未命中/多命中/换行风格不一致都给可操作的修复指引；
 * - find/replace 只触碰命中段，其余内容原样保留；
 * - 非 UTF-8 文件拒绝就地编辑（严格解码，杜绝静默乱码改写）。
 *
 * 所有校验先于存储访问执行：参数形态错误不触碰 IndexedDB，便于独立测试与模型自纠。
 */
import { applyTextEdit, parseTextEdits } from "./text-edit";
import {
  WorkspaceOperationError,
  errorDetails,
} from "@/utils/shared/error-details";
import { chatDatabase } from "@/entrypoints/sidepanel/core/context/chat-database";
import {
  isWorkspaceRelativePath,
  WorkspaceMissingChatError,
  WORKSPACE_EDIT_MAX_FILE_BYTES,
  WORKSPACE_FILE_CONTENT_MAX_CHARS,
  type WorkspaceEntry,
} from "./paths";
import { saveWorkspace, withWorkspaceLock } from "./store";

type EntryMap = Map<string, WorkspaceEntry>;

function fail(code: string, message: string): never {
  throw new WorkspaceOperationError(code, message);
}

/** 保留目录名：只能以目录形态存在，禁止作为文件目标。 */
const RESERVED_DIRECTORIES = new Set(["inputs", "outputs", "results"]);

/**
 * 工具自动写入的执行结果目录（js_run run/crawl 与数据治理产物）。
 * 模型只能 read/list/delete 其中的文件——create/edit 被拒绝，保证
 * 「结果文件 = 工具产出的原始数据」这一可溯性不被手写覆盖破坏。
 */
export const WORKSPACE_RESULTS_DIR = "results";

/** 是否位于工具写入的执行结果目录下（含目录本身）。 */
export function isWorkspaceResultPath(path: string): boolean {
  return (
    path === WORKSPACE_RESULTS_DIR ||
    path.startsWith(WORKSPACE_RESULTS_DIR + "/")
  );
}

/** 校验工具层传入的工作区相对路径（create/edit/delete/run 的 path 统一入口）。 */
export function parseWorkspaceFilePath(raw: unknown): string {
  if (typeof raw !== "string" || !raw) {
    fail("INVALID_PATH", "path 必须是非空字符串（相对会话工作区根目录的路径）");
  }
  if (raw !== raw.trim()) {
    fail(
      "INVALID_PATH",
      `path 不得包含首尾空白（收到 ${JSON.stringify(raw.slice(0, 120))}）`,
    );
  }
  if (raw.length > 1024) {
    fail("INVALID_PATH", "path 超过 1024 字符上限");
  }
  if (!isWorkspaceRelativePath(raw)) {
    fail(
      "INVALID_PATH",
      `path 必须相对工作区根目录：禁止绝对路径、盘符、反斜杠与 ..（收到 ${JSON.stringify(raw.slice(0, 120))}）`,
    );
  }
  return raw;
}

/** 字符级校验（无 NUL、无孤立代理对）——模型直供内容与就地编辑结果共用。 */
function validateTextCharacters(raw: string, label: string): void {
  if (raw.includes("\0")) {
    fail("INVALID_CONTENT", `${label} 不得包含 NUL 字符`);
  }
  if (/[\uD800-\uDFFF]/u.test(raw)) {
    fail("INVALID_CONTENT", `${label} 不得包含孤立代理对字符`);
  }
}

/** 校验模型直供的文件内容：有界（字符上限）+ 字符级校验。 */
export function validateWorkspaceFileContent(
  raw: unknown,
  label: string,
): string {
  if (typeof raw !== "string") {
    fail("INVALID_CONTENT", `${label} 必须是字符串`);
  }
  if (raw.length > WORKSPACE_FILE_CONTENT_MAX_CHARS) {
    fail(
      "FILE_TOO_LARGE",
      `${label} 长度 ${raw.length} 字符，超过上限 ${WORKSPACE_FILE_CONTENT_MAX_CHARS} 字符`,
    );
  }
  validateTextCharacters(raw, label);
  return raw;
}

/**
 * 读取-变异-保存事务：全程持有工作区锁，revision CAS 与全量清单校验
 * （indexWorkspaceEntries：路径形态、父目录类型、字节/条目配额）由 saveWorkspace 兜底。
 * 会话不存在 → [WORKSPACE_CONTEXT]；存储失败保留原因并返回 [WORKSPACE_STORAGE_ERROR]。
 */
async function mutateWorkspace<T>(
  chatId: string,
  signal: AbortSignal | undefined,
  mutate: (entries: EntryMap) => Promise<T> | T,
): Promise<T> {
  try {
    return await withWorkspaceLock(
      chatId,
      async () => {
        const snapshot = await chatDatabase.readWorkspace(chatId, signal);
        const entries: EntryMap = new Map(
          (snapshot?.entries ?? []).map((entry) => [entry.path, entry]),
        );
        const result = await mutate(entries);
        await saveWorkspace(
          chatId,
          snapshot?.revision,
          [...entries.values()],
          signal,
        );
        return result;
      },
      signal,
    );
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof WorkspaceMissingChatError)
      throw new WorkspaceOperationError(
        "CONTEXT",
        "会话不存在或已删除，无法访问其工作区",
        error,
      );
    if (error instanceof WorkspaceOperationError) throw error;
    throw new WorkspaceOperationError(
      "STORAGE_ERROR",
      errorDetails(error),
      error,
    );
  }
}

/** 为新建/重写补齐缺失的父目录项（只建目录、不覆盖任何已有条目）。 */
function ensureParentDirectories(entries: EntryMap, path: string): void {
  for (
    let slash = path.lastIndexOf("/");
    slash >= 0;
    slash = path.lastIndexOf("/", slash - 1)
  ) {
    const parentPath = path.slice(0, slash);
    const existing = entries.get(parentPath);
    if (existing) {
      if (existing.blob || existing.link) {
        fail(
          "INVALID_PATH",
          `父路径 ${JSON.stringify(parentPath)} 已被文件占用，无法创建 ${JSON.stringify(path)}`,
        );
      }
      continue;
    }
    entries.set(parentPath, { path: parentPath, blob: null });
  }
}

export interface WorkspaceFileStat {
  path: string;
  bytes: number;
}

/** action="create"：新建文件（已存在则拒绝，防误覆盖）。 */
export async function createWorkspaceFile(
  chatId: string,
  rawPath: unknown,
  rawContent: unknown,
  signal?: AbortSignal,
): Promise<WorkspaceFileStat> {
  const path = parseWorkspaceFilePath(rawPath);
  if (RESERVED_DIRECTORIES.has(path)) {
    fail(
      "INVALID_PATH",
      `${path}/ 是保留目录，不能作为文件创建（可在其下创建文件，如 ${path}/note.txt）`,
    );
  }
  if (isWorkspaceResultPath(path)) {
    fail(
      "INVALID_PATH",
      `${WORKSPACE_RESULTS_DIR}/ 是工具自动写入的执行结果目录，不能手工创建文件——脚本结果由 run/crawl 自动落盘，数据整形用 data_ref_tool，临时文件放 scripts/ 或 outputs/`,
    );
  }
  const content = validateWorkspaceFileContent(rawContent, "content");
  return mutateWorkspace(chatId, signal, (entries) => {
    if (entries.has(path)) {
      fail(
        "FILE_EXISTS",
        `文件已存在：${path}（修改请用 action="edit"，不要删除重建）`,
      );
    }
    ensureParentDirectories(entries, path);
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    entries.set(path, {
      path,
      blob,
      mode: 0o644,
      mtime: Date.now(),
    });
    return { path, bytes: blob.size };
  });
}

export interface WorkspaceEditInput {
  content?: unknown;
  find?: unknown;
  replace?: unknown;
  replaceAll?: unknown;
  matchMode?: unknown;
  edits?: unknown;
  expectedHash?: unknown;
}

export interface WorkspaceEditStat extends WorkspaceFileStat {
  /** 替换命中次数（content 全量重写时为 undefined） */
  replaced?: number;
}

/** 严格 UTF-8 解码：非 UTF-8 文件拒绝就地编辑，杜绝静默乱码改写。 */
function decodeUtf8Text(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    fail(
      "INVALID_CONTENT",
      `${JSON.stringify(path)} 不是有效的 UTF-8 文本，无法就地编辑（会损坏原内容）。请用 action="run" 脚本按其真实编码处理`,
    );
  }
}

/**
 * action="edit"：content 全量重写，或 find+replace 就地替换
 * （默认须唯一命中；replaceAll=true 时替换全部非重叠命中）。
 */
export async function editWorkspaceFile(
  chatId: string,
  rawPath: unknown,
  input: WorkspaceEditInput,
  signal?: AbortSignal,
): Promise<WorkspaceEditStat> {
  const path = parseWorkspaceFilePath(rawPath);
  if (isWorkspaceResultPath(path)) {
    fail(
      "INVALID_PATH",
      `${WORKSPACE_RESULTS_DIR}/ 下的文件是工具产出的原始数据（JSON 结构），文本级就地编辑会破坏其可解析性——需要整形/变换请用 data_ref_tool（project/merge/dedupe），需要修正请重跑脚本`,
    );
  }
  const hasContent = input.content !== undefined;
  const hasEdits = input.edits !== undefined;
  const hasPair = input.find !== undefined || input.replace !== undefined;
  if (Number(hasContent) + Number(hasEdits) + Number(hasPair) !== 1)
    fail(
      "INVALID_ARGUMENTS",
      "edit 需要 content（全量重写）、find+replace（就地替换）或 edits（批量替换），三种模式互斥",
    );
  if (
    input.expectedHash !== undefined &&
    (typeof input.expectedHash !== "string" ||
      !/^[a-f0-9]{64}$/i.test(input.expectedHash))
  )
    fail(
      "INVALID_ARGUMENTS",
      "expectedHash 必须是 read 返回的 SHA-256（64 位十六进制）",
    );
  const rewritten = hasContent
    ? validateWorkspaceFileContent(input.content, "content")
    : undefined;
  if (
    !hasPair &&
    (input.replaceAll !== undefined || input.matchMode !== undefined)
  )
    fail(
      "INVALID_ARGUMENTS",
      "replaceAll/matchMode 只能与 find+replace 配合；批量模式请写在每一项 edits 中",
    );
  const rawEdits = hasEdits
    ? input.edits
    : hasPair
      ? [
          {
            find: input.find,
            replace: input.replace,
            replaceAll: input.replaceAll,
            matchMode: input.matchMode,
          },
        ]
      : [];
  const edits = hasContent ? [] : parseTextEdits(rawEdits);
  return mutateWorkspace(chatId, signal, async (entries) => {
    const entry = entries.get(path);
    if (!entry)
      fail(
        "FILE_NOT_FOUND",
        "文件不存在：" + path + '（新建请用 action="create"）',
      );
    if (entry.link) fail("INVALID_PATH", "不支持编辑符号链接：" + path);
    if (!entry.blob)
      fail("INVALID_PATH", JSON.stringify(path) + " 是目录，不是文件");
    let buffer: ArrayBuffer | undefined;
    if (
      rewritten === undefined &&
      entry.blob.size > WORKSPACE_EDIT_MAX_FILE_BYTES
    )
      fail("FILE_TOO_LARGE", "文件超过就地编辑上限，请用脚本处理大文件");
    if (input.expectedHash !== undefined) {
      buffer = await entry.blob.arrayBuffer();
      signal?.throwIfAborted();
      const hash = await crypto.subtle.digest("SHA-256", buffer);
      signal?.throwIfAborted();
      if (
        [...new Uint8Array(hash)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("") !== String(input.expectedHash).toLowerCase()
      )
        fail(
          "EDIT_CONFLICT",
          "文件已变化，expectedHash 不匹配；请重新 read 后编辑",
        );
    }
    let next = rewritten;
    let replaced: number | undefined;
    if (next === undefined) {
      buffer ??= await entry.blob.arrayBuffer();
      signal?.throwIfAborted();
      next = decodeUtf8Text(new Uint8Array(buffer), path);
      replaced = 0;
      for (const edit of edits) {
        signal?.throwIfAborted();
        const result = applyTextEdit(next, edit);
        next = result.text;
        replaced += result.replaced;
        if (new Blob([next]).size > WORKSPACE_EDIT_MAX_FILE_BYTES)
          fail("FILE_TOO_LARGE", "编辑结果超过就地编辑上限");
      }
      validateTextCharacters(next, "edit 结果");
    }
    const blob = new Blob([next], {
      type: entry.blob.type || "text/plain;charset=utf-8",
    });
    entries.set(path, {
      ...entry,
      blob,
      mode: entry.mode ?? 0o644,
      mtime: Date.now(),
    });
    return { path, bytes: blob.size, replaced };
  });
}

/** ArrayBuffer → 十六进制 SHA-256（read/edit/run 的 expectedHash 契约共用的文件指纹）。 */
async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 共享的文本快照加载：定位条目（拒绝目录/链接/超限）→ 字节快照 → 严格
 * UTF-8 解码 + SHA-256 指纹。readWorkspaceTextFile 与 readWorkspaceFilePage
 * 共用，保证「同一路径在整读与分页两条通道上得到同一指纹与解码口径」。
 */
async function loadTextSnapshot(
  chatId: string,
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ text: string; sha256: string; bytes: number }> {
  const snapshot = await chatDatabase.readWorkspace(chatId, signal);
  const entry = snapshot?.entries.find((item) => item.path === path);
  if (!entry?.blob || entry.link)
    fail("FILE_NOT_FOUND", "文件不存在或不是普通文件：" + path);
  if (entry.blob.size > maxBytes) {
    fail(
      "FILE_TOO_LARGE",
      `文件 ${entry.blob.size} 字节超过读取上限 ${maxBytes}——超大文件请用脚本按需处理`,
    );
  }
  signal?.throwIfAborted();
  const buffer = await entry.blob.arrayBuffer();
  signal?.throwIfAborted();
  const sha256 = await sha256Hex(buffer);
  signal?.throwIfAborted();
  return {
    text: decodeUtf8Text(new Uint8Array(buffer), path),
    sha256,
    bytes: entry.blob.size,
  };
}

/** Snapshot a regular UTF-8 workspace file without following links. Used by both editors and JS run. */
export async function readWorkspaceTextFile(
  chatId: string,
  rawPath: unknown,
  signal?: AbortSignal,
  maxBytes: number = WORKSPACE_EDIT_MAX_FILE_BYTES,
): Promise<{ path: string; content: string; sha256: string; bytes: number }> {
  const path = parseWorkspaceFilePath(rawPath);
  const { text, sha256, bytes } = await loadTextSnapshot(
    chatId,
    path,
    maxBytes,
    signal,
  );
  return { path, content: text, sha256, bytes };
}

// ────────────────────────── 文本分页读取引擎 ──────────────────────────

/** 文本 read 分页：单页字符数（UTF-16 单位，与执行结果预览阈值刻意同值）。 */
export const WORKSPACE_READ_PAGE_CHARS = 2_000;
/**
 * 文本 read 的文件字节上限：分页定界需要整文件一次性解码（页码 → 字符区间
 * 的确定性映射），拒绝超限文件防止解码内存尖峰；更大的文件交给脚本按需处理。
 * 执行结果文件上限 10MB（见 data-files.ts），此上限保证其永远可分页读取。
 */
export const WORKSPACE_READ_MAX_FILE_BYTES = 16 * 1024 * 1024;

/** 单页读取结果：页内容 + 分页账目（页码/总页数）+ 文件指纹（sha256 供 edit 冲突检测）。 */
export interface WorkspaceFilePage {
  path: string;
  /** 当前页内容（≤ WORKSPACE_READ_PAGE_CHARS 字符；页边界永不拆开代理对） */
  content: string;
  /** 当前页码（1 起） */
  index: number;
  /** 总页数（空文件为 0） */
  pageCount: number;
  totalChars: number;
  bytes: number;
  sha256: string;
  hasMore: boolean;
  /** 下一页页码（仅在 hasMore 时携带，模型可直接回填） */
  nextIndex?: number;
}

const isHighSurrogate = (code: number): boolean =>
  code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean =>
  code >= 0xdc00 && code <= 0xdfff;

/**
 * 确定性分页定界：页 k 覆盖 [start, end)，end = min(start + PAGE_CHARS, total)；
 * 边界正好拆开一个代理对时向前收缩一位，保证每页 content 都是完整的
 * UTF-16 序列（切片可安全 JSON 序列化，不产生孤立代理项——这也是严格
 * 网关 400 防线对上游产出的要求）。
 *
 * 单次线性扫描 O(页数)（每页 O(1) 边界检查），同时求出目标页区间与总页数；
 * index 超界由调用方在拿到 pageCount 后拒绝。
 */
function locateTextPage(
  text: string,
  index: number,
): { start: number; end: number; pageCount: number } {
  const total = text.length;
  let start = 0;
  let end = 0;
  let page = 1;
  let hitStart = -1;
  let hitEnd = -1;
  while (end < total) {
    start = end;
    let stop = Math.min(start + WORKSPACE_READ_PAGE_CHARS, total);
    if (
      stop < total &&
      isHighSurrogate(text.charCodeAt(stop - 1)) &&
      isLowSurrogate(text.charCodeAt(stop))
    )
      stop--;
    if (stop === start) stop = Math.min(start + 2, total); // 防御：单字符页拆对时向前并拢完整代理对
    end = stop;
    if (page === index) {
      hitStart = start;
      hitEnd = end;
    }
    page++;
  }
  return {
    start: hitStart >= 0 ? hitStart : total,
    end: hitStart >= 0 ? hitEnd : total,
    pageCount: total === 0 ? 0 : page - 1,
  };
}

/**
 * action="read" 的分页实现：读取工作区任意 UTF-8 文本文件的第 index 页
 * （每页 ≤2000 字符）。先解码后定界：页码映射是全文的确定性函数，
 * sha256 与 totalChars 每页都携带（edit 的 expectedHash 契约以最近一次
 * read 为准）。index 越界显式报错并回显总页数，绝不静默收敛到其它页。
 */
export async function readWorkspaceFilePage(
  chatId: string,
  rawPath: unknown,
  rawIndex: unknown,
  signal?: AbortSignal,
): Promise<WorkspaceFilePage> {
  const path = parseWorkspaceFilePath(rawPath);
  const index = rawIndex === undefined ? 1 : rawIndex;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 1) {
    fail(
      "INVALID_INDEX",
      `index 必须是 ≥1 的安全整数（页码，默认 1），实际收到 ${String(index)}`,
    );
  }
  const { text, sha256, bytes } = await loadTextSnapshot(
    chatId,
    path,
    WORKSPACE_READ_MAX_FILE_BYTES,
    signal,
  );
  if (text.length === 0) {
    // 空文件：第 1 页合法返回空内容（模型常在 create 后立即 read 核对）；
    // 更大的页码仍显式报错
    if (index !== 1) {
      fail("INDEX_OUT_OF_RANGE", `index=${index} 超出范围：文件为空`);
    }
    return {
      path,
      content: "",
      index: 1,
      pageCount: 0,
      totalChars: 0,
      bytes,
      sha256,
      hasMore: false,
    };
  }
  const { start, end, pageCount } = locateTextPage(text, index);
  if (index > pageCount) {
    fail(
      "INDEX_OUT_OF_RANGE",
      `index=${index} 超出范围：文件共 ${text.length} 字符、${pageCount} 页（1..${pageCount}）`,
    );
  }
  const hasMore = end < text.length;
  return {
    path,
    content: text.slice(start, end),
    index,
    pageCount,
    totalChars: text.length,
    bytes,
    sha256,
    hasMore,
    ...(hasMore ? { nextIndex: index + 1 } : {}),
  };
}

/**
 * 工具层结果文件写入（results/ 专用）：事务内确认目标不存在后落盘，
 * 碰撞抛 FILE_EXISTS 由调用方换名重试；字节上限由调用方传入（执行结果
 * 通道的统一上限见 data-files.ts）。与 create 的区别：目标恒在保留目录
 * results/ 下（模型不可手工创建/编辑，保证结果文件可溯）、内容为工具
 * 产出的已校验文本（字符级校验仍在此 choke point 执行）。
 */
export async function appendWorkspaceResultFile(
  chatId: string,
  path: string,
  content: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ path: string; bytes: number }> {
  if (!isWorkspaceResultPath(path)) {
    fail(
      "INVALID_PATH",
      `结果文件必须位于 ${WORKSPACE_RESULTS_DIR}/ 下（收到 ${JSON.stringify(path.slice(0, 120))}）`,
    );
  }
  validateTextCharacters(content, "结果内容");
  return mutateWorkspace(chatId, signal, (entries) => {
    if (entries.has(path)) fail("FILE_EXISTS", "结果文件名冲突：" + path);
    const blob = new Blob([content], {
      type: "application/json;charset=utf-8",
    });
    if (blob.size > maxBytes) {
      fail(
        "FILE_TOO_LARGE",
        `结果 ${blob.size} 字节超过上限 ${maxBytes}——请在脚本内先筛选字段或限制条数后分批产出`,
      );
    }
    ensureParentDirectories(entries, path);
    entries.set(path, { path, blob, mode: 0o644, mtime: Date.now() });
    return { path, bytes: blob.size };
  });
}

/** action="delete"：删除文件（目录一律拒绝；inputs/outputs 等保留目录同为目录自然被拒）。 */
export async function deleteWorkspaceFile(
  chatId: string,
  rawPath: unknown,
  signal?: AbortSignal,
): Promise<{ path: string }> {
  const path = parseWorkspaceFilePath(rawPath);
  return mutateWorkspace(chatId, signal, (entries) => {
    const entry = entries.get(path);
    if (!entry) {
      fail("FILE_NOT_FOUND", `文件不存在：${path}`);
    }
    if (!entry.blob && !entry.link) {
      fail(
        "DELETE_DIRECTORY",
        `${JSON.stringify(path)} 是目录，本工具只删除文件`,
      );
    }
    entries.delete(path);
    return { path };
  });
}

/**
 * run 前的存在性预检（只读、不加锁）：让「脚本不存在」在工具层就以
 * PY_FILE_NOT_FOUND 呈现，省去宿主/worker 往返；真正的执行仍由 runner 二次校验
 * （预检与执行之间的删除竞态由 runner 的 FileNotFoundError 兜底）。
 */
export async function assertWorkspaceScriptExists(
  chatId: string,
  path: string,
): Promise<void> {
  try {
    const snapshot = await chatDatabase.readWorkspace(chatId);
    const entry = snapshot?.entries.find(
      (candidate) => candidate.path === path,
    );
    if (!entry) {
      fail(
        "FILE_NOT_FOUND",
        `脚本不存在：${path}（运行只接受已落库的文件——先用 action="create" 创建，或由技能 copy / 上次运行写入）`,
      );
    }
    if (!entry.blob && !entry.link) {
      fail(
        "FILE_NOT_FOUND",
        `${JSON.stringify(path)} 是目录，不是可运行的 .py 文件`,
      );
    }
  } catch (error) {
    if (error instanceof WorkspaceMissingChatError) {
      throw new WorkspaceOperationError(
        "CONTEXT",
        "会话不存在或已删除，无法访问其工作区",
        error,
      );
    }
    throw error;
  }
}
