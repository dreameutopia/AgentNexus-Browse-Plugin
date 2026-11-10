import {
  DEFAULT_LOCALE,
  NON_DEFAULT_LOCALES,
  type Locale,
  type NonDefaultLocale,
} from '../i18n/locales';
import { VISION_GUI_TOOL_ID } from '../../tools/vision/gui-contract';
import { isSkillToolId } from '../skills/skill-tool-contract';
/**
 * 智能体领域类型与纯逻辑（无副作用层）
 *
 * 分层约定：
 *   agent-types.ts（本文件） 类型 + 不变量常量 + 纯函数（归一化/校验/分类/排序/ID 生成）
 *   agent-store.ts           预置表 + 内存表 + 持久化 + 跨上下文同步 + 查询/写入门面
 *
 * 拆分动机：本层零 I/O、零全局状态，可被 hub 管理页、sidepanel 面板、测试直接复用；
 * 所有「外部数据 → 领域对象」的收敛（持久化恢复、跨上下文同步、UI 写入）都必须
 * 经过本层的 normalize* 函数，保证进入系统的每一份数据都满足不变量。
 *
 * 安全与稳健约定：
 *   - 所有长度/数量上限在此集中声明，UI 与写入层共用同一套数字，杜绝两处漂移；
 *   - 归一化函数对任意输入都不抛错（脏数据 → 合理默认值或 null）；
 *   - id / name 是身份字段，归一化时不改写（改写会破坏已持久化的引用关系）；
 *   - 本层不感知 vue-i18n：多语言文案按「语言 → 文案」存放（见 AgentDisplayText），
 *     展示侧解析时传入当前语言即可（与 categoryLabelOf 同一思路）。
 */

// ==================== 分类 ====================

/**
 * 未分类的稳定 id。空字符串在展示与筛选时一律归入该分类，
 * 存储中同样以空串表示「用户未设置分类」，避免 general 与「用户显式选了 general」
 * 两种语义混用。
 */
export const AGENT_CATEGORY_UNCATEGORIZED = 'general';

/** 内置分类元数据（id 稳定且永不本地化；显示名经 i18n 解析） */
export interface AgentCategoryMeta {
  /** 稳定 id（持久化字段） */
  id: string;
  /** i18n 显示键（如 'agentCategory.automation'）；调用方自行 cast 为 MessageKey */
  labelKey: string;
}

/**
 * 内置分类注册表（展示顺序即此顺序）。
 * 自定义分类（用户自建的任意 id）排在内置分类之后，按 id 字典序。
 * 新增内置分类：在此登记 + 在两个 locale 中补 labelKey，无需改动任何逻辑代码。
 */
export const BUILTIN_AGENT_CATEGORIES: readonly AgentCategoryMeta[] = [
  { id: 'automation', labelKey: 'agentCategory.automation' },
  { id: 'search', labelKey: 'agentCategory.search' },
  { id: 'vision', labelKey: 'agentCategory.vision' },
  { id: 'content', labelKey: 'agentCategory.content' },
  { id: 'media', labelKey: 'agentCategory.media' },
  { id: AGENT_CATEGORY_UNCATEGORIZED, labelKey: 'agentCategory.general' },
];

/** 分类 id 是否为内置分类 */
export function isBuiltinCategory(categoryId: string): boolean {
  return BUILTIN_AGENT_CATEGORIES.some(category => category.id === categoryId);
}

/**
 * 分类选择器中「自定义分类」选项的哨兵值（仅存在于编辑表单态，永不入库；
 * 与任何真实分类 id 不冲突）。智能体与技能的编辑器共用此哨兵——
 * 分类规范（注册表 / 归一化 / 哨兵）在两处必须完全一致，故收敛于本模块。
 */
export const CATEGORY_CUSTOM_VALUE = '__custom__';

/** 分类 id → i18n 显示键；未知（自定义）分类返回 null，UI 原样展示 id */
export function getCategoryLabelKey(categoryId: string): string | null {
  const builtin = BUILTIN_AGENT_CATEGORIES.find(category => category.id === categoryId);
  return builtin ? builtin.labelKey : null;
}

