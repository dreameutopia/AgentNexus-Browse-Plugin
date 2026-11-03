<template>
  <div v-if="visible" class="voice-assistant-settings-overlay">
    <div class="voice-assistant-settings-modal">
      <div class="settings-header">
        <div class="settings-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z" fill="#8b5cf6"/>
          </svg>
        </div>
        <h3 class="settings-title">{{ t('sidepanel.voice.assistantSettingsTitle') }}</h3>
      </div>
      
      <div class="settings-content">
        <div class="settings-description">
          <p class="description-text">
            {{ t('sidepanel.voice.assistantSettingsDesc') }}
          </p>
        </div>
        
        <div class="settings-option">
          <div class="option-info">
            <label class="option-label">{{ t('sidepanel.voice.autoWakeLabel') }}</label>
            <p class="option-description">{{ t('sidepanel.voice.autoWakeDesc') }}</p>
          </div>
          <div class="option-control">
            <button 
              class="toggle-switch" 
              :class="{ 'active': autoWake }"
              @click="$emit('toggle-auto-wake')"
            >
              <div class="toggle-slider"></div>
            </button>
          </div>
        </div>
      </div>
      
      <div class="settings-actions">
        <button class="modal-btn modal-btn-cancel" @click="$emit('cancel')">
          {{ t('common.cancel') }}
        </button>
        <button class="modal-btn modal-btn-confirm" @click="$emit('confirm')">
          {{ t('sidepanel.voice.confirmEnter') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/utils/i18n';

defineProps<{
  visible: boolean;
  autoWake: boolean;
}>();

defineEmits<{
  'cancel': [];
  'confirm': [];
  'toggle-auto-wake': [];
}>();
</script>
