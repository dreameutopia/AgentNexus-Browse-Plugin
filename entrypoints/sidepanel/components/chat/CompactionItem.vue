<template>
  <div :class="['tool-row', 'compaction-row', compaction.status]">
    <!-- 单行主信息：与 ToolCallItem 同构——左状态图标 + 标题（+行内错误摘要），
         右侧压缩收益（from → to）与耗时 + 展开箭头 -->
    <button
      type="button"
      class="tool-row-main"
      :disabled="!isCompleted"
      :title="rowTitle"
      @click="handleClick"
    >
      <span class="tool-icon" aria-hidden="true">
        <svg v-if="compaction.status === 'pending'" class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12,4V2A10,10 0 0,0 2,12H4A8 8 0 0,1 12,4Z" fill="currentColor"/>
        </svg>
        <svg v-else-if="compaction.status === 'success'" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z" fill="currentColor"/>
        </svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M13,13H11V7H13M13,17H11V15H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" fill="currentColor"/>
        </svg>
      </span>
      <span class="tool-name compaction-name">
        {{ compaction.status === 'pending' ? t('sidepanel.chat.compactionRunning') : t('sidepanel.chat.compactionTitle') }}
      </span>
      <span v-if="compaction.status === 'error' && compaction.error" class="tool-error-inline">{{ compaction.error }}</span>
      <span class="tool-right">
        <span v-if="tokenDeltaLabel" class="compaction-tokens">{{ tokenDeltaLabel }}</span>
        <span v-else-if="compaction.status === 'pending' && compaction.originalTokens" class="compaction-tokens">
          {{ formatTokensK(compaction.originalTokens) }}
        </span>
        <span v-if="durationLabel" class="tool-time">{{ durationLabel }}</span>
        <svg v-if="isCompleted && hasDetail" class="tool-chevron" :class="{ expanded: compaction.expanded }" width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M9,6L8,7L14,12L8,17L9,18L16,12L9,6Z" fill="currentColor"/>
        </svg>
      </span>
    </button>

    <!-- 展开详情：成功 = 摘要全文（<summary> XML）；失败 = 完整错误。
         与工具详情同一容器样式（浅底等宽字体） -->
    <div v-if="isCompleted && hasDetail && compaction.expanded" class="tool-detail">
      <pre v-if="compaction.status === 'success' && compaction.summary">{{ compaction.summary }}</pre>
      <pre v-else-if="compaction.status === 'error' && compaction.error" class="is-error">{{ compaction.error }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 上下文压缩行（与 ToolCallItem 同一视觉规范）
 *
 * 语义对齐工具调用：pending 旋转图标 + 「正在压缩对话记忆…」；success
 * 对勾 + 标题 + 右侧压缩收益（from → to token）与耗时，展开见摘要全文
 * （<summary> XML，即注入模型上下文的压缩记忆）；error 叉 + 行内错误
 * 摘要，展开见完整原因。仅结算态可点击展开；pending 不可交互。
 */
import { computed } from 'vue';
import { t } from '@/utils/i18n';
import type { CompactionPartState } from '../../types/chat';
import { formatTokensK, formatCompactDuration } from '../../utils/chat/format';

const props = defineProps<{
  compaction: CompactionPartState;
  messageId: string;
}>();

const emit = defineEmits<{
  'toggle-expansion': [];
}>();

const isCompleted = computed(() =>
  props.compaction.status === 'success' || props.compaction.status === 'error',
);

const hasDetail = computed(() => {
  if (props.compaction.status === 'success') return !!props.compaction.summary;
  if (props.compaction.status === 'error') return !!props.compaction.error;
  return false;
});

/** 压缩收益标签：144.5K → 2.5K（仅 success 且两端数值齐备；口径见 format.ts） */
const tokenDeltaLabel = computed(() => {
  if (props.compaction.status !== 'success') return '';
  const from = formatTokensK(props.compaction.originalTokens);
  const to = formatTokensK(props.compaction.summaryTokens);
  if (!from || !to) return '';
  return `${from} → ${to}`;
});

/** 耗时标签（与工具行同一口径，实现见 format.ts 的 formatCompactDuration） */
const durationLabel = computed(() => formatCompactDuration(props.compaction.durationMs));

const rowTitle = computed(() => {
  const title = props.compaction.status === 'pending'
    ? t('sidepanel.chat.compactionRunning')
    : t('sidepanel.chat.compactionTitle');
  const statusLabel =
    props.compaction.status === 'pending' ? t('sidepanel.tool.statusPending') :
    props.compaction.status === 'success' ? t('sidepanel.tool.statusSuccess') :
    t('sidepanel.tool.statusError');
  const delta = tokenDeltaLabel.value ? ` · ${tokenDeltaLabel.value}` : '';
  const duration = durationLabel.value ? ` · ${durationLabel.value}` : '';
  return `${title} · ${statusLabel}${delta}${duration}`;
});

const handleClick = () => {
  if (isCompleted.value && hasDetail.value) {
    emit('toggle-expansion');
  }
};
</script>
