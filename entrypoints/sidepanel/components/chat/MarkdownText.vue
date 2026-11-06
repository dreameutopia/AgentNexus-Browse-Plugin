<template>
  <!-- 根元素不写死样式类：class 由使用方透传（message-content / reasoning-content）。
       DOM 由本组件自行管理（不用 v-html 绑定）：直播中按「冻结稳定区 + 活动
       尾部」增量维护，历史片段一次性整渲染——两种路径产物与旧版 v-html 等价 -->
  <div ref="rootEl"></div>
</template>

<script setup lang="ts">
/**
 * Markdown 文本片段渲染（流式增量冻结 + 片段级隔离）
 *
 * 性能设计（流式聊天 UI 的通用实践，对标 Streamdown / Incremark 的
 * 「完成块冻结」模式）：
 *   - 以「片段」为渲染隔离单位：每个文本片段一个组件实例，props 内容
 *     未变化的片段被 Vue 浅比较跳过，长会话中只有正在增长的片段重排；
 *   - 直播中（streaming=true）把内容切为两区：
 *       · 稳定区（findStableBoundary 探测的已闭合前缀，典型锚点是闭合的
 *         ```component / ```mermaid 围栏）：按新增前缀**追加式**渲染成
 *         [data-md-stable] 段落，渲染一次后永不触碰——已挂载的图表
 *         iframe / Mermaid SVG 在后续 token 到达时不被销毁重建；
 *       · 活动尾部（[data-streaming] 标记）：120ms 节流整段重渲染，
 *         成本只与尾部长度相关，视觉保持连续「打字机」感；
 *   - 流结束（streaming 翻转为 false）：把剩余尾部作为最后一个冻结段
 *     追加（终排），已挂载组件原样保留；未经历过直播的片段（历史消息）
 *     走一次性整渲染，与旧版 v-html 行为逐字一致；
 *   - 前缀改写（编辑 / 回退，罕见）：稳定区整体重建一次，随后继续追加。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { markdownRenderer } from '../../utils/chat/markdown-renderer';
import { findStableBoundary } from '../../utils/chat/stable-boundary';

const props = withDefaults(
  defineProps<{
    content: string;
    /** 是否处于直播流（增量冻结 + 节流开启）；默认 false = 已结束片段，一次性整渲染 */
    streaming?: boolean;
  }>(),
  { streaming: false },
);

/** 直播节流间隔（毫秒；只作用于活动尾部与稳定区推进） */
const STREAM_THROTTLE_MS = 120;

const rootEl = ref<HTMLElement | null>(null);

let timer: number | undefined;

/** 稳定区已覆盖的源文前缀（追加式冻结的事实源；仅增长，改写即整体重建） */
let frozenSource = '';
/** 上次渲染进活动尾部的源文（相同则跳过重写，减少 DOM 变更与观察器噪声） */
let lastTailSource: string | null = null;
/** 是否经历过直播：true = 结束时走「尾部终冻结」；false = 历史片段一次性整渲染 */
let everLive = false;
/** 结构就绪标记：mounted 前的 watch 触发只记待应用，不直接操作 DOM */
let mounted = false;
/** 挂载时待应用的内容（watch immediate 先于 onMounted 触发的竞态兜底） */
let pendingApply: (() => void) | null = null;

/** 渲染一段源文（复用完整管线：占位符摘出 / fence 分发 / 表格工具栏 / 回填） */
function renderSegment(text: string): string {
  try {
    return markdownRenderer.renderMessage(text);
  } catch (error) {
    // 渲染器内部已有全量兜底（renderMessage catch → 转义原文）；此处防御
    // 极端环境异常，保证直播 UI 不因单个片段崩溃
    console.warn('[MarkdownText] 片段渲染失败，降级为空段:', error);
    return '';
  }
}

/** 追加一个冻结段（[data-md-stable]；渲染一次后本组件不再触碰其内部） */
function appendStableSegment(text: string): void {
  const root = rootEl.value;
  if (!root || !text) return;
  const segment = document.createElement('div');
  segment.className = 'md-seg-stable';
  segment.dataset.mdStable = '1';
  segment.innerHTML = renderSegment(text);
  // 活动尾部恒为最后一个子节点：新冻结段插入到尾部之前，保持源文顺序
  const tail = root.lastElementChild;
  if (tail && tail.classList.contains('md-live-tail')) {
    root.insertBefore(segment, tail);
  } else {
    root.appendChild(segment);
  }
  frozenSource += text;
}

