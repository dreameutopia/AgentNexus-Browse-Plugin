/**
 * 笔记相关类型定义（单一事实来源）
 *
 * 统一模型：已保存的网页（kind='webpage'）与用户/AI 创建的笔记（kind='note'）
 * 共用同一实体，由存储层（utils/notes-database）作为唯一实现方：
 * - content 为 Tiptap（ProseMirror）HTML 正文，编辑器直接读写；
 * - text 为写入时派生的纯文本（预览 / 搜索 / get_note_content 共用，
 *   同时保证 base64 图片数据不会进入模型上下文）；
 * - category 为单个分类（'inbox'/'ai' 为保留 ID，其余字符串原样展示）；
 * - source 仅网页剪藏携带（原始网址 + 站点图标）。
 * createdAt / updatedAt 为 ISO 8601 字符串。
 */

/** 笔记形态：普通笔记 / 网页剪藏 */
export type NoteKind = 'note' | 'webpage';

/** 网页剪藏来源信息 */
export interface NoteSource {
  url: string;
  favicon?: string;
}

export interface Note {
  id: string;
  kind: NoteKind;
  title: string;
  /** Tiptap HTML 正文 */
  content: string;
  /** 派生纯文本（随 content 写入时同步提取） */
  text: string;
  category: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** 仅 kind='webpage' 时存在 */
  source?: NoteSource;
}
