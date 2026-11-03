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

      <!-- ════ 直播态（流式进行中 / 用户消息 / 无末段正文的记录）：
           维持原有顺序全量渲染，过程内容实时可见 ════ -->
      <template v-if="!usePreludeCollapse">
        <!-- 推理内容特殊渲染（仅当没有reasoning类型的parts时显示，保持向后兼容） -->
        <div v-if="legacyReasoningVisible" :class="['reasoning-container', { collapsed: message._reasoningContentCollapsed }]">
          <div class="reasoning-header" @click="emit('toggle-reasoning-content-collapse', message.id!)">
            <div class="reasoning-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M13 3C9.23 3 6.19 5.95 6 9.66l-1.92 2.53c-.24.31 0 .81.42.81H6v3c0 1.1.9 2 2 2h1v3h7v-4.69c2.37-1.12 4-3.51 4-6.31 0-3.87-3.13-7-7-7m2 11h-1v4h-3v-4H9v-3H7.23L9 8.34C9.31 5.93 11 4 13 4c2.76 0 5 2.24 5 5 0 2.04-1.23 3.81-3 4.58V14z" fill="#8b5cf6"/>
              </svg>
            </div>
            <span class="reasoning-title">{{ t('sidepanel.chat.reasoningTitle') }}</span>
            <svg class="reasoning-expand-icon" :class="{ collapsed: message._reasoningContentCollapsed }" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" fill="currentColor"/>
            </svg>
          </div>
          <div v-if="!message._reasoningContentCollapsed" class="reasoning-content" v-html="renderMessage(message.reasoning_content || '')"></div>
        </div>

        <MessageParts
          :parts="indexedVisibleParts"
          :message-id="message.id || ''"
          :streaming="isLive"
          @toggle-tool-call-expansion="forwardToolToggle"
          @toggle-reasoning-collapse="forwardReasoningToggle"
        />
      </template>

      <!-- ════ 结束态分组渲染：末段正文之前的内容（推理/工具/中间文本）
           收入可折叠「前奏」容器，正文主体始终直接可见 ════ -->
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
            <span v-if="groups.hasReasoning || groups.toolCount > 0" class="prelude-summary">
              <template v-if="groups.hasReasoning">{{ t('sidepanel.chat.preludeReasoning') }}</template>
              <template v-if="groups.hasReasoning && groups.toolCount > 0">&nbsp;·&nbsp;</template>
              <template v-if="groups.toolCount > 0">{{ t('sidepanel.chat.preludeTools', { count: groups.toolCount }) }}</template>
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
                <div class="reasoning-header" @click="emit('toggle-reasoning-content-collapse', message.id!)">
                  <div class="reasoning-icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M13 3C9.23 3 6.19 5.95 6 9.66l-1.92 2.53c-.24.31 0 .81.42.81H6v3c0 1.1.9 2 2 2h1v3h7v-4.69c2.37-1.12 4-3.51 4-6.31 0-3.87-3.13-7-7-7m2 11h-1v4h-3v-4H9v-3H7.23L9 8.34C9.31 5.93 11 4 13 4c2.76 0 5 2.24 5 5 0 2.04-1.23 3.81-3 4.58V14z" fill="#8b5cf6"/>
                    </svg>
                  </div>
                  <span class="reasoning-title">{{ t('sidepanel.chat.reasoningTitle') }}</span>
                  <svg class="reasoning-expand-icon" :class="{ collapsed: message._reasoningContentCollapsed }" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z" fill="currentColor"/>
                  </svg>
                </div>
                <div v-if="!message._reasoningContentCollapsed" class="reasoning-content" v-html="renderMessage(message.reasoning_content || '')"></div>
              </div>

              <MessageParts
                :parts="groups.prelude"
                :message-id="message.id || ''"
                @toggle-tool-call-expansion="forwardToolToggle"
                @toggle-reasoning-collapse="forwardReasoningToggle"
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
        />
        <!-- 正文之后的残余片段（如中止前最后的工具调用）：不折叠，保持原样 -->
        <MessageParts
          v-if="groups.tail.length > 0"
          :parts="groups.tail"
          :message-id="message.id || ''"
          @toggle-tool-call-expansion="forwardToolToggle"
          @toggle-reasoning-collapse="forwardReasoningToggle"
        />
      </template>

      <!-- 如果没有parts但有content或toolCalls -->
      <template v-if="(!message.parts || message.parts.length === 0) && ((message.content && !message.reasoning_content) || (message.toolCalls && message.toolCalls.length > 0))">
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

      <!-- ════ 模型消息操作栏：复制 / 赞 / 踩（结束后显示；耗时在无前奏收起条时兜底展示于此右侧） ════ -->
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
import { computed, onBeforeUnmount, ref } from 'vue';
import { t } from '@/utils/i18n';
import type { ExtendedChatMessage, IndexedMessagePart, MessageFeedback } from '../../types/chat';
import { markdownRenderer } from '../../utils/chat/markdown-renderer';
import { formatDuration } from '../../utils/chat/duration';
import { openNoteDetail } from '../../utils/chat/note-nav';
import { message as toast } from '../../utils/chat/message';
import ToolCallItem from './ToolCallItem.vue';
import MessageParts from './MessageParts.vue';
import MessageImages from './MessageImages.vue';

