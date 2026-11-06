<template>
  <div class="hub">
    <!-- 壳与设置弹窗同构：复用 api-config-* 布局类（settings-modal.css），视觉完全对齐 -->
    <div class="api-config-modal hub-shell">
      <!-- 头部（标题居中 + 右侧语言切换，与设置弹窗一致） -->
      <header class="api-config-header">
        <h1 class="api-config-title">{{ t('hub.title') }}</h1>
        <!-- 语言切换（右上角，切换即持久化并同步到全部扩展页面） -->
        <div class="api-config-locale" role="group" :aria-label="t('common.languageLabel')">
          <button
            v-for="option in localeOptions"
            :key="option.value"
            type="button"
            class="api-config-locale-btn"
            :class="{ active: locale === option.value }"
            :aria-pressed="locale === option.value"
            @click="switchLocale(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </header>

      <section v-if="visibleTransfers.length || handoffError || handoffNotice" class="hub-handoff" aria-live="polite">
        <div>
          <strong>{{ t(visibleTransfers.length ? 'hub.learnHandoffTitle' : 'hub.learnHandoffStatusTitle') }}</strong>
          <p v-if="visibleTransfers.length">{{ t('hub.learnHandoffIntro') }}</p>
          <p v-if="handoffNotice" role="status">{{ handoffNotice }}</p>
          <p v-if="agentEditorOpen || skillEditorOpen" class="hub-handoff__warning">{{ t('hub.learnHandoffSaveFirst') }}</p>
          <p v-if="handoffError" class="hub-handoff__error" role="alert">{{ handoffError }}</p>
        </div>
        <div class="hub-handoff__actions">
          <HubSelect
            v-if="visibleTransfers.length"
            v-model="selectedTransferId"
            :options="transferOptions"
            :disabled="handoffBusy"
            :aria-label="t('hub.learnHandoffSelect')"
            style="width: min(420px, 100%)"
          />
          <button v-if="visibleTransfers.length" type="button" class="hub-btn hub-btn-primary" :disabled="handoffBusy || agentEditorOpen || skillEditorOpen" @click="acceptHandoff">{{ t('hub.learnHandoffAccept') }}</button>
          <button type="button" class="hub-btn" :disabled="handoffBusy" @click="refreshPending">{{ t('hub.learnHandoffRetry') }}</button>
        </div>
      </section>

      <!-- 左右布局：左侧导航 + 右侧内容 -->
      <div class="api-config-layout">
        <aside class="api-config-nav">
          <button
            v-for="section in sections"
            :key="section.id"
            type="button"
            class="api-nav-item"
            :class="{ active: activeSection === section.id }"
            @click="activeSection = section.id"
          >
            <span class="api-nav-label">{{ t(section.labelKey) }}</span>
          </button>
        </aside>

        <!-- 分区内容（v-show 常驻挂载：切换不丢编辑中的表单状态） -->
        <main class="api-config-body" :inert="handoffBusy" :aria-busy="handoffBusy">
          <section v-show="activeSection === 'agents'" class="api-section">
            <AgentManager @editor-state="agentEditorOpen = $event" />
          </section>
          <section v-show="activeSection === 'skills'" class="api-section">
            <SkillManager ref="skillManagerRef" @editor-state="onSkillEditorState" />
          </section>
          <section v-show="activeSection === 'plugins'" class="api-section"><PluginManager /></section>
          <section v-show="activeSection === 'backup'" class="api-section">
            <BackupSection :active="activeSection === 'backup'" />
          </section>
        </main>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 管理中心（更多设置）外壳：与 sidepanel 设置弹窗同构的左侧导航布局。
 * 壳样式复用设置弹窗的 settings-modal.css（api-config-* 类），保证视觉对齐；
 * 各分区为自包含管理组件，直接读写共享存储层（utils/agents、utils/skills），
 * 保存后经 chrome.storage 跨上下文同步实时作用于 sidepanel。
 *
 * 学习深链仅选择待接收成果，保留各分区编辑状态；主动确认后才交给 SkillManager。
 * 挂载、hashchange 与 storage 变化均可刷新队列，不依赖一次性消费信号。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { t, useLocale, LOCALE_OPTIONS, type MessageKey } from '@/utils/i18n';
// 复用设置弹窗壳样式（布局/头部/侧导航/分区容器），视觉与设置弹窗完全一致
import '../sidepanel/components/modals/settings-modal.css';
import AgentManager from './agents/AgentManager.vue';
// Hub 共享自定义选择框（学习成果下拉；全站替换原生 <select>）
import HubSelect from './components/HubSelect.vue';
import PluginManager from './plugins/PluginManager.vue';
import { startPluginClient } from '@/utils/plugins/client';
void startPluginClient().catch(error => console.warn('[Plugins] Startup failed', error));
import SkillManager from './skills/SkillManager.vue';
import BackupSection from './BackupSection.vue';
import { LEARN_DRAFT_HASH, type LearnDraftTransfer } from '@/utils/learn/learn-types';
import { listLearnDrafts, readLearnDraft, watchLearnDrafts, isLearnTransferId } from '@/utils/learn/learn-draft-store';

type HubSection = 'agents' | 'skills' | 'plugins' | 'backup';

const sections: ReadonlyArray<{ id: HubSection; labelKey: MessageKey }> = [
  { id: 'agents', labelKey: 'hub.tabAgents' },
  { id: 'skills', labelKey: 'hub.tabSkills' },
  { id: 'plugins', labelKey: 'hub.tabPlugins' },
  { id: 'backup', labelKey: 'sidepanel.backup.title' },
];

