<template>
  <transition name="pc-notice">
    <div
      v-if="notice"
      class="pc-notice"
      :class="`is-${notice.tone}`"
      :role="notice.tone === 'error' ? 'alert' : 'status'"
    >
      <CheckCircle
        v-if="notice.tone !== 'error'"
        :size="15"
        class="pc-notice__icon"
        aria-hidden="true"
      />
      <AlertCircle v-else :size="15" class="pc-notice__icon" aria-hidden="true" />
      <span class="pc-notice__text">{{ notice.text }}</span>
      <button
        type="button"
        class="pc-notice__close"
        :aria-label="t('common.close')"
        @click="emit('dismiss')"
      >
        <X :size="13" aria-hidden="true" />
      </button>
    </div>
  </transition>
</template>

<script setup lang="ts">
/**
 * 插件中心提示条：成功（绿调、可自动消失）与错误（红调、保留至手动关闭）
 * 两种语气共用一条气泡；关闭动作交由父级处理（计时器也在状态层）。
 */
import { AlertCircle, CheckCircle, X } from 'lucide-vue-next';
import { t } from '@/utils/i18n';

defineProps<{
  notice: { text: string; tone: 'ok' | 'error' } | null;
}>();

const emit = defineEmits<{ dismiss: [] }>();
</script>
