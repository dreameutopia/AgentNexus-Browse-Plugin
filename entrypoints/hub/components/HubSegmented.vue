<template>
  <!--
    分段控件（玻璃轨道 + 滑动指示块）：双态/多态切换的统一形态。
    指示块按激活项索引 translateX 滑动（弹性缓动），选项等宽平铺。
  -->
  <div class="hub-seg" role="radiogroup" :aria-label="ariaLabel">
    <span class="hub-seg__thumb" :style="thumbStyle" aria-hidden="true"></span>
    <button
      v-for="(option, index) in options"
      :key="option.value"
      :ref="el => setBtnEl(index, el)"
      type="button"
      role="radio"
      class="hub-seg__btn"
      :class="{ 'is-active': option.value === modelValue }"
      :aria-checked="option.value === modelValue"
      :tabindex="option.value === modelValue ? 0 : -1"
      @click="choose(option.value)"
      @keydown="onKeydown"
    >{{ option.label }}</button>
  </div>
</template>

<script setup lang="ts">
/**
 * 分段控件（受控组件，v-model 绑定选项 value）。
 * 键盘按 radiogroup 约定：←→（含 ↑↓）在选项间循环切换并即时选中。
 * 指示块宽度按选项数等分（减去轨道 3px×2 内边距），位置随激活索引滑动。
 */
import { computed } from 'vue';

interface SegmentedOption {
  value: string;
  label: string;
}

const props = defineProps<{
  modelValue: string;
  options: SegmentedOption[];
  ariaLabel?: string;
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void;
}>();

const activeIndex = computed(() =>
  Math.max(0, props.options.findIndex(option => option.value === props.modelValue)),
);

const thumbStyle = computed(() => ({
  width: `calc((100% - 6px) / ${Math.max(1, props.options.length)})`,
  transform: `translateX(${activeIndex.value * 100}%)`,
}));

function choose(value: string): void {
  emit('update:modelValue', value);
}

const btnEls = new Map<number, HTMLElement>();

function setBtnEl(index: number, el: unknown): void {
  if (el instanceof HTMLElement) btnEls.set(index, el);
  else btnEls.delete(index);
}

function onKeydown(event: KeyboardEvent): void {
  const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
    ? -1
    : event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? 1
      : 0;
  if (!delta || props.options.length === 0) return;
  event.preventDefault();
  const next = (activeIndex.value + delta + props.options.length) % props.options.length;
  choose(props.options[next].value);
  // roving tabindex：切换后焦点移到新激活按钮
  btnEls.get(next)?.focus();
}
</script>
