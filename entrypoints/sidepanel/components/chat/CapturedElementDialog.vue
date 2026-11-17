<!--
  捕获元素详情弹窗

  内容：元素完整截图预览（低分辨率存储的原图）、唯一选择器 / XPath / frameId、
  可读描述、用户备注编辑。保存只提交备注，选择器与截图保持捕获时刻事实。
-->
<template>
  <div v-if="element" class="ced-overlay" @click.self="requestClose">
    <div class="ced-dialog" role="dialog" aria-modal="true" :aria-label="t('sidepanel.elementCapture.detailTitle')">
      <header class="ced-header">
        <span class="ced-header-icon" aria-hidden="true">
          <ElementTypeIcon :kind="element.kind" :size="16" />
        </span>
        <div class="ced-header-main">
          <div class="ced-title">{{ t('sidepanel.elementCapture.detailTitle') }}</div>
          <div class="ced-subtitle" :title="element.description">{{ element.description }}</div>
        </div>
        <button
          type="button"
          class="ced-close"
          :aria-label="t('sidepanel.elementCapture.cancel')"
          :title="t('sidepanel.elementCapture.cancel')"
          @click="requestClose"
        >
          <X :size="15" :stroke-width="2.2" />
        </button>
      </header>

      <div class="ced-preview">
        <img v-if="screenshotUrl" :src="screenshotUrl" :alt="element.description" />
        <div v-else class="ced-preview-empty">
          <ElementTypeIcon :kind="element.kind" :size="26" />
          <span>{{ t('sidepanel.elementCapture.noPreview') }}</span>
        </div>
      </div>

      <div class="ced-meta">
        <div class="ced-meta-row">
          <span class="ced-meta-label">{{ t('sidepanel.elementCapture.selectorLabel') }}</span>
          <code class="ced-meta-value">{{ element.selector }}</code>
        </div>
        <div v-if="element.xpath" class="ced-meta-row">
          <span class="ced-meta-label">XPath</span>
          <code class="ced-meta-value">{{ element.xpath }}</code>
        </div>
        <div v-if="element.shadowHosts?.length" class="ced-meta-row">
          <span class="ced-meta-label">Shadow</span>
          <code class="ced-meta-value">{{ element.shadowHosts.join(' > ') }}</code>
        </div>
        <div class="ced-meta-row">
          <span class="ced-meta-label">{{ t('sidepanel.elementCapture.frameLabel') }}</span>
          <span class="ced-meta-value">{{ element.frameId }}</span>
        </div>
        <div v-if="element.pageUrl" class="ced-meta-row">
          <span class="ced-meta-label">{{ t('sidepanel.elementCapture.pageLabel') }}</span>
          <span class="ced-meta-value" :title="element.pageUrl">{{ element.pageUrl }}</span>
        </div>
      </div>

      <label class="ced-note">
        <span class="ced-note-label">{{ t('sidepanel.elementCapture.noteLabel') }}</span>
        <textarea
          v-model="noteDraft"
          class="ced-note-input"
          :maxlength="NOTE_MAX_CHARS"
          :placeholder="t('sidepanel.elementCapture.notePlaceholder')"
          rows="3"
        ></textarea>
        <span class="ced-note-counter">{{ noteDraft.length }} / {{ NOTE_MAX_CHARS }}</span>
      </label>

      <footer class="ced-footer">
        <button type="button" class="ced-btn" :disabled="busy" @click="requestClose">
          {{ t('sidepanel.elementCapture.cancel') }}
        </button>
        <button type="button" class="ced-btn ced-btn-primary" :disabled="busy" @click="save">
          {{ busy ? t('sidepanel.elementCapture.saving') : t('sidepanel.elementCapture.save') }}
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { X } from 'lucide-vue-next';
import { t } from '@/utils/i18n';
import {
  CAPTURED_ELEMENT_NOTE_MAX_CHARS,
  type CapturedElement,
} from '@/utils/element-capture/types';
import { imageStore } from '../../core/images/image-store';
import ElementTypeIcon from './ElementTypeIcon.vue';

const props = withDefaults(
  defineProps<{
    element: CapturedElement | null;
    busy?: boolean;
  }>(),
  { busy: false },
);

const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'save', payload: { id: string; note: string }): void;
}>();

