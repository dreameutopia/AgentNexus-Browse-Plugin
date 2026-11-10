/**
 * 转录引擎（用户面）
 *
 * 职责：会话生命周期（创建/重命名/删除/列表）与完整渲染记录的追加与落库。
 * 特征：无长度限制、面向用户展示（正文、推理、工具调用全量保存）。
 * 写入策略：流式期间由会话引擎周期性快照 flush，结束时最终 flush；
 * DB 故障时降级为内存态并告警，不阻塞对话主流程——降级同时经
 * onPersistenceIssue 通知订阅方（App 层据此提示用户「对话可能不会保留」），
 * 绝不让数据丢失风险静默发生。
 */

import type { ChatMessageRecord, ChatSessionMeta, ChatSessionKind } from '../types';
import type { MessageFeedback } from '../../types/chat';
import { chatDatabase, chatPreviewOf, type SessionListOptions } from './chat-database';
import { normalizeModelRef, type ModelRef } from '../../utils/channels';
import { imageStore, normalizeImageRefs } from '../images/image-store';
import { prepareProtocolHistory } from './protocol-history';
import type { PageQuote } from '../../utils/chat/page-quote';
import { notifySessionsChanged, type SessionChangeReason } from '@/utils/sessions/session-bridge';

/** 自动标题取用户消息前缀长度 */
const AUTO_TITLE_MAX = 30;
const DEFAULT_TITLE = '新对话';

