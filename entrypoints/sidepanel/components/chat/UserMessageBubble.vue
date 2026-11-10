<template>
  <div class="user-bubble" :class="{ 'is-expanded': expanded, 'is-clamped': clamped }">
    <!-- 引用块：用户确认引用的网页原文（落库字段 pageQuote，气泡内唯一来源）。
         独立于正文折叠层——正文再长也不裁剪引用块，引用始终完整可读。 -->
    <blockquote v-if="quote" class="user-bubble-quote">
      <div class="user-bubble-quote-head">
        <TextQuote class="user-bubble-quote-icon" :size="12" :stroke-width="2" aria-hidden="true" />
        <span class="user-bubble-quote-tag">{{ t('sidepanel.chat.userMessageQuoteTag') }}</span>
        <span v-if="quoteSource" class="user-bubble-quote-source" :title="quote.source.url || quoteSource">
          {{ quoteSource }}
        </span>
      </div>
      <div class="user-bubble-quote-text">{{ quote.text }}</div>
    </blockquote>

    <!-- 正文区：折叠只裁剪这一层（.user-bubble-clip），正文容器本身不被限高，
         测量到的始终是完整高度，展开/收起不需要重新测量 -->
    <div v-if="content" class="user-bubble-body">
      <div
        class="user-bubble-clip"
        :style="clamped ? { maxHeight: `${clampHeightPx}px` } : undefined"
        @click="handleClipClick"
      >
        <div ref="textEl" class="user-bubble-text">
          <MarkdownText class="message-content" :content="content" />
        </div>
      </div>
      <!-- 收起态底缘渐隐：提示「下面还有内容」，避免硬切一刀的割裂感 -->
      <div v-if="clamped" class="user-bubble-fade" aria-hidden="true"></div>
    </div>

    <!-- 气泡底部操作行：左侧展开/收起入口（仅超长时出现），右侧复制按钮 -->
    <div class="user-bubble-actions">
      <button
        v-if="overflowable"
        type="button"
        class="user-bubble-expand"
        :title="expanded ? t('sidepanel.chat.userMessageCollapse') : t('sidepanel.chat.userMessageExpand')"
        :aria-label="expanded ? t('sidepanel.chat.userMessageCollapse') : t('sidepanel.chat.userMessageExpand')"
        :aria-expanded="expanded ? 'true' : 'false'"
        @click="toggleExpand"
      >
        <svg
          class="user-bubble-expand-icon"
          :class="{ expanded }"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path d="M7,10L12,15L17,10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="user-bubble-expand-text">
          {{ expanded ? t('sidepanel.chat.userMessageCollapse') : t('sidepanel.chat.userMessageExpand') }}
        </span>
      </button>
      <button
        type="button"
        class="user-bubble-copy"
        :class="{ copied }"
        :title="copied ? t('sidepanel.chat.copiedLabel') : t('sidepanel.chat.userMessageCopy')"
        :aria-label="copied ? t('sidepanel.chat.copiedLabel') : t('sidepanel.chat.userMessageCopy')"
        :disabled="!content && !quote"
        @click="copy"
      >
        <svg v-if="!copied" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" fill="currentColor"/>
        </svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 用户消息气泡（正文 + 自动收起 + 复制）
 *
 * 职责：
 *   - 正文按 Markdown 渲染（复用 MarkdownText，历史消息一次性整渲染）；
 *   - 正文超过 USER_MESSAGE_MAX_LINES 行时自动收起，超出部分由用户点击
 *     「展开全文」查看（折叠规则见 utils/chat/user-message-collapse.ts，
 *     该模块是行数阈值与溢出判定的唯一事实源）；
 *   - 气泡右下角常驻复制按钮（与模型消息操作栏共用 utils/chat/
 *     use-copy-to-clipboard.ts 的复制口径）。
 *
 * 收起只裁剪 .user-bubble-clip 一层：正文容器 .user-bubble-text 不限高，
 * 因此测量到的始终是完整高度——展开 / 收起都不需要重新测量内容。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { TextQuote } from 'lucide-vue-next';
