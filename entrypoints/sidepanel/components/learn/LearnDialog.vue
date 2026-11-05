<script setup lang="ts">
/**
 * 网站学习确认弹窗（多态合一）
 *
 * 一个组件承载全部学习态确认，是因为它们共用同一套外壳与出入场动画，
 * 差异只在「正文 + 按钮组」——拆成多个组件会把 90% 的样式复制多遍。
 * 分支用 v-if/else-if 严格按 mode 排他渲染，任一时刻只可能有一种形态。
 *
 * 形态：start（开始前确认）/ stop（运行中终止）/ limitWrapUp（轮数上限收尾）/
 *      validationFail（盲测未通过）/ learnFailed（学习或验证失败）/
 *      failure（不可恢复失败）/ noDraft（没有产出）。
 *
 * 纯受控：内容来自 props.view，动作通过 emit('answer', choice) 上抛，
 * 由 use-learn-session 决定后续流转（组件自身不做任何业务判断）。
 * 各形态的合法选择集由 use-learn-session 的 allowedChoices 统一定义
 * （learnFailed 按阶段分叉：验证阶段持有草稿，不提供「放弃」）。
 */
import { t, type MessageKey } from '@/utils/i18n';
import { computed, ref, watch } from 'vue';
import './learn-theme.css';
import type { LearnDialogChoice, LearnDialogView } from '@/entrypoints/sidepanel/composables/use-learn-session';
import { LEARN_FAILURE_REASON_KEYS, isPositiveSafeInteger } from '@/utils/learn/learn-validate';
import { LEARN_DEFAULT_STAGE_LIMITS, LEARN_DEFAULT_EXTENSION_ITERATIONS, isHumanBlockedReason, type LearnFailureReason } from '@/utils/learn/learn-types';

const props = defineProps<{
  view: LearnDialogView | null;
}>();

const emit = defineEmits<{
  answer: [choice: LearnDialogChoice, extraIterations?: number];
}>();
const extraIterations = ref<number | string>(LEARN_DEFAULT_EXTENSION_ITERATIONS);
watch(() => props.view, view => {
  if (view?.mode === 'limitWrapUp') extraIterations.value = view.extraIterations;
}, { immediate: true });
const canExtend = computed(() => isPositiveSafeInteger(extraIterations.value));
function extend(): void {
  if (isPositiveSafeInteger(extraIterations.value)) emit('answer', 'extend', extraIterations.value);
}

/** 失败原因码 → 展示文案（映射单点收敛在 learn-validate，此处只取文案） */
const REASON_KEYS = LEARN_FAILURE_REASON_KEYS as Record<LearnFailureReason, MessageKey>;

function reasonLabel(reason: LearnFailureReason): string {
  return t(REASON_KEYS[reason]);
}

/** 该卡点是否必须由用户本人完成（决定建议文案：等人工 vs 换策略重试） */
function needsHuman(reason: LearnFailureReason): boolean {
  return isHumanBlockedReason(reason);
}/**
 * 遮罩点击：仅对有「安全取消」语义的模式生效。
 * 必须显式二选一的模式（收尾 / 验证结论 / 无产出）对遮罩无响应——
 * 意外点击绝不能替用户做出选择（否则点一下遮罩就等于「仍要创建」/
 * 「直接结束」，流程被静默推进，违背「绝不执行意外分支」的约束）。
 */
function onOverlayClick(): void {
  const mode = props.view?.mode;
  if (mode === 'start' || mode === 'stop') {
    emit('answer', 'cancel');
  } else if (mode === 'failure') {
    // 失败弹窗只有「知道了」一个出口，遮罩等价于该出口
    emit('answer', 'ok');
  }
  // limitWrapUp / validationFail / noDraft：忽略遮罩，必须点按钮
}

/** mm:ss（学习状态条与终止确认共用同一口径） */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
</script>

