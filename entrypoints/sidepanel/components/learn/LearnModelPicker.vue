<script setup lang="ts">
/**
 * 学习模型选择卡片（自定义下拉）
 *
 * 为什么不用原生 <select>：
 *   原生下拉在侧边栏窄宽度下无法排版渠道名与视觉标识，弹出的系统菜单也不受
 *   扩展样式约束。这里改成「常驻卡片 + 就地展开列表」：
 *   触发卡片显示当前模型（名称 / 渠道 / 视觉徽标），展开后是可滚动的选项列表。
 *   列表留在文档流内（不浮在滚动容器之上），因此既不会撑出横向滚动条，
 *   也不会被弹窗正文裁切。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { Check, ChevronDown } from 'lucide-vue-next';
import { t } from '@/utils/i18n';
import type { LearnModelCandidate } from '@/utils/learn/learn-validate';

const props = defineProps<{
  /** 当前表单口径下可选的模型（父级已按视觉需求过滤） */
  models: LearnModelCandidate[];
  /** 已选模型的稳定键 */
  modelKey: string;
}>();

const emit = defineEmits<{
  'update:modelKey': [key: string];
}>();

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const optionRefs = ref<HTMLButtonElement[]>([]);

const selected = computed(
  () => props.models.find(model => model.key === props.modelKey) ?? null,
);

function toggle(): void {
  open.value = !open.value;
}

function close(): void {
  open.value = false;
}

function choose(model: LearnModelCandidate): void {
  emit('update:modelKey', model.key);
  close();
}

/** 点击卡片外部时收起 */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const target = event.target as Node | null;
  if (target && rootRef.value?.contains(target)) return;
  close();
}

function setOptionRef(el: unknown, index: number): void {
  if (el instanceof HTMLButtonElement) {
    optionRefs.value[index] = el;
  }
}

/** 把焦点移到第 index 个选项（越界则夹到区间内） */
function focusOption(index: number): void {
  const list = optionRefs.value;
  if (!list.length) return;
  const clamped = Math.min(Math.max(index, 0), list.length - 1);
  list[clamped]?.focus();
}

/** 打开列表并聚焦到当前选中项（没有则第一项） */
function openAndFocus(step: 0 | 1 | -1): void {
  open.value = true;
  const current = props.models.findIndex(model => model.key === props.modelKey);
  const base = current >= 0 ? current : 0;
  window.requestAnimationFrame(() => focusOption(base + step));
}

function onTriggerKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    openAndFocus(0);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    openAndFocus(-1);
  } else if (event.key === 'Escape' && open.value) {
    event.preventDefault();
    close();
  }
}

function onOptionKeydown(event: KeyboardEvent, index: number): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    focusOption(index + 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    focusOption(index - 1);
  } else if (event.key === 'Home') {
    event.preventDefault();
    focusOption(0);
  } else if (event.key === 'End') {
    event.preventDefault();
    focusOption(props.models.length - 1);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
  }
}

