<template>
  <div
    :class="['message', message.role]"
    :data-streaming="isLive ? '1' : undefined"
  >
    <div class="message-wrapper">
      <!-- 思考中状态特殊显示 -->
      <template v-if="message.isThinking">
        <div class="thinking-container">
          <div class="thinking-icon">
            <svg class="thinking-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z" fill="currentColor"/>
            </svg>
          </div>
          <span class="thinking-text">{{ t('sidepanel.chat.thinking') }}</span>
        </div>
      </template>

      <!-- ════ 用户消息：独立气泡渲染 ════
           正文超长自动收起（点击展开查看完整内容），气泡右下角常驻复制按钮。
           用户消息没有推理/工具等过程内容，不参与下面的前奏分组 ════ -->
      <template v-if="isUserMessage">
        <UserMessageBubble :content="userTextContent" :message-id="message.id" />
      </template>

      <!-- ════ 直播态（流式进行中 / 无末段正文的记录）：
           维持原有顺序全量渲染，过程内容实时可见 ════ -->
      <template v-else-if="!usePreludeCollapse">
        <!-- 推理内容特殊渲染（仅当没有reasoning类型的parts时显示，保持向后兼容）；
             视觉对齐工具调用行（tool-row）的无边框紧凑设计语言 -->
        <div v-if="legacyReasoningVisible" :class="['reasoning-container', { collapsed: message._reasoningContentCollapsed }]">
          <button
            type="button"
            class="reasoning-header"
            :title="t('sidepanel.chat.reasoningTitle')"
            :aria-expanded="message._reasoningContentCollapsed ? 'false' : 'true'"
            @click="emit('toggle-reasoning-content-collapse', message.id!)"
          >
            <span class="reasoning-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M13 3C9.23 3 6.19 5.95 6 9.66l-1.92 2.53c-.24.31 0 .81.42.81H6v3c0 1.1.9 2 2 2h1v3h7v-4.69c2.37-1.12 4-3.51 4-6.31 0-3.87-3.13-7-7-7m2 11h-1v4h-3v-4H9v-3H7.23L9 8.34C9.31 5.93 11 4 13 4c2.76 0 5 2.24 5 5 0 2.04-1.23 3.81-3 4.58V14z" fill="currentColor"/>
              </svg>
            </span>
            <span class="reasoning-title">{{ t('sidepanel.chat.reasoningTitle') }}</span>
            <span class="reasoning-right">
              <svg class="reasoning-chevron" :class="{ expanded: !message._reasoningContentCollapsed }" width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M9,6L8,7L14,12L8,17L9,18L16,12L9,6Z" fill="currentColor"/>
              </svg>
            </span>
          </button>
          <div v-if="!message._reasoningContentCollapsed" class="reasoning-content" v-html="renderMessage(message.reasoning_content || '')"></div>
        </div>

        <MessageParts
          :parts="indexedVisibleParts"
          :message-id="message.id || ''"
          :streaming="isLive"
          @toggle-tool-call-expansion="forwardToolToggle"
          @toggle-reasoning-collapse="forwardReasoningToggle"
          @toggle-compaction-collapse="forwardCompactionToggle"
        />
      </template>

      <!-- ════ 结束态分组渲染：全部过程内容（推理/工具/截图/中间文本，含正文
           之后残留的过程片段）收入可折叠「前奏」容器，正文主体与终态注记始终
           直接可见；无正文的中止/异常记录由折叠条单独承载 ════ -->
      <template v-else>
        <div
          v-if="groups.prelude.length > 0 || legacyReasoningVisible"
          class="answer-prelude"
          :class="{ collapsed: preludeCollapsed }"
        >
          <button
            type="button"
            class="prelude-header"
            :title="t('sidepanel.chat.preludeToggle')"
            @click="togglePrelude"
          >
            <span class="prelude-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12,3L9.9,8.2L4.5,9.4L8.3,13.3L7.4,18.7L12,16.2L16.6,18.7L15.7,13.3L19.5,9.4L14.1,8.2L12,3Z" fill="currentColor"/>
              </svg>
            </span>
            <span v-if="groups.hasReasoning || groups.toolCount > 0 || groups.compactionCount > 0" class="prelude-summary">
              <template v-if="groups.hasReasoning">{{ t('sidepanel.chat.preludeReasoning') }}</template>
              <template v-if="groups.hasReasoning && groups.toolCount > 0">&nbsp;·&nbsp;</template>
              <template v-if="groups.toolCount > 0">{{ t('sidepanel.chat.preludeTools', { count: groups.toolCount }) }}</template>
              <template v-if="groups.toolCount > 0 && groups.compactionCount > 0">&nbsp;·&nbsp;</template>
              <template v-if="groups.compactionCount > 0">{{ t('sidepanel.chat.preludeCompactions', { count: groups.compactionCount }) }}</template>
            </span>
            <!-- 前奏仅含中间文本（无推理无工具）时的兜底摘要，避免空标题行 -->
            <span v-else class="prelude-summary">
              {{ t('sidepanel.chat.preludeContent', { count: groups.prelude.length }) }}
            </span>
            <!-- 右侧组合（耗时 + 展开箭头）：统一右对齐。
                 若把 margin-left:auto 分散到两个子项，无耗时的旧记录会导致箭头
                 失去推右锚点、贴在摘要后面——auto 必须落在组合容器这一个元素上 -->
            <span class="prelude-right">
              <!-- 本轮实际执行时长（终态 usage.durationMs，随记录持久化） -->
              <span v-if="preludeDurationText" class="prelude-duration">{{ preludeDurationText }}</span>
              <svg class="prelude-chevron" :class="{ collapsed: preludeCollapsed }" width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M9,6L8,7L14,12L8,17L9,18L16,12L9,6Z" fill="currentColor"/>
              </svg>
            </span>
          </button>
          <div class="prelude-body">
            <div class="prelude-inner">
              <!-- 兼容旧记录：仅有 reasoning_content、无 reasoning parts 时并入前奏 -->
              <div v-if="legacyReasoningVisible" :class="['reasoning-container', 'prelude-legacy-reasoning', { collapsed: message._reasoningContentCollapsed }]">
                <button
                  type="button"
                  class="reasoning-header"
                  :title="t('sidepanel.chat.reasoningTitle')"
                  :aria-expanded="message._reasoningContentCollapsed ? 'false' : 'true'"
                  @click="emit('toggle-reasoning-content-collapse', message.id!)"
                >
                  <span class="reasoning-icon" aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M13 3C9.23 3 6.19 5.95 6 9.66l-1.92 2.53c-.24.31 0 .81.42.81H6v3c0 1.1.9 2 2 2h1v3h7v-4.69c2.37-1.12 4-3.51 4-6.31 0-3.87-3.13-7-7-7m2 11h-1v4h-3v-4H9v-3H7.23L9 8.34C9.31 5.93 11 4 13 4c2.76 0 5 2.24 5 5 0 2.04-1.23 3.81-3 4.58V14z" fill="currentColor"/>
                    </svg>
                  </span>
                  <span class="reasoning-title">{{ t('sidepanel.chat.reasoningTitle') }}</span>
                  <span class="reasoning-right">
                    <svg class="reasoning-chevron" :class="{ expanded: !message._reasoningContentCollapsed }" width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M9,6L8,7L14,12L8,17L9,18L16,12L9,6Z" fill="currentColor"/>
                    </svg>
                  </span>
                </button>
                <div v-if="!message._reasoningContentCollapsed" class="reasoning-content" v-html="renderMessage(message.reasoning_content || '')"></div>
              </div>

              <MessageParts
                :parts="groups.prelude"
                :message-id="message.id || ''"
                @toggle-tool-call-expansion="forwardToolToggle"
                @toggle-reasoning-collapse="forwardReasoningToggle"
                @toggle-compaction-collapse="forwardCompactionToggle"
              />
            </div>
          </div>
        </div>

        <!-- 末段正文（始终直接可见） -->
        <MessageParts
          v-if="finalPartList.length > 0"
          :parts="finalPartList"
          :message-id="message.id || ''"
          @toggle-tool-call-expansion="forwardToolToggle"
          @toggle-reasoning-collapse="forwardReasoningToggle"
          @toggle-compaction-collapse="forwardCompactionToggle"
        />
        <!-- 正文之后的终态注记（守卫停止 / 截断说明等 notice）：恒保持可见，
             不被前奏折叠遮蔽；中止前的过程残留已随规则并入前奏折叠 -->
        <MessageParts
          v-if="groups.tail.length > 0"
          :parts="groups.tail"
          :message-id="message.id || ''"
          @toggle-tool-call-expansion="forwardToolToggle"
          @toggle-reasoning-collapse="forwardReasoningToggle"
          @toggle-compaction-collapse="forwardCompactionToggle"
        />
      </template>

      <!-- 如果没有parts但有content或toolCalls（用户消息由气泡独立渲染，不走此兜底） -->
      <template v-if="!isUserMessage && (!message.parts || message.parts.length === 0) && ((message.content && !message.reasoning_content) || (message.toolCalls && message.toolCalls.length > 0))">
        <div v-if="message.content && !message.reasoning_content" class="message-content">
          <!-- 处理数组类型的content（视觉对话） -->
          <template v-if="Array.isArray(message.content)">
            <div v-for="(item, itemIndex) in message.content" :key="itemIndex">
              <div v-if="item.type === 'text'" v-html="renderMessage(item.text || '')"></div>
              <!-- 图片内容不渲染，只显示文字 -->
            </div>
          </template>
          <!-- 处理字符串类型的content（普通对话） -->
          <div v-else v-html="renderMessage(message.content)"></div>
        </div>

        <!-- 工具调用展示 -->
        <div v-if="message.toolCalls && message.toolCalls.length > 0" class="tool-calls-container">
          <ToolCallItem
            v-for="toolCall in message.toolCalls"
            :key="toolCall.id"
            :tool-call="toolCall"
            :message-id="message.id!"
            @toggle-expansion="emit('toggle-tool-call-expansion', message.id!, toolCall.id)"
          />
        </div>
      </template>

      <!-- ════ 关联图片区（底部）：用户上传图片恒在此展示；
           助手消息的 vision 截图已内联为「查看屏幕」片段（见 MessageParts），
           仅对截图早于内联部件形态的旧记录兜底走底部图片区 ════ -->
      <MessageImages v-if="showBottomImages" :image-refs="message.imageRefs || []" />

      <!-- ════ 关联笔记卡片：本条消息执行中创建/追加/更新过的笔记 ════
           从 toolCalls 的 note_tool 成功结果提取（按 noteId 聚合去重）；
           点击经 hash 深链打开内置笔记页并定位详情；悬停平滑展开操作摘要 -->
      <div v-if="noteCards.length > 0" class="note-cards">
        <div class="note-cards-label">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M5,3H19A2,2 0 0,1 21,5V19A2,2 0 0,1 19,21H5A2,2 0 0,1 3,19V5A2,2 0 0,1 5,3M7,7H17V9H7V7M7,11H17V13H7V11M7,15H13V17H7V15Z" fill="currentColor"/>
          </svg>
          <span>{{ t('sidepanel.chat.noteCardsTitle') }}</span>
        </div>
        <div class="note-cards-list">
          <button
            v-for="card in noteCards"
            :key="card.noteId"
            type="button"
            class="note-card"
            @click="openNoteDetail(card.noteId)"
          >
            <span class="note-card-row">
              <span class="note-card-title">{{ card.title || card.noteId }}</span>
              <span
                v-for="action in card.actions"
                :key="action"
                class="note-card-action"
                :class="`is-${action}`"
              >{{ actionLabel(action) }}</span>
            </span>
            <!-- 悬停展开区（grid-rows 过渡实现丝滑展开） -->
            <span class="note-card-expand">
              <span class="note-card-expand-inner">
                <span class="note-card-ops">{{ t('sidepanel.chat.noteCardOps', { count: card.opCount }) }}</span>
                <span class="note-card-open">
                  {{ t('sidepanel.chat.noteCardOpen') }}
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M4,11V13H16L10.5,18.5L11.92,19.92L19.84,12L11.92,4.08L10.5,5.5L16,11H4Z" fill="currentColor"/>
                  </svg>
                </span>
              </span>
            </span>
          </button>
        </div>
      </div>

      <!-- ════ 模型消息操作栏：复制 / 调试轨迹 / 赞 / 踩（结束后显示；
           耗时在无前奏收起条时兜底展示于此右侧） ════ -->
      <div v-if="showMessageActions" class="message-actions">
        <button
          type="button"
          class="message-action-btn"
          :class="{ copied: copied }"
          :title="copied ? t('sidepanel.chat.copiedLabel') : t('sidepanel.chat.copyLabel')"
          :aria-label="copied ? t('sidepanel.chat.copiedLabel') : t('sidepanel.chat.copyLabel')"
          :disabled="!copyableText"
          @click="copyMessage"
        >
          <svg v-if="!copied" width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" fill="currentColor"/>
          </svg>
          <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/>
          </svg>
        </button>
        <button
          type="button"
          class="message-action-btn"
          :class="{ 'is-up': message.feedback === 'up' }"
          :title="t('sidepanel.chat.feedbackUp')"
          :aria-label="t('sidepanel.chat.feedbackUp')"
          :aria-pressed="message.feedback === 'up'"
          @click="setFeedback('up')"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z" fill="currentColor"/>
          </svg>
        </button>
        <button
          type="button"
          class="message-action-btn"
          :class="{ 'is-down': message.feedback === 'down' }"
          :title="t('sidepanel.chat.feedbackDown')"
          :aria-label="t('sidepanel.chat.feedbackDown')"
          :aria-pressed="message.feedback === 'down'"
          @click="setFeedback('down')"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z" fill="currentColor"/>
          </svg>
        </button>
        <!-- 调试轨迹：复制本轮完整执行过程（思考 / 工具调用 / 工具响应 /
             正文，按时间顺序；截图只留标记），用于 Agent 执行流程分析。
             与「复制」按钮分工：复制只取末段正文，本按钮取全过程。
             默认收起——由踩按钮右侧的开关放出；展开时调试按钮插到踩与开关
             之间，开关被顶到最右（宽度过渡带动位移，收起 / 展开各带动画） -->
        <Transition name="message-action-fold">
          <button
            v-if="debugExpanded"
            type="button"
            class="message-action-btn is-debug"
            :class="{ copied: traceCopied }"
            :title="traceCopied ? t('sidepanel.chat.debugTraceCopiedLabel') : t('sidepanel.chat.debugTraceLabel')"
            :aria-label="traceCopied ? t('sidepanel.chat.debugTraceCopiedLabel') : t('sidepanel.chat.debugTraceLabel')"
            :disabled="!traceText"
            @click="copyTrace"
          >
            <svg v-if="!traceCopied" width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M20,8h-2.81c-0.45,-0.78 -1.07,-1.45 -1.82,-1.96L17,4.41 15.59,3l-2.17,2.17C12.96,5.06 12.49,5 12,5c-0.49,0 -0.96,0.06 -1.41,0.17L8.41,3 7,4.41l1.62,1.63C7.88,6.55 7.26,7.22 6.81,8H4v2h2.09C6,10.34 6,10.67 6,11v1H4v2h2v1c0,0.33 0,0.66 0.09,1H4v2h2.81c1.04,1.79 2.97,3 5.19,3s4.15,-1.21 5.19,-3H20v-2h-2.09c0.09,-0.34 0.09,-0.67 0.09,-1v-1h2v-2h-2v-1c0,-0.33 0,-0.66 -0.09,-1H20V8zM14,16h-4v-2h4V16zM14,12h-4v-2h4V12z" fill="currentColor"/>
            </svg>
            <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/>
            </svg>
          </button>
        </Transition>
        <!-- 收起 / 展开开关：紧贴踩按钮右侧；展开后调试按钮插到二者之间，
             开关被顶到最右（收起 / 展开各有一段动画） -->
        <button
          v-if="traceText"
          type="button"
          class="message-action-btn is-fold-toggle"
          :class="{ expanded: debugExpanded }"
          :title="debugExpanded ? t('sidepanel.chat.debugToggleCollapseLabel') : t('sidepanel.chat.debugToggleExpandLabel')"
          :aria-label="debugExpanded ? t('sidepanel.chat.debugToggleCollapseLabel') : t('sidepanel.chat.debugToggleExpandLabel')"
          :aria-expanded="debugExpanded"
          @click="toggleDebugFold"
        >
          <svg class="fold-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M9,6L8,7L14,12L8,17L9,18L16,12L9,6Z" fill="currentColor"/>
          </svg>
        </button>
        <!-- 兜底耗时（推至操作栏最右） -->
        <span v-if="footerDurationText" class="message-duration">{{ footerDurationText }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 单条消息渲染容器（消息级渲染隔离单位）
 *
 * 性能设计：流式输出期间上层每个 token 都会更新最后一条消息对象，
 * 历史实现里整个消息列表位于同一组件模板内——任意 token 都触发全列表
 * vdom diff，长会话下 CPU 成本随历史长度线性增长。
 * 抽取为本组件后：props 为消息对象引用 + isLive 布尔，未变化的消息行
 * 被 Vue 浅比较整体跳过，只有正在流式更新的那一行参与渲染，
 * 配合 MessageParts/MarkdownText 的片段级节流实现「容器单位隔离的增量渲染」。
 */
import { computed, ref } from 'vue';
import { t } from '@/utils/i18n';
import type { ExtendedChatMessage, IndexedMessagePart, MessageFeedback, MessagePart } from '../../types/chat';
import { markdownRenderer } from '../../utils/chat/markdown-renderer';
import { groupAnswerParts, type AnswerGrouping } from '../../utils/chat/part-grouping';
import { formatDuration } from '../../utils/chat/duration';
import { openNoteDetail } from '../../utils/chat/note-nav';
import { useCopyToClipboard } from '../../utils/chat/use-copy-to-clipboard';
import { buildExecutionTraceText } from '../../utils/chat/message-copy-payload';
import ToolCallItem from './ToolCallItem.vue';
import MessageParts from './MessageParts.vue';
import MessageImages from './MessageImages.vue';
import UserMessageBubble from './UserMessageBubble.vue';

const props = defineProps<{
  message: ExtendedChatMessage;
  /** 是否直播中（AI 正在回应且本条是最新一条） */
  isLive: boolean;
}>();

const emit = defineEmits<{
  'toggle-tool-call-expansion': [messageId: string, toolCallId: string];
  'toggle-reasoning-collapse': [messageId: string, partIndex: number];
  'toggle-reasoning-content-collapse': [messageId: string];
  'toggle-compaction-collapse': [messageId: string, partIndex: number];
  /** 反馈变更（赞/踩；null = 清除）：本组件不直改 props，由 App 落库后回写列表 */
  'feedback-change': [messageId: string, feedback: MessageFeedback | null];
}>();

const renderMessage = (content: string) => markdownRenderer.renderMessage(content);

/**
 * 是否渲染底部图片区（MessageImages）：
 *   - 用户消息：上传图片恒在消息底部展示（原有行为）；
 *   - 助手消息：新记录的截图一律以内联「查看屏幕」片段呈现，只有
 *     「有引用但没有任何 image 片段」的旧记录（截图早于内联部件形态）
 *     才兜底走底部图片区，避免旧会话的截图彻底失去展示入口。
 */
const showBottomImages = computed<boolean>(() => {
  const refs = props.message.imageRefs;
  if (!refs || refs.length === 0) return false;
  if (props.message.role === 'user') return true;
  return !(props.message.parts ?? []).some(part => part.type === 'image');
});

/**
 * 是否为用户消息：用户消息走独立气泡（超长自动收起 + 右下角复制按钮），
 * 不参与模型消息的过程分组 / 折叠条渲染。
 */
const isUserMessage = computed(() => props.message.role === 'user');

/**
 * 用户消息正文（气泡渲染的源文）。
 * 字符串正文直取；多模态数组取文本块拼接（图片不进正文，走底部图片区）；
 * 无 content 的旧记录回退到文本片段拼接。
 */
const userTextContent = computed<string>(() => {
  const content = props.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(item => item?.type === 'text')
      .map(item => item.text || '')
      .join('\n');
  }
  return (props.message.parts ?? [])
    .filter(part => part.type === 'text')
    .map(part => part.content || '')
    .join('\n');
});

