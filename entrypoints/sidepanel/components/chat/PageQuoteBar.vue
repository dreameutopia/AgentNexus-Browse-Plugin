<!--
  网页引用条（输入框上方）

  两态：
  - 待引用（pending）：捕获到页面选区，等待用户点「确认引用」；右侧另有
    放弃按钮（图标），把这条待引用丢掉。
  - 已引用（confirmed）：用户已确认，原文固定不变、**不进入输入框**；随本轮
    消息以 <page_quote> 信封发给模型（装配见 utils/chat/page-quote.ts）。
    此时页面上再选别的内容不再响应（用户须先「取消引用」）。

  空间口径：高度随内容 1–3 行（≈32–62px），替代此前「标签独占一行 + 正文可
  滚动到 120px + 右侧按钮组」的卡片（约 160px）。原文最多三行多行展示，
  超出在原文块内出现滚动条（按钮与来源不位移）。窄宽度下逐级降级：
  来源标题 → 按钮文字 → 整条换行，任何宽度都不变形、不溢出。

  样式自带（./page-quote-bar.css）：app.css 经 App.vue 的 <style scoped> 引入，
  其规则带 App.vue 的作用域属性，对子组件根元素之外的节点不生效——
  子组件样式必须自带（与 PlanBoard / UserMessageBubble 同一约定）。
-->
<template>
  <div
    class="page-quote-bar"
    :class="`is-${state}`"
    role="status"
    aria-live="polite"
  >
    <span class="pq-mark" aria-hidden="true">
      <TextQuote v-if="state === 'pending'" :size="12" :stroke-width="2" />
      <BookmarkCheck v-else :size="12" :stroke-width="2" />
    </span>
    <span class="pq-label">{{ labelText }}</span>
    <span class="pq-text" :title="text">{{ text }}</span>
    <span v-if="sourceTitle" class="pq-source" :title="sourceUrl || sourceTitle">
      {{ sourceTitle }}
    </span>
    <div class="pq-actions">
      <button
        v-if="state === 'pending'"
        type="button"
        class="pq-btn pq-btn-confirm"
        :title="t('sidepanel.app.confirmQuote')"
        @click="emit('confirm')"
      >
        <Check :size="12" :stroke-width="2.4" aria-hidden="true" />
        <span class="pq-btn-text">{{ t('sidepanel.app.confirmQuote') }}</span>
      </button>
      <button
        v-else
        type="button"
        class="pq-btn pq-btn-cancel"
        :title="t('sidepanel.app.cancelQuote')"
        @click="emit('cancel')"
      >
        <X :size="12" :stroke-width="2.2" aria-hidden="true" />
        <span class="pq-btn-text">{{ t('sidepanel.app.cancelQuote') }}</span>
      </button>
      <!-- 待引用态的放弃入口（与「取消引用」区分：作用对象是尚未确认的选区） -->
      <button
        v-if="state === 'pending'"
        type="button"
        class="pq-btn pq-btn-ghost"
        :title="t('sidepanel.app.discardPendingQuote')"
        :aria-label="t('sidepanel.app.discardPendingQuote')"
        @click="emit('discard')"
      >
        <X :size="12" :stroke-width="2.2" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { BookmarkCheck, Check, TextQuote, X } from 'lucide-vue-next';
import { t } from '@/utils/i18n';
import type { PageQuoteState } from '../../utils/chat/page-quote';
import './page-quote-bar.css';

const props = withDefaults(
  defineProps<{
    /** 待引用 / 已引用 */
    state: PageQuoteState;
    /** 引用原文（最多三行多行展示，超出块内滚动；完整内容见 title 提示） */
    text: string;
    /** 来源页面标题（可选；窄宽度下自动隐藏） */
    sourceTitle?: string;
    /** 来源页面地址（可选；仅作提示文案） */
    sourceUrl?: string;
  }>(),
  { sourceTitle: '', sourceUrl: '' },
);

const emit = defineEmits<{
  /** 确认引用：待引用 → 已引用 */
  confirm: [];
  /** 取消引用：已引用 → 无引用 */
  cancel: [];
  /** 放弃待引用：待引用 → 无引用 */
  discard: [];
}>();

const labelText = computed(() =>
  props.state === 'confirmed'
    ? t('sidepanel.app.confirmedQuoteLabel')
    : t('sidepanel.app.pendingQuoteLabel'),
);
</script>
