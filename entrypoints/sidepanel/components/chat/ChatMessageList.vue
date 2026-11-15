<template>
  <div class="chat-content" v-show="showChatMode">
      <div
        class="messages-container"
        ref="messagesContainer"
        @wheel.passive="handleUserScrollIntent"
        @touchmove.passive="handleUserScrollIntent"
      >
        <MessageItem
          v-for="(message, index) in filteredMessages"
          :key="message.id || index"
          :message="message"
          :is-live="isLiveMessage(message, index)"
          @toggle-tool-call-expansion="forwardToolToggle"
          @toggle-reasoning-collapse="forwardReasoningToggle"
          @toggle-reasoning-content-collapse="forwardReasoningContentToggle"
          @toggle-compaction-collapse="forwardCompactionToggle"
          @feedback-change="forwardFeedbackChange"
          @guard-continue="forwardGuardContinue"
          @guard-open-settings="forwardGuardOpenSettings"
          @create-skill="openSkillCapture"
        />
      </div>

      <SkillCapturePrompt ref="skillCapturePrompt" :visible="captureState.eligible" :message-id="captureState.messageId" :scope-key="(chatId ?? '') + ':' + captureState.scope" :disabled="isAiResponding" @create="emit('create-skill', $event)" />
      <!-- 回答内截图的看图层：点击截图卡片图片时挂载（Teleport 到 body，遮罩覆盖侧边栏） -->
      <ImageViewer
        v-if="agentImageViewer"
        :items="agentImageViewer.items"
        :index="agentImageViewer.index"
        @update:index="onAgentImageIndex"
        @close="agentImageViewer = null"
      />
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
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, toRef, watch } from 'vue';
import { t } from '@/utils/i18n';
import type { ExtendedChatMessage, MessageFeedback, MessagePart } from '../../types/chat';
import { installDiagramRenderer, processDiagrams } from '../../utils/chat/diagram-renderer';
import { installChartRenderer, processCharts } from '../../utils/chat/chart-renderer';
import { installAgentImageRenderer, processAgentImages, AGENT_IMAGE_OPEN_EVENT } from '../../utils/chat/agent-image-renderer';
import type { AgentImageOpenDetail } from '../../utils/chat/agent-image-renderer';
import MessageItem from './MessageItem.vue';
import SkillCapturePrompt from './SkillCapturePrompt.vue';
import ImageViewer from './ImageViewer.vue';
import { skillCaptureState } from '../../utils/chat/skill-capture';
import './chat-message-list.css';

const props = defineProps<{
  chatId?: string;
  messages: ExtendedChatMessage[];
  showChatMode: boolean;
  isAiResponding: boolean;
  /**
   * 当前直播消息 id（运行中的助手记录 id）。
   * 提供时直播判定按 id 命中——任何在运行期间追加到列表尾部的其它消息
   * （历史注记、错误卡片等）都不会再把流式消息挤成「已结束」渲染；
   * 缺省时回退「最后一条」启发式（测试与旧调用方兼容）。
   */
  liveMessageId?: string | null;
}>();
provide('workspaceChatId', toRef(props, 'chatId'));
const skillCapturePrompt = ref<InstanceType<typeof SkillCapturePrompt> | null>(null);
const captureState = computed(() => skillCaptureState(props.messages, props.isAiResponding));
const openSkillCapture = (messageId: string) => { if (!props.isAiResponding) skillCapturePrompt.value?.open(messageId); };

const messagesContainer = ref<HTMLElement | null>(null);

// A watch source runs during registration even without immediate:true. Define
// every source dependency before registering any watcher (production TDZ fix).
const filteredMessages = computed(() => {
  const uniqueMessages = new Map<string | number, ExtendedChatMessage>();
  props.messages.forEach((message, index) => {
    if (message.isIgnore) return;
    const key = message.id || index;
    if (!uniqueMessages.has(key)) uniqueMessages.set(key, message);
  });
  return Array.from(uniqueMessages.values());
});

// ==================== 自动滚动（stick-to-bottom + 用户接管检测） ====================
//
// 行为约定（对齐主流聊天客户端的通用模式）：
//   - 输出期间默认持续跟随滚动到底部；
//   - 用户任意滚动意图（滚轮向上 / 触摸滑动 / 拖动滚动条 / 键盘翻页）即视为
//     「接管」，本次任务输出期间不再强制滚动——用户向上翻阅不被打断；
//   - 用户重新滚回底部附近（≤ 阈值）自动恢复跟随；
//   - 新一轮任务开始（isAiResponding false → true）或切换会话时重置为跟随。
//
// 滚动容器探测：本组件只拥有内容节点（.messages-container，flex 布局自身
// 不滚动），真正的滚动发生在祖先链上（当前为 .chat-content，见 app.css）。
// 历史实现把 scrollTop 赋值与 scroll 监听全放在内容节点上——对不滚动的
// 元素赋值是空操作、scroll 事件永不触发，自动跟随与接管释放全部失效。
// 现按「最近的 overflow-y:auto/scroll 祖先」在运行时解析，样式重构挪动
// 滚动容器时无需改这里；断连（DOM 重建）时自动重新解析。

