<template>
  <div class="hub-usage">
    <!-- ══════════ 头部：标题 / 状态 / 导出与清零 ══════════ -->
    <header class="hub-usage__head">
      <div class="hub-usage__head-main">
        <div class="hub-usage__title-row">
          <h2 class="hub-usage__title">{{ t('hub.usage.title') }}</h2>
          <span class="hub-badge" :class="snapshot.hydrated ? 'hub-usage-badge-ok' : 'hub-usage-badge-warn'">
            {{ snapshot.hydrated ? t('hub.usage.tracking') : t('common.loading') }}
          </span>
        </div>
        <p class="hub-hint">{{ t('hub.usage.subtitle') }}</p>
        <p class="hub-usage__meta">
          <span v-if="sinceLabel">{{ t('hub.usage.since') }} {{ sinceLabel }}</span>
          <span v-if="updatedLabel">{{ t('hub.usage.lastUpdated') }} {{ updatedLabel }}</span>
        </p>
      </div>
      <div class="hub-usage__head-actions">
        <button type="button" class="hub-btn" :disabled="!hasAnyData" :title="t('hub.usage.exportJson')" @click="exportJson">
          {{ t('hub.usage.exportJson') }}
        </button>
        <button type="button" class="hub-btn" :disabled="!hasAnyData" :title="t('hub.usage.exportCsv')" @click="exportCsv">
          {{ t('hub.usage.exportCsv') }}
        </button>
        <button type="button" class="hub-btn" :disabled="!hasAnyData" @click="copySummary">
          {{ copied ? t('hub.usage.copied') : t('hub.usage.copySummary') }}
        </button>
        <button
          type="button"
          class="hub-btn hub-usage-btn-danger"
          :class="{ 'is-armed': resetArmed }"
          :disabled="!hasAnyData"
          @click="onResetClick"
        >
          {{ resetArmed ? t('hub.usage.resetConfirm') : t('hub.usage.reset') }}
        </button>
      </div>
    </header>

    <!-- 空态 -->
    <div v-if="hasNoRequests" class="hub-usage__empty">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3M19 19H5V5H19V19M7 17H9V7H7V17M11 13C11 14.1 11.9 15 13 15H14.5C15.9 15 17 13.9 17 12.5C17 11.1 15.9 10 14.5 10H13C12.4 10 11.9 9.6 11.9 9C11.9 8.4 12.4 8 13 8H15V6H13C11.3 6 9.9 7.3 9.9 9S11.3 12 13 12H14.5C14.8 12 15 12.2 15 12.5C15 12.8 14.8 13 14.5 13H13C12.4 13 11.9 12.6 11.9 12H11C11 12.6 11 13 11 13Z" fill="currentColor" />
      </svg>
      <p>{{ t('hub.usage.empty') }}</p>
    </div>

    <template v-else>
      <!-- ══════════ 指标卡 ══════════ -->
      <section class="hub-usage__group">
        <h3 class="hub-usage__group-title">{{ t('hub.usage.requestGroup') }}</h3>
        <div class="hub-usage__cards hub-usage__cards--pair">
          <div class="hub-usage__card">
            <span class="hub-usage__card-label">{{ t('hub.usage.totalRequests') }}</span>
            <span class="hub-usage__card-value">{{ formatCount(snapshot.totals.requests) }}</span>
            <span class="hub-usage__card-sub">
              {{ t('hub.usage.successCount') }} {{ formatCount(snapshot.totals.success) }}
              · {{ t('hub.usage.failedCount') }} {{ formatCount(snapshot.totals.failed) }}
              <template v-if="snapshot.totals.aborted > 0">
                · {{ t('hub.usage.abortedCount') }} {{ formatCount(snapshot.totals.aborted) }}
              </template>
            </span>
          </div>
          <div class="hub-usage__card">
            <span class="hub-usage__card-label">{{ t('hub.usage.successRate') }}</span>
            <span class="hub-usage__card-value" :class="successRateClass">{{ successRateLabel }}</span>
            <span class="hub-usage__card-sub">{{ t('hub.usage.successRateHint') }}</span>
          </div>
        </div>
      </section>

      <section class="hub-usage__group">
        <h3 class="hub-usage__group-title">{{ t('hub.usage.tokenGroup') }}</h3>
        <div class="hub-usage__cards hub-usage__cards--quad">
          <div class="hub-usage__card">
            <span class="hub-usage__card-label">{{ t('hub.usage.totalTokens') }}</span>
            <span class="hub-usage__card-value">{{ formatTokens(snapshot.totals.totalTokens) }}</span>
            <span v-if="totals.haveTokens" class="hub-usage__card-sub">
              {{ t('hub.usage.inputTokens') }} {{ formatTokens(snapshot.totals.inputTokens) }}
              · {{ t('hub.usage.outputTokens') }} {{ formatTokens(snapshot.totals.outputTokens) }}
            </span>
          </div>
          <div class="hub-usage__card">
            <span class="hub-usage__card-label">{{ t('hub.usage.inputTokens') }}</span>
            <span class="hub-usage__card-value">{{ formatTokens(snapshot.totals.inputTokens) }}</span>
          </div>
          <div class="hub-usage__card">
            <span class="hub-usage__card-label">{{ t('hub.usage.outputTokens') }}</span>
            <span class="hub-usage__card-value">{{ formatTokens(snapshot.totals.outputTokens) }}</span>
            <span v-if="snapshot.totals.reasoningTokens > 0" class="hub-usage__card-sub">
              {{ t('hub.usage.reasoningTokens') }} {{ formatTokens(snapshot.totals.reasoningTokens) }}
            </span>
          </div>
          <div class="hub-usage__card">
            <span class="hub-usage__card-label">{{ t('hub.usage.cacheHitRate') }}</span>
            <span class="hub-usage__card-value">{{ cacheHitRateLabel }}</span>
            <span class="hub-usage__card-sub">
              {{ t('hub.usage.cacheHitDetail', { cached: formatTokens(snapshot.totals.cachedInputTokens), base: formatTokens(snapshot.totals.cacheEligibleInputTokens) }) }}
            </span>
          </div>
        </div>
      </section>

      <!-- ══════════ 筛选栏（模型 / 渠道 / 智能体 / 排序） ══════════ -->
      <section class="hub-usage__filters">
        <div class="hub-search hub-search--fill hub-usage__search">
          <svg class="hub-search__icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M11.1 10.2a4.6 4.6 0 1 0-.9.9l3 3 .9-.9-3-3zm-4.1.3a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z" fill="currentColor" />
          </svg>
          <input
            v-model.trim="query"
            type="search"
            class="hub-list-search"
            :placeholder="t('hub.usage.searchPlaceholder')"
            :aria-label="t('hub.usage.searchPlaceholder')"
          />
        </div>
        <HubSelect
          v-model="selectedChannel"
          class="hub-usage__select"
          :options="channelOptions"
          :aria-label="t('hub.usage.channelFilter')"
        />
        <HubSelect
          v-model="selectedModel"
          class="hub-usage__select"
          :options="modelOptions"
          :aria-label="t('hub.usage.modelFilter')"
        />
        <HubSelect
          v-model="selectedAgent"
          class="hub-usage__select"
          :options="agentOptions"
          :aria-label="t('hub.usage.agentFilter')"
        />
        <HubSegmented
          v-model="sortBy"
          class="hub-usage__sort"
          :options="sortOptions"
          :aria-label="t('hub.usage.sortBy')"
        />
        <button type="button" class="hub-btn" :disabled="!hasActiveFilter" @click="clearFilters">
          {{ t('hub.usage.clearFilters') }}
        </button>
        <span v-if="hasActiveFilter" class="hub-badge hub-usage-badge-neutral">
          {{ t('hub.usage.activeFilters', { count: activeFilterCount }) }}
        </span>
      </section>

      <!-- ══════════ 按协议聚合 ══════════ -->
      <section class="hub-usage__group">
        <div class="hub-usage__group-head">
          <h3 class="hub-usage__group-title">{{ t('hub.usage.providerGroup') }}</h3>
          <span class="hub-usage__group-hint">{{ t('hub.usage.providerGroupHint') }}</span>
        </div>
        <div v-if="providerStats.length" class="hub-usage__providers">
          <div v-for="entry in providerStats" :key="entry.provider" class="hub-usage__provider">
            <div class="hub-usage__provider-head">
              <span class="hub-usage__provider-name">{{ providerLabel(entry.provider) }}</span>
              <span class="hub-usage__provider-share">{{ percentLabel(entry.share) }}</span>
            </div>
            <div class="hub-usage__bar">
              <div class="hub-usage__bar-fill" :style="{ width: barWidth(entry.share) }"></div>
            </div>
            <div class="hub-usage__provider-meta">
              <span>{{ t('hub.usage.providerRequests') }} {{ formatCount(entry.requests) }}</span>
              <span>{{ t('hub.usage.providerTokens') }} {{ formatTokens(entry.totalTokens) }}</span>
            </div>
          </div>
        </div>
        <p v-else class="hub-hint">{{ t('hub.usage.noMatch') }}</p>
      </section>

      <!-- ══════════ 模型占比 ══════════ -->
      <section class="hub-usage__group">
        <div class="hub-usage__group-head">
          <h3 class="hub-usage__group-title">{{ t('hub.usage.modelShare') }}</h3>
          <span class="hub-usage__group-hint">{{ t('hub.usage.modelShareHint') }}</span>
        </div>
        <div v-if="modelRows.length" class="hub-usage__rows">
          <div
            v-for="entry in modelRows"
            :key="JSON.stringify([entry.provider, entry.channelId, entry.modelId, entry.model])"
            class="hub-usage__row"
          >
            <div class="hub-usage__row-head">
              <span class="hub-usage__row-name" :title="entry.model">{{ entry.model }}</span>
              <span class="hub-badge hub-usage-badge-neutral">{{ providerLabel(entry.provider) }}</span>
              <span class="hub-usage__row-share">{{ percentLabel(entry.share) }}</span>
              <span class="hub-usage__row-tokens">{{ formatTokens(entry.totalTokens) }}</span>
            </div>
            <div class="hub-usage__bar">
              <div class="hub-usage__bar-fill" :style="{ width: barWidth(entry.share) }"></div>
            </div>
            <div class="hub-usage__row-meta">
              <span>{{ entry.channelLabel || t('hub.usage.legacyChannel') }}</span>
              <span>{{ t('hub.usage.totalRequests') }} {{ formatCount(entry.requests) }}</span>
              <span>{{ t('hub.usage.successRate') }} {{ modelSuccessRate(entry) }}</span>
              <span>{{ t('hub.usage.inputTokens') }} {{ formatTokens(entry.inputTokens) }}</span>
              <span>{{ t('hub.usage.outputTokens') }} {{ formatTokens(entry.outputTokens) }}</span>
              <span>{{ t('hub.usage.cacheHitRate') }} {{ cacheRatio(entry) }}</span>
              <span>{{ t('hub.usage.cacheRequestRate') }} {{ cacheRequestRatio(entry) }}</span>
              <span>{{ t('hub.usage.continuationCache') }} {{ continuationRatio(entry) }}</span>
            </div>
          </div>
        </div>
        <p v-else class="hub-hint">{{ t('hub.usage.noMatch') }}</p>
      </section>

      <!-- ══════════ 详细数据（按渠道 / 模型 / 智能体分组卡片） ══════════ -->
      <section class="hub-usage__group">
        <div class="hub-usage__group-head">
          <h3 class="hub-usage__group-title">{{ t('hub.usage.cacheDiagnostics') }}</h3>
          <HubSegmented
            v-model="detailDimension"
            class="hub-usage__dimension"
            :options="dimensionOptions"
            :aria-label="t('hub.usage.detailDimension')"
          />
        </div>
        <p class="hub-hint">{{ t('hub.usage.cacheExplanation') }}</p>
        <div v-if="detailCards.length" class="hub-usage__detail-scroll">
          <div class="hub-usage__detail-grid">
            <article v-for="card in detailCards" :key="card.key" class="hub-usage__detail-card">
              <div class="hub-usage__detail-card-head">
                <span class="hub-usage__detail-card-name" :title="card.label">{{ card.label }}</span>
                <span class="hub-usage__detail-card-tokens">{{ formatTokens(card.totalTokens) }}</span>
              </div>
              <div class="hub-usage__bar">
                <div class="hub-usage__bar-fill" :style="{ width: barWidth(card.share) }"></div>
              </div>
              <div class="hub-usage__detail-metrics">
                <div class="hub-usage__detail-metric">
                  <span class="hub-usage__detail-metric-label" :title="t('hub.usage.cacheHitRate')">
                    {{ t('hub.usage.cacheHitRate') }}
                  </span>
                  <span class="hub-usage__detail-metric-value">{{ cacheRatio(card) }}</span>
                </div>
                <div class="hub-usage__detail-metric">
                  <span class="hub-usage__detail-metric-label" :title="t('hub.usage.cacheRequestRate')">
                    {{ t('hub.usage.cacheRequestRate') }}
                  </span>
                  <span class="hub-usage__detail-metric-value">{{ cacheRequestRatio(card) }}</span>
                </div>
                <div class="hub-usage__detail-metric">
                  <span class="hub-usage__detail-metric-label" :title="t('hub.usage.continuationCache')">
                    {{ t('hub.usage.continuationCache') }}
                  </span>
                  <span class="hub-usage__detail-metric-value">{{ continuationRatio(card) }}</span>
                </div>
                <div class="hub-usage__detail-metric">
                  <span class="hub-usage__detail-metric-label">{{ t('hub.usage.totalRequests') }}</span>
                  <span class="hub-usage__detail-metric-value">{{ formatCount(card.requests) }}</span>
                </div>
              </div>
              <div class="hub-usage__detail-card-foot">
                <span>{{ t('hub.usage.cacheHitDetail', { cached: formatTokens(card.cachedInputTokens), base: formatTokens(card.cacheEligibleInputTokens) }) }}</span>
                <span>{{ t('hub.usage.successRate') }} {{ modelSuccessRate(card) }}</span>
              </div>
            </article>
          </div>
        </div>
        <p v-else class="hub-hint">{{ t('hub.usage.noMatch') }}</p>
      </section>

      <!-- ══════════ 请求明细 + 最近失败（宽屏左右并排，限高滚动） ══════════ -->
      <div class="hub-usage__split" :class="{ 'is-solo': !snapshot.recentErrors.length }">
        <section class="hub-usage__group">
          <div class="hub-usage__group-head">
            <h3 class="hub-usage__group-title">{{ t('hub.usage.requestLog') }}</h3>
            <span class="hub-usage__group-hint">{{ t('hub.usage.recentRequests') }}</span>
          </div>
          <div v-if="filteredRequests.length" class="hub-usage__scroll">
            <div class="hub-usage__rows">
              <div v-for="(entry, index) in filteredRequests" :key="`${entry.at}:${index}`" class="hub-usage__row">
                <div class="hub-usage__row-head">
                  <span class="hub-usage__row-name" :title="entry.model">{{ entry.model }}</span>
                  <span class="hub-usage__tag" :class="outcomeTagClass(entry.outcome)">{{ outcomeLabel(entry.outcome) }}</span>
                  <span class="hub-usage__row-time">{{ formatTime(entry.at) }}</span>
                </div>
                <div class="hub-usage__row-meta">
                  <span>{{ entry.channelLabel || t('hub.usage.legacyChannel') }}</span>
                  <span>{{ entry.agentId || t('hub.usage.otherRequests') }}</span>
                  <span>{{ kindLabel(entry.kind) }}</span>
                  <span v-if="entry.runId">{{ entry.runId.slice(-8) }} #{{ entry.iteration }}</span>
                  <span>{{ t('hub.usage.inputTokens') }} {{ entry.usage?.inputTokens ?? '—' }}</span>
                  <span>{{ t('hub.usage.cachedTokens') }} {{ entry.usage?.cachedInputTokens ?? '—' }}</span>
                  <span
                    v-if="entry.iteration"
                    class="hub-usage__tag"
                    :class="prefixTagClass(entry)"
                  >{{ prefixLabel(entry) }}</span>
                  <span v-if="entry.trimmed || entry.compacted" class="hub-usage__tag hub-usage__tag--warn">
                    {{ t('hub.usage.contextChanged') }}
                  </span>
                </div>
              </div>
            </div>
          </div>
          <p v-else class="hub-hint">{{ t('hub.usage.noMatch') }}</p>
        </section>

        <section v-if="snapshot.recentErrors.length" class="hub-usage__group">
          <div class="hub-usage__group-head">
            <h3 class="hub-usage__group-title">{{ t('hub.usage.recentErrors') }}</h3>
            <span class="hub-usage__group-hint">{{ t('hub.usage.recentErrorsHint') }}</span>
          </div>
          <div class="hub-usage__scroll">
            <ul class="hub-usage__errors">
              <li v-for="(err, index) in snapshot.recentErrors" :key="`${err.at}-${index}`" class="hub-usage__error">
                <span class="hub-usage__error-time">{{ formatTime(err.at) }}</span>
                <span v-if="err.provider" class="hub-usage__error-provider">{{ providerLabel(err.provider) }}</span>
                <span class="hub-usage__error-model">[{{ err.model }}]</span>
                <span class="hub-usage__error-summary">{{ err.summary }}</span>
              </li>
            </ul>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 管理中心「使用监控」分区 —— AI 用量指标的实时只读视图
 *
 * 数据来源：aiUsageMetrics 引擎（订阅实时刷新；record / reset / 跨上下文存储变更均触发）。
 * 本组件零业务逻辑：格式化 + 渲染；清零操作带两步确认（3 秒内二次点击生效，防误触）。
 *
 * 与原「设置弹窗 · 使用监控」的差异（只增不减）：
 *   - 顶部指标卡按「请求 / Token」两组重排为管理中心玻璃卡；
 *   - 筛选栏统一作用于模型占比、详细数据与请求明细三张表（原仅后两张）；
 *   - 新增按协议聚合视图、排序切换（Token / 请求数 / 占比 / 成功率）；
 *   - 详细数据支持按渠道 / 模型 / 智能体切换聚合维度，每组一张卡片；
 *   - 请求明细与失败原因宽屏左右并排、限高滚动，缓存状态以标签呈现；
 *   - 新增 JSON / CSV 导出与摘要复制；
 *   - 顶部展示「最近更新」时间戳，让实时同步状态可见。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { t, useLocale } from '@/utils/i18n';
