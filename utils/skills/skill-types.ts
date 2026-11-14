import { builtinSkillId, isBuiltinSkillId } from './skill-identity';
import { isWorkspaceRelativePath } from '@/utils/python-workspace/paths';
/**
 * 技能（Skill）类型定义
 *
 * 遵循 Agent Skills 开放规范（agentskills.io）的浏览器扩展适配版：
 * 一个技能 = 一个 SKILL.md（YAML frontmatter + Markdown 正文）+ 可选资源文件。
 * 资源可按需复制到会话工作区，由可用的浏览器运行工具处理。
 *
 * 身份：仅用十进制字符串 id 引用。1..1000 是代码维护的受保护内置区间；其余由事务分配器从 1001 递增取号。
 */

/** 技能来源 */
export type SkillSource = 'preset' | 'custom';

/**
 * 运行时技能记录。
 * `files` 以相对路径为键（'SKILL.md' 为入口，其余如 'references/xx.md'），
 * `body` 为 SKILL.md 去掉 frontmatter 后的正文，由解析器生成、持久化时剥离。
 */
export interface SkillRecord {
  /** 全局唯一且不可变的十进制技能 ID（存储键） */
  id: string;
  /** Internal durable identity key; never a model-facing reference. */
  identityKey?: string;
  origin?: { pluginKey: string; ref: string; version: string; digest: string };
  /** 技能名，规范约束：小写字母/数字/连字符（^[a-z0-9]+(-[a-z0-9]+)*$） */
  name: string;
  /** 描述：做什么 + 何时使用（供模型发现与用户选择） */
  description: string;
  /** 环境要求说明（可选），如 "需要已登录 Bilibili" */
  compatibility?: string;
  /** 许可证（可选） */
  license?: string;
  /** frontmatter `allowed-tools`（空格分隔）解析出的预授权工具 ID 列表 */
  allowedTools: string[];
  /** 相对路径 → 文本内容；必须包含 'SKILL.md'（原始全文，含 frontmatter） */
  files: Record<string, string>;
  /** 无法无损表示为 UTF-8 文本的资源，按相对路径保存原始字节的 Base64。 */
  resourceBytes?: Record<string, string>;
  /**
   * 显式目录（可能为空目录）：相对路径，以 / 分隔、无首尾斜杠。
   * 文件路径派生的目录不在此列（由 files 隐含）；此列只承载「用户显式创建、
   * 尚未放入文件」的目录——技能包按文件组织，空目录若不单独记录就会在
   * 保存后消失，故作为一等字段持久化。
   */
  folders?: string[];
  /** SKILL.md 正文（frontmatter 之后），激活时注入上下文 */
  body: string;
  /**
   * 分类 id（单个）。与智能体共用同一套分类规范（注册表 / 归一化 /
   * 显示名解析，见 utils/agents/agent-types），由 frontmatter `category` 解析；
   * 分类必选——编辑器强制选择，历史/导入数据缺省归入通用（general）。
   */
  category: string;
  /** 标签（多个；与智能体同一归一化管道：单项钳制、去重保序、数量上限） */
  tags: string[];
  source: SkillSource;
  enabled: boolean;
  updatedAt: number;
}

/** 持久化形态：剥离派生字段 body，恢复时重新解析 */
export type StoredSkill = Omit<SkillRecord, 'body'>;

/** name 字段规范校验（^a-z0-9+(-a-z0-9+)*$） */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** name 长度上限（与 hub 表单 maxlength 一致；导入与存储层的兜底钳制） */
export const SKILL_NAME_MAX_CHARS = 64;

/** 十进制 ID 形状校验；安全整数边界由 isSkillId 进一步校验 */
export const SKILL_ID_PATTERN = /^[1-9][0-9]*$/;

/** 单个技能正文注入的软上限（字符），超出时截断并提示 */
export const SKILL_BODY_MAX_CHARS = 15000;

/**
 * 技能描述上限（字符）。
 * 与 hub 技能编辑页 description 输入框的 maxlength 同源——两处不一致会出现
 * 「编辑页能填、入库被拒」的割裂，故在此单一声明，UI 侧绑定同一常量。
 */
export const SKILL_DESCRIPTION_MAX_CHARS = 1024;

/** 资源文件相对路径长度上限（编辑器与导入共用的防御；规范建议引用保持一层目录深度） */
export const SKILL_PATH_MAX_CHARS = 1024;

