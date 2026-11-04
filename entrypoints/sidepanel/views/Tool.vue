<template>
  <div class="tool-test-container">
    <!-- 工具分类导航 -->
    <CategoryTabs
      :categories="categories"
      :model-value="activeCategory"
      @update:model-value="activeCategory = $event"
    />

    <!-- 工具列表和测试区域 -->
    <div class="content-area">
      <!-- 左侧工具列表 -->
      <ToolList
        :category-name="currentCategoryName"
        :tools="currentTools"
        :search-query="searchQuery"
        :selected-tool-name="selectedTool?.name"
        @update:search-query="searchQuery = $event"
        @select="selectTool"
      />

      <!-- 右侧测试区域 -->
      <div class="test-area">
        <div v-if="!selectedTool" class="empty-state">
          <div class="empty-icon">🔧</div>
          <p>请从左侧选择一个工具开始测试</p>
        </div>

        <ToolTestPanel
          v-else
          :tool="selectedTool"
          :tool-params="toolParams"
          :is-executing="isExecuting"
          :execution-result="executionResult"
          :active-category="activeCategory"
          :is-navigation-testing="isNavigationTesting"
          :test-progress="testProgress"
          :test-urls="testUrls"
          :navigation-test-result="navigationTestResult"
          :download-test-info="downloadTestInfo"
          :format-result="formatResult"
          @update:tool-params="updateToolParams"
          @execute="executeTool"
          @clear-params="clearParams"
          @run-navigation-test="runNavigationTest"
          @clear-navigation-test="clearNavigationTest"
          @trigger-download="triggerTestDownload"
          @refresh-downloads="refreshDownloads"
          @copy-result="copyResult"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
// 多词组件名（vue/multi-word-component-names）：该视图作为工具箱面板嵌入 App.vue
defineOptions({ name: 'ToolboxPanelView' });
import {
  categories,
  testUrls,
  CategoryTabs,
  ToolList,
  ToolTestPanel,
  useToolExecution,
  useNavigationTest,
  useDownloadTest
} from '../components/tool';

// 分类状态
const activeCategory = ref<string>('automation');
const searchQuery = ref('');

// 工具执行
const {
  selectedTool,
  toolParams,
  isExecuting,
  executionResult,
  selectTool,
  clearParams,
  executeTool,
  formatResult,
  copyResult
} = useToolExecution();
const updateToolParams = (params: Record<string, any>) => {
  for (const key of Object.keys(toolParams)) delete toolParams[key];
  Object.assign(toolParams, params);
};

// 导航测试
const {
  isNavigationTesting,
  testProgress,
  navigationTestResult,
  runNavigationTest,
  clearNavigationTest
} = useNavigationTest();

// 下载测试
const { downloadTestInfo, triggerTestDownload, refreshDownloads } = useDownloadTest();

// 计算属性
const currentCategoryName = computed(() => {
  const category = categories.find(c => c.id === activeCategory.value);
  return category ? category.name : '';
});

const currentTools = computed(() => {
  const category = categories.find(c => c.id === activeCategory.value);
  return category ? category.tools : [];
});
</script>

<style scoped>
.tool-test-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  max-height: 100%;
  background: #f5f5f5;
  overflow: hidden;
}

:global(html, body, #app) {
  height: 100%;
  overflow: hidden;
}

.content-area {
  display: flex;
  flex: 1;
  overflow: hidden;
  min-height: 0;
}

.test-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #fafafa;
  min-height: 0;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #999;
}

.empty-icon {
  font-size: 64px;
  margin-bottom: 16px;
}

.empty-state p {
  font-size: 14px;
}
</style>