import { aiUsageMetrics } from '../../sidepanel/utils/metrics/usage-metrics-engine';
import type {
  UsageMetricsSnapshot,
  ModelUsageMetrics,
  UsageCounters,
  UsageOutcome,
  UsageRequestKind,
  UsageRequestDetail,
} from '../../sidepanel/utils/metrics/usage-metrics-types';
import { createEmptyCounters } from '../../sidepanel/utils/metrics/usage-metrics-types';
import { driverRegistry } from '../../sidepanel/utils/stream/driver-registry';
import type { ProviderType } from '../../sidepanel/utils/stream/types';
import HubSelect from '../components/HubSelect.vue';
import HubSegmented from '../components/HubSegmented.vue';

const { locale } = useLocale();

// ==================== 引擎订阅 ====================

const snapshot = ref<UsageMetricsSnapshot>(aiUsageMetrics.getSnapshot());
const query = ref('');
const selectedChannel = ref('*');
const selectedModel = ref('*');
const selectedAgent = ref('*');
const sortBy = ref<'tokens' | 'requests' | 'share' | 'success'>('tokens');
/** 详细数据分组维度：渠道 / 模型 / 智能体（仅影响详细数据卡片的聚合方式） */
const detailDimension = ref<'channel' | 'model' | 'agent'>('channel');