<template>
  <Transition name="learn-dialog">
    <div v-if="view" class="learn-dialog-overlay learn-root" @click.self="onOverlayClick">
      <div
        class="learn-dialog learn-panel"
        :class="`learn-dialog--${view.mode}`"
        role="alertdialog"
        aria-modal="true"
      >
        <!-- ════════ 开始前二次确认 ════════ -->
        <template v-if="view.mode === 'start'">
          <header class="learn-dialog__header">
            <span class="learn-dialog__badge learn-dialog__badge--info" aria-hidden="true">✨</span>
            <h3 class="learn-dialog__title">{{ t('sidepanel.learn.confirmTitle') }}</h3>
          </header>
          <div class="learn-dialog__body">
            <p class="learn-dialog__intro">{{ t('sidepanel.learn.confirmIntro') }}</p>
            <dl class="learn-summary">
              <div class="learn-summary__row">
                <dt>{{ t('sidepanel.learn.rowUrl') }}</dt>
                <dd class="learn-summary__url">{{ view.config.url }}</dd>
              </div>
              <div class="learn-summary__row">
                <dt>{{ t('sidepanel.learn.rowGoal') }}</dt>
                <dd>{{ view.config.goal }}</dd>
              </div>
              <div class="learn-summary__row">
                <dt>{{ t('sidepanel.learn.descriptionLabel') }}</dt>
                <dd style="white-space: pre-wrap">{{ view.config.additionalDescription || '—' }}</dd>
              </div>
              <div class="learn-summary__row">
                <dt>{{ t('sidepanel.learn.rowMode') }}</dt>
                <dd>{{ view.config.targetMode === 'vision' ? t('sidepanel.learn.targetModeVision') : t('sidepanel.learn.targetModeText') }}</dd>
              </div>
              <div class="learn-summary__row">
                <dt>{{ t('sidepanel.learn.rowStrategy') }}</dt>
                <dd>{{ view.config.strategy === 'vision' ? t('sidepanel.learn.strategyVision') : t('sidepanel.learn.strategyText') }}</dd>
              </div>
              <div class="learn-summary__row">
                <dt>{{ t('sidepanel.learn.rowModel') }}</dt>
                <dd>{{ view.modelLabel || '—' }}</dd>
              </div>
              <div class="learn-summary__row">
                <dt>{{ t('sidepanel.learn.rowValidate') }}</dt>
                <dd>{{ view.config.autoValidate ? t('sidepanel.learn.valueOn') : t('sidepanel.learn.valueOff') }}</dd>
              </div>
              <div class="learn-summary__row">
                <dt>{{ t('sidepanel.learn.learningBudget') }}</dt>
                <dd>{{ t('sidepanel.learn.budgetSummary', { iterations: view.config.learningLimits?.maxIterations ?? LEARN_DEFAULT_STAGE_LIMITS.maxIterations, minutes: view.config.learningLimits?.maxDurationMinutes ?? LEARN_DEFAULT_STAGE_LIMITS.maxDurationMinutes }) }}</dd>
              </div>
              <div v-if="view.config.autoValidate" class="learn-summary__row">
                <dt>{{ t('sidepanel.learn.validationBudget') }}</dt>
                <dd>{{ t('sidepanel.learn.budgetSummary', { iterations: view.config.validationLimits?.maxIterations ?? LEARN_DEFAULT_STAGE_LIMITS.maxIterations, minutes: view.config.validationLimits?.maxDurationMinutes ?? LEARN_DEFAULT_STAGE_LIMITS.maxDurationMinutes }) }}</dd>
              </div>
            </dl>
            <ul class="learn-warnings">
              <li>{{ t('sidepanel.learn.warnFocus') }}</li>
              <li>{{ t('sidepanel.learn.warnKeepOpen') }}</li>
              <li>{{ t('sidepanel.learn.warnConfirm') }}</li>
            </ul>
          </div>
          <footer class="learn-dialog__footer">
            <button type="button" class="learn-btn learn-btn--ghost" @click="emit('answer', 'cancel')">
              {{ t('sidepanel.learn.backToEdit') }}
            </button>
            <button type="button" class="learn-btn learn-btn--primary" @click="emit('answer', 'confirm')">
              {{ t('sidepanel.learn.startLearning') }}
            </button>
          </footer>
        </template>

        <!-- ════════ 运行中终止确认 ════════ -->
        <template v-else-if="view.mode === 'stop'">
          <header class="learn-dialog__header">
            <span class="learn-dialog__badge learn-dialog__badge--warn" aria-hidden="true">⚠️</span>
            <h3 class="learn-dialog__title">
              {{ view.phase === 'validating' ? t('sidepanel.learn.stopValidatingTitle') : t('sidepanel.learn.stopTitle') }}
            </h3>
          </header>
          <div class="learn-dialog__body">
            <p class="learn-dialog__text">
              {{ view.phase === 'validating' ? t('sidepanel.learn.stopValidatingBody') : t('sidepanel.learn.stopBody') }}
            </p>
            <div class="learn-progress">
              <div class="learn-progress__item">
                <span class="learn-progress__label">{{ t('sidepanel.learn.statusElapsed', { elapsed: formatElapsed(view.elapsedMs) }) }}</span>
              </div>
              <div class="learn-progress__item">
                <span class="learn-progress__label">{{ t('sidepanel.learn.statusToolCalls', { count: view.toolCalls }) }}</span>
              </div>
            </div>
          </div>
          <footer class="learn-dialog__footer">
            <button type="button" class="learn-btn learn-btn--ghost" @click="emit('answer', 'cancel')">
              {{ view.fromLimit ? t('sidepanel.learn.backToLimits') : t('sidepanel.learn.stopCancel') }}
            </button>
            <button type="button" class="learn-btn learn-btn--danger" @click="emit('answer', 'confirm')">
              {{ t('sidepanel.learn.stopConfirm') }}
            </button>
          </footer>
        </template>

        <!-- ════════ 预算边界：继续 / 收尾 / 丢弃 ════════ -->
        <template v-else-if="view.mode === 'limitWrapUp'">
          <header class="learn-dialog__header">
            <span class="learn-dialog__badge learn-dialog__badge--warn" aria-hidden="true">⏱️</span>
            <h3 class="learn-dialog__title">{{ t('sidepanel.learn.limitTitle') }}</h3>
          </header>
          <div class="learn-dialog__body">
            <p class="learn-dialog__intro">{{ view.phase === 'learning' ? t('sidepanel.learn.learningBudget') : t('sidepanel.learn.validationBudget') }} · {{ view.reason === 'max-duration' ? t('sidepanel.learn.limitTimeReason') : view.reason === 'tool-failures' ? t('sidepanel.learn.limitFailuresReason') : t('sidepanel.learn.limitRoundsReason') }}</p>
            <p class="learn-dialog__text">
              {{ t('sidepanel.learn.limitBody', { iterations: view.iterations, minutes: view.minutes }) }}
            </p>
            <label class="learn-extension">
              <span>{{ t('sidepanel.learn.extraRoundsLabel') }}</span>
              <input v-model.number="extraIterations" class="learn-extension__input" type="number" min="1" step="1" inputmode="numeric" />
            </label>
            <p v-if="!canExtend" class="learn-extension__error" role="alert">{{ t('sidepanel.learn.errExtraRounds') }}</p>
            <p class="learn-dialog__muted">{{ t('sidepanel.learn.extensionHint') }}</p>
          </div>
          <footer class="learn-dialog__footer learn-limit-actions">
            <button type="button" class="learn-btn learn-btn--primary" :disabled="!canExtend" @click="extend">
              {{ t('sidepanel.learn.limitExtend', { iterations: extraIterations }) }}
            </button>
            <button type="button" class="learn-btn learn-btn--ghost" @click="emit('answer', 'summarize')">
              {{ view.phase === 'validating' ? t('sidepanel.learn.limitSummarizeValidation') : t('sidepanel.learn.limitSummarize') }}
            </button>
            <button type="button" class="learn-btn learn-btn--ghost learn-limit-discard" @click="emit('answer', 'discard')">
              {{ t('sidepanel.learn.limitStop') }}
            </button>
          </footer>
        </template>

        <!-- ════════ 验证未通过 ════════ -->
        <template v-else-if="view.mode === 'validationFail'">
          <header class="learn-dialog__header">
            <span class="learn-dialog__badge learn-dialog__badge--error" aria-hidden="true">❌</span>
            <h3 class="learn-dialog__title">{{ t('sidepanel.learn.validationFailTitle') }}</h3>
          </header>
          <div class="learn-dialog__body">
            <p class="learn-dialog__intro">{{ t('sidepanel.learn.validationFailIntro') }}</p>
            <p
              v-if="typeof view.report.score === 'number'"
              class="learn-dialog__text"
            >
              {{ t('sidepanel.learn.validationFailScore', { score: view.report.score }) }}
            </p>
            <ol v-if="view.report.issues.length" class="learn-issues">
              <li v-for="(issue, index) in view.report.issues" :key="index">{{ issue }}</li>
            </ol>
            <p v-if="view.report.summary" class="learn-dialog__muted">{{ view.report.summary }}</p>
            <p class="learn-dialog__intro">{{ t('sidepanel.learn.validationFailChoose') }}</p>
          </div>
          <footer class="learn-dialog__footer">
            <button type="button" class="learn-btn learn-btn--ghost" @click="emit('answer', 'relearn')">
              {{ t('sidepanel.learn.relearn') }}
            </button>
            <button type="button" class="learn-btn learn-btn--primary" @click="emit('answer', 'create')">
              {{ t('sidepanel.learn.createAnyway') }}
            </button>
          </footer>
        </template>

        <!-- ════════ 学习失败（模型主动提交 status=failed/blocked） ════════ -->
        <template v-else-if="view.mode === 'learnFailed'">
          <header class="learn-dialog__header">
            <span class="learn-dialog__badge learn-dialog__badge--warn" aria-hidden="true">⚠️</span>
            <h3 class="learn-dialog__title">
              {{ view.stage === 'validating' ? t('sidepanel.learn.learnFailedValidateTitle') : t('sidepanel.learn.learnFailedTitle') }}
            </h3>
          </header>
          <div class="learn-dialog__body">
            <p class="learn-dialog__intro">{{ t('sidepanel.learn.learnFailedIntro') }}</p>
            <p class="learn-dialog__text">
              <span class="learn-reason">{{ reasonLabel(view.report.reason) }}</span>
              {{ view.report.detail }}
            </p>
            <div v-if="view.report.findings.length" class="learn-findings">
              <p class="learn-findings__title">{{ t('sidepanel.learn.learnFailedFindingsTitle') }}</p>
              <ol class="learn-issues learn-issues--ok">
                <li v-for="(finding, index) in view.report.findings" :key="index">{{ finding }}</li>
              </ol>
            </div>
            <p v-if="view.report.suggestion" class="learn-dialog__muted">
              {{ t('sidepanel.learn.learnFailedSuggestionLabel') }}{{ view.report.suggestion }}
            </p>
            <!-- 卡点性质决定建议方向：必须由人完成 vs 换个策略可以重试 -->
            <p class="learn-dialog__muted">
              {{ needsHuman(view.report.reason) ? t('sidepanel.learn.learnFailedNeedsHuman') : t('sidepanel.learn.learnFailedRetryable') }}
            </p>
            <p class="learn-dialog__intro">{{ t('sidepanel.learn.learnFailedChoose') }}</p>
          </div>
          <footer class="learn-dialog__footer">
            <!-- 按钮组按阶段分叉：验证阶段已有学成的草稿，「结束」会白丢成果，
                 故那里提供的是「仍要创建」（把草稿交付出去）；学习阶段尚无草稿，
                 结束即放弃，没有可交付之物。合法选择集见 use-learn-session 的 allowedChoices。 -->
            <button
              v-if="view.stage === 'validating'"
              type="button"
              class="learn-btn learn-btn--ghost"
              @click="emit('answer', 'create')"
            >
              {{ t('sidepanel.learn.learnFailedCreate') }}
            </button>
            <button
              v-else
              type="button"
              class="learn-btn learn-btn--ghost"
              @click="emit('answer', 'giveUp')"
            >
              {{ t('sidepanel.learn.learnFailedGiveUp') }}
            </button>
            <button type="button" class="learn-btn learn-btn--primary" @click="emit('answer', 'relearn')">
              {{ view.stage === 'validating' ? t('sidepanel.learn.learnFailedRevalidate') : t('sidepanel.learn.learnFailedRelearn') }}
            </button>
          </footer>
        </template>

        <!-- ════════ 未产出 ════════ -->
        <template v-else-if="view.mode === 'noDraft'">
          <header class="learn-dialog__header">
            <span class="learn-dialog__badge learn-dialog__badge--warn" aria-hidden="true">⚠️</span>
            <h3 class="learn-dialog__title">{{ t('sidepanel.learn.noDraftTitle') }}</h3>
          </header>
          <div class="learn-dialog__body">
            <p class="learn-dialog__text">{{ view.reason }}</p>
          </div>
          <footer class="learn-dialog__footer">
            <button type="button" class="learn-btn learn-btn--ghost" @click="emit('answer', 'giveUp')">
              {{ t('sidepanel.learn.noDraftGiveUp') }}
            </button>
            <button type="button" class="learn-btn learn-btn--primary" @click="emit('answer', 'retry')">
              {{ t('sidepanel.learn.noDraftRetry') }}
            </button>
          </footer>
        </template>

        <!-- ════════ 失败 ════════ -->
        <template v-else>
          <header class="learn-dialog__header">
            <span class="learn-dialog__badge learn-dialog__badge--error" aria-hidden="true">⛔</span>
            <h3 class="learn-dialog__title">{{ view.title }}</h3>
          </header>
          <div class="learn-dialog__body">
            <p class="learn-dialog__text learn-dialog__text--break">{{ view.message }}</p>
          </div>
          <footer class="learn-dialog__footer">
            <button type="button" class="learn-btn learn-btn--primary" @click="emit('answer', 'ok')">
              {{ t('sidepanel.learn.failureOk') }}
            </button>
          </footer>
        </template>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.learn-dialog__footer.learn-limit-actions { flex-direction: column; align-items: stretch; }
