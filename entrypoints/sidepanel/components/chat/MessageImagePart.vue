<template>
  <div class="screen-container" :class="{ collapsed: !expanded }">
    <!-- 折叠头：默认收起（与推理容器同形态），点击展开具体截屏 -->
    <button
      type="button"
      class="screen-header"
      :aria-expanded="expanded"
      :title="expanded ? t('sidepanel.chat.imagesCollapse') : t('sidepanel.chat.viewScreen')"
      @click="expanded = !expanded"
    >
      <span class="screen-icon" aria-hidden="true">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M20,3H4C2.9,3 2,3.9 2,5V15A2,2 0 0,0 4,17H6V20H8V17H16V20H18V17H20A2,2 0 0,0 22,15V5C22,3.9 21.1,3 20,3M20,15H4V5H20V15M12,7A3,3 0 0,1 15,10A3,3 0 0,1 12,13A3,3 0 0,1 9,10A3,3 0 0,1 12,7Z" fill="#6366f1"/>
        </svg>
      </span>
      <span class="screen-title">{{ t('sidepanel.chat.viewScreen') }}</span>
      <svg class="screen-expand-icon" :class="{ collapsed: !expanded }" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" fill="currentColor"/>
      </svg>
    </button>

    <!-- 展开体：具体截屏文件；点击图片进入共享看图层（放大 / 下载） -->
    <div v-if="expanded" class="screen-body">
      <button
        v-if="url"
        type="button"
        class="screen-frame"
        :title="t('sidepanel.chat.imagesExpand')"
        @click="viewerOpen = true"
      >
        <img :src="url" :alt="t('sidepanel.chat.viewScreen')" loading="lazy" />
      </button>
      <div v-else-if="url === null" class="screen-missing" :title="t('sidepanel.chat.imageUnavailable')">
        <span aria-hidden="true">!</span>
        <span class="screen-missing-text">{{ t('sidepanel.chat.imageUnavailable') }}</span>
      </div>
      <div v-else class="screen-loading" aria-hidden="true"></div>
    </div>

    <!-- 共享看图层（放大 / 翻页 / 下载 / Esc 关闭；单图无翻页按钮） -->
    <ImageViewer
      v-if="viewerOpen && url"
      :items="viewerItems"
      :index="0"
      @close="viewerOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 内联截屏片段（MessageImagePart）—— vision 自动截图的「查看屏幕」容器
 *
 * 形态对标推理容器（reasoning-container）：折叠头 + 展开体，按截屏发生
 * 顺序内联在消息片段流中（首截图在消息最前、每轮工具后的重截图紧跟其
 * 轮次），多轮截屏因此按时间线排列，而不是统一堆在消息尾部。
 *
 * 数据契约：片段只持内容哈希引用（imageRef），object URL 经 imageStore
 * 解析（缓存/回收归 imageStore 统一管理，本组件只读）；查看/放大/下载
 * 复用共享组件 ImageViewer，与底部图片区同一份实现。
 *
 * 防御：坏引用 / 图片被回收 → 占位展示不抛错；解析失败记 null 不重试风暴。
 */
import { computed, ref, watch } from 'vue';
import { t } from '@/utils/i18n';
import { imageStore } from '../../core';
import ImageViewer from './ImageViewer.vue';

const props = defineProps<{
  /** 图片内容哈希引用（片段 imageRef） */
  imageRef: string;
}>();

/** 展开状态（缺省收起：截屏不打断正文阅读） */
const expanded = ref(false);
/** 看图层开关（单图；翻页无意义不显示） */
const viewerOpen = ref(false);
/** object URL（undefined = 解析中；null = 缺失/失败；string = 就绪） */
const url = ref<string | null | undefined>(undefined);

watch(
  () => props.imageRef,
  ref => {
    url.value = undefined;
    void resolve(ref);
  },
  { immediate: true },
);

async function resolve(ref: string): Promise<void> {
  try {
    url.value = await imageStore.getObjectUrl(ref);
  } catch {
    url.value = null;
  }
}

/** 看图层输入（就绪态由 v-if 保证非空） */
const viewerItems = computed(() =>
  url.value ? [{ ref: props.imageRef, url: url.value }] : [],
);
</script>

<style scoped>
@import './message-image-part.css';
</style>
