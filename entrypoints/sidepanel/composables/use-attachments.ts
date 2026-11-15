/**
 * 输入区附件栏管理（会话级状态 + 上传守卫流程）
 *
 * 职责：
 *   - 持有待发送附件的响应式列表与增删；
 *   - addFiles 完整守卫链（串行逐文件处理，保证交互与提示的时序正确）：
 *       数量上限 → 体积上限 → 图片（模型视觉能力引导 + 99MB 硬限 +
 *       压缩引擎整理 ≤2MB）/ 其它文件（原样入列）→ 入列。
 *
 * 架构口径（v3：文件即文件）：
 *   - **上传阶段不再解析任何文件内容**。文本不解码、Office 不解包——
 *     一切文件都以**原始字节**随消息落进会话工作区的 inputs/ 目录，
 *     模型按需调用 file_util 读取（文本分页、Office 转 Markdown）。
 *     这样做消除了「用户手上的文件」与「模型看到的解析产物」两份事实源
 *     可能不一致的隐患，也免除了上传时解析大文档的等待与失败面；
 *   - 图片是唯一例外：多模态链路需要 data URL，因此图片仍经压缩引擎
 *     整理（>2MB 或需转码的形态），但**原始文件同样入库**——模型可以用
 *     脚本处理原图，用户下载到的也是原图；
 *   - 体积与上下文口径：
 *       · 图片：不计入字符预算（多模态 image_url 直传，按固定 token/张计量）；
 *       · 其它文件：原样入列，模型侧读取时才按 3000 字符/页分页。
 *
 * 图片准入引导：当前生效模型未声明视觉能力时，弹二次确认（仍然上传 /
 * 取消上传 / 前往设置），由宿主注入 confirmImageWithoutVision 实现——
 * 保持本模块与弹窗层解耦（宿主缺失该实现时按安全侧拒绝上传）。
 */

import { ref } from 'vue';
import { t } from '@/utils/i18n';
import { isImageFilePath, fileExtension } from '@/utils/upload-files/file-kinds';
import {
  prepareImageForUpload,
  IMAGE_COMPRESS_TARGET_BYTES,
  ImageCompressionError,
} from '../utils/chat/image-compressor';
import { showAlert, showConfirm, type AppDialogResult } from './use-app-dialog';
import { WORKSPACE_MAX_FILE_BYTES } from '@/utils/python-workspace/paths';

// ==================== 常量与类型 ====================

/**
 * 图片附件体积硬限：99MB（异常体积防线；超过 2MB 的图片由压缩引擎
 * 整理到 ≤2MB 后才入列，体积本身不再占用上下文预算）。
 */
export const IMAGE_FILE_MAX_BYTES = 99 * 1024 * 1024;

/**
 * 其它文件的二次确认门槛：超过 15MB 弹窗确认「模型按需分页读取，
 * 读取耗时与上下文成本较高」。不拒绝——工作区本身有 128MB 单文件上限，
 * 超过上限在上传阶段明确拒绝（见 workspaceFileTooLarge）。
 */
export const LARGE_TEXT_FILE_CONFIRM_BYTES = 15 * 1024 * 1024;

/** 附件数量上限（防御性：杜绝海量小文件把清单元信息撑成超长消息） */
export const MAX_ATTACHMENT_COUNT = 50;

/** 附件形态（决定输入栏图标与气泡标记） */
export type AttachmentSource = 'image' | 'file';

/** 输入区待发送附件 */
export interface ChatAttachment {
  id: string;
  /** 用户可见的原始文件名（保持原格式展示） */
  name: string;
  /** image = 走多模态链路（另有一份压缩后的 data URL）；file = 原样入库 */
  kind: 'image' | 'file';
  /** 原始文件（发送时按原始字节写入工作区 inputs/） */
  rawFile?: File;
  /** 图片 data URL（kind=image 时存在，已过压缩引擎整理） */
  dataUrl?: string;
  /** 原始文件体积（字节，展示用） */
  sizeBytes: number;
  /** 图片整理后的最终体积（字节；与 sizeBytes 不同 = 发生了压缩/转码） */
  displayBytes?: number;
  /** 小写扩展名（无后缀为空串） */
  ext: string;
  /** 原始 MIME（可能为空串） */
  mimeType: string;
  /** 来源形态：图片 / 普通文件 */
  source: AttachmentSource;
}