/** 距底部多少像素内视为"已在底部"（恢复跟随 / 初始判定阈值） */
const NEAR_BOTTOM_PX = 24;
/** 用户接管标记：true = 本次输出期间不自动滚动 */
const userTookOver = ref(false);
/** 解析出的真实滚动容器（内容节点的最近可滚动祖先；未解析/断连时为 null） */
let scrollEl: HTMLElement | null = null;

/**
 * 解析真实滚动容器：从内容节点向上找第一个 overflow-y 为 auto/scroll/overlay
 * 的祖先。只看声明的 overflow 而非「当前是否溢出」——容器即使暂时没有
 * 滚动余量也是既定的滚动容器。找不到时回退到内容节点的父元素（组件根，
 * 与现行 CSS 的滚动容器一致），保证逻辑永远有一个明确的落点。
 */
const resolveScrollEl = (): HTMLElement | null => {
  if (scrollEl && scrollEl.isConnected) return scrollEl;
  const start = messagesContainer.value;
  if (!start) return null;
  let node: HTMLElement | null = start.parentElement;
  while (node && node !== document.body) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
      scrollEl = node;
      return scrollEl;
    }
    node = node.parentElement;
  }
  scrollEl = start.parentElement;
  return scrollEl;
};

const isNearBottom = (): boolean => {
  const el = resolveScrollEl();
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
};

/**
 * 用户滚动意图入口（wheel / touchmove）。
 * - AI 输出期间：任何向上翻阅都视为接管，本次任务不再强制滚动；
 * - 会话切换贴底窗口内：向上翻阅 / 触摸滑动同样让位并结束窗口。
 * wheel 向上要在事件层拦截——容器已在顶部时滚轮向上不产生 scroll 事件，
 * 只有这里能捕捉到该意图；触摸滑动同理（惯性滚动后续由 scroll 事件兜底）。
 */
const handleUserScrollIntent = (event: WheelEvent | TouchEvent): void => {
  // 向下滚动与贴底同方向，不属于「翻阅离开」，不打断任何跟随
  if (event instanceof WheelEvent && event.deltaY >= 0) return;
  if (settleActive) {
    userTookOver.value = true;
    stopSwitchSettle();
  }
  if (!props.isAiResponding) return;
  userTookOver.value = true;
};

/**
 * 自己的程序滚动忽略窗口（毫秒）：scrollTop 赋值后的 scroll 事件异步到达，
 * 窗口内的事件不参与接管判定，避免把自己的跟随滚动误判为用户离开底部。
 */
const PROGRAMMATIC_SCROLL_IGNORE_MS = 64;
let programmaticScrollUntil = 0;

/**
 * 会话切换贴底窗口上限（毫秒）。
 * 内容尺寸可能在首帧之后继续变化（Markdown 异步排版、图片解码、
 * Mermaid/ECharts 去抖渲染），窗口内每次尺寸变化都重新贴底；
 * 到达上限后必定收手，避免长任务/异常布局把窗口无限拖长。
 */
const SWITCH_SETTLE_MAX_MS = 3000;

/** 贴底窗口是否生效（窗口内尺寸变化持续贴底） */
let settleActive = false;
/** 待执行的贴底帧（0 = 无；同一帧内的多次尺寸变化合并为一次写入） */
let settleFrame = 0;
/** 窗口到期定时器（解除观察的硬兜底） */
let settleDeadlineTimer: number | undefined;
/** 内容节点尺寸观察器（只在窗口内连接，窗口结束即断开） */
let settleObserver: ResizeObserver | null = null;

/**
 * 滚动容器的 scroll 事件：跟随用户实际位置更新接管状态。
 * - 回到底部附近 → 解除接管，恢复跟随；
 * - 离开底部（滚动条拖动 / 键盘翻页 / 选择拖动等不经容器内 wheel 的路径）
 *   → 接管。内容增长本身不触发 scroll 事件（scrollTop 不变），布局收缩时
 *   浏览器钳制后仍处底部，因此「离开底部」可以安全地等价于用户主动离开。
 * 贴底窗口内同样适用：用户主动离开底部即结束窗口，不抢阅读位置。
 */
