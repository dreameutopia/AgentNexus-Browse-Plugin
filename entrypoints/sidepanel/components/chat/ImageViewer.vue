<template>
  <Teleport to="body">
    <div
      v-if="currentItem"
      class="image-viewer"
      role="dialog"
      :aria-label="t('sidepanel.chat.imagesExpand')"
      @click.self="emit('close')"
    >
      <button type="button" class="viewer-close" :title="t('common.close')" @click="emit('close')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
        </svg>
      </button>
      <button v-if="items.length > 1" type="button" class="viewer-nav prev" :title="t('sidepanel.chat.imagePrev')" @click="step(-1)">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M15.41,7.41L14,6L8,12L14,18L15.41,16.59L10.83,12L15.41,7.41Z" fill="currentColor"/>
        </svg>
      </button>
      <button v-if="items.length > 1" type="button" class="viewer-nav next" :title="t('sidepanel.chat.imageNext')" @click="step(1)">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M8.59,16.59L10,18L16,12L10,6L8.59,7.41L13.17,12L8.59,16.59Z" fill="currentColor"/>
        </svg>
      </button>

      <figure class="viewer-stage" @click="toggleZoom">
        <img
          v-if="currentItem.url"
          :src="currentItem.url"
          :class="['viewer-img', { zoomed: zoomIndex > 0 }]"
          :style="imgStyle"
          :alt="currentItem.alt || t('sidepanel.chat.imagesExpand')"
          @load="onImageLoad"
        />
        <p v-else class="viewer-unavailable">{{ t('sidepanel.chat.imageUnavailable') }}</p>
      </figure>

      <!-- 底部按钮组：缩小 / 放大 / 在网页中打开 / 下载 -->
      <div class="viewer-toolbar">
        <span v-if="items.length > 1" class="viewer-counter">{{ index + 1 }} / {{ items.length }}</span>
        <button
          type="button"
          class="viewer-btn viewer-btn--zoom"
          :title="t('sidepanel.chat.imageZoomOut')"
          :disabled="!canZoomOut"
          @click="zoomOut"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M5,11H19V13H5V11Z" fill="currentColor"/>
          </svg>
          <span>{{ t('sidepanel.chat.imageZoomOut') }}</span>
        </button>
        <button
          type="button"
          class="viewer-btn viewer-btn--zoom"
          :title="t('sidepanel.chat.imageZoomIn')"
          :disabled="!canZoomIn"
          @click="zoomIn"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M11,5H13V11H19V13H13V19H11V13H5V11H11V5Z" fill="currentColor"/>
          </svg>
          <span>{{ t('sidepanel.chat.imageZoomIn') }}</span>
        </button>
        <button
          type="button"
          class="viewer-btn"
          :title="t('sidepanel.chat.imageOpenInBrowser')"
          @click="openInBrowser"
        >
          {{ t('sidepanel.chat.imageOpenInBrowser') }}
        </button>
        <button type="button" class="viewer-btn" :title="t('sidepanel.chat.imageDownload')" @click="download">
          {{ t('sidepanel.chat.imageDownload') }}
        </button>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * 共享全屏看图层（ImageViewer）
 *
 * 从 MessageImages 抽取：消息底部图片区（用户上传图）、消息内联
 * 「查看屏幕」片段（vision 截图）与回答内截图引用（<agent-image>）
 * 共用同一套查看 / 缩放 / 打开 / 下载交互，交互行为只存在一份实现，
 * 杜绝两处漂移。
 *
 * 契约：
 *   - items 由调用方完成 object URL 解析（url=null 表示缺失/读取失败，
 *     展示占位），本组件只读不释放——URL 生命周期归 imageStore 统一管理；
 *   - index 受控（update:index 回传翻页结果），组件内部只管理缩放态；
 *   - name 可选：下载文件名主干（缺省按时间戳生成）；
 *   - alt 可选：图片说明（模型给出的描述），缺省用通用文案；
 *   - 键盘：Esc 关闭、← → 翻页、+ / - 缩放（挂载时监听、卸载时摘除，
 *     组件仅在打开期间存在）。
 *
 * 缩放模型：zoomIndex = 0 表示「适应窗口」，1 起为原始像素的倍数档位
 * （1 / 1.5 / 2 / 3 / 4）。放大后按原始像素尺寸显式给出宽高——放大是
 * 「看得更清楚」，不是「把同样的像素拉大」，因此不依赖 transform 缩放。
 *
 * 防御：越界下标回落首项；下载依赖的 URL/元信息缺失时静默返回并告警，
 * 绝不抛错打断查看。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { t } from '@/utils/i18n';
import { imageStore } from '../../core';

/** MIME → 下载文件扩展名（未命中回退 png，截图场景的主流形态） */
const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
};

/** 缩放档位（原始像素的倍数；索引 0 = 适应窗口） */
const ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const;

const props = defineProps<{
  /**
   * 已解析的图片条目（顺序即翻页顺序）。
   *
   * downloadUrl / downloadName 可选：调用方持有**原始文件**（如用户上传
   * 的原图，与展示用的压缩副本不同）时传入，下载按钮就取原始文件与原名；
   * 缺省则回落到 url + 由 MIME 推导的文件名。
   */
  items: ReadonlyArray<{
    ref: string;
    url: string | null;
    name?: string | null;
    alt?: string | null;
    downloadUrl?: string | null;
    downloadName?: string | null;
  }>;
  /** 当前展示下标（受控） */
  index: number;
}>();