const activeSection = ref<HubSection>('agents');

/** 技能分区管理器：仅在用户明确确认后接收指定成果。 */
const skillManagerRef = ref<InstanceType<typeof SkillManager> | null>(null);
const agentEditorOpen = ref(false), skillEditorOpen = ref(false);
const pendingTransfers = ref<LearnDraftTransfer[]>([]);
const selectedTransferId = ref('');
const editingTransferId = ref('');
const handoffError = ref(''), handoffBusy = ref(false);
const handoffNotice = ref('');
const visibleTransfers = computed(() => pendingTransfers.value.filter(item => !skillEditorOpen.value || item.id !== editingTransferId.value));
/** 接收条下拉选项（自绘选择框用）：成果名 + 交付时间 */
const transferOptions = computed(() => visibleTransfers.value.map(item => ({
  value: item.id,
  label: `${item.draft.name} · ${new Date(item.createdAt).toLocaleString()}`,
})));
let requestedTransferId = '';
let refreshGeneration = 0;
let disposed = false;
function onSkillEditorState(open: boolean): void {
  skillEditorOpen.value = open;
  if (!open) editingTransferId.value = '';
}

async function refreshPending(): Promise<void> {
  const generation = ++refreshGeneration;
  const result = await listLearnDrafts();
  if (disposed || generation !== refreshGeneration) return;
  if (!result.ok) { handoffError.value = t('hub.learnHandoffReadFailed'); return; }
  pendingTransfers.value = result.transfers;
  handoffError.value = result.invalidIds.length ? t('hub.learnHandoffReadFailed') : '';
  handoffNotice.value = '';
  if (requestedTransferId) {
    const requested = requestedTransferId;
    if (result.transfers.some(item => item.id === requested)) selectedTransferId.value = requested;
    else {
      const detail = await readLearnDraft(requested);
      if (disposed || generation !== refreshGeneration) return;
      if (detail.status === 'ok' && detail.transfer.status === 'saved') handoffNotice.value = t('hub.learnHandoffAlreadyHandled');
      else if (detail.status === 'ok' && (detail.transfer.status === 'discarded' || detail.transfer.recoveryDismissed)) handoffNotice.value = t('hub.learnHandoffIgnored');
      else handoffError.value = t('hub.learnHandoffReadFailed');
    }
    requestedTransferId = '';
  }
  if (!visibleTransfers.value.some(item => item.id === selectedTransferId.value)) selectedTransferId.value = visibleTransfers.value[0]?.id ?? '';
}

async function acceptHandoff(): Promise<void> {
  if (handoffBusy.value || agentEditorOpen.value || skillEditorOpen.value || !isLearnTransferId(selectedTransferId.value)) return;
  const id = selectedTransferId.value;
  handoffBusy.value = true;
  try {
    const result = await skillManagerRef.value?.acceptLearnDraft(id);
    if (!result?.ok) {
      if (result?.outcome) { handoffNotice.value = result.error ?? ''; handoffError.value = ''; }
      else handoffError.value = result?.error ?? t('hub.learnHandoffReadFailed');
      return;
    }
    editingTransferId.value = id;
    activeSection.value = 'skills';
    handoffError.value = '';
    handoffNotice.value = '';
  } catch { handoffError.value = t('hub.learnHandoffReadFailed'); }
  finally { handoffBusy.value = false; }
}

function protectEditor(event: BeforeUnloadEvent): void {
  if (!agentEditorOpen.value && !skillEditorOpen.value) return;
  event.preventDefault(); event.returnValue = '';
}

/**
 * 分区深链（hub.html#backup 等）：命中即切到对应分区并清 hash。
 * 让侧边栏 / 外部入口能直达某个分区（例如「查看存储占用」→ 直接落到备份分区），
 * 免去用户自己在导航里找。
 */
const SECTION_HASHES: Readonly<Record<string, HubSection>> = {
  '#agents': 'agents',
  '#skills': 'skills',
  '#backup': 'backup',
  '#plugins': 'plugins',
};

function consumeSectionHash(): boolean {
  const target = SECTION_HASHES[window.location.hash];
  if (!target) return false;
  activeSection.value = target;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return true;
}

/**
 * 解析指定成果 ID 后清除导航信号；不切分区、不重置编辑器、不删除数据。
 */
function consumeDraftHash(): boolean {
  const hash = window.location.hash;
  if (hash !== LEARN_DRAFT_HASH && !hash.startsWith(LEARN_DRAFT_HASH + '?')) return false;
  const params = new URLSearchParams(hash.split('?')[1] ?? '');
  const id = params.get('id');
  requestedTransferId = id ?? '';
  // This only records a delivery signal; no editor is reset and no payload is consumed.
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return true;
}
let unsubscribeDrafts: (() => void) | null = null;
onMounted(() => {
  consumeSectionHash(); consumeDraftHash();
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('beforeunload', protectEditor);
  unsubscribeDrafts = watchLearnDrafts(() => { void refreshPending(); });
  void refreshPending();
});
function onHashChange(): void {
  if (consumeSectionHash()) return;
  if (consumeDraftHash()) void refreshPending();
}
onUnmounted(() => {
  disposed = true; refreshGeneration++;
  unsubscribeDrafts?.();
  window.removeEventListener('hashchange', onHashChange);
  window.removeEventListener('beforeunload', protectEditor);
});

// 语言切换：core 为唯一事实源，切换后立即持久化并同步到所有扩展页面
const { locale, switchLocale } = useLocale();
const localeOptions = LOCALE_OPTIONS;
</script>
