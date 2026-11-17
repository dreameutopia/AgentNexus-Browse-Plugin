<!--
  捕获元素 chip 列表（输入区待发送 / 用户消息气泡下方共用）

  口径：
  - 单行横向排布（超出横向滚动，不换行）；
  - 每个 chip：截图预览（与图标同高）→ 元素类型 SVG → 唯一定位标签（截断）
    → 可选叉号（仅输入区待发送态允许取消选中）；
  - 点击 chip 打开元素详情弹窗（查看大图 / 编辑备注）；
  - 悬浮 / 聚焦 chip 时在 chip 上方或下方浮出「校验元素」按钮（Teleport 到
    body，避免被列表的横向滚动容器裁剪）。
-->
<template>
  <div v-if="elements.length > 0" class="captured-element-list" role="list">
    <button
      v-for="element in elements"
      :key="element.id"
      type="button"
      class="captured-element-chip"
      :class="{ 'has-note': !!element.note }"
      role="listitem"
      :title="chipTitle(element)"
      @click="emit('open', element)"
      @mouseenter="showValidate(element, $event)"
      @mouseleave="scheduleHideValidate"
      @focus="showValidate(element, $event)"
      @blur="scheduleHideValidate"
    >
      <span class="cec-thumb" aria-hidden="true">
        <img v-if="thumbnails[element.id]" :src="thumbnails[element.id]" alt="" />
        <span v-else class="cec-thumb-fallback">
          <ElementTypeIcon :kind="element.kind" :size="11" />
        </span>
      </span>
      <span class="cec-icon" aria-hidden="true">
        <ElementTypeIcon :kind="element.kind" :size="13" />
      </span>
      <span class="cec-label">{{ locatorLabel(element) }}</span>
      <span v-if="element.note" class="cec-note-dot" aria-hidden="true"></span>
      <span
        v-if="removable"
        class="cec-remove"
        role="button"
        tabindex="0"
        :aria-label="t('sidepanel.elementCapture.remove')"
        :title="t('sidepanel.elementCapture.remove')"
        @click.stop="emit('remove', element.id)"
        @keydown.enter.stop.prevent="emit('remove', element.id)"
        @keydown.space.stop.prevent="emit('remove', element.id)"
      >
        <X :size="12" :stroke-width="2.2" />
      </span>
    </button>
  </div>

  <!-- 校验按钮：独立浮层，跟随 chip 位置，避免被横向滚动容器裁剪 -->
  <Teleport to="body">
    <Transition name="cec-validate">
      <button
        v-if="validateAnchor"
        ref="validateButton"
        type="button"
        class="cec-validate-float"
        :class="{ 'is-above': validateAnchor.above }"
        :style="{ left: `${validateAnchor.left}px`, top: `${validateAnchor.top}px` }"
        :title="t('sidepanel.elementCapture.validateAction')"
        @mouseenter="cancelHideValidate"
        @mouseleave="scheduleHideValidate"
        @click.stop="handleValidateClick"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12,2A10,10 0 1,0 22,12A10,10 0 0,0 12,2M12,10A2,2 0 1,1 10,12A2,2 0 0,1 12,10M11,3H13V7.1A7,7 0 0,1 16.9,11H21V13H16.9A7,7 0 0,1 13,16.9V21H11V16.9A7,7 0 0,1 7.1,13H3V11H7.1A7,7 0 0,1 11,7.1V3Z"
            fill="currentColor"
          />
        </svg>
        <span>{{ t('sidepanel.elementCapture.validateAction') }}</span>
      </button>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { X } from 'lucide-vue-next';
import { t } from '@/utils/i18n';
import type { CapturedElement } from '@/utils/element-capture/types';
import { imageStore } from '../../core/images/image-store';
import ElementTypeIcon from './ElementTypeIcon.vue';

const props = withDefaults(
  defineProps<{
    elements: CapturedElement[];
    removable?: boolean;
    /** 校验按钮相对 chip 的浮出方向（输入区在上、消息区在下） */
    validatePlacement?: 'above' | 'below';
  }>(),
  { removable: false, validatePlacement: 'above' },
);

const emit = defineEmits<{
  (event: 'open', element: CapturedElement): void;
  (event: 'remove', id: string): void;
  (event: 'validate', element: CapturedElement): void;
}>();

const thumbnails = reactive<Record<string, string>>({});
let disposed = false;

interface ValidateAnchor {
  id: string;
  left: number;
  top: number;
  above: boolean;
}

const validateAnchor = ref<ValidateAnchor | null>(null);
const validateButton = ref<HTMLButtonElement | null>(null);
let validateTarget: CapturedElement | null = null;
let anchorElement: HTMLElement | null = null;
let hideTimer: ReturnType<typeof window.setTimeout> | null = null;

function locatorLabel(element: CapturedElement): string {
  // 展示口径：id 选择器 > XPath > CSS 路径（完整值见 tooltip / 详情弹窗）
  const raw = element.selector.startsWith('#')
    ? element.selector
    : element.xpath || element.selector || element.shadowHosts?.join(' > ') || '';
  const compact = raw.replace(/\s*>\s*/g, ' > ');
  const maxChars = 34;
  return compact.length > maxChars ? `${compact.slice(0, maxChars)}…` : compact;
}