/**
 * 可见片段筛选（展示口径与轨迹口径共用同一套剔除规则）。
 *
 * 剔除项：空片段、缺载荷的片段（无 toolCall / 无 imageRef / 无 compaction 状态）。
 *   - stripThink=true（展示口径）：正文里的 <think> 段被剥离——思考不混进正文；
 *   - stripThink=false（轨迹口径）：原文保留，思考段在轨迹里单独以 <think>
 *     标签还原，保证「整条执行路径的所有输出」原样可读。
 *
 * 过滤（think 剥离、空片段剔除）会使数组下标与 message.parts 脱钩，
 * 折叠/展开等回传事件必须携带原始索引才能在 App.vue 中正确定位片段。
 */
function collectParts(parts: MessagePart[], stripThink: boolean): IndexedMessagePart[] {
  const result: IndexedMessagePart[] = [];
  parts.forEach((part, index) => {
    if (part.type === 'text') {
      if (!part.content) return;
      if (!stripThink) {
        if (!part.content.trim()) return;
        result.push({ index, part });
        return;
      }
      const strippedContent = part.content
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/<think>[\s\S]*$/g, '')
        .trim();
      if (!strippedContent) return;
      result.push({ index, part: { ...part, content: strippedContent } });
      return;
    }
    if (part.type === 'reasoning' && !part.content) return;
    if (part.type === 'notice' && !part.content) return;
    if (part.type === 'tool' && !part.toolCall) return;
    if (part.type === 'image' && !part.imageRef) return;
    if (part.type === 'compaction' && !part.compaction) return;
    result.push({ index, part });
  });
  return result;
}