import { t } from '@/utils/i18n';
import {
  USER_MESSAGE_MAX_LINES,
  computeClampHeightPx,
  isContentOverflowing,
  resolveLineHeightPx,
} from '../../utils/chat/user-message-collapse';
import { useCopyToClipboard } from '../../utils/chat/use-copy-to-clipboard';
import { pageQuoteSourceDisplay, type PageQuote } from '../../utils/chat/page-quote';
import MarkdownText from './MarkdownText.vue';
import './user-message-bubble.css';

const props = defineProps<{
  /** 用户输入正文（原始文本，Markdown 渲染前的源文） */
  content: string;
  /** 消息 id（仅用于失败日志定位，缺省不影响渲染） */
  messageId?: string;
  /**
   * 本条消息携带的网页引用（用户在页面选中文本并确认引用）。
   * 缺省 = 无引用（普通消息不渲染引用块）。
   */
  quote?: PageQuote;
}>();

/** 正文容器（不限高，scrollHeight 即完整正文高度） */
const textEl = ref<HTMLElement | null>(null);

/** 正文是否超出折叠阈值（超出才提供展开入口） */
const overflowable = ref(false);
/** 用户是否已展开（默认收起） */
const expanded = ref(false);
/** 折叠高度（px；实测行高 × 行数上限） */
const clampHeightPx = ref(0);

/** 当前是否处于收起态（超长且未展开） */
const clamped = computed(() => overflowable.value && !expanded.value);

/**
 * 引用来源展示：页面标题优先，其次域名，都没有则回落到中性文案。
 * 空串 = 本条消息无引用（不渲染引用块）。
 */
const quoteSource = computed<string>(() => {
  if (!props.quote) return '';
  return pageQuoteSourceDisplay(props.quote) || t('sidepanel.chat.userMessageQuoteSourceFallback');
});

/**
 * 复制口径：本条消息的全部文本（引用原文 + 用户正文）。
 * 与「这条消息实际发了什么」保持一致——只引用网页原文、不另写文字时，
 * 复制到的就是那段原文（正文为空时复制按钮不得是死的）。
 */
const copyText = computed<string>(() => {
  const quoteText = props.quote?.text?.trim() ?? '';
  const body = props.content ?? '';
  if (!quoteText) return body;
  return body ? `${quoteText}\n${body}` : quoteText;
});

const toggleExpand = (): void => {
  expanded.value = !expanded.value;
};

/**
 * 测量正文高度与行高，判断是否超长。
 * 行高取自真正承载正文的元素（MarkdownText 根节点，字号/行高由 .message-content
 * 决定）；取不到时回落到正文容器自身的计算样式。
 */
const measure = (): void => {
  const el = textEl.value;
  if (!el) return;
  const styled = (el.firstElementChild as HTMLElement | null) ?? el;
  const style = window.getComputedStyle(styled);
  const fontSize = Number.parseFloat(style.fontSize);
  const lineHeight = resolveLineHeightPx(style.lineHeight, fontSize);
  const clampHeight = computeClampHeightPx(lineHeight, USER_MESSAGE_MAX_LINES);
  clampHeightPx.value = clampHeight;
  overflowable.value = isContentOverflowing(el.scrollHeight, clampHeight);
};

/**
 * 收起态下点击正文即展开（点链接 / 按钮不触发；正在选中文本时不打断选中）。
 * 显式的「展开全文」按钮仍是主入口——点正文只是顺手的快捷路径。
 */
const handleClipClick = (event: MouseEvent): void => {
  if (!clamped.value) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('a, button')) return;
  const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
  if (selection && !selection.isCollapsed) return;
  expanded.value = true;
};

// 复制（与模型消息操作栏共用口径）
const { copied, copy } = useCopyToClipboard(
  () => copyText.value,
  () => `用户消息（messageId=${props.messageId ?? '无'}）`,
);

// ── 测量时机：挂载后 / 正文变化后 / 容器宽度变化后（换行数随宽度变化） ──

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  measure();
  // 宽度变化会改变换行数 → 行数随之变化 → 需要重新判定是否超长
  if (typeof ResizeObserver !== 'undefined' && textEl.value) {
    resizeObserver = new ResizeObserver(() => measure());
    resizeObserver.observe(textEl.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

watch(
  () => props.content,
  () => {
    // 正文换了：回到收起态并重新测量
    expanded.value = false;
    nextTick(() => measure());
  },
);
</script>
