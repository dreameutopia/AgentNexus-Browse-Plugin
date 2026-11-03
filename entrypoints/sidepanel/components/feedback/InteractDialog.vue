<!--
  interact 询问弹窗（use-interact 的唯一展示层 + UI 桥接注册点）

  单例组件：App.vue 挂载一次。职责：
  - 挂载时把 openInteract 注册为 interact 工具的 UI 处理器（interact-ui-bridge），
    卸载时注销并收敛挂起询问（防御：工具调用不会因组件卸载而悬挂）；
  - 两种形态：dialog（居中弹窗）/ ball（右上角悬浮球，最小化态）；
    最小化后进度环按剩余等待时间递减，超时由状态机自动收敛；
    离场动画按去向分流：最小化收缩衔接悬浮球，收敛（提交/拒绝/超时/打断）
    原地淡出；
  - 交互约定（对齐 Claude Code / Codex 桌面端）：
    · 点选项 = 立即提交该选项；自定义输入框始终可用（Enter 提交，Shift+Enter 换行，
      IME 组合态不误触提交）；
    · 「拒绝回答」= 明确拒绝（区别于最小化与超时，模型收到 declined 语义）；
    · Esc / 最小化按钮 / 点击悬浮球外不响应——弹窗遮罩点击不关闭（防敏感授权被
      误触消失），Esc 仅执行最小化，悬浮球可随时重新展开；
    · 键盘可达性：弹窗展示期间 Tab 焦点圈定在弹窗内循环（模态可达性基本要求）。

  纯展示 + 意图转发组件：状态与收敛决定权全部在 use-interact 状态机持有。
-->
<template>
  <!-- 弹窗形态：phase === 'dialog' 时展示。
       离场动画分流（动态 transition name）：
       - 最小化（visible 保持 true，phase 切换）→ 沿右上角收缩衔接悬浮球；
       - 收敛（visible 置 false：提交/拒绝/超时/打断）→ 原地淡出，
         避免「已提交」被误读为「缩小到角落仍在等待」 -->
  <Transition :name="dialogTransitionName">
    <div
      v-if="dialogVisible"
      ref="overlayRef"
      class="interact-overlay"
      @click.self="handleOverlayClick"
    >
      <div
        class="interact-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="titleText"
      >
        <!-- 头部：语义图标 + 标题 + 敏感徽标 -->
        <div class="interact-header">
          <span class="interact-header-icon" :class="{ 'is-sensitive': isSensitive }" aria-hidden="true">
            <svg v-if="isSensitive" width="19" height="19" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12,2L1,21H23M12,6L19.53,19H4.47M11,10V14H13V10M11,16V18H13V16" fill="currentColor"/>
            </svg>
            <svg v-else width="19" height="19" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M20,2H4A2,2 0 0,0 2,4V22L6,18H20A2,2 0 0,0 22,16V4A2,2 0 0,0 20,2M8,11H16V13H8V11M8,7H16V9H8V7Z" fill="currentColor"/>
            </svg>
          </span>
          <div class="interact-header-text">
            <h4 class="interact-title">{{ titleText }}</h4>
            <p class="interact-subtitle">{{ subtitleText }}</p>
          </div>
          <span v-if="isSensitive" class="interact-badge-sensitive">
            {{ t('sidepanel.interact.sensitiveBadge') }}
          </span>
        </div>

        <!-- 问题正文 -->
        <p class="interact-question">{{ question }}</p>

        <!-- 背景说明（可选） -->
        <p v-if="context" class="interact-context">{{ context }}</p>

        <!-- 候选选项：点击即提交（对齐 Claude Code AskUserQuestion 交互） -->
        <div v-if="options.length > 0" class="interact-options">
          <button
            v-for="option in options"
            :key="option.label"
            type="button"
            class="interact-option"
            @click="submitInteractAnswer(option.label, 'option')"
          >
            <span class="interact-option-label">{{ option.label }}</span>
            <span v-if="option.description" class="interact-option-desc">{{ option.description }}</span>
          </button>
        </div>

        <!-- 自定义答复：始终可用（即使提供了选项） -->
        <div class="interact-custom">
          <label class="interact-custom-label" for="interact-custom-input">
            {{ t('sidepanel.interact.customLabel') }}
          </label>
          <textarea
            id="interact-custom-input"
            ref="customInputRef"
            v-model="customAnswer"
            class="interact-custom-input"
            rows="2"
            :placeholder="t('sidepanel.interact.customPlaceholder')"
            @keydown="handleCustomKeydown"
          ></textarea>
        </div>

        <!-- 底部：倒计时 + 拒绝 / 提交 -->
        <div class="interact-footer">
          <span class="interact-countdown" :class="{ 'is-urgent': isUrgent }">
            {{ t('sidepanel.interact.remaining', { time: remainingLabel }) }}
          </span>
          <button
            type="button"
            class="interact-btn interact-btn-ghost"
            @click="declineInteract()"
          >
            {{ t('sidepanel.interact.decline') }}
          </button>
          <button
            type="button"
            class="interact-btn interact-btn-primary"
            :disabled="!customAnswer.trim()"
            @click="submitCustom"
          >
            {{ t('sidepanel.interact.submit') }}
          </button>
        </div>
      </div>
    </div>
  </Transition>

  <!-- 悬浮球形态：phase === 'ball' 时展示；边框进度环 = 剩余等待时间 -->
  <Transition name="interact-ball">
    <button
      v-if="ballVisible"
      type="button"
      class="interact-ball"
      :class="{ 'is-sensitive': isSensitive }"
      :title="ballTitle"
      :aria-label="ballTitle"
      @click="reopenInteract()"
    >
      <svg class="interact-ball-ring" viewBox="0 0 46 46" aria-hidden="true">
        <circle class="interact-ball-ring-track" cx="23" cy="23" r="19.5"></circle>
        <circle
          class="interact-ball-ring-progress"
          :class="{ 'is-sensitive': isSensitive, 'is-urgent': isUrgent }"
          cx="23"
          cy="23"
          r="19.5"
          :stroke-dasharray="RING_CIRCUMFERENCE"
          :stroke-dashoffset="ringDashOffset"
        ></circle>
      </svg>
      <span class="interact-ball-icon" aria-hidden="true">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12,2A9,10 0 0,0 3,12A9,10 0 0,0 12,22A9,10 0 0,0 21,12A9,10 0 0,0 12,2M12.05,17A1.15,1.15 0 1,1 12.05,14.7A1.15,1.15 0 0,1 12.05,17M13.6,11.53C12.9,12.23 12.79,12.73 12.79,13.4H11.14C11.14,12.31 11.45,11.62 12.24,10.91C12.86,10.36 13.05,10 13.05,9.5C13.05,8.79 12.5,8.31 11.73,8.31C10.91,8.31 10.35,8.83 10.3,9.84H8.59C8.64,7.97 9.94,6.8 11.85,6.8C13.62,6.8 14.9,7.77 14.9,9.26C14.9,10.16 14.45,10.86 13.6,11.53Z" fill="currentColor"/>
        </svg>
      </span>
    </button>
  </Transition>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { t } from '@/utils/i18n';
