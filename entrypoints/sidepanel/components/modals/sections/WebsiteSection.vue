<template>
  <div class="website-settings">
    <!-- 标题与启用计数徽标 -->
    <div class="asr-section-header">
      <div class="asr-section-title">
        <h4>{{ t('sidepanel.app.loggedInSitesManage') }}</h4>
        <span class="asr-status-badge" :class="enabledCount > 0 ? 'ok' : 'warn'">
          {{ t('sidepanel.app.websiteEnabledCount', { count: enabledCount, total: websites.length }) }}
        </span>
      </div>
      <p class="config-form-hint">{{ t('sidepanel.app.websiteSectionHint') }}</p>
    </div>

    <!-- 站点开关列表（数据源：use-deep-search-sites 共享单例，跨会话持久化） -->
    <div class="website-settings-list">
      <div v-for="website in websites" :key="website.id" class="website-settings-item">
        <div class="website-settings-info">
          <img :src="website.icon" :alt="website.name" class="website-settings-logo" />
          <span class="website-settings-name">
            {{ website.labelKey ? t(website.labelKey) : website.name }}
          </span>
        </div>
        <label class="site-toggle">
          <input
            type="checkbox"
            :checked="website.enabled"
            @change="toggleWebsite(website)"
          />
          <span class="site-toggle-slider"></span>
        </label>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 已登录网站设置分区（Deep Search 站点开关）
 *
 * 数据流：状态为 use-deep-search-sites 的模块级单例——与 App.vue 发送装配
 * （deep-search 智能体按启用站点注入工具）共享同一份启用态，开关即时生效
 * 并持久化到 chrome.storage.local；本分区无本地状态，无需 openEpoch 水合。
 */
import { computed } from 'vue';
import { t } from '@/utils/i18n';
import { useDeepSearchSites, type WebsiteItem } from '../../../composables/use-deep-search-sites';

const { websites, setWebsiteEnabled } = useDeepSearchSites();

/** 已启用站点数（标题徽标展示） */
const enabledCount = computed(() => websites.value.filter(site => site.enabled).length);

/** 切换站点开关（写共享单例 + 持久化） */
const toggleWebsite = (website: WebsiteItem): void => {
  setWebsiteEnabled(website.id, !website.enabled);
};
</script>
