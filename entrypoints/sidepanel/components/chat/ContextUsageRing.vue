<template>
  <div
    class="ctx-ring-wrap"
    :class="{ compacting: compacting }"
    :title="t('sidepanel.contextMeter.title')"
    @mouseenter="cardVisible = true"
    @mouseleave="cardVisible = false"
  >
    <!-- 圆环：20px，比例驱动；压缩进行中附加呼吸动画 -->
    <svg class="ctx-ring" width="20" height="20" viewBox="0 0 36 36" role="img">
      <circle class="ctx-ring-track" cx="18" cy="18" r="15.5" fill="none" stroke-width="4" />
      <circle
        class="ctx-ring-bar"
        cx="18"
        cy="18"
        r="15.5"
        fill="none"
        stroke-width="4"
        stroke-linecap="round"
        :stroke="barColor"
        :stroke-dasharray="dashArray"
        transform="rotate(-90 18 18)"
      />
      <text x="18" y="21.5" text-anchor="middle" class="ctx-ring-text" :fill="barColor">
        {{ percentLabel }}
      </text>
    </svg>

    <!-- 悬浮详情卡片（向上展开；无测量数据时不渲染） -->
    <Transition name="ctx-card">
      <div v-if="cardVisible && usage" class="ctx-card" role="dialog">
        <div class="ctx-card-header">
          <span class="ctx-card-title">{{ t('sidepanel.contextMeter.title') }}</span>
          <span class="ctx-card-percent" :style="{ color: barColor }">{{ percentLabel }}</span>
        </div>

        <div class="ctx-card-total">
          <span class="ctx-card-value">{{ formatTokens(usage.totalTokens) }}</span>
          <span class="ctx-card-divider">/</span>
          <span class="ctx-card-threshold">{{ formatTokens(usage.threshold) }}</span>
        </div>

        <div class="ctx-card-components">
          <div v-for="item in componentRows" :key="item.key" class="ctx-component-row">
            <span class="ctx-component-label">{{ item.label }}</span>
            <div class="ctx-component-bar">
              <div class="ctx-component-fill" :style="{ width: item.barWidth, background: barColor }"></div>
            </div>
            <span class="ctx-component-value">{{ formatTokens(item.tokens) }}</span>
          </div>
        </div>

        <p v-if="compacting" class="ctx-card-hint">
          {{ t('sidepanel.contextMeter.compacting') }}
        </p>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
/**
 * 上下文用量圆环（输入栏模型选择器右侧）
 *
 * - 数据源：core/context/context-meter 的全量口径测量（systemPrompt + 工具定义
 *   + 对话消息 + 图片），与会话引擎的压缩触发（80% / 90%）与窗口守卫裁剪同源；
 * - 分级配色：<60% 绿 / 60%~80% 琥珀 / ≥80% 红（红线直接引用
 *   COMPACTION_PRE_RUN_RATIO——发送前压缩线。看到红色即「下次发送就会触发
 *   压缩」，颜色与触发线同源改一处即处处跟随，不存在两处硬编码漂移）。
 */
import { computed, ref } from 'vue';
import { t } from '@/utils/i18n';
import type { ContextUsage } from '../../core';
import { COMPACTION_PRE_RUN_RATIO } from '../../core';

const props = defineProps<{
  usage: ContextUsage | null;
  /** 是否正在执行上下文压缩（卡片提示 + 圆环呼吸动画） */
  compacting?: boolean;
}>();

const cardVisible = ref(false);

/** 钳制到 0..1（超限时环满格、颜色变红，数值以百分比文本精确展示） */
const safeRatio = computed(() =>
  props.usage ? Math.min(Math.max(props.usage.ratio, 0), 1) : 0,
);

const barColor = computed(() => {
  const ratio = props.usage?.ratio ?? 0;
  if (ratio >= COMPACTION_PRE_RUN_RATIO) return '#ef4444';
  if (ratio >= 0.6) return '#f59e0b';
  return '#10b981';
});

const CIRCUMFERENCE = 2 * Math.PI * 15.5;

const dashArray = computed(() => {
  const filled = CIRCUMFERENCE * safeRatio.value;
  return `${filled} ${CIRCUMFERENCE - filled}`;
});

const percentLabel = computed(() => {
  if (!props.usage) return '—';
  return `${Math.round(props.usage.ratio * 100)}%`;
});

/** token 数人性化展示（K 单位保留一位小数；无效值按 0 兜底） */
const formatTokens = (tokens: number): string => {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens < 1024) return `${Math.round(tokens)}`;
  return `${(tokens / 1024).toFixed(1)}K`;
};

const componentRows = computed(() => {
  const usage = props.usage;
  if (!usage) return [];
  const total = Math.max(usage.totalTokens, 1);
  const toWidth = (tokens: number) => `${Math.min((tokens / total) * 100, 100)}%`;
  const rows = [
    { key: 'system', label: t('sidepanel.contextMeter.system'), tokens: usage.systemTokens, barWidth: toWidth(usage.systemTokens) },
    { key: 'tools', label: t('sidepanel.contextMeter.tools'), tokens: usage.toolsTokens, barWidth: toWidth(usage.toolsTokens) },
    { key: 'messages', label: t('sidepanel.contextMeter.messages'), tokens: usage.messagesTokens, barWidth: toWidth(usage.messagesTokens) },
  ];
  // 图片按固定 1200 token/张 计量（与 base64 体积解耦，见 token-estimate）；
  // 无图时不占行，避免恒为 0 的噪声行
  if (usage.imageTokens > 0) {
    rows.push({
      key: 'images',
      label: t('sidepanel.contextMeter.images'),
      tokens: usage.imageTokens,
      barWidth: toWidth(usage.imageTokens),
    });
  }
  return rows;
});
</script>

<style scoped>
@import './context-usage-ring.css';
</style>