import { registerInteractHandler } from '@/tools/interact/interact-ui-bridge';
import {
  useInteractDialog,
  openInteract,
  submitInteractAnswer,
  declineInteract,
  minimizeInteract,
  reopenInteract,
  dismissPendingInteracts,
} from '../../composables/use-interact';

const state = useInteractDialog();

// ── 展示形态派生 ──
const dialogVisible = computed(() => state.value.visible && state.value.phase === 'dialog');
const ballVisible = computed(() => state.value.visible && state.value.phase === 'ball');

const request = computed(() => state.value.request);
const question = computed(() => request.value?.question ?? '');
const context = computed(() => request.value?.context ?? '');
const options = computed(() => request.value?.options ?? []);
const isSensitive = computed(() => request.value?.sensitive === true);

/**
 * 离场动画分流依据：离场发生时状态已更新——
 *   - 最小化：visible 仍为 true（仅 phase 切换）→ 收缩动画衔接悬浮球；
 *   - 收敛：visible 已置 false → 原地淡出。
 * 进场只发生在 visible=true 时，恒用 interact-dialog 进场类，不受影响。
 */
const dialogTransitionName = computed(() =>
  state.value.visible ? 'interact-dialog' : 'interact-dialog-settle',
);

const titleText = computed(() =>
  isSensitive.value
    ? t('sidepanel.interact.sensitiveTitle')
    : t('sidepanel.interact.title'),
);

const subtitleText = computed(() =>
  isSensitive.value
    ? t('sidepanel.interact.sensitiveSubtitle')
    : t('sidepanel.interact.subtitle'),
);

const ballTitle = computed(() => `${t('sidepanel.interact.ballTitle')}\n${question.value}`);

// ── 倒计时展示 ──
/** 进度环半径与周长（与 CSS 中 viewBox 46 / r 19.5 对齐） */
const RING_CIRCUMFERENCE = 2 * Math.PI * 19.5;