const sortOptions = computed(() => [
  { value: 'tokens', label: t('hub.usage.sortTokens') },
  { value: 'requests', label: t('hub.usage.sortRequests') },
  { value: 'share', label: t('hub.usage.sortShare') },
  { value: 'success', label: t('hub.usage.sortSuccessRate') },
]);

const dimensionOptions = computed(() => [
  { value: 'channel', label: t('hub.usage.byChannel') },
  { value: 'model', label: t('hub.usage.byModel') },
  { value: 'agent', label: t('hub.usage.byAgent') },
]);

const channelOptions = computed(() => [
  { value: '*', label: t('hub.usage.allChannels') },
  ...[...new Map(snapshot.value.scopes.map(e => [e.channelId ?? '', { id: e.channelId ?? '', label: e.channelLabel || t('hub.usage.legacyChannel') }])).values()]
    .map(item => ({ value: item.id, label: item.label })),
]);
const modelOptions = computed(() => [
  { value: '*', label: t('hub.usage.allModels') },
  ...[...new Set(snapshot.value.scopes.map(e => e.model))].sort().map(model => ({ value: model, label: model })),
]);
const agentOptions = computed(() => [
  { value: '*', label: t('hub.usage.allAgents') },
  ...[...new Set(snapshot.value.scopes.map(e => e.agentId ?? ''))].sort().map(agent => ({ value: agent, label: agent || t('hub.usage.otherRequests') })),
]);