watch(open, value => {
  if (value) {
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
  } else {
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
    optionRefs.value = [];
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
});
</script>

<template>
  <div ref="rootRef" class="learn-picker" :class="{ 'learn-picker--open': open }">
    <button
      type="button"
      class="learn-picker__trigger"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-label="t('sidepanel.learn.modelLabel')"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <span class="learn-picker__text">
        <span class="learn-picker__label" :class="{ 'is-placeholder': !selected }">
          {{ selected ? selected.label : t('sidepanel.learn.modelPlaceholder') }}
        </span>
        <span v-if="selected" class="learn-picker__meta">
          <span class="learn-picker__channel">{{ selected.channelName }}</span>
          <span v-if="selected.canAcceptImages" class="learn-picker__badge">
            {{ t('sidepanel.learn.modelVisionBadge') }}
          </span>
        </span>
      </span>
      <ChevronDown class="learn-picker__chevron" :size="16" aria-hidden="true" />
    </button>

    <Transition name="learn-picker">
      <div v-if="open" class="learn-picker__panel">
        <div class="learn-picker__panel-inner">
          <ul class="learn-picker__list" role="listbox" :aria-label="t('sidepanel.learn.modelLabel')">
            <li v-for="(model, index) in models" :key="model.key" class="learn-picker__item">
              <button
                :ref="el => setOptionRef(el, index)"
                type="button"
                class="learn-picker__option"
                role="option"
                :aria-selected="model.key === modelKey"
                @click="choose(model)"
                @keydown="onOptionKeydown($event, index)"
              >
                <span class="learn-picker__option-text">
                  <span class="learn-picker__option-label">{{ model.label }}</span>
                  <span class="learn-picker__option-channel">{{ model.channelName }}</span>
                </span>
                <span v-if="model.canAcceptImages" class="learn-picker__badge">
                  {{ t('sidepanel.learn.modelVisionBadge') }}
                </span>
                <Check
                  v-if="model.key === modelKey"
                  class="learn-picker__check"
                  :size="14"
                  aria-hidden="true"
                />
              </button>
            </li>
          </ul>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.learn-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

/* ──── 触发卡片 ──── */
.learn-picker__trigger {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-width: 0;
  padding: 9px 11px;
  border: 1px solid var(--learn-border-strong, #d1d5db);
  border-radius: 10px;
  background: var(--learn-surface, #f8fafc);
  color: var(--learn-text, #1f2937);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease,
    background 0.15s ease;
}

.learn-picker__trigger:hover {
  border-color: var(--learn-accent, #667eea);
}

.learn-picker__trigger:focus-visible,
.learn-picker--open .learn-picker__trigger {
  border-color: var(--learn-accent, #667eea);
  box-shadow: 0 0 0 3px var(--learn-accent-soft, rgba(102, 126, 234, 0.12));
  outline: none;
}

.learn-picker__text {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.learn-picker__label {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.learn-picker__label.is-placeholder {
  font-weight: 400;
  color: var(--learn-text-faint, #9ca3af);
}

.learn-picker__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 11px;
  color: var(--learn-text-faint, #9ca3af);
}

.learn-picker__channel {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.learn-picker__chevron {
  flex: 0 0 auto;
  color: var(--learn-text-faint, #9ca3af);
  transition: transform 0.2s ease;
}

.learn-picker--open .learn-picker__chevron {
  transform: rotate(180deg);
}

/* ──── 展开列表 ──── */
.learn-picker__panel {
  display: grid;
  grid-template-rows: 1fr;
  min-width: 0;
  transition:
    grid-template-rows 0.22s ease,
    opacity 0.16s ease;
}

.learn-picker__panel-inner {
  min-height: 0;
  overflow: hidden;
}

.learn-picker__list {
  list-style: none;
  margin: 0;
  padding: 5px;
  max-height: 190px;
  overflow-y: auto;
  border: 1px solid var(--learn-border, #e5e7eb);
  border-radius: 10px;
  background: var(--learn-bg, #ffffff);
  scrollbar-width: thin;
}

.learn-picker__item + .learn-picker__item {
  margin-top: 2px;
}

.learn-picker__option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 7px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--learn-text, #1f2937);
  font-family: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease;
}

.learn-picker__option:hover {
  background: var(--learn-surface-hover, #f1f5f9);
}

.learn-picker__option:focus-visible {
  outline: 2px solid var(--learn-accent, #667eea);
  outline-offset: -2px;
}

.learn-picker__option[aria-selected='true'] {
  background: var(--learn-accent-soft, rgba(102, 126, 234, 0.12));
}

.learn-picker__option-text {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.learn-picker__option-label {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.learn-picker__option-channel {
  font-size: 11px;
  color: var(--learn-text-faint, #9ca3af);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.learn-picker__check {
  flex: 0 0 auto;
  color: var(--learn-accent, #667eea);
}

/* ──── 视觉徽标 ──── */
.learn-picker__badge {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--learn-accent-soft, rgba(102, 126, 234, 0.12));
  color: var(--learn-accent-deep, #4f46e5);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.6;
}

/* 展开/收起动画：grid-template-rows 0fr ↔ 1fr */
.learn-picker-enter-active,
.learn-picker-leave-active {
  transition:
    grid-template-rows 0.22s ease,
    opacity 0.16s ease;
}

.learn-picker-enter-from,
.learn-picker-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
}
</style>
