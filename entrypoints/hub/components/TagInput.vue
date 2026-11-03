<template>
  <!--
    标签输入（智能体 / 技能编辑器共用）：chips 展示 + 草稿输入框。
    回车 / 逗号 / 空格 / 失焦提交，经 normalizeTags 统一去重与上限收敛——
    与智能体标签同一套规范（单项长度与数量上限集中在 utils/agents/agent-types）。
  -->
  <div class="tag-input">
    <div v-if="modelValue.length" class="hub-tags">
      <span v-for="tag in modelValue" :key="tag" class="hub-tag">
        {{ tag }}
        <button type="button" class="hub-tag-remove" :title="t('common.delete')" @click="removeTag(tag)">×</button>
      </span>
    </div>
    <input
      v-model="draft"
      type="text"
      :maxlength="maxChars"
      :placeholder="placeholderText"
      @keydown.enter.prevent="commitDraft()"
      @keydown="handleKeydown"
      @blur="commitDraft()"
    />
    <p v-if="limitExceeded" class="hub-error">{{ t('hub.tagLimitHint', { max }) }}</p>
    <p v-else class="hub-hint">{{ hintText }}</p>
  </div>
</template>

<script setup lang="ts">
/**
 * 标签输入组件（受控，v-model 为标签数组）。
 * 交互与提示从智能体编辑器内联实现中原样迁移，保证两处行为一致：
 *   - 提交草稿：按逗号（含全角）/ 空格切分多个候选，统一归一化；
 *   - 全部被去重/上限丢弃时明确给出上限提示，而不是无声吞掉。
 */
import { computed, ref, watch } from 'vue';
import { t } from '@/utils/i18n';
import {
  AGENT_TAG_MAX_CHARS,
  AGENT_TAGS_MAX_COUNT,
  normalizeTags,
} from '@/utils/agents/agent-types';

const props = withDefaults(
  defineProps<{
    /** 标签数组（v-model） */
    modelValue: string[];
    /** 标签数量上限（展示用；归一化上限恒等于 AGENT_TAGS_MAX_COUNT） */
    max?: number;
    /** 单个标签长度上限（输入框 maxlength） */
    maxChars?: number;
    /** 输入框占位文案 */
    placeholder?: string;
    /** 底部提示文案（未触顶时展示） */
    hint?: string;
  }>(),
  {
    max: AGENT_TAGS_MAX_COUNT,
    maxChars: AGENT_TAG_MAX_CHARS,
    placeholder: '',
    hint: '',
  },
);

const emit = defineEmits<{ (event: 'update:modelValue', value: string[]): void }>();

const draft = ref('');
/** 标签数量触顶且新输入被丢弃时展示上限提示（清空后自动复位） */
const limitExceeded = ref(false);

const placeholderText = computed(() => props.placeholder || t('hub.fieldTagsPlaceholder'));
const hintText = computed(() => props.hint || t('hub.fieldTagsHint', { max: props.max }));

/** 提交标签草稿：按逗号/空格切分多个，统一经 normalizeTags 去重与上限收敛 */
function commitDraft(): void {
  const value = draft.value;
  draft.value = '';
  const candidates = value
    .split(/[,，\s]+/)
    .map(tag => tag.trim())
    .filter(Boolean);
  if (candidates.length === 0) return;
  const next = normalizeTags([...props.modelValue, ...candidates]);
  if (next.length === props.modelValue.length) {
    // 全部被去重/上限丢弃：明确提示而不是无声吞掉
    limitExceeded.value = props.modelValue.length >= props.max;
    return;
  }
  limitExceeded.value = next.length >= props.max;
  emit('update:modelValue', next);
}

/** 输入逗号时立即提交（中文输入法的全角逗号同样生效） */
function handleKeydown(event: KeyboardEvent): void {
  if (event.key === ',' || event.key === '，') {
    event.preventDefault();
    commitDraft();
  }
}

function removeTag(tag: string): void {
  emit(
    'update:modelValue',
    props.modelValue.filter(item => item !== tag),
  );
}

/** 上限提示随标签数回落自动复位（父组件清空表单等场景） */
watch(
  () => props.modelValue.length,
  length => {
    if (length < props.max) limitExceeded.value = false;
  },
);
</script>
