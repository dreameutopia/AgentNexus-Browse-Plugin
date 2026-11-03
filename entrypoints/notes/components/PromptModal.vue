<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="modal-overlay"
      role="presentation"
      @click.self="handleCancel"
      @keydown.esc.stop.prevent="handleCancel"
    >
      <div class="modal-card" role="dialog" aria-modal="true" :aria-label="title">
        <h3 class="modal-title">{{ title }}</h3>
        <label v-if="label" class="modal-label" for="notes-prompt-modal-input">{{ label }}</label>
        <input
          id="notes-prompt-modal-input"
          ref="inputRef"
          v-model="value"
          class="modal-input"
          type="text"
          :placeholder="placeholder"
          :maxlength="maxLength"
          @keydown.enter.prevent="handleConfirm"
        />
        <div class="modal-actions">
          <button class="modal-btn modal-btn-ghost" type="button" @click="handleCancel">
            {{ cancelText }}
          </button>
          <button
            class="modal-btn modal-btn-primary"
            type="button"
            :disabled="busy || (!allowEmpty && !value.trim())"
            @click="handleConfirm"
          >
            {{ busy ? busyText : confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

/**
 * 通用单输入弹窗（重命名等场景，替代原生 prompt()）。
 * - 打开时回填初始值并全选，直接输入即可覆盖；
 * - 空白值禁用确认；ESC / 点击遮罩 = 取消。
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    label?: string;
    placeholder?: string;
    initialValue?: string;
    confirmText: string;
    cancelText: string;
    maxLength?: number;
    /** 允许空值确认（如「留空移除链接」）；默认空值禁用确认 */
    allowEmpty?: boolean;
    busy?: boolean;
    busyText?: string;
  }>(),
  {
    label: '',
    placeholder: '',
    initialValue: '',
    maxLength: 50,
    allowEmpty: false,
    busy: false,
    busyText: '',
  },
);

const emit = defineEmits<{
  (e: 'confirm', value: string): void;
  (e: 'cancel'): void;
}>();

const inputRef = ref<HTMLInputElement | null>(null);
const value = ref('');

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    value.value = props.initialValue;
    void nextTick(() => {
      inputRef.value?.focus();
      inputRef.value?.select();
    });
  },
);

function handleConfirm(): void {
  if (props.busy) return;
  const next = value.value.trim();
  if (!props.allowEmpty && !next) return;
  emit('confirm', next);
}

function handleCancel(): void {
  if (props.busy) return;
  emit('cancel');
}
</script>
