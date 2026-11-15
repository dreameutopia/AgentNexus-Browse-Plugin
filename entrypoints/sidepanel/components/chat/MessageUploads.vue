<template>
  <div v-if="files.length > 0" class="message-uploads">
    <div class="message-uploads-label">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M13,9V3.5L18.5,9H13Z" fill="currentColor"/>
      </svg>
      <span>{{ t('sidepanel.chat.uploadsLabel', { count: files.length }) }}</span>
    </div>

    <ul class="message-uploads-list">
      <li v-for="file in files" :key="file.path" class="upload-item">
        <!-- 图片：缩略图 + 放大查看（看图层内含下载） -->
        <button
          v-if="isImage(file)"
          type="button"
          class="upload-thumb"
          :title="t('sidepanel.chat.imageOpenInBrowser')"
          @click="openViewer(file)"
        >
          <img
            v-if="thumbOf(file)"
            :src="thumbOf(file)"
            :alt="file.name"
            loading="lazy"
          />
          <span v-else class="upload-thumb-missing" aria-hidden="true">!</span>
        </button>
        <span v-else class="upload-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M6 3h8l4 4v14H6z M14 3v5h4 M12 10v7m-3-3 3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
          </svg>
        </span>

        <span class="upload-info">
          <span class="upload-name" :title="file.path">{{ file.name }}</span>
          <span class="upload-size">{{ formatBytes(file.sizeBytes) }}</span>
        </span>

        <!-- html / pdf：直接在网页打开查看 -->
        <button
          v-if="isPreviewable(file)"
          type="button"
          class="upload-action"
          :title="t('sidepanel.chat.uploadOpenPreview')"
          @click="openPreview(file)"
        >
          {{ t('sidepanel.chat.uploadOpenPreview') }}
        </button>
        <!-- 其余格式：仅支持下载 -->
        <button
          v-else-if="!isImage(file)"
          type="button"
          class="upload-action"
          :title="t('sidepanel.chat.uploadDownload')"
          @click="download(file)"
        >
          {{ t('sidepanel.chat.uploadDownload') }}
        </button>
      </li>
    </ul>

    <!-- 瞬时失败提示（下载/预览失败时短暂展示，不打断消息阅读） -->
    <p v-if="notice" class="upload-notice" role="status">{{ notice }}</p>

    <!-- 放大看图层（共享组件：放大 / 缩小 / 前后翻页 / 下载 / Esc 关闭） -->
    <ImageViewer
      v-if="viewerIndex !== null"
      :items="viewerItems"
      :index="viewerIndex"
      @update:index="viewerIndex = $event"
      @close="viewerIndex = null"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 消息内「上传文件元素」区（MessageUploads）
 *
 * 呈现用户消息里随本轮发出的全部上传文件（图片、文档、表格、代码……）。
 * 三类交互口径：
 *   - 图片：缩略图 + 点击放大查看（共享 ImageViewer：缩放 / 翻页 / 下载）；
 *     下载取**工作区里的原始文件**（用户亲手给的那一份），而不是模型侧的
 *     压缩副本——用户要的是「拿回我的文件」；
 *   - html / pdf：直接在网页打开查看（独立预览页 file-preview.html，
 *     HTML 走沙箱页渲染，不可信内容不触达扩展能力）；
 *   - 其余格式：仅支持下载。
 *
 * 数据形态：只接收文件条目元信息（路径 / 名称 / 大小 / 后缀 / 图片引用），
 * 文件本体在会话工作区 inputs/ 下；组件按需读取，绝不在转录里携带 base64。
 *
 * 防御性：
 *   - 图片引用缺失 / 读取失败显示占位，不抛错、不阻塞其余文件；
 *   - 下载与预览失败以提示条告知，绝不打断消息阅读；
 *   - object URL 生命周期归本组件（创建后缓存，卸载时统一 revoke）。
 */
