<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { browserBindingKey, readBrowserBinding, writeBrowserBinding, BROWSER_WINDOW_BUSY_CHATS } from '@/utils/browser-window-binding';
import type { BrowserScope } from '@/tools/browser/browser-scope';
import { BrowserScopeError, browserErrorText, browserOperation } from '@/tools/browser/scope-errors';

const props = defineProps<{ chatId: string; busy: boolean }>();
const workerBusyChats = ref<string[]>([]);
const busy = computed(() => props.busy || workerBusyChats.value.includes(props.chatId));
const { t } = useI18n();
const root = ref<HTMLElement>();
const open = ref(false);
const loading = ref(true);
const saving = ref(false);
const scope = ref<BrowserScope>();
const windows = ref<chrome.windows.Window[]>([]);
const ownerWindowId = ref<number>();
const bindingError = ref('');
const saveError = ref('');
const windowsError = ref('');
const error = computed(() => saveError.value || bindingError.value || windowsError.value);
const menuStyle = ref<Record<string, string>>({ bottom: '80px' });
const keyId = computed(() => props.chatId || (ownerWindowId.value === undefined ? '' : `draft:${ownerWindowId.value}`));
const target = computed(() => windows.value.find(window => window.id === scope.value?.windowId));
const windowChoices = computed(() => [...windows.value].sort((a, b) => Number(b.id === ownerWindowId.value) - Number(a.id === ownerWindowId.value)));
const unavailable = computed(() => !!scope.value && !target.value);
const label = computed(() => scope.value
  ? unavailable.value ? t('browserBinding.closed') : t('browserBinding.bound', { name: windowTitle(target.value!) })
  : t('browserBinding.follow'));
function activePage(window: chrome.windows.Window) { return window.tabs?.find(tab => tab.active) ?? window.tabs?.[0]; }
function windowTitle(window: chrome.windows.Window): string {
  return activePage(window)?.title?.trim() || t('browserBinding.untitled');
}
function windowDetails(window: chrome.windows.Window): string {
  const url = activePage(window)?.url;
  let site = '';
  try {
    const parsed = new URL(url ?? '');
    site = /^https?:$/.test(parsed.protocol) ? parsed.hostname : t('browserBinding.browserPage');
  } catch { /* A loading tab may not have a URL yet. */ }
  return [site, t('browserBinding.tabs', { count: window.tabs?.length ?? 0 })].filter(Boolean).join(' · ');
}
function otherPages(window: chrome.windows.Window): string {
  const active = activePage(window);
  return (window.tabs ?? []).filter(tab => tab !== active).map(tab => tab.title?.trim()).filter(Boolean).slice(0, 2).join(' / ');
}
let generation = 0;
let windowGeneration = 0;
let disposed = false;
let busyRevision = 0;
const busyIds = (value: unknown): string[] => Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
let initialization: Promise<void> = Promise.resolve();
let currentLoad: Promise<void> = Promise.resolve();
let pendingSelection: Promise<void> | undefined;
let pendingKey: string | undefined;
let failedSelection: { key: string; cause: unknown } | undefined;
const subscriptions: Array<() => void> = [];