const handleContainerScroll = (): void => {
  if (!props.isAiResponding && !settleActive) return;
  if (performance.now() < programmaticScrollUntil) return;
  if (isNearBottom()) {
    userTookOver.value = false;
    return;
  }
  userTookOver.value = true;
  if (settleActive) stopSwitchSettle();
};

/** 贴底写入：一次读 scrollHeight + 一次赋值，尽量落在同一帧 */
const pinToBottomNow = (): void => {
  const el = resolveScrollEl();
  // 软断连（DOM 被替换/卸载）时放弃本次写入，避免操作游离节点
  if (!el || !el.isConnected) return;
  el.scrollTop = el.scrollHeight;
  programmaticScrollUntil = performance.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
};

/** 请求下一帧贴底；同一帧内多次请求合并为一次写入（防抖 + 避免布局抖动） */
const schedulePinToBottom = (): void => {
  if (settleFrame) return;
  if (typeof window.requestAnimationFrame === 'function') {
    settleFrame = window.requestAnimationFrame(() => {
      settleFrame = 0;
      if (!userTookOver.value) pinToBottomNow();
    });
    return;
  }
  // 无 rAF 环境（旧内核 / 无头测试）退回宏任务，语义一致
  settleFrame = window.setTimeout(() => {
    settleFrame = 0;
    if (!userTookOver.value) pinToBottomNow();
  }, 16);
};

/** 取消待执行的贴底帧（帧回调与超时回调共用同一个 id 槽位） */
const cancelSettleFrame = (): void => {
  if (!settleFrame) return;
  if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(settleFrame);
  else window.clearTimeout(settleFrame);
  settleFrame = 0;
};

/** 结束会话切换贴底窗口：清理帧、定时器与观察器（幂等，可在各类收尾路径重复调用） */
const stopSwitchSettle = (): void => {
  settleActive = false;
  cancelSettleFrame();
  if (settleDeadlineTimer !== undefined) {
    window.clearTimeout(settleDeadlineTimer);
    settleDeadlineTimer = undefined;
  }
  settleObserver?.disconnect();
  settleObserver = null;
};

/**
 * 启动（或重置）会话切换贴底窗口。
 *
 * 切换会话（含侧边栏启动恢复）时消息列表在同一批更新里整体替换，首帧只保证
 * 「结构已挂载」；此后异步排版、图片解码、图表渲染与去抖扫描仍会继续撑高内容。
 * 只滚一次会停在旧高度，因此窗口期内用 ResizeObserver 盯住内容节点：
 *   - 每次尺寸变化 → 合帧调度一次贴底写入；
 *   - 用户向上翻阅 → 立即结束窗口（handleUserScrollIntent / handleContainerScroll）；
 *   - 到期 → 自动断开观察器，窗口外零开销。
 * 空列表直接跳过（无可滚动内容，也不值得连接观察器）。
 */
const startSwitchSettle = (): void => {
  stopSwitchSettle();
  // 落到某个会话时重置接管意愿：切换后的默认阅读位置就是底部
  userTookOver.value = false;
  if (!props.messages.length) return;
  settleActive = true;
  schedulePinToBottom();
  const content = messagesContainer.value;
  if (typeof ResizeObserver !== 'undefined' && content) {
    settleObserver = new ResizeObserver(() => {
      if (settleActive && !userTookOver.value) schedulePinToBottom();
    });
    settleObserver.observe(content);
  }
  settleDeadlineTimer = window.setTimeout(stopSwitchSettle, SWITCH_SETTLE_MAX_MS);
};

const scrollToBottom = (): void => {
  // watch 回调先于 DOM 更新触发（默认 pre flush），待补丁应用后再读 scrollHeight
  nextTick(pinToBottomNow);
};

/** 输出期间的跟随滚动：用户已接管时跳过（保持其阅读位置） */
const followStreamIfNeeded = (): void => {
  if (userTookOver.value) return;
  scrollToBottom();
};

onMounted(() => {
  resolveScrollEl()?.addEventListener('scroll', handleContainerScroll, { passive: true });
  // App 以 activeChatId 作为本组件 key：每次切换会话都会重建实例，
  // 挂载时的消息已是目标会话内容。启动贴底窗口等首帧与异步渲染落地。
  startSwitchSettle();
});

onBeforeUnmount(() => {
  scrollEl?.removeEventListener('scroll', handleContainerScroll);
  scrollEl = null;
  stopSwitchSettle();
});

