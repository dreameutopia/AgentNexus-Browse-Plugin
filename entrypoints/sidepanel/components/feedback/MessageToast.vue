<template>
  <Transition name="toast" appear>
    <div
      v-if="visible"
      class="message-toast"
      :class="`is-${type}`"
      role="status"
      aria-live="polite"
    >
      <!-- 图标 -->
      <span class="message-toast__icon" aria-hidden="true">
        <CheckCircle v-if="type === 'success'" :size="18" />
        <XCircle v-else-if="type === 'error'" :size="18" />
        <AlertCircle v-else-if="type === 'warning'" :size="18" />
        <Info v-else :size="18" />
      </span>

      <!-- 消息内容 -->
      <span class="message-toast__text">{{ message }}</span>

      <!-- 关闭按钮 -->
      <button
        type="button"
        class="message-toast__close"
        :aria-label="t('common.close')"
        @click="close"
      >
        <X :size="14" />
      </button>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { CheckCircle, XCircle, AlertCircle, Info, X } from 'lucide-vue-next'
import { t } from '@/utils/i18n'

interface Props {
  message: string
  type?: 'success' | 'error' | 'warning' | 'info'
  duration?: number
  visible?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  type: 'info',
  duration: 3000,
  visible: false
})

const emit = defineEmits<{
  close: []
}>()

const visible = ref(props.visible)
let timer: ReturnType<typeof setTimeout> | null = null

const close = () => {
  visible.value = false
  emit('close')
}

const startTimer = () => {
  if (timer) {
    clearTimeout(timer)
  }
  if (props.duration > 0) {
    timer = setTimeout(() => {
      close()
    }, props.duration)
  }
}

watch(() => props.visible, (newVal) => {
  visible.value = newVal
  if (newVal) {
    startTimer()
  }
})

onMounted(() => {
  if (props.visible) {
    startTimer()
  }
})
</script>

<style scoped>
/* 真实样式（本项目未引入 Tailwind，工具类不会生效）：
   容器定位在 MessageContainer，这里只负责卡片本体与类型配色 */
.message-toast {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: max-content;
  min-width: 200px;
  max-width: 360px;
  padding: 10px 12px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.14);
  font-size: 13px;
  line-height: 1.5;
  color: #1f2937;
  /* 宿主 pointer-events:none 时，仅本体接收点击（穿透规则：子级可重新开启） */
  pointer-events: auto;
}

.message-toast.is-success { border-color: rgba(22, 163, 74, 0.35); }
.message-toast.is-error { border-color: rgba(220, 38, 38, 0.35); }
.message-toast.is-warning { border-color: rgba(217, 119, 6, 0.35); }
.message-toast.is-info { border-color: rgba(37, 99, 235, 0.35); }

.message-toast__icon {
  display: flex;
  flex-shrink: 0;
  margin-top: 1px;
}

.message-toast.is-success .message-toast__icon { color: #16a34a; }
.message-toast.is-error .message-toast__icon { color: #dc2626; }
.message-toast.is-warning .message-toast__icon { color: #d97706; }
.message-toast.is-info .message-toast__icon { color: #2563eb; }

.message-toast__text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.message-toast__close {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: #9ca3af;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.message-toast__close:hover {
  background: rgba(15, 23, 42, 0.06);
  color: #4b5563;
}

.message-toast__close:focus-visible {
  outline: 2px solid rgba(102, 126, 234, 0.45);
  outline-offset: 1px;
}

.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(100%);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(100%);
}
</style>
