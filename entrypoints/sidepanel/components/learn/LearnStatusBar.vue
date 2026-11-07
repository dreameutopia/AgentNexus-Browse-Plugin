<script setup lang="ts">
/**
 * 学习运行状态条（替换输入区）
 *
 * 学习 / 验证运行期间输入区不再接受普通输入，改为常驻状态条：
 * 阶段徽章 + 已运行时长 + 工具调用数 + 上下文占用 + 终止按钮。
 * 计时、计数与上下文占用由 use-learn-session 统一驱动（组件只读不算）：
 * 前两者由编排层维护，上下文占用来自引擎每轮测量的 context-usage 事件——
 * 与普通对话的用量环同一数据源，学习期间底部工具栏隐藏，状态条是
 * 窗口压力的唯一呈现位。数字与引擎真实进度同源，不自行估算。
 */
import { computed } from 'vue';
import { t } from '@/utils/i18n';
import type { ContextUsage } from '@/entrypoints/sidepanel/core';
import { COMPACTION_PRE_RUN_RATIO } from '@/entrypoints/sidepanel/core';
import './learn-theme.css';

const props = defineProps<{
  phase: 'learning' | 'validating';
  elapsedMs: number;
  toolCalls: number;
  /** 是否处于强制收尾轮（模型未交终态，编排层补跑的一轮） */
  forceSubmitting?: boolean;
  /** 本阶段最近一次请求的真实上下文用量（null = 尚未发起请求，隐藏该项） */
  contextUsage?: ContextUsage | null;
  /** 是否正在压缩上下文（引擎压缩事件驱动；期间用量即将回落） */
  compacting?: boolean;
}>();

const emit = defineEmits<{
  stop: [];
}>();

/** 占用百分比（0 取整；超限如实超过 100，是「已越限」的直观信号） */
const contextPercent = computed(() =>
  props.contextUsage && props.contextUsage.threshold > 0
    ? Math.round((props.contextUsage.totalTokens / props.contextUsage.threshold) * 100)
    : null,
);

/**
 * 逼近压缩线即转警示色——阈值直接引用 COMPACTION_PRE_RUN_RATIO（发送前
 * 压缩线），保证「变红 = 已到压缩触发线」与引擎判定恒一致，不各自硬编码。
 * 学习路径无发送前压缩（压缩只发生在运行中 90% 线），此处取较早的一条线
 * 作为「即将触发压缩」的提前预警，给用户留出反应余量。
 */
const contextHigh = computed(
  () => (contextPercent.value ?? 0) >= COMPACTION_PRE_RUN_RATIO * 100,
);

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
    <template v-if="contextPercent !== null">
      <span class="learn-status__dot" aria-hidden="true">·</span>
      <span
        class="learn-status__meta learn-status__context"
        :class="{ 'learn-status__context--high': contextHigh }"
      >
        {{ t('sidepanel.learn.statusContext', { percent: contextPercent }) }}
      </span>
      <span v-if="props.compacting" class="learn-status__meta learn-status__context-compacting">
        {{ t('sidepanel.learn.statusCompacting') }}
      </span>
    </template>

    <span class="learn-status__hint">
      {{ props.forceSubmitting ? t('sidepanel.learn.statusForceSubmitting') : t('sidepanel.learn.statusHint') }}
    </span>

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

/* 上下文占用：达到 85%（预压缩线）转警示色，早于 90% 运行中压缩线提醒 */
.learn-status__context--high {
  color: var(--learn-danger);
  font-weight: 600;
}

.learn-status__context-compacting {
  color: var(--learn-accent-deep);
  animation: learn-pulse 1.4s ease-in-out infinite;
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
