<template>
  <div class="channels-layout">
    <!-- ==================== 左：渠道列表 ==================== -->
    <div class="channel-list-pane">
      <div class="channel-list-header">
        <span class="channel-list-title">{{ t('sidepanel.channels.paneTitle') }}</span>
        <button type="button" class="config-fetch-btn" @click="showAddChannel = !showAddChannel">
          + {{ t('sidepanel.channels.addChannel') }}
        </button>
      </div>

      <!-- 新增渠道：协议驱动选择 -->
      <div v-if="showAddChannel" class="provider-selector channel-add-providers">
        <button
          v-for="driver in form.driverList"
          :key="driver.id"
          type="button"
          class="provider-btn"
          :title="t('sidepanel.channels.addWithProtocol', { protocol: driver.meta.label })"
          @click="form.addChannel(driver.id); showAddChannel = false"
        >
          <img :src="driver.meta.icon" :alt="driver.meta.label" class="provider-btn-icon" />
          <span class="provider-btn-label">{{ driver.meta.label }}</span>
        </button>
      </div>

      <div class="channel-cards">
        <div
          v-for="item in channels"
          :key="item.id"
          class="channel-card"
          :class="{
            active: item.id === form.selectedChannelId.value,
            'channel-card-disabled': !item.enabled,
          }"
          @click="form.selectChannel(item.id)"
        >
          <img
            class="channel-card-icon"
            :src="driverIconOf(item.protocol)"
            :alt="driverLabelOf(item.protocol)"
          />
          <div class="channel-card-main">
            <span class="channel-card-name">{{ item.name || driverLabelOf(item.protocol) }}</span>
            <span class="channel-card-meta">
              {{ driverLabelOf(item.protocol) }} · {{ t('sidepanel.channels.modelsCount', { count: item.models.length }) }}
            </span>
          </div>
          <!-- 启停开关（点击不进入编辑） -->
          <button
            type="button"
            class="channel-card-toggle"
            :class="{ on: item.enabled }"
            :title="item.enabled ? t('sidepanel.channels.enabled') : t('sidepanel.channels.disabled')"
            @click.stop="form.toggleChannelEnabled(item.id)"
          >
            {{ item.enabled ? t('sidepanel.channels.enabled') : t('sidepanel.channels.disabled') }}
          </button>
          <button
            type="button"
            class="config-model-action-btn config-model-remove-btn"
            :title="t('sidepanel.channels.removeChannelTitle')"
            @click.stop="form.removeChannel(item.id)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
            </svg>
          </button>
        </div>

        <p v-if="!channels.length" class="config-form-hint channel-empty-hint">
          {{ t('sidepanel.channels.emptyHint') }}
        </p>
      </div>
    </div>

    <!-- ==================== 右：选中渠道编辑器 ==================== -->
    <div class="channel-editor-pane">
      <template v-if="channel">
        <!-- 渠道名 -->
        <div class="config-form-group">
          <label class="config-form-label">{{ t('sidepanel.channels.channelName') }}</label>
          <input
            type="text"
            class="config-form-input"
            :placeholder="t('sidepanel.channels.channelNamePlaceholder')"
            v-model="channel.name"
          />
        </div>

        <!-- 协议驱动选择 -->
        <div class="config-form-group">
          <label class="config-form-label">{{ t('sidepanel.apiConfig.protocol') }}</label>
          <div class="provider-selector">
            <button
              v-for="driver in form.driverList"
              :key="driver.id"
              type="button"
              class="provider-btn"
              :class="{ active: channel.protocol === driver.id }"
              @click="form.selectProtocol(driver.id)"
            >
              <img :src="driver.meta.icon" :alt="driver.meta.label" class="provider-btn-icon" />
              <span class="provider-btn-label">{{ driver.meta.label }}</span>
            </button>
          </div>
        </div>

        <!-- API 地址 -->
        <div class="config-form-group">
          <label class="config-form-label">{{ t('sidepanel.apiConfig.serviceUrl') }}</label>
          <input
            type="url"
            class="config-form-input"
            :placeholder="activeMeta ? t(activeMeta.urlPlaceholder) : ''"
            v-model="channel.baseUrl"
          />
          <div v-if="form.actualRequestUrl.value" class="config-actual-url" :title="form.actualRequestUrl.value">
            <span class="config-actual-url-label">{{ t('sidepanel.apiConfig.actualUrl') }}</span>
            <code class="config-actual-url-value">{{ form.actualRequestUrl.value }}</code>
          </div>
          <p class="config-form-hint">
            {{ t('sidepanel.apiConfig.examplePrefix') }}{{ activeMeta?.urlExample ?? '' }}
          </p>
        </div>

        <!-- API 密钥 -->
        <div class="config-form-group">
          <label class="config-form-label">
            {{ t('sidepanel.apiConfig.apiKey') }}
            <span v-if="!form.channelRequiresApiKey.value" class="config-label-optional">{{ t('sidepanel.apiConfig.optionalLocalModel') }}</span>
          </label>
          <div class="config-input-wrapper config-input-wrapper-key">
            <input
              :type="form.showApiKey.value ? 'text' : 'password'"
              class="config-form-input"
              :placeholder="t('sidepanel.apiConfig.apiKeyPlaceholder')"
              v-model="channel.apiKey"
            />
            <button
              type="button"
              class="config-input-toggle"
              @click="form.showApiKey.value = !form.showApiKey.value"
              :title="form.showApiKey.value ? t('sidepanel.apiConfig.hide') : t('sidepanel.apiConfig.show')"
            >
              <svg v-if="!form.showApiKey.value" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17M12,4.5C7,4.5 2.73,7.61 1,12C2.73,16.39 7,19.5 12,19.5C17,19.5 21.27,16.39 23,12C21.27,7.61 17,4.5 12,4.5Z" fill="currentColor"/>
              </svg>
              <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M11.83,9L15,12.16C15,12.11 15,12.05 15,12A3,3 0 0,0 12,9C11.94,9 11.89,9 11.83,9M7.53,9.8L9.08,11.35C9.03,11.56 9,11.77 9,12A3,3 0 0,0 12,15C12.22,15 12.44,14.97 12.65,14.92L14.2,16.47C13.53,16.8 12.79,17 12,17A5,5 0 0,1 7,12C7,11.21 7.2,10.47 7.53,9.8M2,4.27L4.28,6.55L4.73,7C3.08,8.3 1.78,10 1,12C2.73,16.39 7,19.5 12,19.5C13.55,19.5 15.03,19.2 16.38,18.66L16.81,19.09L19.73,22L21,20.73L3.27,3M12,7A5,5 0 0,1 17,12C17,12.64 16.87,13.26 16.64,13.82L19.57,16.75C21.07,15.5 22.27,13.86 23,12C21.27,7.61 17,4.5 12,4.5C10.6,4.5 9.26,4.75 8,5.2L10.17,7.35C10.74,7.13 11.35,7 12,7Z" fill="currentColor"/>
              </svg>
            </button>
          </div>
        </div>

        <!-- 重试与采样是全局参数（高级设置分区统一配置），渠道编辑器不再单独设置 -->

        <!-- 模型列表 -->
        <div class="config-form-group">
          <div class="config-label-row">
            <label class="config-form-label config-label-flush">{{ t('sidepanel.apiConfig.modelName') }}</label>
            <button
              type="button"
              class="config-fetch-btn"
              :disabled="form.isFetchingModels.value"
              :title="form.fetchBtnTitle.value"
              @click="form.handleFetchModels()"
            >
              <svg v-if="form.isFetchingModels.value" width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="api-config-spin-icon">
                <path d="M12 2C6.48 2 2 6.48 2 12S6.48 22 12 22 22 17.52 22 12 17.52 2 12 2ZM12 20C7.59 20 4 16.41 4 12S7.59 4 12 4 20 7.59 20 12 16.41 20 12 20Z" stroke="currentColor" stroke-width="2" fill="none"/>
              </svg>
              <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 3V13M12 13L16 9M12 13L8 9M4 17V19C4 20.1 4.9 21 6 21H18C19.1 21 20 20.1 20 19V17M12 3V13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <span>{{ form.isFetchingModels.value ? t('sidepanel.apiConfig.fetchingModels') : t('sidepanel.apiConfig.autoFetch') }}</span>
            </button>
          </div>

          <div v-if="channel.models.length" class="config-model-list">
            <div
              v-for="model in channel.models"
              :key="model.id"
              class="config-model-row"
              :class="{ active: isDraftDefault(channel.id, model.id), 'model-row-disabled': !model.enabled }"
            >
              <!-- 默认模型星标 -->
              <button
                type="button"
                class="config-model-star"
                :class="{ starred: isDraftDefault(channel.id, model.id) }"
                :title="t('sidepanel.channels.setDefaultModel')"
                @click="form.setDraftActiveModel({ channelId: channel.id, modelId: model.id })"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12,17.27L18.18,21L16.54,13.97L22,9.24L14.81,8.62L12,2L9.19,8.62L2,9.24L7.45,13.97L5.82,21L12,17.27Z" fill="currentColor"/>
                </svg>
              </button>
              <span class="config-model-row-name" :title="model.name">{{ model.name }}</span>
              <span class="config-model-row-actions" @click.stop>
                <!-- 上下文阈值 -->
                <span class="model-threshold-wrap" :title="t('sidepanel.channels.modelThresholdHint')">
                  <input
                    type="number"
                    class="model-threshold-input"
                    v-model.number="model.contextThreshold"
                    min="8192"
                    max="1048576"
                    step="1024"
                    @click.stop
                  />
                </span>
                <!-- 视觉声明 -->
                <span
                  class="config-model-vision"
                  :title="model.vision ? t('sidepanel.apiConfig.visionOn') : t('sidepanel.apiConfig.visionOff')"
                >
                  <span class="config-model-vision-label">{{ t('sidepanel.apiConfig.visionLabel') }}</span>
                  <label class="config-vision-switch">
                    <input type="checkbox" :checked="model.vision" @change="form.toggleModelVision(model.id)" />
                    <span class="config-vision-switch-slider"></span>
                  </label>
                </span>
                <!-- 启停 -->
                <button
                  type="button"
                  class="config-model-action-btn"
                  :class="{ 'model-enable-off': !model.enabled }"
                  :title="model.enabled ? t('sidepanel.channels.disableModel') : t('sidepanel.channels.enableModel')"
                  @click="form.toggleModelEnabled(model.id)"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path v-if="model.enabled" d="M12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" fill="currentColor"/>
                    <path v-else d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4M12,6A6,6 0 0,0 6,12H8A4,4 0 0,1 12,8V6Z" fill="currentColor"/>
                  </svg>
                </button>
                <!-- 移除 -->
                <button
                  type="button"
                  class="config-model-action-btn config-model-remove-btn"
                  :title="channel.models.length <= 1 ? t('sidepanel.apiConfig.keepOneModel') : t('sidepanel.apiConfig.removeModel')"
                  @click="form.removeModel(model.id)"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
                  </svg>
                </button>
              </span>
            </div>
          </div>

          <p v-if="channel.models.length" class="config-form-hint">{{ t('sidepanel.channels.setDefaultModelHint') }}</p>

          <input
            type="text"
            class="config-form-input"
            :placeholder="form.modelInputPlaceholder.value"
            v-model="form.modelInput.value"
            @keydown.enter.prevent="form.addModel()"
          />
          <p class="config-form-hint">
            {{ t('sidepanel.apiConfig.modelHint', { example: activeMeta?.modelExample ?? '' }) }}
          </p>

          <!-- 可用性测试 -->
          <div class="config-test-row">
            <button
              type="button"
              class="config-test-btn"
              :class="{
                'config-test-btn-success': form.testResult.value?.success === true,
                'config-test-btn-error': form.testResult.value?.success === false,
              }"
              :disabled="form.isTesting.value || !form.canTest.value"
              :title="form.testBtnTitle.value"
              @click="form.openTestPicker()"
            >
              <svg v-if="form.isTesting.value" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="api-config-spin-icon">
                <path d="M12 2C6.48 2 2 6.48 2 12S6.48 22 12 22 22 17.52 22 12 17.52 2 12 2ZM12 20C7.59 20 4 16.41 4 12S7.59 4 12 4 20 7.59 20 12 16.41 20 12 20ZM12 6.5V12L16 14.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>
              </svg>
              <svg v-else-if="form.testResult.value?.success === false" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41Z" fill="currentColor"/>
              </svg>
              <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M13 2L4 14H11L10 22L20 10H13L13 2Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
              </svg>
              <span>{{ form.isTesting.value ? t('sidepanel.apiConfig.testing') : t('sidepanel.apiConfig.testAvailable') }}</span>
            </button>
            <span class="config-test-hint">{{ t('sidepanel.apiConfig.testHint') }}</span>
          </div>

          <!-- 测试结果详情 -->
          <div v-if="form.testResult.value && !form.testResult.value.success && form.testResult.value.detail" class="config-test-result config-test-result-error">
            <p class="config-error-item">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink: 0;">
                <path d="M13,13H11V7H13M13,17H11V15H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" fill="#ef4444"/>
              </svg>
              {{ form.testResult.value.message }}
            </p>
            <pre v-if="form.testResult.value.detail" class="config-test-detail">{{ form.testResult.value.detail }}</pre>
          </div>
          <div v-else-if="form.testResult.value && form.testResult.value.success" class="config-test-result config-test-result-success">
            <p class="config-test-success-msg">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink: 0;">
                <path d="M9 16.17L4.83 12L3.41 13.41L9 19L21 7L19.59 5.59L9 16.17Z" fill="#22c55e"/>
              </svg>
              {{ form.testResult.value.message }}
            </p>
          </div>
        </div>
      </template>

      <!-- 空态：无渠道 -->
      <div v-else class="channel-editor-empty">
        <p class="config-form-hint">{{ t('sidepanel.channels.selectChannelHint') }}</p>
      </div>

      <!-- 校验错误由壳（SettingsModal）在分区容器顶部统一渲染：
           保存同时校验渠道与应用设置，只挂在渠道分区会漏掉另一侧的错误 -->
    </div>

    <!-- ==================== 子弹窗：自动获取模型 — 多选 ==================== -->
    <div v-if="form.showModelPicker.value" class="api-sub-overlay" @click.self="form.showModelPicker.value = false">
      <div class="api-sub-modal">
        <h4 class="api-sub-title">
          {{ t('sidepanel.apiConfig.pickModelsTitle') }}
          <span class="api-sub-title-extra">{{ t('sidepanel.apiConfig.pickedCount', { count: form.fetchedModels.value.length }) }}</span>
        </h4>
        <div class="api-sub-toolbar">
          <input
            type="text"
            class="config-form-input api-sub-search"
            :placeholder="t('sidepanel.apiConfig.searchModelPlaceholder')"
            v-model="form.modelSearch.value"
          />
          <button type="button" class="api-sub-tool-btn" @click="form.toggleSelectAll()">
            {{ form.allFetchedSelected.value ? t('sidepanel.apiConfig.deselectAll') : t('sidepanel.apiConfig.selectAll') }}
          </button>
        </div>
        <div class="api-sub-body">
          <label
            v-for="name in form.filteredFetchedModels.value"
            :key="name"
            class="api-sub-option"
            :class="{ checked: form.selectedFetchedModels.value.includes(name) }"
          >
            <input type="checkbox" :value="name" v-model="form.selectedFetchedModels.value" />
            <span class="api-sub-option-name">{{ name }}</span>
            <span v-if="channel?.models.some(model => model.name === name)" class="api-sub-badge">{{ t('sidepanel.apiConfig.configured') }}</span>
          </label>
          <p v-if="!form.filteredFetchedModels.value.length" class="api-sub-empty">{{ t('sidepanel.apiConfig.noMatchedModels') }}</p>
        </div>
        <div class="api-sub-footer">
          <button type="button" class="api-config-btn api-config-btn-secondary api-sub-btn" @click="form.showModelPicker.value = false">{{ t('common.cancel') }}</button>
          <button
            type="button"
            class="api-config-btn api-config-btn-primary api-sub-btn"
            :disabled="form.selectedFetchedModels.value.length === 0"
            @click="form.confirmFetchedModels()"
          >
            {{ t('sidepanel.apiConfig.confirmCount', { count: form.selectedFetchedModels.value.length }) }}
          </button>
        </div>
      </div>
    </div>

    <!-- ==================== 子弹窗：测试可用性 — 单选模型 ==================== -->
    <div v-if="form.showTestPicker.value && channel" class="api-sub-overlay" @click.self="form.showTestPicker.value = false">
      <div class="api-sub-modal">
        <h4 class="api-sub-title">{{ t('sidepanel.apiConfig.pickTestModelTitle') }}</h4>
        <div class="api-sub-body">
          <label
            v-for="model in channel.models"
            :key="model.id"
            class="api-sub-option"
            :class="{ checked: form.testModelName.value === model.id }"
          >
            <input type="radio" name="api-test-model" :value="model.id" v-model="form.testModelName.value" />
            <span class="api-sub-option-name">{{ model.name }}</span>
            <span v-if="isDraftDefault(channel.id, model.id)" class="api-sub-badge api-sub-badge-active">{{ t('sidepanel.apiConfig.currentActive') }}</span>
          </label>
        </div>
        <div class="api-sub-footer">
          <button type="button" class="api-config-btn api-config-btn-secondary api-sub-btn" @click="form.showTestPicker.value = false">{{ t('common.cancel') }}</button>
          <button type="button" class="api-config-btn api-config-btn-primary api-sub-btn" :disabled="!form.testModelName.value" @click="form.confirmTestModel()">{{ t('sidepanel.apiConfig.confirmAndTest') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 渠道与模型分区：
 *   左列 = 渠道列表（新增/启停/删除/选择），右列 = 选中渠道编辑器
 *   （协议驱动 / 地址 / 密钥 / 重试采样参数 / 模型列表 + 拉取 + 连通性测试）。
 * 表单状态由壳提供的共享 composable 持有（与高级参数分区、底部保存同源）。
 */
import { computed, inject, ref } from 'vue';
import { t } from '@/utils/i18n';
import { driverRegistry } from '../../../utils/stream/driver-registry';
import { modelRefKey } from '../../../utils/channels';
import type { ProviderType } from '../../../utils/stream/types';
import { settingsFormKey, type SettingsFormApi } from '../composables/use-settings-form';

const form = inject(settingsFormKey) as SettingsFormApi;

/** 顶层绑定在模板中自动解包 ref/computed，模板可直接 channel.name 双向绑定 */
const channel = form.selectedChannel;
const channels = form.channels;
const activeMeta = form.activeMeta;

/** 是否为草稿中的默认模型（星标） */
const isDraftDefault = (channelId: string, modelId: string): boolean =>
  form.draftActiveModelKey.value === modelRefKey({ channelId, modelId });

/** 协议图标（渠道卡片；协议未注册时回退扩展默认图标） */
const driverIconOf = (protocol: ProviderType): string => {
  const icon = driverRegistry.tryGet(protocol)?.meta.icon;
  return icon ? chrome.runtime.getURL(icon.replace(/^\//, '')) : chrome.runtime.getURL('icon/96.png');
};

/** 协议标签（渠道卡片；协议未注册时原文展示） */
const driverLabelOf = (protocol: ProviderType): string =>
  driverRegistry.tryGet(protocol)?.meta.label ?? String(protocol);

/** 新增渠道面板开关 */
const showAddChannel = ref(false);
</script>