<template>
  <div v-if="visible" class="api-config-overlay">
    <div class="api-config-modal">
      <!-- 头部（单行：关闭 + 标题 + 语言切换） -->
      <div class="api-config-header">
        <!-- 关闭按钮（仅关闭弹窗，不触碰侧边栏） -->
        <button type="button" class="api-config-close" :title="t('common.cancel')" @click="emit('close')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/>
          </svg>
        </button>
        <h3 class="api-config-title">{{ t('sidepanel.apiConfig.title') }}</h3>
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
      </div>

      <!-- 左右布局：左侧导航 + 右侧内容 -->
      <div class="api-config-layout">
        <!-- 左侧导航（hidden 分区不渲染入口） -->
        <aside class="api-config-nav">
          <button
            v-for="section in visibleSections"
            :key="section.id"
            type="button"
            class="api-nav-item"
            :class="{ active: activeSection === section.id }"
            @click="activeSection = section.id"
          >
            <span class="api-nav-label">{{ t(section.nameKey) }}</span>
          </button>
          <!-- 更多设置（独立页）：智能体/技能/备份恢复的完整管理，数据经跨上下文同步实时生效 -->
          <button type="button" class="api-nav-item api-nav-external" @click="openHub">
            <span class="api-nav-label">{{ t('hub.moreSettings') }}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M14,3V5H17.59L7.76,14.83L9.17,16.24L19,6.41V10H21V3M19,19H5V5H12V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V12H19V19Z" fill="currentColor"/>
            </svg>
          </button>
        </aside>

        <!-- 分区内容（v-show 常驻挂载：切换不丢分区态，子级 fixed 子弹窗不受影响） -->
        <div class="api-config-body">
          <!-- 共享校验错误：任何分区的保存失败都在这里可见（应用设置分区的错误
               原先只渲染在渠道分区里，用户在别的分区点保存会看不到任何反馈） -->
          <div
            v-show="settingsForm.validationErrors.value.length > 0"
            class="config-validation-errors api-config-shared-errors"
          >
            <p
              v-for="(error, index) in settingsForm.validationErrors.value"
              :key="index"
              class="config-error-item"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink: 0;">
                <path d="M13,13H11V7H13M13,17H11V15H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" fill="#ef4444"/>
              </svg>
              {{ error }}
            </p>
          </div>
          <section v-show="activeSection === 'channels'" class="api-section">
            <ChannelsSection />
          </section>
          <section v-show="activeSection === 'advanced'" class="api-section">
            <AdvancedSection />
          </section>
          <section v-show="activeSection === 'asr'" class="api-section">
            <AsrSection />
          </section>
          <section v-show="activeSection === 'websites'" class="api-section">
            <WebsiteSection />
          </section>
          <!-- 以下为迁入的历史功能分区（导航隐藏，代码保留便于后续启用） -->
          <section v-show="activeSection === 'files'" class="api-section">
            <FilesSection />
          </section>
          <section v-show="activeSection === 'system'" class="api-section">
            <SystemSection />
          </section>
        </div>
      </div>

      <!-- 底部按钮 -->
      <div class="api-config-footer">
        <button class="api-config-btn api-config-btn-secondary" @click="handleCloseSidebar">
          <svg v-if="!modelRegistry.configured" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12L19 6.41Z" fill="currentColor"/>
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" fill="currentColor"/>
          </svg>
          {{ modelRegistry.configured ? t('sidepanel.apiConfig.back') : t('sidepanel.apiConfig.closeSidebar') }}
        </button>
        <button class="api-config-btn api-config-btn-primary" @click="settingsForm.handleSave()" :disabled="settingsForm.isSaving.value">
          <svg v-if="!settingsForm.isSaving.value" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M17 3H5C3.89 3 3 3.9 3 5V19C3 20.1 3.89 21 5 21H19C20.1 21 21 20.1 21 19V7L17 3M19 19H5V5H16.17L19 7.83V19M12 12C10.34 12 9 13.34 9 15S10.34 18 12 18 15 16.66 15 15 13.66 12 12 12M6 6H15V10H6V6Z" fill="currentColor"/>
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="api-config-spin-icon">
            <path d="M12 2C6.48 2 2 6.48 2 12S6.48 22 12 22 22 17.52 22 12 17.52 2 12 2ZM12 20C7.59 20 4 16.41 4 12S7.59 4 12 4 20 7.59 20 12 16.41 20 12 20ZM12 6.5V12L16 14.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>
          </svg>
          {{ settingsForm.isSaving.value ? t('sidepanel.apiConfig.saving') : t('sidepanel.apiConfig.startConfig') }}
        </button>
      </div>
    </div>

    <!-- 弹窗级错误子弹窗（完整响应 JSON；模型拉取 / 备份导入共用，状态来自共享表单） -->
    <div v-if="settingsForm.errorDialog.value" class="api-sub-overlay" @click.self="settingsForm.errorDialog.value = null">
      <div class="api-sub-modal">
        <h4 class="api-sub-title api-sub-title-error">{{ settingsForm.errorDialog.value.title }}</h4>
        <p class="api-sub-message">{{ settingsForm.errorDialog.value.message }}</p>
        <pre v-if="settingsForm.errorDialog.value.detail" class="api-sub-detail">{{ settingsForm.errorDialog.value.detail }}</pre>
        <div class="api-sub-footer">
          <button type="button" class="api-config-btn api-config-btn-primary api-sub-btn" @click="settingsForm.errorDialog.value = null">{{ t('sidepanel.apiConfig.gotIt') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 设置弹窗（壳）：overlay + 头部（标题/关闭/语言切换）+ 左侧分区导航 + 分区容器 + 底部按钮
 *
 * 架构约定：
 *   - 壳只负责框架与装配，不含任何分区业务逻辑
 *   - 各分区为独立组件（sections/），渠道与模型、高级参数共享同一份表单草稿
 *     （composables/use-settings-form，由壳创建并 provide，底部保存统一持久化）
 *   - 分区经 v-show 常驻挂载，切换不丢状态；壳在每次打开时水合并广播 openEpoch
 *   - 备份恢复、使用监控、Python 环境已迁至「更多设置」独立页（entrypoints/hub）；
 *     files / system 为迁入的历史功能分区，导航隐藏（hidden: true）
 */
import { computed, onMounted, onUnmounted, provide, ref, watch } from 'vue';
import { t, useLocale, LOCALE_OPTIONS, type MessageKey } from '@/utils/i18n';
import { modelRegistry } from '../../utils/channels';
import './settings-modal.css';
import './settings-forms.css';
import {
  createSettingsForm,
  settingsFormKey,
  settingsModalContextKey,
  type SettingsFormApi,
  type SettingsSectionId,
} from './composables/use-settings-form';
import {
  ChannelsSection,
  AdvancedSection,
  AsrSection,
  FilesSection,
  SystemSection,
  WebsiteSection,
} from './sections';

const props = withDefaults(
  defineProps<{
    visible: boolean;
    /** 打开时直接定位到的分区（如语音按钮未配置提示「去配置」跳到 ASR 页） */
    initialSection?: SettingsSectionId;
  }>(),
  {
    initialSection: 'channels',
  }
);

const emit = defineEmits<{
  'close': [];
  'saved': [];
}>();

// ==================== 分区注册表 ====================

interface SectionMeta {
  id: SettingsSectionId;
  nameKey: MessageKey;
  /** 导航隐藏（迁入的历史功能，代码保留便于后续启用） */
  hidden?: boolean;
}

const sections: ReadonlyArray<SectionMeta> = [
  { id: 'channels', nameKey: 'sidepanel.channels.nav' },
  { id: 'advanced', nameKey: 'sidepanel.apiConfig.advancedSettings' },
  { id: 'asr', nameKey: 'sidepanel.asr.navLabel' },
  { id: 'websites', nameKey: 'sidepanel.app.loggedInSites' },
  { id: 'files', nameKey: 'sidepanel.settings.tabFiles', hidden: true },
  { id: 'system', nameKey: 'sidepanel.settings.tabSystem', hidden: true },
];

/** 导航仅渲染可见分区 */
const visibleSections = computed(() => sections.filter(section => !section.hidden));

// ==================== 共享表单与上下文 ====================

const activeSection = ref<SettingsSectionId>('channels');
/** 打开纪元：每次弹窗打开自增，分区据此重新水合自身状态 */
const openEpoch = ref(0);

const settingsForm: SettingsFormApi = createSettingsForm({
  onSaved: () => emit('saved'),
});

provide(settingsFormKey, settingsForm);
provide(settingsModalContextKey, { activeSection, openEpoch });

// ==================== 语言切换 ====================

// 语言切换：core 为唯一事实源，switchLocale 立即生效并持久化到 chrome.storage，
// 其它扩展页面（含 content / background）经 storage.onChanged 自动跟随。
const { locale, switchLocale } = useLocale();
const localeOptions = LOCALE_OPTIONS;

// ==================== 打开 / 水合 ====================

/** 弹窗打开：水合共享表单、定位初始分区、广播 openEpoch 触发各分区自水合 */
function onOpen() {
  void settingsForm.hydrate();
  activeSection.value = props.initialSection;
  openEpoch.value++;
}

onMounted(onOpen);

// 每次打开弹窗都重新从存储水合，避免组件创建时的旧快照覆盖已保存配置
watch(
  () => props.visible,
  visible => {
    if (visible) onOpen();
  }
);

// ==================== 底部按钮 ====================

function handleCloseSidebar() {
  // 已配置时：仅关闭弹窗（返回）。
  // 判定直接读注册表的响应式 configured（单一事实源，随任何配置变更自动更新），
  // 不再依赖由异步水合赋值的快照——后者在快速打开/关闭时可能还是旧值，
  // 曾导致「配置好了还拒绝关闭」或误关整个侧边栏。
  emit('close');

  if (modelRegistry.configured) return;

  // 真正的首次未配置场景：维持原「关闭侧边栏」语义
  try {
    window.close();
  } catch {
    // 如果 window.close() 不生效（某些浏览器限制），什么都不做
  }
}

// Esc 关闭弹窗（与左上角 × 一致：仅关闭弹窗，不触碰侧边栏）
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.visible) {
    emit('close');
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));

// 打开更多设置独立页（智能体/技能/备份恢复管理；数据经跨上下文存储同步实时回流）
function openHub() {
  chrome.tabs.create({ url: chrome.runtime.getURL('hub.html') });
}
</script>