const emit = defineEmits<{
  'update:index': [index: number];
  close: [];
}>();

/** 缩放档位下标（0 = 适应窗口；>0 = ZOOM_STEPS[zoomIndex-1] 倍） */
const zoomIndex = ref(0);
/** 图片原始像素尺寸（未加载时为 0；放大按此计算显式宽高） */
const naturalWidth = ref(0);
const naturalHeight = ref(0);

// 切换图片时复位缩放（原图尺寸也随之作废）
watch(
  () => props.index,
  () => {
    zoomIndex.value = 0;
    naturalWidth.value = 0;
    naturalHeight.value = 0;
  },
);

/** 当前条目（越界回落首项，绝不出现空渲染崩溃） */
const currentItem = computed(() => props.items[props.index] ?? props.items[0]);

/** 是否处于放大态（>0 档位） */
const isZoomed = computed(() => zoomIndex.value > 0);

/** 放大后的显式尺寸（原始像素 × 档位倍数；未加载时交回 CSS 自适应） */
const imgStyle = computed(() => {
  if (!isZoomed.value || !naturalWidth.value || !naturalHeight.value) return undefined;
  const factor = ZOOM_STEPS[zoomIndex.value - 1];
  return {
    width: `${Math.round(naturalWidth.value * factor)}px`,
    height: `${Math.round(naturalHeight.value * factor)}px`,
  };
});

/** 还能否继续放大（档位未到顶且原图尺寸已知） */
const canZoomIn = computed(() => zoomIndex.value < ZOOM_STEPS.length && naturalWidth.value > 0);
/** 还能否继续缩小（未到「适应窗口」档） */
const canZoomOut = computed(() => zoomIndex.value > 0);

/** 图片加载完成：记录原始像素尺寸（放大档位的计算依据） */
const onImageLoad = (event: Event): void => {
  const image = event.target as HTMLImageElement | null;
  if (!image) return;
  naturalWidth.value = image.naturalWidth || 0;
  naturalHeight.value = image.naturalHeight || 0;
};

/** 放大一档 */
const zoomIn = (): void => {
  if (!canZoomIn.value) return;
  zoomIndex.value += 1;
};

/** 缩小一档（回到「适应窗口」即止） */
const zoomOut = (): void => {
  if (!canZoomOut.value) return;
  zoomIndex.value -= 1;
};

/** 点击画面：在「适应窗口」与「原始尺寸」之间切换 */
const toggleZoom = (): void => {
  if (zoomIndex.value > 0) {
    zoomIndex.value = 0;
    return;
  }
  if (!naturalWidth.value) return;
  zoomIndex.value = 1;
};

/** 前后翻页（环形；受控回传） */
const step = (delta: number): void => {
  const count = props.items.length;
  if (count <= 1) return;
  emit('update:index', (props.index + delta + count) % count);
};

/**
 * 在网页（浏览器新标签页）中打开当前图片。
 *
 * 图片本体是图片库的 blob: object URL——扩展页与新标签页同源，可直接打开。
 * 弹窗被拦截时退回扩展 API 开标签页（同样失败则静默：绝不打断查看）。
 */
const openInBrowser = (): void => {
  const url = currentItem.value?.url;
  if (!url) return;
  // 不用 noopener 特性：它会让 window.open 恒返回 null，无法判定是否被拦截
  const opened = window.open(url, '_blank');
  if (opened) {
    opened.opener = null;
    return;
  }
  try {
    const tabs = (globalThis as { chrome?: { tabs?: { create?: (options: { url: string }) => void } } }).chrome?.tabs;
    tabs?.create?.({ url });
  } catch (error) {
    console.warn('[ImageViewer] 在新标签页打开图片失败:', error);
  }
};

/**
 * 下载当前图片。
 *
 * 优先用调用方给的原始文件（downloadUrl + downloadName）——用户上传的
 * 原图与展示用的压缩副本不是同一份，下载必须给回用户亲手给的那一份；
 * 没有原始文件时回落到展示 URL，并按图片库 MIME 推导文件名。
 */
const download = async (): Promise<void> => {
  const item = props.items[props.index] ?? props.items[0];
  if (!item) return;
  try {
    let url = item.downloadUrl ?? item.url;
    if (!url) {
      url = await imageStore.getObjectUrl(item.ref);
      if (!url) return;
    }
    const meta = await imageStore.getMeta(item.ref);
    const extension = MIME_EXTENSION[meta?.mime ?? ''] ?? 'png';
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download =
      item.downloadName ??
      (item.name ? `${item.name}.${extension}` : `image-${stamp}.${extension}`);
    anchor.click();
  } catch (error) {
    console.warn('[ImageViewer] 图片下载失败:', error);
  }
};

/** 键盘：Esc 关闭、方向键翻页、+/- 缩放（仅打开期间挂载） */
const onKeydown = (event: KeyboardEvent): void => {
  if (event.key === 'Escape') {
    event.stopPropagation();
    emit('close');
    return;
  }
  if (event.key === 'ArrowLeft') step(-1);
  if (event.key === 'ArrowRight') step(1);
  if (event.key === '+' || event.key === '=') zoomIn();
  if (event.key === '-' || event.key === '_') zoomOut();
};
onMounted(() => window.addEventListener('keydown', onKeydown, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true));
</script>

<style scoped>
@import './image-viewer.css';
</style>