/** 带原始索引的可见片段列表（展示口径：思考已剥离） */
const indexedVisibleParts = computed<IndexedMessagePart[]>(() =>
  collectParts(props.message.parts || [], true),
);

/** 带原始索引的可见片段列表（轨迹口径：原文保留，思考段单独还原成 <think>） */
const indexedTraceParts = computed<IndexedMessagePart[]>(() =>
  collectParts(props.message.parts || [], false),
);

/** 兼容旧记录：仅有 reasoning_content、无 reasoning 类型 parts（先于 groups 定义，供其读取） */
const legacyReasoningVisible = computed(
  () =>
    !!(props.message.reasoning_content && !(props.message.parts && props.message.parts.some(p => p.type === 'reasoning'))),
);

/**
 * 结束态分组（规则实体见 utils/chat/part-grouping 的 groupAnswerParts）：
 * 以最后一个文本片段为锚点（末段正文），其余全部过程片段——含锚点之后
 * 残留的工具调用 / 思考 / 截图（中止、异常、学习模式收尾轮的典型形态）——
 * 一律收入前奏折叠；notice（终态注记）保持可见。
 * 任何终态（正常结束 / 用户中止 / 异常 / 学习收尾）走同一条规则：
 * 折叠条之下只允许锚点正文与终态注记，不存在「折叠了但下面还有过程内容」。
 */
