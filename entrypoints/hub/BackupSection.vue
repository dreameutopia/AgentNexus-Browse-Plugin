<template>
  <div>
    <!-- ══════════ 存储占用面板 ══════════ -->
    <section class="backup-storage">
      <div class="backup-storage-header">
        <div>
          <h4 class="backup-storage-title">{{ t('sidepanel.backup.storageTitle') }}</h4>
          <p class="backup-storage-desc">{{ t('sidepanel.backup.storageDesc') }}</p>
        </div>
        <button
          type="button"
          class="backup-storage-refresh"
          :disabled="isMeasuring"
          @click="refreshStorage"
        >
          {{ isMeasuring ? t('sidepanel.backup.storageRefreshing') : t('sidepanel.backup.storageRefresh') }}
        </button>
      </div>

      <template v-if="storageReport">
        <div class="backup-storage-total">
          <span class="backup-storage-total-value">{{ totalText }}</span>
          <span class="backup-storage-total-label">{{ t('sidepanel.backup.storageTotal') }}</span>
        </div>

        <div class="backup-storage-planes">
          <span>{{ t('sidepanel.backup.storagePlaneChrome') }}：{{ formatSize(storageReport.chromeBytes) }}</span>
          <span>{{ t('sidepanel.backup.storagePlaneLocal') }}：{{ formatSize(storageReport.localBytes) }}</span>
          <span>{{ t('sidepanel.backup.storagePlaneIdb') }}：{{ formatSize(storageReport.idbBytes) }}</span>
        </div>

        <!-- 分类明细 -->
        <ul class="backup-storage-categories">
          <li v-for="category in visibleCategories" :key="category.id" class="backup-storage-category">
            <div class="backup-storage-category-head">
              <span class="backup-storage-category-name">{{ t(category.labelKey) }}</span>
              <span v-if="category.count" class="backup-storage-badge">
                {{ t('sidepanel.backup.storageItems', { count: category.count }) }}
              </span>
              <span class="backup-storage-badge" :class="{ off: !category.inBackup }">
                {{
                  category.inBackup
                    ? t('sidepanel.backup.storageInBackup')
                    : t('sidepanel.backup.storageNotInBackup')
                }}
              </span>
              <span class="backup-storage-category-size">{{ formatSize(category.bytes) }}</span>
              <span class="backup-storage-category-share">{{ formatShare(category.share) }}</span>
            </div>

            <div class="backup-storage-bar">
              <div class="backup-storage-bar-fill" :style="{ width: barWidth(category.share) }"></div>
            </div>

            <ul v-if="category.children && category.children.length" class="backup-storage-children">
              <li v-for="child in category.children ?? []" :key="child.id" class="backup-storage-child">
                <span class="backup-storage-child-name">{{ t(child.labelKey) }}</span>
                <span v-if="child.count" class="backup-storage-child-share">
                  {{ t('sidepanel.backup.storageItems', { count: child.count }) }}
                </span>
                <span class="backup-storage-child-size">{{ formatSize(child.bytes) }}</span>
                <span class="backup-storage-child-share">{{ formatShare(child.share) }}</span>
              </li>
            </ul>

            <p
              v-if="category.reclaimableBytes && category.reclaimableBytes > 0"
              class="backup-storage-reclaimable"
            >
              {{
                t('sidepanel.backup.storageReclaimable', {
                  size: formatSize(category.reclaimableBytes),
                  count: category.reclaimableCount ?? 0,
                })
              }}
            </p>

            <p v-if="tipText(category)" class="backup-storage-tip">
              <span class="backup-storage-tip-label">{{ t('sidepanel.backup.storageHowToShrink') }}</span>
              {{ tipText(category) }}
            </p>
          </li>
        </ul>

        <!-- 对话数据：文字 vs 多媒体 -->
        <div v-if="mediaVisible" class="backup-storage-media">
          <div class="backup-storage-media-title">
            {{ t('sidepanel.backup.conversationMediaTitle') }}
          </div>
          <div class="backup-storage-media-bar">
            <div class="backup-storage-media-bar-text" :style="{ width: mediaTextWidth }"></div>
            <div class="backup-storage-media-bar-media" :style="{ width: mediaMediaWidth }"></div>
          </div>
          <div class="backup-storage-media-legend">
            <span class="backup-storage-media-legend-item">
              <i class="backup-storage-media-dot text"></i>
              {{ t('sidepanel.backup.conversationMediaText') }}：{{ formatSize(mediaTextBytes) }}
            </span>
            <span class="backup-storage-media-legend-item">
              <i class="backup-storage-media-dot media"></i>
              {{ t('sidepanel.backup.conversationMediaMedia') }}：{{ formatSize(mediaMediaBytes) }}
            </span>
          </div>
          <p class="backup-storage-note">{{ t('sidepanel.backup.conversationMediaNote') }}</p>
        </div>

        <!-- 统计说明（不静默吞掉任何问题） -->
        <div v-if="storageReport.issues.length" class="backup-storage-issues">
          <p class="backup-storage-issues-title">
            {{ t('sidepanel.backup.storageIssuesTitle') }}
            （{{ t('sidepanel.backup.storageIssues', { count: storageReport.issues.length }) }}）
          </p>
          <ul>
            <li v-for="(issue, index) in storageReport.issues" :key="index">{{ issue }}</li>
          </ul>
        </div>
      </template>

      <p v-else-if="!isMeasuring" class="backup-storage-note">
        {{ t('sidepanel.backup.storageEmpty') }}
      </p>
    </section>

    <!-- ══════════ 导出 / 导入 ══════════ -->
    <p class="config-form-hint">{{ t('sidepanel.backup.exportDataDesc') }}</p>

    <label class="config-backup-secrets">
      <input type="checkbox" v-model="includeSecrets" />
      <span>{{ t('sidepanel.backup.includeSecrets') }}</span>
    </label>
    <p class="config-form-hint">{{ t('sidepanel.backup.includeSecretsHint') }}</p>

    <label class="config-backup-secrets">
      <input type="checkbox" v-model="includeMedia" />
      <span>{{ t('sidepanel.backup.includeMedia') }}</span>
    </label>
    <p class="config-form-hint">{{ t('sidepanel.backup.includeMediaHint') }}</p>

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
          {{
            importPreview.hasData
              ? t('sidepanel.backup.importPreviewFull', {
                  time: importPreview.exportedAt,
                  count: importPreview.count,
                })
              : t('sidepanel.backup.importPreview', {
                  time: importPreview.exportedAt,
                  count: importPreview.count,
                })
          }}
        </p>
        <p v-if="!importPreview.hasData" class="api-sub-message">
          {{ t('sidepanel.backup.importDataMissing') }}
        </p>
        <ul class="backup-preview-list">
          <li
            v-for="item in importPreview.items"
            :key="item.id"
            class="backup-preview-item"
            :class="{ data: item.isData }"
          >
            {{ item.label }}
          </li>
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
 * 备份与恢复分区（管理中心）
 *
 * 两块能力：
 * 1. **存储占用面板**：统计本插件在浏览器本地的全部占用，按分类列出大小、
 *    条数、占比与子项构成，并给出「如何缩小」的建议；无引用的图片单独标出
 *    可回收量。统计失败的部分显示「—」并在「统计说明」里逐条列出原因——
 *    绝不静默隐藏（隐藏会让用户以为占满了，实际还有未统计的部分）。
 * 2. **导出 / 导入**：导出覆盖配置与全部数据分区（对话、技能、智能体、计划、
 *    托管文件、笔记、捕获文件、用量统计），可选择是否包含多媒体与密钥；
 *    导入先全量校验再写入，中途失败自动回滚。
 *
 * 导入成功后整页刷新：备份写入覆盖引擎 / 存储 / 内存表多个层面，
 * reload 保障 hub 页（智能体 / 技能管理器）与引擎全部按权威存储重建，
 * sidepanel 侧则经 chrome.storage.onChanged 自动回流。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { t, type MessageKey } from '@/utils/i18n';
