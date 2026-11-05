<template>
  <!--
    自定义分类选择器（智能体 / 技能编辑器共用）。
    取代原生 <select>：分组下拉（内置分类 / 已有自定义分类）+ 末项「新建自定义分类」；
    选择新建时，新分类名称输入框与选择器出现在同一行，所见即所得地引导用户完成创建。
    v-model 绑定分类 id（'' = 未分类，仅 allowUncategorized 时可选）；
    modelValue === CATEGORY_CUSTOM_VALUE 表示处于自定义创建态，名称经 v-model:custom 双向绑定。
  -->
  <div ref="rootRef" class="cat-select" :class="{ 'is-open': open, 'is-invalid': invalid }" @keydown.esc.stop="open = false">
    <div class="cat-select-row">
      <button
        type="button"
        class="cat-select-trigger"
        :aria-expanded="open"
        aria-haspopup="listbox"
        @click.stop="open = !open"
      >
        <span class="cat-select-dot" :style="{ background: dotColorFor(modelValue) }" aria-hidden="true"></span>
        <span class="cat-select-value" :class="{ 'is-placeholder': !currentLabel }">{{ currentLabel || placeholder }}</span>
        <svg class="cat-select-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <input
        v-if="isCustom"
        ref="customInputRef"
        :value="custom"
        type="text"
        class="cat-select-custom"
        :maxlength="maxCustomChars"
        :placeholder="t('hub.categoryCustomPlaceholder')"
        @input="onCustomInput"
      />
    </div>

    <div v-if="open" class="cat-select-pop" role="listbox" @click.stop>
      <template v-for="(section, index) in sections" :key="section.key">
        <template v-if="section.options.length > 0">
          <div v-if="section.label && index > 0" class="cat-select-divider" aria-hidden="true"></div>
          <div v-if="section.label" class="cat-select-section-label">{{ section.label }}</div>
          <button
            v-for="option in section.options"
            :key="option.id || '__none__'"
            type="button"
            class="cat-select-option"
            :class="{ 'is-selected': option.id === modelValue }"
            role="option"
            :aria-selected="option.id === modelValue"
            @click="choose(option.id)"
          >
            <span class="cat-select-dot" :style="{ background: dotColorFor(option.id) }" aria-hidden="true"></span>
            <span class="cat-select-option-label">{{ option.label }}</span>
            <svg v-if="option.id === modelValue" class="cat-select-check" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </template>
      </template>

      <div class="cat-select-divider" aria-hidden="true"></div>
      <button
        type="button"
        class="cat-select-option cat-select-create"
        :class="{ 'is-selected': isCustom }"
        @click="choose(CATEGORY_CUSTOM_VALUE)"
      >
        <svg class="cat-select-plus" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
        <span class="cat-select-option-label">{{ t('hub.categoryCreate') }}</span>
        <svg v-if="isCustom" class="cat-select-check" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 自定义分类选择器（受控组件）。
 *
 * 分类规范与智能体完全统一（utils/agents/agent-types）：
 *   - 内置分类注册表 BUILTIN_AGENT_CATEGORIES（显示名经 i18n）；
 *   - 已有自定义分类来自智能体与技能两个存储的并集，可直接复用而无需重输；
 *   - 「新建自定义分类」以 CATEGORY_CUSTOM_VALUE 哨兵进入自定义态，
 *     名称输入框与选择器同一行，保存时由父组件经 normalizeCategory 归一化。
 * 交互：点击外部或按 Esc 关闭下拉；选中新建项后输入框自动聚焦。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { t, type MessageKey } from '@/utils/i18n';
import {
  AGENT_CATEGORY_MAX_CHARS,
  BUILTIN_AGENT_CATEGORIES,
  CATEGORY_CUSTOM_VALUE,
  isBuiltinCategory,
  normalizeCategory,
} from '@/utils/agents/agent-types';
import { getAllAgents, onAgentsChange } from '@/utils/agents/agent-store';
import { getAllSkills, onSkillsChange } from '@/utils/skills/skill-store';

const props = withDefaults(
  defineProps<{
    /** 当前分类 id（'' = 未分类；CATEGORY_CUSTOM_VALUE = 自定义创建态） */
    modelValue: string;
    /** 自定义创建态下的新分类名称（v-model:custom） */
    custom?: string;
    /** 是否提供「未分类」选项（智能体允许未分类；技能分类必选） */
    allowUncategorized?: boolean;
    /** 校验失败态（红框 + 浅红底，与 .hub-field.is-invalid 同视觉） */
    invalid?: boolean;
    /** 未选择任何分类时触发器的占位文案 */
    placeholder?: string;
  }>(),
  {
    custom: '',
    allowUncategorized: false,
    invalid: false,
    placeholder: '',
  },
);

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void;
  (event: 'update:custom', value: string): void;
}>();