/**
 * 分类显示名解析：内置分类经 labelKey 交给调用方注入的 i18n 函数，
 * 自定义分类与未分类直接展示 id。
 * 通过注入 resolve 保持本层零 i18n 依赖（utils 层不感知 vue-i18n）。
 */
export function categoryLabelOf(
  categoryId: string,
  resolve: (labelKey: string) => string,
): string {
  const id = categoryId || AGENT_CATEGORY_UNCATEGORIZED;
  const key = getCategoryLabelKey(id);
  return key ? resolve(key) : id;
}

/** 分类分组（选择器/管理页共用的展示结构） */
export interface AgentCategoryGroup {
  /** 分类 id（未分类统一落在 AGENT_CATEGORY_UNCATEGORIZED 组） */
  categoryId: string;
  /** 内置分类的 i18n 显示键；自定义分类为 null（UI 直接展示 categoryId） */
  labelKey: string | null;
  /** 组内智能体（按名称稳定排序，已按分组顺序排列） */
  agents: AgentConfig[];
}

// ==================== 领域对象 ====================

/** 视觉运行配置：声明后该智能体进入「截图 → 多模态消息 → 工具后重截图」循环 */
export interface VisionRuntimeConfig {
  /** 统一原始视口截图；vision_gui(action="mark") 请求下一张截图附带数字框 */
  screenshotTool: 'screenshot';
  /** 截图工具参数 */
  screenshotArgs: Record<string, unknown>;
  /**
   * 每轮工具成功执行后重截图并注入合成多模态用户消息。
   * 恒为 true（视觉循环的心跳，不可关闭）——字段保留只为兼容存量存储结构，
   * 归一化见 normalizeVision。
   */
  reScreenshotAfterTools: boolean;
}

/**
 * 智能体展示文案（随界面语言切换的「显示形态」）。
 *
 * 与 AgentConfig 顶层 name/description/tags 的关系：
 *   - 顶层字段是「规范值」：既是存储键（name）、也是默认语言的展示文案；
 *   - 本结构承载**非默认语言**的展示文案，按语言键索引。
 * 因此规范值永远存在（自定义智能体只有规范值），切换语言时缺项自然回落规范值，
 * 无需任何「按语言重建对象」的逻辑。
 */
export interface AgentDisplayText {
  /** 用户可见名称（非默认语言用；默认语言用 AgentConfig.name） */
  name: string;
  /** 用户可见描述（非默认语言用；默认语言用 AgentConfig.description） */
  description: string;
  /** 用户可见标签（非默认语言用；默认语言用 AgentConfig.tags） */
  tags: string[];
}

/**
 * 预置智能体的多语言展示文案表。
 *
 * 与自定义智能体的区别：预置智能体的文案由代码维护、随产品发布，
 * 因此要求「除默认语言外的每种语言都必须提供文案」——新增语言时编译期即暴露缺口，
 * 而不是运行时静默回落成中文。
 */
export type PresetDisplayTexts = Record<NonDefaultLocale, AgentDisplayText>;

/**
 * 预置智能体配置：与自定义智能体的唯一差别是 display 必填。
 *
 * 因此「每个预置智能体都必须提供全部非默认语言的文案」是编译期约束：
 * 新增预置忘了写英文 → 编译报错；新增语言忘了给预置补文案 → 同样编译报错。
 */
export type PresetAgentConfig = AgentConfig & { display: PresetDisplayTexts };

/**
 * 智能体配置（预置与自定义共用的领域对象）。
 *
 * 身份字段：id（机器标识，跨版本稳定，用于预置判定与按 id 引用）、name（用户可见名称，
 * 同时是存储键）。二者均不参与归一化改写——改写会破坏已持久化的引用（会话元信息、
 * 用户记忆）。
 *
 * 注意：曾经存在的 `settings`（temperature / maxTokens / enableStreaming）已彻底移除：
 * 采样参数统一取用户全局 API 配置，流式恒开启，该字段没有任何读取方，保留只会
 * 误导配置者并制造「改了没生效」的假象。
 */