.learn-limit-actions .learn-btn { width: 100%; }
.learn-limit-discard { color: var(--learn-danger); }
.learn-extension { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; color: var(--learn-text); }
.learn-extension__input { width: 100px; min-width: 0; padding: 8px 10px; border: 1px solid var(--learn-border-strong); border-radius: 8px; background: var(--learn-bg); color: var(--learn-text); font: inherit; }
.learn-extension__input:focus-visible { outline: 2px solid var(--learn-accent-soft-border); outline-offset: 2px; }
.learn-extension__error { margin: 0; font-size: 12px; color: var(--learn-danger); }
.learn-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 950;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--learn-scrim);
  backdrop-filter: blur(3px);
}

.learn-dialog {
  display: flex;
  flex-direction: column;
  width: min(520px, 100%);
  max-height: min(84vh, 700px);
  border-radius: 14px;
  overflow: hidden;
}

.learn-dialog__header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 20px 0;
}

.learn-dialog__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  font-size: 15px;
  background: var(--learn-surface-hover);
}

.learn-dialog__badge--info {
  background: var(--learn-accent-soft);
}

.learn-dialog__badge--warn {
  background: var(--learn-warning-soft);
}

.learn-dialog__badge--error {
  background: var(--learn-danger-soft);
}

.learn-dialog__title {
  margin: 0;
  font-size: 15.5px;
  font-weight: 600;
  color: var(--learn-text-strong);
}

