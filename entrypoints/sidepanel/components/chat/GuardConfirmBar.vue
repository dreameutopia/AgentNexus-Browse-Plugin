<!--
  循环守卫确认条（非阻塞）

  取代旧的 window.confirm 守卫确认：
  - window.confirm 是同步模态：打开期间整个 sidepanel 的 JS 线程被冻结，
    停止按钮、流式渲染、事件处理全部无响应，且无法被 abort 信号打断；
  - 本组件为普通行内 UI：确认期间界面保持可用，停止可即刻生效，
    超时未确认按「停止」处理（默认安全侧，防止无人值守时无限运行）。

  纯展示组件：文案、倒计时数值由父层（App.vue）驱动，决定权在父层持有
  的 Promise resolver；本组件只 emit continue / stop 两个意图。
-->
<template>
  <Transition name="guard-bar">
    <div v-if="visible" class="guard-confirm-bar" role="alertdialog" aria-live="assertive">
      <div class="guard-bar-main">
        <span class="guard-bar-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12,2L1,21H23M12,6L19.53,19H4.47M11,10V14H13V10M11,16V18H13V16" fill="currentColor"/>
          </svg>
        </span>
        <div class="guard-bar-text">
          <p class="guard-bar-title">{{ titleText }}</p>
          <p class="guard-bar-hint">{{ hintWithCountdown }}</p>
        </div>
      </div>
      <div class="guard-bar-actions">
        <button type="button" class="guard-btn guard-btn-stop" @click="emit('stop')">
          {{ t('sidepanel.chat.guardStop') }}
        </button>
        <button type="button" class="guard-btn guard-btn-continue" @click="emit('continue')">
          {{ t('sidepanel.chat.guardContinue') }}
        </button>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { t } from '@/utils/i18n';

const props = defineProps<{
  visible: boolean;
  /** 触发守卫的类型（与引擎 guard 事件同源） */
  kind: 'max-iterations' | 'max-duration' | 'tool-failures';
  /** max-iterations 时的轮数上限 / tool-failures 时的连续失败轮数 */
  count?: number;
  /** max-duration 时的时长上限（分钟） */
  minutes?: number;
  /** 自动停止倒计时剩余秒数 */
  secondsLeft: number;
}>();

const emit = defineEmits<{
  continue: [];
  stop: [];
}>();

const titleText = computed(() => {
  if (props.kind === 'max-iterations') {
    return t('sidepanel.chat.guardTitleIterations', { count: props.count ?? 0 });
  }
  if (props.kind === 'tool-failures') {
    return t('sidepanel.chat.guardTitleFailures', { count: props.count ?? 0 });
  }
  return t('sidepanel.chat.guardTitleDuration', { minutes: props.minutes ?? 0 });
});

const hintWithCountdown = computed(() =>
  t('sidepanel.chat.guardHint', { seconds: props.secondsLeft }),
);
</script>

<style scoped>
.guard-confirm-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0 12px 8px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(245, 158, 11, 0.35);
  background: rgba(245, 158, 11, 0.08);
}

.guard-bar-main {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}

.guard-bar-icon {
  flex-shrink: 0;
  display: inline-flex;
  margin-top: 1px;
  color: #b45309;
}

.guard-bar-text {
  min-width: 0;
}

.guard-bar-title {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: #92400e;
  line-height: 1.45;
}

.guard-bar-hint {
  margin: 2px 0 0;
  font-size: 11.5px;
  color: #b45309;
  line-height: 1.4;
}

.guard-bar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.guard-btn {
  border: none;
  border-radius: 7px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: filter 0.15s ease, transform 0.05s ease;
}

.guard-btn:active {
  transform: scale(0.97);
}

.guard-btn-stop {
  color: #92400e;
  background: rgba(245, 158, 11, 0.14);
  border: 1px solid rgba(245, 158, 11, 0.35);
}

.guard-btn-stop:hover {
  filter: brightness(0.96);
}

.guard-btn-continue {
  color: #fff;
  background: #f59e0b;
}

.guard-btn-continue:hover {
  filter: brightness(1.05);
}

/* 进出场：与输入区其它面板一致的轻量位移淡入 */
.guard-bar-enter-active,
.guard-bar-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.guard-bar-enter-from,
.guard-bar-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
