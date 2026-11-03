<script setup lang="ts">
/**
 * 网站学习配置面板
 *
 * 只负责「收集 + 本地即时反馈」，不持有业务状态：
 *   - 表单值：组件内部（打开时重置，关闭即丢弃，不跨会话残留）；
 *   - 校验结果：由父级（use-learn-session）经 props.errors 下发——
 *     校验规则单点收敛在 learn-validate，避免「面板一套、提交一套」的漂移；
 *   - 提交：emit('submit', raw)，由父级校验后决定是否进入二次确认。
 *
 * 三条联动规则在这里落地为交互：
 *   1. 目标模式 = 视觉 → 学习策略锁定为视觉（选项禁用 + 说明文案）；
 *   2. 视觉需求变化（目标模式 / 学习策略任一引起）→ 清空已选模型并内联提示；
 *   3. 需要视觉但清单里没有可收图模型 → 内联引导去设置。
 */
import { computed, reactive, ref, watch } from 'vue';
import { t, type MessageKey } from '@/utils/i18n';
import LearnHintPopover from './LearnHintPopover.vue';
import './learn-theme.css';
import {
  LEARN_ERROR_KEYS,
  filterLearnModels,
  needsVisionModel,
  shouldClearModelOnStrategyChange,
  LEARN_GOAL_MAX_CHARS,
  type LearnConfigErrorCode,
  type LearnConfigField,
  type LearnModelCandidate,
} from '@/utils/learn/learn-validate';
import type { LearnConfigInput, LearnStrategy, LearnTargetMode } from '@/utils/learn/learn-types';

/** 错误码 → i18n key 的展示层视图（learn-validate 保持零 i18n 依赖，此处一次性收口） */
const ERROR_KEYS = LEARN_ERROR_KEYS as Record<LearnConfigErrorCode, MessageKey>;

const props = defineProps<{
  visible: boolean;
  /** 全量可选模型（面板按当前表单状态自行过滤） */
  modelCandidates: LearnModelCandidate[];
  /** 父级校验结果（错误码 → 本组件映射文案） */
  errors: Partial<Record<LearnConfigField, LearnConfigErrorCode>>;
  /**
   * 表单重置纪元：仅「新的学习意图」（openModal）递增。
   * 从确认弹窗「返回修改」不递增——保留已填内容正是该按钮承诺的语义，
   * 故不能用 visible 变化当重置信号（confirming↔configuring 往返也切 visible）。
   */
  resetEpoch: number;
}>();

const emit = defineEmits<{
  close: [];
  submit: [raw: LearnConfigInput];
  openSettings: [];
}>();

// ──── 表单态 ────

const form = reactive({
  url: '',
  goal: '',
  targetMode: 'text' as LearnTargetMode,
  strategy: 'text' as LearnStrategy,
  modelKey: '',
  autoValidate: true,
});

/** 模型清单因视觉需求变化而清空后的友好提示 */
const modelClearedNotice = ref(false);

// 新的学习意图 → 从干净状态开始：上次未提交的输入不残留（避免误用旧配置开跑）。
// watch resetEpoch 而非 visible：确认弹窗「返回修改」（confirming → configuring）
// 同样会切回 visible，但那不是重新打开——清空会吞掉用户想修改的内容
watch(
  () => props.resetEpoch,
  () => {
    form.url = '';
    form.goal = '';
    form.targetMode = 'text';
    form.strategy = 'text';
    form.modelKey = '';
    form.autoValidate = true;
    modelClearedNotice.value = false;
  },
);

// ──── 派生 ────

/** 当前表单是否需要能接收图片的模型 */
const requireVision = computed(() =>
  needsVisionModel({ targetMode: form.targetMode, strategy: form.strategy }),
);

/** 经视觉口径过滤后的模型清单 */
const visibleModels = computed(() => filterLearnModels(props.modelCandidates, requireVision.value));

/** 需要视觉但一个可收图模型都没有（区别于「尚未配置任何模型」） */
const noVisionModelAvailable = computed(
  () =>
    requireVision.value &&
    props.modelCandidates.length > 0 &&
    props.modelCandidates.every(candidate => !candidate.canAcceptImages),
);

const noModelAtAll = computed(() => props.modelCandidates.length === 0);

const goalLength = computed(() => Array.from(form.goal).length);

/** 错误码 → 展示文案 */
function errorOf(field: LearnConfigField): string {
  const code = props.errors[field];
  return code ? t(ERROR_KEYS[code]) : '';
}

// ──── 联动 ────

