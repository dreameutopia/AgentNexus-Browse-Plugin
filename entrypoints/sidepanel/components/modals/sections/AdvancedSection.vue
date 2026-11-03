<template>
  <div>
    <!-- 分区说明：全局请求参数 + 对话循环参数（文案见 defaultsIntro） -->
    <p class="config-form-hint config-section-intro">{{ t('sidepanel.apiConfig.defaultsIntro') }}</p>

    <!-- 重试次数（全局） -->
    <div class="config-form-group">
      <label class="config-form-label">{{ t('sidepanel.apiConfig.retryCount') }}</label>
      <input
        type="number"
        class="config-form-input config-form-input-sm"
        v-model.number="draft.retryCount"
        min="0"
        max="10"
        placeholder="0-10"
      />
      <p class="config-form-hint">{{ t('sidepanel.apiConfig.retryCountHint') }}</p>
    </div>

    <!-- 重试间隔（全局） -->
    <div class="config-form-group">
      <label class="config-form-label">{{ t('sidepanel.apiConfig.retryInterval') }}</label>
      <input
        type="number"
        class="config-form-input config-form-input-sm"
        v-model.number="draft.retryInterval"
        min="1"
        max="120"
        step="1"
        placeholder="2"
      />
      <p class="config-form-hint">{{ t('sidepanel.apiConfig.retryIntervalHint') }}</p>
    </div>

    <!-- 温度（全局） -->
    <div class="config-form-group">
      <label class="config-form-label">{{ t('sidepanel.apiConfig.temperature') }}</label>
      <input
        type="number"
        class="config-form-input config-form-input-sm"
        v-model.number="draft.temperature"
        min="0"
        max="2"
        step="0.1"
        placeholder="0.7"
      />
      <p class="config-form-hint">{{ t('sidepanel.apiConfig.defaultsTemperatureHint') }}</p>
    </div>

    <!-- 上下文阈值（新建模型默认） -->
    <div class="config-form-group">
      <label class="config-form-label">{{ t('sidepanel.apiConfig.contextThreshold') }}</label>
      <input
        type="number"
        class="config-form-input config-form-input-sm"
        v-model.number="draft.defaultContextThreshold"
        min="8192"
        max="1048576"
        step="1024"
        placeholder="262144"
      />
      <p class="config-form-hint">{{ t('sidepanel.apiConfig.contextThresholdHint') }}</p>
    </div>

    <!-- interact 询问等待时长（全局应用级） -->
    <div class="config-form-group">
      <label class="config-form-label">{{ t('sidepanel.apiConfig.interactTimeout') }}</label>
      <input
        type="number"
        class="config-form-input config-form-input-sm"
        v-model.number="draft.interactTimeoutMinutes"
        min="1"
        max="120"
        step="1"
        placeholder="20"
      />
      <p class="config-form-hint">{{ t('sidepanel.apiConfig.interactTimeoutHint') }}</p>
    </div>

    <!-- 文本对话轮次上限（全局应用级） -->
    <div class="config-form-group">
      <label class="config-form-label">{{ t('sidepanel.apiConfig.textMaxIterations') }}</label>
      <input
        type="number"
        class="config-form-input config-form-input-sm"
        v-model.number="draft.textMaxIterations"
        :min="ITERATIONS_MIN"
        :max="ITERATIONS_MAX"
        step="1"
        placeholder="20"
      />
      <p class="config-form-hint">{{ t('sidepanel.apiConfig.textMaxIterationsHint') }}</p>
    </div>

    <!-- 视觉对话轮次上限（全局应用级） -->
    <div class="config-form-group">
      <label class="config-form-label">{{ t('sidepanel.apiConfig.visionMaxIterations') }}</label>
      <input
        type="number"
        class="config-form-input config-form-input-sm"
        v-model.number="draft.visionMaxIterations"
        :min="ITERATIONS_MIN"
        :max="ITERATIONS_MAX"
        step="1"
        placeholder="10"
      />
      <p class="config-form-hint">{{ t('sidepanel.apiConfig.visionMaxIterationsHint') }}</p>
    </div>

    <!-- 连续工具失败轮次阈值（全局应用级） -->
    <div class="config-form-group">
      <label class="config-form-label">{{ t('sidepanel.apiConfig.toolFailRounds') }}</label>
      <input
        type="number"
        class="config-form-input config-form-input-sm"
        v-model.number="draft.maxConsecutiveFailedToolRounds"
        :min="FAILED_TOOL_ROUNDS_MIN"
        :max="FAILED_TOOL_ROUNDS_MAX"
        step="1"
        placeholder="5"
      />
      <p class="config-form-hint">{{ t('sidepanel.apiConfig.toolFailRoundsHint') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 高级参数分区（应用设置）：
 *   - 重试 / 温度 / 新建模型上下文阈值 = 全局请求参数（对所有渠道生效，
 *     渠道编辑器不再单独配置这三项）
 *   - interact 询问等待时长 / 文本与视觉对话轮次上限 / 连续工具失败阈值
 *     = 全局应用设置（轮次与失败阈值经 runtime 装配注入会话引擎的循环守卫）
 * 与渠道分区共享同一份表单草稿，由底部「保存」统一持久化。
 * 数值边界引用 channel-types 常量（校验 / 钳制 / UI 三处共用，永不漂移）。
 */
import { inject } from 'vue';
import { t } from '@/utils/i18n';
import {
  FAILED_TOOL_ROUNDS_MAX,
  FAILED_TOOL_ROUNDS_MIN,
  ITERATIONS_MAX,
  ITERATIONS_MIN,
} from '../../../utils/channels';
import { settingsFormKey, type SettingsFormApi } from '../composables/use-settings-form';

const form = inject(settingsFormKey) as SettingsFormApi;

/** 顶层绑定在模板中自动解包 ref，模板可直接 draft.retryCount 双向绑定 */
const draft = form.settingsDraft;
</script>