export interface AgentConfig {
  plugin?: { key: string; version: string; displayName: string; publisher: string };
  /** 机器标识（预置为固定常量；自定义由名称生成的 ASCII slug，保证唯一） */
  id: string;
  /** 用户可见名称（存储键；唯一） */
  name: string;
  /** 描述：做什么 + 何时使用（供模型与用户选择时判断） */
  description: string;
  /** 系统提示词 */
  system: string;
  /** 工具 ID 列表（去重） */
  tools: string[];
  /**
   * 关联技能引用列表（去重；元素为技能 id / 名称 / 模型标识，经
   * skill-availability.resolveSkill 三态解析）。可选：未声明 = 仅靠工具映射
   * 兜底决定可用技能。预置与自定义智能体均可声明。
   */
  skills?: string[];
  /** 分类 id（单个）；空串 = 未分类，展示与筛选时归入 general */
  category: string;
  /**
   * 启用状态：缺省 = 启用（默认全部启用）。
   * 停用的智能体不出现在输入框的 @ 选择器中（不可被选中），
   * 但仍可在管理中心查看 / 编辑 / 重新启用。
   */
  enabled?: boolean;
  /** 标签（多个；保序去重，用于选择器过滤与管理页检索） */
  tags: string[];
  /**
   * 预置智能体的多语言展示文案（默认语言沿用上方规范值，此处只放其余语言）。
   * 自定义智能体不声明本字段——其文案由用户自行撰写，不随界面语言变化。
   */
  display?: PresetDisplayTexts;
  /** 视觉运行配置：缺省 = 纯文本对话 */
  vision?: VisionRuntimeConfig;
  /**
   * 头像：图片或 emoji（预置与自定义智能体一致支持）。
   * 缺省 = 无头像，由 UI 回退默认 emoji。
   */
  avatar?: AgentAvatar;
  /**
   * 能力协商声明（影响系统提示词装配，不影响工具集与渲染层）。
   *
   * richComponents：富内容组件白名单（rich-components/registry.ts 的组件 id，
   * 如 ['chart','stat','table','timeline','tree','insight','diagram','diff']）：
   *   - 缺省 = 默认全集（与历史行为一致）；
   *   - 声明 = 只在 <rich-output-guidelines> 分区中教模型使用这些组件
   *     （分区正文由 rich-components/rich-output-prompt.ts 维护），
   *     未知 id 装配时剔除并告警；空数组 = 整段不注入（0 提示词开销）。
   * 只裁剪「教什么」，不裁剪「能渲染什么」——历史消息里的组件在任何
   * 会话中都必须继续可渲染。
   */
  capabilities?: {
    richComponents?: readonly string[];
  };
}

/**
 * 取智能体在指定语言下的展示文案。
 *
 * 回落规则（自上而下）：
 *   1. 该语言的展示文案（预置智能体的 display[locale]）；
 *   2. 规范值（顶层 name/description/tags，即默认语言文案）。
 * 自定义智能体没有 display，永远取规范值——它们的文案由用户自行撰写，
 * 不应随界面语言变化。
 *
 * 纯函数（不依赖 vue-i18n）：调用方传入当前语言，切换语言时重新求值即可。
 */
export function agentDisplayOf(
  agent: AgentConfig,
  locale: Locale,
): { name: string; description: string; tags: string[] } {
  // display 只收录非默认语言，默认语言直接用规范值——故此处取不到即回落
  const localized = locale === DEFAULT_LOCALE ? undefined : agent.display?.[locale as NonDefaultLocale];
  return {
    name: localized?.name ?? agent.name,
    description: localized?.description ?? agent.description,
    tags: localized?.tags ?? agent.tags,
  };
}

/**
 * 智能体头像。
 *
 * 两种形态：
 *   - image：src 指向图片（扩展内相对路径如 /agent/action.png、绝对 http(s) URL 或 data: URL）
 *   - emoji：value 为 emoji 字符（可含变体选择符 / ZWJ 组合）
 *
 * 不使用 SVG path：图标路径无法表达用户自定义形象，也无法承载图片；
 * 统一收敛为「图片地址 或 emoji」后，预置、自定义、导入三条来源共用同一套渲染逻辑。
 */