const NOTE_MAX_CHARS = CAPTURED_ELEMENT_NOTE_MAX_CHARS;
const noteDraft = ref('');
const screenshotUrl = ref('');
let disposed = false;

watch(
  () => props.element,
  async element => {
    noteDraft.value = element?.note || '';
    screenshotUrl.value = '';
    if (!element?.screenshotRef) return;
    try {
      const url = await imageStore.getObjectUrl(element.screenshotRef);
      if (!disposed && props.element?.id === element.id) {
        screenshotUrl.value = url || '';
      }
    } catch {
      screenshotUrl.value = '';
    }
  },
  { immediate: true },
);

function requestClose(): void {
  if (props.busy) return;
  emit('close');
}

function save(): void {
  const element = props.element;
  if (!element || props.busy) return;
  emit('save', { id: element.id, note: noteDraft.value.trim() });
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.element) {
    event.preventDefault();
    requestClose();
  }
}

onMounted(() => window.addEventListener('keydown', onKeyDown, true));
onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener('keydown', onKeyDown, true);
});
</script>

<style scoped>
.ced-overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.46);
  backdrop-filter: blur(1.5px);
}

.ced-dialog {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(420px, 100%);
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  padding: 14px;
  border-radius: 12px;
  background: var(--panel-bg, #ffffff);
  color: var(--text-color, #1f2328);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
}

.ced-header {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.ced-header-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: rgba(59, 130, 246, 0.12);
  color: #3b82f6;
  flex: 0 0 auto;
}

.ced-header-main {
  flex: 1;
  min-width: 0;
}

.ced-title {
  font-size: 13px;
  font-weight: 600;
}

.ced-subtitle {
  margin-top: 2px;
  font-size: 11px;
  color: var(--secondary-text-color, #6b7280);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ced-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--secondary-text-color, #6b7280);
  cursor: pointer;
}

.ced-close:hover {
  background: rgba(127, 127, 127, 0.14);
}

.ced-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  max-height: 260px;
  overflow: hidden;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(127, 127, 127, 0.2));
  background:
    linear-gradient(45deg, rgba(127, 127, 127, 0.06) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(127, 127, 127, 0.06) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(127, 127, 127, 0.06) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(127, 127, 127, 0.06) 75%);
  background-size: 12px 12px;
  background-position: 0 0, 0 6px, 6px -6px, -6px 0;
}

.ced-preview img {
  display: block;
  max-width: 100%;
  max-height: 258px;
  object-fit: contain;
}

.ced-preview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--secondary-text-color, #6b7280);
}

.ced-meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-radius: 8px;
  background: rgba(127, 127, 127, 0.07);
}

.ced-meta-row {
  display: flex;
  gap: 8px;
  font-size: 11px;
  line-height: 1.5;
}

.ced-meta-label {
  flex: 0 0 56px;
  color: var(--secondary-text-color, #6b7280);
}

.ced-meta-value {
  flex: 1;
  min-width: 0;
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10.5px;
}

.ced-note {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ced-note-label {
  font-size: 11px;
  color: var(--secondary-text-color, #6b7280);
}

.ced-note-input {
  width: 100%;
  resize: vertical;
  min-height: 62px;
  padding: 7px 8px 18px;
  border-radius: 8px;
  border: 1px solid var(--border-color, rgba(127, 127, 127, 0.26));
  background: var(--input-bg, transparent);
  color: inherit;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  outline: none;
}

.ced-note-input:focus {
  border-color: var(--accent-color, #3b82f6);
}

.ced-note-counter {
  position: absolute;
  right: 8px;
  bottom: 5px;
  font-size: 9.5px;
  color: var(--secondary-text-color, #9ca3af);
  pointer-events: none;
}

.ced-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.ced-btn {
  border: 0;
  border-radius: 7px;
  padding: 6px 14px;
  font-size: 12px;
  cursor: pointer;
  background: rgba(127, 127, 127, 0.16);
  color: inherit;
}

.ced-btn:hover:not(:disabled) {
  background: rgba(127, 127, 127, 0.24);
}

.ced-btn-primary {
  background: #3b82f6;
  color: #fff;
}

.ced-btn-primary:hover:not(:disabled) {
  background: #2f6fdd;
}

.ced-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
