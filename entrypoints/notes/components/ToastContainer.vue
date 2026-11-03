<template>
  <Teleport to="body">
    <div class="toast-container">
      <TransitionGroup name="toast">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="toast-item"
          :class="`toast-${toast.type}`"
        >
          <CheckCircle v-if="toast.type === 'success'" class="toast-icon" :size="16" />
          <XCircle v-else class="toast-icon" :size="16" />
          <span>{{ toast.message }}</span>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { CheckCircle, XCircle } from 'lucide-vue-next';
import type { ToastItem } from '../composables/useToast';

defineProps<{
  toasts: ToastItem[];
}>();
</script>