/**
 * 批内视觉引导记忆（addFiles 批次作用域）。
 *
 * 同一批上传只弹一次视觉能力确认：首问结果对批内其余图片复用
 * （同批 = 同一上传意图，逐图连环弹窗只是打扰）；'cancel' / 'alternate'
 * 时批内剩余图片直接跳过，批次结束以系统通知条汇总跳过数量。
 * modelLabel 参与复用条件——模型中途变化（防御性，理论上批内不变）
 * 时按新模型重问，避免拿旧模型的答复约束新模型的判定。
 */
export interface BatchVisionMemo {
  decision: AppDialogResult | null;
  modelLabel: string;
  skipped: number;
}

/** 宿主注入的判定依赖（App.vue 提供，保持模块可单测） */
export interface AttachmentHostContext {
  /** 当前生效模型是否声明视觉能力 */
  isCurrentModelVision: () => boolean;
  /** 非阻塞进度通知（压缩等长时操作的即时反馈；缺省为 no-op） */
  notify?: (message: string) => void;
  /**
   * 视觉能力引导弹窗（模型无视觉能力时上传图片）。
   *
   * 契约：返回用户选择——'confirm'（仍然上传）/ 'cancel'（取消上传）/
   * 'alternate'（前往设置；调用方负责打开设置面板）。
   *
   * 缺省实现 = 直接拒绝上传（安全侧：无引导能力时不得让带图请求溜过去）。
   */
  confirmImageWithoutVision?: (modelLabel: string) => Promise<AppDialogResult>;
  /** 当前生效模型展示名（提示文案用） */
  currentModelLabel?: () => string;
}

// ==================== 工具 ====================

/** 字节数人性化（B/KB/MB） */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 多模态链路可处理的栅格图片 MIME（与 IMAGE_FILE_EXTENSIONS 口径一致） */
const RASTER_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

/**
 * 是否走多模态图片链路。
 *
 * 判定口径与 file-kinds 的图片后缀表同源（png/jpg/jpeg/gif/webp/bmp/ico）：
 *   - SVG 明确**不算**图片——主流视觉接口不接受 image/svg+xml，它按文本
 *     文件处理（可被 file_util 直接读取其源码）；
 *   - MIME 兜底只认同样这批浏览器可解码的栅格格式——HEIC/AVIF 等虽是
 *     image/*，但 Chrome 解码不了，走压缩链路必然报错丢件；按普通文件
 *     原样入库（用户可下载），模型也读不到，行为与能力边界一致。
 */
function isImageAttachment(file: File): boolean {
  if (file.type === 'image/svg+xml') return false;
  if (isImageFilePath(file.name)) return true;
  const mime = file.type.split(';')[0].trim().toLowerCase();
  return RASTER_IMAGE_MIMES.has(mime);
}

// ==================== 工厂 ====================

/**
 * 创建附件管理器（App.vue 持有单例；切换会话时应 clearAttachments）。
 * addFiles 串行处理：弹窗与压缩都依赖前一个文件的最终状态。
 */
