<template>
  <div class="usage-section">
    <!-- 标题与操作 -->
    <div class="usage-section-header">
      <div class="usage-section-title">
        <h4>{{ t('sidepanel.metrics.title') }}</h4>
        <span class="usage-status-badge" :class="snapshot.hydrated ? 'ok' : 'loading'">
          {{ snapshot.hydrated ? t('sidepanel.metrics.tracking') : t('common.loading') }}
        </span>
      </div>
      <p class="config-form-hint">{{ t('sidepanel.metrics.subtitle') }}</p>
      <div class="usage-header-actions">
        <span v-if="sinceLabel" class="usage-since">{{ t('sidepanel.metrics.since') }} {{ sinceLabel }}</span>
        <button
          type="button"
          class="usage-reset-btn"
          :class="{ armed: resetArmed }"
          :disabled="!hasAnyData"
          @click="onResetClick"
        >
          {{ resetArmed ? t('sidepanel.metrics.resetConfirm') : t('sidepanel.metrics.reset') }}
        </button>
      </div>
    </div>

    <!-- 空态 -->
    <div v-if="hasNoRequests" class="usage-empty">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3M19 19H5V5H19V19M7 17H9V7H7V17M11 13C11 14.1 11.9 15 13 15H14.5C15.9 15 17 13.9 17 12.5C17 11.1 15.9 10 14.5 10H13C12.4 10 11.9 9.6 11.9 9C11.9 8.4 12.4 8 13 8H15V6H13C11.3 6 9.9 7.3 9.9 9S11.3 12 13 12H14.5C14.8 12 15 12.2 15 12.5C15 12.8 14.8 13 14.5 13H13C12.4 13 11.9 12.6 11.9 12H11C11 12.6 11 13 11 13Z" fill="currentColor"/>
      </svg>
      <p>{{ t('sidepanel.metrics.empty') }}</p>
    </div>

    <template v-else>
      <!-- 请求指标 -->
      <div class="usage-group-title">{{ t('sidepanel.metrics.requestGroup') }}</div>
      <div class="usage-cards">
        <div class="usage-card usage-card-wide">
          <span class="usage-card-label">{{ t('sidepanel.metrics.totalRequests') }}</span>
          <span class="usage-card-value">{{ formatCount(snapshot.totals.requests) }}</span>
          <span class="usage-card-sub">
            {{ t('sidepanel.metrics.successCount') }} {{ formatCount(snapshot.totals.success) }}
            · {{ t('sidepanel.metrics.failedCount') }} {{ formatCount(snapshot.totals.failed) }}
            <template v-if="snapshot.totals.aborted > 0">
              · {{ t('sidepanel.metrics.abortedCount') }} {{ formatCount(snapshot.totals.aborted) }}
            </template>
          </span>
        </div>
        <div class="usage-card usage-card-accent">
          <span class="usage-card-label">{{ t('sidepanel.metrics.successRate') }}</span>
          <span class="usage-card-value" :class="successRateClass">{{ successRateLabel }}</span>
          <span class="usage-card-sub">
            {{ t('sidepanel.metrics.successCount') }} / {{ t('sidepanel.metrics.ratedTotal') }}
            {{ formatCount(snapshot.totals.success + snapshot.totals.failed) }}
          </span>
        </div>
      </div>

      <!-- Token 指标 -->
      <div class="usage-group-title">{{ t('sidepanel.metrics.tokenGroup') }}</div>
      <div class="usage-cards">
        <div class="usage-card usage-card-accent">
          <span class="usage-card-label">{{ t('sidepanel.metrics.totalTokens') }}</span>
          <span class="usage-card-value">{{ formatTokens(snapshot.totals.totalTokens) }}</span>
          <span v-if="totals.haveTokens" class="usage-card-sub">
            {{ t('sidepanel.metrics.inputTokens') }} {{ formatTokens(snapshot.totals.inputTokens) }}
            · {{ t('sidepanel.metrics.outputTokens') }} {{ formatTokens(snapshot.totals.outputTokens) }}
          </span>
        </div>
        <div class="usage-card">
          <span class="usage-card-label">{{ t('sidepanel.metrics.inputTokens') }}</span>
          <span class="usage-card-value">{{ formatTokens(snapshot.totals.inputTokens) }}</span>
        </div>
        <div class="usage-card">
          <span class="usage-card-label">{{ t('sidepanel.metrics.outputTokens') }}</span>
          <span class="usage-card-value">{{ formatTokens(snapshot.totals.outputTokens) }}</span>
          <span v-if="snapshot.totals.reasoningTokens > 0" class="usage-card-sub">
            {{ t('sidepanel.metrics.reasoningTokens') }} {{ formatTokens(snapshot.totals.reasoningTokens) }}
          </span>
        </div>
        <div class="usage-card">
          <span class="usage-card-label">{{ t('sidepanel.metrics.cacheHitRate') }}</span>
          <span class="usage-card-value">{{ cacheHitRateLabel }}</span>
          <span class="usage-card-sub">
            {{ t('sidepanel.metrics.cacheHitDetail', { cached: formatTokens(snapshot.totals.cachedInputTokens), base: formatTokens(snapshot.totals.cacheEligibleInputTokens) }) }}
          </span>
        </div>
      </div>

      <!-- 模型占比 -->
      <div class="usage-group-title usage-group-title-row">
        <span>{{ t('sidepanel.metrics.modelShare') }}</span>
        <span class="usage-group-hint">{{ t('sidepanel.metrics.modelShareHint') }}</span>
      </div>
      <div class="usage-model-list">
        <div v-for="entry in snapshot.models" :key="JSON.stringify([entry.provider, entry.channelId, entry.modelId, entry.model])" class="usage-model-row">
          <div class="usage-model-head">
            <span class="usage-model-name" :title="entry.model">{{ entry.model }}</span>
            <span class="usage-model-provider">{{ providerLabel(entry.provider) }}</span>
            <span class="usage-model-share">{{ percentLabel(entry.share ?? 0) }}</span>
            <span class="usage-model-tokens">{{ formatTokens(entry.totalTokens) }}</span>
          </div>
          <div class="usage-model-bar">
            <div class="usage-model-bar-fill" :style="{ width: barWidth(entry.share ?? 0) }"></div>
          </div>
          <div class="usage-model-meta">
            <span>{{ entry.channelLabel || t('sidepanel.metrics.legacyChannel') }}</span>
            <span>{{ t('sidepanel.metrics.totalRequests') }} {{ formatCount(entry.requests) }}</span>
            <span>{{ t('sidepanel.metrics.successRate') }} {{ modelSuccessRate(entry) }}</span>
            <span>{{ t('sidepanel.metrics.inputTokens') }} {{ formatTokens(entry.inputTokens) }}</span>
            <span>{{ t('sidepanel.metrics.outputTokens') }} {{ formatTokens(entry.outputTokens) }}</span>
            <span>{{ t('sidepanel.metrics.cacheHitRate') }} {{ cacheRatio(entry) }}</span>
            <span>{{ t('sidepanel.metrics.cacheRequestRate') }} {{ cacheRequestRatio(entry) }}</span>
            <span>{{ t('sidepanel.metrics.continuationCache') }} {{ continuationRatio(entry) }}</span>
          </div>
        </div>
      </div>

      <div class="usage-group-title">{{ t('sidepanel.metrics.cacheDiagnostics') }}</div>
      <p class="config-form-hint">{{ t('sidepanel.metrics.cacheExplanation') }}</p>
      <div class="usage-header-actions usage-cache-filters">
        <select v-model="selectedChannel" :aria-label="t('sidepanel.metrics.channelFilter')">
          <option value="*">{{ t('sidepanel.metrics.allChannels') }}</option>
          <option v-for="item in channelOptions" :key="item.id" :value="item.id">{{ item.label }}</option>
        </select>
        <select v-model="selectedModel" :aria-label="t('sidepanel.metrics.modelFilter')">
          <option value="*">{{ t('sidepanel.metrics.allModels') }}</option>
          <option v-for="model in modelOptions" :key="model" :value="model">{{ model }}</option>
        </select>
        <select v-model="selectedAgent" :aria-label="t('sidepanel.metrics.agentFilter')">
          <option value="*">{{ t('sidepanel.metrics.allAgents') }}</option>
          <option v-for="agent in agentOptions" :key="agent" :value="agent">{{ agent || t('sidepanel.metrics.otherRequests') }}</option>
        </select>
      </div>
      <div class="usage-model-list">
        <div v-for="entry in filteredScopes" :key="JSON.stringify([entry.provider, entry.channelId, entry.modelId, entry.agentId, entry.requestKind])" class="usage-model-row">
          <div class="usage-model-head"><span class="usage-model-name">{{ entry.model }}</span></div>
          <div class="usage-model-meta">
            <span>{{ entry.channelLabel || t('sidepanel.metrics.legacyChannel') }}</span>
            <span>{{ entry.agentId || t('sidepanel.metrics.otherRequests') }} · {{ entry.requestKind }}</span>
            <span>{{ t('sidepanel.metrics.cacheHitRate') }} {{ cacheRatio(entry) }}</span>
            <span>{{ t('sidepanel.metrics.cacheRequestRate') }} {{ cacheRequestRatio(entry) }}</span>
            <span>{{ t('sidepanel.metrics.continuationCache') }} {{ continuationRatio(entry) }}</span>
            <span>{{ t('sidepanel.metrics.cacheHitDetail', { cached: formatTokens(entry.cachedInputTokens), base: formatTokens(entry.cacheEligibleInputTokens) }) }}</span>
          </div>
        </div>
      </div>
      <div class="usage-group-title">{{ t('sidepanel.metrics.recentRequests') }}</div>
      <div class="usage-model-list usage-request-list">
        <div v-for="(entry, index) in filteredRequests" :key="`${entry.at}:${index}`" class="usage-model-row">
          <div class="usage-model-head"><span class="usage-model-name">{{ entry.model }}</span><span>{{ formatTime(entry.at) }}</span></div>
          <div class="usage-model-meta">
            <span>{{ entry.channelLabel || t('sidepanel.metrics.legacyChannel') }}</span>
            <span>{{ entry.agentId || t('sidepanel.metrics.otherRequests') }} · {{ entry.kind }} · {{ entry.outcome }}</span>
            <span v-if="entry.runId">{{ entry.runId.slice(-8) }} #{{ entry.iteration }}</span>
            <span>{{ t('sidepanel.metrics.inputTokens') }} {{ entry.usage?.inputTokens ?? '—' }}</span>
            <span>{{ t('sidepanel.metrics.cachedTokens') }} {{ entry.usage?.cachedInputTokens ?? '—' }}</span>
            <span v-if="entry.iteration">{{ entry.iteration === 1 ? t('sidepanel.metrics.firstRound') : entry.prefixChanged ? t('sidepanel.metrics.prefixChanged') : t('sidepanel.metrics.prefixStable') }}</span>
            <span v-if="entry.trimmed || entry.compacted">{{ t('sidepanel.metrics.contextChanged') }}</span>
          </div>
        </div>
      </div>

      <!-- 最近错误 -->
      <div v-if="snapshot.recentErrors.length" class="usage-group-title usage-group-title-row">
        <span>{{ t('sidepanel.metrics.recentErrors') }}</span>
        <span class="usage-group-hint">{{ t('sidepanel.metrics.recentErrorsHint') }}</span>
      </div>
      <ul v-if="snapshot.recentErrors.length" class="usage-error-list">
        <li v-for="(err, index) in snapshot.recentErrors" :key="`${err.at}-${index}`" class="usage-error-item">
          <span class="usage-error-time">{{ formatTime(err.at) }}</span>
          <span v-if="err.provider" class="usage-error-provider">{{ providerLabel(err.provider) }}</span>
          <span class="usage-error-model">[{{ err.model }}]</span>
          <span class="usage-error-summary">{{ err.summary }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 使用监控分区 — AI 用量指标的实时只读视图
 *
 * 数据来源：aiUsageMetrics 引擎（订阅实时刷新；record / reset / 跨上下文存储变更均触发）。
 * 本组件零业务逻辑：格式化 + 渲染；清零操作带两步确认（3 秒内二次点击生效，防误触）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { t, useLocale } from '@/utils/i18n';
import { aiUsageMetrics } from '../../../utils/metrics/usage-metrics-engine';
import type { UsageMetricsSnapshot, ModelUsageMetrics } from '../../../utils/metrics/usage-metrics-types';
import { driverRegistry } from '../../../utils/stream/driver-registry';
import type { ProviderType } from '../../../utils/stream/types';

const { locale } = useLocale();

// ==================== 引擎订阅 ====================

const snapshot = ref<UsageMetricsSnapshot>(aiUsageMetrics.getSnapshot());
const selectedChannel = ref('*');
const selectedModel = ref('*');
const selectedAgent = ref('*');
const channelOptions = computed(() => [...new Map(snapshot.value.scopes.map(e => [e.channelId ?? '', { id: e.channelId ?? '', label: e.channelLabel || t('sidepanel.metrics.legacyChannel') }])).values()]);
const modelOptions = computed(() => [...new Set(snapshot.value.scopes.map(e => e.model))].sort());
const agentOptions = computed(() => [...new Set(snapshot.value.scopes.map(e => e.agentId ?? ''))].sort());
function matchesScope(e: { channelId?: string; model: string; agentId?: string }): boolean {
  return (selectedChannel.value === '*' || (e.channelId ?? '') === selectedChannel.value) &&
    (selectedModel.value === '*' || e.model === selectedModel.value) &&
    (selectedAgent.value === '*' || (e.agentId ?? '') === selectedAgent.value);
}
const filteredScopes = computed(() => snapshot.value.scopes.filter(matchesScope));
const filteredRequests = computed(() => snapshot.value.recentRequests.filter(matchesScope));
function cacheRatio(e: ModelUsageMetrics): string { return e.cacheEligibleInputTokens > 0 ? percentLabel(e.cachedInputTokens / e.cacheEligibleInputTokens) : '—'; }
function cacheRequestRatio(e: ModelUsageMetrics): string { return e.cacheObservedRequests > 0 ? percentLabel(e.cacheHitRequests / e.cacheObservedRequests) : '—'; }
function continuationRatio(e: ModelUsageMetrics): string { return e.continuationInputTokens > 0 ? percentLabel(e.continuationCachedTokens / e.continuationInputTokens) : '—'; }
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
  if (rate >= 0.95) return 'good';
  if (rate >= 0.8) return 'warn';
  return 'bad';
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

// ==================== 清零（两步确认） ====================

const resetArmed = ref(false);

function onResetClick() {
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
function modelSuccessRate(entry: ModelUsageMetrics): string {
  const rated = entry.success + entry.failed;
  if (rated === 0) return '—';
  return percentLabel(entry.success / rated);
}

/** 协议标签：已注册协议用驱动展示名，其余（如 asr）原样展示 */
function providerLabel(provider: string): string {
  const meta = driverRegistry.tryGet(provider as ProviderType)?.meta;
  if (meta?.label) return meta.label;
  if (provider === 'asr') return t('sidepanel.metrics.asrProviderLabel');
  return provider;
}
</script>

<style>
@import '../usage-metrics.css';
</style>
