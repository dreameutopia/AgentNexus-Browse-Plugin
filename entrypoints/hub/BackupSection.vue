<template>
  <div>
    <p class="config-form-hint">{{ t('sidepanel.backup.desc') }}</p>

    <label class="config-backup-secrets">
      <input type="checkbox" v-model="includeSecrets" />
      <span>{{ t('sidepanel.backup.includeSecrets') }}</span>
    </label>
    <p class="config-form-hint">{{ t('sidepanel.backup.includeSecretsHint') }}</p>

    <div class="config-backup-actions">
      <button
        type="button"
        class="config-test-btn"
        :disabled="isExporting"
        :title="t('sidepanel.backup.exportBtn')"
        @click="handleExportBackup"
      >
        <span>{{ isExporting ? t('sidepanel.backup.exporting') : t('sidepanel.backup.exportBtn') }}</span>
      </button>
      <button
        type="button"
        class="config-test-btn"
        :title="t('sidepanel.backup.importBtn')"
        @click="triggerImportPicker"
      >
        <span>{{ t('sidepanel.backup.importBtn') }}</span>
      </button>
    </div>

    <p v-if="backupMessage" class="config-backup-message">{{ backupMessage }}</p>
    <p class="config-form-hint">{{ storageHealthText }}</p>

    <input ref="importFileInput" type="file" accept=".json,application/json" class="config-backup-file" @change="handleImportFile" />

    <!-- 子弹窗：导入备份预览 -->
    <div v-if="importPreview" class="api-sub-overlay" @click.self="importPreview = null">
      <div class="api-sub-modal">
        <h4 class="api-sub-title">{{ t('sidepanel.backup.importTitle') }}</h4>
        <p class="api-sub-message">
          {{ t('sidepanel.backup.importPreview', { time: importPreview.exportedAt, count: importPreview.count }) }}
        </p>
        <ul class="config-backup-sections">
          <li v-for="id in importPreview.ids" :key="id">{{ id }}</li>
        </ul>
        <div class="api-sub-footer">
          <button type="button" class="api-config-btn api-config-btn-secondary api-sub-btn" @click="importPreview = null">{{ t('common.cancel') }}</button>
          <button type="button" class="api-config-btn api-config-btn-secondary api-sub-btn" @click="confirmImport('fill')">{{ t('sidepanel.backup.strategyFill') }}</button>
          <button type="button" class="api-config-btn api-config-btn-primary api-sub-btn" @click="confirmImport('replace')">{{ t('sidepanel.backup.strategyReplace') }}</button>
        </div>
      </div>
    </div>

    <!-- 子弹窗：错误信息（完整响应内容） -->
    <div v-if="errorDialog" class="api-sub-overlay" @click.self="errorDialog = null">
      <div class="api-sub-modal">
        <h4 class="api-sub-title api-sub-title-error">{{ errorDialog.title }}</h4>
        <p class="api-sub-message">{{ errorDialog.message }}</p>
        <div class="api-sub-footer">
          <button type="button" class="api-config-btn api-config-btn-primary api-sub-btn" @click="errorDialog = null">{{ t('sidepanel.apiConfig.gotIt') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 备份与恢复分区（导出 JSON / 导入预览与策略选择 / 存储健康展示）
 *
 * 迁移自 sidepanel 设置弹窗（modals/sections/BackupSection.vue），状态完全自持：
 *   - 原 inject 的共享表单依赖已移除（errorDialog 本地化渲染、无需水合弹窗表单）
 *   - 导入成功后整页刷新：备份写入覆盖引擎/存储/内存表多个层面，
 *     reload 保障 hub 页（智能体/技能管理器）与引擎全部按权威存储重建，
 *     sidepanel 侧则经 chrome.storage.onChanged 自动回流
 *
 * 表单控件样式与设置弹窗共享同一份 settings-forms.css（视觉对齐）。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { t, type MessageKey } from '@/utils/i18n';
import { getEngine } from '../sidepanel/utils/config/engine';
import {
  applyBackup,
  buildBackup,
  downloadBackup,
  parseBackup,
  serializeBackup,
  type BackupFile,
  type BackupStrategy,
  type ParseFailure,
} from '../sidepanel/utils/config/backup';
import type { EngineHealth } from '../sidepanel/utils/config/types';
// 与设置弹窗共享同一套表单/子弹窗样式（api-sub-* / config-backup-* / config-test-btn 等）
import '../sidepanel/components/modals/settings-forms.css';

const props = defineProps<{
  /** 当前分区是否激活（激活时刷新存储健康状态） */
  active: boolean;
}>();

/** 错误子弹窗（导入解析失败 / 导入写入失败共用） */
const errorDialog = ref<{ title: string; message: string } | null>(null);

const includeSecrets = ref(true);
const isExporting = ref(false);
const backupMessage = ref('');
const importFileInput = ref<HTMLInputElement | null>(null);
const storageHealth = ref<EngineHealth | null>(null);
const importPreview = ref<{
  backup: BackupFile;
  ids: string[];
  count: number;
  exportedAt: string;
} | null>(null);

/** 解析失败码 → 文案（键必须与 ParseFailure 一一对应） */
const PARSE_FAILURE_KEYS: Record<ParseFailure, MessageKey> = {
  'not-json': 'sidepanel.backup.errNotJson',
  'bad-format': 'sidepanel.backup.errFormat',
  'bad-version': 'sidepanel.backup.errVersion',
  'future-version': 'sidepanel.backup.errFutureVersion',
  checksum: 'sidepanel.backup.errChecksum',
  'no-sections': 'sidepanel.backup.errNoSections',
  'invalid-section': 'sidepanel.backup.errInvalidSection',
};

// 存储健康：主副本/镜像/快照是否就绪（有副本恢复或告警时对用户可见）
const storageHealthText = computed(() => {
  const health = storageHealth.value;
  if (!health) return t('sidepanel.backup.healthUnknown');
  return health.healthy
    ? t('sidepanel.backup.healthOk', { count: health.snapshotTotal })
    : t('sidepanel.backup.healthWarn', { count: health.issueCount });
});

// 切到备份分区时刷新存储健康状态
watch(
  () => props.active,
  active => {
    if (active) void refreshStorageHealth();
  }
);

onMounted(() => {
  void refreshStorageHealth();
});

async function refreshStorageHealth(): Promise<void> {
  try {
    const diagnostics = await getEngine().diagnostics();
    storageHealth.value = diagnostics.health;
  } catch (error) {
    console.warn('[Hub] 读取存储诊断失败:', error);
    storageHealth.value = null;
  }
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatExportedAt(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? t('sidepanel.backup.importUnknownTime') : new Date(time).toLocaleString();
}

/** 导出全部配置为 JSON 文件 */
async function handleExportBackup(): Promise<void> {
  if (isExporting.value) return;
  isExporting.value = true;
  backupMessage.value = '';
  try {
    // 先把 localStorage 侧最新状态并入引擎，保证导出内容完整
    await getEngine().syncExternals();
    const backup = await buildBackup({ includeSecrets: includeSecrets.value });
    const count = Object.keys(backup.sections).length;
    if (!count) {
      backupMessage.value = t('sidepanel.backup.exportEmpty');
      return;
    }
    downloadBackup(serializeBackup(backup));
    backupMessage.value = t('sidepanel.backup.exported', { count });
    void refreshStorageHealth();
  } catch (error) {
    backupMessage.value = t('sidepanel.backup.exportFailed', { reason: toErrorText(error) });
  } finally {
    isExporting.value = false;
  }
}

function triggerImportPicker(): void {
  importFileInput.value?.click();
}

/** 读取备份文件 → 解析校验（不写入）→ 弹预览选择导入策略 */
async function handleImportFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // 允许重复选择同一个文件
  if (!file) return;
  backupMessage.value = '';

  let text: string;
  try {
    text = await file.text();
  } catch (error) {
    errorDialog.value = {
      title: t('sidepanel.backup.importTitle'),
      message: t('sidepanel.backup.importFailed', { reason: toErrorText(error) }),
    };
    return;
  }

  const parsed = parseBackup(text);
  if (!parsed.ok) {
    errorDialog.value = {
      title: t('sidepanel.backup.importTitle'),
      message: parsed.errors.map(code => t(PARSE_FAILURE_KEYS[code])).join('\n'),
    };
    return;
  }

  const ids = Object.keys(parsed.backup.sections);
  importPreview.value = {
    backup: parsed.backup,
    ids,
    count: ids.length,
    exportedAt: formatExportedAt(parsed.backup.exportedAt),
  };
}

/** 确认导入：先全量校验再写入，中途失败自动回滚到导入前状态 */
async function confirmImport(strategy: BackupStrategy): Promise<void> {
  const preview = importPreview.value;
  if (!preview) return;
  importPreview.value = null;

  let failure: string | null = null;
  try {
    const report = await applyBackup(preview.backup, strategy);
    if (report.errors.length) {
      const rollbackNote = report.rolledBack ? `${t('sidepanel.backup.importRolledBack')}\n` : '';
      failure =
        rollbackNote +
        report.errors
          .map(item => t('sidepanel.backup.importFailed', { reason: `${item.id}: ${item.message}` }))
          .join('\n');
    }
  } catch (error) {
    failure = t('sidepanel.backup.importFailed', { reason: toErrorText(error) });
  }

  if (failure) {
    errorDialog.value = { title: t('sidepanel.backup.importTitle'), message: failure };
    return;
  }

  // 导入成功：整页刷新，让引擎与各管理器按权威存储全量重建
  window.location.reload();
}
</script>