/** 文本搜索：命中模型名 / 渠道名 / 智能体名（不区分大小写） */
function matchesQuery(e: { model: string; channelLabel?: string; agentId?: string; provider?: string }): boolean {
  const needle = query.value.toLowerCase();
  if (!needle) return true;
  return [e.model, e.channelLabel ?? '', e.agentId ?? '', e.provider ?? '']
    .some(field => field.toLowerCase().includes(needle));
}

function matchesScope(e: { channelId?: string; model: string; agentId?: string }): boolean {
  return (selectedChannel.value === '*' || (e.channelId ?? '') === selectedChannel.value) &&
    (selectedModel.value === '*' || e.model === selectedModel.value) &&
    (selectedAgent.value === '*' || (e.agentId ?? '') === selectedAgent.value);
}

/** 模型占比表（受全部筛选条件约束） */
const filteredModels = computed(() =>
  snapshot.value.models.filter(entry => matchesScope(entry) && matchesQuery(entry)),
);

/** 维度明细表（详细数据卡片的数据源；按渠道 / 模型 / 智能体 + 文本搜索） */
const filteredScopes = computed(() =>
  snapshot.value.scopes.filter(entry => matchesScope(entry) && matchesQuery(entry)),
);

/** 请求明细（同样受筛选约束） */
const filteredRequests = computed(() =>
  snapshot.value.recentRequests.filter(entry => matchesScope(entry) && matchesQuery(entry)),
);

