<template>
  <div class="pc-discover">
    <!-- 社区搜索 -->
    <div class="pc-discover__search">
      <input
        v-model="query"
        type="search"
        class="pc-discover__input"
        :placeholder="t('hub.plugins.searchPlaceholder')"
        :disabled="busy"
        @keyup.enter="search()"
      />
      <button
        type="button"
        class="hub-btn hub-btn-primary"
        :disabled="busy || !query.trim()"
        @click="search()"
      >
        <Search :size="14" aria-hidden="true" />
        {{ t('hub.plugins.searchAction') }}
      </button>
    </div>
    <p class="pc-hint">{{ t('hub.plugins.searchDisclaimer') }}</p>

    <!-- 已验证的签名目录（默认折叠，不打扰主流程） -->
    <details class="pc-catalog">
      <summary class="pc-catalog__summary">{{ t('hub.plugins.catalogTitle') }}</summary>
      <div class="pc-catalog__fields">
        <input
          v-model="catalogUrl"
          class="pc-catalog__input"
          :placeholder="t('hub.plugins.catalogUrlPlaceholder')"
          :disabled="busy"
        />
        <input
          v-model="catalogKey"
          class="pc-catalog__input"
          :placeholder="t('hub.plugins.catalogKeyPlaceholder')"
          :disabled="busy"
        />
        <button
          type="button"
          class="hub-btn"
          :disabled="busy || !catalogUrl || !catalogKey"
          @click="loadCatalog()"
        >
          {{ t('hub.plugins.catalogLoad') }}
        </button>
      </div>
    </details>

    <!-- 空态：未搜索给引导，搜索后无结果给提示 -->
    <p v-if="!results.length" class="pc-empty">
      {{
        discovered
          ? t('hub.plugins.searchNoResults')
          : t('hub.plugins.discoverEmpty')
      }}
    </p>

    <div v-else class="pc-results">
      <article
        v-for="item in results"
        :key="item.repository"
        class="pc-result"
      >
        <header class="pc-result__head">
          <strong class="pc-result__name">{{ item.name }}</strong>
          <span
            class="pc-badge"
            :class="item.verifiedCatalog ? 'is-signed' : 'is-community'"
          >
            {{
              item.verifiedCatalog
                ? t('hub.plugins.resultSigned')
                : t('hub.plugins.resultCommunity')
            }}
          </span>
        </header>
        <p v-if="item.description" class="pc-result__desc">
          {{ item.description }}
        </p>
        <footer class="pc-result__foot">
          <a
            class="pc-result__link"
            :href="item.repository"
            target="_blank"
            rel="noopener noreferrer"
            >{{ item.repository }}</a
          >
          <button
            type="button"
            class="hub-btn"
            :disabled="busy"
            @click="previewGithub(item.repository, undefined, item)"
          >
            {{ t('hub.plugins.reviewInstall') }}
          </button>
        </footer>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 发现分区：GitHub 社区搜索 + 已验证签名目录两条获取渠道与结果卡片。
 * 状态与命令取自 usePluginCenter 模块单例（与页面共享同一事实源）。
 */
import { Search } from 'lucide-vue-next';
import { t } from '@/utils/i18n';
import { usePluginCenter } from '../composables/use-plugin-center';

const {
  busy,
  query,
  results,
  discovered,
  catalogUrl,
  catalogKey,
  search,
  loadCatalog,
  previewGithub,
} = usePluginCenter();
</script>
