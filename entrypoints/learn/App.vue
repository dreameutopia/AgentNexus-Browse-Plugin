<template>
  <div class="learn-page">
    <div class="learn-aurora" aria-hidden="true"></div>

    <div class="learn-shell">
      <header class="learn-topbar">
        <div class="learn-brand">
          <span class="learn-brand-mark" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2L14.2 9.8L22 12L14.2 14.2L12 22L9.8 14.2L2 12L9.8 9.8L12 2Z" fill="currentColor"/>
            </svg>
          </span>
          <div class="learn-brand-text">
            <span class="learn-eyebrow">{{ t('learnPage.eyebrow') }}</span>
            <h1>{{ t('learnPage.title') }}</h1>
          </div>
        </div>

        <div v-if="origin" class="learn-target" :title="origin.url || origin.title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M12 2A10 10 0 1 0 12 22A10 10 0 0 0 12 2M12 4C13.2 5.2 14 7.4 14.2 10H9.8C10 7.4 10.8 5.2 12 4M4.3 10H7.7C7.9 7.2 8.7 4.9 9.8 3.5A8 8 0 0 0 4.3 10M4.3 14A8 8 0 0 0 9.8 20.5C8.7 19.1 7.9 16.8 7.7 14H4.3M9.8 14H14.2C14 16.6 13.2 18.8 12 20C10.8 18.8 10 16.6 9.8 14M14.2 10H9.8C10 7.4 10.8 5.2 12 4C13.2 5.2 14 7.4 14.2 10M14.2 14C14 16.8 13.2 19.1 12.1 20.5A8 8 0 0 0 19.7 14H14.2M19.7 10A8 8 0 0 0 14.2 3.5C15.3 4.9 16.1 7.2 16.3 10H19.7Z" fill="currentColor"/>
          </svg>
          <span class="learn-target-title">{{ origin.title || hostOf(origin.url) }}</span>
          <span class="learn-target-host">{{ hostOf(origin.url) }}</span>
        </div>
      </header>

      <main class="learn-layout">
        <!-- 左：配置表单 / 成功态 -->
        <section class="learn-main">
          <transition name="learn-fade" mode="out-in">
            <div v-if="started" key="success" class="learn-card learn-success">
              <span class="learn-success-icon" aria-hidden="true">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M9 16.2L4.8 12L3.4 13.4L9 19L21 7L19.6 5.6L9 16.2Z" fill="currentColor"/>
                </svg>
              </span>
              <h2>{{ t('learnPage.successTitle') }}</h2>
              <p>{{ t('learnPage.successBody') }}</p>
              <p class="learn-success-hint">{{ t('learnPage.successHint') }}</p>
              <p v-if="error" class="learn-error" role="alert">{{ error }}</p>
              <div class="learn-actions">
                <button type="button" class="learn-btn learn-btn--primary" @click="returnToTarget">
                  {{ t('learnPage.successReturn') }}
                </button>
                <button type="button" class="learn-btn" @click="resetForm">
                  {{ t('learnPage.successAgain') }}
                </button>
              </div>
            </div>

            <form v-else key="form" class="learn-card learn-form" @submit.prevent="startLearning">
              <div class="learn-field">
                <div class="learn-label-row">
                  <label class="learn-label" for="learn-goal">{{ t('learnPage.goalLabel') }}</label>
                  <span class="learn-counter" :class="{ 'learn-counter--warn': goal.length > LEARN_GOAL_MAX_CHARS * 0.9 }">
                    {{ goal.length }}/{{ LEARN_GOAL_MAX_CHARS }}
                  </span>
                </div>
                <textarea
                  id="learn-goal"
                  v-model="goal"
                  class="learn-textarea"
                  :maxlength="LEARN_GOAL_MAX_CHARS"
                  :placeholder="t('learnPage.goalPlaceholder')"
                  rows="4"
                  :disabled="starting"
                ></textarea>
              </div>

              <div class="learn-field">
                <div class="learn-label-row">
                  <label class="learn-label" for="learn-notes">{{ t('learnPage.notesLabel') }}</label>
                  <span class="learn-optional">{{ t('learnPage.notesOptional') }}</span>
                  <span class="learn-counter" :class="{ 'learn-counter--warn': notes.length > LEARN_NOTES_MAX_CHARS * 0.9 }">
                    {{ notes.length }}/{{ LEARN_NOTES_MAX_CHARS }}
                  </span>
                </div>
                <textarea
                  id="learn-notes"
                  v-model="notes"
                  class="learn-textarea learn-textarea--notes"
                  :maxlength="LEARN_NOTES_MAX_CHARS"
                  :placeholder="t('learnPage.notesPlaceholder')"
                  rows="3"
                  :disabled="starting"
                ></textarea>
              </div>

              <div class="learn-field">
                <div class="learn-label-row">
                  <span class="learn-label">{{ t('learnPage.agentLabel') }}</span>
                  <span class="learn-optional">{{ t('learnPage.agentHint') }}</span>
                </div>
                <div v-if="agents.length" class="learn-agent-list">
                  <button
                    v-for="agent in agents"
                    :key="agent.name"
                    type="button"
                    class="learn-agent"
                    :class="{ 'learn-agent--selected': agent.name === selectedAgentName }"
                    :aria-pressed="agent.name === selectedAgentName"
                    :disabled="starting"
                    @click="selectedAgentName = agent.name"
                  >
                    <AgentAvatar :avatar="agent.avatar" :size="32" :label="displayOf(agent).name" />
                    <span class="learn-agent-text">
                      <span class="learn-agent-name">{{ displayOf(agent).name }}</span>
                      <span class="learn-agent-desc">{{ displayOf(agent).description }}</span>
                    </span>
                    <span class="learn-agent-check" aria-hidden="true">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M9 16.2L4.8 12L3.4 13.4L9 19L21 7L19.6 5.6L9 16.2Z" fill="currentColor"/>
                      </svg>
                    </span>
                  </button>
                </div>
                <p v-else class="learn-empty">{{ t('learnPage.noAgents') }}</p>
              </div>

              <p v-if="!learnSkillReady" class="learn-warning" role="status">
                {{ t('learnPage.skillUnavailable') }}
              </p>
              <p v-if="error" class="learn-error" role="alert">{{ error }}</p>

              <div class="learn-actions">
                <button
                  type="submit"
                  class="learn-btn learn-btn--primary learn-btn--start"
                  :disabled="!canStart || starting"
                >
                  <span v-if="starting" class="learn-spinner" aria-hidden="true"></span>
                  {{ starting ? t('learnPage.starting') : t('learnPage.start') }}
                </button>
              </div>

              <p v-if="originReady && !origin" class="learn-warning" role="status">
                {{ t('learnPage.originUnavailable') }}
              </p>
            </form>
          </transition>
        </section>

        <!-- 右：介绍 -->
        <aside class="learn-intro">
          <div class="learn-card learn-intro-card">
            <span class="learn-intro-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 2L14.2 9.8L22 12L14.2 14.2L12 22L9.8 14.2L2 12L9.8 9.8L12 2Z" fill="currentColor"/>
              </svg>
            </span>
            <h2>{{ t('learnPage.introTitle') }}</h2>
            <p>{{ t('learnPage.introBody') }}</p>
            <ul class="learn-intro-list">
              <li>{{ t('learnPage.introPoint1') }}</li>
              <li>{{ t('learnPage.introPoint2') }}</li>
              <li>{{ t('learnPage.introPoint3') }}</li>
            </ul>
            <p class="learn-intro-note">{{ t('learnPage.introNote') }}</p>
          </div>
        </aside>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { t } from '@/utils/i18n';
