<!--
  循环守卫确认条（非阻塞）

  取代旧的 window.confirm 守卫确认：
  - window.confirm 是同步模态：打开期间整个 sidepanel 的 JS 线程被冻结，
    停止按钮、流式渲染、事件处理全部无响应，且无法被 abort 信号打断；
  - 本组件为普通行内 UI：确认期间界面保持可用，停止可即刻生效，
    超时未确认按「停止」处理（默认安全侧，防止无人值守时无限运行）。

  纯展示组件：文案、倒计时数值由父层（App.vue）驱动，决定权在父层持有
  的 Promise resolver；本组件只 emit continue / stop 两个意图。

  视觉口径对齐任务计划卡片（PlanBoard / plan-board.css）：白底卡片 +
  --line-soft 描边 + 14px 圆角 + 轻投影；图标沿用 22×22 圆角小方块
  （--surface-hover 底）；标题 12.5px/600、辅助行 11.5px 灰阶；主行动
  按钮取 --ink-primary 深墨底（与发送按钮同一主色）。卡底 2px 倒计时
  轨道镜像计划卡的进度细线——剩余时间以宽度递减呈现，末 10s 转为
  计划卡同源的语义红（#ef4444）；连续工具失败守卫的图标徽标同样取
  该语义红，其余两类守卫保持中性灰。
-->
<template>
  <Transition name="guard-bar">
    <div v-if="visible" class="guard-confirm-bar" role="alertdialog" aria-live="assertive">
      <div class="guard-bar-main">
        <span class="guard-bar-mark" :class="`is-${kind}`" aria-hidden="true">
          <ListChecks v-if="kind === 'max-iterations'" :size="13" :stroke-width="2" />
          <Timer v-else-if="kind === 'max-duration'" :size="13" :stroke-width="2" />
          <TriangleAlert v-else :size="13" :stroke-width="2" />
        </span>
        <div class="guard-bar-text">
          <p class="guard-bar-title">{{ titleText }}</p>
          <p class="guard-bar-hint">{{ hintWithCountdown }}</p>
        </div>
      </div>
      <div class="guard-bar-actions">
        <button type="button" class="guard-btn guard-btn-stop" @click="emit('stop')">
          {{ t('sidepanel.chat.guardStop') }}
        </button>
        <button type="button" class="guard-btn guard-btn-continue" @click="emit('continue')">
          {{ t('sidepanel.chat.guardContinue') }}
        </button>
      </div>
      <!-- 倒计时轨道：卡底 2px 细线（与计划卡进度条同构），宽度 = 剩余占比 -->
      <div class="guard-bar-track" aria-hidden="true">
        <span
          class="guard-bar-track-fill"
          :class="{ 'is-urgent': secondsLeft <= 10 }"
          :style="{ width: countdownPercent }"
        ></span>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { ListChecks, Timer, TriangleAlert } from 'lucide-vue-next';
import { t } from '@/utils/i18n';

const props = withDefaults(
  defineProps<{
    visible: boolean;
    /** 触发守卫的类型（与引擎 guard 事件同源） */
    kind: 'max-iterations' | 'max-duration' | 'tool-failures';
    /** max-iterations 时的轮数上限 / tool-failures 时的连续失败轮数 */
    count?: number;
    /** max-duration 时的时长上限（分钟） */
    minutes?: number;
    /** 自动停止倒计时剩余秒数 */
    secondsLeft: number;
    /** 倒计时总时长（秒）：轨道宽度基准；默认与 App.vue 的 GUARD_AUTO_STOP_SECONDS 同值 */
    totalSeconds?: number;
  }>(),
  { count: undefined, minutes: undefined, totalSeconds: 60 },
);

const emit = defineEmits<{
  continue: [];
  stop: [];
}>();

const titleText = computed(() => {
  if (props.kind === 'max-iterations') {
    return t('sidepanel.chat.guardTitleIterations', { count: props.count ?? 0 });
  }
  if (props.kind === 'tool-failures') {
    return t('sidepanel.chat.guardTitleFailures', { count: props.count ?? 0 });
  }
  return t('sidepanel.chat.guardTitleDuration', { minutes: props.minutes ?? 0 });
});

const hintWithCountdown = computed(() =>
  t('sidepanel.chat.guardHint', { seconds: props.secondsLeft }),
);

/** 轨道剩余占比（钳制到 0–100%，秒步进经 1s 线性过渡抹平为连续递减） */
const countdownPercent = computed(() => {
  const total = props.totalSeconds > 0 ? props.totalSeconds : 1;
  const ratio = Math.min(1, Math.max(0, props.secondsLeft / total));
  return `${(ratio * 100).toFixed(2)}%`;
});
</script>

<style scoped>
/* 卡壳：与计划卡（.plan-board__card）同口径——白底、软描边、14px 圆角、轻投影 */
.guard-confirm-bar {
  position: relative; /* 卡底倒计时轨道的定位包含块 */
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0 0 8px; /* 与输入容器/计划卡同宽对齐（bottom-section 已提供侧向留白） */
  padding: 9px 12px 11px;
  border-radius: 14px;
  border: 1px solid var(--line-soft, #e4e2de);
  background: #ffffff;
  box-shadow: 0 1px 2px var(--surface-soft, #f3f1ed);
  overflow: hidden; /* 轨道贴边裁剪进圆角 */
}

.guard-bar-main {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

/* 图标徽标：与计划卡头部图标（.plan-board__mark）同构——22×22 圆角小方块；
   连续失败守卫取计划卡 failed 同源语义红，其余保持中性灰 */
.guard-bar-mark {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 7px;
  background: var(--surface-hover, #eeece7);
  color: var(--ink-secondary, #787671);
}

.guard-bar-mark.is-tool-failures {
  background: rgba(239, 68, 68, 0.1);
  color: #b91c1c;
}

.guard-bar-text {
  min-width: 0;
}

.guard-bar-title {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink-primary, #292824);
  line-height: 1.45;
}

.guard-bar-hint {
  margin: 2px 0 0;
  font-size: 11.5px;
  color: var(--ink-muted, #9b9790);
  line-height: 1.4;
  /* 倒计时数字等宽，秒级跳变不引起行宽抖动 */
  font-variant-numeric: tabular-nums;
}

.guard-bar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.guard-btn {
  border: none;
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background-color 0.15s ease, transform 0.05s ease;
}

.guard-btn:active {
  transform: scale(0.97);
}

/* 次行动（停止）：中性灰胶囊，与计划卡计数胶囊同底色 */
.guard-btn-stop {
  color: var(--ink-secondary, #787671);
  background: var(--surface-hover, #eeece7);
}

.guard-btn-stop:hover {
  background: #e4e1da;
}

/* 主行动（继续）：深墨底白字，与发送按钮同一主色（--ink-primary 体系） */
.guard-btn-continue {
  color: #ffffff;
  background: var(--ink-primary, #292824);
}

.guard-btn-continue:hover {
  background: #44413b;
}

/* 卡底倒计时轨道：镜像计划卡进度细线（2px），剩余时间以宽度递减；
   末 10s 转语义红提示紧迫（与计划卡 failed 徽标同源红） */
.guard-bar-track {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: var(--surface-soft, #f3f1ed);
}

.guard-bar-track-fill {
  display: block;
  height: 100%;
  background: var(--ink-muted, #9b9790);
  transition: width 1s linear, background-color 0.3s ease;
}

.guard-bar-track-fill.is-urgent {
  background: #ef4444;
}

/* 进出场：与输入区其它面板一致的轻量位移淡入 */
.guard-bar-enter-active,
.guard-bar-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.guard-bar-enter-from,
.guard-bar-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