// 会话切换兜底：组件按 key 重建时走 onMounted；未来若去掉 key，
// chatId 变化同样重新进入贴底窗口，保证「切换即回底」的语义不变
watch(
  () => props.chatId,
  () => startSwitchSettle(),
);

// 从欢迎态进入聊天态：内容可能在隐藏期间完成渲染（隐藏时 scrollHeight 为 0，
// 贴底写入是空操作），显示后需补一次贴底
watch(
  () => props.showChatMode,
  visible => {
    if (visible) startSwitchSettle();
  },
);

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

// ==================== 回答内截图看图层（<agent-image>） ====================
//
// 截图卡片由 markdown 渲染成可信 HTML 骨架，图片本体由 agent-image-renderer
// 异步注入（图片库读取是异步的）。点击图片时渲染层派发文档级事件，本组件
// 接管并挂载共享看图层 ImageViewer——遮罩在侧边栏内，放大 / 缩小 /
// 在网页中打开 / 下载由共享组件统一提供（与消息底部图片区同一份实现）。

/** 看图层状态（null = 未打开） */
const agentImageViewer = ref<{
  items: { ref: string; url: string; name: string; alt: string }[];
  index: number;
} | null>(null);

/** 点击截图 → 打开侧边栏内遮罩看图层 */
const onAgentImageOpen = (event: Event): void => {
  const detail = (event as CustomEvent<AgentImageOpenDetail>).detail;
  if (!detail?.url) return;
  agentImageViewer.value = { items: [{ ...detail }], index: 0 };
};

/** 看图层翻页（受控回传） */
const onAgentImageIndex = (index: number): void => {
  if (!agentImageViewer.value) return;
  agentImageViewer.value = { ...agentImageViewer.value, index };
};

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
      processAgentImages(messagesContainer.value);
    }
  }, 300);
};

onMounted(() => {
  installDiagramRenderer();
  installChartRenderer();
  installAgentImageRenderer();
  document.addEventListener(AGENT_IMAGE_OPEN_EVENT, onAgentImageOpen);
  if (messagesContainer.value) {
    processDiagrams(messagesContainer.value);
    processCharts(messagesContainer.value);
    processAgentImages(messagesContainer.value);
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
  document.removeEventListener(AGENT_IMAGE_OPEN_EVENT, onAgentImageOpen);
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
  'create-skill': [request: { messageId: string; extra: string }];
  'toggle-tool-call-expansion': [messageId: string, toolCallId: string];
  'toggle-reasoning-collapse': [messageId: string, partIndex: number];
  'toggle-reasoning-content-collapse': [messageId: string];
  /** 压缩片段展开/收起（partIndex 定位 message.parts 原始下标） */
  'toggle-compaction-collapse': [messageId: string, partIndex: number];
  /** 模型消息反馈（赞/踩；null = 清除），由 App 落库并回写列表 */
  'feedback-change': [messageId: string, feedback: MessageFeedback | null];
  /** 守卫停止注记的「继续」：App 统一做时效判定后自动续跑 */
  'guard-continue': [messageId: string, partIndex: number];
  /** 守卫停止注记的「修改设置」：App 打开设置弹窗并定位 */
  'guard-open-settings': [guardKind: MessagePart['guardKind']];
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
const forwardCompactionToggle = (messageId: string, partIndex: number) => {
  emit('toggle-compaction-collapse', messageId, partIndex);
};
const forwardFeedbackChange = (messageId: string, feedback: MessageFeedback | null) => {
  emit('feedback-change', messageId, feedback);
};
const forwardGuardContinue = (messageId: string, partIndex: number) => {
  emit('guard-continue', messageId, partIndex);
};
const forwardGuardOpenSettings = (guardKind: MessagePart['guardKind']) => {
  emit('guard-open-settings', guardKind);
};

/**
 * 直播态判定：AI 正在回应，且本条是直播消息。
 * 优先按 liveMessageId 精确命中（运行记录 id 由 App 维护）——运行期间
 * 追加到列表尾部的任何其它消息（压缩注记、错误卡片、别会话串扰残留）
 * 都不再把流式消息翻成「已结束」渲染（大折叠 + 反馈按钮提前出现）。
 * 缺省回退「最后一条」启发式（历史行为）。
 */
const isLiveMessage = (message: ExtendedChatMessage, index: number): boolean => {
  if (!props.isAiResponding) return false;
  if (props.liveMessageId) return message.id === props.liveMessageId;
  return index === filteredMessages.value.length - 1;
};
</script>
