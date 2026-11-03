<script setup lang="ts">
/**
 * 草稿暂存失败降级说明（非阻断）
 *
 * 降级发生于收尾阶段「暂存草稿」失败：流程照常结束，但草稿不会自动送达
 * 管理中心，本次学习成果无法兑现，必须显式告知用户。
 * 不阻断的原因：阻断会把收尾流程卡死，而恢复路径（重跑学习 / 打开会话
 * 读回草稿）并不依赖此刻的弹窗；故只做一次强提示，由用户决定何时关闭。
 */
import { t } from '@/utils/i18n';

const props = defineProps<{ visible: boolean }>();

const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Transition name="learn-degraded">
    <div v-if="visible" class="learn-degraded-overlay" @click.self="emit('close')">
      <div class="learn-degraded" role="alertdialog" aria-modal="true">
        <header class="learn-degraded__header">
          <span class="learn-degraded__badge" aria-hidden="true">⚠️</span>
          <h3 class="learn-degraded__title">{{ t('sidepanel.learn.draftSaveDegradedTitle') }}</h3>
        </header>
        <div class="learn-degraded__body">
          <p class="learn-degraded__text">{{ t('sidepanel.learn.draftSaveDegradedBody') }}</p>
        </div>
        <footer class="learn-degraded__footer">
          <button type="button" class="learn-degraded__btn" @click="emit('close')">
            {{ t('sidepanel.learn.draftSaveDegradedAck') }}
          </button>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.learn-degraded-overlay {
  position: fixed;
  inset: 0;
  z-index: 940; /* 低于确认弹窗（950）：它只补充说明，不参与流程决策 */
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(15, 23, 42, 0.45);
}

.learn-degraded {
  display: flex;
  flex-direction: column;
  width: min(440px, 100%);
  border-radius: 14px;
  background: var(--bg-elevated, #0f172a);
  color: var(--text-primary, #e2e8f0);
  box-shadow:
    0 24px 60px rgba(0, 0, 0, 0.4),
    0 0 0 1px var(--border, rgba(148, 163, 184, 0.2));
  overflow: hidden;
}

.learn-degraded__header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 20px 0;
}

.learn-degraded__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  font-size: 15px;
  background: rgba(245, 158, 11, 0.18);
}

.learn-degraded__title {
  margin: 0;
  font-size: 15.5px;
  font-weight: 600;
}

.learn-degraded__body {
  padding: 12px 20px 4px;
}

.learn-degraded__text {
  margin: 0;
  font-size: 13px;
  line-height: 1.75;
  color: var(--text-secondary, #cbd5e1);
}

.learn-degraded__footer {
  display: flex;
  justify-content: flex-end;
  padding: 16px 20px 18px;
}

.learn-degraded__btn {
  padding: 9px 18px;
  border: none;
  border-radius: 9px;
  background: var(--accent, #3b82f6);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.learn-degraded__btn:hover {
  opacity: 0.9;
}

.learn-degraded-enter-active,
.learn-degraded-leave-active {
  transition: opacity 0.18s ease;
}

.learn-degraded-enter-from,
.learn-degraded-leave-to {
  opacity: 0;
}
</style>
