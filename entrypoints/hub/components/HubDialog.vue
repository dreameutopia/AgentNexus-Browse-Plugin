<template>
  <!--
    管理中心通用确认弹窗（玻璃材质，语义色仅用于状态表达）

    与侧边栏的 AppDialog 是两套实现：侧边栏那套挂在 App.vue 上、走全局单例，
    管理中心是独立扩展页面、不挂载侧边栏组件，故在此自带一份同语言的实现。

    安全侧默认：遮罩点击与 Escape 一律等价于「取消」，绝不误触破坏性确认；
    破坏性（warn / error）形态的初始焦点落在次按钮上，回车不会直接执行删除。
  -->
  <Teleport to="body">
    <div v-if="visible" class="hub-dialog-overlay" @click.self="handleOverlayClick">
      <div
        ref="panelRef"
        class="hub-dialog"
        role="alertdialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        :aria-describedby="messageId"
      >
        <div class="hub-dialog__icon" :class="`is-${tone}`" aria-hidden="true">
          <svg v-if="tone === 'error'" width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20M13,7H11V13H13M13,15H11V17H13" fill="currentColor" />
          </svg>
          <svg v-else-if="tone === 'warn'" width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12,2L1,21H23M12,6L19.53,19H4.47M11,10V14H13V10M11,16V18H13V16" fill="currentColor" />
          </svg>
          <svg v-else width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M13,9H11V7H13M13,17H11V11H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" fill="currentColor" />
          </svg>
        </div>
        <h3 :id="titleId" class="hub-dialog__title">{{ title }}</h3>
        <p :id="messageId" class="hub-dialog__message">{{ message }}</p>
        <div class="hub-dialog__actions">
          <button
            v-if="cancelText"
            type="button"
            class="hub-dialog__btn hub-dialog__btn--secondary"
            :disabled="busy"
            @click="emit('cancel')"
          >
            {{ cancelText }}
          </button>
          <button
            type="button"
            class="hub-dialog__btn hub-dialog__btn--primary"
            :class="{ 'is-danger': tone === 'error' }"
            :disabled="busy"
            @click="emit('confirm')"
          >
            {{ confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * 管理中心确认弹窗（受控组件）。
 *
 * 形态：info（告知）/ warn（警告）/ error（破坏性）；按钮文案由使用方传入
 * （i18n 由调用方解析 —— 本组件不含任何文案，避免两处维护同一句话）。
 *
 * 交互约定：
 *   - 遮罩点击与 Escape ≡ 取消（安全侧默认，绝不误触破坏性确认）；
 *   - 初始焦点：破坏性形态落在「取消」上，其余落在主按钮；
 *   - busy 期间两个按钮都禁用，避免重复提交同一破坏性操作。
 */
import { nextTick, onUnmounted, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    visible: boolean;
    title: string;
    message: string;
    /** 语义色：info（默认）/ warn / error */
    tone?: 'info' | 'warn' | 'error';
    confirmText?: string;
    cancelText?: string;
    /** 异步处理中：禁用按钮，防止重复提交 */
    busy?: boolean;
  }>(),
  {
    tone: 'info',
    confirmText: '',
    cancelText: '',
    busy: false,
  },
);

const emit = defineEmits<{
  (event: 'confirm'): void;
  (event: 'cancel'): void;
}>();

const panelRef = ref<HTMLElement | null>(null);
/** 标题 / 正文的 aria 关联 id（同一页面可能存在多个弹窗实例） */
const titleId = `hub-dialog-title-${Math.random().toString(36).slice(2, 10)}`;
const messageId = `hub-dialog-message-${Math.random().toString(36).slice(2, 10)}`;

const tone = ref(props.tone);
// tone 随 prop 更新（同一实例可能被复用为不同提示）
watch(() => props.tone, value => { tone.value = value; });

/** 遮罩点击：等价于取消（与 Escape 同语义） */
function handleOverlayClick(): void {
  if (props.busy) return;
  emit('cancel');
}

let keydownHandler: ((event: KeyboardEvent) => void) | null = null;

/**
 * 弹窗打开时接管 Escape 并设置初始焦点；关闭时移除监听。
 *
 * 监听挂在 document 上（捕获阶段）：弹窗经 Teleport 挂在 body 下，
 * 焦点在弹窗内时 keydown 仍会冒泡到 document，捕获监听能可靠收到。
 */
watch(
  () => props.visible,
  visible => {
    if (visible) {
      keydownHandler = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        if (props.busy) return;
        emit('cancel');
      };
      document.addEventListener('keydown', keydownHandler, true);
      void nextTick(() => {
        // 破坏性形态初始聚焦次按钮：回车不会直接执行删除
        const destructive = tone.value === 'warn' || tone.value === 'error';
        const selector = destructive
          ? '.hub-dialog__btn--secondary'
          : '.hub-dialog__btn--primary';
        const target = panelRef.value?.querySelector<HTMLButtonElement>(selector);
        target?.focus();
      });
    } else if (keydownHandler) {
      document.removeEventListener('keydown', keydownHandler, true);
      keydownHandler = null;
    }
  },
);

