<template>
  <div class="system-settings">
    <div class="setting-group">
      <h3>{{ t('sidepanel.settings.appearanceTitle') }}</h3>

      <div class="setting-item">
        <label>{{ t('sidepanel.settings.fontFamily') }}</label>
        <select v-model="systemSettings.fontFamily" class="setting-select">
          <option value="'Noto Serif SC'">Noto Serif SC</option>
          <option value="'Microsoft YaHei'">{{ t('sidepanel.settings.fontMicrosoftYaHei') }}</option>
          <option value="'PingFang SC'">{{ t('sidepanel.settings.fontPingFang') }}</option>
          <option value="'Helvetica Neue'">Helvetica Neue</option>
          <option value="'Arial'">Arial</option>
        </select>
      </div>

      <div class="setting-item">
        <label>{{ t('sidepanel.settings.fontSize') }}</label>
        <div class="font-size-control">
          <input
            type="range"
            v-model="systemSettings.fontSize"
            min="12"
            max="20"
            step="1"
            class="font-size-slider"
          >
          <span class="font-size-value">{{ systemSettings.fontSize }}px</span>
        </div>
      </div>
    </div>

    <div class="setting-group">
      <h3>{{ t('common.language') }}</h3>

      <div class="setting-item">
        <label>{{ t('common.languageLabel') }}</label>
        <select class="setting-select" :value="locale" @change="onLocaleChange">
          <option v-for="option in localeOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </div>

      <p class="setting-hint">{{ t('common.languageHint') }}</p>
    </div>

    <div class="setting-group">
      <h3>{{ t('sidepanel.settings.functionTitle') }}</h3>

      <div class="setting-item">
        <div class="setting-label-with-help">
          <label>{{ t('sidepanel.settings.promptRouting') }}</label>
          <div class="help-icon" @mouseenter="showTooltip($event, 'prompt')" @mouseleave="hideTooltip('prompt')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <path d="M9,9a3,3 0 0,1 6,0c0,2 -3,3 -3,3"></path>
              <path d="M12,17h.01"></path>
            </svg>
            <div v-if="showPromptHelp" class="help-tooltip" :style="{ left: tooltipPosition.x + 'px', top: tooltipPosition.y + 'px', transform: 'translateX(-50%)' }">
              {{ t('sidepanel.settings.promptRoutingDesc') }}
            </div>
          </div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" v-model="systemSettings.enablePromptRouting">
          <span class="toggle-slider"></span>
        </label>
      </div>

      <div class="setting-item">
        <div class="setting-label-with-help">
          <label>{{ t('sidepanel.settings.modelRouting') }}</label>
          <div class="help-icon" @mouseenter="showTooltip($event, 'model')" @mouseleave="hideTooltip('model')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <path d="M9,9a3,3 0 0,1 6,0c0,2 -3,3 -3,3"></path>
              <path d="M12,17h.01"></path>
            </svg>
            <div v-if="showModelHelp" class="help-tooltip" :style="{ left: tooltipPosition.x + 'px', top: tooltipPosition.y + 'px', transform: 'translateX(-50%)' }">
              {{ t('sidepanel.settings.modelRoutingDesc') }}
            </div>
          </div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" v-model="systemSettings.enableModelRouting">
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <div class="form-actions">
      <button class="save-btn" @click="saveSystemSettings">{{ t('common.saveSettings') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 系统设置分区（外观字体 / 语言 / 功能开关）
 * 迁移自原独立 SettingsModal 的 system 标签页；当前导航隐藏（历史功能保留）。
 * 原底部统一保存已随旧壳移除，此处提供分区内保存按钮（localStorage + 引擎镜像 + 字体即时应用）。
 */
import { inject, reactive, ref, watch } from 'vue';
import { t, useLocale, LOCALE_OPTIONS } from '@/utils/i18n';
import { syncExternalStores } from '../../../utils/config/engine';
import { settingsModalContextKey, type SettingsModalContext } from '../composables/use-settings-form';

const { openEpoch } = inject(settingsModalContextKey) as SettingsModalContext;

// 语言切换（core 单一事实源，切换后立即持久化并同步到所有扩展页面）
const { locale, switchLocale } = useLocale();
const localeOptions = LOCALE_OPTIONS;
const onLocaleChange = (event: Event) => {
  switchLocale((event.target as HTMLSelectElement).value as (typeof localeOptions)[number]['value']);
};

// 系统设置
const systemSettings = reactive({
  fontFamily: "'Noto Serif SC'",
  fontSize: 14,
  enablePromptRouting: false,
  enableModelRouting: false
});

// 帮助提示相关状态
const showPromptHelp = ref(false);
const showModelHelp = ref(false);
const tooltipPosition = ref({ x: 0, y: 0 });

const applyFontSettings = () => {
  const root = document.documentElement;
  root.style.setProperty('--app-font-family', systemSettings.fontFamily);
  root.style.setProperty('--app-font-size', `${systemSettings.fontSize}px`);
};

const loadSettings = () => {
  // 加载系统设置
  const savedSystemSettings = localStorage.getItem('systemSettings');
  if (savedSystemSettings) {
    Object.assign(systemSettings, JSON.parse(savedSystemSettings));
  }

  // 应用字体设置
  applyFontSettings();
};

/** 保存系统设置（localStorage + 持久化引擎镜像 + 字体即时应用） */
const saveSystemSettings = () => {
  localStorage.setItem('systemSettings', JSON.stringify(systemSettings));
  // 同步镜像进持久化引擎（localStorage 会被「清除浏览数据」抹掉）
  void syncExternalStores();
  applyFontSettings();
};

// 帮助提示相关函数
const showTooltip = (event: MouseEvent, type: string) => {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  tooltipPosition.value = {
    x: rect.left + rect.width / 2,
    y: rect.top - 40  // 增加距离，确保tooltip在问号上方而不覆盖
  }

  if (type === 'prompt') {
    showPromptHelp.value = true
  } else if (type === 'model') {
    showModelHelp.value = true
  }
};

const hideTooltip = (type: string) => {
  if (type === 'prompt') {
    showPromptHelp.value = false
  } else if (type === 'model') {
    showModelHelp.value = false
  }
};

// 弹窗每次打开时重新加载
watch(openEpoch, loadSettings, { immediate: true })
</script>

<style scoped>
.system-settings {
  max-height: 500px;
  overflow-y: auto;
}

.setting-group {
  margin-bottom: 32px;
}

.setting-group h3 {
  margin: 0 0 20px 0;
  font-size: 18px;
  font-weight: 600;
  color: #1f2937;
}

.setting-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 0;
  border-bottom: 1px solid #f3f4f6;
}

.setting-item:last-child {
  border-bottom: none;
}

.setting-item label {
  font-size: 14px;
  font-weight: 500;
  color: #374151;
}

.setting-label-with-help {
  display: flex;
  align-items: center;
  gap: 8px;
}

.help-icon {
  position: relative;
  color: #9ca3af;
  cursor: help;
}

.help-tooltip {
  position: fixed;
  bottom: auto;
  top: auto;
  left: auto;
  right: auto;
  transform: none;
  background: #1f2937;
  color: white;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
  white-space: nowrap;
  z-index: 9999;
  margin-bottom: 4px;
  pointer-events: none;
}

.help-tooltip::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 4px solid transparent;
  border-top-color: #1f2937;
}

.setting-select, .setting-input {
  padding: 8px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 14px;
  min-width: 200px;
  position: relative;
  z-index: 1;
}

.setting-select:focus, .setting-input:focus {
  outline: none;
  border-color: #667eea;
}

.setting-hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--text-tertiary, #9ca3af);
}

.font-size-control {
  display: flex;
  align-items: center;
  gap: 12px;
}

.font-size-slider {
  width: 150px;
}

.font-size-value {
  font-size: 14px;
  font-weight: 500;
  color: #374151;
  min-width: 40px;
}

.toggle-switch {
  position: relative;
  display: inline-block;
  width: 48px;
  height: 24px;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: #d1d5db;
  transition: 0.3s;
  border-radius: 24px;
}

.toggle-slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background-color: white;
  transition: 0.3s;
  border-radius: 50%;
}

input:checked + .toggle-slider {
  background-color: #667eea;
}

input:checked + .toggle-slider:before {
  transform: translateX(24px);
}

.form-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 32px;
}

.save-btn {
  padding: 10px 20px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.save-btn:hover {
  transform: translateY(-1px);
}

.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}
</style>
