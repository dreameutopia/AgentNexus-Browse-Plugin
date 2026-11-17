/**
 * 会话删除引擎（SessionDeletionEngine）—— 删除会话的唯一编排入口
 *
 * 「删除一个会话」在本系统横跨多个存储面，散落在各调用点必然漏删。
 * 本引擎是**唯一允许发起会话删除的地方**（业务入口一律调 deleteSession），
 * 覆盖的全部绑定面如下：
 *
 *   1. 转录库（AgentNexusChatDB）：sessions + messages + pythonWorkspaces
 *      在**同一事务内**级联删除（模型可见上下文 modelMessages / modelContext
 *      与用户可见上下文 content / parts / reasoning / toolCalls 同属 messages
 *      表的字段，随级联一并消失；会话级的压缩摘要随 sessions 行消失）；
 *   2. 图片库（AgentNexusImageDB）：被删会话引用过的图片在**删除后**若已无
 *      任何消息引用则回收（内容寻址去重意味着同一图片可能被其它会话共享，
 *      绝不能按会话盲删）；引用权威 = 转录库 byImageRef 索引计数；
 *   3. 计划存储（plan-store）：dropPlan 落删除墓碑，防其它窗口的副本复活；
 *   4. 上传文件库（AgentNexusFileDB）：会话注册的全部文件整会话回收
 *      （文件解析出的正文即文件记录的 text 字段，随文件一并消失）；
 *   5. 会话级运行态（chrome.storage.session）：活跃会话指针指向被删会话时
 *      清空（否则下次打开侧边栏会试图恢复一个已不存在的会话）；
 *   6. 运行中会话：先中止在跑的对话（否则运行会话删除后继续写入，
 *      产生孤儿图片与被丢弃的快照）；
 *   7. 孤儿回收（sweepOrphanImages）：覆盖「图片已入库但消息落库失败 /
 *      运行竞态残留」的历史遗留——带创建宽限期，绝不误删在途图片。
 *
 * **刻意不删的面**（删除会话不应波及它们）：
 *   - 笔记库（utils/notes-database）：笔记是跨会话的外部记忆，刻意无会话绑定；
 *   - data-ref 暂存（utils/data-ref-store）：全局暂存板，当前无会话维度；
 *   - 技能 / 智能体 / 用量统计 / Python 包缓存：全局资源，与会话无关。
 *
 * 顺序即正确性：先中止运行 → 采集引用 → 删除转录 → 清计划 → 清上传文件 →
 * 清活跃指针 → 按引用回收图片。
 * 每步独立容错（单步失败只告警并继续），最终以结果值汇总——删除会话这个
 * 用户意图必须尽量完成，残留在后续 sweep 中兜底。
 */

import { backgroundConversation } from '../conversation/runtime-client';
import { ACTIVE_CHAT_KEY } from '../conversation/runtime-protocol';
import { transcriptEngine } from './transcript-engine';
import { chatDatabase } from './chat-database';
import { imageStore, isImageRef } from '../images/image-store';
import { dropPlan } from '@/utils/plan/plan-store';

/** 删除结果汇总（供调用方展示与埋点） */
export interface SessionDeleteResult {
  /** 转录面（会话 + 消息）是否删除成功 */
  transcriptDeleted: boolean;
  /** 按引用判定回收的图片数 */
  imagesDeleted: number;
  /** 整会话回收的工作区文件数（用户上传文件与工具产物均在工作区内） */
  filesDeleted: number;
  /** 是否清掉了指向本会话的活跃会话指针 */
  activePointerCleared: boolean;
  /** 是否中止了正在运行的会话 */
  runAborted: boolean;
  /** 各步骤的非致命失败原因（只告警，不阻断） */
  issues: string[];
}

/** 孤儿回收的创建宽限期：在途图片（刚入库、消息尚未落库）不在回收范围 */
const SWEEP_GRACE_MS = 2 * 60 * 1000;

