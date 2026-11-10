<template>
  <div v-if="visible" class="deep-search-warning-overlay">
    <div class="deep-search-warning-modal">
      <div class="warning-header">
        <div class="warning-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2L13.09 8.26L22 9L13.09 9.74L12 16L10.91 9.74L2 9L10.91 8.26L12 2Z" fill="currentColor"/>
          </svg>
        </div>
        <h3 class="warning-title">{{ t('sidepanel.deepSearch.title') }}</h3>
      </div>
      
      <div class="warning-content">
        <p class="warning-message">
          {{ t('sidepanel.deepSearch.message') }}
        </p>
        <p class="warning-submessage">
          {{ t('sidepanel.deepSearch.submessage') }}
        </p>
      </div>
      
      <div class="warning-actions">
        <button class="warning-btn warning-btn-primary" @click="$emit('go-to-website-settings')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.22,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.22,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.03 4.95,18.95L7.44,17.94C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.68 16.04,18.34 16.56,17.94L19.05,18.95C19.27,19.03 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z" fill="currentColor"/>
          </svg>
          {{ t('sidepanel.deepSearch.openWebsites') }}
        </button>
        
        <button class="warning-btn warning-btn-secondary" @click="$emit('go-to-agent-selector')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12,2A2,2 0 0,1 14,4C14,5.11 13.11,6 12,6C10.89,6 10,5.11 10,4A2,2 0 0,1 12,2M21,9V7L15,1L13.5,2.5L16.17,5.17L10.58,10.76C10.22,10.54 9.8,10.38 9.35,10.35L8.8,9.8L7.39,11.21L7.94,11.76C7.97,12.21 8.13,12.63 8.35,12.99L2.76,18.58L4.17,20L9.76,14.41C10.12,14.63 10.54,14.79 10.99,14.82L11.54,15.37L12.95,13.96L12.4,13.41C12.37,12.96 12.21,12.54 11.99,12.18L17.58,6.59L20.25,9.25L21.75,7.75L21,9M12.19,12.19C12,12.69 11.61,13.08 11.11,13.27C10.61,13.46 10.05,13.44 9.56,13.2C9.07,13 8.68,12.61 8.49,12.11C8.3,11.61 8.32,11.05 8.56,10.56C8.8,10.07 9.19,9.68 9.69,9.49C10.19,9.3 10.75,9.32 11.24,9.56C11.73,9.8 12.12,10.19 12.31,10.69C12.5,11.19 12.48,11.75 12.24,12.24L12.19,12.19Z" fill="currentColor"/>
          </svg>
          {{ t('sidepanel.deepSearch.chooseOtherAgent') }}
        </button>
        
        <button class="warning-btn warning-btn-cancel" @click="$emit('close')">
          {{ t('common.cancel') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/utils/i18n';
// 独立样式文件：App.vue 的 app.css 经 <style scoped> 引入，作用域属性无法穿透到子组件内部，
// 这里直接全局 import 确保弹窗样式生效（与 asr-config-prompt.css 同一模式；
// app.css 中的旧定义已删除，避免两处维护）。
import './deep-search-warning.css';

defineProps<{
  visible: boolean;
}>();

defineEmits<{
  'close': [];
  'go-to-website-settings': [];
  'go-to-agent-selector': [];
}>();
</script>
