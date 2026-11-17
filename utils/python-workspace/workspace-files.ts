/**
 * 会话工作区统一文件引擎（file_util 的唯一后端，脚本执行复用同一快照/锁）
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
import { WORKSPACE_DIRECTORY_KINDS } from "./workspace-directories";
import { fileExtension } from "@/utils/upload-files/file-kinds";

type EntryMap = Map<string, WorkspaceEntry>;

function fail(code: string, message: string): never {
  throw new WorkspaceOperationError(code, message);
}

/**
 * 保留目录名：只能以目录形态存在，禁止作为文件目标（工具层早检查复用同一集合，避免漂移）。
 *
 * 集合由 workspace-directories.ts 的目录职责派生——「工作区有哪些一级目录」
 * 是单一事实源，保留集合只是其中「不可作为文件目标」的那部分视图。
 */
export const WORKSPACE_RESERVED_DIRECTORIES: ReadonlySet<string> = new Set(
  Object.entries(WORKSPACE_DIRECTORY_KINDS)
    .filter(([, kind]) => kind !== 'script' && kind !== 'skill')
    .map(([name]) => name),
);
const RESERVED_DIRECTORIES = WORKSPACE_RESERVED_DIRECTORIES;

/**
 * 工具产出的正文/交付文件目录（read_website 的 md、后续可扩展其它正文产物）。
 * 与 results/ 的区别：content/ 是**可读可编辑**的交付物，模型与用户都可以
 * 继续修改；results/ 是工具原始数据，只读不可手写。
 */
export const WORKSPACE_CONTENT_DIR = "content";

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
    fail(
      "INVALID_PATH",
      "path 必须是非空字符串（相对会话工作区根目录的路径，如 scripts/collect.js）",
    );
  }
  if (raw !== raw.trim()) {
    fail(
      "INVALID_PATH",
      `path 不得包含首尾空白（收到 ${JSON.stringify(raw.slice(0, 120))}）——请去掉首尾空格后重试`,
    );
  }
  if (raw.length > 1024) {
    fail("INVALID_PATH", "path 超过 1024 字符上限——请改用更短的路径");
  }
  if (!isWorkspaceRelativePath(raw)) {
    fail(
      "INVALID_PATH",
      `path 必须相对工作区根目录：禁止绝对路径、盘符、反斜杠与 ..（收到 ${JSON.stringify(raw.slice(0, 120))}）` +
        `——请改为不带盘符与反斜杠的相对路径，如 scripts/collect.js`,
    );
  }
  return raw;
}

/** 字符级校验（无 NUL、无孤立代理对）——模型直供内容与就地编辑结果共用。 */
function validateTextCharacters(raw: string, label: string): void {
  if (raw.includes("\0")) {
    fail(
      "INVALID_CONTENT",
      `${label} 不得包含 NUL 字符——请移除该字符后重试`,
    );
  }
  if (/[\uD800-\uDFFF]/u.test(raw)) {
    fail(
      "INVALID_CONTENT",
      `${label} 不得包含孤立代理对字符——请重新提供完整文本（常见于复制时编码截断）`,
    );
  }
}