/** 稳定区整体重建（前缀改写 / 复位；已挂载组件随 DOM 清除一并释放） */
function rebuildStable(stableText: string): void {
  const root = rootEl.value;
  if (!root) return;
  frozenSource = '';
  lastTailSource = null;
  for (const segment of [...root.children]) {
    if (segment.classList.contains('md-seg-stable')) segment.remove();
  }
  appendStableSegment(stableText);
}

/** 直播应用：稳定区推进（只追加 / 罕见重建）+ 活动尾部整段重渲染 */
function applyLive(content: string): void {
  const root = rootEl.value;
  if (!root) return;
  everLive = true;

  const boundary = findStableBoundary(content);
  const stable = content.slice(0, boundary);

  if (stable.startsWith(frozenSource)) {
    if (stable.length > frozenSource.length) {
      appendStableSegment(stable.slice(frozenSource.length));
    }
  } else {
    // 前缀被改写（编辑 / 回退 / 上游重排）：放弃旧冻结区整体重建
    rebuildStable(stable);
  }

  const tailText = boundary < content.length ? content.slice(boundary) : '';
  if (tailText !== lastTailSource) {
    lastTailSource = tailText;
    ensureTail(root).innerHTML = renderSegment(tailText);
  }
}

/** 确保活动尾部节点存在且位于最后（[data-streaming] 供异步渲染器跳过） */
function ensureTail(root: HTMLElement): HTMLElement {
  const existing = root.lastElementChild;
  if (existing && existing.classList.contains('md-live-tail')) {
    return existing as HTMLElement;
  }
  const tail = document.createElement('div');
  tail.className = 'md-live-tail';
  tail.dataset.streaming = '1';
  root.appendChild(tail);
  return tail;
}

/** 终态应用：直播过的片段把剩余内容全部冻结（保留已挂载组件）；历史片段一次性整渲染 */
function applyFinal(content: string): void {
  const root = rootEl.value;
  if (!root) return;

  if (!everLive) {
    // 历史片段（含流结束后新挂载的组件实例）：与旧版 v-html 逐字等价
    root.innerHTML = renderSegment(content);
    return;
  }

  if (content.startsWith(frozenSource)) {
    if (content.length > frozenSource.length) {
      appendStableSegment(content.slice(frozenSource.length));
    }
  } else {
    rebuildStable(content);
  }
  // 尾部清空（内容已全部冻结；保留节点本身，避免一次子树变更）
  if (lastTailSource !== '') {
    lastTailSource = '';
    ensureTail(root).innerHTML = '';
  }
}

/** 统一应用入口（mounted 守卫：watch immediate 先于 DOM 就绪的竞态） */
function applyNow(): void {
  if (!mounted) {
    pendingApply = applyNow;
    return;
  }
  if (props.streaming) {
    applyLive(props.content);
  } else {
    applyFinal(props.content);
  }
}

/** 直播节流（前沿节流：首个 token 立即上屏，后续按间隔合并） */
function scheduleLiveApply(): void {
  if (timer !== undefined) return;
  timer = window.setTimeout(() => {
    timer = undefined;
    applyNow();
  }, STREAM_THROTTLE_MS);
}

onMounted(() => {
  mounted = true;
  if (pendingApply) {
    const apply = pendingApply;
    pendingApply = null;
    apply();
    return;
  }
  // 常规挂载：立即应用一次（直播片段首帧不等待节流）
  applyNow();
});

watch(
  () => props.content,
  () => {
    if (props.streaming) {
      scheduleLiveApply();
      return;
    }
    applyNow();
  },
);

// 流状态翻转：取消挂起的节流并立即应用
// （true→false = 终排：把尾部冻结成最后一段；false→true = 直接进入直播态）
watch(
  () => props.streaming,
  () => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    applyNow();
  },
);

onBeforeUnmount(() => {
  if (timer !== undefined) window.clearTimeout(timer);
});

// 挂载前的 watch immediate 不需要：onMounted 必然执行一次 applyNow；
// watch(() => props.content) 不加 immediate，避免与挂载期双渲染竞争
</script>
