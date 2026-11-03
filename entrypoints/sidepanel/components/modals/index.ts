/**
 * 弹窗域组件出口
 * 设置（SettingsModal：壳 + sections/ 分区组件）、语音配置提示、确认框、
 * Deep Search 警告、模型缓存管理与 AI 任务弹窗（部分为预留，尚未接入主界面）。
 */

export { default as SettingsModal } from './SettingsModal.vue';
export { default as AsrConfigPrompt } from './AsrConfigPrompt.vue';
export { default as ConfirmDialog } from './ConfirmDialog.vue';
export { default as DeepSearchWarning } from './DeepSearchWarning.vue';
export { default as ModelCacheManagement } from './ModelCacheManagement.vue';
export { default as AiTaskModal } from './AiTaskModal.vue';