// ==================== 详细数据（按维度聚合的卡片） ====================

/** 一张聚合卡片 = 单个渠道 / 模型 / 智能体的全部计数器 + 展示字段 */
interface DetailCard extends UsageCounters {
  key: string;
  label: string;
  share: number;
}

const COUNTER_KEYS = Object.keys(createEmptyCounters()) as (keyof UsageCounters)[];

/**
 * 按所选维度聚合筛选后的 scope：
 *   - 渠道：同一 channelId 的多模型 / 多智能体合并；
 *   - 模型：同名模型跨渠道合并；
 *   - 智能体：同一智能体的多渠道合并（空智能体归入「其他请求」）。
 * 占比基于聚合后小计重算，与模型占比表同口径。
 */
const detailCards = computed<DetailCard[]>(() => {
  const dimension = detailDimension.value;
  const map = new Map<string, DetailCard>();
  for (const entry of filteredScopes.value) {
    const key =
      dimension === 'channel' ? (entry.channelId ?? '') :
      dimension === 'model' ? entry.model :
      (entry.agentId ?? '');
    const label =
      dimension === 'channel' ? (entry.channelLabel || t('hub.usage.legacyChannel')) :
      dimension === 'model' ? entry.model :
      (entry.agentId || t('hub.usage.otherRequests'));
    let card = map.get(key);
    if (!card) {
      card = { key, label, share: 0, ...createEmptyCounters() };
      map.set(key, card);
    }
    for (const counterKey of COUNTER_KEYS) card[counterKey] += entry[counterKey] ?? 0;
  }
  const cards = [...map.values()];
  const subtotal = cards.reduce((sum, card) => sum + card.totalTokens, 0);
  return cards
    .map(card => ({ ...card, share: subtotal > 0 ? card.totalTokens / subtotal : 0 }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests || a.label.localeCompare(b.label));
});

/**
 * 占比基于「当前筛选后的小计」重算——筛选后仍显示全局占比会误导
 * （用户以为看的是全局，实际只筛了一部分）。
 */
const modelRows = computed(() => {
  const rows = filteredModels.value;
  const subtotal = rows.reduce((sum, entry) => sum + entry.totalTokens, 0);
  return rows
    .map(entry => ({ ...entry, share: subtotal > 0 ? entry.totalTokens / subtotal : 0 }))
    .sort((a, b) => compareRows(a, b));
});

/** 排序：按当前排序列降序，同列同值时以模型名兜底（保证顺序稳定） */
function compareRows(a: ModelUsageMetrics & { share: number }, b: ModelUsageMetrics & { share: number }): number {
  switch (sortBy.value) {
    case 'requests':
      return b.requests - a.requests || a.model.localeCompare(b.model);
    case 'share':
      return b.share - a.share || a.model.localeCompare(b.model);
    case 'success': {
      const rateA = a.success + a.failed > 0 ? a.success / (a.success + a.failed) : -1;
      const rateB = b.success + b.failed > 0 ? b.success / (b.success + b.failed) : -1;
      return rateB - rateA || a.model.localeCompare(b.model);
    }
    default:
      return b.totalTokens - a.totalTokens || a.model.localeCompare(b.model);
  }
}

/** 按协议聚合（同样受筛选约束） */
const providerStats = computed(() => {
  const map = new Map<string, { provider: string; requests: number; totalTokens: number }>();
  for (const entry of filteredModels.value) {
    const current = map.get(entry.provider) ?? { provider: entry.provider, requests: 0, totalTokens: 0 };
    current.requests += entry.requests;
    current.totalTokens += entry.totalTokens;
    map.set(entry.provider, current);
  }
  const rows = [...map.values()];
  const subtotal = rows.reduce((sum, row) => sum + row.totalTokens, 0);
  return rows
    .map(row => ({ ...row, share: subtotal > 0 ? row.totalTokens / subtotal : 0 }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests);
});

/** 生效中的筛选条件数量（用于「N 项筛选生效」徽标） */
const activeFilterCount = computed(() => {
  let count = 0;
  if (selectedChannel.value !== '*') count++;
  if (selectedModel.value !== '*') count++;
  if (selectedAgent.value !== '*') count++;
  if (query.value) count++;
  return count;
});
const hasActiveFilter = computed(() => activeFilterCount.value > 0);

function clearFilters(): void {
  query.value = '';
  selectedChannel.value = '*';
  selectedModel.value = '*';
  selectedAgent.value = '*';
}

let unsubscribe: (() => void) | undefined;
let disarmTimer: ReturnType<typeof setTimeout> | undefined;

onMounted(() => {
  unsubscribe = aiUsageMetrics.subscribe(next => {
    snapshot.value = next;
  });
});

onUnmounted(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  if (disarmTimer !== undefined) clearTimeout(disarmTimer);
});

// ==================== 派生态 ====================

/** 空态仅在数据水合完成后呈现（避免加载瞬间闪现「暂无数据」） */
const hasNoRequests = computed(
  () => snapshot.value.hydrated && snapshot.value.totals.requests === 0
);
const hasAnyData = computed(() => snapshot.value.totals.requests > 0);

const totals = computed(() => {
  const s = snapshot.value.totals;
  return {
    haveTokens: s.totalTokens > 0,
  };
});

/** 成功率 = 成功 / (成功 + 失败)；中止不计入分母（用户主动行为，非质量信号） */
const successRateLabel = computed(() => {
  const { success, failed } = snapshot.value.totals;
  const rated = success + failed;
  if (rated === 0) return '—';
  return percentLabel(success / rated);
});

const successRateClass = computed(() => {
  const { success, failed } = snapshot.value.totals;
  const rated = success + failed;
  if (rated === 0) return '';
  const rate = success / rated;
  if (rate >= 0.95) return 'is-good';
  if (rate >= 0.8) return 'is-warn';
  return 'is-bad';
});

/** 缓存命中率 = 命中输入 token / 上报了缓存信息的输入 token；无上报显示 — */
const cacheHitRateLabel = computed(() => {
  const { cachedInputTokens, cacheEligibleInputTokens } = snapshot.value.totals;
  if (cacheEligibleInputTokens <= 0) return '—';
  return percentLabel(cachedInputTokens / cacheEligibleInputTokens);
});

const sinceLabel = computed(() => {
  const startedAt = snapshot.value.startedAt;
  if (!startedAt) return '';
  return formatTime(startedAt);
});

const updatedLabel = computed(() => {
  const updatedAt = snapshot.value.updatedAt;
  if (!updatedAt) return '';
  return formatTime(updatedAt);
});

// ==================== 清零（两步确认） ====================

const resetArmed = ref(false);

function onResetClick(): void {
  if (!resetArmed.value) {
    resetArmed.value = true;
    disarmTimer = setTimeout(() => {
      resetArmed.value = false;
    }, 3000);
    return;
  }
  clearTimeout(disarmTimer);
  resetArmed.value = false;
  aiUsageMetrics.reset();
}

// ==================== 导出与复制 ====================

/** 触发浏览器下载（文本内容 + MIME） */
function downloadText(content: string, filename: string, mime: string): void {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    console.warn('[Hub] 用量报告导出失败:', error);
  }
}