function chipTitle(element: CapturedElement): string {
  const parts = [element.description || element.tagName, element.selector];
  if (element.frameId > 0) parts.push(`frame ${element.frameId}`);
  if (element.note) parts.push(`${t('sidepanel.elementCapture.noteLabel')}: ${element.note}`);
  return parts.filter(Boolean).join('\n');
}

function cancelHideValidate(): void {
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function hideValidate(): void {
  cancelHideValidate();
  validateAnchor.value = null;
  validateTarget = null;
  anchorElement = null;
}

function scheduleHideValidate(): void {
  cancelHideValidate();
  hideTimer = window.setTimeout(() => {
    hideTimer = null;
    hideValidate();
  }, 180);
}

/** 依据锚点 chip 的当前矩形重算浮层位置（滚动 / 尺寸变化时跟随） */
function updateValidatePosition(): void {
  const anchor = anchorElement;
  const element = validateTarget;
  if (!anchor || !element) return;
  if (!anchor.isConnected) {
    hideValidate();
    return;
  }

  const rect = anchor.getBoundingClientRect();
  const width = validateButton.value?.offsetWidth ?? 96;
  const viewport = document.documentElement.clientWidth || window.innerWidth;
  const center = rect.left + rect.width / 2;
  const left = Math.max(6 + width / 2, Math.min(center, viewport - width / 2 - 6));
  const above = props.validatePlacement === 'above';
  const top = above ? rect.top - 6 : rect.bottom + 6;

  validateAnchor.value = { id: element.id, left, top, above };
}

function showValidate(element: CapturedElement, event: Event): void {
  const anchor = event.currentTarget;
  if (!(anchor instanceof HTMLElement)) return;
  cancelHideValidate();
  validateTarget = element;
  anchorElement = anchor;
  updateValidatePosition();
  void nextTick(() => updateValidatePosition());
}

function handleValidateClick(): void {
  const element = validateTarget;
  hideValidate();
  if (element) emit('validate', element);
}

const reposition = (): void => {
  if (validateAnchor.value) updateValidatePosition();
};

watch(
  () => props.elements.map(element => element.id).join('|'),
  () => {
    // 列表变化（删除 / 切换会话）后锚点可能已失效，直接收起浮层
    if (validateAnchor.value) hideValidate();
  },
);

watch(
  () => props.elements.map(element => `${element.id}:${element.screenshotRef || ''}`).join('|'),
  async () => {
    for (const element of props.elements) {
      const ref = element.screenshotRef;
      if (!ref || thumbnails[element.id]) continue;
      try {
        const url = await imageStore.getObjectUrl(ref);
        if (disposed) return;
        if (url) thumbnails[element.id] = url;
      } catch {
        // 缩略图加载失败：保留类型图标占位，不影响元素操作
      }
    }
  },
  { immediate: true },
);

onMounted(() => {
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
});

onBeforeUnmount(() => {
  disposed = true;
  hideValidate();
  window.removeEventListener('scroll', reposition, true);
  window.removeEventListener('resize', reposition);
});
</script>

<style scoped>
.captured-element-list {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  max-width: 100%;
  padding: 2px 1px 4px;
  scrollbar-width: thin;
}

.captured-element-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  max-width: 240px;
  height: 26px;
  padding: 0 4px 0 3px;
  border-radius: 7px;
  border: 1px solid var(--border-color, rgba(127, 127, 127, 0.22));
  background: var(--input-bg, rgba(127, 127, 127, 0.08));
  color: var(--text-color, inherit);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.captured-element-chip:hover {
  background: var(--item-hover-bg, rgba(127, 127, 127, 0.14));
  border-color: var(--accent-color, #3b82f6);
}

.cec-thumb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  overflow: hidden;
  flex: 0 0 auto;
  background: rgba(127, 127, 127, 0.14);
}

.cec-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.cec-thumb-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--secondary-text-color, #8a8a8a);
}

.cec-icon {
  display: inline-flex;
  align-items: center;
  color: var(--secondary-text-color, #8a8a8a);
  flex: 0 0 auto;
}

.cec-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10.5px;
  color: var(--text-color, inherit);
}

.cec-note-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent-color, #3b82f6);
  flex: 0 0 auto;
}

.cec-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  color: var(--secondary-text-color, #8a8a8a);
  flex: 0 0 auto;
  cursor: pointer;
}

.cec-remove:hover {
  background: rgba(239, 68, 68, 0.16);
  color: #ef4444;
}

/* 校验浮层（Teleport 到 body）：默认位于 chip 上方 */
.cec-validate-float {
  position: fixed;
  z-index: 10900;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transform: translate(-50%, -100%);
  padding: 5px 10px;
  border: 1px solid var(--border-color, rgba(127, 127, 127, 0.24));
  border-radius: 999px;
  background: var(--bg-primary, #ffffff);
  color: var(--text-color, #1f2937);
  font: 500 11px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: 0 6px 18px rgba(15, 23, 42, 0.16);
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.cec-validate-float.is-above {
  transform: translate(-50%, -100%);
}

.cec-validate-float:not(.is-above) {
  transform: translate(-50%, 0);
}

.cec-validate-float:hover {
  border-color: var(--accent-color, #3b82f6);
  color: var(--accent-color, #3b82f6);
}

.cec-validate-float svg {
  flex: 0 0 auto;
}

.cec-validate-enter-active,
.cec-validate-leave-active {
  transition: opacity 0.14s ease, transform 0.14s ease;
}

.cec-validate-enter-from,
.cec-validate-leave-to {
  opacity: 0;
}
</style>
