<template>
  <div class="category-tabs">
    <button
      v-for="category in categories"
      :key="category.id"
      class="category-tab"
      :class="{ active: modelValue === category.id }"
      @click="$emit('update:modelValue', category.id)"
    >
      <span class="category-icon">{{ category.icon }}</span>
      <span class="category-name">{{ category.name }}</span>
      <span class="category-count">{{ category.tools.length }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import type { ToolCategory } from './types';

defineProps<{
  categories: ToolCategory[];
  modelValue: string;
}>();

defineEmits<{
  'update:modelValue': [value: string];
}>();
</script>

<style scoped>
.category-tabs {
  display: flex;
  gap: 6px;
  padding: 10px 16px;
  background: white;
  border-bottom: 1px solid #e0e0e0;
  overflow-x: auto;
}

.category-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-radius: 8px;
  background: #f5f5f5;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.category-tab:hover {
  background: #e0e0e0;
}

.category-tab.active {
  background: #667eea;
  color: white;
}

.category-icon {
  font-size: 16px;
}

.category-name {
  font-size: 12px;
  font-weight: 500;
}

.category-count {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.1);
  font-size: 10px;
}
</style>
