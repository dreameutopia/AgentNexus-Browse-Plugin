<template>
  <div class="pc-ops">
    <header class="pc-ops__head">
      <div>
        <h3 class="pc-ops__title">{{ t('hub.plugins.operationsTitle') }}</h3>
        <p class="pc-ops__intro">{{ t('hub.plugins.operationsIntro') }}</p>
      </div>
      <div class="pc-ops__actions">
        <button
          type="button"
          class="hub-btn"
          :disabled="operationsLoading || busy"
          @click="loadOperations()"
        >
          <RefreshCw
            :size="14"
            :class="{ 'pc-spin': operationsLoading }"
            aria-hidden="true"
          />
          {{ t('hub.plugins.operationsRefresh') }}
        </button>
        <button
          type="button"
          class="hub-btn"
          :disabled="operationsLoading || busy || !operations.length"
          @click="clearOperations()"
        >
          <Trash2 :size="14" aria-hidden="true" />
          {{ t('hub.plugins.operationsClear') }}
        </button>
      </div>
    </header>

    <div class="pc-ops__filters">
      <label class="pc-ops__filter">
        <span>{{ t('hub.plugins.operationsFilterPlugin') }}</span>
        <select
          v-model="operationFilter.pluginKey"
          :disabled="operationsLoading"
          @change="loadOperations()"
        >
          <option value="">{{ t('hub.plugins.operationsFilterAll') }}</option>
          <option
            v-for="plugin in snapshot.packages"
            :key="plugin.key"
            :value="plugin.key"
          >
            {{ plugin.manifest.displayName }}
          </option>
        </select>
      </label>
      <label class="pc-ops__filter">
        <span>{{ t('hub.plugins.operationsFilterAction') }}</span>
        <select
          v-model="operationFilter.action"
          :disabled="operationsLoading"
          @change="loadOperations()"
        >
          <option value="">{{ t('hub.plugins.operationsFilterAll') }}</option>
          <option
            v-for="action in actions"
            :key="action"
            :value="action"
          >
            {{ actionLabel(action) }}
          </option>
        </select>
      </label>
      <label class="pc-ops__filter">
        <span>{{ t('hub.plugins.operationsFilterStatus') }}</span>
        <select
          v-model="operationFilter.status"
          :disabled="operationsLoading"
          @change="loadOperations()"
        >
          <option value="">{{ t('hub.plugins.operationsFilterAll') }}</option>
          <option value="success">{{ t('hub.plugins.operationSuccess') }}</option>
          <option value="failure">{{ t('hub.plugins.operationFailure') }}</option>
        </select>
      </label>
    </div>

    <p v-if="operationsLoading" class="pc-empty">
      {{ t('hub.plugins.operationsLoading') }}
    </p>
    <p v-else-if="!operations.length" class="pc-empty">
      {{ t('hub.plugins.operationsEmpty') }}
    </p>
    <ul v-else class="pc-ops__list">
      <li
        v-for="record in operations"
        :key="record.id"
        class="pc-op"
        :class="`pc-op--${record.status}`"
      >
        <div class="pc-op__main">
          <span class="pc-op__badge">{{ actionLabel(record.action) }}</span>
          <span class="pc-op__status">{{ statusLabel(record.status) }}</span>
          <span
            class="pc-op__plugin"
            :title="record.pluginKey"
          >{{ pluginLabel(record) }}</span>
          <span v-if="versionLabel(record)" class="pc-op__version">
            {{ versionLabel(record) }}
          </span>
          <span v-if="record.source" class="pc-op__source">
            {{ sourceLabel(record.source) }}
          </span>
          <time class="pc-op__time">{{ formatTime(record.at) }}</time>
        </div>
        <div v-if="record.errorCode || record.durationMs" class="pc-op__meta">
          <span v-if="record.errorCode" class="pc-op__code">
            {{ record.errorCode }}
          </span>
          <span v-if="record.stage" class="pc-op__stage">
            {{ stageLabel(record.stage) }}
          </span>
          <span class="pc-op__duration">
            {{ t('hub.plugins.operationDuration', { ms: record.durationMs }) }}
          </span>
        </div>
        <p v-if="record.note" class="pc-op__note">{{ record.note }}</p>
        <details v-if="record.errorDetail" class="pc-op__detail">
          <summary>{{ t('hub.plugins.operationDetail') }}</summary>
          <pre>{{ record.errorDetail }}</pre>
        </details>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
/**
 * 操作日志查询组件
 *
 * 展示后台持久化的插件生命周期记录；失败项必须能直接看到错误码、阶段和
 * 原始 detail（例如 `INCOMPATIBLE_HOST: host 0.0.1 not in ">=0.0.1 <1.0.0" or pluginApi 1.2.0 not in "^1.1.0"`），
 * 而不是仅有“导入失败”。
 */
import { RefreshCw, Trash2 } from 'lucide-vue-next';
import { t } from '@/utils/i18n';
import type {
  PluginOperationAction,
  PluginOperationRecord,
  PluginOperationSource,
  PluginOperationStage,
} from '@/utils/plugins/operations';
import { usePluginCenter } from '../composables/use-plugin-center';

const {
  busy,
  snapshot,
  operations,
  operationsLoading,
  operationFilter,
  loadOperations,
  clearOperations,
} = usePluginCenter();