const groups = computed<AnswerGrouping>(() =>
  groupAnswerParts(indexedVisibleParts.value, {
    legacyReasoningText: !!props.message.reasoning_content?.trim(),
    totalToolCalls: props.message.toolCalls?.length,
  }),
);

/** 末段正文片段（单元素数组；无正文时为空数组，供模板直接绑定） */
const finalPartList = computed<IndexedMessagePart[]>(() => {
  const final = groups.value.final;
  return final ? [final] : [];
});

/**
 * 是否启用「前奏折叠」分组渲染：
 * 助手消息 + 已结束 + 前奏确有可折叠内容（或存在旧版 reasoning_content）。
 * **不要求存在末段正文**：被中止/异常收尾的运行可能没有任何文本输出
 * （如中止于纯工具轮），此时前奏收纳全部过程内容，折叠条单独成立——
 * 任何终态都必须完整折叠过程，不再依赖「有正文」这个正常结束才满足的前提。
 * 其余情形（用户消息 / 直播态 / 纯文本回答）走原有顺序渲染。
 */
const usePreludeCollapse = computed(() => {
  if (props.message.role !== 'assistant' || props.isLive) return false;
  return groups.value.prelude.length > 0 || legacyReasoningVisible.value;
});

// 前奏折叠状态：缺省折叠（回答结束即自动收起过程内容）；用户点击后记忆
const collapsedOverride = ref<boolean | null>(null);
const preludeCollapsed = computed(() => collapsedOverride.value ?? true);
const togglePrelude = (): void => {
  collapsedOverride.value = !preludeCollapsed.value;
};