/** 校验模型直供的文件内容：有界（字符上限）+ 字符级校验。 */
export function validateWorkspaceFileContent(
  raw: unknown,
  label: string,
): string {
  if (typeof raw !== "string") {
    fail("INVALID_CONTENT", `${label} 必须是字符串（收到 ${typeof raw}）`);
  }
  if (raw.length > WORKSPACE_FILE_CONTENT_MAX_CHARS) {
    fail(
      "FILE_TOO_LARGE",
      `${label} 长度 ${raw.length} 字符，超过上限 ${WORKSPACE_FILE_CONTENT_MAX_CHARS} 字符——请拆分内容或精简后重试`,
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
    rethrowWorkspaceAccessError(error, signal);
  }
}

/**
 * 工作区读写的统一错误出口：取消优先如实抛出；会话缺失 → CONTEXT；
 * 业务错误原样透传；其余一律收敛为 STORAGE_ERROR（保留原始原因）。
 * 读类操作与写事务共用，保证两条通道的错误码与文案一致。
 */
function rethrowWorkspaceAccessError(
  error: unknown,
  signal?: AbortSignal,
): never {
  if (signal?.aborted) {
    throw signal.reason ?? new WorkspaceOperationError("ABORTED", "操作已取消");
  }
  if (error instanceof WorkspaceMissingChatError) {
    throw new WorkspaceOperationError(
      "CONTEXT",
      "会话不存在或已删除，无法访问其工作区",
      error,
    );
  }
  if (error instanceof WorkspaceOperationError) throw error;
  throw new WorkspaceOperationError("STORAGE_ERROR", errorDetails(error), error);
}

/**
 * 只读打开工作区快照（read/list/search/grep/形态探测的统一入口）。
 *
 * 与 mutateWorkspace 共用同一套错误映射，避免每个读类调用点各写一份
 * try/catch 后出现「有的映射 CONTEXT、有的抛原始 WorkspaceMissingChatError」
 * 的不一致——后者在工具边界会被误判为未知异常。
 */
export async function readWorkspaceSnapshot(
  chatId: string,
  signal?: AbortSignal,
): Promise<WorkspaceEntry[]> {
  try {
    signal?.throwIfAborted();
    const snapshot = await chatDatabase.readWorkspace(chatId, signal);
    return snapshot?.entries ?? [];
  } catch (error) {
    rethrowWorkspaceAccessError(error, signal);
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
          `父路径 ${JSON.stringify(parentPath)} 已被文件占用，无法创建 ${JSON.stringify(path)}——请换一个不冲突的路径`,
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
        `文件已存在：${path}（修改请用 file_util(action="edit")，不要删除重建）`,
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

/**
 * 工具产出的交付文件写入（content/ 等非 results 目录）。
 *
 * 与 createWorkspaceFile 的差异：
 * - 大小按**字节**上限校验（8MB），而不是 200k 字符的手写上限——正文产物
 *   可能远超手写文件，字节口径才与存储/下载一致；
 * - 允许任意 MIME（默认 markdown），不写文本模式的 0o644 之外的额外语义；
 * - 已存在即拒绝（调用方负责生成不冲突的文件名并在冲突时重试），
 *   绝不静默覆盖用户已有产物。
 */
export async function writeToolWorkspaceFile(
  chatId: string,
  rawPath: unknown,
  content: string,
  options: { mime?: string; signal?: AbortSignal } = {},
): Promise<WorkspaceFileStat> {
  const path = parseWorkspaceFilePath(rawPath);
  if (RESERVED_DIRECTORIES.has(path)) {
    fail(
      "INVALID_PATH",
      `${path}/ 是保留目录，不能作为文件写入（请写到其下，如 ${path}/page.md）`,
    );
  }
  if (isWorkspaceResultPath(path)) {
    fail(
      "INVALID_PATH",
      `${WORKSPACE_RESULTS_DIR}/ 只能由 run/crawl 的结果通道写入，工具产物请写到 ${WORKSPACE_CONTENT_DIR}/ 或 outputs/`,
    );
  }
  if (typeof content !== "string") {
    fail("INVALID_ARGUMENT", "content 必须是字符串");
  }
  const bytes = new Blob([content]).size;
  if (bytes > WORKSPACE_EDIT_MAX_FILE_BYTES) {
    fail(
      "INVALID_ARGUMENT",
      `文件 ${bytes} 字节，超过单文件上限 ${WORKSPACE_EDIT_MAX_FILE_BYTES} 字节`,
    );
  }
  const mime = options.mime || "text/markdown;charset=utf-8";
  return mutateWorkspace(chatId, options.signal, (entries) => {
    if (entries.has(path)) {
      fail("FILE_EXISTS", `文件已存在：${path}（工具产物不覆盖已有文件）`);
    }
    ensureParentDirectories(entries, path);
    const blob = new Blob([content], { type: mime });
    entries.set(path, { path, blob, mode: 0o644, mtime: Date.now() });
    return { path, bytes: blob.size };
  });
}

/** 工作区路径的存在形态（用于区分「目录不可删」与「二进制不可删」）。 */
export type WorkspacePathKind = 'file' | 'directory' | 'link' | 'missing';

/**
 * 只读探测某个路径在工作区中的形态。
 *
 * 删除动作需要先区分目录/文件/缺失，才能给出正确的下一步；若直接按后缀
 * 判定文本类型，`delete path="scripts"` 会被误报成「后缀不在文本范围」，
 * 掩盖真正的失败原因。
 */
export async function workspacePathKind(
  chatId: string,
  rawPath: unknown,
  signal?: AbortSignal,
): Promise<WorkspacePathKind> {
  const path = parseWorkspaceFilePath(rawPath);
  const entries = await readWorkspaceSnapshot(chatId, signal);
  const entry = entries.find((item) => item.path === path);
  if (!entry) return 'missing';
  if (entry.link) return 'link';
  return entry.blob ? 'file' : 'directory';
}

export interface WorkspaceCopyStat extends WorkspaceFileStat {
  /** 副本来源路径 */
  source: string;
}

/**
 * action="copy"：复制工作区内的任意类型文件（文本/图片/Office/PDF 等），
 * 逐字节保留原内容。
 *
 * 与文本写操作的边界：
 *   - **不受文件类型限制**（副本是字节级复制，不做解码/转码，不会损坏二进制）；
 *   - 目标必须是工作区相对路径，且**父目录必须已存在**——复制是「另存一份」，
 *     不静默创建目录，避免路径拼错却写出一棵新目录树；
 *   - 后缀必须与源文件一致（大小写不敏感：`.PY` 与 `.py` 视为同一后缀），
 *     防止 `a.json` 被复制成 `a.csv` 这类「内容与扩展名不符」的产物；
 *   - `results/` 仍是结果通道的保留目录，副本不能写入（可溯性约束与 create/edit 一致）。
 */
export async function copyWorkspaceFile(
  chatId: string,
  rawSource: unknown,
  rawTarget: unknown,
  signal?: AbortSignal,
): Promise<WorkspaceCopyStat> {
  const source = parseWorkspaceFilePath(rawSource);
  const target = parseWorkspaceFilePath(rawTarget);
  if (source === target) {
    fail("INVALID_PATH", "target 不能与 path 相同——副本必须使用新的路径");
  }
  if (RESERVED_DIRECTORIES.has(target)) {
    fail(
      "INVALID_PATH",
      `${target}/ 是保留目录，不能作为文件副本目标（请写到其下，如 ${target}/copy.txt）`,
    );
  }
  if (isWorkspaceResultPath(target)) {
    fail(
      "INVALID_PATH",
      `${WORKSPACE_RESULTS_DIR}/ 只能由结果通道写入，副本请写到 ${WORKSPACE_CONTENT_DIR}/、outputs/、scripts/ 等目录`,
    );
  }
  const sourceSuffix = fileExtension(source);
  const targetSuffix = fileExtension(target);
  if (sourceSuffix !== targetSuffix) {
    fail(
      "INVALID_PATH",
      `副本后缀必须与源文件完全一致：源 ${JSON.stringify(source)} 的后缀为 ${sourceSuffix ? `".${sourceSuffix}"` : "（无）"}，` +
        `目标 ${JSON.stringify(target)} 的后缀为 ${targetSuffix ? `".${targetSuffix}"` : "（无）"}。请保留相同后缀（大小写不敏感）`,
    );
  }
  const parent = target.includes("/")
    ? target.slice(0, target.lastIndexOf("/"))
    : "";
  return mutateWorkspace(chatId, signal, (entries) => {
    const entry = entries.get(source);
    if (!entry?.blob || entry.link) {
      fail(
        "FILE_NOT_FOUND",
        `源文件不存在或不是普通文件：${source}——用 file_util(action="list") 盘点核对来源路径拼写`,
      );
    }
    if (entries.has(target)) {
      fail("FILE_EXISTS", `副本目标已存在：${target}（请换一个名称，避免覆盖既有文件）`);
    }
    if (parent) {
      const parentEntry = entries.get(parent);
      if (!parentEntry) {
        fail(
          "INVALID_PATH",
          `副本目标的父目录不存在：${parent}——先用 file_util(action="list") 确认目录，或把 target 指向已存在目录`,
        );
      }
      if (parentEntry.blob || parentEntry.link) {
        fail(
          "INVALID_PATH",
          `副本目标的父路径 ${parent} 已被文件占用——请换一个目标路径`,
        );
      }
    }
    const blob = new Blob([entry.blob], {
      type: entry.blob.type || "application/octet-stream",
    });
    entries.set(target, { path: target, blob, mode: 0o644, mtime: Date.now() });
    return { path: target, bytes: blob.size, source };
  });
}

export interface WorkspaceEditInput {  content?: unknown;
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
      `${JSON.stringify(path)} 不是有效的 UTF-8 文本，无法就地编辑（会损坏原内容）。请先用 file_util(action="copy") 备份，再用 python_run 按其真实编码读取并另存为 UTF-8 文本后再编辑`,
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
      'expectedHash 必须是 file_util(action="read") 返回的 SHA-256（64 位十六进制）',
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
        `文件不存在：${path}（新建请用 file_util(action="create")）`,
      );
    if (entry.link)
      fail(
        "INVALID_PATH",
        `不支持编辑符号链接：${path}——请指向普通文本文件`,
      );
    if (!entry.blob)
      fail(
        "INVALID_PATH",
        `${JSON.stringify(path)} 是目录，不是文件——请指向目录下的具体文件（file_util(action="list", path=${JSON.stringify(path)}) 可盘点子项）`,
      );
    let buffer: ArrayBuffer | undefined;
    if (
      rewritten === undefined &&
      entry.blob.size > WORKSPACE_EDIT_MAX_FILE_BYTES
    )
      fail(
        "FILE_TOO_LARGE",
        `文件超过就地编辑上限（${WORKSPACE_EDIT_MAX_FILE_BYTES} 字节）——请用脚本处理大文件`,
      );
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
          '文件已变化，expectedHash 不匹配；请用 file_util(action="read") 重新读取后再编辑',
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
          fail(
            "FILE_TOO_LARGE",
            `编辑结果超过就地编辑上限（${WORKSPACE_EDIT_MAX_FILE_BYTES} 字节）——请缩小替换范围或拆分文件`,
          );
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

/**
 * action="append"：在既有文本文件尾部追加内容。
 *
 * 与 edit 的同源约束：
 *   - 目标必须已存在且是普通文件（不静默创建——追加语义的前提是既有文件；
 *     需要新建请用 create，避免「路径打错却写出一个新文件」的静默副作用）；
 *   - 既有内容必须是严格 UTF-8（与 edit 同口径）：非 UTF-8 文件（GBK/UTF-16）
 *     拒绝追加，避免拼出混合编码的损坏文件，此时应改用脚本按真实编码处理；
 *   - results/ 下的工具结果文件拒绝追加（其可溯性依赖内容不被手写污染）。
 */
export async function appendWorkspaceFile(
  chatId: string,
  rawPath: unknown,
  rawContent: unknown,
  signal?: AbortSignal,
): Promise<WorkspaceFileStat & { appendedChars: number }> {
  const path = parseWorkspaceFilePath(rawPath);
  if (isWorkspaceResultPath(path)) {
    fail(
      "INVALID_PATH",
      `${WORKSPACE_RESULTS_DIR}/ 下的文件是工具产出的原始数据，不接受追加写入——需要整形/变换请用 data_ref_tool，需要修正请重跑脚本`,
    );
  }
  const addition = validateWorkspaceFileContent(rawContent, "content");
  return mutateWorkspace(chatId, signal, async (entries) => {
    const entry = entries.get(path);
    if (!entry)
      fail(
        "FILE_NOT_FOUND",
        `文件不存在：${path}（追加的前提是文件已存在；新建请用 file_util(action="create")）`,
      );
    if (entry.link)
      fail(
        "INVALID_PATH",
        `不支持追加符号链接：${path}——请指向普通文本文件`,
      );
    if (!entry.blob)
      fail(
        "INVALID_PATH",
        `${JSON.stringify(path)} 是目录，不是文件——请指向目录下的具体文件（file_util(action="list", path=${JSON.stringify(path)}) 可盘点子项）`,
      );
    if (entry.blob.size > WORKSPACE_EDIT_MAX_FILE_BYTES) {
      fail(
        "FILE_TOO_LARGE",
        `文件超过就地编辑上限（${WORKSPACE_EDIT_MAX_FILE_BYTES} 字节）——请用脚本处理大文件`,
      );
    }
    const buffer = await entry.blob.arrayBuffer();
    signal?.throwIfAborted();
    const current = decodeUtf8Text(new Uint8Array(buffer), path);
    const next = current + addition;
    if (new Blob([next]).size > WORKSPACE_EDIT_MAX_FILE_BYTES) {
      fail(
        "FILE_TOO_LARGE",
        `追加结果超过就地编辑上限（${WORKSPACE_EDIT_MAX_FILE_BYTES} 字节）——请减少单次追加量或拆分文件`,
      );
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
    return { path, bytes: blob.size, appendedChars: addition.length };
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
 * UTF-8 解码 + SHA-256 指纹。file_util 的分页读取与脚本执行前的源码读取
 * 共用，保证「同一路径在整读与分页两条通道上得到同一指纹与解码口径」。
 */
async function loadTextSnapshot(
  chatId: string,
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ text: string; sha256: string; bytes: number }> {
  const entries = await readWorkspaceSnapshot(chatId, signal);
  const entry = entries.find((item) => item.path === path);
  // 三态分诊（缺失 / 符号链接 / 目录）而不是笼统的「不存在或不是普通文件」：
  // 混为一谈会让模型对着目录反复重试 read/run。下一步必须可执行——
  // 「先 list 核对拼写、缺失则 create」覆盖 file_util 读取与 js_run/python_run
  // 脚本执行两条中继通道（错误会以 [JS_*]/[PY_*] 前缀透出，故点名 file_util）。
  if (!entry)
    fail(
      "FILE_NOT_FOUND",
      `文件不存在：${path}——read/run 都不会自动创建文件。` +
        `下一步：file_util(action="list") 盘点核对路径拼写；确实缺失时先 file_util(action="create") 创建后重试` +
        `（run/crawl 只执行已保存的脚本）`,
    );
  if (entry.link)
    fail(
      "INVALID_PATH",
      `${JSON.stringify(path)} 是符号链接，不是普通文件——请指向普通文件`,
    );
  if (!entry.blob)
    fail(
      "INVALID_PATH",
      `${JSON.stringify(path)} 是目录，不是文件——请指向目录下的具体文件（file_util(action="list", path=${JSON.stringify(path)}) 可盘点子项）`,
    );
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

/** 脚本执行结果的响应预览字符数（run/crawl 只回传前 2000 字符，完整结果在结果文件里）。 */
export const WORKSPACE_READ_PAGE_CHARS = 2_000;

/**
 * 面向模型的按需阅读分页（file_util 与内容正则搜索共用）。
 *
 * 与 WORKSPACE_READ_PAGE_CHARS 的差异是产品口径：脚本结果预览用 2000，
 * 文件按需阅读用 3000。两条通道必须引用同一个常量，否则内容搜索回报的
 * 页码会与 file_util 实际分页错位——模型据此续读时直接读到错误区间。
 */
export const WORKSPACE_TOOL_READ_PAGE_CHARS = 3_000;
/**
 * 文本 read 的文件字节上限：分页定界需要整文件一次性解码（页码 → 字符区间
 * 的确定性映射），拒绝超限文件防止解码内存尖峰；更大的文件交给脚本按需处理。
 * 执行结果文件上限 10MB（见 data-files.ts），此上限保证其永远可分页读取。
 */
export const WORKSPACE_READ_MAX_FILE_BYTES = 16 * 1024 * 1024;

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
 *
 * 导出为**分页定界的唯一实现**：file_util 的读取通道（默认 3000 字符/页）
 * 必须通过它定界；各写一份必然漂移，而漂移的代价是页边界拆开代理对
 * （严格网关对孤立代理项零容忍）。
 */
function* iteratePageRanges(
  text: string,
  pageChars: number,
): Generator<{ start: number; end: number }> {
  const total = text.length;
  let start = 0;
  while (start < total) {
    let stop = Math.min(start + pageChars, total);
    if (
      stop < total &&
      isHighSurrogate(text.charCodeAt(stop - 1)) &&
      isLowSurrogate(text.charCodeAt(stop))
    )
      stop--;
    if (stop === start) stop = Math.min(start + 2, total); // 防御：单字符页拆对时向前并拢完整代理对
    yield { start, end: stop };
    start = stop;
  }
}

export function locateTextPage(
  text: string,
  index: number,
  pageChars: number = WORKSPACE_TOOL_READ_PAGE_CHARS,
): { start: number; end: number; pageCount: number } {
  let pageCount = 0;
  let hit: { start: number; end: number } | undefined;
  for (const range of iteratePageRanges(text, pageChars)) {
    pageCount++;
    if (pageCount === index) hit = range;
  }
  const total = text.length;
  return {
    start: hit?.start ?? total,
    end: hit?.end ?? total,
    pageCount,
  };
}

/**
 * 字符偏移 → 页码（1 起，口径与 locateTextPage 完全一致）。
 *
 * 供内容正则搜索回报「命中行落在 file_util 第几页」：必须复用同一套页边界
 * 算法，否则代理对附近的页码会与 read 实际返回的页错开一位。
 * 空文件返回 1（read 对空文件的第 1 页合法返回空内容）；越界偏移收敛到末页。
 */
export function pageIndexForOffset(
  text: string,
  offset: number,
  pageChars: number = WORKSPACE_TOOL_READ_PAGE_CHARS,
): number {
  const total = text.length;
  if (total === 0) return 1;
  const target = Math.min(Math.max(0, Math.trunc(offset)), total - 1);
  let page = 1;
  for (const range of iteratePageRanges(text, pageChars)) {
    if (target >= range.start && target < range.end) return page;
    page++;
  }
  return Math.max(1, page - 1);
}

/**
 * 原始字节快照读取（不做任何解码）。
 *
 * 供两类调用方使用：
 *   - file_util 的读取通道：文本文件走**容错解码阶梯**（BOM → UTF-8 → GBK），
 *     Office 文件走**二进制解析**（xlsx/docx/pptx → markdown），两者都要求
 *     原始字节而非已解码字符串；
 *   - 任何需要自行判定编码的调用方。
 *
 * 与 loadTextSnapshot 的区别：不强制 UTF-8、不计算 sha256——指纹由调用方
 * 在确实需要时自行计算，避免对大文件做无谓的摘要运算。
 */
export async function readWorkspaceFileBytes(
  chatId: string,
  rawPath: unknown,
  signal?: AbortSignal,
  maxBytes: number = WORKSPACE_READ_MAX_FILE_BYTES,
): Promise<{ path: string; bytes: Uint8Array; size: number }> {
  const path = parseWorkspaceFilePath(rawPath);
  const entries = await readWorkspaceSnapshot(chatId, signal);
  const entry = entries.find((item) => item.path === path);
  // 与 loadTextSnapshot 同一套三态分诊与可执行下一步（两条读取通道必须同口径）
  if (!entry)
    fail(
      "FILE_NOT_FOUND",
      `文件不存在：${path}——read 不会自动创建文件。` +
        `下一步：file_util(action="list") 盘点核对路径拼写；确实缺失时先 file_util(action="create") 创建后重试`,
    );
  if (entry.link)
    fail(
      "INVALID_PATH",
      `${JSON.stringify(path)} 是符号链接，不是普通文件——请指向普通文件`,
    );
  if (!entry.blob)
    fail(
      "INVALID_PATH",
      `${JSON.stringify(path)} 是目录，不是文件——请指向目录下的具体文件（file_util(action="list", path=${JSON.stringify(path)}) 可盘点子项）`,
    );
  if (entry.blob.size > maxBytes) {
    fail(
      "FILE_TOO_LARGE",
      `文件 ${entry.blob.size} 字节超过读取上限 ${maxBytes}——超大文件请用脚本按需处理`,
    );
  }
  signal?.throwIfAborted();
  const buffer = await entry.blob.arrayBuffer();
  signal?.throwIfAborted();
  return {
    path,
    bytes: new Uint8Array(buffer),
    size: entry.blob.size,
  };
}

/**
 * 工具层结果文件写入（results/ 专用）：事务内确认目标不存在后落盘，
 * 碰撞抛 FILE_EXISTS 由调用方换名重试；字节上限由调用方传入（执行结果
 * 通道的统一上限见 data-files.ts）。与 create 的区别：目标恒在保留目录
 * results/ 下（模型不可手工创建/编辑，保证结果文件可溯）、内容为工具
 * 产出的已校验文本（字符级校验仍在此 choke point 执行）。
 *
 * mime 由调用方按实际格式传入（json/csv）：同一目录承载多种格式，
 * 下载与预览据此决定打开方式；缺省保持 JSON（既有调用方不变）。
 */
export async function appendWorkspaceResultFile(
  chatId: string,
  path: string,
  content: string,
  maxBytes: number,
  signal?: AbortSignal,
  mime: string = "application/json;charset=utf-8",
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
    // MIME 由调用方按实际格式传入（json/csv）：结果目录同时承载两种格式，
    // 下载/预览按 MIME 决定打开方式
    const blob = new Blob([content], { type: mime });
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
      fail(
        "FILE_NOT_FOUND",
        `文件不存在：${path}——先用 file_util(action="list") 盘点核对路径；若文件确实已不存在，本操作可视为完成`,
      );
    }
    if (!entry.blob && !entry.link) {
      fail(
        "DELETE_DIRECTORY",
        `${JSON.stringify(path)} 是目录，本工具只删除文件——请指向目录下的具体文件（file_util(action="list", path=${JSON.stringify(path)}) 可盘点子项）`,
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
        `脚本不存在：${path}（run 只接受已落库的 .py 文件——先用 file_util(action="create") 创建，或由技能 copy / 上次运行写入）`,
      );
    }
    if (!entry.blob && !entry.link) {
      fail(
        "FILE_NOT_FOUND",
        `${JSON.stringify(path)} 是目录，不是可运行的 .py 文件——请指向具体的 .py 文件（如 scripts/report.py）`,
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
