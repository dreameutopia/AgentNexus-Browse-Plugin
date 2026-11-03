<template>
  <div v-if="visible" class="ai-processing-overlay">
    <div class="ai-processing-modal">
      <div class="processing-content">
        <div class="processing-icon">
          <div class="spinner">
            <div class="spinner-ring"></div>
            <div class="spinner-ring"></div>
            <div class="spinner-ring"></div>
          </div>
        </div>
        <div class="processing-text">
          <h3 class="processing-title">{{ t('sidepanel.voice.processingTitle') }}</h3>
          <p class="processing-subtitle">{{ t('sidepanel.voice.processingSubtitle') }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/utils/i18n';
// 独立样式文件：app.css 经 App.vue <style scoped> 引入无法穿透子组件，
// 这里直接全局 import 确保弹窗样式生效（与 voice-recording-modal.css 同一模式）。
import './ai-processing-overlay.css';

defineProps<{
  visible: boolean;
}>();
</script>