function stamp(): string {
  const date = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 导出完整快照（JSON）：总账 + 模型 + 分渠道明细 + 请求日志 + 失败摘要 */
function exportJson(): void {
  if (!hasAnyData.value) return;
  const payload = {
    exportedAt: new Date().toISOString(),
    startedAt: snapshot.value.startedAt,
    updatedAt: snapshot.value.updatedAt,
    totals: snapshot.value.totals,
    models: modelRows.value,
    scopes: filteredScopes.value,
    recentRequests: filteredRequests.value,
    recentErrors: snapshot.value.recentErrors,
  };
  downloadText(JSON.stringify(payload, null, 2), `agentnexus-usage-${stamp()}.json`, 'application/json;charset=utf-8');
}

/** CSV 单元格转义（引号 / 逗号 / 换行） */
function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 导出当前筛选后的聚合明细（CSV）：一行一个「模型 × 渠道 × 智能体」条目 */
function exportCsv(): void {
  if (!hasAnyData.value) return;
  const header = [
    'model', 'provider', 'channel', 'agent', 'kind',
    'requests', 'success', 'failed', 'aborted',
    'input_tokens', 'output_tokens', 'total_tokens', 'cached_input_tokens',
    'cache_eligible_input_tokens', 'cache_hit_requests', 'cache_observed_requests',
    'continuation_input_tokens', 'continuation_cached_tokens', 'token_share',
  ];
  const rows = filteredScopes.value.map(entry => [
    entry.model,
    entry.provider,
    entry.channelLabel || '',
    entry.agentId || '',
    entry.requestKind || '',
    entry.requests, entry.success, entry.failed, entry.aborted,
    entry.inputTokens, entry.outputTokens, entry.totalTokens, entry.cachedInputTokens,
    entry.cacheEligibleInputTokens, entry.cacheHitRequests, entry.cacheObservedRequests,
    entry.continuationInputTokens, entry.continuationCachedTokens,
    modelRows.value.find(row => row.model === entry.model)?.share ?? 0,
  ]);
  const content = [header, ...rows]
    .map(row => row.map(csvCell).join(','))
    .join('\r\n');
  downloadText(`﻿${content}`, `agentnexus-usage-${stamp()}.csv`, 'text/csv;charset=utf-8');
}

/** 复制文本摘要到剪贴板 */
const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

async function copySummary(): Promise<void> {
  if (!hasAnyData.value) return;
  const s = snapshot.value.totals;
  const lines = [
    `${t('hub.usage.title')} · ${sinceLabel.value ? `${t('hub.usage.since')} ${sinceLabel.value}` : ''}`,
    `${t('hub.usage.totalRequests')}: ${s.requests} (${t('hub.usage.successCount')} ${s.success} / ${t('hub.usage.failedCount')} ${s.failed} / ${t('hub.usage.abortedCount')} ${s.aborted})`,
    `${t('hub.usage.successRate')}: ${successRateLabel.value}`,
    `${t('hub.usage.totalTokens')}: ${s.totalTokens} (${t('hub.usage.inputTokens')} ${s.inputTokens} / ${t('hub.usage.outputTokens')} ${s.outputTokens})`,
    `${t('hub.usage.cacheHitRate')}: ${cacheHitRateLabel.value}`,
  ];
  if (modelRows.value.length) {
    lines.push(`${t('hub.usage.modelShare')}:`);
    for (const entry of modelRows.value.slice(0, 5)) {
      lines.push(`  - ${entry.model} · ${percentLabel(entry.share)} · ${formatTokens(entry.totalTokens)}`);
    }
  }
  if (snapshot.value.recentErrors.length) {
    lines.push(`${t('hub.usage.recentErrors')}: ${snapshot.value.recentErrors.length}`);
  }
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    if (copyTimer !== undefined) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied.value = false; }, 2000);
  } catch (error) {
    copied.value = false;
    console.warn('[Hub] 用量摘要复制失败:', error);
  }
}

