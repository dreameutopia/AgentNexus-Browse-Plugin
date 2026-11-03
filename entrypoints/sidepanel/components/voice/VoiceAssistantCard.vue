<template>
  <div class="voice-assistant-card">
    <div class="card-header">
      <div class="header-left">
        <div class="title-gradient">{{ t('sidepanel.voice.assistantTitle') }}</div>
      </div>
      <div class="header-right">
        <div class="connected-time">
          <span class="time-label">{{ t('sidepanel.voice.connectedDuration') }}</span>
          <span class="time-value">{{ formattedTime }}</span>
        </div>
        <button class="exit-btn" @click="handleExit" :title="t('sidepanel.voice.assistantExitTitle')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </div>
    
    <div class="card-body">
      <div class="status-display">
        <div class="status-icon" :class="statusClass">
          <!-- 状态SVG图标 -->
          <svg v-if="status === 'waiting'" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2" fill="none" opacity="0.8"/>
            <circle cx="12" cy="12" r="3" fill="currentColor" opacity="0.6"/>
          </svg>
          
          <svg v-if="status === 'listening'" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z" fill="currentColor"/>
            <circle cx="12" cy="8" r="1.5" fill="rgba(255,255,255,0.8)">
              <animate attributeName="opacity" values="0.5;1;0.5" dur="1.5s" repeatCount="indefinite"/>
            </circle>
          </svg>
          
          <svg v-if="status === 'understanding'" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z" fill="currentColor"/>
            <circle cx="9.5" cy="9.5" r="2" fill="none" stroke="rgba(255,255,255,0.6)" stroke-width="1">
              <animate attributeName="r" values="1;3;1" dur="2s" repeatCount="indefinite"/>
              <animate attributeName="opacity" values="0.8;0.3;0.8" dur="2s" repeatCount="indefinite"/>
            </circle>
          </svg>
          
          <svg v-if="status === 'executing'" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4Z" fill="currentColor" opacity="0.3"/>
            <path d="M12,2A10,10 0 0,0 12,22V20A8,8 0 0,1 12,4V2Z" fill="currentColor">
              <animateTransform attributeName="transform" type="rotate" values="0 12 12;360 12 12" dur="1.5s" repeatCount="indefinite"/>
            </path>
            <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2" opacity="0.7"/>
          </svg>
        </div>
        <div class="status-text" :class="statusClass">{{ statusText }}</div>
      </div>
    </div>

    <div class="card-footer">
      <div class="action-buttons">
        <!-- 开始说话按钮 (仅在非自动唤醒模式且等待状态时显示) -->
        <button 
          v-if="!autoWake && status === 'waiting' && !isAiResponding"
          class="action-btn start-btn"
          @click="handleStartSpeaking"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z" fill="currentColor"/>
          </svg>
          <span>{{ t('sidepanel.voice.startSpeaking') }}</span>
        </button>
        
        <button 
          v-if="status === 'listening'"
          class="action-btn stop-btn"
          @click="handleStopSpeaking"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>
          </svg>
          <span>{{ t('sidepanel.voice.stopSpeaking') }}</span>
        </button>
        
        <!-- 自动唤醒状态指示 -->
        <div v-if="autoWake" class="auto-wake-indicator">
          <div class="indicator-dot"></div>
          <span class="indicator-text">{{ t('sidepanel.voice.autoWakeOn') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { t } from '@/utils/i18n';

interface Props {
  status: 'waiting' | 'listening' | 'understanding' | 'executing';
  connectedTime: number;
  autoWake: boolean;
  isAiResponding: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'start-recording': [];
  'stop-recording': [];
  'exit': [];
}>();

const statusText = computed(() => {
  switch (props.status) {
    case 'waiting': return t('sidepanel.voice.statusWaiting');
    case 'listening': return t('sidepanel.voice.statusListening');
    case 'understanding': return t('sidepanel.voice.statusUnderstanding');
    case 'executing': return t('sidepanel.voice.statusExecuting');
    default: return t('sidepanel.voice.statusWaiting');
  }
});

const statusIconClass = computed(() => {
  return `status-icon status-${props.status}`;
});

const statusClass = computed(() => {
  return `status-${props.status}`;
});

const formattedTime = computed(() => {
  return formatTime(props.connectedTime);
});

const handleStartSpeaking = () => {
  emit('start-recording');
};

const handleStopSpeaking = () => {
  emit('stop-recording');
};

const handleExit = () => {
  emit('exit');
};

const formatTime = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  } else {
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }
};

