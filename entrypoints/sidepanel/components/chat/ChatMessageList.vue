<template>
  <div class="chat-content" v-show="showChatMode">
      <div class="messages-container" ref="messagesContainer" @wheel.passive="handleUserScrollIntent" @touchmove.passive="handleUserScrollIntent" @pointerdown="handleUserScrollIntent">
        <MessageItem
          v-for="(message, index) in filteredMessages"
          :key="message.id || index"
          :message="message"
          :is-live="isLiveMessage(index)"
          @toggle-tool-call-expansion="forwardToolToggle"
          @toggle-reasoning-collapse="forwardReasoningToggle"
          @toggle-reasoning-content-collapse="forwardReasoningContentToggle"
          @feedback-change="forwardFeedbackChange"
        />
      </div>

      <!-- AI回答时的加载动画 -->
      <div v-if="isAiResponding" class="ai-responding-indicator">
        <div class="typing-dots">
          <span class="dot"></span>
          <span class="dot"></span>
          <span class="dot"></span>
        </div>
        <span class="responding-text">{{ t('sidepanel.chat.responding') }}</span>
      </div>
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { t } from '@/utils/i18n';
import type { ExtendedChatMessage, MessageFeedback } from '../../types/chat';
import { installDiagramRenderer, processDiagrams } from '../../utils/chat/diagram-renderer';
import { installChartRenderer, processCharts } from '../../utils/chat/chart-renderer';
import MessageItem from './MessageItem.vue';
import './chat-message-list.css';

const props = defineProps<{
  messages: ExtendedChatMessage[];
  showChatMode: boolean;
  isAiResponding: boolean;
}>();

const messagesContainer = ref<HTMLElement | null>(null);

// ==================== 自动滚动（stick-to-bottom + 用户接管检测） ====================
//
// 行为约定（对齐主流聊天客户端的通用模式）：
//   - 输出期间默认持续跟随滚动到底部；
//   - 用户任意滚动意图（滚轮 / 触摸滑动 / 拖动滚动条）即视为「接管」，
//     本次任务输出期间不再强制滚动——用户向上翻阅不被打断；
//   - 用户重新滚回底部附近（≤ 阈值）自动恢复跟随；
//   - 新一轮任务开始（isAiResponding false → true）或切换会话时重置为跟随。

/** 距底部多少像素内视为"已在底部"（恢复跟随 / 初始判定阈值） */
const NEAR_BOTTOM_PX = 24;
/** 用户接管标记：true = 本次输出期间不自动滚动 */
const userTookOver = ref(false);
/** 拖动滚动条的按压中标记（pointerdown 后到 pointerup 前的 scroll 视为用户行为） */
let pointerDownOnContainer = false;

const isNearBottom = (): boolean => {
  const el = messagesContainer.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
};

/**
 * 用户滚动意图入口（wheel / touchmove / 滚动条拖动按下）。
 * 仅在 AI 输出期间生效：空闲期的滚动浏览不代表对下一次输出的接管意愿；
 * 用户滚回底部附近时解除接管，恢复自动跟随。
 */
const handleUserScrollIntent = (event: WheelEvent | TouchEvent | PointerEvent): void => {
  if (event instanceof PointerEvent) {
    // 指针按下：可能是拖动滚动条或选择文本前的按压，记录之供 scroll 判定
    pointerDownOnContainer = true;
    window.addEventListener('pointerup', releasePointer, { once: true, passive: true });
    return;
  }
  if (!props.isAiResponding) return;
  // 滚轮向上（deltaY < 0）或触摸滑动明确是主动翻阅行为 → 接管
  if (event instanceof WheelEvent && event.deltaY < 0) {
    userTookOver.value = true;
  } else if (!(event instanceof WheelEvent)) {
    userTookOver.value = true;
  }
};

const releasePointer = (): void => {
  pointerDownOnContainer = false;
};

/** 容器 scroll 事件：跟随用户实际位置更新接管状态 */
const handleContainerScroll = (): void => {
  if (!props.isAiResponding) return;
  if (pointerDownOnContainer) {
    // 拖动滚动条产生的滚动：视位置决定——离开底部即接管
    if (!isNearBottom()) userTookOver.value = true;
    return;
  }
  // 非指针、非滚轮触发的 scroll（如程序 scrollTop 赋值）不改变接管状态；
  // 用户通过任何方式回到底部附近则恢复跟随
  if (isNearBottom()) userTookOver.value = false;
};

const scrollToBottom = () => {
  // watch 回调先于 DOM 更新触发（默认 pre flush），待补丁应用后再读 scrollHeight
  nextTick(() => {
    const el = messagesContainer.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  });
};

/** 输出期间的跟随滚动：用户已接管时跳过（保持其阅读位置） */
const followStreamIfNeeded = (): void => {
  if (userTookOver.value) return;
  scrollToBottom();
};

onMounted(() => {
  messagesContainer.value?.addEventListener('scroll', handleContainerScroll, { passive: true });
});

onBeforeUnmount(() => {
  messagesContainer.value?.removeEventListener('scroll', handleContainerScroll);
});

