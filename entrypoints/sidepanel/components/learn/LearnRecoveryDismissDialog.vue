<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue';
import { t } from '@/utils/i18n';
import './learn-theme.css';

const props = defineProps<{ visible: boolean; busy: boolean; error: string }>();
const emit = defineEmits<{ cancel: []; confirm: [] }>();
const panel = ref<HTMLElement | null>(null);
const cancelButton = ref<HTMLButtonElement | null>(null);
let previousFocus: HTMLElement | null = null;
let focusEpoch = 0;
function restoreFocus() { if (previousFocus?.isConnected) previousFocus.focus(); previousFocus = null; }
watch(() => props.visible, async visible => {
  const epoch = ++focusEpoch;
  if (!visible) { document.removeEventListener('keydown', keydown, true); restoreFocus(); return; }
  document.addEventListener('keydown', keydown, true);
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await nextTick();
  if (props.visible && epoch === focusEpoch) cancelButton.value?.focus();
}, { flush: 'post', immediate: true });
function keydown(event: KeyboardEvent) {
  if (!props.visible) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!props.busy) emit('cancel'); }
  if (event.key !== 'Tab') return;
  const buttons = Array.from(panel.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
  if (!buttons.length) { event.preventDefault(); panel.value?.focus(); return; }
  const first = buttons[0], last = buttons[buttons.length - 1];
  if (event.shiftKey && (document.activeElement === first || !buttons.includes(document.activeElement as HTMLButtonElement))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || !buttons.includes(document.activeElement as HTMLButtonElement))) { event.preventDefault(); first.focus(); }
}
onUnmounted(() => { focusEpoch++; document.removeEventListener('keydown', keydown, true); restoreFocus(); });
</script>

<template>
  <Teleport to="body">
    <Transition name="learn-dismiss">
      <div v-if="visible" class="learn-dismiss-overlay learn-root" @click.self="!busy && emit('cancel')">
        <section ref="panel" class="learn-dismiss-panel learn-panel" role="alertdialog" aria-modal="true" aria-labelledby="learn-dismiss-title" aria-describedby="learn-dismiss-description" :aria-busy="busy" tabindex="-1">
          <header class="learn-dismiss-header">
            <span class="learn-dismiss-icon" aria-hidden="true">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5H5v14h14v-4M9 5V3h12v12h-2M9 5h10v10M8 10h7M8 14h5" /></svg>
            </span>
            <h3 id="learn-dismiss-title">{{ t('sidepanel.learn.ignoreTitle') }}</h3>
          </header>
          <div class="learn-dismiss-body">
            <p id="learn-dismiss-description">{{ t('sidepanel.learn.ignoreBody') }}</p>
            <p class="learn-dismiss-detail">{{ t('sidepanel.learn.ignorePreserves') }}</p>
            <p v-if="error" class="learn-dismiss-error" role="alert">{{ t('sidepanel.learn.ignoreFailed') }}</p>
          </div>
          <footer class="learn-dismiss-footer">
            <button ref="cancelButton" type="button" class="learn-btn learn-btn--ghost" :disabled="busy" @click="emit('cancel')">{{ t('sidepanel.learn.ignoreCancel') }}</button>
            <button type="button" class="learn-btn learn-btn--primary" :disabled="busy" @click="emit('confirm')">{{ busy ? t('sidepanel.learn.ignoreSaving') : t('sidepanel.learn.ignoreConfirm') }}</button>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.learn-dismiss-overlay { position: fixed; inset: 0; z-index: 960; display: flex; align-items: center; justify-content: center; padding: 20px; background: var(--learn-scrim); }
.learn-dismiss-panel { width: min(420px, 100%); min-width: 0; max-height: 100%; overflow-y: auto; }
.learn-dismiss-header { display: flex; align-items: center; gap: 10px; padding: 20px 20px 0; }
.learn-dismiss-header h3 { margin: 0; font-size: 15px; line-height: 1.5; overflow-wrap: anywhere; }
.learn-dismiss-icon { flex: 0 0 auto; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; color: var(--learn-text-muted); background: var(--learn-surface); }
.learn-dismiss-body { padding: 12px 20px 0; font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; }
.learn-dismiss-body p { margin: 0 0 8px; }
.learn-dismiss-detail { color: var(--learn-text-muted); font-size: 12px; }
.learn-dismiss-error { color: var(--learn-danger); }
.learn-dismiss-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px 20px; }
.learn-dismiss-enter-active, .learn-dismiss-leave-active { transition: opacity .15s ease; }
.learn-dismiss-enter-from, .learn-dismiss-leave-to { opacity: 0; }
@media (max-width: 480px) { .learn-dismiss-footer { flex-direction: column; } .learn-dismiss-footer .learn-btn { width: 100%; font-size: 12px; } }
</style>
