<template>
  <div 
    class="ws-status-island"
    @mouseenter="isExpanded = true"
    @mouseleave="isExpanded = false"
  >
    <div class="island-pill" :class="[statusClass, { expanded: isExpanded }]">
      <!-- 状态圆球 -->
      <div class="status-orb" :class="orbClass">
        <!-- 连接状态：绿边 ✅ -->
        <svg v-if="isConnected" class="orb-icon" viewBox="0 0 24 24" fill="none">
          <path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z" fill="currentColor"/>
        </svg>
        <!-- 连接中：旋转动画 -->
        <svg v-else-if="isConnecting" class="orb-icon spin" viewBox="0 0 24 24" fill="none">
          <path d="M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z" fill="currentColor"/>
        </svg>
        <!-- 断开/失败：红边 ✕ -->
        <svg v-else class="orb-icon" viewBox="0 0 24 24" fill="none">
          <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
        </svg>
      </div>

      <!-- 展开区域（丝滑动画） -->
      <div class="expand-zone">
        <!-- 状态文字 -->
        <span class="status-label">{{ statusText }}</span>

        <!-- 未连接时显示帮助问号 -->
        <a
          v-if="!isConnected && !isConnecting"
          class="help-icon"
          href="https://ccn7xx2ie259.feishu.cn/wiki/FpGUw91EgibWsHkVkBIccyh0n1d"
          target="_blank"
          :title="t('sidepanel.ws.helpTitle')"
          @click.stop
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path d="M11,18H13V16H11V18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,6A4,4 0 0,0 8,10H10A2,2 0 0,1 12,8A2,2 0 0,1 14,10C14,12 11,11.75 11,15H13C13,12.75 16,12.5 16,10A4,4 0 0,0 12,6Z" fill="currentColor"/>
          </svg>
        </a>

        <!-- 开发者工具按钮（仅 dev 模式显示） -->
        <button
          v-if="props.isDev"
          class="debug-btn"
          @click.stop="emit('toggle-debug')"
          :title="t('sidepanel.ws.toolbox')"
        >
          <svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width="12" height="12"><path d="M193.3 554.2v3-3z m159.4 141.3l39.1 39.1 117.3-120.3 120.3 123.3 39.1-39.1-114.3-114.3 114.3-114.3-39.1-39.1-117.3 120.3-120.3-120.3-39.1 36.1L467 581.2 352.7 695.5z m348.8-433.1c0-34.1-8.5-65.6-25.6-94.7-17-29.1-40.1-52.1-69.2-69.2-29.1-17-60.6-25.6-94.7-25.6s-65.6 8.5-94.7 25.6c-29.1 17-51.6 40.1-67.7 69.2-16 29.1-24.1 60.6-24.1 94.7v36.1h-54.1L163.2 190.3l-39.1 39.1 105.2 105.2v3c-22 56.1-33.1 116.3-33.1 180.4v42.1H64v54.1h141.3c10 60.1 30.1 115.3 60.1 165.4l3 3-126.3 126.3 36.1 36.1 123.3-120.3 3 6c28.1 32.1 60.1 57.1 96.2 75.2S473.9 933 511.9 933s75.2-9 111.2-27.1 68.2-42.1 96.2-72.2l3-6L845.6 951l39.1-36.1-129.3-129.3 3-3c30.1-50.1 51.1-106.2 63.1-168.4h138.3v-54.1H827.5l3-42.1c0-62.1-12-123.3-36.1-183.4v-3l102.2-102.2-39.1-39.1-108.2 108.2h-48.1v-36.1h0.2z m-321.7 0c0-38.1 13-70.2 39.1-96.2 26.1-26.1 57.6-39.1 94.7-39.1s68.7 13 94.7 39.1c26.1 26.1 39.1 58.1 39.1 96.2v36.1H379.7v-36.1z m366.9 93.3c20 50.1 30.1 104.2 30.1 162.4s-7.5 97.7-22.6 142.8c-15 45.1-35.1 84.2-60.1 117.3-25.1 33.1-53.1 58.1-84.2 75.2S546.3 879 512.2 879s-66.6-8.5-97.7-25.6c-31.1-17.1-59.1-42.1-84.2-75.2s-44.6-72.2-58.6-117.3c-14-45.1-21-92.7-21-142.8s9-110.2 27.1-162.4l3-3h466.1v3z" fill="currentColor"/></svg>
        </button>

        <!-- 分隔线 -->
        <div class="divider"></div>

        <!-- 操作按钮 -->
        <button
          class="action-btn"
          :class="buttonClass"
          @click="toggleConnection"
          :disabled="isConnecting"
        >
          {{ buttonText }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '@/utils/i18n'

// Props - 使用字符串类型以兼容枚举值
const props = defineProps<{
  status: string
  isDev?: boolean
}>()

// Emits
const emit = defineEmits<{
  (e: 'toggle-connection'): void
  (e: 'toggle-debug'): void
}>()

// 悬停展开状态
const isExpanded = ref(false)

// 计算属性
const isConnected = computed(() => props.status === 'CONNECTED')
const isConnecting = computed(() => props.status === 'CONNECTING' || props.status === 'RECONNECTING')
const isFailed = computed(() => props.status === 'ERROR')

const statusClass = computed(() => ({
  'connected': isConnected.value,
  'connecting': isConnecting.value,
  'disconnected': !isConnected.value && !isConnecting.value
}))

const orbClass = computed(() => ({
  'orb-connected': isConnected.value,
  'orb-connecting': isConnecting.value,
  'orb-failed': isFailed.value,
  'orb-disconnected': !isConnected.value && !isConnecting.value && !isFailed.value
}))

const statusText = computed(() => {
  if (isConnected.value) return t('sidepanel.ws.connected')
  if (isConnecting.value) return t('sidepanel.ws.connecting')
  if (isFailed.value) return t('sidepanel.ws.unavailable')
  return t('sidepanel.ws.disconnected')
})

const buttonClass = computed(() => ({
  'btn-disconnect': isConnected.value,
  'btn-connect': !isConnected.value && !isConnecting.value
}))

const buttonText = computed(() => isConnected.value ? t('sidepanel.ws.disconnect') : t('sidepanel.ws.connect'))

// 方法
const toggleConnection = () => {
  if (!isConnecting.value) {
    emit('toggle-connection')
  }
}
</script>

<style scoped>
.ws-status-island {
  position: fixed;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
}

.island-pill {
  display: inline-flex;
  align-items: center;
  gap: 0;
  padding: 3px;
  background: rgba(30, 30, 30, 0.85);
  border-radius: 16px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  transition: gap 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              padding 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              background 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              box-shadow 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.island-pill.expanded {
  gap: 5px;
  padding: 3px 7px 3px 3px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
}

/* ---------- 状态圆球 ---------- */
.status-orb {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  border: 1.5px solid transparent;
}

.orb-connected {
  background: rgba(34, 197, 94, 0.15);
  border-color: #22c55e;
  color: #22c55e;
}

.orb-connected .orb-icon {
  filter: drop-shadow(0 0 3px rgba(34, 197, 94, 0.45));
}

.orb-connecting {
  background: rgba(59, 130, 246, 0.15);
  border-color: #3b82f6;
  color: #3b82f6;
}

.orb-failed {
  background: rgba(239, 68, 68, 0.15);
  border-color: #ef4444;
  color: #ef4444;
}

.orb-disconnected {
  background: rgba(156, 163, 175, 0.12);
  border-color: #9ca3af;
  color: #9ca3af;
}

.orb-icon {
  display: block;
  width: 10px;
  height: 10px;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ---------- 展开区域 ---------- */
.expand-zone {
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  max-width: 0;
  opacity: 0;
  overflow: hidden;
  transform: translateX(-4px);
  transition: max-width 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              opacity 0.45s cubic-bezier(0.25, 0.46, 0.45, 0.94) 0.05s,
              transform 0.45s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  pointer-events: none;
}

.island-pill.expanded .expand-zone {
  max-width: 200px;
  opacity: 1;
  transform: translateX(0);
  pointer-events: auto;
}

.status-label {
  font-size: 10px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.85);
  letter-spacing: 0.3px;
}

.divider {
  width: 1px;
  height: 10px;
  background: rgba(255, 255, 255, 0.15);
}

.action-btn {
  padding: 1px 6px;
  font-size: 9px;
  font-weight: 500;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  white-space: nowrap;
}

.action-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.btn-connect {
  background: rgba(34, 197, 94, 0.15);
  color: #22c55e;
}

.btn-connect:hover:not(:disabled) {
  background: rgba(34, 197, 94, 0.25);
}

.btn-disconnect {
  background: rgba(239, 68, 68, 0.12);
  color: #f87171;
}

.btn-disconnect:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.2);
}

.action-btn:active:not(:disabled) {
  transform: scale(0.95);
}

.help-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  color: rgba(255, 255, 255, 0.5);
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  text-decoration: none;
  cursor: help;
}

.help-icon:hover {
  color: rgba(255, 255, 255, 0.85);
  transform: scale(1.1);
}

.help-icon svg {
  display: block;
}

/* ---------- 开发者工具按钮 ---------- */
.debug-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(168, 85, 247, 0.15);
  color: rgba(255, 255, 255, 0.7);
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.debug-btn:hover {
  background: rgba(168, 85, 247, 0.3);
  color: rgba(255, 255, 255, 0.95);
}

.debug-btn:active {
  transform: scale(0.9);
}
</style>
