<template>
  <section v-if="visible && ready && !hidden && dismissed !== scopeKey" class="skill-practice-card" aria-live="polite">
    <!-- 图标与标题同行（不再单占左栏）：左下空白消失，正文与按钮可整行铺开 -->
    <div class="skill-practice-head">
      <span class="skill-practice-icon" aria-hidden="true"><SkillIcon /></span>
      <strong class="skill-practice-title">{{ t('sidepanel.chat.skillCaptureTitle') }}</strong>
    </div>
    <p class="skill-practice-intro">{{ t('sidepanel.chat.skillCaptureIntro') }}</p>
    <div class="skill-practice-actions">
      <button type="button" class="skill-practice-primary" :disabled="disabled" @click="open(messageId)">{{ t('sidepanel.chat.skillCaptureCreate') }}</button>
      <button type="button" @click="dismissed = scopeKey">{{ t('sidepanel.chat.skillCaptureLater') }}</button>
      <button type="button" class="skill-practice-quiet" @click="openHide">{{ t('sidepanel.chat.skillCaptureHide') }}</button>
    </div>
  </section>
  <Teleport to="body">
    <div v-if="mode" class="skill-capture-backdrop" @click.self="close" @keydown.esc.stop.prevent="close">
      <section ref="dialog" class="skill-capture-dialog" role="dialog" aria-modal="true" :aria-label="t(mode === 'hide' ? 'sidepanel.chat.skillCaptureHideTitle' : 'sidepanel.chat.skillCaptureConfirmTitle')" tabindex="-1" @keydown.tab="trapFocus">
        <div class="skill-capture-dialog-top"><span class="skill-capture-dialog-mark" aria-hidden="true"><SkillIcon width="23" height="23" /></span><h3>{{ t(mode === 'hide' ? 'sidepanel.chat.skillCaptureHideTitle' : 'sidepanel.chat.skillCaptureConfirmTitle') }}</h3></div>
        <p>{{ t(mode === 'hide' ? 'sidepanel.chat.skillCaptureHideBody' : 'sidepanel.chat.skillCaptureConfirmBody') }}</p>
        <label v-if="mode === 'create'" class="skill-capture-field">{{ t('sidepanel.chat.skillCaptureExtraLabel') }}<textarea ref="textarea" v-model="extra" maxlength="3000" rows="4" :placeholder="t('sidepanel.chat.skillCaptureExtraPlaceholder')" /></label>
        <p v-if="error" class="skill-capture-error" role="alert">{{ error }}</p>
        <footer><button type="button" :disabled="saving" @click="close">{{ t('sidepanel.chat.skillCancel') }}</button><button type="button" class="skill-practice-primary" :disabled="saving || disabled" @click="confirm">{{ t(mode === 'hide' ? 'sidepanel.chat.skillCaptureHideConfirm' : 'sidepanel.chat.skillCaptureSend') }}</button></footer>
      </section>
    </div>
  </Teleport>
</template>
<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { t } from '@/utils/i18n';
import SkillIcon from './SkillIcon.vue';
const props = defineProps<{
    visible: boolean;
    messageId?: string;
    scopeKey: string;
    disabled: boolean;
}>();
const emit = defineEmits<{
    create: [
        request: {
            messageId: string;
            extra: string;
        }
    ];
}>();
const KEY = 'agentNexusSkillCaptureHidden';
const hidden = ref(false), ready = ref(false), mode = ref<'create' | 'hide' | null>(null), dismissed = ref(''), extra = ref(''), error = ref(''), saving = ref(false);
const dialog = ref<HTMLElement | null>(null), textarea = ref<HTMLTextAreaElement | null>(null);
let disposed = false, preferenceRevision = 0, dialogRevision = 0;
let sourceId = '', returnFocus: HTMLElement | null = null;
const close = () => { if (saving.value)
    return; mode.value = null; returnFocus?.focus(); };
const open = (messageId?: string) => { if (saving.value || props.disabled || !messageId)
    return; sourceId = messageId; returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; extra.value = ''; error.value = ''; mode.value = 'create'; };
const openHide = () => { if (saving.value)
    return; returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; error.value = ''; mode.value = 'hide'; };