function positionMenu() {
  const rect = root.value?.getBoundingClientRect();
  if (!rect) return;
  const height = window.innerHeight;
  menuStyle.value = rect.top >= Math.min(220, height / 2)
    ? { bottom: `${Math.max(8, height - rect.top + 8)}px`, maxHeight: `${Math.max(24, rect.top - 20)}px` }
    : { top: `${Math.max(8, rect.bottom + 8)}px`, maxHeight: `${Math.max(24, height - rect.bottom - 20)}px` };
}
async function resolveOwner() {
  const window = await browserOperation('picker.getCurrentWindow', undefined, () => chrome.windows.getCurrent());
  if (!Number.isSafeInteger(window?.id) || window.id! < 0 || (window.type !== undefined && window.type !== 'normal'))
    throw new BrowserScopeError('INVALID_BROWSER_SCOPE', 'picker.getCurrentWindow', '无法确认侧边栏所属的普通窗口，请重新打开侧边栏。');
  if (!disposed) ownerWindowId.value = window.id;
}
async function refreshWindows() {
  const epoch = ++windowGeneration;
  try {
    const result = await browserOperation('picker.listWindows', undefined,
      () => chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }));
    if (!Array.isArray(result)) throw new Error('浏览器未返回有效的窗口列表');
    if (!disposed && epoch === windowGeneration) {
      windows.value = result.filter(item => Number.isSafeInteger(item.id) && item.id! >= 0 && item.type === 'normal');
      windowsError.value = '';
    }
  } catch (cause) {
    if (!disposed && epoch === windowGeneration) windowsError.value = browserErrorText(cause);
  }
}
function load(): Promise<void> {
  const epoch = ++generation;
  const id = keyId.value;
  loading.value = true;
  bindingError.value = '';
  saveError.value = failedSelection?.key === id ? browserErrorText(failedSelection.cause) : '';
  currentLoad = (async () => {
    try {
      if (!id) throw new Error('侧边栏窗口尚未就绪，请稍后重试');
      const binding = await readBrowserBinding(id);
      if (!disposed && epoch === generation && id === keyId.value) scope.value = binding;
    } catch (cause) {
      if (!disposed && epoch === generation) bindingError.value = browserErrorText(cause);
    } finally { if (!disposed && epoch === generation) loading.value = false; }
  })();
  return currentLoad;
}
async function select(windowId?: number) {
  if (busy.value || loading.value || saving.value) return;
  const id = keyId.value;
  if (!id) { bindingError.value = '侧边栏窗口尚未就绪，请重新打开选择面板。'; return; }
  saving.value = true;
  saveError.value = '';
  pendingKey = id;
  const operation = (async () => {
    const binding: BrowserScope | undefined = windowId === undefined ? undefined : { mode: 'bound-window', windowId };
    await writeBrowserBinding(id, binding);
    failedSelection = undefined;
    if (!disposed && id === keyId.value) { scope.value = binding; open.value = false; }
  })();
  pendingSelection = operation;
  try { await operation; }
  catch (cause) {
    failedSelection = { key: id, cause };
    if (!disposed && id === keyId.value) saveError.value = browserErrorText(cause);
  } finally {
    if (pendingSelection === operation) { pendingSelection = undefined; pendingKey = undefined; }
    if (!disposed) saving.value = false;
  }
}
async function toggle() {
  if (busy.value || saving.value) return;
  open.value = !open.value;
  if (open.value) {
    positionMenu();
    try { if (ownerWindowId.value === undefined) await resolveOwner(); }
    catch (cause) { bindingError.value = browserErrorText(cause); }
    await Promise.all([load(), refreshWindows()]);
    await nextTick();
    if (open.value && !disposed) root.value?.querySelector<HTMLButtonElement>('.browser-window-option.selected')?.focus();
  }
}
async function captureBinding(): Promise<BrowserScope | undefined> {
  const chatId = props.chatId;
  await initialization;
  if (!chatId && ownerWindowId.value === undefined) await resolveOwner();
  const id = keyId.value;
  if (disposed || chatId !== props.chatId || !id)
    throw new BrowserScopeError('BROWSER_BINDING_CHANGED', 'captureBinding', '窗口选择所属会话已改变，发送未继续。');
  if (pendingKey === id) await pendingSelection;
  await currentLoad;
  if (failedSelection?.key === id) throw failedSelection.cause;
  const binding = await readBrowserBinding(id);
  if (disposed || id !== keyId.value)
    throw new BrowserScopeError('BROWSER_BINDING_CHANGED', 'captureBinding', '读取窗口选择期间会话发生变化，发送未继续。');
  return binding;
}
/** Snapshot once; never reread a different chat's selection after session creation. */
function prepareDraftBinding(snapshot?: { scope?: BrowserScope }) {
  const id = keyId.value;
  const selected = snapshot ? Promise.resolve(snapshot.scope) : captureBinding();
  void selected.catch(() => undefined);
  return async (chatId: string) => {
    const binding = await selected;
    await writeBrowserBinding(chatId, binding);
    if (id.startsWith('draft:')) {
      const current = await readBrowserBinding(id);
      if (current?.windowId === binding?.windowId) await writeBrowserBinding(id);
    }
  };
}
defineExpose({ prepareDraftBinding, captureBinding });
const outside = (event: PointerEvent) => { if (!root.value?.contains(event.target as Node)) open.value = false; };
const escape = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && open.value) { open.value = false; root.value?.querySelector<HTMLButtonElement>('.browser-window-trigger')?.focus(); }
};
const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
  if (area === 'session') {
    if (BROWSER_WINDOW_BUSY_CHATS in changes) {
      busyRevision++;
      workerBusyChats.value = busyIds(changes[BROWSER_WINDOW_BUSY_CHATS].newValue);
    }
  }
  if (area === 'session' && keyId.value && browserBindingKey(keyId.value) in changes) {
    if (!saving.value && failedSelection?.key === keyId.value) {
      failedSelection = undefined;
      saveError.value = '';
    }
    void load();
  }
};
const topology = () => { void refreshWindows(); };
const reposition = () => { if (open.value) positionMenu(); };
watch(() => props.chatId, () => { scope.value = undefined; open.value = false; void load(); });
watch(busy, value => { if (value) open.value = false; });
onMounted(() => {
  document.addEventListener('pointerdown', outside);
  document.addEventListener('keydown', escape);
  window.addEventListener('resize', reposition);
  document.addEventListener('scroll', reposition, true);
  const subscribe = (event: { addListener(listener: any): void; removeListener(listener: any): void } | undefined, listener: any) => {
    if (!event) return;
    event.addListener(listener);
    subscriptions.push(() => event.removeListener(listener));
  };
  try {
    subscribe(chrome.storage?.onChanged, changed);
    subscribe(chrome.windows?.onRemoved, topology);
    subscribe(chrome.windows?.onCreated, topology);
  } catch (cause) { windowsError.value = browserErrorText(cause); }
  initialization = (async () => {
    const revision = busyRevision;
    try {
      const state = await browserOperation('picker.readBusyState', undefined,
        () => chrome.storage.session.get([BROWSER_WINDOW_BUSY_CHATS]));
      if (!disposed && revision === busyRevision) {
        workerBusyChats.value = busyIds(state?.[BROWSER_WINDOW_BUSY_CHATS]);
      }
    } catch (cause) { if (!disposed) bindingError.value = browserErrorText(cause); }
    try { await resolveOwner(); }
    catch (cause) { if (!disposed) bindingError.value = browserErrorText(cause); }
    if (!disposed) await Promise.all([load(), refreshWindows()]);
  })();
});
onUnmounted(() => {
  disposed = true;
  generation++;
  windowGeneration++;
  document.removeEventListener('pointerdown', outside);
  document.removeEventListener('keydown', escape);
  window.removeEventListener('resize', reposition);
  document.removeEventListener('scroll', reposition, true);
  for (const unsubscribe of subscriptions.splice(0)) {
    try { unsubscribe(); } catch (cause) { console.warn('[BrowserWindowPicker]', browserErrorText(cause)); }
  }
});
</script>