import { getEngine } from '../sidepanel/utils/config/engine';
import {
  applyFullBackup,
  buildFullBackup,
  collectStorageReport,
  DATA_SECTION_ORDER,
  defaultFullBackupFileName,
  downloadBackup,
  formatBytes,
  parseFullBackup,
  percentText,
  sectionLabelKey,
  serializeBackupCompact,
  type BackupFile,
  type BackupStrategy,
  type ParseFailure,
  type StorageReport,
} from '../sidepanel/utils/backup';
import type { EngineHealth } from '../sidepanel/utils/config/types';
// 与设置弹窗共享同一套表单 / 子弹窗样式（api-sub-* / config-backup-* / config-test-btn 等）
import '../sidepanel/components/modals/settings-forms.css';
// 存储占用面板专用样式
import './backup-storage.css';

const props = defineProps<{
  /** 当前分区是否激活（激活时刷新存储占用与健康状态） */
  active: boolean;
}>();

/** 错误子弹窗（导入解析失败 / 导入写入失败共用） */
const errorDialog = ref<{ title: string; message: string } | null>(null);

const includeSecrets = ref(true);
const includeMedia = ref(true);
const isExporting = ref(false);
const isMeasuring = ref(false);
const backupMessage = ref('');
const importFileInput = ref<HTMLInputElement | null>(null);
const storageHealth = ref<EngineHealth | null>(null);
const storageReport = ref<StorageReport | null>(null);
const importPreview = ref<{
  backup: BackupFile;
  items: { id: string; label: string; isData: boolean }[];
  count: number;
  hasData: boolean;
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

// ── 存储占用：展示派生 ──

/** 合计占用文本 */
const totalText = computed(() => formatBytes(storageReport.value?.totalBytes ?? -1));

/**
 * 只显示有实际占用的分类（0 字节的分类不占视觉空间）。
 * **统计失败（-1）的分类必须显示**——隐藏它等于让用户以为那里没有数据；
 * 「其他」始终展示（它是「未被归类」的兜底容器，可能正藏着遗漏的占用）。
 */
const visibleCategories = computed(() => {
  const report = storageReport.value;
  if (!report) return [];
  return report.categories.filter(
    category => category.bytes !== 0 || category.id === 'other',
  );
});

/** 对话媒体构成（仅在有数据时展示） */
const mediaVisible = computed(() => {
  const value = storageReport.value?.conversationMedia;
  return !!value && value.totalBytes > 0;
});

const mediaTextBytes = computed(() => storageReport.value?.conversationMedia.textBytes ?? -1);
const mediaMediaBytes = computed(() => storageReport.value?.conversationMedia.mediaBytes ?? -1);

/**
 * 媒体构成条的两段宽度。
 *
 * 以「文字占比」为基准、文字段取该占比、媒体段取其余——两段之和恒为 100%，
 * 不会出现四舍五入后溢出（两段各自算占比时可能合计 100.01%）。
 */
const mediaTextWidth = computed(() => {
  const split = storageReport.value?.conversationMedia;
  if (!split || split.totalBytes <= 0 || split.textBytes < 0) return '0%';
  const percent = Math.max(0, Math.min(100, (split.textBytes / split.totalBytes) * 100));
  return `${percent.toFixed(2)}%`;
});

const mediaMediaWidth = computed(() => {
  const split = storageReport.value?.conversationMedia;
  if (!split || split.totalBytes <= 0 || split.textBytes < 0) return '0%';
  const percent = Math.max(0, Math.min(100, (split.textBytes / split.totalBytes) * 100));
  return `${Math.max(0, 100 - percent).toFixed(2)}%`;
});

/** 字节 → 可读文本（-1 → 「—」） */
function formatSize(bytes: number): string {
  return formatBytes(bytes);
}

/** 占比 → 百分比文本 */
function formatShare(share: number): string {
  return percentText(share);
}

/** 占比 → 条形图宽度（最小 0.6%，肉眼可见） */
function barWidth(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%';
  const percent = Math.min(100, Math.max(0.6, share * 100));
  return `${percent.toFixed(2)}%`;
}

/** 分类的「如何缩小」文案（无提示时返回空串） */
function tipText(category: { tipKey?: MessageKey }): string {
  return category.tipKey ? t(category.tipKey) : '';
}

// ── 存储健康：主副本 / 镜像 / 快照是否就绪 ──
const storageHealthText = computed(() => {
  const health = storageHealth.value;
  if (!health) return t('sidepanel.backup.healthUnknown');
  return health.healthy
    ? t('sidepanel.backup.healthOk', { count: health.snapshotTotal })
    : t('sidepanel.backup.healthWarn', { count: health.issueCount });
});

// ── 生命周期 ──

// 切到备份分区时刷新（占用统计较重，仅在激活时执行）
watch(
  () => props.active,
  active => {
    if (active) {
      void refreshStorage();
      void refreshStorageHealth();
    }
  },
);

onMounted(() => {
  void refreshStorage();
  void refreshStorageHealth();
});

/** 重新统计存储占用 */
async function refreshStorage(): Promise<void> {
  if (isMeasuring.value) return;
  isMeasuring.value = true;
  try {
    storageReport.value = await collectStorageReport();
  } catch (error) {
    console.warn('[Hub] 统计存储占用失败:', error);
    storageReport.value = null;
  } finally {
    isMeasuring.value = false;
  }
}

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

// ── 导出 ──

/** 导出完整备份（配置 + 全部数据分区） */
async function handleExportBackup(): Promise<void> {
  if (isExporting.value) return;
  isExporting.value = true;
  backupMessage.value = '';
  try {
    // 先把 localStorage 侧最新状态并入引擎，保证导出内容完整
    await getEngine().syncExternals();
    const result = await buildFullBackup({
      includeSecrets: includeSecrets.value,
      includeMedia: includeMedia.value,
    });
    const count = result.sectionIds.length;
    if (!count) {
      backupMessage.value = t('sidepanel.backup.exportEmpty');
      return;
    }
    downloadBackup(serializeBackupCompact(result.backup), defaultFullBackupFileName());
    const parts = [t('sidepanel.backup.exportSections', { count })];
    if (result.issues.length) parts.push(t('sidepanel.backup.exportPartial'));
    if (result.notices.length) parts.push(result.notices.join('；'));
    backupMessage.value = parts.join(' · ');
    if (result.issues.length) {
      console.warn('[Hub] 备份导出存在未采集成功的分区:', result.issues);
    }
    void refreshStorage();
  } catch (error) {
    backupMessage.value = t('sidepanel.backup.exportFailed', { reason: toErrorText(error) });
  } finally {
    isExporting.value = false;
  }
}

// ── 导入 ──

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

  const parsed = parseFullBackup(text);
  if (!parsed.ok) {
    errorDialog.value = {
      title: t('sidepanel.backup.importTitle'),
      message: parsed.errors.map(code => t(PARSE_FAILURE_KEYS[code])).join('\n'),
    };
    return;
  }

  const ids = Object.keys(parsed.backup.sections);
  const items = ids.map(id => ({
    id,
    label: t(sectionLabelKey(id) ?? 'sidepanel.backup.catOther'),
    isData: (DATA_SECTION_ORDER as readonly string[]).includes(id),
  }));
  importPreview.value = {
    backup: parsed.backup,
    items,
    count: ids.length,
    hasData: items.some(item => item.isData),
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
    const report = await applyFullBackup(preview.backup, strategy);
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