// 导出所有需要的变量和函数
defineExpose({
  statusText,
  statusClass,
  statusIconClass,
  formattedTime,
  handleStartSpeaking,
  handleStopSpeaking,
  handleExit
});
</script>

<style scoped>
.voice-assistant-card {
  position: fixed;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  width: 420px;
  background: rgba(255, 255, 255, 0.15);
  backdrop-filter: blur(25px);
  -webkit-backdrop-filter: blur(25px);
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 20px;
  box-shadow: 
    0 20px 40px rgba(0, 0, 0, 0.15),
    0 8px 16px rgba(0, 0, 0, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.3);
  z-index: 1000;
  padding: 24px;
  color: #333;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  transition: all 0.3s ease;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  width: 100%;
  min-height: 24px;
  flex-wrap: nowrap;
}

.header-left {
  display: flex;
  align-items: center;
  flex: 0 1 auto;
  min-width: 0;
}

.header-left .title-gradient {
  font-size: 18px;
  font-weight: 600;
  background: linear-gradient(90deg, #3b82f6, #8b5cf6, #ec4899, #8b5cf6, #3b82f6);
  background-size: 300% 100%;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  animation: gradientFlow 4s ease-in-out infinite;
  white-space: nowrap;
}

@keyframes gradientFlow {
  0% {
    background-position: 0% 50%;
  }
  50% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0% 50%;
  }
}

.header-right {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  margin-left: auto;
  min-width: 0;
}

.connected-time {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  white-space: nowrap;
  text-align: right;
  min-width: fit-content;
  flex-shrink: 0;
}

.time-label {
  color: #666;
  margin-bottom: 2px;
}

.time-value {
  font-weight: 600;
  color: #333;
  font-family: 'Courier New', monospace;
}

.exit-btn {
  background: none;
  border: none;
  color: #666;
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  transition: all 0.2s ease;
}

.exit-btn:hover {
  background: rgba(0, 0, 0, 0.1);
  color: #333;
}

.card-body {
  margin-bottom: 20px;
}

.status-display {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 24px;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.15), rgba(255, 255, 255, 0.05));
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  box-shadow: 
    0 8px 32px rgba(0, 0, 0, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.3);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  transition: all 0.3s ease;
}

.status-icon {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  transition: all 0.3s ease;
  box-shadow: 
    0 4px 16px rgba(0, 0, 0, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.3);
}

.status-icon.status-waiting {
  background: rgba(99, 102, 241, 0.1);
  color: #6366f1;
}

.status-icon.status-listening {
  background: rgba(34, 197, 94, 0.1);
  color: #22c55e;
}

.status-icon.status-understanding {
  background: rgba(251, 191, 36, 0.1);
  color: #fbbf24;
}

.status-icon.status-executing {
  background: rgba(139, 92, 246, 0.1);
  color: #8b5cf6;
}

.pulse-ring {
  position: absolute;
  top: -4px;
  left: -4px;
  right: -4px;
  bottom: -4px;
  border: 2px solid #22c55e;
  border-radius: 50%;
  animation: pulse 2s infinite;
  opacity: 0.6;
}

@keyframes pulse {
  0% {
    transform: scale(1);
    opacity: 0.6;
  }
  50% {
    transform: scale(1.1);
    opacity: 0.3;
  }
  100% {
    transform: scale(1);
    opacity: 0.6;
  }
}