/** 视觉需求是否变化（用切换前后的完整状态比较，避免目标模式同时变化时误判） */
function visionNeedChanged(nextMode: LearnTargetMode, nextStrategy: LearnStrategy): boolean {
  return shouldClearModelOnStrategyChange(
    { targetMode: form.targetMode, strategy: form.strategy },
    { targetMode: nextMode, strategy: nextStrategy },
  );
}

function clearModelIfInconsistent(nextMode: LearnTargetMode, nextStrategy: LearnStrategy): void {
  if (!visionNeedChanged(nextMode, nextStrategy)) return;
  if (form.modelKey) {
    form.modelKey = '';
    modelClearedNotice.value = true;
  }
}

function selectTargetMode(mode: LearnTargetMode): void {
  if (form.targetMode === mode) return;
  // 目标为视觉时学习策略一并锁定为视觉（产品约定：没有降级到纯文本的必要）
  const nextStrategy: LearnStrategy = mode === 'vision' ? 'vision' : form.strategy;
  clearModelIfInconsistent(mode, nextStrategy);
  form.targetMode = mode;
  form.strategy = nextStrategy;
}

function selectStrategy(strategy: LearnStrategy): void {
  if (form.targetMode === 'vision') return; // 锁定态不可切换
  if (form.strategy === strategy) return;
  clearModelIfInconsistent(form.targetMode, strategy);
  form.strategy = strategy;
}

function selectModel(event: Event): void {
  form.modelKey = (event.target as HTMLSelectElement).value;
  if (form.modelKey) modelClearedNotice.value = false;
}

// ──── 提交 ────

function submit(): void {
  const matched = visibleModels.value.find(candidate => candidate.key === form.modelKey);
  emit('submit', {
    url: form.url,
    goal: form.goal,
    targetMode: form.targetMode,
    strategy: form.strategy,
    // 未选中时传 null，让父级给出「请选择学习模型」而不是「模型不可用」
    modelRef: matched ? { channelId: matched.ref.channelId, modelId: matched.ref.modelId } : null,
    autoValidate: form.autoValidate,
  });
}
</script>

