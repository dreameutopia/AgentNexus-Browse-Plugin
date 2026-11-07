import { migrateVisionToolId } from '../tools/vision-tool-migration';
/**
 * 技能（Skill）类型定义
 *
 * 遵循 Agent Skills 开放规范（agentskills.io）的浏览器扩展适配版：
 * 一个技能 = 一个 SKILL.md（YAML frontmatter + Markdown 正文）+ 可选资源文件。
 * 规范中的 scripts/ 目录在本环境不执行（无 bash），仅作为文字参考保留在正文中。
 *
 * 身份模型（v2）：
 *   - id：全局唯一且创建后不可变的机器标识（短 slug），是存储键与一切引用
 *     （智能体关联、会话回显、load_skill 调用）的稳定锚点。id 分两个区间：
 *     以保留前缀开头的区间只分配给内置技能（见 SKILL_ID_RESERVED_PREFIX），
 *     自定义技能的生成 / 导入一律在其余区间内取值；
 *   - name：用户可见名称（仍受规范字符约束），允许在 id 不变的前提下修改，
 *     **允许同名**——同名技能是常态（多站点各自的同名规范、重复导入），
 *     消歧由 id 与模型标识承担，名称本身不承担唯一性职责；
 *   - 模型标识（model id）：`${name}-${id}`，即系统提示词与工具参数中对模型
 *     暴露的唯一名称。即使两个技能同名（导入等场景），模型看到的标识也绝不
 *     相同，杜绝重名导致的模型歧义与不可控加载。
 */

/** 技能来源 */
export type SkillSource = 'preset' | 'custom' | 'plugin';

/**
 * 运行时技能记录。
 * `files` 以相对路径为键（'SKILL.md' 为入口，其余如 'references/xx.md'），
 * `body` 为 SKILL.md 去掉 frontmatter 后的正文，由解析器生成、持久化时剥离。
 */
export interface SkillRecord {
  plugin?: { key: string; version: string; displayName: string; publisher: string };
  /** 全局唯一且不可变的技能 id（短 slug，存储键） */
  id: string;
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

/** id 字段规范校验（小写字母 / 数字；不设长度约束——内置 id 9 位、自定义基名 8 位、冲突后缀更长） */
export const SKILL_ID_PATTERN = /^[a-z0-9]+$/;

/**
 * 生成的技能 id 基名长度（base36）。
 * 随机路径（generateUniqueSkillId）取满 36^8 ≈ 2.8 万亿个取值；
 * 确定性路径（skillIdFromName）受 32 位 FNV-1a 限制，实际约 2^32 个取值，
 * 对技能规模（百量级）仍绰绰有余——碰撞由 isTaken 确认 + 计数后缀兜底。
 */
export const SKILL_ID_LENGTH = 8;

/** 模型标识中 name 与 id 的连接符 */
export const SKILL_MODEL_ID_SEPARATOR = '-';

/** 单个技能正文注入的软上限（字符），超出时截断并提示 */
export const SKILL_BODY_MAX_CHARS = 15000;

/**
 * 技能描述上限（字符）。
 * 与 hub 技能编辑页 description 输入框的 maxlength 同源——两处不一致会出现
 * 「编辑页能填、入库被拒」的割裂，故在此单一声明，UI 侧绑定同一常量。
 */
export const SKILL_DESCRIPTION_MAX_CHARS = 1024;

/** 资源文件相对路径长度上限（编辑器与导入共用的防御；规范建议引用保持一层目录深度） */
export const SKILL_PATH_MAX_CHARS = 200;

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
    if (path.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) continue;
    if (!result.includes(path)) result.push(path);
  }
  return result;
}

// ──── 导入 / 导出防护上限 ────

/** 单个技能允许携带的最大文件数（导入防御：zip 炸弹/超深目录） */
export const SKILL_IMPORT_MAX_FILES = 60;

/** 单个导入文件的大小上限（字符；约 2MB 文本） */
export const SKILL_IMPORT_MAX_FILE_CHARS = 2_000_000;

/** 单个技能所有文件的总量上限（字符；约 10MB 文本） */
export const SKILL_IMPORT_MAX_TOTAL_CHARS = 10_000_000;

/** 单次导入允许的技能个数上限 */
export const SKILL_IMPORT_MAX_SKILLS = 20;

