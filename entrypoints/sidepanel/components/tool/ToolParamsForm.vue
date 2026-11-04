<template>
  <div class="params-form">
    <h3 class="section-title">参数配置</h3>
    <div v-if="Object.keys(activeTool.parameters).length === 0" class="no-params">
      此工具无需参数
    </div>
    <div v-else class="param-fields">
      <div
        v-for="(param, paramName) in activeTool.parameters"
        :key="paramName"
        class="param-field"
      >
        <label class="param-label">
          <span class="param-name">{{ paramName }}</span>
          <span v-if="activeTool.required.includes(paramName)" class="required">*</span>
          <span class="param-type">{{ param.type }}</span>
        </label>
        <div class="param-description">{{ param.description }}</div>

        <!-- 布尔类型 -->
        <label v-if="param.type === 'boolean'" class="checkbox-label">
          <input
            :checked="modelValue[paramName]"
            type="checkbox"
            @change="updateParam(paramName, ($event.target as HTMLInputElement).checked)"
          />
          <span>{{ param.description }}</span>
        </label>

        <!-- 数字类型 -->
        <input
          v-else-if="param.type === 'number' || param.type === 'integer'"
          :value="modelValue[paramName]"
          type="number"
          class="param-input"
          :placeholder="param.default !== undefined ? `默认: ${param.default}` : ''"
          :min="param.minimum"
          :max="param.maximum"
          :step="param.type === 'integer' ? 1 : 'any'"
          @input="updateParam(paramName, Number(($event.target as HTMLInputElement).value))"
        />

        <!-- 枚举类型 -->
        <select
          v-else-if="param.enum"
          :value="modelValue[paramName]"
          class="param-select"
          @change="updateParam(paramName, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">请选择...</option>
          <option
            v-for="option in param.enum"
            :key="option"
            :value="option"
          >
            {{ option }}
          </option>
        </select>

        <!-- 数组类型 -->
        <textarea
          v-else-if="param.type === 'array'"
          :value="modelValue[paramName]"
          class="param-textarea"
          placeholder='JSON数组格式，例如: ["item1", "item2"]'
          rows="3"
          @input="updateParam(paramName, ($event.target as HTMLTextAreaElement).value)"
        ></textarea>

        <!-- 对象类型 -->
        <textarea
          v-else-if="param.type === 'object'"
          :value="modelValue[paramName]"
          class="param-textarea"
          placeholder='JSON对象格式，例如: {"key": "value"}'
          rows="4"
          @input="updateParam(paramName, ($event.target as HTMLTextAreaElement).value)"
        ></textarea>

        <!-- 字符串类型（多行） -->
        <textarea
          v-else-if="param.multiline"
          :value="modelValue[paramName]"
          class="param-textarea"
          :placeholder="param.placeholder || param.description"
          rows="4"
          @input="updateParam(paramName, ($event.target as HTMLTextAreaElement).value)"
        ></textarea>

        <!-- 字符串类型（单行） -->
        <input
          v-else
          :value="modelValue[paramName]"
          type="text"
          class="param-input"
          :placeholder="param.placeholder || param.description"
          @input="updateParam(paramName, ($event.target as HTMLInputElement).value)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ToolDefinition, ToolParameter } from './types';
import { resolveActionDefinition } from './types';
import { computed } from 'vue';

const props = defineProps<{
  tool: ToolDefinition;
  modelValue: Record<string, any>;
}>();

const emit = defineEmits<{
  'update:modelValue': [params: Record<string, any>];
}>();
const activeTool = computed(() => resolveActionDefinition(props.tool, props.modelValue.action));

const updateParam = (paramName: string, value: any) => {
  if (paramName === 'action' && props.tool.actionSchemas) {
    const next: Record<string, any> = { action: value };
    // Screenshot identity can carry across action selection; gesture fields cannot.
    if (props.modelValue.screenshotId) next.screenshotId = props.modelValue.screenshotId;
    emit('update:modelValue', next);
    return;
  }
  emit('update:modelValue', { ...props.modelValue, [paramName]: value });
};
</script>

<style scoped>
.params-form {
  background: white;
  padding: 20px;
  border-radius: 12px;
  margin-bottom: 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.section-title {
  margin: 0 0 16px;
  font-size: 18px;
  font-weight: 600;
  color: #333;
}

.no-params {
  padding: 20px;
  text-align: center;
  color: #999;
  font-style: italic;
}

.param-fields {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.param-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.param-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
  color: #333;
}

.param-name {
  font-family: 'Consolas', 'Monaco', monospace;
}

.required {
  color: #e74c3c;
  font-weight: bold;
}

.param-type {
  padding: 2px 8px;
  border-radius: 4px;
  background: #e8eaf6;
  color: #5c6bc0;
  font-size: 11px;
  font-family: 'Consolas', 'Monaco', monospace;
}

.param-description {
  font-size: 12px;
  color: #666;
  font-style: italic;
}

.param-input,
.param-select,
.param-textarea {
  padding: 10px 12px;
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  font-size: 14px;
  font-family: inherit;
  transition: border-color 0.2s;
}

.param-input:focus,
.param-select:focus,
.param-textarea:focus {
  outline: none;
  border-color: #667eea;
}

.param-textarea {
  resize: vertical;
  font-family: 'Consolas', 'Monaco', monospace;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  border-radius: 6px;
  background: #f9f9f9;
  cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
  cursor: pointer;
}
</style>
