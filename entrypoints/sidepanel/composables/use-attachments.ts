/**
 * 输入区附件栏管理（会话级状态 + 上传守卫流程）
 *
 * 职责：
 *   - 持有待发送附件（文本类 + 图片）的响应式列表与增删；
 *   - addFiles 完整守卫链（串行逐文件处理，保证预算计算的时序正确）：
 *       分类准入 → 体积硬限（文本 10MB / 图片 10MB）→
 *       Office 解析（内嵌图片需确认）→ 编码解码 →
 *       上下文预算（单文件 ≤ 阈值 20%；全部附件累计 ≤ 阈值 50%，
 *       超额自动从前往后裁剪，预算耗尽明确拒绝）→ 入列；
 *   - 弹窗交互全部经 use-app-dialog（Promise 化，绝不阻塞 JS 线程）。
 *
 * 预算口径：与 context-meter 同源——按「字符数」计（图片不计入字符预算，
 * 其体积影响由请求侧上下文计量自然体现）。
 *
 * 图片准入前置：当前生效模型必须已声明视觉能力（settings → 模型行眼睛开关，
 * 存储于渠道内模型的 vision 字段）；模型由注入的 isCurrentModelVision 判定，
 * 保持本模块与存储层解耦。
 */

import { computed, ref } from 'vue';
import { t } from '@/utils/i18n';
import {
  classifyAttachmentFile,
  decodeTextBuffer,
  imageToDataUrl,
  parseOfficeDocument,
  AttachmentParseError,
} from '../utils/chat/attachment-parser';
import { CONTEXT_THRESHOLD_DEFAULT } from '../utils/channels/channel-types';
import { showAlert, showConfirm } from './use-app-dialog';

// ==================== 常量与类型 ====================

/** 文本类附件体积硬限：10MB（超出直接拒绝，提示剪切核心内容） */
export const TEXT_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** 图片附件体积硬限：10MB（对齐主流多模态接口单图上限） */
export const IMAGE_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** 单个文本附件占上下文阈值上限：20% */
export const SINGLE_FILE_BUDGET_RATIO = 0.2;

/** 全部文本附件累计占上下文阈值上限：50% */
export const TOTAL_BUDGET_RATIO = 0.5;

/** 附件数量上限（防御性：杜绝海量小文件把附件摘要标记撑成超长消息） */
export const MAX_ATTACHMENT_COUNT = 50;

/**
 * 上下文阈值兜底值（单一事实源 = utils/channels 的 CONTEXT_THRESHOLD_DEFAULT，
 * 与 ContextWindowGuard / 模型注册表共用同一数值，杜绝多处字面量漂移）：
 * 注入的 getContextThreshold 返回 NaN / 非正数（外部写入的脏配置）时使用，
 * 保证预算计算恒为有限正整数。
 */
export const FALLBACK_CONTEXT_THRESHOLD = CONTEXT_THRESHOLD_DEFAULT;

/** 附件形态（决定输入栏图标与气泡标记） */
export type AttachmentSource = 'plain' | 'office' | 'image';

/** 输入区待发送附件 */
export interface ChatAttachment {
  id: string;
  /** 用户可见的原始文件名（保持原格式展示） */
  name: string;
  /** text = 文本类（plain/office 解析产物）；image = 图片 */
  kind: 'text' | 'image';
  /** 图片 data URL（kind=image 时存在） */
  dataUrl?: string;
  /** 提取文本（kind=text 时存在，已按预算裁剪；发送时并入用户消息） */
  text?: string;
  /** 计入预算的字符数（图片为 0） */
  chars: number;
  /** 原始文件体积（字节，展示用） */
  sizeBytes: number;
  /** 来源形态：纯文本 / Office 解析 / 图片 */
  source: AttachmentSource;
}

/** 宿主注入的判定依赖（App.vue 提供，保持模块可单测） */
export interface AttachmentHostContext {
  /** 当前生效模型是否声明视觉能力 */
  isCurrentModelVision: () => boolean;
  /** 当前配置的上下文字符阈值（>0；非法值由宿主保证不出现） */
  getContextThreshold: () => number;
}

// ==================== 工具 ====================

/** UTF-16 安全截断：避免在代理对（emoji 等）中间切开产生孤立代理项 */
function safeSlice(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  const sliced = text.slice(0, maxChars);
  const tail = sliced.charCodeAt(sliced.length - 1);
  // 尾字符是高位代理（0xD800-0xDBFF）而原文下一个字符存在 → 去掉半个代理对
  if (tail >= 0xd800 && tail <= 0xdbff && sliced.length < text.length) {
    return sliced.slice(0, -1);
  }
  return sliced;
}

