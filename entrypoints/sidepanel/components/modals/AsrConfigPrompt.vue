<template>
  <div v-if="visible" class="asr-prompt-overlay" @click.self="$emit('close')">
    <div class="asr-prompt-modal">
      <!-- 顶部图标 -->
      <div class="asr-prompt-icon">
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z" fill="currentColor"/>
        </svg>
        <span class="asr-prompt-icon-badge">!</span>
      </div>

      <!-- 文案 -->
      <h3 class="asr-prompt-title">{{ t('sidepanel.asr.promptTitle') }}</h3>
      <p class="asr-prompt-message">{{ t('sidepanel.asr.promptMessage') }}</p>

      <!-- 支持的供应商提示 -->
      <div class="asr-prompt-providers">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M11,7H13V13H11V7M11,15H13V17H11V15Z" fill="currentColor"/>
        </svg>
        <span>{{ t('sidepanel.asr.promptFeatureHint') }}</span>
      </div>

      <!-- 操作按钮 -->
      <div class="asr-prompt-actions">
        <button type="button" class="asr-prompt-btn asr-prompt-btn-secondary" @click="$emit('close')">
          {{ t('sidepanel.asr.promptCancel') }}
        </button>
        <button type="button" class="asr-prompt-btn asr-prompt-btn-primary" @click="$emit('configure')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.22,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.22,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.03 4.95,18.95L7.44,17.94C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.68 16.04,18.34 16.56,17.94L19.05,18.95C19.27,19.03 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z" fill="currentColor"/>
          </svg>
          {{ t('sidepanel.asr.promptGoSettings') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/utils/i18n';
// 独立样式文件：App.vue 的 app.css 经 <style scoped> 引入，作用域属性无法穿透到子组件内部，
// 这里直接全局 import 确保弹窗样式生效（与 voice-recording-modal.css 同一模式）。
import './asr-config-prompt.css';

defineProps<{
  visible: boolean;
}>();

defineEmits<{
  close: [];
  /** 前往设置的「语音识别」分区完成配置 */
  configure: [];
}>();
</script>
