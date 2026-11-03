<template>
  <div v-if="visible" class="voice-recording-overlay">
    <div class="voice-recording-modal">
      <div class="recording-header">
        <div class="recording-icon-wrapper">
          <div class="recording-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2C13.1 2 14 2.9 14 4V12C14 13.1 13.1 14 12 14C10.9 14 10 13.1 10 12V4C10 2.9 10.9 2 12 2ZM19 10V12C19 15.9 15.9 19 12 19C8.1 19 5 15.9 5 12V10H7V12C7 14.8 9.2 17 12 17C14.8 17 17 14.8 17 12V10H19ZM10 21H14V23H10V21Z" fill="currentColor"/>
            </svg>
            <div v-if="isRecording" class="recording-pulse-ring"></div>
          </div>
        </div>
        <div class="recording-header-content">
          <h3 class="recording-title">{{ t('sidepanel.voice.recordingTitle') }}</h3>
          <p class="recording-subtitle">{{ isRecording ? t('sidepanel.voice.recordingSubtitleRecording') : t('sidepanel.voice.recordingSubtitleRecognizing') }}</p>
        </div>
      </div>
      
      <div class="recording-content">
        <div class="recording-timer-section">
          <div class="timer-display">
            <span class="current-time">{{ Math.floor(recordingTime / 60).toString().padStart(2, '0') }}:{{ (recordingTime % 60).toString().padStart(2, '0') }}</span>
            <span class="time-separator">/</span>
            <span class="max-time">{{ Math.floor(maxRecordingTime / 60).toString().padStart(2, '0') }}:{{ (maxRecordingTime % 60).toString().padStart(2, '0') }}</span>
          </div>
          <div class="timer-progress">
            <div class="progress-bar" :style="{ width: (recordingTime / maxRecordingTime * 100) + '%' }"></div>
          </div>
        </div>

        <div class="recording-status">
          <div v-if="isRecording" class="status-indicator recording">
            <div class="status-dot"></div>
            <span class="status-text">{{ t('sidepanel.voice.statusRecording') }}</span>
          </div>
          <div v-else class="status-indicator stopped">
            <div class="status-dot"></div>
            <span class="status-text">{{ t('sidepanel.voice.statusStopped') }}</span>
          </div>
        </div>
      </div>
      
      <div class="recording-actions">
        <button v-if="isRecording" class="recording-btn recording-btn-stop" @click="$emit('stop')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>
          </svg>
          <span>{{ t('sidepanel.voice.stopRecording') }}</span>
        </button>
        
        <button v-if="!isRecording" class="recording-btn recording-btn-cancel" @click="$emit('cancel')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/>
          </svg>
          <span>{{ t('common.cancel') }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/utils/i18n';
// 独立样式文件：app.css 经 App.vue <style scoped> 引入无法穿透子组件，
// 这里直接全局 import 确保弹窗样式生效（app.css 中的旧定义已删除）
import './voice-recording-modal.css';

defineProps<{
  visible: boolean;
  isRecording: boolean;
  recordingTime: number;
  maxRecordingTime: number;
}>();

defineEmits<{
  'stop': [];
  'cancel': [];
}>();
</script>
