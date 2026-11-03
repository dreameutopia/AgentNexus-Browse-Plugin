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
        <main class="api-config-body">
          <section v-show="activeSection === 'agents'" class="api-section">
            <AgentManager />
          </section>
          <section v-show="activeSection === 'skills'" class="api-section">
            <SkillManager ref="skillManagerRef" />
          </section>
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
 * 网站学习草稿深链（hub.html#new-skill）：hash 命中 → 切到技能分区并把
 * 消费信号交给 SkillManager；处理后立即清 hash（replaceState 不触发
 * hashchange，无循环），避免刷新重复命中。挂载与 hashchange 双监听——
 * sidepanel 复用已开标签页走 tabs.update，只监听挂载会漏掉该路径。
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { t, useLocale, LOCALE_OPTIONS, type MessageKey } from '@/utils/i18n';
// 复用设置弹窗壳样式（布局/头部/侧导航/分区容器），视觉与设置弹窗完全一致
import '../sidepanel/components/modals/settings-modal.css';
import AgentManager from './agents/AgentManager.vue';
import SkillManager from './skills/SkillManager.vue';
import BackupSection from './BackupSection.vue';
import { LEARN_DRAFT_HASH } from '@/utils/learn/learn-types';

type HubSection = 'agents' | 'skills' | 'backup';

const sections: ReadonlyArray<{ id: HubSection; labelKey: MessageKey }> = [
  { id: 'agents', labelKey: 'hub.tabAgents' },
  { id: 'skills', labelKey: 'hub.tabSkills' },
  { id: 'backup', labelKey: 'sidepanel.backup.title' },
];

const activeSection = ref<HubSection>('agents');

/** 技能分区管理器（草稿消费入口：深链信号经此交给它，编辑态冲突由其自行处置） */
const skillManagerRef = ref<InstanceType<typeof SkillManager> | null>(null);

/**
 * 解析草稿深链：命中则切到技能分区并清 hash，返回是否命中。
 * 无 hash 的常规打开不产生信号——交付信号唯一，避免用户普通打开管理中心
 * 被无关事件打断（草稿消费的防残留见 learn-draft-store 三重防线）。
 */
function consumeDraftHash(): boolean {
  if (window.location.hash !== LEARN_DRAFT_HASH) return false;
  activeSection.value = 'skills';
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return true;
}

onMounted(() => {
  // 挂载即消费（hash 决定提示口径：深链承诺了草稿，缺失/过期要明确告知）
  const viaHash = consumeDraftHash();
  void skillManagerRef.value?.consumeLearnDraft(viaHash);
  window.addEventListener('hashchange', onHashChange);
});

function onHashChange(): void {
  // 标签已开着时 sidepanel 经 tabs.update 送达深链：命中才消费
  if (consumeDraftHash()) {
    void skillManagerRef.value?.consumeLearnDraft(true);
  }
}

onUnmounted(() => window.removeEventListener('hashchange', onHashChange));

// 语言切换：core 为唯一事实源，切换后立即持久化并同步到所有扩展页面
const { locale, switchLocale } = useLocale();
const localeOptions = LOCALE_OPTIONS;
</script>