import AgentAvatar from '@/common/AgentAvatar.vue';
import { useAgentDisplay } from '@/common/use-agent-display';
import { agentEngine, skillEngine } from '@/entrypoints/sidepanel/core';
import type { AgentConfig } from '@/utils/agents/agent-types';
import { WEBSITE_TASK_LEARN_SKILL_ID } from '@/utils/skills/skill-identity';
import {
  LEARN_GOAL_MAX_CHARS,
  LEARN_NOTES_MAX_CHARS,
  LEARN_ORIGIN_STORAGE_KEY,
  focusLearnOrigin,
  preflightLearnSession,
  readLearnOrigin,
  resolveLiveLearnOrigin,
  startLearnSession,
  type LearnBridgeFailureCode,
  type LearnOriginTab,
} from '@/utils/sessions/learn-launch-bridge';

const { displayOf } = useAgentDisplay();

const goal = ref('');
const notes = ref('');
const selectedAgentName = ref('');
const agents = ref<AgentConfig[]>([]);
const origin = ref<LearnOriginTab | null>(null);
const originReady = ref(false);
const starting = ref(false);
const started = ref(false);
const error = ref('');

let unsubscribeAgents: (() => void) | undefined;

/** 内置学习技能是否可用；禁用/缺失时直接给出可读提示，避免启动后才知道 */
const learnSkillReady = computed(() => {
  try {
    const skill = skillEngine.get(WEBSITE_TASK_LEARN_SKILL_ID);
    return Boolean(skill) && skill?.enabled !== false;
  } catch (err) {
    console.warn('[LearnPage] 读取学习技能失败:', err);
    return false;
  }
});

const canStart = computed(
  () => Boolean(goal.value.trim())
    && Boolean(selectedAgentName.value)
    && Boolean(origin.value)
    && learnSkillReady.value
    && !starting.value
    && !started.value,
);

function refreshAgents(): void {
  try {
    agents.value = agentEngine.list().filter(agent => agent.enabled !== false);
  } catch (err) {
    console.warn('[LearnPage] 读取智能体列表失败:', err);
    agents.value = [];
  }
  if (!agents.value.some(agent => agent.name === selectedAgentName.value)) {
    selectedAgentName.value = agents.value[0]?.name ?? '';
  }
}