export function createAttachmentManager(ctx: AttachmentHostContext) {
  const attachments = ref<ChatAttachment[]>([]);
  const isAdding = ref(false);
  let generation = 0;

  const notify = (message: string): void => {
    try {
      ctx.notify?.(message);
    } catch {
      /* 通知通道异常不影响附件流程 */
    }
  };

  /** 错误原因归一（弹窗文案用） */
  const reasonOf = (error: unknown): string =>
    error instanceof ImageCompressionError || error instanceof Error ? error.message : String(error);

  function removeAttachment(id: string): void {
    attachments.value = attachments.value.filter(item => item.id !== id);
  }

  function clearAttachments(): void {
    generation += 1;
    attachments.value = [];
  }

  /**
   * 文件批量入口：选择器多选 / 拖拽放置后逐个走守卫链，单个失败只提示不
   * 阻断后续。全程串行（await 弹窗/压缩 → 完成 → 下一文件），杜绝并发
   * 竞态；单文件的意外异常被兜底捕获为可读提示，绝不中断批次。
   * 批量超限一次提示（整批拒绝或截断到剩余额度），杜绝逐文件连环弹窗。
   */
  async function addFiles(files: File[], workspaceOnly = false): Promise<void> {
    if (isAdding.value || files.length === 0) return;
    const batchGeneration = generation;
    const isCurrent = () => batchGeneration === generation;
    // 同步占位（在任何 await 之前）：并发入口（拖拽 + 选择器）在弹窗等待期
    // 不得双双进入处理循环
    isAdding.value = true;
    try {
      // 批量数量守卫：上限已满整批拒绝；未满则截断到剩余额度（addOne 内的
      // 单文件守卫保留为第二道防线——防御批内其它入口并发写入）
      const room = Math.max(0, MAX_ATTACHMENT_COUNT - attachments.value.length);
      let batch = files;
      if (files.length > room) {
        await showAlert(
          room <= 0
            ? t('sidepanel.attachments.tooManyFiles', { count: MAX_ATTACHMENT_COUNT })
            : t('sidepanel.attachments.tooManyFilesPartial', {
                count: MAX_ATTACHMENT_COUNT,
                kept: room,
                dropped: files.length - room,
              }),
          t('sidepanel.attachments.promptTitle'),
          'warn',
        );
        if (room <= 0) return;
        batch = files.slice(0, room);
      }
      // 批内视觉引导记忆：同批只问一次（见 BatchVisionMemo）
      const visionMemo: BatchVisionMemo = { decision: null, modelLabel: '', skipped: 0 };
      for (const file of batch) {
        if (!isCurrent()) return;
        try {
          await addOne(file, visionMemo, workspaceOnly, isCurrent);
        } catch (error) {
          if (!isCurrent()) return;
          const reason = reasonOf(error);
          console.warn('[Attachments] 文件处理意外失败:', file.name, error);
          await showAlert(
            t('sidepanel.attachments.parseFailed', { name: file.name, reason }),
            t('sidepanel.attachments.promptTitle'),
            'error',
          );
        }
      }
      // 批次结束汇总：有图片因「无视觉能力且未放行」被跳过时一次性告知，
      // 逐文件弹提示只会把 N 张图变成 N 次打扰
      if (isCurrent() && visionMemo.skipped > 0) {
        notify(t('sidepanel.attachments.visionUploadBatchSkipped', { count: visionMemo.skipped }));
      }
    } finally {
      isAdding.value = false;
    }
  }

  /** 单文件守卫链（数量上限 → 体积上限 → 图片链 / 普通文件链 → 入列） */
  async function addOne(
    file: File,
    /** 批内共享的视觉引导记忆（同批首问复用；缺省 = 每文件独立询问） */
    visionMemo: BatchVisionMemo,
    workspaceOnly: boolean,
    isCurrent: () => boolean,
  ): Promise<void> {
    // ── 数量上限：防御海量小文件把清单元信息撑成超长消息 ──
    if (attachments.value.length >= MAX_ATTACHMENT_COUNT) {
      await showAlert(
        t('sidepanel.attachments.tooManyFiles', { count: MAX_ATTACHMENT_COUNT }),
        t('sidepanel.attachments.promptTitle'),
        'warn',
      );
      return;
    }

    // ── 体积上限：工作区单文件硬限（超限在上传阶段就拒绝，不留到发送时） ──
    if (file.size > WORKSPACE_MAX_FILE_BYTES) {
      await showAlert(
        t('sidepanel.attachments.workspaceFileTooLarge', { name: file.name, limit: formatBytes(WORKSPACE_MAX_FILE_BYTES) }),
        t('sidepanel.attachments.promptTitle'),
        'warn',
      );
      return;
    }

    // 图片走多模态链路（需压缩整理）；其余文件原样入列
    if (isImageAttachment(file) && !workspaceOnly) {
      await addImage(file, visionMemo, isCurrent);
      return;
    }
    await addFile(file, isCurrent);
  }

  // ── 图片链：视觉能力引导 → 99MB 硬限 → 压缩引擎整理（>2MB / 转码形态）→ 入列 ──
  //
  // 视觉能力引导（模型未声明视觉能力时）：不直接拒绝，而是二次确认——
  // 用户明确知晓「带图请求会被拒绝」后仍可上传（'confirm' 放行）；
  // 'cancel' 放弃上传；'alternate'（前往设置）由宿主打开设置面板。
  // 缺省引导实现 = 拒绝上传（安全侧）。
  // 批内记忆（visionMemo）：同一批上传只问一次，首问结果对批内其余图片
  // 复用——同批即同一上传意图，逐图连环弹窗只是打扰；模型中途变化
  // （理论上不可能，防御）时按新标签重问。
  async function addImage(
    file: File,
    visionMemo: BatchVisionMemo,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!ctx.isCurrentModelVision()) {
      const label = ctx.currentModelLabel?.() ?? '';
      // 同批且同模型：复用首问结果，不再弹窗
      if (visionMemo.decision !== null && visionMemo.modelLabel === label) {
        if (visionMemo.decision !== 'confirm') {
          visionMemo.skipped += 1;
          console.info(`[Attachments] 模型「${label || '(未配置)'}」无视觉能力，沿用批内选择跳过 ${file.name}`);
          return;
        }
      } else {
        const decision = ctx.confirmImageWithoutVision
          ? await ctx.confirmImageWithoutVision(label)
          : 'cancel';
        if (!isCurrent()) return;
        visionMemo.decision = decision;
        visionMemo.modelLabel = label;
        if (decision !== 'confirm') {
          visionMemo.skipped += 1;
          console.info(`[Attachments] 模型「${label || '(未配置)'}」无视觉能力，用户放弃上传 ${file.name}`);
          return;
        }
        console.warn(
          `[Attachments] 模型「${label || '(未配置)'}」无视觉能力，用户确认仍然上传 ${file.name}（带图请求可能被服务端拒绝）`,
        );
      }
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
    if (!isCurrent()) return;

    // 体积提示先行的长时操作反馈（>2MB 必然进压缩引擎）
    if (file.size > IMAGE_COMPRESS_TARGET_BYTES) {
      notify(t('sidepanel.attachments.compressing', { name: file.name, size: formatBytes(file.size) }));
    }

    const prepared = await prepareImageForUpload(buffer, fileExtension(file.name), file.type);
    if (!isCurrent()) return;

    // 整理结果反馈（压缩 / 转码发生时告知前后体积；直传静默）
    if (prepared.changed) {
      notify(
        t('sidepanel.attachments.compressed', {
          name: file.name,
          before: formatBytes(file.size),
          after: formatBytes(prepared.byteSize),
        }),
      );
    }

    attachments.value.push({
      id: crypto.randomUUID(),
      name: file.name,
      rawFile: file,
      kind: 'image',
      dataUrl: prepared.dataUrl,
      sizeBytes: file.size,
      displayBytes: prepared.byteSize,
      ext: fileExtension(file.name),
      mimeType: file.type,
      source: 'image',
    });
  }

  // ── 普通文件链：大文件确认 → 原样入列（**不解析内容**） ──
  async function addFile(file: File, isCurrent: () => boolean): Promise<void> {
    // ── 超大文件二次确认：不拒绝（模型按需分页读取，内容零丢失），但让用户知情 ──
    if (file.size > LARGE_TEXT_FILE_CONFIRM_BYTES) {
      const proceed = await showConfirm(
        t('sidepanel.attachments.largeFileConfirm', { name: file.name, size: formatBytes(file.size) }),
        t('sidepanel.attachments.promptTitle'),
        'warn',
      );
      if (!isCurrent()) return;
      if (!proceed) {
        notify(t('sidepanel.attachments.largeFileDeclined', { name: file.name }));
        return;
      }
    }

    attachments.value.push({
      id: crypto.randomUUID(),
      name: file.name,
      rawFile: file,
      kind: 'file',
      sizeBytes: file.size,
      ext: fileExtension(file.name),
      mimeType: file.type,
      source: 'file',
    });
  }

  return {
    attachments,
    isAdding,
    addFiles,
    removeAttachment,
    clearAttachments,
  };
}

export type AttachmentManager = ReturnType<typeof createAttachmentManager>;
