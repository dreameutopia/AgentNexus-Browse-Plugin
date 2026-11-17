<template>
  <div class="hub">
    <!-- 壳：左右两张独立卡片（左导航卡 / 右内容卡），标题在左卡顶部 -->
    <div class="hub-layout">
      <!-- 左：导航卡（管理中心标题 + 分区入口 + 语言切换） -->
      <aside class="hub-sidebar">
        <h1 class="hub-sidebar-title">{{ t('hub.title') }}</h1>
        <nav class="hub-sidebar-nav" :aria-label="t('hub.title')">
          <button
            v-for="section in sections"
            :key="section.id"
            type="button"
            class="hub-nav-item"
            :class="{ active: activeSection === section.id }"
            @click="activeSection = section.id"
          >
            <span class="hub-nav-label">{{ t(section.labelKey) }}</span>
          </button>
        </nav>
        <!-- 语言切换（贴在左卡底部；切换即持久化并同步到全部扩展页面） -->
        <div class="hub-sidebar-foot">
          <div class="hub-locale" role="group" :aria-label="t('common.languageLabel')">
            <button
              v-for="option in localeOptions"
              :key="option.value"
              type="button"
              class="hub-locale-btn"
              :class="{ active: locale === option.value }"
              :aria-pressed="locale === option.value"
              @click="switchLocale(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
      </aside>

      <!-- 右：内容卡（分区内容，卡片内部滚动） -->
      <main class="hub-content">
        <!-- 分区内容（v-show 常驻挂载：切换不丢编辑中的表单状态） -->
        <div class="hub-content-body">
          <section v-show="activeSection === 'agents'" class="api-section">
            <AgentManager @editor-state="agentEditorOpen = $event" />
          </section>
          <section v-show="activeSection === 'skills'" class="api-section">
            <SkillManager @editor-state="onSkillEditorState" />
          </section>
          <section v-show="activeSection === 'plugins'" class="api-section"><PluginManager /></section>
          <section v-show="activeSection === 'sessions'" class="api-section">
            <SessionsSection :active="activeSection === 'sessions'" />
          </section>
          <section v-show="activeSection === 'usage'" class="api-section">
            <UsageSection />
          </section>
          <section v-show="activeSection === 'python'" class="api-section">
            <PythonSection :active="activeSection === 'python'" />
          </section>
          <section v-show="activeSection === 'backup'" class="api-section">
            <BackupSection :active="activeSection === 'backup'" />
          </section>
        </div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 管理中心（更多设置）外壳：左右两张独立卡片（左导航卡 / 右内容卡）。
 * 标题「管理中心」在左卡顶部，分区入口在其下方，语言切换贴在左卡底部；
 * 右卡承载分区内容，卡片内部滚动（页面本身不出现竖向滚动条）。
 * 各分区为自包含管理组件，直接读写共享存储层（utils/agents、utils/skills），
 * 保存后经 chrome.storage 跨上下文同步实时作用于 sidepanel。
 *
 * 「使用监控」与「Python 环境」由设置弹窗迁入（侧边栏不再保留入口）：
 * 两者的数据均来自共享存储层（用量统计引擎 / Pyodide 环境状态），
 * 跨上下文变更经 storage 订阅实时回流到本视图。
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { t, useLocale, LOCALE_OPTIONS, type MessageKey } from '@/utils/i18n';
// 复用设置弹窗壳的共享按钮样式（备份分区弹窗的 api-config-btn 变体）；
// 布局与导航样式由 hub.css 的 hub-* 类承担（左右两张独立卡片）
import '../sidepanel/components/modals/settings-modal.css';
import AgentManager from './agents/AgentManager.vue';
import PluginManager from './plugins/PluginManager.vue';
import { startPluginClient } from '@/utils/plugins/client';
void startPluginClient().catch(error => console.warn('[Plugins] Startup failed', error));
import SkillManager from './skills/SkillManager.vue';
import BackupSection from './BackupSection.vue';
import UsageSection from './usage/UsageSection.vue';
import PythonSection from './python/PythonSection.vue';
import SessionsSection from './sessions/SessionsSection.vue';

type HubSection = 'agents' | 'skills' | 'plugins' | 'sessions' | 'usage' | 'python' | 'backup';

const sections: ReadonlyArray<{ id: HubSection; labelKey: MessageKey }> = [
  { id: 'agents', labelKey: 'hub.tabAgents' },
  { id: 'skills', labelKey: 'hub.tabSkills' },
  { id: 'plugins', labelKey: 'hub.tabPlugins' },
  { id: 'sessions', labelKey: 'hub.tabSessions' },
  { id: 'usage', labelKey: 'hub.tabUsage' },
  { id: 'python', labelKey: 'hub.tabPython' },
  { id: 'backup', labelKey: 'sidepanel.backup.title' },
];

const activeSection = ref<HubSection>('agents');

const agentEditorOpen = ref(false), skillEditorOpen = ref(false);
function onSkillEditorState(open: boolean): void {
  skillEditorOpen.value = open;
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
  '#sessions': 'sessions',
  '#usage': 'usage',
  '#python': 'python',
};

function consumeSectionHash(): boolean {
  const target = SECTION_HASHES[window.location.hash];
  if (!target) return false;
  activeSection.value = target;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return true;
}

onMounted(() => {
  consumeSectionHash();
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('beforeunload', protectEditor);
});
function onHashChange(): void {
  consumeSectionHash();
}
onUnmounted(() => {
  window.removeEventListener('hashchange', onHashChange);
  window.removeEventListener('beforeunload', protectEditor);
});

// 语言切换：core 为唯一事实源，切换后立即持久化并同步到所有扩展页面
const { locale, switchLocale } = useLocale();
const localeOptions = LOCALE_OPTIONS;
</script>