import { computed, inject, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { t } from '@/utils/i18n';
import { imageStore } from '../../core';
import { readWorkspaceUpload } from '@/utils/python-workspace/store';
import { isImageFilePath } from '@/utils/upload-files/file-kinds';
import type { UploadedFileEntry } from '@/utils/upload-files/upload-file-manifest';
import { formatBytes } from '../../composables/use-attachments';
import ImageViewer from './ImageViewer.vue';

const props = defineProps<{
  /** 本条用户消息携带的上传文件条目 */
  files: UploadedFileEntry[];
}>();

/** 当前会话 id（工作区文件读取的定位键；由消息列表注入） */
const workspaceChatId = inject<Ref<string | undefined> | undefined>('workspaceChatId', undefined);

/** 图片缩略图 object URL（按工作区路径索引；三态：undefined=未解析 / null=缺失） */
const thumbUrls = ref<Record<string, string | null | undefined>>({});
/** 原始文件 object URL（下载用；按工作区路径索引） */
const originalUrls = ref<Record<string, string>>({});
/** 看图层当前下标（null = 关闭） */
const viewerIndex = ref<number | null>(null);

/** 可网页预览的后缀（渲染方式由预览页按扩展名分派） */
const PREVIEWABLE_EXTENSIONS = new Set(['html', 'htm', 'pdf']);

/** 是否图片条目（按后缀判定；与上传侧的后缀表同源） */
const isImage = (file: UploadedFileEntry): boolean => isImageFilePath(file.name);

/** 是否支持网页预览 */
const isPreviewable = (file: UploadedFileEntry): boolean => PREVIEWABLE_EXTENSIONS.has(file.ext.toLowerCase());

/** 缩略图 URL（未就绪或缺失时返回 undefined——模板据此显示占位） */
const thumbOf = (file: UploadedFileEntry): string | undefined => {
  const url = thumbUrls.value[file.path];
  return typeof url === 'string' ? url : undefined;
};

/**
 * 本条消息里的图片条目（看图层翻页范围）。
 *
 * 刻意不过滤「缺 imageRef」的条目：图片库引用可能随 GC 消失，但工作区里
 * 的原始文件仍在——看图层对这类条目显示「图片不可用」占位，下载仍能取到
 * 用户的原文件，能力不丢。
 */
const imageFiles = computed(() => props.files.filter(file => isImage(file)));

/** 解析图片缩略图（幂等；缺失记 null 不重试风暴） */
const resolveThumbs = async (): Promise<void> => {
  for (const file of imageFiles.value) {
    if (file.path in thumbUrls.value || !file.imageRef) continue;
    try {
      thumbUrls.value[file.path] = await imageStore.getObjectUrl(file.imageRef);
    } catch {
      thumbUrls.value[file.path] = null;
    }
  }
};

watch(
  () => props.files,
  () => {
    void resolveThumbs();
  },
  { immediate: true },
);

/** 取（并缓存）原始文件的 object URL——下载必须给用户原文件 */
const ensureOriginalUrl = async (file: UploadedFileEntry): Promise<string | null> => {
  const cached = originalUrls.value[file.path];
  if (cached) return cached;
  const chatId = workspaceChatId?.value;
  if (!chatId) return null;
  try {
    const blob = await readWorkspaceUpload(chatId, file.path);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    originalUrls.value[file.path] = url;
    return url;
  } catch (error) {
    console.warn('[MessageUploads] 读取原始上传文件失败:', error);
    return null;
  }
};

/** 看图层条目（显示用压缩副本 + 下载用原始文件） */
const viewerItems = computed(() =>
  imageFiles.value.map(file => ({
    ref: file.imageRef ?? '',
    url: (thumbUrls.value[file.path] as string | null | undefined) ?? null,
    name: file.name.replace(/\.[^.]+$/, ''),
    downloadUrl: originalUrls.value[file.path] ?? null,
    downloadName: file.name,
  })),
);

/** 打开看图层：先备齐原始文件（下载用），再定位到被点击的那张 */
const openViewer = async (file: UploadedFileEntry): Promise<void> => {
  await Promise.all(imageFiles.value.map(entry => ensureOriginalUrl(entry)));
  const index = imageFiles.value.findIndex(entry => entry.path === file.path);
  if (index < 0 && imageFiles.value.length === 0) {
    // 理论不可达（缩略图按钮只对图片渲染）：防御性兜底转下载，不静默无响应
    await download(file);
    return;
  }
  viewerIndex.value = index >= 0 ? index : 0;
};

/**
 * 在网页（独立预览页）中打开 html / pdf。
 *
 * 只传会话与路径，文件内容由预览页自行从工作区读取——侧边栏不必为预览
 * 再读一遍大文件的 blob，也避免 object URL 的跨页生命周期管理。
 */
const openPreview = (file: UploadedFileEntry): void => {
  const chatId = workspaceChatId?.value;
  const tabs = typeof chrome === 'undefined' ? undefined : chrome.tabs;
  if (!chatId || !tabs?.create) {
    flashNotice(t('sidepanel.chat.uploadActionFailed', { name: file.name }));
    return;
  }
  const query = new URLSearchParams({ chat: chatId, path: file.path });
  const url = `${chrome.runtime.getURL('file-preview.html')}?${query.toString()}`;
  tabs.create({ url, active: true }).catch((error: unknown) => {
    console.warn('[MessageUploads] 打开文件预览失败:', error);
    flashNotice(t('sidepanel.chat.uploadActionFailed', { name: file.name }));
  });
};

/** 瞬时失败提示（2.5s 自动消失；不打断消息阅读，但失败对用户可见可分析） */
const notice = ref('');
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
const flashNotice = (message: string): void => {
  notice.value = message;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = '';
    noticeTimer = undefined;
  }, 2500);
};
onBeforeUnmount(() => {
  if (noticeTimer) clearTimeout(noticeTimer);
});

/** 下载原始文件（用户上传的那一份，不是压缩副本） */
const download = async (file: UploadedFileEntry): Promise<void> => {
  const url = await ensureOriginalUrl(file);
  if (!url) {
    console.warn('[MessageUploads] 上传文件已不可用:', file.path);
    flashNotice(t('sidepanel.chat.uploadActionFailed', { name: file.name }));
    return;
  }
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  try {
    document.body.appendChild(anchor);
    anchor.click();
  } catch (error) {
    console.warn('[MessageUploads] 文件下载失败:', error);
    flashNotice(t('sidepanel.chat.uploadActionFailed', { name: file.name }));
  } finally {
    anchor.remove();
  }
};

// 卸载时回收本组件创建的 object URL（缩略图归 imageStore，不在此回收）
onBeforeUnmount(() => {
  for (const url of Object.values(originalUrls.value)) URL.revokeObjectURL(url);
  originalUrls.value = {};
});
</script>

<style scoped>
@import './message-uploads.css';
</style>
