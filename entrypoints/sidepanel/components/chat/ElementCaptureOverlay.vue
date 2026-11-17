<!--
  侧边栏「元素捕获中」遮罩

  说明：遮罩只覆盖侧边栏，不遮挡网页——用户需要在网页内移动鼠标选取元素。
  退出方式：网页内 Esc / 本遮罩「结束捕获」按钮。
-->
<template>
  <div v-if="active" class="eco-overlay" role="status" aria-live="polite">
    <div class="eco-card">
      <div class="eco-icon" aria-hidden="true">
        <Crosshair :size="22" :stroke-width="1.8" />
      </div>
      <div class="eco-title">{{ t('sidepanel.elementCapture.capturingTitle') }}</div>
      <p class="eco-desc">{{ t('sidepanel.elementCapture.capturingHint') }}</p>
      <div class="eco-steps">
        <div class="eco-step">
          <span class="eco-kbd">Ctrl</span>
          <span>+</span>
          <span class="eco-kbd">{{ t('sidepanel.elementCapture.mouseLeft') }}</span>
          <span class="eco-step-text">{{ t('sidepanel.elementCapture.confirmStep') }}</span>
        </div>
        <div class="eco-step">
          <span class="eco-kbd">Esc</span>
          <span class="eco-step-text">{{ t('sidepanel.elementCapture.escapeStep') }}</span>
        </div>
      </div>
      <div class="eco-count">
        {{ t('sidepanel.elementCapture.selectedCount', { count, max }) }}
      </div>
      <button type="button" class="eco-cancel" @click="emit('cancel')">
        {{ t('sidepanel.elementCapture.finish') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Crosshair } from 'lucide-vue-next';
import { t } from '@/utils/i18n';

withDefaults(
  defineProps<{
    active: boolean;
    count?: number;
    max?: number;
    error?: string;
  }>(),
  { count: 0, max: 100, error: '' },
);

const emit = defineEmits<{
  (event: 'cancel'): void;
}>();
</script>

<style scoped>
.eco-overlay {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(12, 14, 18, 0.66);
  backdrop-filter: blur(2px);
}

.eco-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: min(320px, 100%);
  padding: 20px 18px;
  border-radius: 14px;
  background: var(--panel-bg, #ffffff);
  color: var(--text-color, #1f2328);
  box-shadow: 0 20px 54px rgba(0, 0, 0, 0.34);
  text-align: center;
}

.eco-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
  animation: eco-pulse 1.6s ease-in-out infinite;
}

.eco-title {
  font-size: 14px;
  font-weight: 600;
}

.eco-desc {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--secondary-text-color, #6b7280);
}

.eco-steps {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 9px;
  background: rgba(127, 127, 127, 0.08);
  font-size: 11px;
  color: var(--secondary-text-color, #4b5563);
}

.eco-step {
  display: flex;
  align-items: center;
  gap: 5px;
}

.eco-step-text {
  margin-left: 2px;
}

.eco-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  height: 19px;
  padding: 0 5px;
  border-radius: 5px;
  border: 1px solid var(--border-color, rgba(127, 127, 127, 0.3));
  border-bottom-width: 2px;
  background: var(--panel-bg, #fff);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
}

.eco-count {
  font-size: 11px;
  color: var(--secondary-text-color, #6b7280);
}

.eco-cancel {
  margin-top: 2px;
  border: 0;
  border-radius: 8px;
  padding: 7px 18px;
  font-size: 12px;
  cursor: pointer;
  background: rgba(127, 127, 127, 0.16);
  color: inherit;
}

.eco-cancel:hover {
  background: rgba(127, 127, 127, 0.24);
}

@keyframes eco-pulse {
  0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.3); }
  50% { transform: scale(1.05); box-shadow: 0 0 0 8px rgba(239, 68, 68, 0); }
}
</style>
