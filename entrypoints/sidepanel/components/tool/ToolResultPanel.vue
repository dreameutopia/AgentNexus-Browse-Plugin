<template>
  <div v-if="result" class="result-section">
    <div class="result-header">
      <h3 class="section-title">执行结果</h3>
      <button class="btn-copy" @click="$emit('copy')">📋 复制</button>
    </div>
    <div
      class="result-content"
      :class="{ error: result.isError }"
    >
      <pre>{{ formattedText }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ExecutionResult } from './types';

const props = defineProps<{
  result: ExecutionResult | null;
  formatFn: (result: ExecutionResult | null) => string;
}>();

defineEmits<{
  copy: [];
}>();

const formattedText = computed(() => props.formatFn(props.result));
</script>

<style scoped>
.result-section {
  background: white;
  padding: 20px;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.result-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.section-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #333;
}

.btn-copy {
  padding: 6px 12px;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  background: white;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-copy:hover {
  background: #f0f0f0;
  border-color: #667eea;
}

.result-content {
  padding: 16px;
  border-radius: 8px;
  background: #f9f9f9;
  border: 1px solid #e0e0e0;
  max-height: 500px;
  overflow: auto;
}

.result-content.error {
  background: #fff5f5;
  border-color: #feb2b2;
  color: #c53030;
}

.result-content pre {
  margin: 0;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-wrap: break-word;
}
</style>