class SessionDeletionEngine {
  /**
   * 删除会话及其全部关联回收（转录 / 图片 / 计划 / 上传文件 / 活跃指针 /
   * 运行中止 / 孤儿兜底）。
   *
   * 不抛错于预期内的单步失败（记入 issues 继续），仅转录删除本身失败时上抛
   * （那是用户意图的主体，失败必须让调用方感知）。
   */
  async deleteSession(chatId: string): Promise<SessionDeleteResult> {
    // 边界校验：空标识会让后续每一步都作用在「不存在的会话」上，
    // 其中计划墓碑 / 活跃指针清理还可能误伤空键记录——在入口直接拒绝。
    if (typeof chatId !== 'string' || !chatId.trim()) {
      throw new Error('删除会话失败：缺少有效的会话标识');
    }
    const issues: string[] = [];

    // 1) 中止运行中的对话（幂等：无运行时为 no-op）
    let runAborted = false;
    try {
      if (typeof document !== 'undefined') {
        await backgroundConversation.abortAndWait(chatId);
        runAborted = true;
      }
    } catch (error) {
      issues.push(`中止运行失败: ${this.describe(error)}`);
    }

    // 2) 删除前采集本会话引用过的图片（删除后这些引用将不复存在）
    let candidateRefs: string[] = [];
    try {
      candidateRefs = await chatDatabase.getImageRefsOfChat(chatId);
    } catch (error) {
      issues.push(`采集图片引用失败: ${this.describe(error)}`);
    }

    // 2.5) 删除前采集工作区条目数（上传文件与工具产物都在工作区里；
    // 工作区随会话在同一事务中删除，此处只用于回报回收规模）
    let workspaceFileCount = 0;
    try {
      const snapshot = await chatDatabase.readWorkspace(chatId);
      workspaceFileCount = (snapshot?.entries ?? []).filter(entry => !!entry.blob || !!entry.link).length;
    } catch (error) {
      issues.push(`采集工作区文件失败: ${this.describe(error)}`);
    }

    // 3) 转录级联删除（会话 + 消息 + 工作区，同一事务）——用户意图主体，失败上抛
    await transcriptEngine.deleteSession(chatId);

    // 4) 计划清理（落墓碑防跨窗口复活）
    try {
      dropPlan(chatId);
    } catch (error) {
      issues.push(`清理任务计划失败: ${this.describe(error)}`);
    }

    // 4.5) 上传文件已随会话工作区一并回收（见步骤 2.5 / 3）——此处不再
    // 有独立的文件库需要清理，filesDeleted 汇报工作区回收的文件数
    const filesDeleted = workspaceFileCount;

    // 4.7) 活跃会话指针清理：指针指向被删会话时清空，避免下次打开侧边栏
    // 去恢复一个已不存在的会话（恢复失败会停在空白页且没有可解释的提示）。
    let activePointerCleared = false;
    try {
      activePointerCleared = await this.clearActivePointer(chatId);
    } catch (error) {
      issues.push(`清理活跃会话指针失败: ${this.describe(error)}`);
    }

    // 5) 图片按引用回收：删除后仍被其它会话引用的保留，零引用的回收
    let imagesDeleted = 0;
    try {
      imagesDeleted = await this.reclaimUnreferenced(candidateRefs);
    } catch (error) {
      issues.push(`回收图片失败: ${this.describe(error)}`);
    }

    // 6) 孤儿兜底：覆盖运行竞态 / 落库失败导致的无主图片（带宽限期）
    try {
      imagesDeleted += await this.sweepOrphanImages();
    } catch (error) {
      issues.push(`孤儿图片回收失败: ${this.describe(error)}`);
    }

    if (issues.length > 0) {
      console.warn(`[SessionDeletionEngine] 会话 ${chatId} 删除存在非致命问题:`, issues);
    }
    return {
      transcriptDeleted: true,
      imagesDeleted,
      filesDeleted,
      activePointerCleared,
      runAborted,
      issues,
    };
  }

  /**
   * 指针指向被删会话时清空活跃会话指针。
   *
   * 只清「指向本会话」的情况：指针指向别的会话时一律不动（那是用户正在
   * 使用的会话，清掉会让侧边栏莫名其妙回到空白页）。
   */
  private async clearActivePointer(chatId: string): Promise<boolean> {
    if (typeof chrome === 'undefined' || !chrome.storage?.session) return false;
    const stored = await chrome.storage.session.get(ACTIVE_CHAT_KEY);
    const current = stored[ACTIVE_CHAT_KEY];
    if (typeof current !== 'string' || current !== chatId) return false;
    await chrome.storage.session.remove(ACTIVE_CHAT_KEY);
    return true;
  }

  /**
   * 按引用计数回收一批图片：删除转录后逐个查询「还有多少消息引用它」，
   * 为 0 才回收（内容寻址去重 → 跨会话共享的图片不会被误删）。
   */
  private async reclaimUnreferenced(refs: readonly string[]): Promise<number> {
    const unique = [...new Set(refs)].filter(isImageRef);
    if (unique.length === 0) return 0;
    const unreferenced: string[] = [];
    for (const ref of unique) {
      const remaining = await chatDatabase.countMessagesReferencingImage(ref);
      if (remaining === 0) unreferenced.push(ref);
    }
    return imageStore.deleteByHashes(unreferenced);
  }

  /**
   * 孤儿图片全量回收：图片库中存在、但没有任何消息引用的图片。
   * 判定基准 = 转录库 byImageRef 计数（唯一权威），因此对「先入库后落库
   * 失败」「跨上下文并发删除」等时序都成立。带创建宽限期（在途图片豁免）。
   * @param graceMs 宽限期（毫秒）；0 表示不豁免（仅供显式维护调用）
   * @returns 实际回收条数
   */
  async sweepOrphanImages(graceMs: number = SWEEP_GRACE_MS): Promise<number> {
    const allHashes = await imageStore.listAllHashes();
    if (allHashes.length === 0) return 0;
    const cutoff = Date.now() - Math.max(0, graceMs);
    const orphans: string[] = [];
    for (const ref of allHashes) {
      const remaining = await chatDatabase.countMessagesReferencingImage(ref);
      if (remaining > 0) continue;
      // 宽限期内的图片可能正等待消息落库（发送流程中），跳过；
      // 元信息读不到（并发删除 / DB 读失败）同样保守跳过，留待下次 sweep——
      // 宁可漏删，绝不因一次读失败误删在途图片
      const createdAt = await imageStore.getCreatedAt(ref);
      if (createdAt === null || createdAt > cutoff) continue;
      orphans.push(ref);
    }
    if (orphans.length === 0) return 0;
    console.info(`[SessionDeletionEngine] 回收 ${orphans.length} 张孤儿图片`);
    return imageStore.deleteByHashes(orphans);
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 全局单例 */
export const sessionDeletionEngine = new SessionDeletionEngine();
