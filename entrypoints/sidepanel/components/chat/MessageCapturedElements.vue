<!--
  用户消息下方的捕获元素区（与文件元素同区排布）

  只做容器与事件中转：chip 渲染 / 缩略图加载统一交给 CapturedElementList，
  保证输入区与消息区视觉与行为同源。
-->
<template>
  <div v-if="elements.length > 0" class="message-captured-elements">
    <CapturedElementList
      :elements="elements"
      validate-placement="below"
      @open="element => emit('open', element)"
      @validate="element => emit('validate', element)"
    />
  </div>
</template>

<script setup lang="ts">
import type { CapturedElement } from '@/utils/element-capture/types';
import CapturedElementList from './CapturedElementList.vue';

defineProps<{
  elements: CapturedElement[];
}>();

const emit = defineEmits<{
  (event: 'open', element: CapturedElement): void;
  (event: 'validate', element: CapturedElement): void;
}>();
</script>

<style scoped>
.message-captured-elements {
  width: 100%;
  margin-top: 6px;
}
</style>
