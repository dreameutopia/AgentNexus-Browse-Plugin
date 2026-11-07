/**
 * 会话上传文件引擎（ConversationFileStore）
 *
 * 用户上传文件全生命周期的统一管理入口（sidepanel 上传侧注册 + background
 * worker 内 read_file 分页读取，IndexedDB 在两个上下文同源可用）：
 *   1. 注册：提取后的纯文本 → 分页元信息（确定性算法）→ 8 位短 id → 落库；
 *   2. 读取：read_file(file_id, page) 按页取正文——页边界每次从正文现算
 *      （skill-pagination 的确定性保证：同文本恒同页，信封内预览的第 1 页
 *      与工具读取的第 1 页逐字一致，模型按页码续读不会错位）；
 *   3. 生命周期：随会话级联清理（session-deletion-engine 调 deleteByChat）。
 *
 * 分页预算与技能分页（skill-pagination）同一实现、同一 token 口径
 * （utils/ai/token-estimate 启发式）——「每页约 N token」的声称与上下文
 * 窗口计量不会漂移。
 *
 * 防御性：
 *   - 短 id 撞车由主键 add 的 ConstraintError 兜底（换候选重试，上限 8 次）；
 *   - 正文长度钳制（超限直接拒绝注册：这是上传侧解析层的契约违反，
 *     绝不静默截断——截断会让信封页码与工具页码错位）；
 *   - 任意读路径失败返回 null / 可读错误，绝不抛裸 IDB 异常击穿工具链。
 */

import { fileDatabase, type StoredConversationFile } from './file-database';
import {
  countSkillChars,
  paginateSkillText,
  SKILL_PAGE_TOKEN_BUDGET,
} from '@/utils/skills/skill-pagination';
import {
  generateShortId,
  isShortIdConstraintError,
  SHORT_ID_PATTERN,
} from '@/utils/shared/short-id';

/**
 * 上传文件单页 token 预算（与技能分页共用同一常量与算法实现）。
 * 3000 token/页 ≈ 12K 拉丁字符或 3K 中文字符：单页足以承载一章正文 /
 * 一段代码，又不至于一次读取挤占可观窗口。
 */
export const FILE_PAGE_TOKEN_BUDGET = SKILL_PAGE_TOKEN_BUDGET;

/** 单个文件提取文本的码点数上限（防御脏调用方；正常链路上传侧已解析成功） */
export const FILE_MAX_CHARS = 20 * 1024 * 1024;

/** 8 位文件短 id 形态（唯一实现在 utils/shared/short-id；再导出保持既有导入方稳定） */
export const FILE_ID_PATTERN = SHORT_ID_PATTERN;

/** 短 id 分配的最大重试次数（主键冲突时换候选重试） */
const FILE_ID_MAX_ATTEMPTS = 8;

/** 注册入参（元信息由上传侧分类解析产出） */
export interface RegisterFileMeta {
  name: string;
  ext: string;
  source: 'plain' | 'office';
  mimeType: string;
  sizeBytes: number;
}

/** 单页读取结果（paginateSkillText 的 ok 分支 + 文件元信息） */
export interface FilePageRead {
  file: Pick<StoredConversationFile, 'id' | 'name' | 'ext' | 'source'>;
  page: number;
  pageCount: number;
  totalChars: number;
  currentChars: number;
  remainingChars: number;
  content: string;
}

/** 页码越界（调用方据此给出可自纠的报错文案） */
export class FilePageOutOfRangeError extends Error {
  readonly pageCount: number;
  constructor(pageCount: number) {
    super(`页码越界：全文共 ${pageCount} 页`);
    this.name = 'FilePageOutOfRangeError';
    this.pageCount = pageCount;
  }
}