const actions: PluginOperationAction[] = [
  'preview',
  'install',
  'update',
  'enable',
  'disable',
  'uninstall',
  'rollback',
  'backup-restore',
  'backup-rollback',
  'update-check',
  'startup',
];

function actionLabel(action: PluginOperationAction): string {
  switch (action) {
    case 'preview':
      return t('hub.plugins.operationActionPreview');
    case 'install':
      return t('hub.plugins.operationActionInstall');
    case 'update':
      return t('hub.plugins.operationActionUpdate');
    case 'enable':
      return t('hub.plugins.operationActionEnable');
    case 'disable':
      return t('hub.plugins.operationActionDisable');
    case 'uninstall':
      return t('hub.plugins.operationActionUninstall');
    case 'rollback':
      return t('hub.plugins.operationActionRollback');
    case 'backup-restore':
      return t('hub.plugins.operationActionBackupRestore');
    case 'backup-rollback':
      return t('hub.plugins.operationActionBackupRollback');
    case 'update-check':
      return t('hub.plugins.operationActionUpdateCheck');
    case 'startup':
      return t('hub.plugins.operationActionStartup');
  }
}

function statusLabel(status: PluginOperationRecord['status']): string {
  return status === 'success'
    ? t('hub.plugins.operationSuccess')
    : t('hub.plugins.operationFailure');
}

const stageKeys = {
  request: 'hub.plugins.operationStageRequest',
  download: 'hub.plugins.operationStageDownload',
  unpack: 'hub.plugins.operationStageUnpack',
  layout: 'hub.plugins.operationStageLayout',
  signature: 'hub.plugins.operationStageSignature',
  manifest: 'hub.plugins.operationStageManifest',
  compat: 'hub.plugins.operationStageCompat',
  schema: 'hub.plugins.operationStageSchema',
  reference: 'hub.plugins.operationStageReference',
  dependency: 'hub.plugins.operationStageDependency',
  commit: 'hub.plugins.operationStageCommit',
  apply: 'hub.plugins.operationStageApply',
  runtime: 'hub.plugins.operationStageRuntime',
} as const;

function stageLabel(stage: PluginOperationStage): string {
  return t(stageKeys[stage]);
}

function sourceLabel(source: PluginOperationSource): string {
  switch (source) {
    case 'file':
      return t('hub.plugins.operationSourceFile');
    case 'github':
      return t('hub.plugins.operationSourceGithub');
    case 'rollback':
      return t('hub.plugins.operationSourceRollback');
    case 'backup':
      return t('hub.plugins.operationSourceBackup');
    case 'startup':
      return t('hub.plugins.operationSourceStartup');
    case 'auto':
      return t('hub.plugins.operationSourceAuto');
  }
}

function pluginLabel(record: PluginOperationRecord): string {
  if (record.pluginName && record.pluginKey)
    return `${record.pluginName} (${record.pluginKey})`;
  return (
    record.pluginName ||
    record.pluginKey ||
    t('hub.plugins.operationPluginUnknown')
  );
}

function versionLabel(record: PluginOperationRecord): string {
  if (record.fromVersion && record.toVersion)
    return record.fromVersion === record.toVersion
      ? `v${record.toVersion}`
      : `v${record.fromVersion} → v${record.toVersion}`;
  if (record.toVersion) return `v${record.toVersion}`;
  if (record.fromVersion) return `v${record.fromVersion}`;
  return '';
}

function formatTime(at: number): string {
  return new Date(at).toLocaleString();
}
</script>

<style scoped>
.pc-ops {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.pc-ops__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.pc-ops__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
}
.pc-ops__intro {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-3);
}
.pc-ops__actions {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
}
.pc-ops__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.pc-ops__filter {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-3);
}
.pc-ops__filter select {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border-2);
  border-radius: 7px;
  background: var(--bg-1);
  color: var(--text-1);
  font-size: 12px;
}
.pc-ops__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.pc-op {
  padding: 10px 12px;
  border: 1px solid var(--border-2);
  border-radius: 8px;
  background: var(--bg-1);
}
.pc-op--failure {
  border-color: color-mix(in srgb, var(--danger, #c0392b) 35%, var(--border-2));
}
.pc-op__main {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
}
.pc-op__badge {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--bg-3, rgba(127, 127, 127, 0.12));
  color: var(--text-1);
  font-weight: 600;
}
.pc-op__status {
  font-weight: 600;
}
.pc-op--success .pc-op__status {
  color: var(--success, #1e8e3e);
}
.pc-op--failure .pc-op__status {
  color: var(--danger, #c0392b);
}
.pc-op__plugin {
  color: var(--text-1);
  overflow-wrap: anywhere;
}
.pc-op__version,
.pc-op__source,
.pc-op__time {
  color: var(--text-3);
}
.pc-op__time {
  margin-left: auto;
  white-space: nowrap;
}
.pc-op__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-3);
}
.pc-op__code {
  padding: 0 5px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--danger, #c0392b) 12%, transparent);
  color: var(--danger, #c0392b);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.pc-op__note {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--text-3);
  overflow-wrap: anywhere;
}
.pc-op__detail {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-2);
}
.pc-op__detail summary {
  cursor: pointer;
  color: var(--text-3);
}
.pc-op__detail pre {
  margin: 6px 0 0;
  padding: 8px;
  border-radius: 6px;
  background: var(--bg-2, rgba(127, 127, 127, 0.08));
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}
</style>