/**
 * 导入预警阈值（UTF-8 字节）：单个技能文本总量超过该值时，导入前必须弹窗
 * 确认（用户明确知晓风险后才写入）。预警而不硬拒的原因：体量本身不违法，
 * 风险属于「环境错配」——浏览器扩展没有终端，scripts/ 无法运行（只能当
 * 文档读），超大文本还会长期占用扩展存储并拖慢每次写入与跨上下文同步。
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
    const toolId = migrateVisionToolId(raw.trim());
    if (!toolId || seen.has(toolId)) continue;
    seen.add(toolId);
    result.push(toolId);
  }
  return result;
}

// ──── id 生成与模型标识 ────

/**
 * FNV-1a 32 位字符串哈希（无依赖、跨上下文确定）。
 * 用于由名称派生确定性 id：同一技能在不同机器 / 不同上下文上恢复或导入，
 * 得到的 id 完全一致，无需任何协调。
 */
function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 由名称派生确定性 id（base36，长度 SKILL_ID_LENGTH）。
 * 与智能体的 generateAgentId 不同：技能名本身已受字符规范约束，哈希落在
 * 32 位空间内（约 2^32 个取值），正常规模下无需后缀；冲突时由 generateSkillId
 * 以「哈希 + 确定性计数后缀」保证唯一（见下）。
 *
 * 注意：本函数不区分 id 区间——返回值可能落进内置技能保留区间。
 * 自定义技能的取号请走 generateSkillId / generateUniqueSkillId（二者均让位）。
 */
export function skillIdFromName(name: string): string {
  return fnv1aHash(name).toString(36).padStart(SKILL_ID_LENGTH, '0').slice(-SKILL_ID_LENGTH);
}

/** 技能 id 字符集（base36，与 skillIdFromName 的输出集一致） */
const SKILL_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * 内置（预置）技能 id 的保留前缀。
 *
 * 保留区间 = 以该前缀开头的全部 id（`p` + 8 位 base36，36^8 ≈ 2.8 万亿个取值），
 * 只由 presetSkillIdFromName 分配给 skills/ 目录下的内置技能；一切生成路径
 * （新建、导入、旧版记录恢复）经 isReservedSkillId 让位，永不落进该区间。
 * 于是内置技能的 id 可以被静态硬编码引用（智能体预设、工具→技能映射表），
 * 不受「自定义技能与内置同名」的干扰——同名不再构成歧义，id 才是唯一锚点。
 */
export const SKILL_ID_RESERVED_PREFIX = 'p';

/** id 是否落在内置技能保留区间（仅生成时让位；存量 id 一律照常有效、可被引用） */
export function isReservedSkillId(id: string): boolean {
  return id.startsWith(SKILL_ID_RESERVED_PREFIX);
}

/**
 * 内置技能 id：保留前缀 + 名称哈希（纯函数、跨上下文 / 跨版本确定）。
 *
 * 调用方传入的 name 必须与该技能 SKILL.md frontmatter 的 name 同源
 * （skill-store.initStore 与智能体预设 / 工具映射表两侧使用同一个名字），
 * 否则硬编码引用会落空。哈希空间受 32 位 FNV-1a 限制（约 2^32 个取值），
 * 内置技能的数量级下无碰撞之虞。
 */
export function presetSkillIdFromName(name: string): string {
  return `${SKILL_ID_RESERVED_PREFIX}${skillIdFromName(name)}`;
}

/**
 * 自定义技能 id 基名：在非保留区间内由名称确定性派生。
 * 哈希落进保留区间时按 `名称#1、#2…` 加盐重哈希（确定性，各上下文结果一致）。
 *
 * 说明：当前 FNV-1a 是 32 位，base36 最长 7 位，经 padStart 补齐后恒以 '0'
 * 开头，因此这条让位今天实际走不到——保留它是为让「自定义 id 永不进保留
 * 区间」这条不变量独立于哈希实现与长度常量，将来改动不会静默破坏约定。
 */
function customSkillIdBase(name: string): string {
  let input = name;
  for (let attempt = 0; attempt <= 8; attempt++) {
    const id = skillIdFromName(input);
    if (!isReservedSkillId(id)) return id;
    input = `${name}#${attempt + 1}`;
  }
  // 理论不可达（连续 9 次哈希都落进 1/36 的保留区间）：强制改写首字符兜底，
  // 宁可引入一次非常规派生，也绝不返回保留区间内的 id
  return `c${skillIdFromName(`${name}!`).slice(1)}`;
}

/**
 * 防御性兜底取号：有界重试，绝不死循环。
 *
 * 用于两条生成路径的「正常策略用尽」分支（确定性后缀用尽 / 随机抽样未命中）。
 * 占用判定恒真（理论不可能，多见于测试桩）时返回最后一次候选——函数必须有
 * 返回值，宁可引入非确定性也不允许卡死调用方。
 *
 * @param isTaken 占用判定（调用方注入，保持纯函数）
 * @param build 生成一个候选（调用方负责避开保留区间与形态约束）
 */
