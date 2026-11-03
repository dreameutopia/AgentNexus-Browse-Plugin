<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="modal-overlay"
      role="presentation"
      @click.self="handleCancel"
      @keydown.esc.stop.prevent="handleCancel"
    >
      <div class="modal-card" role="alertdialog" aria-modal="true" :aria-label="title">
        <div class="modal-icon" :class="{ danger }">
          <TriangleAlert v-if="danger" :size="20" />
          <Info v-else :size="20" />
        </div>
        <h3 class="modal-title">{{ title }}</h3>
        <p v-if="message" class="modal-message">{{ message }}</p>
        <div class="modal-actions">
          <button
            ref="cancelRef"
            class="modal-btn modal-btn-ghost"
            type="button"
            @click="handleCancel"
          >
            {{ cancelText }}
          </button>
          <button
            class="modal-btn"
            :class="danger ? 'modal-btn-danger' : 'modal-btn-primary'"
            type="button"
            :disabled="busy"
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
import { TriangleAlert, Info } from 'lucide-vue-next';

/**
 * 通用二次确认弹窗（危险操作统一入口，替代原生 confirm()）。
 * - 打开时聚焦「取消」按钮：破坏性操作下误按回车不会直接执行；
 * - ESC / 点击遮罩 = 取消（keydown.stop 阻止冒泡到页面级 Esc 返回列表）。
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    message?: string;
    confirmText: string;
    cancelText: string;
    danger?: boolean;
    busy?: boolean;
    busyText?: string;
  }>(),
  {
    message: '',
    danger: false,
    busy: false,
    busyText: '',
  },
);

const emit = defineEmits<{
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}>();

const cancelRef = ref<HTMLButtonElement | null>(null);

watch(
  () => props.open,
  (open) => {
    if (open) void nextTick(() => cancelRef.value?.focus());
  },
);

function handleConfirm(): void {
  if (props.busy) return;
  emit('confirm');
}

function handleCancel(): void {
  if (props.busy) return;
  emit('cancel');
}
</script>
