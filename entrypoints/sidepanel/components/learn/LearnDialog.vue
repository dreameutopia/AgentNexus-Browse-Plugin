<script setup lang="ts">
/**
 * 网站学习确认弹窗（六态合一）
 *
 * 一个组件承载全部学习态确认，是因为它们共用同一套外壳与出入场动画，
 * 差异只在「正文 + 按钮组」——拆成六个组件会把 90% 的样式复制六遍。
 * 分支用 v-if/else-if 严格按 mode 排他渲染，任一时刻只可能有一种形态。
 *
 * 纯受控：内容来自 props.view，动作通过 emit('answer', choice) 上抛，
 * 由 use-learn-session 决定后续流转（组件自身不做任何业务判断）。
 */
import { t } from '@/utils/i18n';
import type { LearnDialogChoice, LearnDialogView } from '@/entrypoints/sidepanel/composables/use-learn-session';

const props = defineProps<{
  view: LearnDialogView | null;
}>();

const emit = defineEmits<{
  answer: [choice: LearnDialogChoice];
}>();

/**
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
    <div v-if="view" class="learn-dialog-overlay" @click.self="onOverlayClick">
      <div
        class="learn-dialog"
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
              {{ t('sidepanel.learn.stopCancel') }}
            </button>
            <button type="button" class="learn-btn learn-btn--danger" @click="emit('answer', 'confirm')">
              {{ t('sidepanel.learn.stopConfirm') }}
            </button>
          </footer>
        </template>

        <!-- ════════ 轮数上限：收尾提交 ════════ -->
        <template v-else-if="view.mode === 'limitWrapUp'">
          <header class="learn-dialog__header">
            <span class="learn-dialog__badge learn-dialog__badge--warn" aria-hidden="true">⏱️</span>
            <h3 class="learn-dialog__title">{{ t('sidepanel.learn.limitTitle') }}</h3>
          </header>
          <div class="learn-dialog__body">
            <p class="learn-dialog__text">
              {{ t('sidepanel.learn.limitBody', { iterations: view.iterations }) }}
            </p>
          </div>
          <footer class="learn-dialog__footer">
            <button type="button" class="learn-btn learn-btn--ghost" @click="emit('answer', 'stop')">
              {{ t('sidepanel.learn.limitStop') }}
            </button>
            <button type="button" class="learn-btn learn-btn--primary" @click="emit('answer', 'wrapUp')">
              {{ t('sidepanel.learn.limitWrapUp') }}
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
.learn-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 950;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(15, 23, 42, 0.6);
  backdrop-filter: blur(3px);
}

.learn-dialog {
  display: flex;
  flex-direction: column;
  width: min(520px, 100%);
  max-height: min(84vh, 700px);
  border-radius: 14px;
  background: var(--bg-elevated, #0f172a);
  color: var(--text-primary, #e2e8f0);
  box-shadow:
    0 24px 60px rgba(0, 0, 0, 0.42),
    0 0 0 1px var(--border, rgba(148, 163, 184, 0.2));
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
  background: rgba(148, 163, 184, 0.16);
}

.learn-dialog__badge--info {
  background: rgba(59, 130, 246, 0.18);
}

.learn-dialog__badge--warn {
  background: rgba(245, 158, 11, 0.18);
}

.learn-dialog__badge--error {
  background: rgba(239, 68, 68, 0.18);
}

.learn-dialog__title {
  margin: 0;
  font-size: 15.5px;
  font-weight: 600;
}

.learn-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 20px 4px;
  overflow-y: auto;
}

.learn-dialog__intro {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-secondary, #94a3b8);
}

.learn-dialog__text {
  margin: 0;
  font-size: 13px;
  line-height: 1.75;
  color: var(--text-primary, #e2e8f0);
}

.learn-dialog__text--break {
  word-break: break-word;
  white-space: pre-wrap;
}

.learn-dialog__muted {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-tertiary, #94a3b8);
}

/* 配置摘要 */
.learn-summary {
  margin: 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(148, 163, 184, 0.08);
  border: 1px solid var(--border, rgba(148, 163, 184, 0.16));
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
  color: var(--text-tertiary, #94a3b8);
}

.learn-summary__row dd {
  margin: 0;
  color: var(--text-primary, #e2e8f0);
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
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.3);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.learn-warnings li {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-secondary, #cbd5e1);
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
  background: rgba(148, 163, 184, 0.08);
  border: 1px solid var(--border, rgba(148, 163, 184, 0.16));
}

.learn-progress__label {
  font-size: 12.5px;
  color: var(--text-secondary, #cbd5e1);
}

/* 问题清单 */
.learn-issues {
  margin: 0;
  padding: 10px 12px 10px 30px;
  border-radius: 10px;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.28);
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
}

.learn-issues li {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-secondary, #cbd5e1);
  word-break: break-word;
}

.learn-dialog__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 16px 20px 18px;
}

.learn-btn {
  padding: 9px 18px;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background 0.15s ease,
    opacity 0.15s ease;
}

.learn-btn--ghost {
  border: 1px solid var(--border, rgba(148, 163, 184, 0.28));
  background: transparent;
  color: var(--text-secondary, #cbd5e1);
}

.learn-btn--ghost:hover {
  background: var(--bg-hover, rgba(148, 163, 184, 0.12));
}

.learn-btn--primary {
  border: none;
  background: var(--accent, #3b82f6);
  color: #fff;
}

.learn-btn--primary:hover {
  opacity: 0.9;
}

.learn-btn--danger {
  border: none;
  background: var(--danger, #ef4444);
  color: #fff;
}

.learn-btn--danger:hover {
  opacity: 0.9;
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
