<template>
  <div class="tool-list">
    <div class="tool-list-header">
      <h3>{{ categoryName }} ({{ tools.length }})</h3>
      <input
        :value="searchQuery"
        type="text"
        class="search-input"
        placeholder="搜索工具..."
        @input="$emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
      />
    </div>
    <div class="tool-items">
      <div
        v-for="tool in filteredTools"
        :key="tool.name"
        class="tool-item"
        :class="{ active: selectedToolName === tool.name }"
        @click="$emit('select', tool)"
      >
        <div class="tool-item-header">
          <span class="tool-name">{{ tool.name }}</span>
        </div>
        <div class="tool-description">{{ tool.description }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ToolDefinition } from './types';

const props = defineProps<{
  categoryName: string;
  tools: ToolDefinition[];
  searchQuery: string;
  selectedToolName?: string;
}>();

defineEmits<{
  'update:searchQuery': [value: string];
  select: [tool: ToolDefinition];
}>();

const filteredTools = computed(() => {
  if (!props.searchQuery) return props.tools;
  const query = props.searchQuery.toLowerCase();
  return props.tools.filter(tool =>
    tool.name.toLowerCase().includes(query) ||
    tool.description.toLowerCase().includes(query)
  );
});
</script>

<style scoped>
.tool-list {
  width: 320px;
  display: flex;
  flex-direction: column;
  background: white;
  border-right: 1px solid #e0e0e0;
  min-height: 0;
  overflow: hidden;
}

.tool-list-header {
  padding: 16px;
  border-bottom: 1px solid #e0e0e0;
}

.tool-list-header h3 {
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 600;
}

.search-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  font-size: 14px;
}

.search-input:focus {
  outline: none;
  border-color: #667eea;
}

.tool-items {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.tool-item {
  padding: 12px;
  margin-bottom: 8px;
  border-radius: 8px;
  background: #f9f9f9;
  cursor: pointer;
  transition: all 0.2s;
}

.tool-item:hover {
  background: #f0f0f0;
}

.tool-item.active {
  background: #667eea;
  color: white;
}

.tool-item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.tool-name {
  font-size: 14px;
  font-weight: 600;
  font-family: 'Consolas', 'Monaco', monospace;
}

.tool-description {
  font-size: 12px;
  opacity: 0.8;
  line-height: 1.4;
}
</style>
