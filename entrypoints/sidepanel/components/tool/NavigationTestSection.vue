<template>
  <div class="navigation-test-section">
    <div class="test-header">
      <h3 class="section-title">🧪 导航互斥锁测试</h3>
      <span class="test-description">测试新的导航锁机制，防止并发导航冲突</span>
    </div>
    <div class="test-controls">
      <button
        class="btn-test"
        :disabled="isTesting"
        @click="$emit('run')"
      >
        <span v-if="isTesting">🔄 测试中... ({{ progress }}/{{ totalUrls }})</span>
        <span v-else>🚀 运行导航压力测试</span>
      </button>
      <button
        v-if="result"
        class="btn-clear-test"
        @click="$emit('clear')"
      >
        🗑️ 清除结果
      </button>
    </div>
    <div v-if="result" class="test-result">
      <div class="test-summary">
        <div class="summary-item">
          <span class="label">总请求:</span>
          <span class="value">{{ result.total }}</span>
        </div>
        <div class="summary-item">
          <span class="label">成功:</span>
          <span class="value success">{{ result.success }}</span>
        </div>
        <div class="summary-item">
          <span class="label">失败:</span>
          <span class="value error">{{ result.failed }}</span>
        </div>
        <div class="summary-item">
          <span class="label">总耗时:</span>
          <span class="value">{{ result.totalTime }}ms</span>
        </div>
        <div class="summary-item">
          <span class="label">平均耗时:</span>
          <span class="value">{{ result.avgTime }}ms</span>
        </div>
      </div>
      <div class="test-details">
        <h4>详细结果：</h4>
        <div class="test-log">
          <div
            v-for="(log, index) in result.logs"
            :key="index"
            class="log-item"
            :class="{ error: log.error }"
          >
            <span class="log-index">#{{ index + 1 }}</span>
            <span class="log-url">{{ log.url }}</span>
            <span class="log-time">{{ log.time }}ms</span>
            <span v-if="log.error" class="log-error">❌ {{ log.error }}</span>
            <span v-else class="log-success">✅ 成功</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { NavigationTestResult } from './types';

defineProps<{
  isTesting: boolean;
  progress: number;
  totalUrls: number;
  result: NavigationTestResult | null;
}>();

defineEmits<{
  run: [];
  clear: [];
}>();
</script>

<style scoped>
.navigation-test-section {
  background: white;
  padding: 20px;
  border-radius: 12px;
  margin-bottom: 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  border: 2px solid #667eea;
}

.test-header {
  margin-bottom: 16px;
}

.test-header .section-title {
  margin-bottom: 4px;
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 600;
  color: #333;
}

.test-description {
  display: block;
  font-size: 13px;
  color: #666;
  margin-top: 4px;
}

.test-controls {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.btn-test {
  flex: 1;
  padding: 12px 20px;
  border: none;
  border-radius: 8px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
}

.btn-test:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
}

.btn-test:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-clear-test {
  padding: 12px 20px;
  border: 1px solid #ddd;
  border-radius: 8px;
  background: white;
  color: #666;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.3s ease;
}

.btn-clear-test:hover {
  background: #f5f5f5;
  border-color: #999;
}

.test-result {
  margin-top: 20px;
}

.test-summary {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px;
  margin-bottom: 20px;
}

.summary-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px;
  border-radius: 8px;
  background: #f9f9f9;
}

.summary-item .label {
  font-size: 12px;
  color: #666;
  margin-bottom: 4px;
}

.summary-item .value {
  font-size: 20px;
  font-weight: 600;
  color: #333;
}

.summary-item .value.success {
  color: #48bb78;
}

.summary-item .value.error {
  color: #f56565;
}

.test-details h4 {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
  color: #333;
}

.test-log {
  max-height: 400px;
  overflow-y: auto;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  background: #fafafa;
}

.log-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid #e0e0e0;
  font-size: 13px;
}

.log-item:last-child {
  border-bottom: none;
}

.log-item.error {
  background: #fff5f5;
}

.log-index {
  font-weight: 600;
  color: #667eea;
  min-width: 30px;
}

.log-url {
  flex: 1;
  color: #333;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-time {
  font-weight: 600;
  color: #666;
  min-width: 60px;
  text-align: right;
}

.log-success {
  color: #48bb78;
  font-weight: 600;
  min-width: 60px;
}

.log-error {
  color: #f56565;
  font-weight: 600;
  font-size: 12px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
