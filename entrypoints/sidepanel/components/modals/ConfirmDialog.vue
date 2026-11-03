<template>
  <div v-if="visible" class="confirm-dialog-overlay" @click="onCancel">
    <div class="confirm-dialog" @click.stop>
      <div class="confirm-dialog-header">
        <h3 class="confirm-dialog-title">{{ title }}</h3>
      </div>
      <div class="confirm-dialog-content">
        <p class="confirm-dialog-message">{{ message }}</p>
      </div>
      <div class="confirm-dialog-actions">
        <button class="confirm-dialog-button cancel" @click="onCancel">
          {{ cancelText || 'Cancel' }}
        </button>
        <button class="confirm-dialog-button confirm" @click="onConfirm">
          {{ confirmText || 'Confirm' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Props {
  visible: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
}

interface Emits {
  confirm: [];
  cancel: [];
}

defineProps<Props>();
const emit = defineEmits<Emits>();

const onConfirm = () => {
  emit('confirm');
};

const onCancel = () => {
  emit('cancel');
};
</script>

<style scoped>
.confirm-dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.confirm-dialog {
  background: white;
  border-radius: 8px;
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
  max-width: 400px;
  width: 90%;
  overflow: hidden;
}

.confirm-dialog-header {
  padding: 20px 20px 0;
}

.confirm-dialog-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #1f2937;
}

.confirm-dialog-content {
  padding: 16px 20px;
}

.confirm-dialog-message {
  margin: 0;
  color: #6b7280;
  line-height: 1.5;
}

.confirm-dialog-actions {
  padding: 20px;
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  border-top: 1px solid #e5e7eb;
}

.confirm-dialog-button {
  padding: 8px 16px;
  border-radius: 6px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  border: 1px solid transparent;
}

.confirm-dialog-button.cancel {
  background: #f3f4f6;
  color: #374151;
  border-color: #d1d5db;
}

.confirm-dialog-button.cancel:hover {
  background: #e5e7eb;
}

.confirm-dialog-button.confirm {
  background: #dc2626;
  color: white;
}

.confirm-dialog-button.confirm:hover {
  background: #b91c1c;
}
</style>