// ==================== 执行耗时展示（终态 usage.durationMs，随记录持久化） ====================

/**
 * 耗时文案。隐藏条件分层：durationMs 缺失（旧记录）或 ≤0（瞬时失败的 0ms
 * 展示为「耗时 0ms」像 bug）→ 空串；formatDuration 再兜底拦截 NaN/负数。
 */
const durationText = computed<string>(() => {
  const ms = props.message.durationMs;
  if (ms === undefined || ms <= 0) return '';
  const formatted = formatDuration(ms);
  return formatted ? t('sidepanel.chat.durationTook', { duration: formatted }) : '';
});

/**
 * 耗时的两个互斥展示位：
 *   - 有前奏收起条（usePreludeCollapse）→ 贴收起条右侧（主诉求位，与摘要同行）；
 *   - 无收起条（纯文本回答等）→ 兜底放操作栏右侧（对标其他应用「每条回复都可见耗时」）。
 * 同一条消息只出现一处，避免上下重复。
 */
const preludeDurationText = computed(() => (usePreludeCollapse.value ? durationText.value : ''));
const footerDurationText = computed(() => (usePreludeCollapse.value ? '' : durationText.value));

// ==================== 消息操作栏（复制 / 赞 / 踩） ====================

/** 操作栏可见性：仅已结束的模型消息；直播占位与系统信息条不渲染 */
const showMessageActions = computed(
  () =>
    props.message.role === 'assistant' &&
    !props.isLive &&
    !props.message.isThinking &&
    !props.message.isSystemNotice,
);