onUnmounted(() => {
  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler, true);
    keydownHandler = null;
  }
});
</script>

<style scoped>
/*
  管理中心确认弹窗样式（液态玻璃体系：中性黑白灰，语义色仅用于状态表达）

  遮罩用中性墨色而非纯黑：与 hub 的浅色画布更协调，也避免大面积纯黑压过
  页面本身的信息层级。弹窗卡片沿用 --glass-* 材质，与其它分区卡片同源。
*/
.hub-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(24, 23, 21, 0.28);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  animation: hub-dialog-fade 0.18s var(--ease-out, ease);
}

.hub-dialog {
  width: min(460px, 100%);
  max-height: min(80vh, 640px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 26px 26px 20px;
  border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.78));
  border-radius: var(--radius-glass, 16px);
  background: var(--glass-tint-strong, rgba(255, 255, 255, 0.72));
  backdrop-filter: var(--glass-blur-strong, blur(30px) saturate(180%));
  -webkit-backdrop-filter: var(--glass-blur-strong, blur(30px) saturate(180%));
  box-shadow: var(--glass-inset, none), var(--glass-shadow-lift, 0 20px 48px rgb(41 40 36 / 14%));
  text-align: center;
  animation: hub-dialog-pop 0.22s var(--ease-spring, cubic-bezier(0.32, 0.72, 0, 1));
}

.hub-dialog__icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1px solid rgba(41, 40, 36, 0.12);
  background: rgba(255, 255, 255, 0.72);
  color: var(--ink-secondary, #787671);
}

.hub-dialog__icon.is-warn {
  color: var(--warning-color, #f59e0b);
  border-color: rgba(245, 158, 11, 0.28);
  background: rgba(245, 158, 11, 0.1);
}

.hub-dialog__icon.is-error {
  color: var(--error-color, #ef4444);
  border-color: rgba(239, 68, 68, 0.26);
  background: rgba(239, 68, 68, 0.09);
}

.hub-dialog__title {
  margin: 2px 0 0;
  font-size: 15px;
  font-weight: 650;
  line-height: 1.45;
  color: var(--ink-primary, #292824);
}

.hub-dialog__message {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink-secondary, #787671);
  white-space: pre-wrap;
  word-break: break-word;
}

.hub-dialog__actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  width: 100%;
}

.hub-dialog__btn {
  flex: 1 1 0;
  appearance: none;
  border: 1px solid rgba(41, 40, 36, 0.12);
  border-radius: 10px;
  padding: 8px 12px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.18s ease, border-color 0.18s ease, color 0.18s ease,
    transform 0.25s var(--ease-spring, cubic-bezier(0.32, 0.72, 0, 1));
}

.hub-dialog__btn--secondary {
  background: rgba(255, 255, 255, 0.66);
  color: var(--ink-primary, #292824);
}

.hub-dialog__btn--secondary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.9);
  border-color: rgba(41, 40, 36, 0.24);
}

.hub-dialog__btn--primary {
  background: var(--primary-gradient, linear-gradient(135deg, #45423b 0%, #2b2925 100%));
  border-color: transparent;
  color: #ffffff;
  font-weight: 600;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 2px 10px rgba(41, 40, 36, 0.3);
}

.hub-dialog__btn--primary:hover:not(:disabled) {
  transform: translateY(-1px);
}

/* 破坏性主按钮：唯一的红色用法，语义化表达「不可恢复」 */
.hub-dialog__btn--primary.is-danger {
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 2px 10px rgba(220, 38, 38, 0.28);
}

.hub-dialog__btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(41, 40, 36, 0.24);
}

.hub-dialog__btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none;
}

@keyframes hub-dialog-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes hub-dialog-pop {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .hub-dialog-overlay,
  .hub-dialog {
    animation: none;
  }
}
</style>