const ringRatio = computed(() => {
  const { totalMs, remainingMs } = state.value;
  if (!Number.isFinite(totalMs) || totalMs <= 0) return 0;
  return Math.min(1, Math.max(0, remainingMs / totalMs));
});

const ringDashOffset = computed(
  () => RING_CIRCUMFERENCE * (1 - ringRatio.value),
);

/** 剩余时长 < 20% 视为紧急（进度环变红、倒计时红色加粗） */
const isUrgent = computed(() => ringRatio.value <= 0.2);

/** 剩余时长文案 m:ss（不足 1 分钟也按 0:xx 展示，绝不出现负数） */
const remainingLabel = computed(() => {
  const safe = Math.max(0, state.value.remainingMs);
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
});

// ── 自定义答复 ──
const customAnswer = ref('');
const customInputRef = ref<HTMLTextAreaElement | null>(null);
/** 弹窗遮罩层引用（焦点圈定的查询范围，见 trapFocus） */
const overlayRef = ref<HTMLElement | null>(null);

/** 提交自定义输入（空答复按钮已禁用，双保险） */
function submitCustom(): void {
  const answer = customAnswer.value.trim();
  if (!answer) return;
  submitInteractAnswer(answer, 'custom');
}

/**
 * 自定义输入键盘约定：Enter 提交、Shift+Enter 换行；
 * IME 组合态（拼音输入选词回车）不触发提交——isComposing 与传统 keyCode 229
 * 双重防御，避免中文输入时回车选词被误判为提交
 */
function handleCustomKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return;
  if (event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  submitCustom();
}

/**
 * 遮罩点击：不关闭也不最小化（防敏感授权被误触消失）；
 * 仅聚焦输入框引导作答
 */
function handleOverlayClick(): void {
  customInputRef.value?.focus();
}

// ── 键盘：Esc 最小化（询问继续计时，可从悬浮球重新展开）；Tab 焦点圈定 ──
function handleKeydown(event: KeyboardEvent) {
  if (!dialogVisible.value) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    minimizeInteract();
    return;
  }
  if (event.key === 'Tab') {
    trapFocus(event);
  }
}

/**
 * 焦点圈定：Tab / Shift+Tab 在弹窗内可聚焦元素间循环，不逃逸到遮罩下的
 * 背景控件（模态可达性基本要求；焦点已在弹窗外时拉回首/末元素）。
 * 经组件 overlay 引用查询而非 document 全局选择器——队列驱动的连续询问
 * 在离场动画重叠期会短暂存在两个弹窗节点，全局查询可能命中正在离场
 * 且已脱离响应式的那一个。
 */
function trapFocus(event: KeyboardEvent): void {
  const overlay = overlayRef.value;
  if (!(overlay instanceof HTMLElement)) return;
  const dialog = overlay.querySelector('.interact-dialog');
  if (!(dialog instanceof HTMLElement)) return;
  const focusables = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter(el => el.offsetParent !== null || el === document.activeElement);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (event.shiftKey) {
    if (active === first || !dialog.contains(active)) {
      event.preventDefault();
      last.focus();
    }
  } else if (active === last || !dialog.contains(active)) {
    event.preventDefault();
    first.focus();
  }
}
document.addEventListener('keydown', handleKeydown, true);
onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown, true);
});

// ── 状态联动 ──
// 监听「请求身份」而非 visible：队列驱动的连续询问（A 收敛后 B 在同一同步
// 批次内顶上）visible 全程为 true、元素只做内容替换，唯有 request 引用变化
// 可靠标识「新询问开始」——此时必须清空上一份草稿（防 A 的草稿被误提交给 B）
// 并聚焦输入框
watch(
  () => state.value.request,
  (next, prev) => {
    if (next !== null && next !== prev) {
      customAnswer.value = '';
      if (state.value.phase === 'dialog') {
        void nextTick(() => customInputRef.value?.focus());
      }
    }
  },
);
// 悬浮球重新展开时聚焦输入框
watch(
  () => state.value.phase,
  phase => {
    if (phase === 'dialog' && state.value.visible) {
      void nextTick(() => customInputRef.value?.focus());
    }
  },
);

// ── UI 桥接注册：interact 工具执行时经此把询问交给本弹窗 ──
const unregisterHandler = registerInteractHandler(openInteract);
onUnmounted(() => {
  unregisterHandler();
  // 组件卸载兜底：挂起询问按 dismissed 收敛（工具 Promise 绝不悬挂）
  dismissPendingInteracts();
});
</script>

<style>
@import './interact-dialog.css';
</style>
