<template>
  <div class="pc-discover">
    <!-- 主搜索：输入即本地过滤官方目录；按钮/回车扩展到 GitHub 社区搜索 -->
    <div class="pc-discover__search">
      <input
        v-model="query"
        type="search"
        class="pc-discover__input"
        :placeholder="t('hub.plugins.searchPlaceholder')"
        :disabled="busy"
        @keyup.enter="query.trim() && search()"
      />
      <button
        type="button"
        class="hub-btn hub-btn-primary"
        :disabled="busy || !query.trim()"
        @click="search()"
      >
        <Search :size="14" aria-hidden="true" />
        {{ t('hub.plugins.communitySearchAction') }}
      </button>
    </div>
    <p class="pc-hint">{{ t('hub.plugins.searchDisclaimer') }}</p>

    <!-- 空态：按官方目录状态区分（加载失败不影响社区结果展示） -->
    <p v-if="!discoverResults.length" class="pc-empty">{{ emptyText }}</p>

    <div v-else class="pc-results">
      <article
        v-for="item in discoverResults"
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

    <!-- 自定义目录源（高级，默认折叠）：自托管签名目录场景 -->
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
  </div>
</template>

<script setup lang="ts">
/**
 * 发现分区：官方目录为主、GitHub 社区搜索为辅。
 * 搜索框输入即本地过滤目录条目（官方目录 URL/公钥内置，用户不可见）；
 * 按钮/回车显式扩展社区搜索，结果去重后追加（社区徽章）。
 * 自定义目录源（URL + 公钥）保留为折叠的高级入口。
 * 状态与命令取自 usePluginCenter 模块单例（与页面共享同一事实源）。
 */
import { computed } from 'vue';
import { Search } from 'lucide-vue-next';
import { t } from '@/utils/i18n';
import { usePluginCenter } from '../composables/use-plugin-center';

const {
  busy,
  query,
  discoverResults,
  catalogResults,
  communityResults,
  catalogState,
  discovered,
  catalogUrl,
  catalogKey,
  search,
  loadCatalog,
  previewGithub,
} = usePluginCenter();

/** 空态文案：目录失败 > 未部署引导 > 目录为空 > 无匹配 > 默认引导 */
const emptyText = computed(() => {
  if (catalogState.value === 'failed')
    return t('hub.plugins.officialCatalogFailed');
  if (catalogState.value === 'unconfigured')
    return t('hub.plugins.discoverEmpty');
  if (communityResults.value.length) return t('hub.plugins.searchNoResults');
  if (
    catalogState.value === 'ok' &&
    !query.value.trim() &&
    !catalogResults.value.length
  )
    return t('hub.plugins.officialCatalogEmpty');
  if (discovered.value && query.value.trim())
    return t('hub.plugins.searchNoResults');
  return t('hub.plugins.discoverEmpty');
});
</script>