class ConversationFileStore {
  /**
   * 注册一个上传文件（分配 8 位短 id，计算分页元信息，落库）。
   * 正文超长（> FILE_MAX_CHARS 码点）抛错拒绝——截断会造成信封与工具页码
   * 错位，宁可失败让上传侧给出可读提示。
   */
  async register(
    chatId: string,
    meta: RegisterFileMeta,
    text: string,
  ): Promise<StoredConversationFile> {
    if (!chatId) throw new Error('注册上传文件失败：缺少会话标识（chatId）');
    if (typeof text !== 'string') throw new Error('注册上传文件失败：正文不是字符串');
    const charCount = countSkillChars(text);
    if (charCount === 0) throw new Error('注册上传文件失败：正文为空（空文档不应进入注册）');
    if (charCount > FILE_MAX_CHARS) {
      throw new Error(`注册上传文件失败：正文 ${charCount} 码点超过上限 ${FILE_MAX_CHARS}`);
    }
    // 第 1 页现算：totalPages 与信封预览同一次产出（确定性，读路径恒可复算）
    const first = paginateSkillText(text, 1, FILE_PAGE_TOKEN_BUDGET);
    if (!first.ok) throw new Error('注册上传文件失败：分页计算异常（正文非空却无页）');

    const base = {
      chatId,
      name: meta.name,
      ext: meta.ext,
      source: meta.source,
      mimeType: meta.mimeType,
      sizeBytes: meta.sizeBytes,
      charCount,
      totalPages: first.page.pageCount,
      createdAt: Date.now(),
      text,
    };

    let lastError: unknown;
    for (let attempt = 0; attempt < FILE_ID_MAX_ATTEMPTS; attempt++) {
      const record: StoredConversationFile = { id: generateShortId(), ...base };
      try {
        await fileDatabase.add(record);
        return record;
      } catch (error) {
        if (!isShortIdConstraintError(error)) {
          // 存储层真实故障：包裹为可分析的可读错误（裸 DOMException 对调用方不可定位）
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`注册上传文件失败：写入文件库失败: ${reason}`);
        }
        lastError = error;
      }
    }
    throw new Error(`注册上传文件失败：短 id 分配撞车（${FILE_ID_MAX_ATTEMPTS} 次后放弃）: ${String(lastError)}`);
  }

  /**
   * 按 id 取完整记录。
   * @returns 记录不存在返回 null；**存储层故障上抛**（区别于「不存在」——
   *   把故障误报成「文件不存在」会误导调用方走清理/自纠分支）
   */
  async get(id: string): Promise<StoredConversationFile | null> {
    if (!FILE_ID_PATTERN.test(id)) return null;
    try {
      return await fileDatabase.get(id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`读取上传文件 ${id} 失败: ${reason}`);
    }
  }

  /**
   * 分页读取正文（read_file 工具的读取入口；**会话严格隔离**）。
   * 记录不存在或属于其它会话一律返回 null——跨会话判定在存储层兜底，
   * 绝不把其它会话的文件内容泄漏给调用方。
   * @throws FilePageOutOfRangeError 页码大于总页数（含总页数供自纠文案）
   * @throws Error 存储层故障（get 的可读包裹上抛，调用方据此与「不存在」分诊）
   */
  async readPage(
    chatId: string,
    id: string,
    requestedPage: number,
  ): Promise<FilePageRead | null> {
    if (!chatId || !FILE_ID_PATTERN.test(id)) return null;
    const file = await this.get(id);
    if (!file || file.chatId !== chatId) return null;
    const result = paginateSkillText(file.text, requestedPage, FILE_PAGE_TOKEN_BUDGET);
    if (!result.ok) throw new FilePageOutOfRangeError(result.pageCount);
    return {
      file: { id: file.id, name: file.name, ext: file.ext, source: file.source },
      page: result.page.page,
      pageCount: result.page.pageCount,
      totalChars: result.page.totalChars,
      currentChars: result.page.currentChars,
      remainingChars: result.page.remainingChars,
      content: result.page.content,
    };
  }

  /** 按会话列出全部已注册文件（注册时间升序；自纠清单 / 信封装配用） */
  async listByChat(chatId: string): Promise<StoredConversationFile[]> {
    try {
      return await fileDatabase.listByChat(chatId);
    } catch (error) {
      console.warn('[ConversationFileStore] 列出会话文件失败:', chatId, error);
      return [];
    }
  }

  /** 删除一个会话的全部文件（会话删除级联清理；返回删除条数，失败为 0） */
  async deleteByChat(chatId: string): Promise<number> {
    try {
      return await fileDatabase.deleteByChat(chatId);
    } catch (error) {
      console.warn('[ConversationFileStore] 清理会话文件失败:', chatId, error);
      return 0;
    }
  }

  /** 清空全部（仅供级联清理 / 测试） */
  async clear(): Promise<void> {
    try {
      await fileDatabase.clear();
    } catch (error) {
      console.warn('[ConversationFileStore] 清空文件库失败:', error);
    }
  }
}

/** 全局单例（sidepanel 与 background worker 各持一份，经 IndexedDB 同源） */
export const conversationFileStore = new ConversationFileStore();

export type { StoredConversationFile };