async function refreshOrigin(): Promise<void> {
  try {
    const stored = await readLearnOrigin();
    if (!stored) {
      origin.value = null;
      return;
    }
    origin.value = await resolveLiveLearnOrigin(stored);
  } catch (err) {
    console.warn('[LearnPage] 读取目标标签页失败:', err);
    origin.value = null;
  }
}

function hostOf(url: string): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function failureMessage(code: LearnBridgeFailureCode): string {
  switch (code) {
    case 'sidepanel-unavailable':
      return t('learnPage.sidepanelClosed');
    case 'busy':
      return t('learnPage.busy');
    case 'agent-unavailable':
      return t('learnPage.agentUnavailable');
    case 'skill-unavailable':
      return t('learnPage.skillUnavailable');
    case 'model-unavailable':
      return t('learnPage.modelUnavailable');
    case 'origin-unavailable':
      return t('learnPage.originUnavailable');
    case 'invalid-request':
      return t('learnPage.invalidRequest');
    case 'send-failed':
    default:
      return t('learnPage.sendFailed');
  }
}

async function startLearning(): Promise<void> {
  if (starting.value || started.value) return;
  error.value = '';
  const trimmedGoal = goal.value.trim();
  if (!trimmedGoal) {
    error.value = t('learnPage.goalRequired');
    return;
  }
  if (trimmedGoal.length > LEARN_GOAL_MAX_CHARS) {
    error.value = t('learnPage.goalTooLong', { count: LEARN_GOAL_MAX_CHARS });
    return;
  }
  if (notes.value.trim().length > LEARN_NOTES_MAX_CHARS) {
    error.value = t('learnPage.notesTooLong', { count: LEARN_NOTES_MAX_CHARS });
    return;
  }
  if (!selectedAgentName.value) {
    error.value = t('learnPage.agentUnavailable');
    return;
  }
  if (!learnSkillReady.value) {
    error.value = t('learnPage.skillUnavailable');
    return;
  }
  if (!origin.value) {
    error.value = t('learnPage.originUnavailable');
    return;
  }

  starting.value = true;
  try {
    // 目标标签页可能已被关闭/移动：启动前重新解析，避免把学习工具作用到本页
    const live = await resolveLiveLearnOrigin(origin.value);
    if (!live) {
      origin.value = null;
      error.value = t('learnPage.originUnavailable');
      return;
    }
    origin.value = live;

    const preflight = await preflightLearnSession(live.windowId);
    if (!preflight.ok) {
      error.value = failureMessage(preflight.code);
      return;
    }

    // 必须先切回目标标签页：侧边栏的浏览器作用域按窗口活动页生效
    const focused = await focusLearnOrigin(live);
    if (!focused) {
      origin.value = null;
      error.value = t('learnPage.originUnavailable');
      return;
    }

    const result = await startLearnSession({
      windowId: live.windowId,
      goal: trimmedGoal,
      notes: notes.value.trim(),
      agentName: selectedAgentName.value,
      originUrl: live.url,
      originTitle: live.title,
    });
    if (!result.ok) {
      error.value = failureMessage(result.code);
      return;
    }
    started.value = true;
  } catch (err) {
    console.warn('[LearnPage] 启动学习会话失败:', err);
    error.value = t('learnPage.sendFailed');
  } finally {
    starting.value = false;
  }
}

async function returnToTarget(): Promise<void> {
  if (!origin.value) {
    error.value = t('learnPage.originUnavailable');
    return;
  }
  const focused = await focusLearnOrigin(origin.value);
  if (!focused) {
    origin.value = null;
    error.value = t('learnPage.originUnavailable');
  }
}

function resetForm(): void {
  started.value = false;
  error.value = '';
}

function onWindowFocus(): void {
  void refreshOrigin();
}

function onSessionStorageChanged(
  changes: Record<string, chrome.storage.StorageChange>,
): void {
  if (changes[LEARN_ORIGIN_STORAGE_KEY]) {
    void refreshOrigin();
  }
}

onMounted(async () => {
  refreshAgents();
  unsubscribeAgents = agentEngine.onChange(refreshAgents);
  await refreshOrigin();
  originReady.value = true;
  window.addEventListener('focus', onWindowFocus);
  try {
    chrome.storage?.session?.onChanged?.addListener(onSessionStorageChanged);
  } catch (err) {
    console.warn('[LearnPage] 监听来源标签页变化失败:', err);
  }
});

onUnmounted(() => {
  unsubscribeAgents?.();
  window.removeEventListener('focus', onWindowFocus);
  try {
    chrome.storage?.session?.onChanged?.removeListener(onSessionStorageChanged);
  } catch {
    /* 已卸载，无需处理 */
  }
});
</script>