/** 生成记录 ID（优先 crypto.randomUUID，降级时间戳+随机数） */
function generateId(prefix: string): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${uuid}`;
}

/** 可选文本字段归一化：非字符串 → ''，字符串去首尾空白（空串是合法业务值，见 updateSessionUsage 语义约定） */
function normalizeOptionalText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 名称列表归一化：去空白项 + 去重保序 + 防御非字符串脏数据。
 * 持久化层不校验字段形状（跨版本/外部写入皆可能），写入前统一收敛，
 * 保证下游（技能装配、徽标渲染）拿到的永远是干净的 string[]。
 */
function normalizeNameList(value: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

export interface CreateSessionInput {
  /** 智能体 ID（稳定引用；与 agentName 一同落库，恢复时优先按 id 解析） */
  agentId?: string;
  agentName?: string;
  skillNames?: string[];
  /** 模型引用（稳定 id 对；写入前经 normalizeModelRef 清洗，脏引用落 null） */
  modelRef?: ModelRef | null;
  /** 系统提示词补充段（如 Deep Search 的笔记信息），随会话持久化以便重建同源 systemPrompt */
  systemPromptSuffix?: string;
  /** 会话类型（缺省 = 'chat'；仅接受合法值，脏值一律回落 'chat'） */
  kind?: ChatSessionKind;
}

/** 「模型面有效上下文」读取结果（压缩摘要 + 压缩点之后的记录 + systemPrompt 派生输入） */
export interface EffectiveContext {
  /** 会话压缩摘要（'' = 未压缩） */
  summary: string;
  /** 摘要生成时间（0 = 未压缩） */
  compactedAt: number;
  /** 会话持久化的 systemPrompt 补充段（'' = 无） */
  systemPromptSuffix: string;
  /** 压缩点之后（未压缩时为全部）的用户面记录 */
  records: ChatMessageRecord[];
}

/** 持久化降级事件：哪类操作失败、可读原因（供 UI 告知用户数据可能不保留） */
export interface PersistenceIssue {
  /** 发生降级的操作面 */
  operation: 'message-flush' | 'session-meta' | 'seq-seed';
  /** 可读错误消息 */
  message: string;
}

/**
 * 消息反馈写入结果。
 * 区分「记录本就不存在」（合成消息，预期）与「写入异常」（DB 故障，需告警），
 * 让调用方只对真实失败给出用户可见提示，避免对错误卡片点赞时弹误报。
 */
export type FeedbackWriteResult = 'saved' | 'missing' | 'failed';

class TranscriptEngine {
  /** Failed writes remain usable by the next turn in this process. Never let a
   * quota failure silently rebuild a conversation from an older DB snapshot. */
  private volatileRecords = new Map<string, ChatMessageRecord>();
  private latestWrites = new Map<string, number>();
  private writeChats = new Map<string, string>();
  private writeEpoch = 0;
  private lastFlushIssue: { reason: string; at: number } | null = null;

  private withVolatile(chatId: string, records: ChatMessageRecord[], afterSeq = 0): ChatMessageRecord[] {
    const merged = new Map(records.map(record => [record.id, record]));
    for (const record of this.volatileRecords.values()) if (record.chatId === chatId && record.seq > afterSeq) merged.set(record.id, structuredClone(record));
    return [...merged.values()].sort((a, b) => a.seq - b.seq);
  }
  /** 会话内 seq 计数器（chatId → 已分配最大 seq）；挂载后由 ensureSeqSeed 填充 */
  private seqCounters = new Map<string, number>();
  private seeded = new Set<string>();
  /** 持久化降级订阅（App 层订阅后向用户呈现「数据可能不保留」提示） */
  private persistenceListeners = new Set<(issue: PersistenceIssue) => void>();

  // ──── 持久化降级通知 ────

  /**
   * 订阅持久化降级事件。引擎自身保持「降级不阻塞主流程」的策略不变，
   * 降级会通知订阅方，同一流式落库错误限频提示。
   * 返回取消订阅函数。
   */
  onPersistenceIssue(listener: (issue: PersistenceIssue) => void): () => void {
    this.persistenceListeners.add(listener);
    return () => this.persistenceListeners.delete(listener);
  }

  /** 广播一次降级事件（监听器异常只告警，不影响其它订阅方与主流程） */
  private notifyPersistenceIssue(operation: PersistenceIssue['operation'], error: unknown): void {
    const issue: PersistenceIssue = {
      operation,
      message: error instanceof Error ? error.message : String(error),
    };
    for (const listener of this.persistenceListeners) {
      try {
        listener(issue);
      } catch (listenerError) {
        console.warn('[TranscriptEngine] 持久化降级监听器执行失败:', listenerError);
      }
    }
  }

  // ──── 会话生命周期 ────

  async createSession(input: CreateSessionInput = {}): Promise<ChatSessionMeta> {
    const now = Date.now();
    const meta: ChatSessionMeta = {
      chatId: generateId('chat'),
      title: DEFAULT_TITLE,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      lastMessagePreview: '',
      agentId: normalizeOptionalText(input.agentId),
      agentName: normalizeOptionalText(input.agentName),
      skillNames: normalizeNameList(input.skillNames),
      modelRef: normalizeModelRef(input.modelRef),
      systemPromptSuffix: normalizeOptionalText(input.systemPromptSuffix),
      // 会话类型：只接受合法枚举值，其余（脏数据 / 旧版本）一律归一为 'chat'
      kind: input.kind === 'site-learn' ? 'site-learn' : 'chat',
    };
    const created = await chatDatabase.createSession(meta);
    this.notifySessionChange('created');
    return created;
  }

  async renameSession(chatId: string, title: string): Promise<ChatSessionMeta | null> {
    const trimmed = title.trim().slice(0, AUTO_TITLE_MAX * 2);
    if (!trimmed) return null;
    const updated = await this.patchSessionMeta(chatId, { title: trimmed });
    if (updated) this.notifySessionChange('renamed');
    return updated;
  }

  /**
   * 归档会话（收纳：从常规列表隐去，数据原地保留）。
   *
   * 归档不是删除：全部关联数据（消息 / 图片 / 上传文件 / 工作区 / 计划）
   * 一律保留，可在管理中心「会话管理」里恢复或到期自动清理。
   */
  async archiveSession(chatId: string): Promise<ChatSessionMeta | null> {
    const updated = await chatDatabase.setSessionArchived(chatId, true);
    if (updated) this.notifySessionChange('archived');
    return updated;
  }

  /** 取消归档（从归档列表回到常规列表） */
  async unarchiveSession(chatId: string): Promise<ChatSessionMeta | null> {
    const updated = await chatDatabase.setSessionArchived(chatId, false);
    if (updated) this.notifySessionChange('unarchived');
    return updated;
  }

  /**
   * 删除会话（仅转录面：会话元信息 + 全部消息，同一事务）。
   * 注意：这是**低层级联**——图片、计划等跨库/跨存储的关联回收由
   * session-deletion-engine 统一编排（引用判定 + 孤儿回收），业务入口
   * （历史抽屉等）一律走删除引擎，不要直接调用本方法。
   */
  async deleteSession(chatId: string): Promise<void> {
    await chatDatabase.deleteSession(chatId);
    this.notifySessionChange('deleted');
    this.seqCounters.delete(chatId);
    this.seeded.delete(chatId);
    this.seeding.delete(chatId);
    for (const [id, writingChat] of this.writeChats) if (writingChat === chatId) {
      this.volatileRecords.delete(id); this.latestWrites.delete(id); this.writeChats.delete(id);
    }
  }

  /**
   * 更新会话的系统提示词补充段（学习草稿等**非 LLM 输入**的会话级数据承载）。
   *
   * 关键约束：learning / validating 运行期间本方法**只能承载非 LLM 输入**
   * （如技能草稿 JSON），绝不能写入会话正在读取的 systemPromptSuffix
   * ——那会让每轮请求的 systemPrompt 漂移，破坏上下文缓存命中的前提
   * （systemPrompt 必须逐轮逐字稳定）。学习会话不使用 systemPromptSuffix
   * （agentSystemOverride 走 override 路径，见 use-learn-session），故在此
   * 落草稿是安全的；且 App 层对 kind='site-learn' 的会话屏蔽了普通发送
   * 对该字段的回写（见 sendMessage），两层保护缺一不可。
   *
   * 体积上限 20000 字符：草稿本体（正文 ≤15000）+ JSON 转义余量，
   * 超出即截断并告警——宁可让回放侧解析失败走「无草稿」，
   * 也不能让单条记录无界增长拖垮会话元信息。
   *
   * 失败降级：仅告警并通知订阅方，不抛错——草稿回放是增强能力，
   * 不该反过来打断正在收尾的会话。
   */
  async setSystemPromptSuffix(chatId: string, suffix: string): Promise<void> {
    try {
      if (suffix.length > 20000) {
        console.warn('[TranscriptEngine] 补充段超长已截断:', suffix.length);
      }
      await this.patchSessionMeta(chatId, { systemPromptSuffix: suffix.slice(0, 20000) });
    } catch (error) {
      console.warn('[TranscriptEngine] 会话补充段写入失败:', error);
      this.notifyPersistenceIssue('session-meta', error);
    }
  }

  async listSessions(options: SessionListOptions = {}): Promise<ChatSessionMeta[]> {
    return chatDatabase.listSessions(options);
  }

  async getSession(chatId: string): Promise<ChatSessionMeta | null> {
    return chatDatabase.getSession(chatId);
  }

  async loadSessionRecords(chatId: string): Promise<ChatMessageRecord[]> {
    const page = await chatDatabase.getMessagesPage(chatId, { limit: Number.MAX_SAFE_INTEGER });
    return this.withVolatile(chatId, page.records);
  }

  // ──── 上下文压缩状态（模型面专用；用户面转录永不被改动） ────

  /**
   * 读取「模型面有效上下文」：会话存在压缩摘要时，返回摘要 + 压缩点之后的记录
   * （seq > compactionUpToSeq）；无压缩时等价于全量记录。
   *
   * 同时返回会话持久化的 systemPrompt 补充段——它与 agentName/skillNames 共同构成
   * systemPrompt 的全部派生输入，调用方据此即可在不重新请求模型的情况下重建出
   * 与真实请求同源的系统提示词（会话切换后的上下文预算估算依赖这一点）。
   *
   * 实现要点：先读会话元信息判断是否存在压缩点，再按 seq 下界只取尾部记录——
   * 压缩恰恰发生在会话最长的时候，全量加载 + 内存过滤是那时的主要开销来源。
   */
  async getEffectiveContext(chatId: string): Promise<EffectiveContext> {
    let summary = '';
    let upTo = 0;
    let compactedAt = 0;
    let systemPromptSuffix = '';
    try {
      const session = await chatDatabase.getSession(chatId);
      summary = session?.compactionSummary?.trim() ?? '';
      upTo = session?.compactionUpToSeq ?? 0;
      compactedAt = session?.compactionUpdatedAt ?? 0;
      systemPromptSuffix = normalizeOptionalText(session?.systemPromptSuffix);
    } catch (error) {
      // 元信息读取失败时退化为全量记录（压缩信息缺失只影响体积，不影响正确性）
      console.warn('[TranscriptEngine] 读取压缩状态失败，按无压缩处理:', error);
    }

    if (!summary || upTo <= 0) {
      const records = await this.loadSessionRecords(chatId);
      await this.preloadRecordImages(records);
      return {
        summary: '',
        compactedAt: 0,
        systemPromptSuffix,
        records,
      };
    }

    try {
      const records = this.withVolatile(chatId, await chatDatabase.getMessagesAfter(chatId, upTo), upTo);
      await this.preloadRecordImages(records);
      return { summary, compactedAt, systemPromptSuffix, records };
    } catch (error) {
      console.warn('[TranscriptEngine] 读取压缩点之后的消息失败，回退为全量记录:', error);
      const records = await this.loadSessionRecords(chatId);
      await this.preloadRecordImages(records);
      return {
        summary: '',
        compactedAt: 0,
        systemPromptSuffix,
        records,
      };
    }
  }

  /**
   * 预载记录关联图片的 data URL（幂等，失败只告警）。
   * 上下文派生（contextEngine.toProtocolMessages）是同步快照路径——依赖
   * imageStore 缓存命中把图片还原进多模态消息；此处统一在记录加载点预热，
   * 保证「加载会话 → 装配上下文」链路上缓存恒可用。
   */
  private async preloadRecordImages(records: readonly ChatMessageRecord[]): Promise<void> {
    await prepareProtocolHistory(records);
    const refs: string[] = [];
    for (const record of records) {
      refs.push(...normalizeImageRefs(record.imageRefs));
    }
    if (refs.length === 0) return;
    try {
      await imageStore.preload(refs);
    } catch (error) {
      console.warn('[TranscriptEngine] 预载会话图片失败（对应图片将暂不进入上下文）:', error);
    }
  }

  /** 写入/更新压缩状态：seq <= upToSeq 的历史已被摘要取代 */
  async setCompaction(
    chatId: string,
    summary: string,
    upToSeq: number,
  ): Promise<ChatSessionMeta | null> {
    if (!summary.trim() || upToSeq <= 0) return null;
    return this.patchSessionMeta(chatId, {
      compactionSummary: summary,
      compactionUpToSeq: upToSeq,
      compactionUpdatedAt: Date.now(),
    });
  }

  /**
   * 更新会话最近使用的智能体/技能/模型/系统提示词补充段（每次发送调用）。
   *
   * 语义约定：字段为 undefined 表示「本次不更新该项」；空字符串是合法值
   * （表示用户移除了智能体 / 没有补充段），因此判空一律用 !== undefined，
   * 不能用 || 或 ?? ——否则「清除选择」永远写不进库，会话切换后会回显过期设置。
   */
  async updateSessionUsage(
    chatId: string,
    usage: {
      agentId?: string;
      agentName?: string;
      skillNames?: string[];
      /** 模型引用（undefined = 本次不更新；null = 清除会话模型选择） */
      modelRef?: ModelRef | null;
      systemPromptSuffix?: string;
    },
  ): Promise<void> {
    const patch: Partial<ChatSessionMeta> = {};
    if (usage.agentId !== undefined) patch.agentId = normalizeOptionalText(usage.agentId);
    if (usage.agentName !== undefined) patch.agentName = normalizeOptionalText(usage.agentName);
    if (usage.skillNames !== undefined) patch.skillNames = normalizeNameList(usage.skillNames);
    if (usage.modelRef !== undefined) patch.modelRef = normalizeModelRef(usage.modelRef);
    if (usage.systemPromptSuffix !== undefined) {
      patch.systemPromptSuffix = normalizeOptionalText(usage.systemPromptSuffix);
    }
    if (Object.keys(patch).length === 0) return;
    await this.patchSessionMeta(chatId, patch);
  }

  // ──── 消息写入 ────

  /**
   * 追加用户消息并更新会话元信息（含自动标题）。
   * @param imageRefs 本轮上传图片的内容哈希引用（图片本体已由会话引擎写入
   *   独立图片库；此处只落引用。缺省 = 无图片）
   * @param pageQuote 本轮用户确认引用的网页原文（落库后用户气泡据此渲染
   *   引用块；缺省 = 无引用。引用内容只落用户面转录，模型面另走信封）
   */
  async appendUserMessage(
    chatId: string,
    content: string,
    imageRefs: readonly string[] = [],
    pageQuote?: PageQuote,
  ): Promise<ChatMessageRecord> {
    const seq = await this.nextSeq(chatId);
    const now = Date.now();
    const record: ChatMessageRecord = {
      id: generateId('msg'),
      chatId,
      seq,
      role: 'user',
      content,
      parts: [{ type: 'text', content }],
      reasoning: '',
      toolCalls: [],
      status: 'done',
      ...(imageRefs.length > 0 ? { imageRefs: [...imageRefs] } : {}),
      // 恒写入（空上传 = 空数组）：与旧记录的 undefined 区分，UI 侧据此
      // 只把用户上传展示为气泡底部图片；vision 首截图等引擎注入的引用
      // 仅进 imageRefs（落库归一化补入），不进本字段
      uploadImageRefs: [...imageRefs],
      // 用户确认的网页引用随本条消息落库（气泡引用块的唯一来源）
      ...(pageQuote ? { pageQuote } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.flush(record);

    // 自动标题：仅在会话仍是默认标题时用首条用户消息覆盖。
    // 预览（lastMessagePreview）由 flush 统一维护——预览与计数必须同源，
    // 若在此处再写一次预览，冗余计数会被重复累加（历史缺陷）。
    // 非关键路径独立容错：标题读取/写入失败只降级（会话保持默认标题），
    // 绝不连同已落库的用户消息一起把整次发送打断
    try {
      const session = await chatDatabase.getSession(chatId);
      // 引用独存的首条消息（正文为空）以引用原文作标题素材——否则新会话只能
      // 停在默认标题上，历史里认不出这是哪次对话
      const titleSource = content.trim() || pageQuote?.text.trim() || '';
      const shouldAutoTitle = session?.title === DEFAULT_TITLE && titleSource.length > 0;
      if (shouldAutoTitle) {
        await this.patchSessionMeta(chatId, { title: titleSource.slice(0, AUTO_TITLE_MAX) });
      }
    } catch (error) {
      console.warn('[TranscriptEngine] 自动标题更新失败（不影响消息入档）:', error);
      this.notifyPersistenceIssue('session-meta', error);
    }
    return record;
  }

  /** 创建助手消息占位记录（不落库；由会话引擎在首个事件时快照） */
  async createAssistantRecord(chatId: string): Promise<ChatMessageRecord> {
    const seq = await this.nextSeq(chatId);
    const now = Date.now();
    return {
      id: generateId('msg'),
      chatId,
      seq,
      role: 'assistant',
      content: '',
      parts: [],
      reasoning: '',
      toolCalls: [],
      status: 'streaming',
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * 落库（快照与最终写一视同仁）。
   * 失败降级：仅告警不抛错，保证对话主流程不被 DB 故障阻断。
   * 会话已删除（如运行中在历史抽屉删除）：事务内判定并丢弃本次写入，
   * 避免产生无会话元信息的孤儿记录。
   *
   * 冗余计数（messageCount）由数据库在同一事务内原子维护，
   * 因此流式快照的重复写入不会重复计数（exactly-once 语义）。
   */
  async flush(record: ChatMessageRecord): Promise<void> {
    record.updatedAt = Date.now();
    const epoch = ++this.writeEpoch;
    this.latestWrites.set(record.id, epoch);
    this.writeChats.set(record.id, record.chatId);
    let snapshot = record;
    let messageSaved = false;
    try {
      snapshot = structuredClone(record);
      const { skipped } = await chatDatabase.saveMessage(snapshot);
      messageSaved = true;
      this.lastFlushIssue = null;
      if (this.latestWrites.get(record.id) === epoch) {
        this.volatileRecords.delete(record.id); this.latestWrites.delete(record.id); this.writeChats.delete(record.id);
      }
      if (skipped) {
        return;
      }
      // 预览只在消息进入终态时刷新：流式过程中的半截文本不代表会话最后一条内容。
      // 引用独存的用户消息（正文为空）以引用原文作预览——否则历史抽屉会看到一条空白
      if (record.status !== 'streaming') {
        const preview = record.content.trim() || record.pageQuote?.text.trim() || record.error || '';
        await this.patchSessionMeta(record.chatId, {
          lastMessagePreview: chatPreviewOf(preview),
        });
      }
    } catch (error) {
      if (!messageSaved && this.latestWrites.get(record.id) !== epoch) return;
      if (this.latestWrites.get(record.id) === epoch) this.volatileRecords.set(record.id, snapshot);
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const now = Date.now();
      if (this.lastFlushIssue?.reason !== reason || now - this.lastFlushIssue.at >= 60_000) {
        this.lastFlushIssue = { reason, at: now };
        console.warn('[TranscriptEngine] 消息落库失败（已降级为内存态）:', error);
        this.notifyPersistenceIssue('message-flush', error);
      }
    }
  }

  /**
   * 写入/清除消息反馈（赞/踩；null = 清除）。
   *
   * 实现走 patchMessage 的单事务读-改-写（只动 feedback 一个键），
   * 不整记录回写——避免与该消息的快照 flush 并发时互相覆盖字段。
   *
   * 返回三态（调用方可区分「无需处理」与「真失败」）：
   *   - 'saved'   已落库；
   *   - 'missing' 记录不存在——系统通知、错误卡片等合成消息本就不入转录，
   *               属预期路径（info 级记录，不弹任何用户提示）；
   *   - 'failed'  真实异常（DB 故障 / 配额 / 隐私模式）——warn 级带上下文
   *               留下可分析日志，由 UI 层决定是否向用户呈现。
   *
   * 失败策略：不抛错也不广播持久化降级事件——反馈属可丢失的非关键数据，
   * 而降级横幅的文案描述的是转录本体（「对话可能不会保留」），为一次点赞
   * 弹出该提示会造成误报。UI 侧已乐观上屏，落库失败时状态停留在本次会话内，
   * 下次重载回落为库值。
   */
  async setMessageFeedback(
    messageId: string,
    feedback: MessageFeedback | null,
  ): Promise<FeedbackWriteResult> {
    try {
      const updated = await chatDatabase.patchMessage(messageId, {
        feedback: feedback ?? undefined,
      });
      if (!updated) {
        console.info(
          `[TranscriptEngine] 消息 ${messageId} 无落库记录（合成消息，反馈仅保留在 UI）`,
        );
        return 'missing';
      }
      return 'saved';
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `[TranscriptEngine] 消息反馈写入失败（messageId=${messageId}, feedback=${feedback ?? 'clear'}）: ${reason}`,
        error,
      );
      return 'failed';
    }
  }

  // ──── seq 分配 ────

  /** 进行中的 seq 播种（chatId → Promise）：并发首用同会话时共享同一次播种 */
  private seeding = new Map<string, Promise<void>>();

  /** 会话内单调递增 seq；首次使用时从 DB 播种，防与历史冲突 */
  private async nextSeq(chatId: string): Promise<number> {
    if (!this.seeded.has(chatId)) {
      // 单飞：并发首用（极端时序下的双入口）共享同一次播种——若各自读到同一
      // maxSeq 再各自 +1，会分配出相同 seq，撞 [chatId, seq] 唯一索引让整笔
      // 写入事务失败并连锁触发落库降级
      let seed = this.seeding.get(chatId);
      if (!seed) {
        seed = this.seedSeqCounter(chatId);
        this.seeding.set(chatId, seed);
        void seed.then(
          () => {
            if (this.seeding.get(chatId) === seed) this.seeding.delete(chatId);
          },
          () => {
            /* seedSeqCounter 内部已全量兜错，此处仅为穷尽 then 双分支 */
          },
        );
      }
      await seed;
    }
    const next = (this.seqCounters.get(chatId) ?? 0) + 1;
    this.seqCounters.set(chatId, next);
    return next;
  }

  /** 播种实现（绝不 reject：失败走时间戳基数回退，见内部注释） */
  private async seedSeqCounter(chatId: string): Promise<void> {
    try {
      const maxSeq = await chatDatabase.getMaxSeq(chatId);
      this.seqCounters.set(chatId, Math.max(this.seqCounters.get(chatId) ?? 0, maxSeq));
    } catch (error) {
      // 防御性回退：播种失败（DB 暂不可读）时以当前时间戳为基数。
      // 历史 seq 从 1 连续递增，时间戳恒大于一切既有值，可避免新记录与
      // 已落库记录撞 [chatId, seq] 唯一索引（撞索引会让整笔写入事务失败，
      // 连锁触发落库降级）。DB 恢复后按库内最大 seq 重新对齐。
      this.seqCounters.set(chatId, Math.max(this.seqCounters.get(chatId) ?? 0, Date.now()));
      console.warn('[TranscriptEngine] seq 播种失败，已回退为时间戳基数:', error);
      this.notifyPersistenceIssue('seq-seed', error);
    }
    this.seeded.add(chatId);
  }

  /**
   * 局部更新会话元信息。
   *
   * 本方法只做「字段级更新」，不隐含任何计数语义：
   * messageCount 由数据库在写入消息的同一事务内维护（见 chatDatabase.saveMessage），
   * 在此层按「是否带预览」推断「是否新增了一条消息」会让计数与真实消息数脱钩。
   */
  private async patchSessionMeta(
    chatId: string,
    patch: Partial<ChatSessionMeta>,
  ): Promise<ChatSessionMeta | null> {
    try {
      const updated = await chatDatabase.patchSession(chatId, { ...patch, updatedAt: Date.now() });
      if (updated) this.notifySessionChange('updated');
      return updated;
    } catch (error) {
      console.warn('[TranscriptEngine] 会话元信息更新失败:', error);
      this.notifyPersistenceIssue('session-meta', error);
      return null;
    }
  }

  /**
   * 广播会话变更（跨上下文实时同步）。
   *
   * 通知失败绝不抛错：本方法只是「让管理中心尽快刷新」的加速手段，
   * 真正的权威源是 IndexedDB —— 管理中心另有定时与聚焦刷新兜底。
   */
  private notifySessionChange(reason: SessionChangeReason): void {
    try {
      notifySessionsChanged(reason);
    } catch (error) {
      console.warn('[TranscriptEngine] 会话变更广播失败:', error);
    }
  }
}

/** 全局单例 */
/**
 * 用户消息气泡底部图片区的展示口径：只含用户主动上传的图片。
 *
 * 两级判定（新记录精确 / 旧记录反推）：
 *   1. **新记录**（uploadImageRefs 存在）：直接取该字段——落库时已把
 *      用户上传与引擎注入的视口截图分开登记，无需二次推断。
 *   2. **旧记录**（uploadImageRefs 缺失）：无法从记录自身区分来源，
 *      改用「会话内助手记录的引用」反推——引擎注入的视口截图必然同时
 *      出现在对应的助手记录里（助手消息是它的展示主体），从用户记录的
 *      引用中剔除这些即可还原用户真正的上传。
 *      无法反推时（会话内无助手记录）回退完整 imageRefs：宁可多展示，
 *      不可丢失用户上传。
 *
 * 视觉截图的展示入口恒为助手消息的内联「查看屏幕」片段，不经本函数；
 * 模型上下文派生继续用完整 imageRefs（截图是协议历史的合法组成部分，
 * 且图片回收/GC 依赖它）。
 *
 * @param record 用户记录
 * @param assistantImageRefs 会话内助手记录持有的全部引用（用于旧记录反推）
 */
export function userVisibleImageRefs(
  record: Pick<ChatMessageRecord, 'imageRefs' | 'uploadImageRefs'>,
  assistantImageRefs?: ReadonlySet<string>,
): string[] {
  if (record.uploadImageRefs !== undefined) return record.uploadImageRefs;
  const refs = record.imageRefs ?? [];
  if (refs.length === 0 || !assistantImageRefs || assistantImageRefs.size === 0) return refs;
  // 旧记录反推：剔除「助手消息也在展示」的引用（= 引擎注入的视口截图）
  const uploads = refs.filter(ref => !assistantImageRefs.has(ref));
  return uploads.length > 0 ? uploads : refs;
}

export const transcriptEngine = new TranscriptEngine();
