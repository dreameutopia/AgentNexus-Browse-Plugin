<template>
  <div v-if="imageRefs.length > 0" class="message-images">
    <!-- 折叠头：默认收起（不打断阅读），点击展开缩略图 -->
    <button
      type="button"
      class="message-images-header"
      :aria-expanded="expanded"
      :title="expanded ? t('sidepanel.chat.imagesCollapse') : t('sidepanel.chat.imagesExpand')"
      @click="expanded = !expanded"
    >
      <span class="message-images-icon" aria-hidden="true">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M4,5H20A1,1 0 0,1 21,6V18A1,1 0 0,1 20,19H4A1,1 0 0,1 3,18V6A1,1 0 0,1 4,5M12,14L16.5,9.5L14.5,7.5L12,10L9.5,7.5L7.5,9.5L12,14Z" fill="currentColor"/>
        </svg>
      </span>
      <span class="message-images-count">{{ t('sidepanel.chat.imagesCount', { count: imageRefs.length }) }}</span>
      <svg class="message-images-chevron" :class="{ collapsed: !expanded }" width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M7.41,8.59L12,13.17L16.59,8.59L18,10L12,16L6,10L7.41,8.59Z" fill="currentColor"/>
      </svg>
    </button>

    <!-- 缩略图网格（展开态） -->
    <div v-if="expanded" class="message-images-grid">
      <button
        v-for="(item, index) in items"
        :key="item.ref"
        type="button"
        class="message-images-thumb"
        :title="t('sidepanel.chat.imagesExpand')"
        @click="openViewer(index)"
      >
        <img v-if="item.url !== undefined && item.url !== null" :src="item.url" :alt="t('sidepanel.chat.imagesCount', { count: 1 })" loading="lazy" />
        <span v-else-if="item.url === null" class="message-images-thumb-missing" :title="t('sidepanel.chat.imageUnavailable')">!</span>
        <span v-else class="message-images-thumb-loading" aria-hidden="true"></span>
      </button>
    </div>

    <!-- 全屏看图层（共享组件：放大 / 缩小 / 前后翻页 / 下载 / Esc 关闭） -->
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
 * 消息关联图片区（MessageImages）
 *
 * 数据形态：只接收内容哈希引用（imageRefs），二进制经 imageStore 解析为
 * object URL——转录库永不携带 base64，本组件也绝不触碰存储细节。
 *
 * 交互约定：默认收起（折叠头显示张数，不打断消息阅读）；展开后为缩略图
 * 网格，点击进入全屏看图层（查看 / 放大 / 下载 / 翻页统一由共享组件
 * ImageViewer 提供，与消息内联「查看屏幕」片段同一份实现）。
 *
 * 防御性：
 *   - object URL 由 imageStore 统一缓存与回收（LRU 驱逐即 revoke），
 *     本组件只读不释放，避免双重生命周期管理；
 *   - 图片缺失 / 读取失败显示占位，不抛错、不阻塞其余图片。
 */
import { computed, ref, watch } from 'vue';
import { t } from '@/utils/i18n';
import { imageStore } from '../../core';
import ImageViewer from './ImageViewer.vue';

const props = defineProps<{
  /** 关联图片的内容哈希引用列表（消息记录 imageRefs） */
  imageRefs: string[];
}>();

/** 折叠状态（缺省收起） */
const expanded = ref(false);
/** 看图层当前下标（null = 关闭） */
const viewerIndex = ref<number | null>(null);

/**
 * 引用 → object URL 解析表。
 * undefined = 解析中；null = 图片不存在 / 读取失败（占位展示）。
 */
const urlTable = ref<Record<string, string | null | undefined>>({});

/** 解析尚未处理过的引用（幂等：已记录的键跳过，失败记 null 不重试风暴） */
const resolveUrls = async (refs: readonly string[]): Promise<void> => {
  for (const ref of refs) {
    if (ref in urlTable.value) continue;
    try {
      const url = await imageStore.getObjectUrl(ref);
      // 引用可能在解析期间被会话删除回收：回填 null 即展示占位
      urlTable.value[ref] = url;
    } catch {
      urlTable.value[ref] = null;
    }
  }
};

watch(
  () => props.imageRefs,
  refs => {
    void resolveUrls(refs);
  },
  { immediate: true },
);

/**
 * 展示条目（保持与 imageRefs 同序，供缩略图与看图层共用）。
 * url 三态保留：undefined = 解析中；null = 缺失/失败；string = 就绪。
 */
const items = computed(() =>
  props.imageRefs.map(ref => ({ ref, url: urlTable.value[ref] })),
);

/** 看图层输入（三态收敛为 string | null：解析中按缺失占位，打开即定格） */
const viewerItems = computed(() =>
  props.imageRefs.map(ref => ({ ref, url: urlTable.value[ref] ?? null })),
);

const openViewer = (index: number): void => {
  viewerIndex.value = index;
};
</script>

<style scoped>
@import './message-images.css';
</style>