/** 旧记录兜底正文：字符串直取；多模态数组仅取文本块（图片不参与复制） */
const legacyContentText = computed<string>(() => {
  const content = props.message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(item => item?.type === 'text')
      .map(item => item.text || '')
      .join('\n')
      .trim();
  }
  return '';
});

/**
 * 待复制正文（computed 缓存：正文变化才重建，点击与 disabled 判定零重复计算）。
 *
 * 口径 = **末段正文**（最后一个文本片段），与结束态分组的锚点同一口径
 * （groupAnswerParts 的 final）：思考过程、工具调用、以及正文之前残留的
 * 中间文本段都不进复制内容——复制按钮给的是「正式输出」这一份。
 *
 * 旧记录兜底：没有文本片段（无 parts 的早期记录，或纯工具轮收尾）时，
 * 回退整段 content，避免按钮复制到空文本。
 */
const copyableText = computed<string>(() => {
  const final = groups.value.final;
  if (final && final.part.type === 'text' && final.part.content?.trim()) {
    return final.part.content.trim();
  }
  return legacyContentText.value;
});

/**
 * 调试轨迹载荷：本轮完整执行过程（思考 / 工具调用 / 工具响应 / 正文 /
 * 终态注记，按时间顺序；截图只留标记不复制图片本体），供执行流程分析。
 *
 * 载荷形态（结构化标签序列、无页眉前缀）与旧记录兜底规则见
 * utils/chat/message-copy-payload。
 */