.spinner {
  position: absolute;
  top: -2px;
  left: -2px;
  right: -2px;
  bottom: -2px;
  border: 2px solid transparent;
  border-top: 2px solid #fbbf24;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

.executing-animation {
  position: absolute;
  top: -2px;
  left: -2px;
  right: -2px;
  bottom: -2px;
  border: 2px solid transparent;
  border-top: 2px solid #8b5cf6;
  border-right: 2px solid #8b5cf6;
  border-radius: 50%;
  animation: spin 1.5s linear infinite;
}

.status-text {
  font-size: 18px;
  font-weight: 600;
  text-align: center;
  transition: all 0.3s ease;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
  letter-spacing: 0.5px;
}

.status-text.status-listening {
  color: #22c55e;
  background: linear-gradient(90deg, #22c55e, #16a34a);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  animation: breathe 2s ease-in-out infinite;
}

.status-text.status-waiting {
  color: #6366f1;
  background: linear-gradient(90deg, #6366f1, #4f46e5);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  animation: breathe 2.5s ease-in-out infinite;
}

.status-text.status-understanding {
  color: #f59e0b;
  background: linear-gradient(90deg, #f59e0b, #d97706);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  animation: breathe 1.5s ease-in-out infinite;
}

.status-text.status-executing {
  color: #8b5cf6;
  background: linear-gradient(90deg, #8b5cf6, #7c3aed);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  animation: breathe 1.8s ease-in-out infinite;
}

@keyframes breathe {
  0%, 100% {
    opacity: 0.8;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.02);
  }
}

.card-footer {
  display: flex;
  justify-content: center;
}

.action-buttons {
  display: flex;
  align-items: center;
  gap: 12px;
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

.start-btn {
  background: rgba(34, 197, 94, 0.2);
  color: #22c55e;
  border: 1px solid rgba(34, 197, 94, 0.3);
}

.start-btn:hover {
  background: rgba(34, 197, 94, 0.3);
  transform: translateY(-1px);
}

.stop-btn {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.stop-btn:hover {
  background: rgba(239, 68, 68, 0.3);
  transform: translateY(-1px);
}

.auto-wake-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.2);
  border-radius: 6px;
  font-size: 12px;
  color: #22c55e;
}

.indicator-dot {
  width: 6px;
  height: 6px;
  background: #22c55e;
  border-radius: 50%;
  animation: pulse 2s infinite;
}

.indicator-text {
  font-weight: 500;
}

/* 新增：柔和呼吸光点与加载美化 */
.glow-dot {
  position: relative;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.5);
  animation: glow-breathe 2.2s ease-in-out infinite;
}

/* 根据不同状态切换光晕颜色 */
.status-icon.status-waiting .glow-dot { box-shadow: 0 0 24px 6px rgba(99,102,241,0.35); }
.status-icon.status-listening .glow-dot { box-shadow: 0 0 24px 6px rgba(34,197,94,0.35); }
.status-icon.status-understanding .glow-dot { box-shadow: 0 0 24px 6px rgba(251,191,36,0.35); }
.status-icon.status-executing .glow-dot { box-shadow: 0 0 24px 6px rgba(139,92,246,0.35); }

@keyframes glow-breathe {
  0%, 100% { transform: scale(1); filter: blur(0.2px); opacity: 0.95; }
  50% { transform: scale(1.25); filter: blur(0.3px); opacity: 1; }
}

/* 柔和的细环加载：理解中 */
.spinner.spinner-soft {
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  border: 2px solid transparent;
  border-top-color: currentColor;
  opacity: 0.65;
  animation: spin 1.1s linear infinite;
}

/* 执行中：带渐变的双扇形环 */
.executing-animation.ring-gradient {
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  background:
    conic-gradient(from 0deg, rgba(0,0,0,0) 0 65%, currentColor 65% 80%, rgba(0,0,0,0) 80% 100%);
  -webkit-mask: radial-gradient(circle 18px, #0000 23px, #000 24px);
  animation: spin 1.4s linear infinite;
  opacity: 0.7;
}

/* 响应式设计 */
@media (max-width: 480px) {
  .voice-assistant-card {
    width: calc(100% - 40px);
    left: 20px;
    transform: none;
  }
  
  .card-header {
    flex-direction: column;
    gap: 8px;
    align-items: flex-start;
  }
  
  .header-right {
    align-self: flex-end;
  }
}
</style>