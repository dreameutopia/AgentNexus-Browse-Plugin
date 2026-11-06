<template>
  <template v-for="entry in renderEntries" :key="entry.kind === 'cluster-bar' ? entry.key : entry.item.index">
    <!-- ════ 「连续过程小折叠」条：连续的工具调用 / 思考 / 截图收拢为
         一条摘要；正文文本与 notice 恒可见并隔离簇，见 part-grouping ════ -->
    <button
      v-if="entry.kind === 'cluster-bar'"
      type="button"
      class="cluster-bar"
      :title="t('sidepanel.chat.clusterToggle')"
      :aria-expanded="isClusterOpen(entry.key, entry.grouped.length) ? 'true' : 'false'"
      @click="toggleCluster(entry.key, entry.grouped.length)"
    >
      <span class="cluster-icon" aria-hidden="true">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12,2L2,7L12,12L22,7L12,2M2,12L12,17L22,12M2,17L12,22L22,17" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
        </svg>
      </span>
      <span class="cluster-summary">
        <template v-if="entry.counts.tools > 0">{{ t('sidepanel.chat.preludeTools', { count: entry.counts.tools }) }}</template>
        <template v-if="entry.counts.tools > 0 && entry.counts.reasoning > 0">&nbsp;·&nbsp;</template>
        <template v-if="entry.counts.reasoning > 0">{{ t('sidepanel.chat.clusterReasoning', { count: entry.counts.reasoning }) }}</template>
        <template v-if="(entry.counts.tools > 0 || entry.counts.reasoning > 0) && entry.counts.images > 0">&nbsp;·&nbsp;</template>
        <template v-if="entry.counts.images > 0">{{ t('sidepanel.chat.clusterScreenshots', { count: entry.counts.images }) }}</template>
      </span>
      <span class="cluster-right">
        <span v-if="entry.durationMs > 0" class="cluster-duration">{{ formatDuration(entry.durationMs) }}</span>
        <svg class="cluster-chevron" :class="{ collapsed: !isClusterOpen(entry.key, entry.grouped.length) }" width="11" height="11" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M9,6L8,7L14,12L8,17L9,18L16,12L9,6Z" fill="currentColor"/>
        </svg>
      </span>
    </button>

    <!-- 归属摘要条的片段：仅在簇展开时渲染（簇默认收起；生长后自动复位收起）。
         clusterVersion 缺失时按展开处理（fail-open）——防御未来构造端形态漂移，
         绝不因字段缺失把内容永久藏在折叠条后面 -->
    <div
      v-else-if="!entry.clusterKey || entry.clusterVersion === undefined || isClusterOpen(entry.clusterKey, entry.clusterVersion)"
      class="message-part"
    >
      <!-- 文字部分（流式节流渲染，见 MarkdownText） -->
      <MarkdownText
        v-if="entry.item.part.type === 'text' && entry.item.part.content"
        class="message-content"
        :content="entry.item.part.content"
        :streaming="streaming"
      />
      <!-- 系统注记部分（守卫停止 / 截断说明等）：独立系统信息条容器 -->
      <div v-else-if="entry.item.part.type === 'notice' && entry.item.part.content" class="system-notice">
        <span class="system-notice-icon" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M13,17H11V15H13M13,13H11V7H13" fill="currentColor"/>
          </svg>
        </span>
        <span class="system-notice-text">{{ entry.item.part.content }}</span>
      </div>

      <!-- 推理部分（内联显示在正确的顺序位置；toggle 回传原始索引，供父级定位） -->
      <div v-else-if="entry.item.part.type === 'reasoning' && entry.item.part.content" :class="['reasoning-container', { collapsed: entry.item.part.collapsed }]">
        <div class="reasoning-header" @click="emit('toggle-reasoning-collapse', messageId, entry.item.index)">
          <div class="reasoning-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M13 3C9.23 3 6.19 5.95 6 9.66l-1.92 2.53c-.24.31 0 .81.42.81H6v3c0 1.1.9 2 2 2h1v3h7v-4.69c2.37-1.12 4-3.51 4-6.31 0-3.87-3.13-7-7-7m2 11h-1v4h-3v-4H9v-3H7.23L9 8.34C9.31 5.93 11 4 13 4c2.76 0 5 2.24 5 5 0 2.04-1.23 3.81-3 4.58V14z" fill="currentColor"/>
            </svg>
          </div>
          <span class="reasoning-title">{{ t('sidepanel.chat.reasoningTitle') }}</span>
          <svg class="reasoning-expand-icon" :class="{ collapsed: entry.item.part.collapsed }" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" fill="currentColor"/>
          </svg>
        </div>
        <MarkdownText
          v-if="!entry.item.part.collapsed"
          class="reasoning-content"
          :content="entry.item.part.content"
          :streaming="streaming"
        />
      </div>

      <!-- 工具调用部分 -->
      <div v-else-if="entry.item.part.type === 'tool' && entry.item.part.toolCall" class="tool-calls-container">
        <ToolCallItem
          :tool-call="entry.item.part.toolCall"
          :message-id="messageId"
          @toggle-expansion="emit('toggle-tool-call-expansion', messageId, entry.item.part.toolCall.id)"
        />
      </div>

      <!-- 截屏片段（vision 自动截图）：内联「查看屏幕」可折叠容器，
           按截屏发生顺序排列在片段流中（多轮工具调用的截图各居其位） -->
      <MessageImagePart
        v-else-if="entry.item.part.type === 'image' && entry.item.part.imageRef"
        :image-ref="entry.item.part.imageRef"
      />
    </div>
  </template>