<template>
  <div ref="root" class="browser-window-picker" @click.stop>
    <button type="button" class="input-action-btn browser-window-trigger" :class="{ bound: scope, unavailable: unavailable || error }"
      :title="busy ? t('browserBinding.busy') : `${t('browserBinding.title')} · ${label}`" :aria-label="t('browserBinding.title')"
      aria-haspopup="dialog" :aria-expanded="open" :aria-busy="loading || saving" :disabled="busy || saving" @click="toggle">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
        <rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>
        <path v-if="scope" d="m8 10 3 3 5-5"/>
      </svg>
    </button>
    <div v-if="open" class="browser-window-menu" :style="menuStyle" role="dialog" :aria-label="t('browserBinding.title')" :aria-busy="loading || saving">
      <div class="browser-window-heading">{{ t('browserBinding.title') }} <span>Beta</span></div>
      <p class="browser-window-intro">{{ t('browserBinding.hint') }}</p>
      <button type="button" class="browser-window-option" :class="{ selected: !scope && !bindingError }" :aria-pressed="!scope && !bindingError" :disabled="busy || saving || loading" @click="select()">
        <span class="browser-window-radio" aria-hidden="true">{{ !scope && !bindingError ? '✓' : '' }}</span>
        <div class="browser-window-copy"><strong>{{ t('browserBinding.follow') }}</strong><small>{{ t('browserBinding.followHint') }}</small></div>
      </button>
      <div class="browser-window-list-heading"><span>{{ t('browserBinding.choose') }}</span>
        <button type="button" class="browser-window-refresh" :disabled="busy || loading || saving" @click="refreshWindows">{{ t('common.refresh') }}</button>
      </div>
      <p v-if="loading" class="browser-window-empty">{{ t('common.loading') }}</p>
      <p v-else-if="!windows.length && !error" class="browser-window-empty">{{ t('browserBinding.empty') }}</p>
      <button v-for="(window, index) in windowChoices" :key="window.id" type="button" class="browser-window-option"
        :class="{ selected: scope?.windowId === window.id }" :aria-pressed="scope?.windowId === window.id" :disabled="busy || saving || loading" @click="select(window.id)">
        <span class="browser-window-radio" aria-hidden="true">{{ scope?.windowId === window.id ? '✓' : '' }}</span>
        <div class="browser-window-copy">
          <div class="browser-window-badges"><span>{{ t('browserBinding.window', { number: index + 1 }) }}</span>
            <span v-if="window.id === ownerWindowId" class="browser-window-badge">{{ t('browserBinding.thisWindow') }}</span>
            <span v-if="scope?.windowId === window.id" class="browser-window-badge selected-badge">{{ t('browserBinding.selected') }}</span>
            <span v-if="window.state === 'minimized'" class="browser-window-badge minimized-badge">{{ t('browserBinding.minimized') }}</span>
          </div>
          <strong :title="windowTitle(window)">{{ windowTitle(window) }}</strong>
          <small>{{ windowDetails(window) }}</small>
          <small v-if="otherPages(window)" class="browser-window-other-pages" :title="otherPages(window)">{{ t('browserBinding.otherPages', { titles: otherPages(window) }) }}</small>
        </div>
      </button>
      <div class="browser-window-footer">
        <p v-if="error || unavailable" class="browser-window-status warning" role="status" aria-live="polite">{{ error || label }}</p>
        <p v-else class="browser-window-status" role="status" aria-live="polite">{{ scope ? t('browserBinding.scopeHint') : t('browserBinding.offHint') }}</p>
        <p v-if="busy" class="warning">{{ t('browserBinding.busy') }}</p>
        <p v-if="scope" class="browser-window-visibility">{{ t('browserBinding.visibility') }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.browser-window-picker { position: relative; display: flex; align-items: center; }
.browser-window-trigger { appearance: none; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--ink-secondary, #787671); cursor: pointer; box-shadow: none; outline: none; transition: background .15s, color .15s; }
.browser-window-trigger:hover { background: var(--line-soft, #e4e2de); color: var(--ink-primary, #292824); }
.browser-window-trigger:focus-visible { outline: 2px solid #818cf8; outline-offset: 2px; }
.browser-window-trigger:disabled { opacity: .5; cursor: wait; }
.browser-window-trigger.bound { color: #6366f1; background: #6366f110; }
.browser-window-trigger.unavailable { color: #b45309; }
.browser-window-menu { position: fixed; left: 12px; right: 12px; box-sizing: border-box; max-height: min(480px, 70vh); overflow-y: auto; overscroll-behavior: contain; padding: 16px; border: 1px solid var(--line-soft, #e5e7eb); border-radius: 16px; background: var(--bg-primary, white); color: var(--ink-primary, #202124); box-shadow: 0 12px 40px #00000016; z-index: 102; scrollbar-width: thin; }
.browser-window-heading { display: flex; gap: 8px; align-items: center; font-weight: 650; font-size: 14px; }
.browser-window-heading > span { font-size: 10px; font-weight: 500; color: #6366f1; background: #6366f110; border-radius: 5px; padding: 3px 6px; }
.browser-window-menu p { font-size: 12px; line-height: 1.65; color: var(--ink-secondary, #6b7280); margin: 8px 0; overflow-wrap: anywhere; }
.browser-window-intro { margin-bottom: 14px !important; }
.browser-window-list-heading { display: flex; align-items: center; justify-content: space-between; margin: 14px 2px 6px; color: var(--ink-secondary, #6b7280); font-size: 11px; }
.browser-window-refresh { appearance: none; border: 0; border-radius: 5px; padding: 3px 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.browser-window-refresh:hover { color: #6366f1; background: #6366f110; }
.browser-window-option { appearance: none; box-sizing: border-box; width: 100%; display: flex; text-align: left; align-items: flex-start; gap: 10px; border: 1px solid transparent; border-radius: 10px; padding: 11px 10px; margin: 3px 0; background: transparent; color: inherit; font: inherit; cursor: pointer; transition: background .15s, border-color .15s; }
.browser-window-option:hover { background: var(--line-soft, #f3f4f6); }
.browser-window-option.selected { background: #6366f10a; border-color: #6366f133; }
.browser-window-option:focus-visible, .browser-window-refresh:focus-visible { outline: 2px solid #818cf8; outline-offset: 1px; }
.browser-window-option:disabled { opacity: .55; cursor: default; }
.browser-window-radio { display: flex; flex: 0 0 16px; align-items: center; justify-content: center; box-sizing: border-box; width: 16px; height: 16px; margin-top: 3px; border: 1.5px solid var(--ink-tertiary, #b7b6bc); border-radius: 50%; font-size: 10px; font-weight: 700; }
.selected .browser-window-radio { background: #6366f1; border-color: #6366f1; color: white; }
.browser-window-copy { min-width: 0; flex: 1; }
.browser-window-option strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 550; line-height: 1.6; }
.browser-window-option small { display: block; font-size: 11px; line-height: 1.6; color: var(--ink-secondary, #6b7280); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; margin-top: 3px; }
.browser-window-option:first-of-type small { white-space: normal; }
.browser-window-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-bottom: 5px; font-size: 10px; line-height: 1.5; color: var(--ink-secondary, #6b7280); }
.browser-window-badge { padding: 1px 5px; border-radius: 4px; background: var(--line-soft, #f0f0f3); }
.browser-window-badge.selected-badge { color: #6366f1; background: #6366f112; }
.browser-window-badge.minimized-badge { color: #a16207; background: #eab30814; }
.browser-window-footer { margin-top: 12px; padding: 10px 2px 0; border-top: 1px solid var(--line-soft, #e5e7eb); }
.browser-window-footer p { margin: 0; font-size: 11px; }
.browser-window-footer .browser-window-visibility { margin-top: 7px; }
.browser-window-menu .warning { color: #b45309; }
</style>