.learn-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 20px 4px;
  overflow-y: auto;
}

.learn-dialog__intro {
  margin: 0;
  font-size: 12.5px;
  color: var(--learn-text-muted);
}

.learn-dialog__text {
  margin: 0;
  font-size: 13px;
  line-height: 1.75;
  color: var(--learn-text);
}

.learn-dialog__text--break {
  word-break: break-word;
  white-space: pre-wrap;
}

.learn-dialog__muted {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--learn-text-faint);
}

/* 配置摘要 */
.learn-summary {
  margin: 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--learn-surface);
  border: 1px solid var(--learn-border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.learn-summary__row {
  display: grid;
  grid-template-columns: 76px 1fr;
  gap: 10px;
  font-size: 12.5px;
  line-height: 1.6;
}

.learn-summary__row dt {
  color: var(--learn-text-faint);
}

.learn-summary__row dd {
  margin: 0;
  color: var(--learn-text);
  word-break: break-word;
}

.learn-summary__url {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

/* 风险提示 */
.learn-warnings {
  margin: 0;
  padding: 10px 12px 10px 28px;
  border-radius: 10px;
  background: var(--learn-warning-soft);
  border: 1px solid var(--learn-warning-border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.learn-warnings li {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--learn-text-muted);
}

/* 进度卡片 */
.learn-progress {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.learn-progress__item {
  flex: 1 1 140px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--learn-surface);
  border: 1px solid var(--learn-border);
}

.learn-progress__label {
  font-size: 12.5px;
  color: var(--learn-text-muted);
}

/* 问题清单 */
.learn-issues {
  margin: 0;
  padding: 10px 12px 10px 30px;
  border-radius: 10px;
  background: var(--learn-danger-soft);
  border: 1px solid var(--learn-danger-border);
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
}

.learn-issues li {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--learn-text-muted);
  word-break: break-word;
}

/* 失败原因分类标签（原因码 → 文案后的一枚胶囊） */
.learn-reason {
  display: inline-block;
  margin-right: 6px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--learn-warning-soft);
  border: 1px solid var(--learn-warning-border);
  color: var(--learn-warning);
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
}

/* 已探明的知识（失败也有产出，故用中性/正向配色而非危险色） */
.learn-findings {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.learn-findings__title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--learn-text-muted);
}

.learn-issues--ok {
  background: var(--learn-surface);
  border-color: var(--learn-border);
}

.learn-issues--ok li {
  color: var(--learn-text);
}

.learn-dialog__footer {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 16px 20px 18px;
}

/* 进出场 */
.learn-dialog-enter-active,
.learn-dialog-leave-active {
  transition: opacity 0.18s ease;
}

.learn-dialog-enter-active .learn-dialog,
.learn-dialog-leave-active .learn-dialog {
  transition: transform 0.18s ease;
}

.learn-dialog-enter-from,
.learn-dialog-leave-to {
  opacity: 0;
}

.learn-dialog-enter-from .learn-dialog,
.learn-dialog-leave-to .learn-dialog {
  transform: translateY(10px) scale(0.97);
}
</style>