export type AgentAvatar =
  | { type: 'image'; src: string }
  | { type: 'emoji'; value: string };

/** 图片形态头像（单独命名以便按形态窄化后仍保留可辨识的类型名） */
export type AgentImageAvatar = { type: 'image'; src: string };
/** emoji 形态头像（单独命名以便按形态窄化后仍保留可辨识的类型名） */
export type AgentEmojiAvatar = { type: 'emoji'; value: string };

// ==================== 不变量常量 ====================

/** 名称长度上限（与 hub 表单 maxlength 一致，写入层兜底钳制） */
export const AGENT_NAME_MAX_CHARS = 32;
/** 描述长度上限 */
export const AGENT_DESCRIPTION_MAX_CHARS = 120;
/** 系统提示词长度上限（字符；防御异常大的写入撑爆 chrome.storage） */
export const AGENT_SYSTEM_MAX_CHARS = 20_000;
/** 标签数量上限 */
export const AGENT_TAGS_MAX_COUNT = 8;
/** 单个标签长度上限 */
export const AGENT_TAG_MAX_CHARS = 16;
/** 分类 id 长度上限 */
export const AGENT_CATEGORY_MAX_CHARS = 24;
/** 工具数量上限（与 hub 的组并集上限同数量级，这里只做存储层兜底） */
export const AGENT_TOOLS_MAX_COUNT = 200;
/** 单个工具 ID 长度上限 */
export const AGENT_TOOL_ID_MAX_CHARS = 256;
/** 关联技能数量上限 */
export const AGENT_SKILLS_MAX_COUNT = 20;
/** 单个技能引用（id / 名称 / 模型标识）长度上限 */
export const AGENT_SKILL_REF_MAX_CHARS = 256;
/** 生成的自定义智能体 id 前缀（名称无 ASCII 字符时的兜底基名） */
export const AGENT_ID_FALLBACK_BASE = 'agent';

/**
 * 图片头像地址长度上限（data URL 会远大于普通路径，故给足额度）。
 * 上传头像经 avatar-image 压缩到 1MB 内：1MB 字节的 base64 约 1.4M 字符，
 * 上限取 1.5M 字符留出 data URL 前缀余量，与 AGENT_AVATAR_MAX_BYTES 配套。
 */
export const AGENT_AVATAR_IMAGE_MAX_CHARS = 1_500_000;
/** emoji 头像长度上限（容纳 ZWJ / 变体选择符等组合序列） */
export const AGENT_AVATAR_EMOJI_MAX_CHARS = 16;

/**
 * 无头像智能体的兜底 emoji。
 * 用 emoji 而非 SVG 图标：与「图片或 emoji」的头像模型保持同一形态，
 * 渲染层只有一条分支，且不会出现图标盒内的空白色块。
 */
export const DEFAULT_AGENT_AVATAR: AgentEmojiAvatar = { type: 'emoji', value: '🤖' };

/**
 * 内置头像图片清单（public/agent 下的静态资源）。
 * 预置智能体从这里挑头像；自定义智能体的编辑器不再提供预置选择，
 * 改为「上传图片 / 选择 emoji」两条通道（见 hub 的头像选择器）。
 */
export interface BuiltinAgentAvatar {
  /** 稳定 id（存储于 AgentAvatar.src 的绝对路径片段） */
  id: string;
  /** 扩展内相对路径（以 / 开头，解析为 chrome-extension://<id>/agent/xxx.png） */
  src: string;
}

/** 内置头像图片清单（展示顺序即选择器中的排列顺序） */
export const BUILTIN_AGENT_AVATARS: readonly BuiltinAgentAvatar[] = Object.freeze([
  { id: 'action', src: '/agent/action.png' },
  { id: 'vision', src: '/agent/vision.png' },
  { id: 'data', src: '/agent/data.png' },
  { id: 'deep_search', src: '/agent/deep_search.png' },
  { id: 'bilibili', src: '/agent/bilibili.png' },
  { id: 'excalidraw', src: '/agent/excalidraw.png' },
]);

// ==================== 归一化（任意输入 → 合规值，绝不抛错） ====================

/** 截断到上限；非字符串返回空串 */
function clampText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

