<template>
  <div v-for="item in parts" :key="item.index" class="message-part">
    <!-- 文字部分（流式节流渲染，见 MarkdownText） -->
    <MarkdownText
      v-if="item.part.type === 'text' && item.part.content"
      class="message-content"
      :content="item.part.content"
      :streaming="streaming"
    />
    <!-- 系统注记部分（守卫停止 / 截断说明等）：独立系统信息条容器 -->
    <div v-else-if="item.part.type === 'notice' && item.part.content" class="system-notice">
      <span class="system-notice-icon" aria-hidden="true">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M13,17H11V15H13M13,13H11V7H13" fill="currentColor"/>
        </svg>
      </span>
      <span class="system-notice-text">{{ item.part.content }}</span>
    </div>

    <!-- 推理部分（内联显示在正确的顺序位置；toggle 回传原始索引，供父级定位） -->
    <div v-else-if="item.part.type === 'reasoning' && item.part.content" :class="['reasoning-container', { collapsed: item.part.collapsed }]">
      <div class="reasoning-header" @click="emit('toggle-reasoning-collapse', messageId, item.index)">
        <div class="reasoning-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M13 3C9.23 3 6.19 5.95 6 9.66l-1.92 2.53c-.24.31 0 .81.42.81H6v3c0 1.1.9 2 2 2h1v3h7v-4.69c2.37-1.12 4-3.51 4-6.31 0-3.87-3.13-7-7-7m2 11h-1v4h-3v-4H9v-3H7.23L9 8.34C9.31 5.93 11 4 13 4c2.76 0 5 2.24 5 5 0 2.04-1.23 3.81-3 4.58V14z" fill="#8b5cf6"/>
          </svg>
        </div>
        <span class="reasoning-title">{{ t('sidepanel.chat.reasoningTitle') }}</span>
        <svg class="reasoning-expand-icon" :class="{ collapsed: item.part.collapsed }" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" fill="currentColor"/>
        </svg>
      </div>
      <MarkdownText
        v-if="!item.part.collapsed"
        class="reasoning-content"
        :content="item.part.content"
        :streaming="streaming"
      />
    </div>

    <!-- 工具调用部分 -->
    <div v-else-if="item.part.type === 'tool' && item.part.toolCall" class="tool-calls-container">
      <ToolCallItem
        :tool-call="item.part.toolCall"
        :message-id="messageId"
        @toggle-expansion="emit('toggle-tool-call-expansion', messageId, item.part.toolCall.id)"
      />
    </div>

    <!-- 截屏片段（vision 自动截图）：内联「查看屏幕」可折叠容器，
         按截屏发生顺序排列在片段流中（多轮工具调用的截图各居其位） -->
    <MessageImagePart
      v-else-if="item.part.type === 'image' && item.part.imageRef"
      :image-ref="item.part.imageRef"
    />
  </div>
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
 *   - streaming 透传给文本片段：直播中的片段按节流间隔渲染 Markdown，
 *     已结束片段直接渲染（见 MarkdownText）。
 *   - notice 片段以独立系统信息条呈现（与工具行同风格的轻量容器），
 *     系统信息与正文在视觉上分层，不再混用同一气泡样式。
 *   - image 片段由 MessageImagePart 渲染为「查看屏幕」容器（默认收起，
 *     展开见原图，点击进共享看图层），折叠状态是组件本地态，无需回传。
 */
import { t } from '@/utils/i18n';
import type { IndexedMessagePart } from '../../types/chat';
import ToolCallItem from './ToolCallItem.vue';
import MarkdownText from './MarkdownText.vue';
import MessageImagePart from './MessageImagePart.vue';

withDefaults(
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
</script>