function takeAnyId(isTaken: (candidate: string) => boolean, build: () => string): string {
  for (let attempt = 0; attempt < 16; attempt++) {
    const candidate = build();
    if (!isTaken(candidate)) return candidate;
  }
  return build();
}

/**
 * 生成全局唯一的技能 id（确定性形态，供旧版无 id 记录恢复使用）。
 *
 * 基名经 customSkillIdBase 派生（避开内置保留区间）；被占用时按序追加十进制
 * 后缀（确定性：同一初始状态下各上下文生成结果一致）。极端情况下（后缀用尽，
 * 理论不可能）改用「基名 + 时间戳 + 随机」并同样经 isTaken 确认，
 * 保证函数必然返回——宁可引入非确定性也不允许死循环。
 *
 * 新建 / 导入请改用 generateUniqueSkillId（随机形态，并发创建更安全）。
 *
 * @param name 技能名（任意字符串，内部会先做哈希）
 * @param isTaken 判定候选 id 是否已被占用（调用方注入，保持纯函数）
 */
export function generateSkillId(name: string, isTaken?: (candidate: string) => boolean): string {
  const base = customSkillIdBase(typeof name === 'string' ? name : '');
  const taken = isTaken ?? (() => false);
  if (!taken(base)) return base;

  let counter = 2;
  while (counter <= 64) {
    const candidate = `${base}${counter}`;
    if (!taken(candidate)) return candidate;
    counter += 1;
  }
  // 防御性兜底（基名前缀保证不落保留区间）：时间戳36进制 + 随机两位
  return takeAnyId(
    taken,
    () =>
      `${base}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`.slice(
        0,
        SKILL_ID_LENGTH + 6,
      ),
  );
}

/** 随机 8 位 base36 技能 id（crypto 优先，不可用时降级 Math.random） */
function randomSkillId(): string {
  const bytes = new Uint8Array(SKILL_ID_LENGTH);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let id = '';
  for (let i = 0; i < bytes.length; i++) {
    id += SKILL_ID_ALPHABET[bytes[i] % SKILL_ID_ALPHABET.length];
  }
  return id;
}

/**
 * 新建 / 导入自定义技能的 id（随机 + 写前占用确认），与 generateSkillId 分工：
 *
 *   - generateSkillId：确定性，用于旧版（无 id）记录恢复——各上下文从同一份
 *     数据恢复必须得到同一个 id，否则跨上下文引用会各说各话；
 *   - generateUniqueSkillId：非确定性，用于新建与导入——创建是一次性事件，
 *     无需跨上下文复现。随机基名让「两个上下文同时创建」不会算出同一个 id
 *     （确定性派生在同名技能下必然撞车，落库对账时后者会被整体丢弃，
 *     表现为「刚建好的技能凭空消失」），再经 isTaken 写前确认，
 *     把并发创建的碰撞概率压到 36^-8 量级。
 *
 * 取值范围：一律避开内置技能保留区间（见 SKILL_ID_RESERVED_PREFIX）。
 *
 * @param isTaken 判定候选 id 是否已被占用（调用方注入，保持纯函数）
 */
export function generateUniqueSkillId(isTaken?: (candidate: string) => boolean): string {
  const taken = isTaken ?? (() => false);
  for (let attempt = 0; attempt < 64; attempt++) {
    const candidate = randomSkillId();
    if (!isReservedSkillId(candidate) && !taken(candidate)) return candidate;
  }
  // 理论不可达兜底（64 次随机抽样全撞）：改用「时间戳 + 随机」再做有界确认，
  // 同样避开保留区间——既保证必然返回，也绝不交出一个已占用的 id
  return takeAnyId(taken, () => {
    const raw = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(
      0,
      SKILL_ID_LENGTH + 6,
    );
    return isReservedSkillId(raw) ? `c${raw.slice(1)}` : raw;
  });
}

/**
 * 组装模型标识：`${name}-${id}`。
 * 这是系统提示词清单与 load_skill / read_skill_file 参数中对模型暴露的
 * 唯一技能名称（同名技能的 id 段不同，标识绝不相同）。
 */
export function composeModelSkillId(name: string, id: string): string {
  return `${name}${SKILL_MODEL_ID_SEPARATOR}${id}`;
}

/** SkillRecord 便捷封装 */
export function modelSkillIdOf(skill: Pick<SkillRecord, 'name' | 'id'>): string {
  return skill.id.startsWith('ed25519:') ? skill.id : composeModelSkillId(skill.name, skill.id);
}

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
