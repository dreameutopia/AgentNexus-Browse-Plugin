<template>
  <!-- 根元素不写死样式类：class 由使用方透传（message-content / reasoning-content） -->
  <div v-html="html"></div>
</template>

<script setup lang="ts">
/**
 * Markdown 文本片段渲染（流式节流 + 片段级隔离）
 *
 * 性能设计（流式聊天 UI 的通用实践）：
 *   - 以「片段」为渲染隔离单位：每个文本片段一个组件实例，props 内容
 *     未变化的片段被 Vue 浅比较跳过，长会话中只有正在增长的片段重排；
 *   - 直播中（streaming=true）对 Markdown 重排做 120ms 前沿+尾随节流：
 *     token 到达频率通常远高于该间隔，整段重解析 + v-html 重写的成本
 *     被摊平为恒定频率，视觉上仍保持连续的"打字机"感；
 *   - 流结束（streaming 翻转为 false）立即执行一次终排，保证最终内容
 *     与转录逐字一致（含图表/文件卡片等后处理标记的完整渲染）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { markdownRenderer } from '../../utils/chat/markdown-renderer';

const props = defineProps<{
  content: string;
  /** 是否处于直播流（节流开启）；默认 false = 已结束片段，直接渲染 */
  streaming?: boolean;
}>();

/** 直播节流间隔（毫秒） */
const STREAM_THROTTLE_MS = 120;

let timer: number | undefined;
/** 节流窗口内实际用于渲染的内容（落后于 props.content 至多一个节流间隔） */
const renderedContent = ref(props.content);

const scheduleRender = (): void => {
  if (timer !== undefined) return;
  timer = window.setTimeout(() => {
    timer = undefined;
    renderedContent.value = props.content;
  }, STREAM_THROTTLE_MS);
};

watch(
  () => props.content,
  value => {
    if (!props.streaming) {
      renderedContent.value = value;
      return;
    }
    scheduleRender();
  },
);

// 流结束：取消挂起的节流并立即终排
watch(
  () => props.streaming,
  streaming => {
    if (!streaming) {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      renderedContent.value = props.content;
    }
  },
);

onBeforeUnmount(() => {
  if (timer !== undefined) window.clearTimeout(timer);
});

const html = computed(() => markdownRenderer.renderMessage(renderedContent.value));
</script>
