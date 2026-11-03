<template>
  <div class="select-menu" @keydown.esc="handleEsc">
    <button
      class="select-trigger"
      :class="[`select-trigger-${size}`, { open }]"
      type="button"
      :title="title"
      :disabled="disabled"
      @click.stop="open = !open"
    >
      <span class="select-trigger-label">{{ currentLabel }}</span>
      <svg
        class="select-trigger-chevron"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>

    <div
      v-if="open"
      class="select-popup"
      :class="align === 'right' ? 'select-popup-right' : 'select-popup-left'"
      role="listbox"
    >
      <button
        v-for="item in items"
        :key="item.value"
        class="select-option"
        :class="{ active: item.value === modelValue }"
        type="button"
        role="option"
        :aria-selected="item.value === modelValue"
        @click="choose(item)"
      >
        <span class="select-option-label">{{ item.label }}</span>
        <svg
          v-if="item.value === modelValue"
          class="select-option-check"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';

export interface SelectMenuItem {
  value: string;
  label: string;
}

/**
 * 自定义下拉选择器（统一替换原生 <select>）：
 * - 触发按钮 + 浮层选项列表，风格与页面中性玻璃样式一致；
 * - 展开时监听文档级点击，点外部即收起（触发按钮带 .stop 不受影响）；
 * - ESC：菜单展开时只收起菜单（阻断全局「返回列表」），未展开时放行；
 * - 选中项打勾高亮，超长标签省略号截断。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    items: SelectMenuItem[];
    title?: string;
    align?: 'left' | 'right';
    size?: 'xs' | 'sm' | 'md';
    disabled?: boolean;
  }>(),
  {
    title: '',
    align: 'left',
    size: 'md',
    disabled: false,
  },
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const open = ref(false);

const currentLabel = computed(() => {
  const matched = props.items.find((item) => item.value === props.modelValue);
  if (matched) return matched.label;
  // 当前值不在候选中（如自定义分类刚被外部改名）：显示首项兜底
  return props.items[0]?.label ?? '';
});

function choose(item: SelectMenuItem): void {
  open.value = false;
  if (item.value !== props.modelValue) emit('update:modelValue', item.value);
}

/** 菜单未展开时 Esc 不拦截，交还给页面级「返回列表」快捷键 */
function handleEsc(event: KeyboardEvent): void {
  if (!open.value) return;
  event.stopPropagation();
  event.preventDefault();
  open.value = false;
}

function handleDocumentClick(): void {
  open.value = false;
}

watch(open, (isOpen) => {
  if (isOpen) document.addEventListener('click', handleDocumentClick);
  else document.removeEventListener('click', handleDocumentClick);
});

onUnmounted(() => {
  document.removeEventListener('click', handleDocumentClick);
});
</script>