/** 分类归一化：去首尾空白 + 长度钳制；非法输入回落空串（未分类） */
export function normalizeCategory(value: unknown): string {
  const text = clampText(value, AGENT_CATEGORY_MAX_CHARS);
  // 分类 id 会被拼进选择器的过滤匹配，排除空白字符避免出现不可见分类
  return text.replace(/\s+/g, '-');
}

/**
 * 标签归一化：逐项去空白 + 单项长度钳制 + 去重保序 + 数量上限。
 * 空白标签直接丢弃（用户输入 "a,,b" 或 "a b" 不应产生噪音标签）。
 */
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value) {
    if (result.length >= AGENT_TAGS_MAX_COUNT) break;
    const tag = clampText(raw, AGENT_TAG_MAX_CHARS);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

/** 工具 ID 列表归一化：去空白项 + 长度钳制 + 去重保序 + 数量上限 */
export function normalizeToolIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value) {
    if (result.length >= AGENT_TOOLS_MAX_COUNT) break;
    if (typeof raw === 'string' && raw.startsWith('ed25519:') && (raw.length > AGENT_TOOL_ID_MAX_CHARS || !/^ed25519:[a-z2-7]{52}\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw))) continue;
    const toolId = clampText(raw, AGENT_TOOL_ID_MAX_CHARS);
    if (!toolId) continue;
    if (seen.has(toolId)) continue;
    seen.add(toolId);
    result.push(toolId);
  }
  return result;
}

/**
 * 关联技能引用归一化：与工具列表同构（去空白 + 钳制 + 去重保序 + 上限）。
 * 元素保留原样（可能是 id / 名称 / 模型标识），存在性与启停由可用性层解析——
 * 挂死引用（技能被删）不在此处剔除，保证「先删技能后改智能体」的中间态
 * 数据不丢失，用户重新创建同名技能即自动恢复关联。
 */
export function normalizeSkillRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value) {
    if (result.length >= AGENT_SKILLS_MAX_COUNT) break;
    if (typeof raw === 'string' && raw.startsWith('ed25519:') && (raw.length > AGENT_SKILL_REF_MAX_CHARS || !/^ed25519:[a-z2-7]{52}\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw))) continue;
    const ref = clampText(raw, AGENT_SKILL_REF_MAX_CHARS);
    if (!ref) continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    result.push(ref);
  }
  return result;
}

/** 视觉配置归一化：结构不完整时返回 undefined（= 不启用视觉循环）
 *
 * reScreenshotAfterTools 恒为 true：它是视觉循环的心跳（工具批次结束后自动
 * 回传新视口截图），关掉后模型既看不见自己刚操作的页面，手势消耗掉的
 * screenshotId 也没有新的来源——而注入给模型的视觉规程无条件承诺「工具结束后
 * 约 3 秒回传新截图」。该开关已从管理中心移除，存量记录里的 false 在此收口。
 */
export function normalizeVision(value: unknown): VisionRuntimeConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<VisionRuntimeConfig>;
  const screenshotTool = 'screenshot' as const;
  const args =
    candidate.screenshotArgs && typeof candidate.screenshotArgs === 'object' && !Array.isArray(candidate.screenshotArgs)
      ? (candidate.screenshotArgs as Record<string, unknown>)
      : {};
  return {
    screenshotTool,
    screenshotArgs: args,
    reScreenshotAfterTools: true,
  };
}

/**
 * 头像归一化：任意输入 → 合规 AgentAvatar（缺省返回 undefined = 无头像）。
 *
 * 兼容两种历史写法，保证旧数据不被丢弃：
 *   - { type: 'image', src } / { type: 'emoji', value }：当前结构
 *   - 纯字符串：按「看起来是图片地址 → 图片，否则 → emoji」判定
 *     （旧版本曾用单字符串存过 icon 语义，避免整条头像丢失）
 */
