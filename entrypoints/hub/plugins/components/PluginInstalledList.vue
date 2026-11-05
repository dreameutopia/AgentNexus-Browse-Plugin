<template>
  <div class="pc-installed">
    <div class="pc-installed__bar">
      <input
        v-model="filter"
        type="search"
        class="pc-installed__filter"
        :placeholder="t('hub.plugins.filterPlaceholder')"
      />
      <span class="pc-installed__count">
        {{ t('hub.plugins.installedCount', { count: installedTotal }) }}
      </span>
    </div>

    <p v-if="installedTotal === 0" class="pc-empty">
      {{ t('hub.plugins.installedEmpty') }}
    </p>
    <p v-else-if="installed.length === 0" class="pc-empty">
      {{ t('hub.plugins.noMatches') }}
    </p>

    <div v-else class="pc-cards">
      <PluginInstalledCard
        v-for="plugin in installed"
        :key="plugin.key"
        :plugin="plugin"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 已安装分区：筛选条 + 计数 + 卡片网格 + 空态区分
 * （一个未装与筛选无匹配给出不同提示）。
 */
import { t } from '@/utils/i18n';
import { usePluginCenter } from '../composables/use-plugin-center';
import PluginInstalledCard from './PluginInstalledCard.vue';

const { filter, installed, installedTotal } = usePluginCenter();
</script>
