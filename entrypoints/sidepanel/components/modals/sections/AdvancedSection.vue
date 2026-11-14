<template>
  <div>
    <!-- 分区说明：全局请求参数 + 对话循环参数（文案见 defaultsIntro） -->
    <p class="config-form-hint config-section-intro">{{ t('sidepanel.apiConfig.defaultsIntro') }}</p>

    <!-- 默认智能体（新会话首条消息未选智能体时自动选中） -->
    <div class="config-form-group">
      <label class="config-form-label">{{ t('sidepanel.apiConfig.defaultAgent') }}</label>
      <select v-model="draft.defaultAgentId" class="config-form-input">
        <optgroup
          v-for="group in agentGroups"
          :key="group.categoryId"
          :label="group.label"
        >
          <option v-for="agent in group.agents" :key="agent.id" :value="agent.id">
            {{ displayNameOf(agent) }}
          </option>
        </optgroup>
        <!-- 草稿指向的默认智能体已被删除：原样展示 id，保存时由校验/运行期回落兜底 -->
        <option v-if="defaultAgentMissing" :value="draft.defaultAgentId">
          {{ draft.defaultAgentId }}
        </option>
      </select>
      <p class="config-form-hint">{{ t('sidepanel.apiConfig.defaultAgentHint') }}</p>
    </div>

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

    <!-- 对话轮次上限（全局应用级，文本与视觉策略统一）。
         data-setting-id 供「守卫停止 → 修改设置」精确滚动/聚焦 -->
    <div class="config-form-group" data-setting-id="maxIterations">
      <label class="config-form-label">{{ t('sidepanel.apiConfig.maxIterations') }}</label>
      <input
        type="number"
        class="config-form-input config-form-input-sm"
        v-model.number="draft.maxIterations"
        :min="ITERATIONS_MIN"
        :max="ITERATIONS_MAX"
        step="1"
        placeholder="30"
      />
      <p class="config-form-hint">{{ t('sidepanel.apiConfig.maxIterationsHint') }}</p>
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

    <!-- 单工具最长执行时间（全局应用级；由工具执行引擎作为硬上界执行） -->
    <div class="config-form-group">
      <label class="config-form-label">{{ t('sidepanel.apiConfig.toolTimeoutMinutes') }}</label>
      <input
        type="number"
        class="config-form-input config-form-input-sm"
        v-model.number="draft.toolTimeoutMinutes"
        :min="TOOL_TIMEOUT_MIN_MINUTES"
        :max="TOOL_TIMEOUT_MAX_MINUTES"
        step="1"
        placeholder="30"
      />
      <p class="config-form-hint">{{ t('sidepanel.apiConfig.toolTimeoutMinutesHint') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 高级参数分区（应用设置）：
 *   - 默认智能体 = 新会话首条消息未选智能体时的自动选中目标（存稳定 id，
 *     删除后运行期回落预置 Auto-Action）
 *   - 重试 / 温度 / 新建模型上下文阈值 = 全局请求参数（对所有渠道生效，
 *     渠道编辑器不再单独配置这三项）
 *   - interact 询问等待时长 / 对话轮次上限（文本与视觉策略统一）/ 连续工具失败阈值
 *     = 全局应用设置（轮次与失败阈值经 runtime 装配注入会话引擎的循环守卫）
 * 与渠道分区共享同一份表单草稿，由底部「保存」统一持久化。
 * 数值边界引用 channel-types 常量（校验 / 钳制 / UI 三处共用，永不漂移）。
 */
import { computed, inject, onUnmounted, ref } from 'vue';
import { t, type MessageKey } from '@/utils/i18n';
import { agentEngine } from '../../../core/registry/agent-engine';
import { useAgentDisplay } from '@/common/use-agent-display';
import {
  FAILED_TOOL_ROUNDS_MAX,
  FAILED_TOOL_ROUNDS_MIN,
  ITERATIONS_MAX,
  ITERATIONS_MIN,
  TOOL_TIMEOUT_MAX_MINUTES,
  TOOL_TIMEOUT_MIN_MINUTES,
} from '../../../utils/channels';
import { settingsFormKey, type SettingsFormApi } from '../composables/use-settings-form';

const form = inject(settingsFormKey) as SettingsFormApi;

/** 顶层绑定在模板中自动解包 ref，模板可直接 draft.retryCount 双向绑定 */
const draft = form.settingsDraft;

// 默认智能体下拉（按分类分组，与聊天输入框选择器同一套分组与排序规则；
// 分类显示名经 i18n 解析，自定义分类原样展示 id）。
// 引擎内部表非响应式：注册表变更（本上下文 / hub 跨上下文同步）经版本号驱动重算。
const { displayNameOf } = useAgentDisplay();
const agentsVersion = ref(0);
const unsubscribeAgents = agentEngine.onChange(() => {
  agentsVersion.value++;
});
onUnmounted(unsubscribeAgents);

const agentGroups = computed(() => {
  void agentsVersion.value;
  return agentEngine.listGroupedByCategory().map(group => ({
    ...group,
    label: group.labelKey ? t(group.labelKey as MessageKey) : group.categoryId,
  }));
});

/** 草稿指向的默认智能体已被删除（下拉无法映射到现有条目时原样展示 id） */
const defaultAgentMissing = computed(
  () =>
    !!draft.value.defaultAgentId &&
    !agentGroups.value.some(group =>
      group.agents.some(agent => agent.id === draft.value.defaultAgentId),
    ),
);
</script>