</template>

<script setup lang="ts">
/**
 * 消息片段序列渲染（文字 / 系统注记 / 推理 / 工具调用 / 截屏，按原顺序）。
 *
 * 设计要点：
 *   - 输入为「带原始索引」的片段列表（IndexedMessagePart）：visibleParts 过滤
 *     会造成数组下标与 message.parts 脱钩，历史实现把过滤后下标回传父级导致
 *     推理折叠定位到错误片段；本组件统一携带原始索引，回传时不再错位。
 *   - 供 ChatMessageList 在两种形态下复用：直播态全量渲染；结束态按
 *     「过程前奏（可折叠）/ 末段正文 / 尾部」分组渲染。
 *   - 连续过程小折叠（buildLivePartSegments）在直播态与结束态同一规则：
 *     连续的工具调用 / 思考 / 截图收拢为一条摘要条，最新活动保留可见——
 *     长任务直播不再无限拉长过程行，展开前奏折叠后内部的小折叠同样生效
 *     （对标 Claude Code / Codex / Copilot 的收拢约定）。正文文本是正式
 *     输出，恒可见并作为簇间隔离——出现非思考输出时连续即被隔断。
 *   - streaming 透传给文本片段：直播中的片段按节流间隔渲染 Markdown，
 *     已结束片段直接渲染（见 MarkdownText）。
 *   - notice 片段以独立系统信息条呈现（与工具行同风格的轻量容器），
 *     系统信息与正文在视觉上分层，不再混用同一气泡样式。
 *   - image 片段由 MessageImagePart 渲染为「查看屏幕」容器（默认收起，
 *     展开见原图，点击进共享看图层），折叠状态是组件本地态，无需回传。
 */
import { computed, ref } from 'vue';
import { t } from '@/utils/i18n';
import type { IndexedMessagePart } from '../../types/chat';
import { formatDuration } from '../../utils/chat/duration';
import {
  buildLivePartSegments,
  type LiveRenderEntry,
} from '../../utils/chat/part-grouping';
import ToolCallItem from './ToolCallItem.vue';
import MarkdownText from './MarkdownText.vue';
import MessageImagePart from './MessageImagePart.vue';

const props = withDefaults(
  defineProps<{
    parts: IndexedMessagePart[];
    messageId: string;
    /** 本组片段是否处于直播流（文本片段开启节流渲染） */
    streaming?: boolean;
  }>(),
  { streaming: false },
);

const emit = defineEmits<{
  'toggle-tool-call-expansion': [messageId: string, toolCallId: string];
  'toggle-reasoning-collapse': [messageId: string, partIndex: number];
}>();

/**
 * 渲染项序列：连续的工具调用 / 思考 / 截图收拢为小折叠条；正文文本与
 * notice 恒可见并隔离簇。直播与结束态（含展开的前奏折叠内部）同一规则。
 * 输入形态防御：parts 非数组（调用方契约被破坏 / 未来误用）时收敛为空
 * 序列，宁可本组片段不渲染也不能让 computed 抛错拖垮整个消息列表。
 */
const renderEntries = computed<LiveRenderEntry[]>(() =>
  buildLivePartSegments(Array.isArray(props.parts) ? props.parts : []),
);

/**
 * 簇展开记忆：key = 簇标识（组内首片段原始下标），value = 用户意图 + 记录
 * 时刻的簇版本（组内片段数）。默认收起；用户展开后保持展开，直到簇生长
 * （新片段并入使版本变化）——直播中新的活动会取代旧的，长出的簇自动复位
 * 收起，避免用户不在场时过程行无限展开（新簇可再次手动展开）。
 */
const clusterExpansion = ref(new Map<string, { expanded: boolean; version: number }>());

const isClusterOpen = (key: string, version: number): boolean => {
  const state = clusterExpansion.value.get(key);
  return !!state && state.version === version && state.expanded;
};

const toggleCluster = (key: string, version: number): void => {
  clusterExpansion.value.set(key, { expanded: !isClusterOpen(key, version), version });
};
</script>