const traceText = computed<string>(() =>
  buildExecutionTraceText({
    parts: indexedTraceParts.value,
    legacyReasoning: legacyReasoningVisible.value ? props.message.reasoning_content : undefined,
    legacyToolCalls: indexedTraceParts.value.some(part => part.part.type === 'tool')
      ? []
      : (props.message.toolCalls ?? []),
  }),
);

/**
 * 调试按钮的收起 / 展开状态：默认收起——操作栏右侧只留一个展开开关，
 * 调试按钮本体默认不占位。用户点开关后放出调试按钮（收起 / 展开各有一段
 * CSS 过渡动画，见 chat-message-list.css 的 message-action-fold）。
 */
const debugExpanded = ref(false);
const toggleDebugFold = (): void => {
  debugExpanded.value = !debugExpanded.value;
};

/** 复制成功反馈态与复制动作（与用户消息气泡共用 utils/chat/use-copy-to-clipboard） */
const { copied, copy: copyMessage } = useCopyToClipboard(
  () => copyableText.value,
  () => `消息（messageId=${props.message.id ?? '无'}）`,
);

/** 调试轨迹复制：独立的成功反馈态，与正文复制互不干扰 */
const { copied: traceCopied, copy: copyTrace } = useCopyToClipboard(
  () => traceText.value,
  () => `调试轨迹（messageId=${props.message.id ?? '无'}）`,
);

