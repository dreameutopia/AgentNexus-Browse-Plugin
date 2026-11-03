<template>
  <div>
    <!-- 标题与状态 -->
    <div class="asr-section-header">
      <div class="asr-section-title">
        <h4>{{ t('sidepanel.asr.title') }}</h4>
        <span class="asr-status-badge" :class="asrFormReady ? 'ok' : 'warn'">
          {{ asrFormReady ? t('sidepanel.asr.configuredBadge') : t('sidepanel.asr.notConfiguredBadge') }}
        </span>
      </div>
      <p class="config-form-hint">{{ t('sidepanel.asr.subtitle') }}</p>
    </div>

    <!-- 供应商选择 -->
    <div class="config-form-group">
      <label class="config-form-label">{{ t('sidepanel.asr.providerSectionTitle') }}</label>
      <div class="asr-provider-grid">
        <button
          v-for="meta in asrProviderList"
          :key="meta.value"
          type="button"
          class="asr-provider-card"
          :class="{ active: asrForm.provider === meta.value }"
          @click="selectAsrProvider(meta.value)"
        >
          <span class="asr-provider-name">{{ meta.label }}</span>
        </button>
      </div>
      <p class="config-form-hint">{{ t(asrProviderMeta.hintKey) }}</p>
    </div>

    <!-- 接口基础地址 -->
    <div class="config-form-group">
      <label class="config-form-label">{{ t('sidepanel.asr.serviceUrl') }}</label>
      <input
        type="url"
        class="config-form-input"
        :placeholder="asrProviderMeta.baseUrl || 'https://your-service.com/v1'"
        v-model="asrForm.baseUrl"
        @blur="asrForm.baseUrl = asrForm.baseUrl.trim()"
      />
      <div v-if="asrActualEndpoint" class="config-actual-url" :title="asrActualEndpoint">
        <span class="config-actual-url-label">{{ t('sidepanel.asr.actualEndpoint') }}</span>
        <code class="config-actual-url-value">{{ asrActualEndpoint }}</code>
      </div>
      <p class="config-form-hint">{{ t('sidepanel.asr.serviceUrlHint') }}</p>
    </div>

    <!-- API 密钥 -->
    <div class="config-form-group">
      <label class="config-form-label">{{ t('sidepanel.asr.apiKey') }}</label>
      <div class="config-input-wrapper config-input-wrapper-key">
        <input
          :type="asrShowKey ? 'text' : 'password'"
          class="config-form-input"
          :placeholder="t('sidepanel.asr.apiKeyPlaceholder')"
          v-model="asrForm.apiKey"
        />
        <button class="config-input-toggle" @click="asrShowKey = !asrShowKey" :title="asrShowKey ? t('sidepanel.apiConfig.hide') : t('sidepanel.apiConfig.show')">
          <svg v-if="!asrShowKey" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17M12,4.5C7,4.5 2.73,7.61 1,12C2.73,16.39 7,19.5 12,19.5C17,19.5 21.27,16.39 23,12C21.27,7.61 17,4.5 12,4.5Z" fill="currentColor"/>
          </svg>
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M11.83,9L15,12.16C15,12.11 15,12.05 15,12A3,3 0 0,0 12,9C11.94,9 11.89,9 11.83,9M7.53,9.8L9.08,11.35C9.03,11.56 9,11.77 9,12A3,3 0 0,0 12,15C12.22,15 12.44,14.97 12.65,14.92L14.2,16.47C13.53,16.8 12.79,17 12,17A5,5 0 0,1 7,12C7,11.21 7.2,10.47 7.53,9.8M2,4.27L4.28,6.55L4.73,7C3.08,8.3 1.78,10 1,12C2.73,16.39 7,19.5 12,19.5C13.55,19.5 15.03,19.2 16.38,18.66L16.81,19.09L19.73,22L21,20.73L3.27,3M12,7A5,5 0 0,1 17,12C17,12.64 16.87,13.26 16.64,13.82L19.57,16.75C21.07,15.5 22.27,13.86 23,12C21.27,7.61 17,4.5 12,4.5C10.6,4.5 9.26,4.75 8,5.2L10.17,7.35C10.74,7.13 11.35,7 12,7Z" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- 识别模型 -->
    <div class="config-form-group">
      <label class="config-form-label">{{ t('sidepanel.asr.modelLabel') }}</label>
      <div v-if="asrRecommendedModels.length" class="config-model-chips">
        <span
          v-for="name in asrRecommendedModels"
          :key="name"
          class="config-model-chip"
          :class="{ active: name === asrForm.model }"
          :title="t('sidepanel.asr.recommendModels')"
          @click="asrForm.model = name"
        >
          <svg v-if="name === asrForm.model" width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="config-model-chip-check">
            <path d="M9 16.17L4.83 12L3.41 13.41L9 19L21 7L19.59 5.59L9 16.17Z" fill="currentColor"/>
          </svg>
          <span class="config-model-chip-name">{{ name }}</span>
        </span>
      </div>
      <input
        type="text"
        class="config-form-input"
        :placeholder="t('sidepanel.asr.modelPlaceholder')"
        v-model="asrForm.model"
        @blur="asrForm.model = asrForm.model.trim()"
      />
      <p class="config-form-hint">{{ t('sidepanel.asr.recommendModels') }}</p>
    </div>

    <!-- 校验错误（ASR） -->
    <div v-if="asrValidationErrors.length" class="config-validation-errors">
      <p v-for="(error, index) in asrValidationErrors" :key="index" class="config-error-item">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink: 0;">
          <path d="M13,13H11V7H13M13,17H11V15H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" fill="#ef4444"/>
        </svg>
        {{ error }}
      </p>
    </div>

    <!-- 保存（独立于模型服务的保存按钮） -->
    <button
      type="button"
      class="api-config-btn api-config-btn-primary asr-save-btn"
      :class="{ 'asr-save-btn-done': asrJustSaved }"
      @click="handleAsrSave"
    >
      <svg v-if="!asrJustSaved" width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M17 3H5C3.89 3 3 3.9 3 5V19C3 20.1 3.89 21 5 21H19C20.1 21 21 20.1 21 19V7L17 3M19 19H5V5H16.17L19 7.83V19M12 12C10.34 12 9 13.34 9 15S10.34 18 12 18 15 16.66 15 15 13.66 12 12 12M6 6H15V10H6V6Z" fill="currentColor"/>
      </svg>
      <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9 16.17L4.83 12L3.41 13.41L9 19L21 7L19.59 5.59L9 16.17Z" fill="currentColor"/>
      </svg>
      {{ asrJustSaved ? t('sidepanel.asr.saveSuccess') : t('sidepanel.asr.saveBtn') }}
    </button>

    <!-- 支持的供应商与 API 调用文档 -->
    <div class="asr-docs">
      <h4 class="asr-docs-title">{{ t('sidepanel.asr.docsTitle') }}</h4>
      <p class="config-form-hint">{{ t('sidepanel.asr.docsHint') }}</p>
      <div
        v-for="meta in asrDocProviders"
        :key="meta.value"
        class="asr-doc-card"
        :class="{ unsupported: !meta.supported }"
      >
        <div class="asr-doc-head">
          <span class="asr-doc-name">{{ meta.label }}</span>
          <span v-if="!meta.supported" class="asr-soon-badge">{{ t('sidepanel.asr.comingSoon') }}</span>
          <a
            v-if="meta.docsUrl"
            class="asr-doc-link"
            :href="meta.docsUrl"
            target="_blank"
            rel="noopener noreferrer"
          >{{ t('sidepanel.asr.openDocs') }} ↗</a>
        </div>
        <dl class="asr-doc-body">
          <div class="asr-doc-row">
            <dt>{{ t('sidepanel.asr.docMethod') }}</dt>
            <dd><code>POST</code></dd>
          </div>
          <div class="asr-doc-row">
            <dt>{{ t('sidepanel.asr.docEndpoint') }}</dt>
            <dd><code>{{ asrDocEndpointOf(meta) }}</code></dd>
          </div>
          <div class="asr-doc-row">
            <dt>{{ t('sidepanel.asr.docAuth') }}</dt>
            <dd><code>Authorization: Bearer &lt;API Key&gt;</code></dd>
          </div>
          <div class="asr-doc-row">
            <dt>{{ t('sidepanel.asr.docBody') }}</dt>
            <dd>
              <code>{{ t('sidepanel.asr.docFileParam') }}</code>
              <code>{{ t('sidepanel.asr.docModelParam') }}</code>
            </dd>
          </div>
          <div class="asr-doc-row">
            <dt>{{ t('sidepanel.asr.docResponse') }}</dt>
            <dd><code>{{ t('sidepanel.asr.docResponseDesc') }}</code></dd>
          </div>
          <div v-if="meta.models.length" class="asr-doc-row">
            <dt>{{ t('sidepanel.asr.docModels') }}</dt>
            <dd class="asr-doc-models">
              <code v-for="name in meta.models" :key="name">{{ name }}</code>
            </dd>
          </div>
        </dl>
        <p class="config-form-hint">{{ t(meta.hintKey) }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 语音识别（ASR）分区：全插件统一语音转文字引擎配置
 * （输入框语音按钮与语音助手共用此配置，独立于模型服务保存）。
 * 弹窗每次打开（openEpoch 自增）时从持久化配置重新水合。
 */
import { computed, inject, onUnmounted, reactive, ref, watch } from 'vue';
import { t } from '@/utils/i18n';
import {
  AsrConfigManager,
  SUPPORTED_ASR_PROVIDERS,
  defaultBaseUrlOf,
  recommendModelsOf,
  resolveTranscriptionEndpoint,
  type AsrProvider,
  type AsrProviderId,
  type AsrProviderMeta,
} from '../../../utils/api/user-asr-config';
import { settingsModalContextKey, type SettingsModalContext } from '../composables/use-settings-form';

const { openEpoch } = inject(settingsModalContextKey) as SettingsModalContext;

// ==================== ASR 表单状态 ====================

const asrForm = reactive({
  provider: 'siliconflow' as AsrProvider,
  baseUrl: '',
  apiKey: '',
  model: '',
});
const asrShowKey = ref(false);
const asrValidationErrors = ref<string[]>([]);
/** 刚保存成功的瞬时标记（按钮短暂显示已保存） */
const asrJustSaved = ref(false);
let asrSavedTimer: ReturnType<typeof setTimeout> | null = null;

/** 可选供应商（仅 supported 项可配置） */
const asrProviderList = AsrConfigManager.getProviderList();
/** 文档列表（含暂不支持的 DashScope，仅展示） */
const asrDocProviders: readonly AsrProviderMeta[] = SUPPORTED_ASR_PROVIDERS;

/** 当前选中供应商的元数据 */
const asrProviderMeta = computed(
  () => asrProviderList.find(meta => meta.value === asrForm.provider) ?? asrProviderList[0]
);

/** 当前供应商推荐模型（点击快速填入） */
const asrRecommendedModels = computed(() => recommendModelsOf(asrForm.provider));

/** 拼接后的实际转写端点（与 voice-to-text 真实请求同一函数，杜绝两套拼接逻辑漂移） */
const asrActualEndpoint = computed(() =>
  asrForm.baseUrl.trim() ? resolveTranscriptionEndpoint(asrForm.baseUrl) : ''
);

/** 表单三要素齐备即视为已配置（徽标实时反映表单状态） */
const asrFormReady = computed(
  () => !!(asrForm.baseUrl.trim() && asrForm.apiKey.trim() && asrForm.model.trim())
);

/** 文档卡片端点示例：有默认 baseUrl 的供应商直接拼完整端点，custom/dashscope 展示占位说明 */
function asrDocEndpointOf(meta: AsrProviderMeta): string {
  if (!meta.supported) return 'POST /api/v1/services/audio/asr/transcription + GET 轮询（非 OpenAI 兼容）';
  if (!meta.baseUrl) return '{你的基础地址}/audio/transcriptions';
  return resolveTranscriptionEndpoint(meta.baseUrl);
}

/** 切换 ASR 供应商：自动填入默认地址，模型为空时预填首个推荐模型 */
function selectAsrProvider(provider: AsrProviderId) {
  const meta = SUPPORTED_ASR_PROVIDERS.find(item => item.value === provider);
  // 仅允许切换到已支持的供应商（列表本身已过滤，双重防护）
  if (!meta || !meta.supported) return;
  asrForm.provider = provider as AsrProvider;
  const defaultBaseUrl = defaultBaseUrlOf(asrForm.provider);
  if (defaultBaseUrl) {
    asrForm.baseUrl = defaultBaseUrl;
  }
  if (!asrForm.model) {
    asrForm.model = recommendModelsOf(asrForm.provider)[0] ?? '';
  }
  asrValidationErrors.value = [];
}

/** 保存 ASR 配置（校验 → AsrConfigManager 持久化，输入框语音/语音助手共用此配置） */
async function handleAsrSave() {
  const { valid, errors } = AsrConfigManager.validate({ ...asrForm });
  asrValidationErrors.value = valid ? [] : errors;
  if (!valid) return;

  try {
    await AsrConfigManager.save({
      provider: asrForm.provider,
      baseUrl: asrForm.baseUrl.trim(),
      apiKey: asrForm.apiKey,
      model: asrForm.model.trim(),
    });
    asrJustSaved.value = true;
    if (asrSavedTimer) clearTimeout(asrSavedTimer);
    asrSavedTimer = setTimeout(() => {
      asrJustSaved.value = false;
    }, 2000);
  } catch (error) {
    console.error('[SettingsModal] ASR 配置保存失败:', error);
    asrValidationErrors.value = [t('sidepanel.apiConfig.saveFailed')];
  }
}

/** 从持久化配置水合 ASR 表单 */
function applyAsrConfig(config: Awaited<ReturnType<typeof AsrConfigManager.load>>) {
  asrForm.provider = config.provider;
  asrForm.baseUrl = config.baseUrl || defaultBaseUrlOf(config.provider);
  asrForm.apiKey = config.apiKey || '';
  asrForm.model = config.model || '';
  asrValidationErrors.value = [];
  asrJustSaved.value = false;
}

// 弹窗每次打开时重新水合（openEpoch 由壳在打开时自增）
watch(
  openEpoch,
  () => {
    void AsrConfigManager.load().then(applyAsrConfig);
  },
  { immediate: true }
);

onUnmounted(() => {
  if (asrSavedTimer) clearTimeout(asrSavedTimer);
});
</script>
