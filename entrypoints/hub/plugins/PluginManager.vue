<template>
  <section class="plugin-center" :aria-busy="busy">
    <!-- 页头 -->
    <header class="pc-header">
      <span class="pc-header__icon" aria-hidden="true">
        <Puzzle :size="18" />
      </span>
      <div class="pc-header__text">
        <h2 class="pc-header__title">{{ t('hub.plugins.title') }}</h2>
        <p class="pc-header__intro">{{ t('hub.plugins.intro') }}</p>
      </div>
    </header>

    <PluginSkillUpdates />
    <!-- 成功 / 错误提示条 -->
    <PluginNoticeBar :notice="notice" @dismiss="dismissNotice()" />

    <!-- 全局安装工具栏（常驻：导入用 file input 需始终在 DOM 中） -->
    <div class="pc-toolbar">
      <label class="hub-btn pc-import">
        <Upload :size="14" aria-hidden="true" />
        {{ t('hub.plugins.importFile') }}
        <input
          type="file"
          accept=".anplugin"
          class="pc-file-input"
          :disabled="busy"
          @change="importFile"
        />
      </label>
      <button
        type="button"
        class="hub-btn"
        :disabled="busy"
        :title="busy ? t('hub.plugins.busyHint') : undefined"
        @click="run(load)"
      >
        <RefreshCw :size="14" :class="{ 'pc-spin': busy }" aria-hidden="true" />
        {{ t('hub.plugins.refresh') }}
      </button>
      <input
        v-model="repository"
        class="pc-repo-input"
        :placeholder="t('hub.plugins.ghPlaceholder')"
        :disabled="busy"
        @keyup.enter="repository && previewGithub(repository)"
      />
      <button
        type="button"
        class="hub-btn hub-btn-primary"
        :disabled="busy || !repository"
        @click="previewGithub(repository)"
      >
        <Github :size="14" aria-hidden="true" />
        {{ t('hub.plugins.ghInstall') }}
      </button>
    </div>

    <!-- 页内二级标签：已安装 / 发现 / 安装审查（待审查带琥珀角标） -->
    <nav class="pc-tabs" role="tablist" :aria-label="t('hub.plugins.title')">
      <button
        type="button"
        role="tab"
        class="pc-tab"
        :class="{ active: activeTab === 'installed' }"
        :aria-selected="activeTab === 'installed'"
        @click="goToTab('installed')"
      >
        <Package :size="14" aria-hidden="true" />
        <span>{{ t('hub.plugins.tabInstalled') }}</span>
        <span class="pc-tab__count">{{ installedTotal }}</span>
      </button>
      <button
        type="button"
        role="tab"
        class="pc-tab"
        :class="{ active: activeTab === 'discover' }"
        :aria-selected="activeTab === 'discover'"
        @click="goToTab('discover')"
      >
        <Compass :size="14" aria-hidden="true" />
        <span>{{ t('hub.plugins.tabDiscover') }}</span>
      </button>
      <button
        type="button"
        role="tab"
        class="pc-tab"
        :class="{ active: activeTab === 'review' }"
        :aria-selected="activeTab === 'review'"
        @click="goToTab('review')"
      >
        <ShieldCheck :size="14" aria-hidden="true" />
        <span>{{ t('hub.plugins.tabReview') }}</span>
        <span
          v-if="hasPendingReview && activeTab !== 'review'"
          class="pc-tab__dot"
          :title="t('hub.plugins.reviewBadge')"
        />
      </button>
      <button
        type="button"
        role="tab"
        class="pc-tab"
        :class="{ active: activeTab === 'operations' }"
        :aria-selected="activeTab === 'operations'"
        @click="goToTab('operations')"
      >
        <ClipboardList :size="14" aria-hidden="true" />
        <span>{{ t('hub.plugins.tabOperations') }}</span>
      </button>
    </nav>

    <!-- 分区内容 -->
    <div class="pc-body">
      <div
        v-show="activeTab === 'installed'"
        class="pc-panel"
        role="tabpanel"
        :aria-label="t('hub.plugins.tabInstalled')"
      >
        <PluginInstalledList />
      </div>
      <div
        v-show="activeTab === 'discover'"
        class="pc-panel"
        role="tabpanel"
        :aria-label="t('hub.plugins.tabDiscover')"
      >
        <PluginDiscoverPanel />
      </div>
      <div
        v-show="activeTab === 'review'"
        class="pc-panel"
        role="tabpanel"
        :aria-label="t('hub.plugins.tabReview')"
      >
        <PluginReviewPanel
          v-if="pending"
          :pending="pending"
          :consent="consent"
          :busy="busy"
          :pending-rollback="pendingRollback"
          @update:consent="consent = $event"
          @install="install()"
          @cancel="cancelReview()"
        />
        <p v-else class="pc-empty">{{ t('hub.plugins.reviewEmpty') }}</p>
      </div>
      <div
        v-show="activeTab === 'operations'"
        class="pc-panel"
        role="tabpanel"
        :aria-label="t('hub.plugins.tabOperations')"
      >
        <PluginOperationsPanel />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * 插件中心页面本体（UI 独占文件）：只负责骨架组装——页头、提示条、
 * 全局工具栏、页内二级标签与四个分区的装配；状态与命令全部来自
 * usePluginCenter 模块单例，大组件已按分区拆分到 ./components/。
 *
 * DOM 契约（tests/plugins/ui.test.ts，独立挂载）：
 * - input[type=file] 常驻且 busy 时 disabled；
 * - 预览成功自动切到「安装审查」，.review 内首个 button 为安装按钮；
 * - 确认安装后回到「已安装」标签，卡片可见（版本与发布者文案）。
 * 文案只走 utils/i18n 的模块级 t()（不依赖 i18n 插件挂载）。
 */
import { onMounted } from 'vue';
import {
  ClipboardList,
  Compass,
  Github,
  Package,
  Puzzle,
  RefreshCw,
  ShieldCheck,
  Upload,
} from 'lucide-vue-next';
import { t } from '@/utils/i18n';
import PluginNoticeBar from './components/PluginNoticeBar.vue';
import PluginReviewPanel from './components/PluginReviewPanel.vue';
import PluginDiscoverPanel from './components/PluginDiscoverPanel.vue';
import PluginInstalledList from './components/PluginInstalledList.vue';
import PluginSkillUpdates from './components/PluginSkillUpdates.vue';
import PluginOperationsPanel from './components/PluginOperationsPanel.vue';
import { usePluginCenter } from './composables/use-plugin-center';

const {
  busy,
  notice,
  repository,
  pending,
  consent,
  pendingRollback,
  activeTab,
  installedTotal,
  hasPendingReview,
  dismissNotice,
  goToTab,
  run,
  load,
  importFile,
  previewGithub,
  install,
  cancelReview,
  checkUpdates,
} = usePluginCenter();

// 挂载即刷新快照（与旧版一致：先对账存储，再展示）；
// 快照就绪后静默触发自动更新检查（后台 6 小时节流，失败无感）
onMounted(() => {
  void run(load).then(() => void checkUpdates());
});
</script>
