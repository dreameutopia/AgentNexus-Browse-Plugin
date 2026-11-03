<template>
  <div v-if="visible" class="progress-indicator">
    <div class="progress-content">
      <div v-if="showSpinner" class="spinner"></div>
      <p class="progress-text">{{ text }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Props {
  visible: boolean;
  text: string;
  showSpinner?: boolean;
}

defineProps<Props>();
</script>

<style scoped>
.progress-indicator {
  padding: 16px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  margin: 16px 0;
}

.progress-content {
  display: flex;
  align-items: center;
  gap: 12px;
}

.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid #e2e8f0;
  border-top: 2px solid #3b82f6;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.progress-text {
  margin: 0;
  color: #64748b;
  font-size: 14px;
}
</style>