// 新一轮任务开始：重置接管状态，恢复跟随（上一轮的接管意愿不延续到新任务）
watch(
  () => props.isAiResponding,
  responding => {
    if (responding) {
      userTookOver.value = false;
      scrollToBottom();
    }
  },
);

// 消息数量变化时滚动到底部（新消息添加/移除；会话切换后的整表替换也走这里）
watch(
  () => props.messages.length,
  () => {
    // 会话切换（大量消息一次性替换）总是回到底部并重置接管
    userTookOver.value = false;
    scrollToBottom();
  },
);

// 流式回复中，消息内容频繁更新（onToken/onReasoning/onToolCall 触发 splice）
// 用最后一条消息的内容签名变化来检测，避免 deep watch 的性能开销
watch(
  () => {
    const msgs = filteredMessages.value;
    const last = msgs[msgs.length - 1];
    if (!last) return 0;
    return `${msgs.length}:${String(last.content).length}:${last.parts?.length ?? 0}:${last.reasoning_content?.length ?? 0}`;
  },
  () => followStreamIfNeeded(),
);

// ==================== 图表渲染（Mermaid / PlantUML / ECharts） ====================
// 消息 DOM 的重写来源多样（流式 token、前奏折叠展开重建、历史会话加载），
// 统一用子树 MutationObserver + 去抖扫描驱动 diagram-renderer / chart-renderer；
// 直播流中的消息带 [data-streaming] 标记，扫描时跳过（此时 v-html 逐 token
// 重写会反复清掉已渲染产物），流结束后由下方 watch 立即补扫。
let diagramObserver: MutationObserver | null = null;
let diagramScanTimer: number | undefined;

const scheduleDiagramScan = () => {
  window.clearTimeout(diagramScanTimer);
  diagramScanTimer = window.setTimeout(() => {
    if (messagesContainer.value) {
      processDiagrams(messagesContainer.value);
      processCharts(messagesContainer.value);
    }
  }, 300);
};

onMounted(() => {
  installDiagramRenderer();
  installChartRenderer();
  if (messagesContainer.value) {
    processDiagrams(messagesContainer.value);
    processCharts(messagesContainer.value);
    diagramObserver = new MutationObserver(scheduleDiagramScan);
    // attributes + data-streaming 过滤：流结束时 Vue 移除该属性属于 attribute
    // 变更（无 childList 变化），不监听则最后一条消息的图表会漏渲染
    diagramObserver.observe(messagesContainer.value, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-streaming'],
    });
  }
});

onBeforeUnmount(() => {
  diagramObserver?.disconnect();
  diagramObserver = null;
  window.clearTimeout(diagramScanTimer);
});

// 流结束双保险：不等 attribute 变更回调，立即调度扫描，
// 确保最后一条（刚脱离直播态的）消息中的图表第一时间渲染
watch(
  () => props.isAiResponding,
  responding => {
    if (!responding) scheduleDiagramScan();
  },
);

// ==================== 事件契约与消息过滤 ====================

// 事件契约（与 App.vue 模板绑定一一对应）；forward* 转发自 MessageItem 子组件
const emit = defineEmits<{
  'toggle-tool-call-expansion': [messageId: string, toolCallId: string];
  'toggle-reasoning-collapse': [messageId: string, partIndex: number];
  'toggle-reasoning-content-collapse': [messageId: string];
  /** 模型消息反馈（赞/踩；null = 清除），由 App 落库并回写列表 */
  'feedback-change': [messageId: string, feedback: MessageFeedback | null];
}>();

const forwardToolToggle = (messageId: string, toolCallId: string) => {
  emit('toggle-tool-call-expansion', messageId, toolCallId);
};
const forwardReasoningToggle = (messageId: string, partIndex: number) => {
  emit('toggle-reasoning-collapse', messageId, partIndex);
};
const forwardReasoningContentToggle = (messageId: string) => {
  emit('toggle-reasoning-content-collapse', messageId);
};
const forwardFeedbackChange = (messageId: string, feedback: MessageFeedback | null) => {
  emit('feedback-change', messageId, feedback);
};

const filteredMessages = computed(() => {
  // 先过滤掉忽略的消息，然后按ID去重
  const uniqueMessages = new Map<string, ExtendedChatMessage>();
  props.messages.filter(msg => !msg.isIgnore).forEach(msg => {
    if (msg.id) {
      // 如果已存在相同ID的消息，保留更新的那个（reasoning_content更完整的）
      const existing = uniqueMessages.get(msg.id);
      if (!existing) {
        uniqueMessages.set(msg.id, msg);
      }
    } else {
      // 没有ID的消息，保留
      uniqueMessages.set(`temp-${Math.random()}`, msg);
    }
  });
  return Array.from(uniqueMessages.values());
});

/** 直播态判定：AI 正在回应且本条是最后一条消息（历史消息即使在回应期间也视为已结束） */
const isLiveMessage = (index: number): boolean =>
  props.isAiResponding && index === filteredMessages.value.length - 1;
</script>