export function normalizeAvatar(value: unknown): AgentAvatar | undefined {
  if (value === null || value === undefined) return undefined;

  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return undefined;
    if (text.length > AGENT_AVATAR_IMAGE_MAX_CHARS) return undefined;
    // 以 / 开头、含协议或以常见图片扩展名结尾 → 视为图片地址
    const looksLikeImage =
      text.startsWith('/') ||
      /^(data:image\/|https?:\/\/|chrome-extension:\/\/)/i.test(text) ||
      /\.(png|jpe?g|gif|webp|svg|bmp|ico)(\?.*)?$/i.test(text);
    return looksLikeImage
      ? { type: 'image', src: text }
      : { type: 'emoji', value: text.slice(0, AGENT_AVATAR_EMOJI_MAX_CHARS) };
  }

  if (typeof value !== 'object') return undefined;
  const candidate = value as Partial<AgentAvatar> & { type?: string; src?: unknown; value?: unknown };

  if (candidate.type === 'image') {
    const src = clampText(candidate.src, AGENT_AVATAR_IMAGE_MAX_CHARS);
    return src ? { type: 'image', src } : undefined;
  }
  if (candidate.type === 'emoji') {
    const emoji = clampText(candidate.value, AGENT_AVATAR_EMOJI_MAX_CHARS);
    return emoji ? { type: 'emoji', value: emoji } : undefined;
  }
  // type 缺失但带 src/value 时按内容推断，避免外部导入的结构差异导致头像丢失
  if (typeof candidate.src === 'string' && candidate.src.trim()) {
    return { type: 'image', src: candidate.src.trim() };
  }
  if (typeof candidate.value === 'string' && candidate.value.trim()) {
    return { type: 'emoji', value: candidate.value.trim() };
  }
  return undefined;
}

/**
 * 多语言展示文案归一化：校验「每个非默认语言都齐备 name/description/tags」。
 * 缺任一语言或字段类型不对 → 整体丢弃（回落默认语言文案），不做半吊子修补。
 */
function normalizeDisplayTexts(value: unknown): PresetDisplayTexts | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result: Partial<Record<NonDefaultLocale, AgentDisplayText>> = {};
  for (const locale of NON_DEFAULT_LOCALES) {
    const entry = source[locale];
    if (!entry || typeof entry !== 'object') return undefined;
    const { name, description, tags } = entry as Partial<AgentDisplayText>;
    if (typeof name !== 'string' || typeof description !== 'string' || !Array.isArray(tags)) return undefined;
    const normalizedTags = normalizeTags(tags);
    if (normalizedTags.length !== tags.length) return undefined;
    result[locale] = { name, description, tags: normalizedTags };
  }
  return result as PresetDisplayTexts;
}

/**
 * 持久化记录 → 合规 AgentConfig；结构性缺失（id/name/system）返回 null。
 *
 * 校验策略：身份字段（id/name）只校验不改写；其余字段一律收敛（钳制/去重/默认值）。
 * 这样旧版本数据、跨上下文同步的中间态、外部写入的脏数据都能被安全接纳，
 * 而不是整条丢弃导致用户智能体凭空消失。
 */
export function normalizeAgentConfig(value: unknown): AgentConfig | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<AgentConfig>;
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  const system = typeof candidate.system === 'string' ? candidate.system : '';
  // 结构性缺失不可修复：没有 id 无法参与预置判定与引用，没有名称无法定位存储键
  if (!id || !name || !system) return null;

  const config: AgentConfig = {
    id,
    name,
    description: clampText(candidate.description, AGENT_DESCRIPTION_MAX_CHARS),
    system: system.length > AGENT_SYSTEM_MAX_CHARS ? system.slice(0, AGENT_SYSTEM_MAX_CHARS) : system,
    // vision_gui 不属于可持久化的工具选择面：它是「视觉操作」开关（AgentConfig.vision）
    // 在运行时注入的受控能力（见 runtime-builder「视觉操作开关注入」），工具组也从不
    // 提供勾选入口——存量记录里的历史勾选残留（旧版界面 / 外部写入）在本收敛点统一
    // 剔除，保证「存储的 tools 恒不含 vision_gui」。数据层归一之外，装配层另有一道
    // 兜底（插件智能体与预置表不经过本函数），两层共同维护该不变量。
    tools: normalizeToolIds(candidate.tools).filter(toolId => toolId !== VISION_GUI_TOOL_ID && !isSkillToolId(toolId)),
    category: normalizeCategory(candidate.category),
    tags: normalizeTags(candidate.tags),
  };
  const skills = normalizeSkillRefs(candidate.skills);
  if (skills.length > 0) config.skills = skills;
  const display = normalizeDisplayTexts(candidate.display);
  if (display) config.display = display;
  const vision = normalizeVision(candidate.vision);
  if (vision) config.vision = vision;
  const avatar = normalizeAvatar(candidate.avatar);
  if (avatar) config.avatar = avatar;
  // 启用态：缺省 = 启用；仅显式 false 才记录（避免给每条记录塞 true 噪音）
  if (candidate.enabled === false) config.enabled = false;
  return config;
}