<template>
  <Transition name="learn-modal">
    <div v-if="visible" class="learn-modal-overlay learn-root" @click.self="emit('close')">
      <div class="learn-modal learn-panel" role="dialog" aria-modal="true" :aria-label="t('sidepanel.learn.modalTitle')">
        <header class="learn-modal__header">
          <div>
            <h2 class="learn-modal__title">{{ t('sidepanel.learn.modalTitle') }}</h2>
            <p class="learn-modal__subtitle">{{ t('sidepanel.learn.modalSubtitle') }}</p>
          </div>
          <button class="learn-modal__close" type="button" :aria-label="t('common.close')" @click="emit('close')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41Z" fill="currentColor" />
            </svg>
          </button>
        </header>

        <div class="learn-modal__body">
          <!-- 网站链接 -->
          <label class="learn-field">
            <span class="learn-field__label">{{ t('sidepanel.learn.urlLabel') }}</span>
            <input
              v-model="form.url"
              class="learn-field__input"
              type="url"
              spellcheck="false"
              :placeholder="t('sidepanel.learn.urlPlaceholder')"
              @keydown.enter.prevent="submit"
            />
            <span v-if="errorOf('url')" class="learn-field__error">{{ errorOf('url') }}</span>
          </label>

          <!-- 学习目标 -->
          <label class="learn-field">
            <span class="learn-field__label">{{ t('sidepanel.learn.goalLabel') }}</span>
            <textarea
              v-model="form.goal"
              class="learn-field__textarea"
              rows="3"
              :placeholder="t('sidepanel.learn.goalPlaceholder')"
            ></textarea>
            <span class="learn-field__foot">
              <span v-if="errorOf('goal')" class="learn-field__error">{{ errorOf('goal') }}</span>
              <span class="learn-field__counter">
                {{ t('sidepanel.learn.goalCounter', { current: goalLength, max: LEARN_GOAL_MAX_CHARS }) }}
              </span>
            </span>
          </label>

          <!-- 目标操作模式 -->
          <div class="learn-field">
            <span class="learn-field__label">
              {{ t('sidepanel.learn.targetModeLabel') }}
            </span>
            <p class="learn-field__hint">{{ t('sidepanel.learn.targetModeHint') }}</p>
            <div class="learn-segmented" role="radiogroup" :aria-label="t('sidepanel.learn.targetModeLabel')">
              <button
                type="button"
                class="learn-segmented__item"
                :class="{ active: form.targetMode === 'text' }"
                role="radio"
                :aria-checked="form.targetMode === 'text'"
                @click="selectTargetMode('text')"
              >
                <span class="learn-segmented__title">{{ t('sidepanel.learn.targetModeText') }}</span>
                <span class="learn-segmented__desc">{{ t('sidepanel.learn.targetModeTextDesc') }}</span>
              </button>
              <button
                type="button"
                class="learn-segmented__item"
                :class="{ active: form.targetMode === 'vision' }"
                role="radio"
                :aria-checked="form.targetMode === 'vision'"
                @click="selectTargetMode('vision')"
              >
                <span class="learn-segmented__title">{{ t('sidepanel.learn.targetModeVision') }}</span>
                <span class="learn-segmented__desc">{{ t('sidepanel.learn.targetModeVisionDesc') }}</span>
              </button>
            </div>
            <span v-if="errorOf('targetMode')" class="learn-field__error">{{ errorOf('targetMode') }}</span>
          </div>

          <!-- 学习策略 -->
          <div class="learn-field">
            <span class="learn-field__label">
              {{ t('sidepanel.learn.strategyLabel') }}
              <LearnHintPopover
                :title="t('sidepanel.learn.strategyHintTitle')"
                :lines="[
                  t('sidepanel.learn.strategyHintBody1'),
                  t('sidepanel.learn.strategyHintBody2'),
                  t('sidepanel.learn.strategyHintBody3'),
                ]"
              />
            </span>
            <div class="learn-segmented" role="radiogroup" :aria-label="t('sidepanel.learn.strategyLabel')">
              <button
                type="button"
                class="learn-segmented__item"
                :class="{ active: form.strategy === 'text', locked: form.targetMode === 'vision' }"
                role="radio"
                :aria-checked="form.strategy === 'text'"
                :disabled="form.targetMode === 'vision'"
                @click="selectStrategy('text')"
              >
                <span class="learn-segmented__title">{{ t('sidepanel.learn.strategyText') }}</span>
                <span class="learn-segmented__desc">{{ t('sidepanel.learn.strategyTextDesc') }}</span>
              </button>
              <button
                type="button"
                class="learn-segmented__item"
                :class="{ active: form.strategy === 'vision' }"
                role="radio"
                :aria-checked="form.strategy === 'vision'"
                @click="selectStrategy('vision')"
              >
                <span class="learn-segmented__title">{{ t('sidepanel.learn.strategyVision') }}</span>
                <span class="learn-segmented__desc">{{ t('sidepanel.learn.strategyVisionDesc') }}</span>
              </button>
            </div>
            <p v-if="form.targetMode === 'vision'" class="learn-field__hint">
              {{ t('sidepanel.learn.strategyLocked') }}
            </p>
            <span v-if="errorOf('strategy')" class="learn-field__error">{{ errorOf('strategy') }}</span>
          </div>

          <!-- 学习模型 -->
          <div class="learn-field">
            <span class="learn-field__label">
              {{ t('sidepanel.learn.modelLabel') }}
              <span class="learn-field__sub">{{ t('sidepanel.learn.modelHint') }}</span>
            </span>

            <div v-if="noModelAtAll" class="learn-field__empty">
              {{ t('sidepanel.learn.modelNoModels') }}
              <button type="button" class="learn-link" @click="emit('openSettings')">
                {{ t('sidepanel.learn.modelGoSettings') }}
              </button>
            </div>
            <div v-else-if="noVisionModelAvailable" class="learn-field__empty">
              {{ t('sidepanel.learn.modelNoVision') }}
              <button type="button" class="learn-link" @click="emit('openSettings')">
                {{ t('sidepanel.learn.modelGoSettings') }}
              </button>
            </div>
            <select
              v-else
              class="learn-field__select"
              :value="form.modelKey"
              @change="selectModel"
            >
              <option value="" disabled>{{ t('sidepanel.learn.modelLabel') }}</option>
              <option v-for="model in visibleModels" :key="model.key" :value="model.key">
                {{ model.label }}{{ model.channelName ? ` · ${model.channelName}` : '' }}
              </option>
            </select>

            <p v-if="modelClearedNotice" class="learn-field__notice">
              {{ t('sidepanel.learn.strategyClearedModel') }}
            </p>
            <span v-if="errorOf('modelRef')" class="learn-field__error">{{ errorOf('modelRef') }}</span>
          </div>

          <!-- 自动验证 -->
          <div class="learn-field learn-field--row">
            <div class="learn-toggle__text">
              <span class="learn-field__label">{{ t('sidepanel.learn.autoValidateLabel') }}</span>
              <p class="learn-field__hint">
                {{ form.autoValidate ? t('sidepanel.learn.autoValidateOn') : t('sidepanel.learn.autoValidateOff') }}
              </p>
            </div>
            <button
              type="button"
              class="learn-toggle"
              :class="{ on: form.autoValidate }"
              role="switch"
              :aria-checked="form.autoValidate"
              :aria-label="t('sidepanel.learn.autoValidateLabel')"
              @click="form.autoValidate = !form.autoValidate"
            >
              <span class="learn-toggle__knob"></span>
            </button>
          </div>
        </div>

        <footer class="learn-modal__footer">
          <button type="button" class="learn-btn learn-btn--ghost" @click="emit('close')">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="learn-btn learn-btn--primary" @click="submit">
            {{ t('sidepanel.learn.startLearning') }}
          </button>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.learn-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--learn-scrim);
  backdrop-filter: blur(2px);
}

