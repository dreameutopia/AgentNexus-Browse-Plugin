<template>
  <div :class="['tool-row', toolCall.status]">
    <!-- 单行主信息：左侧状态图标 + 工具名（+行内错误摘要），右侧耗时与展开箭头。
         无边框无底色，hover 时仅有极轻的圆角底——对齐 Codex / Claude Code 桌面端的克制风格 -->
    <button
      type="button"
      class="tool-row-main"
      :disabled="!isCompleted"
      :title="rowTitle"
      @click="handleClick"
    >
      <span class="tool-icon" aria-hidden="true">
        <svg v-if="toolCall.status === 'pending'" class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z" fill="currentColor"/>
        </svg>
        <svg v-else-if="toolCall.status === 'success'" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z" fill="currentColor"/>
        </svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M13,13H11V7H13M13,17H11V15H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" fill="currentColor"/>
        </svg>
      </span>
      <span class="tool-name">{{ toolCall.name.startsWith('ed25519:') ? toolCall.name.split('/').pop() : toolCall.name }}</span>
      <small v-if="pluginSource" :title="toolCall.name">{{ pluginSource }}</small>
      <span v-if="toolCall.status === 'error' && toolCall.error" class="tool-error-inline">{{ toolCall.error }}</span>
      <span class="tool-right">
        <span v-if="durationLabel" class="tool-time">{{ durationLabel }}</span>
        <svg v-if="isCompleted && hasDetail" class="tool-chevron" :class="{ expanded: toolCall.expanded }" width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M9,6L8,7L14,12L8,17L9,18L16,12L9,6Z" fill="currentColor"/>
        </svg>
      </span>
    </button>

    <!-- 展开详情：无边框，浅底等宽字体，与工具名左对齐 -->
    <div v-if="isCompleted && hasDetail && toolCall.expanded" class="tool-detail">
      <pre v-if="toolCall.status === 'success' && prettyResult">{{ prettyResult }}</pre>
      <pre v-else-if="toolCall.status === 'error' && toolCall.error" class="is-error">{{ toolCall.error }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 工具调用行（无边框紧凑样式）
 *
 * 视觉规范（参考 Codex / Claude Code 桌面端）：
 *   - 一行承载全部状态：左 SVG 状态图标（旋转 / 对勾 / 叉）+ 等宽工具名，
 *     右侧耗时 + 展开箭头；无卡片边框、无分割线、无状态徽章
 *   - 错误信息以弱红色单行内联摘要展示（溢出省略），完整内容在展开区
 *   - 仅完成态可点击展开；悬停反馈为 4% 不透明度的圆角底
 */
import { computed } from 'vue';
import { t } from '@/utils/i18n';
import type { ToolCallUI } from '../../types/chat';

/** 详情区序列化上限（字符）：超长结果截断展示，避免渲染 64KB 级记录拖垮列表 */
const DETAIL_PREVIEW_MAX_CHARS = 50_000;

const props = defineProps<{
  toolCall: ToolCallUI;
  messageId: string;
}>();
const pluginSource = computed(() => {
  const plugin = props.toolCall.result?.plugin;
  return plugin && typeof plugin.displayName === 'string' && typeof plugin.version === 'string' ? `${plugin.displayName} · ${plugin.version}` : '';
});

const emit = defineEmits<{
  'toggle-expansion': [];
}>();

const isCompleted = computed(() =>
  props.toolCall.status === 'success' || props.toolCall.status === 'error',
);

const hasDetail = computed(() => {
  if (props.toolCall.status === 'success') return !!props.toolCall.result;
  if (props.toolCall.status === 'error') return !!props.toolCall.error;
  return false;
});

/** 耗时标签：<1s 显示毫秒，≥1s 保留一位小数 */
const durationLabel = computed(() => {
  const ms = props.toolCall.executionTime;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
});

const rowTitle = computed(() => {
  const statusLabel =
    props.toolCall.status === 'pending' ? t('sidepanel.tool.statusPending') :
    props.toolCall.status === 'success' ? t('sidepanel.tool.statusSuccess') :
    t('sidepanel.tool.statusError');
  const duration = durationLabel.value ? ` · ${durationLabel.value}` : '';
  return `${props.toolCall.name} · ${statusLabel}${duration}`;
});

const prettyResult = computed(() => {
  if (props.toolCall.status !== 'success' || !props.toolCall.result) return '';
  try {
    const text = JSON.stringify(props.toolCall.result, null, 2) ?? '';
    if (text.length <= DETAIL_PREVIEW_MAX_CHARS) return text;
    return `${text.slice(0, DETAIL_PREVIEW_MAX_CHARS)}\n…[结果过长，已截断展示（原始 ${text.length} 字符）]`;
  } catch {
    // result 含循环引用等不可序列化结构时降级为字符串快照
    return String(props.toolCall.result);
  }
});

const handleClick = () => {
  // 仅已完成状态允许展开/收起
  if (isCompleted.value && hasDetail.value) {
    emit('toggle-expansion');
  }
};
</script>