// ==================== 排序与分组 ====================

/**
 * 智能体稳定排序：名称字典序（数字/字母优先，中文按 Unicode 码点）。
 * 所有列表视图统一走此排序，保证同一份数据在 hub 与 sidepanel 呈现一致顺序，
 * 也避免恢复顺序差异导致的「列表顺序每次打开都变」。
 */
export function compareAgents(a: AgentConfig, b: AgentConfig): number {
  return a.name.localeCompare(b.name, 'zh-Hans-CN');
}

/**
 * 过滤出「可被选中」的智能体（enabled 不为 false）。
 * 停用 = 不可被选中：侧边栏输入框的 @ 选择器只列启用中的智能体，
 * 管理中心仍展示全部（便于查看与重新启用）。
 */
export function filterEnabledAgents(agents: readonly AgentConfig[]): AgentConfig[] {
  return agents.filter(agent => agent.enabled !== false);
}

/**
 * 按分类分组（内置分类按注册顺序在前，自定义分类按 id 字典序在后）。
 * 未分类智能体统一落在 general 组；空组不返回，避免 UI 出现空标题。
 */
export function groupAgentsByCategory(agents: readonly AgentConfig[]): AgentCategoryGroup[] {
  const buckets = new Map<string, AgentConfig[]>();
  for (const agent of agents) {
    const categoryId = agent.category || AGENT_CATEGORY_UNCATEGORIZED;
    const bucket = buckets.get(categoryId);
    if (bucket) bucket.push(agent);
    else buckets.set(categoryId, [agent]);
  }

  const orderedIds = [
    ...BUILTIN_AGENT_CATEGORIES.map(category => category.id),
    ...[...buckets.keys()].filter(id => !isBuiltinCategory(id)).sort(),
  ];

  const groups: AgentCategoryGroup[] = [];
  for (const categoryId of orderedIds) {
    const bucket = buckets.get(categoryId);
    if (!bucket || bucket.length === 0) continue;
    groups.push({
      categoryId,
      labelKey: getCategoryLabelKey(categoryId),
      agents: [...bucket].sort(compareAgents),
    });
  }
  return groups;
}

// ==================== ID 生成 ====================

/**
 * 由名称生成 ASCII slug 作为自定义智能体 id。
 *
 * 规则：仅保留 ASCII 字母数字并转小写，连续分隔符折叠为单个 '-'；
 * 纯中文等无 ASCII 字符的名称回落到 `${AGENT_ID_FALLBACK_BASE}-<时间戳36进制><随机>`，
 * 保证 id 始终可用于 URL / 文件名 / 正则等后续场景（原始中文 id 会踩编码坑）。
 *
 * @param isTaken 判定候选 id 是否已被占用（调用方注入，保持本函数纯净）；
 *   缺省视为不占用。命中时追加序号直至唯一。
 */
export function generateAgentId(name: string, isTaken?: (candidate: string) => boolean): string {
  const base =
    (typeof name === 'string' ? name : '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || AGENT_ID_FALLBACK_BASE;

  const taken = isTaken ?? (() => false);
  let candidate = base;
  let counter = 1;
  while (taken(candidate)) {
    counter += 1;
    candidate = `${base}-${counter}`;
    // 极端防御：理论上名称唯一性已保证有限次收敛，仍设置硬上限防止脏数据造成死循环
    if (counter > 1000) {
      candidate = `${base}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      break;
    }
  }
  return candidate;
}
