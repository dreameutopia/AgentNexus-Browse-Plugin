<template>
  <!--
    通用自绘选择框（Hub 全站替换原生 <select>）。
    玻璃触发器 + 玻璃浮层下拉：外点击 / Esc 关闭，方向键 + 回车键盘可达，
    选中项带对勾。宽度由使用方通过 class / style 作用于根元素控制。
  -->
  <div ref="rootRef" class="hub-select" :class="{ 'is-open': open }" @keydown.esc.stop="close">
    <button
      ref="triggerRef"
      type="button"
      class="hub-select__trigger"
      :disabled="disabled"
      role="combobox"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :aria-label="ariaLabel"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <span class="hub-select__value" :class="{ 'is-placeholder': !selectedLabel }">
        {{ selectedLabel || placeholder }}
      </span>
      <svg class="hub-select__chevron" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <!-- 纯 CSS 进场动画（hubPopIn）：不依赖 <Transition>，无 requestAnimationFrame
         的嵌入环境（如 JSDOM 测试宿主）同样可用；与 CategorySelect 浮层同一手法 -->
    <div v-if="open" class="hub-select__pop" role="listbox" :aria-label="ariaLabel">
      <button
        v-for="(option, index) in options"
        :key="option.value"
        :ref="el => setOptionEl(index, el)"
        type="button"
        role="option"
        class="hub-select__option"
        :class="{ 'is-selected': option.value === modelValue, 'is-highlight': index === highlightIndex }"
        :aria-selected="option.value === modelValue"
        :data-value="option.value"
        @click="choose(option.value)"
        @mousemove="highlightIndex = index"
      >
        <span class="hub-select__option-label">{{ option.label }}</span>
        <svg v-if="option.value === modelValue" class="hub-select__check" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <div v-if="!options.length" class="hub-select__empty">{{ emptyText }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 自绘单选下拉（受控组件，v-model 绑定选项 value）。
 *
 * 交互约定（对齐 macOS / iOS 菜单行为）：
 *   - 触发器点击开合；点击组件外部或 Esc 关闭；
 *   - 键盘：Enter / Space / ArrowDown 打开；打开后 ↑↓ 移动高亮（自动滚入视野），
 *     Enter 选中高亮项，Home / End 跳到首尾，Esc 关闭并把焦点还给触发器；
 *   - 鼠标划过即同步高亮，点击直接选中。
 * 视觉（hub.css）：.hub-select__* —— 玻璃触发器、旋转箭头、玻璃浮层 + CSS 进场动画。
 */
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { t } from '@/utils/i18n';

interface SelectOption {
  value: string;
  label: string;
}

const props = withDefaults(
  defineProps<{
    /** 当前选中值（v-model） */
    modelValue: string;
    /** 选项列表（保持传入顺序渲染） */
    options: SelectOption[];
    /** 未选中时触发器占位文案 */
    placeholder?: string;
    /** 禁用态 */
    disabled?: boolean;
    /** 无障碍标签（不传则依赖可见文案） */
    ariaLabel?: string;
  }>(),
  {
    placeholder: '',
    disabled: false,
    ariaLabel: '',
  },
);

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void;
}>();

const emptyText = computed(() => t('common.none'));

const selectedLabel = computed(
  () => props.options.find(option => option.value === props.modelValue)?.label ?? '',
);

// ──── 开合与外点击关闭 ────

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLButtonElement | null>(null);

function toggle(): void {
  if (props.disabled) return;
  if (open.value) close();
  else openList();
}

function openList(): void {
  if (props.disabled || open.value) return;
  open.value = true;
  highlightIndex.value = Math.max(
    0,
    props.options.findIndex(option => option.value === props.modelValue),
  );
}

function close(): void {
  if (!open.value) return;
  open.value = false;
  // 关闭后把焦点还给触发器，键盘用户不会失焦
  void nextTick(() => triggerRef.value?.focus());
}

function handleDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const target = event.target as Node | null;
  if (target && rootRef.value?.contains(target)) return;
  open.value = false;
}

// 挂在 document 上（下拉浮层可能溢出触发器父级的 overflow 裁剪）
document.addEventListener('pointerdown', handleDocumentPointerDown, { passive: true });
onUnmounted(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
});

// ──── 键盘导航 ────

const highlightIndex = ref(0);
const optionEls = new Map<number, HTMLElement>();

function setOptionEl(index: number, el: unknown): void {
  if (el instanceof HTMLElement) optionEls.set(index, el);
  else optionEls.delete(index);
}

function moveHighlight(delta: number): void {
  if (!props.options.length) return;
  highlightIndex.value =
    (highlightIndex.value + delta + props.options.length) % props.options.length;
  optionEls.get(highlightIndex.value)?.scrollIntoView({ block: 'nearest' });
}

function onTriggerKeydown(event: KeyboardEvent): void {
  if (props.disabled) return;
  switch (event.key) {
    case 'Enter':
    case ' ':
    case 'ArrowDown':
      event.preventDefault();
      openList();
      break;
    case 'ArrowUp':
      event.preventDefault();
      openList();
      moveHighlight(-1);
      break;
  }
}

function onListKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      moveHighlight(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      moveHighlight(-1);
      break;
    case 'Home':
      event.preventDefault();
      highlightIndex.value = 0;
      optionEls.get(0)?.scrollIntoView({ block: 'nearest' });
      break;
    case 'End':
      event.preventDefault();
      highlightIndex.value = props.options.length - 1;
      optionEls.get(props.options.length - 1)?.scrollIntoView({ block: 'nearest' });
      break;
    case 'Enter':
      event.preventDefault();
      choose(props.options[highlightIndex.value]?.value ?? '');
      break;
  }
}

// 浮层打开后挂键盘监听（浮层自身可含滚动，事件直接冒泡到根）
watch(open, value => {
  if (value) void nextTick(() => rootRef.value?.addEventListener('keydown', onListKeydown));
  else rootRef.value?.removeEventListener('keydown', onListKeydown);
});

onUnmounted(() => {
  rootRef.value?.removeEventListener('keydown', onListKeydown);
});

// ──── 选中 ────

function choose(value: string): void {
  emit('update:modelValue', value);
  open.value = false;
  void nextTick(() => triggerRef.value?.focus());
}
</script>