// ──── 选项数据：内置注册表 + 智能体/技能中已使用的自定义分类 ────

const customCategoryIds = ref<string[]>([]);

function refreshCustomCategoryIds(): void {
  const ids = new Set<string>();
  for (const agent of getAllAgents()) {
    const id = normalizeCategory(agent.category);
    if (id && !isBuiltinCategory(id)) ids.add(id);
  }
  for (const skill of getAllSkills()) {
    const id = normalizeCategory(skill.category);
    if (id && !isBuiltinCategory(id)) ids.add(id);
  }
  customCategoryIds.value = [...ids].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

const unsubscribeAgents = onAgentsChange(refreshCustomCategoryIds);
const unsubscribeSkills = onSkillsChange(refreshCustomCategoryIds);
onMounted(refreshCustomCategoryIds);
onUnmounted(() => {
  unsubscribeAgents();
  unsubscribeSkills();
});

interface CategoryOption {
  id: string;
  label: string;
}

interface CategorySection {
  key: string;
  /** 分组标题；null = 无标题组（「未分类」置于顶部时不分组） */
  label: string | null;
  options: CategoryOption[];
}

const sections = computed<CategorySection[]>(() => {
  const list: CategorySection[] = [];
  if (props.allowUncategorized) {
    list.push({ key: 'none', label: null, options: [{ id: '', label: t('hub.categoryNone') }] });
  }
  list.push({
    key: 'builtin',
    label: t('hub.categoryGroupBuiltin'),
    options: BUILTIN_AGENT_CATEGORIES.map(category => ({
      id: category.id,
      label: t(category.labelKey as MessageKey),
    })),
  });
  if (customCategoryIds.value.length > 0) {
    list.push({
      key: 'custom',
      label: t('hub.categoryGroupCustom'),
      options: customCategoryIds.value.map(id => ({ id, label: id })),
    });
  }
  return list;
});

// ──── 展示状态 ────

const isCustom = computed(() => props.modelValue === CATEGORY_CUSTOM_VALUE);

const currentLabel = computed(() => {
  if (isCustom.value) return t('hub.categoryCustom');
  if (!props.modelValue) return props.allowUncategorized ? t('hub.categoryNone') : '';
  const builtin = BUILTIN_AGENT_CATEGORIES.find(category => category.id === props.modelValue);
  return builtin ? t(builtin.labelKey as MessageKey) : props.modelValue;
});

const placeholder = computed(() => props.placeholder || t('hub.categoryPlaceholder'));

const maxCustomChars = AGENT_CATEGORY_MAX_CHARS;

/** 分类圆点色：内置分类各配一色，自定义统一青色，未分类灰色 */
const BUILTIN_DOT_COLORS: Record<string, string> = {
  automation: '#667eea',
  search: '#0ea5e9',
  vision: '#8b5cf6',
  content: '#10b981',
  media: '#f59e0b',
  general: '#9b9790',
};
const CUSTOM_DOT_COLOR = '#14b8a6';
const EMPTY_DOT_COLOR = '#d8d4cc';

function dotColorFor(id: string): string {
  if (!id) return EMPTY_DOT_COLOR;
  if (id === CATEGORY_CUSTOM_VALUE) return CUSTOM_DOT_COLOR;
  return BUILTIN_DOT_COLORS[id] ?? CUSTOM_DOT_COLOR;
}

// ──── 交互 ────

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const customInputRef = ref<HTMLInputElement | null>(null);

function choose(id: string): void {
  emit('update:modelValue', id);
  open.value = false;
  if (id === CATEGORY_CUSTOM_VALUE) {
    void nextTick(() => customInputRef.value?.focus());
  }
}

function onCustomInput(event: Event): void {
  emit('update:custom', (event.target as HTMLInputElement).value);
}

/** 切换进入自定义态时输入框自动聚焦（从外部赋值进入同样生效） */
watch(isCustom, custom => {
  if (custom) void nextTick(() => customInputRef.value?.focus());
});

/** 点击组件外部关闭下拉 */
function handleDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const target = event.target as Node | null;
  if (target && rootRef.value?.contains(target)) return;
  open.value = false;
}

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown, { passive: true });
});
onUnmounted(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
});
</script>
