<!--
  应用级轻量弹窗（use-app-dialog 的唯一展示层）

  单例组件：App.vue 挂载一次，状态由 use-app-dialog 提供；
  alert（单按钮）/ confirm（双按钮）两种形态 × info/warn/error 三种语义色。
  点击遮罩：alert 视为已知悉（关闭），confirm 视为取消（安全侧默认）。
-->
<template>
  <Transition name="app-dialog">
    <div
      v-if="dialog.visible"
      class="app-dialog-overlay"
      @click.self="handleOverlayClick"
    >
      <div class="app-dialog" role="dialog" aria-modal="true">
        <div class="app-dialog-icon" :class="`tone-${dialog.tone}`">
          <svg v-if="dialog.tone === 'error'" width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20M13,7H11V13H13M13,15H11V17H13" fill="currentColor"/>
          </svg>
          <svg v-else-if="dialog.tone === 'warn'" width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12,2L1,21H23M12,6L19.53,19H4.47M11,10V14H13V10M11,16V18H13V16" fill="currentColor"/>
          </svg>
          <svg v-else width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M13,9H11V7H13M13,17H11V11H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" fill="currentColor"/>
          </svg>
        </div>
        <h4 class="app-dialog-title">{{ dialog.title }}</h4>
        <p class="app-dialog-message">{{ dialog.message }}</p>
        <div class="app-dialog-actions">
          <button
            v-if="dialog.mode === 'confirm'"
            type="button"
            class="app-dialog-btn app-dialog-btn-secondary"
            @click="settleAppDialog(false)"
          >
            {{ dialog.cancelText }}
          </button>
          <button
            type="button"
            class="app-dialog-btn app-dialog-btn-primary"
            @click="settleAppDialog(true)"
          >
            {{ dialog.confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { nextTick, onUnmounted, watch } from 'vue';
import { useAppDialog, settleAppDialog } from '../../composables/use-app-dialog';

const dialog = useAppDialog();

/** 遮罩点击：alert 视为已知悉；confirm 视为取消（安全侧，不会误确认） */
const handleOverlayClick = () => {
  settleAppDialog(dialog.value.mode === 'confirm' ? false : true);
};

// 弹窗打开：聚焦弹窗容器（键盘可达）并接管 Escape；
// 关闭：移除监听。单例组件随 App 挂载，watch 生命周期与组件一致
let keydownHandler: ((event: KeyboardEvent) => void) | null = null;

watch(
  () => dialog.value.visible,
  visible => {
    if (visible) {
      keydownHandler = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          // Escape 与遮罩点击同语义：confirm 取消（安全侧），alert 已知悉
          settleAppDialog(dialog.value.mode === 'confirm' ? false : true);
        }
      };
      document.addEventListener('keydown', keydownHandler, true);
      void nextTick(() => {
        // 初始焦点策略：warn/error 的 confirm 初始聚焦次按钮（安全侧，
        // 回车不会误触破坏性确认）；其余聚焦主按钮
        const focusCancel =
          dialog.value.mode === 'confirm' && (dialog.value.tone === 'warn' || dialog.value.tone === 'error');
        const target = focusCancel
          ? document.querySelector<HTMLButtonElement>('.app-dialog-btn-secondary')
          : document.querySelector<HTMLButtonElement>('.app-dialog-btn-primary');
        target?.focus();
      });
    } else if (keydownHandler) {
      document.removeEventListener('keydown', keydownHandler, true);
      keydownHandler = null;
    }
  },
);

// 组件卸载兜底：弹窗意外残留时移除全局监听（单例组件随 App 挂载，常态不触发）
onUnmounted(() => {
  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler, true);
    keydownHandler = null;
  }
});
</script>

<style>
@import './app-dialog.css';
</style>
