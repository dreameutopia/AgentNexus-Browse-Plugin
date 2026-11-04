<script setup lang="ts">
/**
 * 学习策略问号解释卡
 *
 * 形态：问号按钮 + **就地展开**的解释卡（inline disclosure），不做浮层。
 *
 * 为什么不做绝对定位浮层：
 *   弹窗正文是纵向滚动容器（overflow-y: auto）。绝对定位的浮层留在容器内时，
 *   其宽度会计入滚动容器的可滚动溢出区域——解释卡固定 300px 宽，窄侧边栏里
 *   必然撑破右侧，正文因此长出一条横向滚动条；而且浮层还会被滚动视口裁切。
 *   现在解释卡进入正常文档流：根节点 display: contents 让触发器与解释卡直接
 *   成为标签行的 flex 项，解释卡 flex-basis: 100% 换行独占一行，
 *   宽度天然等于字段宽度——不产生任何横向溢出，也无需 JS 定位。
 *
 * 图标用 lucide CircleQuestionMark（此前手写 Material path 因填充规则问题
 * 渲染成一坨实心圆点，看着像个小黑球，已废弃）。
 */
import { onBeforeUnmount, ref, useId, watch } from 'vue';
import { CircleQuestionMark } from 'lucide-vue-next';

const props = defineProps<{
  /** 卡片标题 */
  title: string;
  /** 逐行说明（每项渲染为一段） */
  lines: string[];
}>();

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const panelId = `learn-hint-${useId()}`;

function toggle(): void {
  open.value = !open.value;
}

function close(): void {
  open.value = false;
}

/** 点击解释卡外部时收起（触发器与卡片本体都算内部） */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const target = event.target as Node | null;
  if (target && rootRef.value?.contains(target)) return;
  close();
}

watch(open, value => {
  if (value) {
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
  } else {
    document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
});
</script>

<template>
  <span ref="rootRef" class="learn-hint">
    <button
      type="button"
      class="learn-hint__trigger"
      :aria-expanded="open"
      :aria-controls="panelId"
      :aria-label="props.title"
      @click="toggle"
      @keydown.esc.stop.prevent="close"
    >
      <CircleQuestionMark class="learn-hint__icon" :size="15" :stroke-width="2" aria-hidden="true" />
    </button>

    <Transition name="learn-hint">
      <span v-if="open" :id="panelId" class="learn-hint__panel" role="tooltip">
        <span class="learn-hint__panel-inner">
          <strong class="learn-hint__title">{{ props.title }}</strong>
          <span v-for="(line, index) in props.lines" :key="index" class="learn-hint__line">{{ line }}</span>
        </span>
      </span>
    </Transition>
  </span>
</template>

<style scoped>
/* 根节点不生成盒子：让触发器与解释卡直接参与标签行的 flex 排布 */
.learn-hint {
  display: contents;
}

.learn-hint__trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--learn-text-faint, #9ca3af);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background 0.15s ease;
}

.learn-hint__trigger:hover,
.learn-hint__trigger:focus-visible {
  color: var(--learn-accent, #667eea);
  background: var(--learn-accent-soft, rgba(102, 126, 234, 0.12));
  outline: none;
}

.learn-hint__icon {
  display: block;
}

/* 解释卡：独占标签行的一整行，宽度＝字段宽度 */
.learn-hint__panel {
  display: grid;
  grid-template-rows: 1fr;
  flex: 0 0 100%;
  min-width: 0;
  transition:
    grid-template-rows 0.22s ease,
    opacity 0.16s ease;
}

.learn-hint__panel-inner {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
  overflow: hidden;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--learn-surface, #f8fafc);
  border: 1px solid var(--learn-border, #e5e7eb);
  color: var(--learn-text-muted, #6b7280);
  font-size: 12px;
  line-height: 1.7;
  text-align: left;
  overflow-wrap: anywhere;
}

.learn-hint__title {
  display: block;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--learn-text-strong, #111827);
}

.learn-hint__line {
  display: block;
}

.learn-hint__line:last-child {
  color: var(--learn-text-faint, #9ca3af);
}

/* 展开/收起动画：grid-template-rows 0fr ↔ 1fr */
.learn-hint-enter-active,
.learn-hint-leave-active {
  transition:
    grid-template-rows 0.22s ease,
    opacity 0.16s ease;
}

.learn-hint-enter-from,
.learn-hint-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
}
</style>
