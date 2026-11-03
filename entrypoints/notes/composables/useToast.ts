/**
 * Toast 通知 composable
 */
import { ref } from 'vue';

export interface ToastItem {
  id: number;
  message: string;
  type: 'success' | 'error';
}

const toasts = ref<ToastItem[]>([]);
let toastId = 0;

export function useToast() {
  function showToast(message: string, type: 'success' | 'error' = 'success') {
    const id = ++toastId;
    toasts.value.push({ id, message, type });

    setTimeout(() => {
      removeToast(id);
    }, 3000);
  }

  function removeToast(id: number) {
    const index = toasts.value.findIndex((t) => t.id === id);
    if (index !== -1) {
      toasts.value.splice(index, 1);
    }
  }

  return {
    toasts,
    showToast,
    removeToast,
  };
}
