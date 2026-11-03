<template>
  <div class="tool-test-panel">
    <!-- 工具信息 -->
    <div class="tool-info">
      <h2 class="tool-title">{{ tool.name }}</h2>
      <p class="tool-desc">{{ tool.description }}</p>
      <div class="tool-meta">
        <span class="meta-tag">分类: {{ tool.category }}</span>
        <span class="meta-tag">版本: {{ tool.version }}</span>
      </div>
    </div>

    <!-- 参数表单 -->
    <ToolParamsForm
      :tool="tool"
      :model-value="toolParams"
      @update:model-value="$emit('update:toolParams', $event)"
    />

    <!-- 执行按钮 -->
    <div class="action-buttons">
      <button
        class="btn-execute"
        :disabled="isExecuting"
        @click="$emit('execute')"
      >
        <span v-if="isExecuting">⏳ 执行中...</span>
        <span v-else>▶️ 执行工具</span>
      </button>
      <button
        class="btn-clear"
        @click="$emit('clearParams')"
      >
        🔄 重置参数
      </button>
    </div>

    <!-- 导航测试区域（仅在自动化分类显示） -->
    <NavigationTestSection
      v-if="activeCategory === 'automation'"
      :is-testing="isNavigationTesting"
      :progress="testProgress"
      :total-urls="testUrls.length"
      :result="navigationTestResult"
      @run="$emit('runNavigationTest')"
      @clear="$emit('clearNavigationTest')"
    />

    <!-- 下载测试区域（仅在自动化分类且特定工具显示） -->
    <DownloadTestSection
      v-if="activeCategory === 'automation' && tool?.name === 'get_downloads_status'"
      :download-test-info="downloadTestInfo"
      @trigger-download="$emit('triggerDownload')"
      @refresh-downloads="$emit('refreshDownloads')"
    />

    <!-- 执行结果 -->
    <ToolResultPanel
      :result="executionResult"
      :format-fn="formatResult"
      @copy="$emit('copyResult')"
    />
  </div>
</template>

<script setup lang="ts">
import ToolParamsForm from './ToolParamsForm.vue';
import ToolResultPanel from './ToolResultPanel.vue';
import NavigationTestSection from './NavigationTestSection.vue';
import DownloadTestSection from './DownloadTestSection.vue';
import type { ToolDefinition, ExecutionResult, NavigationTestResult } from './types';

defineProps<{
  tool: ToolDefinition;
  toolParams: Record<string, any>;
  isExecuting: boolean;
  executionResult: ExecutionResult | null;
  activeCategory: string;
  isNavigationTesting: boolean;
  testProgress: number;
  testUrls: string[];
  navigationTestResult: NavigationTestResult | null;
  downloadTestInfo: string;
  formatResult: (result: ExecutionResult | null) => string;
}>();

defineEmits<{
  'update:toolParams': [params: Record<string, any>];
  execute: [];
  clearParams: [];
  runNavigationTest: [];
  clearNavigationTest: [];
  triggerDownload: [];
  refreshDownloads: [];
  copyResult: [];
}>();
</script>

<style scoped>
.tool-test-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  padding: 24px;
}

.tool-info {
  background: white;
  padding: 20px;
  border-radius: 12px;
  margin-bottom: 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.tool-title {
  margin: 0 0 8px;
  font-size: 24px;
  font-weight: 600;
  font-family: 'Consolas', 'Monaco', monospace;
  color: #333;
}

.tool-desc {
  margin: 0 0 12px;
  font-size: 14px;
  color: #666;
  line-height: 1.6;
}

.tool-meta {
  display: flex;
  gap: 12px;
}

.meta-tag {
  display: inline-block;
  padding: 4px 12px;
  border-radius: 6px;
  background: #f0f0f0;
  font-size: 12px;
  color: #666;
}

.action-buttons {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
}

.btn-execute,
.btn-clear {
  padding: 12px 24px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-execute {
  flex: 1;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.btn-execute:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
}

.btn-execute:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-clear {
  background: #f0f0f0;
  color: #666;
}

.btn-clear:hover {
  background: #e0e0e0;
}
</style>
