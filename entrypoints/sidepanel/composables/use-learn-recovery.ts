import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue';
import { dismissLearnRecovery, readLearnRecovery, watchLearnDrafts, type LearnRecoveryStatus } from '@/utils/learn/learn-draft-store';
import type { SkillDraft } from '@/utils/learn/learn-types';

export interface LearnRecoverySource { chatId: string; draft: SkillDraft }

/** Sidepanel projection of durable receipts; raw transcript/memory drafts remain recovery copies. */
export function useLearnRecovery(source: Readonly<Ref<LearnRecoverySource | null>>) {
  const status = ref<LearnRecoveryStatus | 'checking'>('checking');
  const syncError = ref('');
  const dismissError = ref('');
  const confirming = ref(false);
  const busy = ref(false);
  const visible = computed(() => !!source.value && status.value === 'available');
  let target: LearnRecoverySource | null = null;
  let generation = 0;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;

  function closeDialog() { confirming.value = false; target = null; dismissError.value = ''; }
  async function refresh(): Promise<boolean> {
    const ticket = ++generation, current = source.value;
    if (!current) { status.value = 'checking'; syncError.value = ''; return false; }
    const result = await readLearnRecovery(current.draft, current.chatId);
    if (disposed || ticket !== generation || source.value !== current) return false;
    // Read failure must not hide the only downloadable memory/transcript copy.
    status.value = result.ok ? result.status : status.value === 'saved' || status.value === 'ignored' ? status.value : 'available';
    syncError.value = result.ok ? '' : result.error;
    if (result.ok && result.status !== 'available') closeDialog();
    return result.ok && result.status === 'available';
  }
  watch(source, () => {
    status.value = 'checking'; syncError.value = ''; closeDialog();
    void refresh();
  }, { immediate: true, flush: 'sync' });

  function requestDismiss() {
    if (!visible.value || busy.value) return;
    target = source.value; dismissError.value = ''; confirming.value = true;
  }
  function cancelDismiss() { if (!busy.value) closeDialog(); }
  async function confirmDismiss() {
    const current = target;
    if (!confirming.value || !current || current !== source.value || busy.value) return;
    busy.value = true; dismissError.value = '';
    try {
      const result = await dismissLearnRecovery(current.draft, current.chatId);
      if (disposed) return;
      if (!result.ok) { if (source.value === current && confirming.value) dismissError.value = result.error; return; }
      if (source.value === current) { status.value = 'ignored'; closeDialog(); }
      await refresh();
    } finally { if (!disposed) busy.value = false; }
  }
  /** Fresh preflight before creating/navigating; never reopen a completed/ignored receipt. */
  async function canCreate(current: LearnRecoverySource): Promise<boolean> {
    if (disposed || source.value !== current || busy.value || confirming.value) return false;
    const available = await refresh();
    return available && source.value === current && !busy.value && !confirming.value;
  }
  const onFocus = () => { void refresh(); };
  const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
  onMounted(() => {
    unsubscribe = watchLearnDrafts(onFocus);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    void refresh(); // Covers the gap between initial read and listener registration.
  });
  onUnmounted(() => {
    disposed = true; generation++;
    unsubscribe?.();
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibility);
  });
  return { visible, status, syncError, dismissError, confirming, busy, requestDismiss, cancelDismiss, confirmDismiss, canCreate, refresh };
}