const props = defineProps<{
  message: ExtendedChatMessage;
  /** 是否直播中（AI 正在回应且本条是最新一条） */
  isLive: boolean;
}>();

const emit = defineEmits<{
  'toggle-tool-call-expansion': [messageId: string, toolCallId: string];
  'toggle-reasoning-collapse': [messageId: string, partIndex: number];
  'toggle-reasoning-content-collapse': [messageId: string];
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
 * 带原始索引的可见片段列表。
 * 过滤（<think> 剥离、空片段剔除）会使数组下标与 message.parts 脱钩，
 * 折叠/展开等回传事件必须携带原始索引才能在 App.vue 中正确定位片段。
 */
const indexedVisibleParts = computed<IndexedMessagePart[]>(() => {
  const parts = props.message.parts || [];
  const result: IndexedMessagePart[] = [];
  parts.forEach((part, index) => {
    if (part.type === 'text') {
      if (!part.content) return;
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
    result.push({ index, part });
  });
  return result;
});

interface AnswerGroups {
  /** 末段正文之前的片段（推理 / 工具调用 / 中间过渡文本 / 系统注记） */
  prelude: IndexedMessagePart[];
  /** 末段正文（最后一个含内容的文本片段） */
  final: IndexedMessagePart | null;
  /** 正文之后的残余片段（如中止前最后一批工具调用） */
  tail: IndexedMessagePart[];
  hasReasoning: boolean;
  toolCount: number;
}

/** 按末段正文切分消息片段（结束态分组的依据） */
const groups = computed<AnswerGroups>(() => {
  const indexed = indexedVisibleParts.value;
  let lastTextPos = -1;
  for (let i = indexed.length - 1; i >= 0; i--) {
    if (indexed[i].part.type === 'text') {
      lastTextPos = i;
      break;
    }
  }
  const hasReasoning =
    !!props.message.reasoning_content?.trim() || indexed.some(it => it.part.type === 'reasoning');
  const toolCount =
    props.message.toolCalls?.length ?? indexed.filter(it => it.part.type === 'tool').length;
  if (lastTextPos === -1) {
    return { prelude: [], final: null, tail: indexed, hasReasoning, toolCount };
  }
  return {
    prelude: indexed.slice(0, lastTextPos),
    final: indexed[lastTextPos],
    tail: indexed.slice(lastTextPos + 1),
    hasReasoning,
    toolCount,
  };
});

/** 兼容旧记录：仅有 reasoning_content、无 reasoning 类型 parts */
const legacyReasoningVisible = computed(
  () =>
    !!(props.message.reasoning_content && !(props.message.parts && props.message.parts.some(p => p.type === 'reasoning'))),
);

/** 末段正文片段（单元素数组；无正文时为空数组，供模板直接绑定） */
const finalPartList = computed<IndexedMessagePart[]>(() => {
  const final = groups.value.final;
  return final ? [final] : [];
});

/**
 * 是否启用「前奏折叠」分组渲染：
 * 助手消息 + 已结束 + 存在末段正文 + 正文之前确有可折叠内容。
 * 其余情形（用户消息 / 直播态 / 纯文本回答 / 无正文记录）走原有顺序渲染。
 */
const usePreludeCollapse = computed(() => {
  if (props.message.role !== 'assistant' || props.isLive) return false;
  if (!groups.value.final) return false;
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

/** 复制成功反馈态（2 秒后复原） */
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer);
});

/**
 * 待复制正文（computed 缓存：正文变化才重建，点击与 disabled 判定零重复计算）。
 * 字符串直接用；多模态数组仅取文本块（图片不参与复制）。
 */
const copyableText = computed<string>(() => {
  const content = props.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(item => item.type === 'text')
      .map(item => item.text || '')
      .join('\n');
  }
  return '';
});

const copyMessage = async (): Promise<void> => {
  const text = copyableText.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch (error) {
    // 剪贴板不可用（权限 / 非安全上下文 / 内容超限）：
    // 复位成功态避免「已复制」误导，toast 给出可读提示，控制台保留可分析细节
    copied.value = false;
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[MessageItem] 消息复制失败（messageId=${props.message.id ?? '无'}）: ${reason}`, error);
    toast.error(t('sidepanel.chat.copyFailed'));
  }
};

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