/**
 * 归一化显式目录列表：只保留合法的相对目录路径。
 * 规则与资源文件路径同源（去空白 / 反斜杠 / 尾斜杠 / './' 前缀），
 * 逐段拒绝 ''、'.'、'..'，超长丢弃，并去重保序。
 * 外部输入（存储层反序列化、导入）共用此归一化，避免脏形态进入模型。
 */
export function normalizeFolderList(folders: unknown): string[] {
  if (!Array.isArray(folders)) return [];
  const result: string[] = [];
  for (const raw of folders) {
    if (typeof raw !== 'string') continue;
    const path = raw.replace(/\\/g, '/').trim().replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (!path || path.length > SKILL_PATH_MAX_CHARS) continue;
    if (!isWorkspaceRelativePath(path) || path.split('/').includes('__proto__')) continue;
    if (!result.includes(path)) result.push(path);
  }
  return result;
}

// ──── 导入 / 导出防护上限 ────

/** 单个技能允许携带的最大文件数（导入防御：zip 炸弹/超深目录） */
export const SKILL_IMPORT_MAX_FILES = 256;

/** 单个导入文件的大小上限（字符；约 2MB 文本） */
export const SKILL_IMPORT_MAX_FILE_CHARS = 2_000_000;

/** 单个技能所有文件的总量上限（字符；约 10MB 文本） */
export const SKILL_IMPORT_MAX_TOTAL_CHARS = 10_000_000;

/** Larger binary assets, such as fonts, templates and wheels, have a separate byte budget. */
export const SKILL_RESOURCE_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const SKILL_RESOURCE_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** 单次导入允许的技能个数上限 */
export const SKILL_IMPORT_MAX_SKILLS = 20;

/**
 * 导入预警阈值（资源原始字节）：导入前确认扩展存储占用。
 */
export const SKILL_IMPORT_WARN_BYTES = 5 * 1024 * 1024;

/**
 * 技能包（zip）的硬性体量上限（字节）。
 * 防的是解压炸弹与误选文件：unzipSync 是同步整包解压，超大包会在逐技能
 * 校验之前就把内存打爆（UI 卡死 / 标签页崩溃），必须在读文件与解压之前
 * 用 file.size 一票否决。64MB 远高于「20 技能 × 各 10M 字符」的合法上限
 * （合法文本压缩后通常只有个位数 MB），不会误伤正常包。
 */
export const SKILL_IMPORT_MAX_PACKAGE_BYTES = 64 * 1024 * 1024;

// ──── 归一化（共享不变量） ────

/**
 * allowedTools 列表归一化（入库不变量）：非字符串与空白项剔除、整体 trim、
 * 去重保序。frontmatter 解析、写入覆盖（setCustomSkill）与反序列化
 * （deserializeSkill）三处共用，保证任何入口（表单 / 导入 / 外部存储）进入
 * 系统的数据都满足同一形态——单点维护，杜绝三处实现漂移。
 * 注意：此处不去除未注册的工具 ID——注册表判定与告警统一由 runtime 装配的
 * finalizeToolIds / 请求侧完成，存储层不依赖工具注册表（分层解耦）。
 */
export function normalizeAllowedToolList(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const toolId = raw.trim();
    if (!toolId || seen.has(toolId)) continue;
    seen.add(toolId);
    result.push(toolId);
  }
  return result;
}

/** Built-in identity lookup; all other identities come from the transactional allocator. */
export const presetSkillIdFromName = builtinSkillId;
export const isReservedSkillId = isBuiltinSkillId;

/**
 * 找出列表内**重名**的技能名集合（同名是常态，展示层据此消歧）。
 *
 * 同名技能的 name 甚至 description 都可能完全一致（重复导入），选择面与已选
 * 胶囊若原样展示，用户无法确定自己选中的是哪一条——重名时补显 id 即可区分。
 * 纯函数：调用方决定传入「可见列表」还是「已选列表」。
 */
export function findDuplicateSkillNames(
  skills: readonly Pick<SkillRecord, 'name'>[],
): Set<string> {
  const counts = new Map<string, number>();
  for (const skill of skills) {
    counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
  }
  const duplicated = new Set<string>();
  for (const [name, count] of counts) {
    if (count > 1) duplicated.add(name);
  }
  return duplicated;
}
