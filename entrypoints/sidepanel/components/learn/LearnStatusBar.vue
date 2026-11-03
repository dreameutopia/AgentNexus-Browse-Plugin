<script setup lang="ts">
/**
 * 学习运行状态条（替换输入区）
 *
 * 学习 / 验证运行期间输入区不再接受普通输入，改为常驻状态条：
 * 阶段徽章 + 已运行时长 + 工具调用数 + 终止按钮。
 * 计时与计数由 use-learn-session 统一驱动（组件只读不算），
 * 保证状态条数字与引擎真实进度同源。
 */
import { t } from '@/utils/i18n';
import './learn-theme.css';

const props = defineProps<{
  phase: 'learning' | 'validating';
  elapsedMs: number;
  toolCalls: number;
}>();

const emit = defineEmits<{
  stop: [];
}>();

/** mm:ss */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
</script>

<template>
  <div class="learn-status learn-root" role="status" aria-live="polite">
    <span class="learn-status__pulse" aria-hidden="true"></span>

    <span class="learn-status__phase">
      {{ props.phase === 'validating' ? t('sidepanel.learn.statusValidating') : t('sidepanel.learn.statusLearning') }}
    </span>

    <span class="learn-status__meta">
      {{ t('sidepanel.learn.statusElapsed', { elapsed: formatElapsed(props.elapsedMs) }) }}
    </span>
    <span class="learn-status__dot" aria-hidden="true">·</span>
    <span class="learn-status__meta">
      {{ t('sidepanel.learn.statusToolCalls', { count: props.toolCalls }) }}
    </span>

    <span class="learn-status__hint">{{ t('sidepanel.learn.statusHint') }}</span>

    <button type="button" class="learn-status__stop" @click="emit('stop')">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M6 6H18V18H6V6Z" fill="currentColor" />
      </svg>
      {{ t('sidepanel.learn.stopButton') }}
    </button>
  </div>
</template>

<style scoped>
.learn-status {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  width: 100%;
  padding: 11px 14px;
  border-radius: 12px;
  background: var(--learn-accent-soft);
  border: 1px solid var(--learn-accent-soft-border);
  font-size: 12.5px;
}

.learn-status__pulse {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--learn-accent);
  animation: learn-pulse 1.4s ease-in-out infinite;
}

@keyframes learn-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.4;
    transform: scale(0.75);
  }
}

.learn-status__phase {
  font-weight: 600;
  color: var(--learn-accent-deep);
}

.learn-status__meta {
  color: var(--learn-text-muted);
  font-variant-numeric: tabular-nums;
}

.learn-status__dot {
  color: var(--learn-text-faint);
}

.learn-status__hint {
  flex: 1 1 auto;
  min-width: 160px;
  color: var(--learn-text-faint);
  font-size: 11.5px;
}

.learn-status__stop {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  padding: 6px 14px;
  border: none;
  border-radius: 8px;
  background: var(--learn-danger);
  color: #ffffff;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease;
}

.learn-status__stop:hover {
  background: #dc2626;
}

@media (max-width: 560px) {
  .learn-status__hint {
    display: none;
  }
}
</style>
