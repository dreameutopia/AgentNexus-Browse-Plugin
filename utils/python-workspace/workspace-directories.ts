/**
 * 工作区一级目录契约（唯一事实源）
 *
 * ==================== 为什么需要这个模块 ====================
 *
 * 工作区的目录语义此前散落在三处，彼此会漂移：
 *   - utils/python-workspace/workspace-files.ts：保留目录集合（禁止作为文件目标）；
 *   - utils/python-workspace/python-filesystem.ts：沙箱启动时预建哪些目录；
 *   - 提示词（session-workspace / workspace-file-guidelines / python-scripting）：
 *     告诉模型「有哪些目录、各自装什么、脚本能往哪写」。
 *
 * 漂移的代价是实打实的失败：脚本里 `open("content/x.md", "w")` 抛
 * FileNotFoundError——提示词说「目录由工具首次写入时自动创建」，而沙箱里
 * content/ 根本不存在（只有 inputs/ 与 outputs/ 被预建）。模型于是误以为
 * 「脚本写文件必须先建目录」，绕道用 file_util 建占位文件，再重跑脚本。
 *
 * 本模块把「有哪些一级目录、各自职责、脚本能否直接写」收成一份可导出的
 * 事实：沙箱按它预建，提示词按它描述，工具按它校验。三层同源，不再漂移。
 */

/** 一级目录的职责分类。 */
export type WorkspaceDirectoryKind =
  /** 用户上传原件（只读消费） */
  | 'input'
  /** 可交付产物（用户可下载/预览） */
  | 'output'
  /** 工具产出的正文文件（可读可编辑） */
  | 'content'
  /** 工具执行结果与数据治理产物（工具通道写入） */
  | 'result'
  /** 工作脚本 */
  | 'script'
  /** 获准复制的技能资源 */
  | 'skill';

/**
 * 一级目录 → 职责分类。键即目录名（工作区根目录下的相对路径）。
 *
 * 与 WORKSPACE_RESERVED_DIRECTORIES 的区别：保留目录是「不能作为文件目标」
 * （inputs/outputs/results/content），而这里是「目录本身是什么、谁能写」。
 * 两者是正交的：scripts/ 与 skills/ 同样是标准目录，但允许在其中创建文件。
 */
export const WORKSPACE_DIRECTORY_KINDS: Readonly<Record<string, WorkspaceDirectoryKind>> = {
  inputs: 'input',
  outputs: 'output',
  content: 'content',
  results: 'result',
  scripts: 'script',
  skills: 'skill',
};

/**
 * 脚本可直接写入的一级目录（python_run 在沙箱里写文件时用）。
 *
 * results/ 不在其中：它是工具结果通道，文件由工具写入并只允许 read/list/delete
 * （手工写入会破坏「结果文件 = 工具产出的原始数据」这条可溯性约束）。
 */
export const WORKSPACE_SCRIPT_WRITABLE_DIRECTORIES: readonly string[] = Object.freeze([
  'outputs',
  'content',
  'scripts',
  'skills',
]);

/**
 * 沙箱启动时预建的一级目录。
 *
 * 为什么要预建：脚本里的 `open("content/x.md", "w")` 是**直接写 MEMFS**，
 * 不经过 file_util 的「写文件自动补父目录」逻辑。MEMFS 里目录不存在时
 * open() 直接抛 FileNotFoundError——模型看到的是一条与「目录会自动创建」
 * 相矛盾的事实，于是反复重试。
 *
 * 预建 = 让沙箱与提示词描述一致：凡提示词说「存在」的目录，脚本里就能直接
 * 写。**更深一层**（如 outputs/2026/report.csv 的中间层）仍需脚本自己
 * os.makedirs——Python 语义如此，不改。
 */
export const WORKSPACE_SANDBOX_PRESET_DIRECTORIES: readonly string[] = Object.freeze([
  'inputs',
  'outputs',
  'content',
  'scripts',
  'skills',
]);

/** 目录职责的说明文案（供提示词与错误提示共用，避免各写一份而漂移）。 */
const DIRECTORY_PURPOSE: Readonly<Record<WorkspaceDirectoryKind, string>> = {
  input: '用户上传的原件',
  output: '可交付产物（用户可下载/预览）',
  content: '工具产出的正文文件（可读可编辑）',
  result: '工具执行结果与数据治理产物（工具通道写入）',
  script: '工作脚本',
  skill: '获准复制的技能资源',
};

/** 一级目录的职责说明（模型可见的权威表述）。 */
export function describeWorkspaceDirectory(name: string): string {
  const kind = WORKSPACE_DIRECTORY_KINDS[name];
  return kind ? DIRECTORY_PURPOSE[kind] : '工作区目录';
}

/** 脚本可写入的一级目录清单文案（模型可见）。 */
export function describeScriptWritableDirectories(): string {
  return WORKSPACE_SCRIPT_WRITABLE_DIRECTORIES.map((name) => `${name}/`).join('、');
}