// ==================== 格式化 ====================

/** 整数千分位 */
function formatCount(value: number): string {
  try {
    return value.toLocaleString(locale.value === 'zh-CN' ? 'zh-CN' : 'en-US');
  } catch {
    return String(value);
  }
}

/** token 数量：大数紧凑表示（12,345 → 1.2万 / 12.3K） */
function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  try {
    const tag = locale.value === 'zh-CN' ? 'zh-CN' : 'en-US';
    return new Intl.NumberFormat(tag, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  } catch {
    return value >= 10000 ? `${(value / 10000).toFixed(1)}w` : String(value);
  }
}

/** 占比百分数（0~100，保留 1 位小数） */
function percentLabel(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  const pct = ratio * 100;
  return `${pct >= 99.95 ? 100 : pct.toFixed(1)}%`;
}

/** 占比条宽度（最小可见宽度 2%，有数据时） */
function barWidth(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  return `${Math.max(ratio * 100, 2)}%`;
}

/** 时间：同日显示 HH:mm，跨日显示 M/D HH:mm */
function formatTime(timestamp: number): string {
  if (!timestamp) return '';
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    const tag = locale.value === 'zh-CN' ? 'zh-CN' : 'en-US';
    return new Intl.DateTimeFormat(tag, {
      ...(sameDay ? {} : { month: 'numeric', day: 'numeric' }),
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return '';
  }
}

/** 模型成功率（分母为 0 时显示 —） */
function modelSuccessRate(entry: UsageCounters): string {
  const rated = entry.success + entry.failed;
  if (rated === 0) return '—';
  return percentLabel(entry.success / rated);
}

function cacheRatio(e: UsageCounters): string {
  return e.cacheEligibleInputTokens > 0 ? percentLabel(e.cachedInputTokens / e.cacheEligibleInputTokens) : '—';
}

function cacheRequestRatio(e: UsageCounters): string {
  return e.cacheObservedRequests > 0 ? percentLabel(e.cacheHitRequests / e.cacheObservedRequests) : '—';
}

function continuationRatio(e: UsageCounters): string {
  return e.continuationInputTokens > 0 ? percentLabel(e.continuationCachedTokens / e.continuationInputTokens) : '—';
}

// ==================== 请求明细标签 ====================

/** 结局标签文案（成功 / 失败 / 已取消） */
function outcomeLabel(outcome: UsageOutcome): string {
  if (outcome === 'success') return t('hub.usage.outcomeSuccess');
  if (outcome === 'failed') return t('hub.usage.outcomeFailed');
  return t('hub.usage.outcomeAborted');
}

/** 结局标签配色：语义色仅用于状态表达（成功绿 / 失败红 / 取消中性） */
function outcomeTagClass(outcome: UsageOutcome): string {
  if (outcome === 'success') return 'hub-usage__tag--good';
  if (outcome === 'failed') return 'hub-usage__tag--bad';
  return 'hub-usage__tag--neutral';
}

/** 请求类别文案（对话 / 连通测试 / 语音识别 / 上下文压缩） */
function kindLabel(kind: UsageRequestKind): string {
  if (kind === 'chat') return t('hub.usage.kindChat');
  if (kind === 'probe') return t('hub.usage.kindProbe');
  if (kind === 'asr') return t('hub.usage.kindAsr');
  return t('hub.usage.kindCompaction');
}

/**
 * 缓存状态标签：首轮（无从对比）/ 缓存失效（前缀变短，旧缓存作废）/
 * 缓存命中（前缀稳定，可复用缓存）。文案面向使用者，不暴露「前缀」术语。
 */
function prefixLabel(entry: UsageRequestDetail): string {
  if (!entry.iteration) return '';
  if (entry.iteration === 1) return t('hub.usage.firstRound');
  return entry.prefixChanged ? t('hub.usage.prefixChanged') : t('hub.usage.prefixStable');
}

function prefixTagClass(entry: UsageRequestDetail): string {
  if (!entry.iteration || entry.iteration === 1) return 'hub-usage__tag--neutral';
  return entry.prefixChanged ? 'hub-usage__tag--warn' : 'hub-usage__tag--good';
}

/** 协议标签：已注册协议用驱动展示名，其余（如 asr）原样展示 */
function providerLabel(provider: string): string {
  const meta = driverRegistry.tryGet(provider as ProviderType)?.meta;
  if (meta?.label) return meta.label;
  if (provider === 'asr') return t('hub.usage.asrProviderLabel');
  return provider;
}
</script>

<style>
@import './usage-section.css';
</style>