.learn-modal {
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  max-height: min(88vh, 760px);
  border-radius: 14px;
  overflow: hidden;
}

.learn-modal__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 12px;
  border-bottom: 1px solid var(--learn-border);
}

.learn-modal__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--learn-text-strong);
}

.learn-modal__subtitle {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--learn-text-muted);
}

.learn-modal__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--learn-text-faint);
  cursor: pointer;
  transition: all 0.15s ease;
}

.learn-modal__close:hover {
  background: var(--learn-surface-hover);
  color: var(--learn-text);
}

.learn-modal__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px 20px;
  overflow-y: auto;
}

.learn-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.learn-field--row {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.learn-field__label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--learn-text);
}

.learn-field__sub {
  font-weight: 400;
  font-size: 11.5px;
  color: var(--learn-text-faint);
}

.learn-field__hint {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--learn-text-faint);
}

.learn-field__input,
.learn-field__textarea,
.learn-field__select {
  width: 100%;
  padding: 9px 11px;
  border: 1px solid var(--learn-border-strong);
  border-radius: 9px;
  background: var(--learn-surface);
  color: var(--learn-text);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.learn-field__textarea {
  resize: vertical;
  min-height: 64px;
  line-height: 1.6;
}

.learn-field__input:focus,
.learn-field__textarea:focus,
.learn-field__select:focus {
  border-color: var(--learn-accent);
  box-shadow: 0 0 0 3px var(--learn-accent-soft);
}

.learn-field__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 16px;
}

.learn-field__counter {
  margin-left: auto;
  font-size: 11px;
  color: var(--learn-text-faint);
}

.learn-field__error {
  font-size: 11.5px;
  color: var(--learn-danger);
}

.learn-field__notice {
  margin: 0;
  font-size: 11.5px;
  color: var(--learn-warning);
}

.learn-field__empty {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 9px;
  background: var(--learn-warning-soft);
  border: 1px solid var(--learn-warning-border);
  font-size: 12px;
  color: var(--learn-text-muted);
  line-height: 1.6;
}

.learn-link {
  border: none;
  background: none;
  padding: 0;
  color: var(--learn-accent-deep);
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
}

/* 分段选择（目标模式 / 学习策略） */
.learn-segmented {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.learn-segmented__item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  border: 1px solid var(--learn-border-strong);
  border-radius: 10px;
  background: var(--learn-surface);
  color: var(--learn-text);
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}

.learn-segmented__item:hover:not(:disabled) {
  border-color: var(--learn-accent);
}

.learn-segmented__item.active {
  border-color: var(--learn-accent);
  background: var(--learn-accent-soft);
}

.learn-segmented__item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.learn-segmented__title {
  font-size: 13px;
  font-weight: 600;
}

.learn-segmented__desc {
  font-size: 11px;
  line-height: 1.5;
  color: var(--learn-text-muted);
}

/* 开关 */
.learn-toggle {
  position: relative;
  flex: 0 0 auto;
  width: 40px;
  height: 22px;
  border: none;
  border-radius: 999px;
  background: #d1d5db;
  cursor: pointer;
  transition: background 0.18s ease;
}

.learn-toggle.on {
  background: var(--learn-accent);
}

.learn-toggle__knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  transition: transform 0.18s ease;
}

.learn-toggle.on .learn-toggle__knob {
  transform: translateX(18px);
}

.learn-toggle__text {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 底部按钮 */
.learn-modal__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--learn-border);
}

/* 进出场 */
.learn-modal-enter-active,
.learn-modal-leave-active {
  transition: opacity 0.18s ease;
}

.learn-modal-enter-active .learn-modal,
.learn-modal-leave-active .learn-modal {
  transition: transform 0.18s ease;
}

.learn-modal-enter-from,
.learn-modal-leave-to {
  opacity: 0;
}

.learn-modal-enter-from .learn-modal,
.learn-modal-leave-to .learn-modal {
  transform: translateY(8px) scale(0.98);
}
</style>
