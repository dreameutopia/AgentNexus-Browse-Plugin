/**
 * 会话标签（Conversation Tag）
 *
 * 设计约束：
 * - 一个会话可携带多个标签，标签是**会话自身的元信息**，不参与模型上下文；
 * - 内置标签只存稳定 id，展示文案走 i18n（切换语言后标签随之切换）；
 * - 自定义标签存用户输入的文本，展示时原样输出，不做翻译；
 * - 所有写入都必须经过 normalizeConversationTags：去空、去重、限长、限数量，
 *   防止脏数据或异常输入把会话元信息撑大或制造重复标签。
 */

/** 内置「学习」标签 id（展示文案见 i18n：sidepanel.conversationTags.learn） */
export const LEARN_CONVERSATION_TAG_ID = 'learn';

/** 单个会话最多保留的标签数 */
export const MAX_CONVERSATION_TAGS = 8;

/** 自定义标签文本上限（字符） */
export const MAX_CONVERSATION_TAG_LABEL_LENGTH = 24;

/** 标签 id 上限（防御异常数据） */
const MAX_CONVERSATION_TAG_ID_LENGTH = 64;

/** 会话标签：id 稳定；内置标签无 label，自定义标签带用户文本 */
export interface ConversationTag {
  id: string;
  /** 自定义标签的用户文本；内置标签缺省（由 i18n 提供） */
  label?: string;
}

/** 内置「学习」标签（新建学习会话时写入） */
export const LEARN_CONVERSATION_TAG: ConversationTag = Object.freeze({
  id: LEARN_CONVERSATION_TAG_ID,
});

/** 是否为内置系统标签 */
export function isSystemConversationTag(tag: ConversationTag): boolean {
  return tag.id === LEARN_CONVERSATION_TAG_ID;
}

/** 归一化单个标签文本：合并空白、去首尾、按码点截断（避免截断 emoji 代理对） */
export function normalizeConversationTagLabel(value: unknown): string {
  if (typeof value !== 'string') return '';
  const compact = value.replace(/\s+/g, ' ').trim();
  return Array.from(compact).slice(0, MAX_CONVERSATION_TAG_LABEL_LENGTH).join('');
}

/**
 * 归一化标签集合（唯一写入口）。
 *
 * 规则：
 * - 只接受对象数组；非法项静默丢弃（标签是增强信息，不应阻断会话操作）；
 * - 内置标签按 id 去重，且不允许用户伪造 label；
 * - 自定义标签要求非空文本，按 id 与文本双重去重（大小写不敏感）；
 * - 保持输入顺序，最多保留 MAX_CONVERSATION_TAGS 个。
 */
export function normalizeConversationTags(value: unknown): ConversationTag[] {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  const result: ConversationTag[] = [];

  for (const raw of value) {
    if (result.length >= MAX_CONVERSATION_TAGS) break;
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as { id?: unknown; label?: unknown };
    const id = typeof candidate.id === 'string' ? candidate.id.trim().slice(0, MAX_CONVERSATION_TAG_ID_LENGTH) : '';
    if (!id || seenIds.has(id)) continue;

    if (id === LEARN_CONVERSATION_TAG_ID) {
      seenIds.add(id);
      result.push({ id: LEARN_CONVERSATION_TAG_ID });
      continue;
    }

    const label = normalizeConversationTagLabel(candidate.label);
    if (!label) continue;
    const labelKey = label.toLowerCase();
    if (seenLabels.has(labelKey)) continue;

    seenIds.add(id);
    seenLabels.add(labelKey);
    result.push({ id, label });
  }

  return result;
}

/** 由用户输入创建一条自定义标签（空文本返回 null） */
export function createCustomConversationTag(label: unknown): ConversationTag | null {
  const normalized = normalizeConversationTagLabel(label);
  if (!normalized) return null;
  const random = Math.random().toString(36).slice(2, 8);
  return {
    id: `tag_${Date.now().toString(36)}_${random}`,
    label: normalized,
  };
}

/**
 * 追加一条自定义标签（用于编辑器的「添加」动作）。
 * 已存在同文本标签时返回原数组引用，便于调用方判定是否发生变化。
 */
export function appendConversationTag(
  tags: readonly ConversationTag[],
  label: unknown,
): ConversationTag[] {
  const normalized = normalizeConversationTagLabel(label);
  if (!normalized) return [...tags];
  const labelKey = normalized.toLowerCase();
  if (tags.some(tag => tag.label && tag.label.toLowerCase() === labelKey)) {
    return [...tags];
  }
  const created = createCustomConversationTag(normalized);
  if (!created) return [...tags];
  return normalizeConversationTags([...tags, created]);
}