const trapFocus = (event: KeyboardEvent) => { const nodes = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not([disabled]), textarea') ?? [])]; if (!nodes.length)
    return; const first = nodes[0], last = nodes.at(-1)!; if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) {
    event.preventDefault();
    last.focus();
}
else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
} };
const confirm = async () => {
    if (props.disabled || saving.value || !mode.value)
        return;
    if (mode.value === 'create') {
        const request = { messageId: sourceId, extra: extra.value.trim() };
        close();
        dismissed.value = props.scopeKey;
        emit('create', request);
        return;
    }
    saving.value = true;
    const revision = dialogRevision;
    try {
        await chrome.storage.local.set({ [KEY]: true });
        if (disposed || revision !== dialogRevision) return;
        hidden.value = true;
        saving.value = false;
        close();
    }
    catch {
        if (!disposed && revision === dialogRevision) error.value = t('sidepanel.chat.skillCapturePreferenceError');
    }
    finally {
        if (!disposed && revision === dialogRevision) saving.value = false;
    }
};
const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => { if (area === 'local' && changes[KEY]) {
    preferenceRevision++;
    hidden.value = changes[KEY].newValue === true;
} };
onMounted(async () => { chrome.storage.onChanged.addListener(changed); const revision = preferenceRevision; try {
    const stored = await chrome.storage.local.get(KEY);
    if (!disposed && revision === preferenceRevision)
        hidden.value = stored[KEY] === true;
}
catch {
    if (!disposed)
        hidden.value = true;
}
finally {
    if (!disposed)
        ready.value = true;
} });
onBeforeUnmount(() => { disposed = true; chrome.storage?.onChanged?.removeListener(changed); });
watch(() => [props.scopeKey, props.disabled], () => { if (mode.value) {
    dialogRevision++;
    saving.value = false;
    close();
} });
watch(mode, async (value) => { if (value) {
    await nextTick();
    (value === 'create' ? textarea.value : dialog.value)?.focus();
} });
defineExpose({ open });
</script>
<style scoped>
/* ──── 技能沉淀提醒卡片（紧凑排版） ────
   布局要点：① 图标与标题**同行**，不再单占左栏——左栏空一列是这张卡最大的空白来源；
   ② 正文与按钮整行铺开（不再被图标挤到右侧窄列），按钮不因换行多占一行高度；
   ③ 尺寸基调整体下调一档：内边距 11/13、图标 26、正文 11.5/1.55、按钮 5/10。 */
.skill-practice-card{display:flex;flex-direction:column;gap:6px;margin:10px 0 14px;padding:11px 13px;border:1px solid color-mix(in srgb,var(--primary-color,#3b3934) 23%,transparent);border-radius:13px;background:linear-gradient(125deg,color-mix(in srgb,var(--primary-color,#3b3934) 8%,transparent),color-mix(in srgb,var(--primary-color,#3b3934) 2%,transparent));color:var(--ink-primary,#334155)}
.skill-practice-head{display:flex;align-items:center;gap:8px;min-width:0}
.skill-practice-title{font-size:13px;font-weight:650;line-height:1.45;min-width:0}
.skill-practice-icon{display:grid;place-items:center;flex-shrink:0;width:26px;height:26px;border-radius:8px;color:var(--primary-color,#3b3934);background:color-mix(in srgb,var(--primary-color,#3b3934) 12%,transparent)}
.skill-practice-icon svg{width:15px;height:15px}
.skill-practice-intro{margin:0;font-size:11.5px;line-height:1.55;color:var(--ink-secondary,#64748b)}
.skill-practice-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.skill-capture-dialog-mark{display:grid;place-items:center;flex-shrink:0;width:42px;height:42px;border-radius:13px;color:var(--primary-color,#3b3934);background:color-mix(in srgb,var(--primary-color,#3b3934) 12%,transparent)}
button{border:1px solid var(--line-soft,#dce1eb);border-radius:9px;background:transparent;color:inherit;padding:7px 12px;font:inherit;font-size:12px;cursor:pointer;transition:background .16s,transform .16s}button:hover{background:color-mix(in srgb,var(--primary-color,#3b3934) 10%,transparent)}button:focus-visible,textarea:focus-visible{outline:2px solid var(--primary-color,#3b3934);outline-offset:3px}button:disabled{opacity:.5;cursor:default}.skill-practice-actions button{padding:5px 10px;font-size:11.5px;border-radius:8px}.skill-practice-primary{background:var(--primary-color,#3b3934)!important;border-color:transparent;color:white;box-shadow:0 2px 7px #3b39341a}.skill-practice-quiet{border-color:transparent;color:var(--ink-secondary,#64748b);font-size:11px;padding:5px 8px}
.skill-capture-backdrop{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;padding:22px;background:#10162966;backdrop-filter:blur(5px)}.skill-capture-dialog{width:min(100%,480px);box-sizing:border-box;padding:24px;border-radius:20px;border:1px solid var(--line-soft,#dce1eb);background:var(--surface-card,#fff);color:var(--ink-primary,#1e293b);box-shadow:0 24px 90px #10162940;outline:none}.skill-capture-dialog-top{display:flex;align-items:center;gap:12px}.skill-capture-dialog h3{font-size:16px;margin:0}.skill-capture-dialog p{font-size:13px;line-height:1.7;color:var(--ink-secondary,#64748b);white-space:pre-line}.skill-capture-field{display:grid;gap:8px;margin-top:18px;font-size:12px;font-weight:600}.skill-capture-field textarea{box-sizing:border-box;width:100%;resize:vertical;min-height:96px;max-height:260px;padding:11px 12px;border:1px solid var(--line-soft,#dce1eb);border-radius:10px;background:var(--surface-soft,#f7f8fc);color:inherit;font:inherit;font-weight:400;line-height:1.6}.skill-capture-dialog footer{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}.skill-capture-error{color:#d14d53!important}
@media(prefers-reduced-motion:reduce){button{transition:none}}@media(max-width:360px){.skill-practice-card{padding:10px;gap:6px}.skill-practice-quiet{width:100%;text-align:left}.skill-capture-dialog{padding:18px}}
</style>