/** 字节数人性化（B/KB/MB） */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 字符数人性化（K 单位一位小数；用于弹窗提示中的上下文阈值等大数） */
export function formatCharsLocalized(chars: number): string {
  return chars < 1024 ? `${chars}` : `${(chars / 1024).toFixed(1)}K`;
}

// ==================== 工厂 ====================

/**
 * 创建附件管理器（App.vue 持有单例；切换会话时应 clearAttachments）。
 * addFiles 串行处理：预算/弹窗都依赖前一个文件的最终状态。
 */
export function createAttachmentManager(ctx: AttachmentHostContext) {
  const attachments = ref<ChatAttachment[]>([]);
  const isAdding = ref(false);

  /** 已计入预算的字符总量（文本附件累计） */
  const totalChars = computed(() =>
    attachments.value.reduce((sum, item) => sum + item.chars, 0),
  );

  function removeAttachment(id: string): void {
    attachments.value = attachments.value.filter(item => item.id !== id);
  }

  /**
   * 移除全部图片附件（切换到无视觉能力模型的确认分支调用），文本附件保留。
   * @returns 实际移除的数量（供调用方构造反馈文案）
   */
  function removeImageAttachments(): number {
    const before = attachments.value.length;
    attachments.value = attachments.value.filter(item => item.kind !== 'image');
    return before - attachments.value.length;
  }

  function clearAttachments(): void {
    attachments.value = [];
  }

  /**
   * 文件批量入口：选择器多选后逐个走守卫链，单个失败只提示不阻断后续。
   * 全程串行（await 弹窗 → 用户操作 → 下一文件），杜绝并发预算竞态；
   * 单文件的意外异常（读取失败等）被兜底捕获为可读提示，绝不中断批次，
   * 也绝不产生未处理的 Promise 拒绝。
   */
  async function addFiles(files: File[]): Promise<void> {
    if (isAdding.value || files.length === 0) return;
    isAdding.value = true;
    try {
      for (const file of files) {
        try {
          await addOne(file);
        } catch (error) {
          // addOne 内部已对可预期错误弹窗；此处兜底「不可预期」的异常
          //（如文件在读取间隙被删除导致的 arrayBuffer 拒绝）
          const reason = error instanceof Error ? error.message : String(error);
          console.warn('[Attachments] 文件处理意外失败:', file.name, error);
          await showAlert(
            t('sidepanel.attachments.parseFailed', { name: file.name, reason }),
            t('sidepanel.attachments.promptTitle'),
            'error',
          );
        }
      }
    } finally {
      isAdding.value = false;
    }
  }

  /** 解析注入的上下文阈值为有限正整数（脏配置兜底，见 FALLBACK_CONTEXT_THRESHOLD） */
  function resolveThreshold(): number {
    const raw = ctx.getContextThreshold();
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return Math.floor(raw);
    }
    return FALLBACK_CONTEXT_THRESHOLD;
  }

  /** 单文件守卫链（数量上限 → 分类 → 体积 → 解码/解析 → 确认 → 预算 → 入列） */
  async function addOne(file: File): Promise<void> {
    // ── 数量上限：防御海量小文件把附件摘要标记撑成超长消息 ──
    if (attachments.value.length >= MAX_ATTACHMENT_COUNT) {
      await showAlert(
        t('sidepanel.attachments.tooManyFiles', { count: MAX_ATTACHMENT_COUNT }),
        t('sidepanel.attachments.promptTitle'),
        'warn',
      );
      return;
    }

    const classification = classifyAttachmentFile(file.name, file.type);

    // ── 明确拒绝：不支持的格式 / 旧版二进制 Office ──
    if (classification.kind === 'unsupported') {
      await showAlert(
        t('sidepanel.attachments.unsupportedFormat', { name: file.name }),
        t('sidepanel.attachments.promptTitle'),
        'warn',
      );
      return;
    }
    if (classification.kind === 'legacy-office') {
      await showAlert(
        t('sidepanel.attachments.legacyOfficeFormat', { name: file.name }),
        t('sidepanel.attachments.promptTitle'),
        'warn',
      );
      return;
    }

    // ── 图片：模型视觉能力前置 + 体积硬限 + 上下文体积防御 ──
    if (classification.kind === 'image') {
      if (!ctx.isCurrentModelVision()) {
        await showAlert(
          t('sidepanel.attachments.modelNoVision'),
          t('sidepanel.attachments.promptTitle'),
          'warn',
        );
        return;
      }
      if (file.size > IMAGE_FILE_MAX_BYTES) {
        await showAlert(
          t('sidepanel.attachments.imageTooLarge', { name: file.name }),
          t('sidepanel.attachments.promptTitle'),
          'warn',
        );
        return;
      }
      const buffer = await file.arrayBuffer();
      const dataUrl = imageToDataUrl(buffer, classification.ext, file.type);
      // 上下文体积防御：base64 长度按请求口径计入 JSON 计量。单图就超过
      // 整个上下文阈值时，ContextWindowGuard 会把本轮用户消息整组丢弃
      //（模型收不到当前消息），必须在上传时就明确拒绝
      const threshold = resolveThreshold();
      if (dataUrl.length > threshold) {
        await showAlert(
          t('sidepanel.attachments.imageExceedsContext', {
            name: file.name,
            threshold: formatCharsLocalized(threshold),
          }),
          t('sidepanel.attachments.promptTitle'),
          'warn',
        );
        return;
      }
      attachments.value.push({
        id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        kind: 'image',
        dataUrl,
        chars: 0,
        sizeBytes: file.size,
        source: 'image',
      });
      return;
    }

    // ── 文本类（纯文本 / Office）：体积硬限（10MB）──
    if (file.size > TEXT_FILE_MAX_BYTES) {
      await showAlert(
        t('sidepanel.attachments.fileTooLarge'),
        t('sidepanel.attachments.promptTitle'),
        'warn',
      );
      return;
    }

    // ── 提取文本：Office 先解析（内嵌图片需确认），纯文本走解码阶梯 ──
    let text: string;
    let source: AttachmentSource = 'plain';
    if (classification.kind === 'office') {
      let parsed: { text: string; hasEmbeddedImages: boolean };
      try {
        const buffer = await file.arrayBuffer();
        parsed = await parseOfficeDocument(buffer, classification.ext);
      } catch (error) {
        const reason =
          error instanceof AttachmentParseError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        await showAlert(
          t('sidepanel.attachments.parseFailed', { name: file.name, reason }),
          t('sidepanel.attachments.promptTitle'),
          'error',
        );
        return;
      }
      // 空产物防御：无任何文本的 Office 文档（空表 / 纯图片页）入列没有意义
      if (!parsed.text.trim()) {
        await showAlert(
          t('sidepanel.attachments.emptyDocument', { name: file.name }),
          t('sidepanel.attachments.promptTitle'),
          'warn',
        );
        return;
      }
      if (parsed.hasEmbeddedImages) {
        const proceed = await showConfirm(
          t('sidepanel.attachments.officeContainsImages', { name: file.name }),
          t('sidepanel.attachments.promptTitle'),
          'warn',
        );
        if (!proceed) return;
      }
      text = parsed.text;
      source = 'office';
    } else {
      try {
        const buffer = await file.arrayBuffer();
        text = decodeTextBuffer(buffer);
      } catch (error) {
        const reason =
          error instanceof AttachmentParseError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        await showAlert(
          t('sidepanel.attachments.parseFailed', { name: file.name, reason }),
          t('sidepanel.attachments.promptTitle'),
          'error',
        );
        return;
      }
    }

    // ── 上下文预算：单文件 ≤ 20%，累计 ≤ 50%，超额从前往后保留 ──
    const threshold = resolveThreshold();
    const singleCap = Math.floor(threshold * SINGLE_FILE_BUDGET_RATIO);
    const totalCap = Math.floor(threshold * TOTAL_BUDGET_RATIO);
    const remaining = totalCap - totalChars.value;

    if (remaining <= 0) {
      await showAlert(
        t('sidepanel.attachments.budgetExceeded'),
        t('sidepanel.attachments.promptTitle'),
        'warn',
      );
      return;
    }

    const allowed = Math.min(singleCap, remaining);
    let finalText = text;
    if (text.length > allowed) {
      finalText = safeSlice(text, allowed);
      await showAlert(
        t('sidepanel.attachments.fileTrimmed', { count: finalText.length }),
        t('sidepanel.attachments.promptTitle'),
        'info',
      );
    }

    attachments.value.push({
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      kind: 'text',
      text: finalText,
      chars: finalText.length,
      sizeBytes: file.size,
      source,
    });
  }

  return {
    attachments,
    isAdding,
    totalChars,
    addFiles,
    removeAttachment,
    removeImageAttachments,
    clearAttachments,
  };
}

export type AttachmentManager = ReturnType<typeof createAttachmentManager>;
