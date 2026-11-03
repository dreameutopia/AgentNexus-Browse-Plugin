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

      <figure class="viewer-stage" @click="zoomed = !zoomed">
        <img
          v-if="currentItem.url"
          :src="currentItem.url"
          :class="['viewer-img', { zoomed }]"
          :alt="t('sidepanel.chat.imagesExpand')"
        />
        <p v-else class="viewer-unavailable">{{ t('sidepanel.chat.imageUnavailable') }}</p>
      </figure>

      <div class="viewer-toolbar">
        <span class="viewer-counter">{{ index + 1 }} / {{ items.length }}</span>
        <button type="button" class="viewer-btn" @click="zoomed = !zoomed">
          {{ zoomed ? t('sidepanel.chat.imageZoomOut') : t('sidepanel.chat.imageZoomIn') }}
        </button>
        <button type="button" class="viewer-btn" @click="download">
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
 * 从 MessageImages 抽取：消息底部图片区（用户上传图）与消息内联
 * 「查看屏幕」片段（vision 截图）共用同一套查看/放大/下载/翻页交互，
 * 交互行为只存在一份实现，杜绝两处漂移。
 *
 * 契约：
 *   - items 由调用方完成 object URL 解析（url=null 表示缺失/读取失败，
 *     展示占位），本组件只读不释放——URL 生命周期归 imageStore 统一管理；
 *   - index 受控（update:index 回传翻页结果），组件内部只管理缩放态；
 *   - 键盘：Esc 关闭、← → 翻页（挂载时监听、卸载时摘除，组件仅在打开期间存在）。
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

const props = defineProps<{
  /** 已解析的图片条目（顺序即翻页顺序） */
  items: ReadonlyArray<{ ref: string; url: string | null }>;
  /** 当前展示下标（受控） */
  index: number;
}>();

const emit = defineEmits<{
  'update:index': [index: number];
  close: [];
}>();

/** 缩放态（true = 自然尺寸放大）；切换图片时复位 */
const zoomed = ref(false);
watch(
  () => props.index,
  () => {
    zoomed.value = false;
  },
);

/** 当前条目（越界回落首项，绝不出现空渲染崩溃） */
const currentItem = computed(() => props.items[props.index] ?? props.items[0]);

/** 前后翻页（环形；受控回传） */
const step = (delta: number): void => {
  const count = props.items.length;
  if (count <= 1) return;
  emit('update:index', (props.index + delta + count) % count);
};

/** 下载当前图片：优先复用已解析 URL，缺失时回读图片库；文件名按 MIME 推导 */
const download = async (): Promise<void> => {
  const item = props.items[props.index] ?? props.items[0];
  if (!item) return;
  try {
    let url = item.url;
    if (!url) {
      url = await imageStore.getObjectUrl(item.ref);
      if (!url) return;
    }
    const meta = await imageStore.getMeta(item.ref);
    const extension = MIME_EXTENSION[meta?.mime ?? ''] ?? 'png';
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `image-${stamp}.${extension}`;
    anchor.click();
  } catch (error) {
    console.warn('[ImageViewer] 图片下载失败:', error);
  }
};

/** 键盘：Esc 关闭、方向键翻页（仅打开期间挂载） */
const onKeydown = (event: KeyboardEvent): void => {
  if (event.key === 'Escape') {
    event.stopPropagation();
    emit('close');
    return;
  }
  if (event.key === 'ArrowLeft') step(-1);
  if (event.key === 'ArrowRight') step(1);
};
onMounted(() => window.addEventListener('keydown', onKeydown, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true));
</script>

<style scoped>
@import './image-viewer.css';
</style>