/** 赞/踩切换：再次点击同一按钮 = 清除；两态互斥由单字段天然保证 */
const setFeedback = (kind: MessageFeedback): void => {
  if (!props.message.id) return;
  const next: MessageFeedback | null = props.message.feedback === kind ? null : kind;
  emit('feedback-change', props.message.id, next);
};

// 子组件事件转发（事件契约与 ChatMessageList / App.vue 模板绑定一一对应）
const forwardToolToggle = (messageId: string, toolCallId: string) => {
  emit('toggle-tool-call-expansion', messageId, toolCallId);
};
const forwardReasoningToggle = (messageId: string, partIndex: number) => {
  emit('toggle-reasoning-collapse', messageId, partIndex);
};
const forwardCompactionToggle = (messageId: string, partIndex: number) => {
  emit('toggle-compaction-collapse', messageId, partIndex);
};

// ==================== 关联笔记卡片（note_tool 结果提取） ====================

/** 卡片数据：同一笔记的多次操作聚合为一张卡 */
interface NoteCardData {
  noteId: string;
  title: string;
  /** 涉及的操作类型（去重保序） */
  actions: string[];
  /** 操作总次数 */
  opCount: number;
}

/**
 * 从本条消息的 note_tool 成功调用中提取关联笔记。
 * 聚合规则：create/append/update 按 noteId 聚合（标题取最新值）；
 * delete 成功后撤销该笔记的卡片（卡片指向的笔记已不存在）。
 * 结果形态防御：result.data 由工具层保证结构（见 note-tool.ts 的结果契约），
 * 此处仍对缺字段/脏数据逐项兜底，坏一条不影响其余卡片。
 */
const noteCards = computed<NoteCardData[]>(() => {
  const cards = new Map<string, NoteCardData>();
  const calls = props.message.toolCalls ?? [];
  for (const call of calls) {
    if (call.name !== 'note_tool' || call.status !== 'success') continue;
    const data = (call.result as { data?: Record<string, unknown> } | undefined)?.data;
    if (!data || typeof data !== 'object') continue;
    const action = data.action;
    const noteId = data.noteId;
    if (typeof action !== 'string' || typeof noteId !== 'string' || !noteId) continue;

    if (action === 'delete') {
      cards.delete(noteId);
      continue;
    }
    if (action !== 'create' && action !== 'append' && action !== 'update') continue;

    const title = typeof data.title === 'string' ? data.title : '';
    const existing = cards.get(noteId);
    if (existing) {
      if (title) existing.title = title;
      if (!existing.actions.includes(action)) existing.actions.push(action);
      existing.opCount += 1;
    } else {
      cards.set(noteId, {
        noteId,
        title,
        actions: [action],
        opCount: 1,
      });
    }
  }
  return [...cards.values()];
});

/** 操作类型的展示文案 */
const actionLabel = (action: string): string => {
  if (action === 'create') return t('sidepanel.chat.noteCardActionCreate');
  if (action === 'append') return t('sidepanel.chat.noteCardActionAppend');
  return t('sidepanel.chat.noteCardActionUpdate');
};
</script>
