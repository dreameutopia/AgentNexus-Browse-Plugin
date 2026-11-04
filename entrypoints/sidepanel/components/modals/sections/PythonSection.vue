<template>
  <div class="python-settings">
    <!-- 标题与状态徽标 -->
    <div class="asr-section-header">
      <div class="asr-section-title">
        <h4>{{ t('sidepanel.python.title') }}</h4>
        <span class="asr-status-badge python-beta-badge">{{ t('sidepanel.python.betaTag') }}</span>
        <span class="asr-status-badge" :class="statusBadgeClass">{{ statusBadgeText }}</span>
      </div>
      <p class="config-form-hint">{{ t('sidepanel.python.subtitle') }}</p>
      <p class="python-beta-notice">{{ t('sidepanel.python.betaNotice') }}</p>
    </div>

    <!-- ── 运行时状态卡 ── -->
    <div class="config-form-group">
      <label class="config-form-label">{{ t('sidepanel.python.runtimeTitle') }}</label>

      <!-- 未下载：说明 + 下载按钮 -->
      <div v-if="env.status === 'idle'" class="python-intro">
        <p class="config-form-hint">{{ t('sidepanel.python.introDesc1') }}</p>
        <p class="config-form-hint">{{ t('sidepanel.python.introDesc2') }}</p>
        <button type="button" class="api-config-btn api-config-btn-primary python-action-btn" @click="startSetup">
          {{ t('sidepanel.python.downloadBtn') }}
        </button>
      </div>

      <!-- 下载中：逐文件进度 -->
      <div v-else-if="downloading" class="python-progress-area">
        <p class="config-form-hint">{{ t('sidepanel.python.downloadingHint') }}</p>
        <div v-for="file in progressFiles" :key="file.label" class="python-progress-item">
          <div class="python-progress-head">
            <span class="python-progress-name">{{ file.label }}</span>
            <span class="python-progress-num">{{ file.text }}</span>
          </div>
          <div class="python-progress-bar">
            <div class="python-progress-fill" :style="{ width: file.percent + '%' }"></div>
          </div>
        </div>
        <button type="button" class="api-config-btn python-action-btn" @click="cancelSetup">
          {{ t('sidepanel.python.cancelBtn') }}
        </button>
      </div>

      <!-- 引导 + 核验中 -->
      <div v-else-if="verifying" class="python-progress-area">
        <p class="config-form-hint python-busy">
          <span class="python-spinner"></span>
          {{ t('sidepanel.python.verifyingHint') }}
        </p>
      </div>

      <!-- 就绪：信息 + 操作 -->
      <div v-else-if="env.status === 'ready'" class="python-ready">
        <p class="python-ready-info">
          CPython {{ env.pythonVersion || '?' }} · Pyodide {{ env.version }} ·
          {{ t('sidepanel.python.verifiedAt') }} {{ formatTime(env.verifiedAt) }}
        </p>
        <p v-if="cacheInfo.count > 0" class="config-form-hint">
          {{ t('sidepanel.python.cacheInfo', { count: cacheInfo.count, size: formatBytes(cacheInfo.bytes) }) }}
        </p>
        <div class="python-ready-actions">
          <button type="button" class="api-config-btn python-action-btn" :disabled="verifying" @click="reverify">
            {{ t('sidepanel.python.verifyBtn') }}
          </button>
          <button type="button" class="api-config-btn python-action-btn python-danger-btn" @click="removeEnv">
            {{ t('sidepanel.python.removeBtn') }}
          </button>
        </div>
      </div>

      <!-- 失败：原因 + 重试 -->
      <div v-else class="python-error-area">
        <p class="config-error-item">{{ t('sidepanel.python.errorPrefix') }}{{ env.lastError }}</p>
        <div class="python-ready-actions">
          <button type="button" class="api-config-btn api-config-btn-primary python-action-btn" @click="startSetup">
            {{ t('sidepanel.python.retryBtn') }}
          </button>
        </div>
      </div>
    </div>

    <!-- ── 包管理（就绪后显示） ── -->
    <div v-if="env.status === 'ready'" class="config-form-group">
      <label class="config-form-label">{{ t('sidepanel.python.pkgTitle') }}</label>
      <p class="config-form-hint">{{ t('sidepanel.python.pkgHint') }}</p>

      <!-- 已安装 chips -->
      <div class="config-form-label python-sub-label">{{ t('sidepanel.python.pkgInstalledTitle') }}</div>
      <div v-if="installedPackages.length" class="python-chip-row">
        <span v-for="pkg in installedPackages" :key="pkg.name" class="python-chip python-chip-installed">
          <span class="python-chip-name">{{ pkg.name }}</span>
          <span class="python-chip-version">{{ pkg.version }}</span>
          <button
            type="button"
            class="python-chip-remove"
            :title="t('common.delete')"
            @click="uninstall(pkg.name)"
          >×</button>
        </span>
      </div>
      <p v-else class="config-form-hint">{{ t('sidepanel.python.pkgEmpty') }}</p>

      <!-- 常用包快捷安装 -->
      <div class="config-form-label python-sub-label">{{ t('sidepanel.python.pkgFeatured') }}</div>
      <div class="python-chip-row">
        <button
          v-for="entry in featuredEntries"
          :key="entry.name"
          type="button"
          class="python-chip"
          :class="{ 'python-chip-installed': isInstalled(entry.name), 'python-chip-busy': busyPackage === entry.name }"
          :disabled="busyPackage === entry.name || !!busyPackage"
          @click="togglePackage(entry.name)"
        >
          <span class="python-chip-name">{{ entry.name }}</span>
          <span class="python-chip-version">{{ isInstalled(entry.name) ? '✓' : entry.version }}</span>
        </button>
      </div>

      <!-- 目录搜索安装 -->
      <div class="python-search-row">
        <input
          v-model.trim="pkgQuery"
          type="text"
          class="config-form-input"
          :placeholder="t('sidepanel.python.pkgSearchPlaceholder')"
        />
      </div>
      <div v-if="pkgQuery" class="python-search-results">
        <!-- 目录加载失败：区别于「无匹配」，给出重试入口 -->
        <div v-if="catalogState === 'error'" class="python-search-empty">
          <p class="config-form-hint">{{ t('sidepanel.python.pkgCatalogError') }}</p>
          <button type="button" class="api-config-btn python-action-btn" @click="loadCatalog">
            {{ t('common.retry') }}
          </button>
        </div>
        <!-- 目录加载中：避免误报「没有匹配的包」 -->
        <div v-else-if="catalogState === 'loading'" class="python-search-empty">
          <p class="config-form-hint">{{ t('common.loading') }}</p>
        </div>
        <template v-else>
          <button
            v-for="hit in visibleHits"
            :key="hit.entry.name"
            type="button"
            class="python-search-item"
            :class="{
              'python-search-item-installed': isInstalled(hit.entry.name),
              'python-search-item-pending': pendingInstall?.name === hit.entry.name,
              'python-search-item-busy': busyPackage === hit.entry.name,
            }"
            :disabled="!!busyPackage"
            @click="requestInstall(hit.entry)"
          >
            <span class="python-chip-name">{{ hit.entry.name }}</span>
            <!-- 别名命中提示：sklearn → scikit-learn -->
            <span v-if="hit.matchedAlias" class="python-search-alias">{{ hit.matchedAlias }}</span>
            <span class="python-chip-version">{{ hit.entry.version }}</span>
            <span v-if="isInstalled(hit.entry.name)" class="python-search-installed">✓</span>
            <span v-else-if="busyPackage === hit.entry.name" class="python-search-busy">
              <span class="python-spinner python-spinner-sm"></span>
            </span>
            <span v-else class="python-search-action">
              {{ pendingInstall?.name === hit.entry.name ? t('sidepanel.python.pkgPendingMark') : t('sidepanel.python.pkgInstallAction') }}
            </span>
          </button>
          <div v-if="!searchHits.length && catalogState === 'ready'" class="python-search-empty">
            <p class="config-form-hint">{{ t('sidepanel.python.pkgNotFound') }}</p>
            <p class="config-form-hint python-search-tip">{{ t('sidepanel.python.pkgSearchTip') }}</p>
          </div>
          <div v-if="searchHits.length" class="python-search-footer">
            <span class="config-form-hint">
              {{ t('sidepanel.python.pkgSearchCount', { count: searchHits.length }) }}
            </span>
            <button
              v-if="hiddenHitCount > 0"
              type="button"
              class="python-search-more"
              @click="searchLimit += 16"
            >
              {{ t('sidepanel.python.pkgSearchMore', { count: hiddenHitCount }) }}
            </button>
          </div>
        </template>
      </div>

      <!-- 安装确认条（搜索结果 / 常用包共用） -->
      <div v-if="pendingInstall" class="python-install-confirm">
        <div class="python-install-confirm-info">
          <span class="python-chip-name">{{ pendingInstall.name }}</span>
          <span class="python-chip-version">{{ pendingInstall.version }}</span>
          <span class="python-install-confirm-hint">
            <template v-if="pendingDeps.length">
              {{ t('sidepanel.python.pkgConfirmWithDeps', { deps: pendingDeps.join(', ') }) }}
            </template>
            <template v-else>{{ t('sidepanel.python.pkgConfirmNoDeps') }}</template>
          </span>
        </div>
        <div class="python-install-confirm-actions">
          <button
            type="button"
            class="api-config-btn api-config-btn-primary python-action-btn"
            :disabled="!!busyPackage"
            @click="confirmInstall"
          >
            {{ t('sidepanel.python.pkgConfirmInstall') }}
          </button>
          <button
            type="button"
            class="api-config-btn python-action-btn"
            :disabled="!!busyPackage"
            @click="cancelPendingInstall"
          >
            {{ t('common.cancel') }}
          </button>
        </div>
      </div>

      <p v-if="installMessage" class="config-form-hint python-install-message" :class="{ 'python-install-message-busy': !!busyPackage }">{{ installMessage }}</p>
      <p class="config-form-hint">{{ t('sidepanel.python.pkgSourceNote') }}</p>
    </div>

    <!-- ── 测试运行台（就绪后显示） ── -->
    <div v-if="env.status === 'ready'" class="config-form-group">
      <label class="config-form-label">{{ t('sidepanel.python.consoleTitle') }}</label>
      <p class="config-form-hint">{{ t('sidepanel.python.consoleHint') }}</p>
      <textarea
        v-model="code"
        class="python-code-input"
        rows="8"
        spellcheck="false"
        @keydown.ctrl.enter.prevent="runTest"
        @keydown.meta.enter.prevent="runTest"
      ></textarea>
      <div class="python-console-actions">
        <button
          type="button"
          class="api-config-btn api-config-btn-primary python-action-btn"
          :disabled="runningTest"
          @click="runTest"
        >
          {{ runningTest ? t('sidepanel.python.consoleRunning') : t('sidepanel.python.consoleRun') }}
        </button>
        <span v-if="testOutcome" class="config-form-hint">{{ t('sidepanel.python.durationInfo', { ms: testOutcome.durationMs }) }}</span>
      </div>

      <div v-if="testOutcome" class="python-console-output">
        <div v-if="testOutcome.stdout" class="python-output-block">
          <span class="python-output-label">stdout</span>
          <pre>{{ testOutcome.stdout }}</pre>
        </div>
        <div v-if="testOutcome.result" class="python-output-block">
          <span class="python-output-label">result</span>
          <pre>{{ testOutcome.result }}</pre>
        </div>
        <div v-if="testOutcome.stderr" class="python-output-block python-output-stderr">
          <span class="python-output-label">stderr</span>
          <pre>{{ testOutcome.stderr }}</pre>
        </div>
        <div v-if="!testOutcome.ok" class="python-output-block python-output-error">
          <span class="python-output-label">{{ testOutcome.timedOut ? 'timeout' : 'error' }}</span>
          <pre>{{ testOutcome.timedOut ? t('sidepanel.python.timeoutMessage') : testOutcome.errorDetail || testOutcome.errorName }}</pre>
        </div>
        <p v-if="testOutcome.ok && !testOutcome.stdout && !testOutcome.result && !testOutcome.stderr" class="config-form-hint">
          {{ t('sidepanel.python.consoleNoOutput') }}
        </p>
      </div>
    </div>

    <!-- ── 说明 ── -->
    <p class="config-form-hint python-footnote">{{ t('sidepanel.python.privacyNote') }}</p>
  </div>
</template>

<script setup lang="ts">
/**
 * Python 环境设置分区（下载 / 核验 / 包管理 / 测试运行）
 *
 * 数据流：
 * - 环境状态：chrome.storage.local（watchPyodideEnv 跨上下文订阅，与运行时/工具侧共享）
 * - 核心文件下载：downloadPyodideFile（进度 + 可取消 + IndexedDB 落盘）
 * - 核验：ensurePyodideRuntime + verifyPyodideRuntime（功能级冒烟测试），
 *   通过后写入 status='ready' —— 这是 python_run 工具与智能体编辑页
 *   「Python 计算」组可用性的唯一开关
 * - 包管理：锁文件目录（随扩展打包的 pyodide-lock.json）驱动，
 *   installPackages / uninstallPackages（wheel 经缓存层，sha256 校验）
 * - 测试运行台：与 python_run 工具完全同一执行管线（runPythonCode），
 *   在此验证的效果即智能体实际使用的效果
 */
import { computed, inject, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { t } from '@/utils/i18n';
import { settingsModalContextKey, type SettingsModalContext } from '../composables/use-settings-form';
// 子路径直连（不走 @/utils/pyodide 桶文件）：本组件对 Python 能力的函数式
// 依赖（下方 onMounted/按钮处理器）按需动态 import 桶文件加载，静态导入
// 若经桶文件会与其形成「静态 + 动态混合导入」，Vite 会告警动态导入无法拆 chunk
import {
  PYODIDE_CORE_FILES,
  PYODIDE_FEATURED_PACKAGES,
} from '@/utils/pyodide/pyodide-config';
import { downloadPyodideFile } from '@/utils/pyodide/pyodide-downloader';
import { listFileMeta } from '@/utils/pyodide/pyodide-cache';
import {
  DEFAULT_PYODIDE_ENV_STATE,
  updatePyodideEnvState,
  type PyodideEnvState,
} from '@/utils/pyodide/pyodide-env';
import {
  getPackageCatalog,
  installPackages,
  uninstallPackages,
  verifyPyodideRuntime,
  type PyodideCatalogEntry,
} from '@/utils/pyodide/pyodide-runtime';

const { openEpoch } = inject(settingsModalContextKey) as SettingsModalContext;

// ──── 状态 ────

const env = ref<PyodideEnvState>({ ...DEFAULT_PYODIDE_ENV_STATE });
const downloading = ref(false);
const verifying = ref(false);
const cancelController = ref<AbortController | null>(null);

const cacheInfo = reactive({ count: 0, bytes: 0 });

const catalog = ref<PyodideCatalogEntry[]>([]);
/** 目录生命周期：区分「加载中 / 就绪 / 失败」，避免失败被误报为「没有匹配的包」 */
const catalogState = ref<'loading' | 'ready' | 'error'>('loading');
const pkgQuery = ref('');
const busyPackage = ref('');
const installMessage = ref('');
/** 待确认安装的包（搜索结果与常用包共用的确认条状态） */
const pendingInstall = ref<PyodideCatalogEntry | null>(null);
/** 搜索结果初始截断数，超出可增量展开 */
const searchLimit = ref(8);

const code = ref(
  [
    'import sys, json',
    '',
    'info = {',
    '    "python": sys.version.split()[0],',
    '    "sum_1_to_100": sum(range(1, 101)),',
    '}',
    'print(json.dumps(info, ensure_ascii=False, indent=2))',
    'info',
  ].join('\n'),
);
const runningTest = ref(false);
const testOutcome = ref<{
  ok: boolean;
  stdout: string;
  stderr: string;
  result: string;
  durationMs: number;
  timedOut: boolean;
  errorName: string;
  errorDetail: string;
} | null>(null);

/** 下载进度（key = 文件名） */
const progress = reactive<Record<string, { received: number; total: number }>>({});

let unwatchEnv: (() => void) | null = null;

// ──── 计算属性 ────

const statusBadgeClass = computed(() => {
  switch (env.value.status) {
    case 'ready':
      return 'ok';
    case 'error':
      return 'bad';
    default:
      return 'warn';
  }
});

const statusBadgeText = computed(() => {
  if (downloading.value) return t('sidepanel.python.statusDownloading');
  if (verifying.value) return t('sidepanel.python.statusVerifying');
  switch (env.value.status) {
    case 'ready':
      return t('sidepanel.python.statusReady');
    case 'error':
      return t('sidepanel.python.statusError');
    default:
      return t('sidepanel.python.statusIdle');
  }
});

const progressFiles = computed(() =>
  PYODIDE_CORE_FILES.map(file => {
    const state = progress[file.label] ?? { received: 0, total: -1 };
    const percent = state.total > 0 ? Math.min(100, Math.round((state.received / state.total) * 100)) : 0;
    const text =
      state.total > 0
        ? `${formatBytes(state.received)} / ${formatBytes(state.total)}（${percent}%）`
        : formatBytes(state.received);
    return { label: file.label, percent, text };
  }),
);

const installedPackages = computed(() => env.value.packages);

const installedNames = computed(() => new Set(env.value.packages.map(pkg => pkg.name.toLowerCase())));

const featuredEntries = computed(() => {
  if (catalog.value.length === 0) return [];
  return PYODIDE_FEATURED_PACKAGES.map(name =>
    catalog.value.find(entry => entry.name.toLowerCase() === name.toLowerCase()),
  ).filter((entry): entry is PyodideCatalogEntry => entry !== undefined);
});

/** 搜索命中：score 越小越靠前（精确 > 前缀 > 包含 > 别名），同分已安装优先 */
interface SearchHit {
  entry: PyodideCatalogEntry;
  score: number;
  /** 通过 imports 别名命中时展示（如 sklearn → scikit-learn） */
  matchedAlias?: string;
}

const searchHits = computed<SearchHit[]>(() => {
  const query = pkgQuery.value.trim().toLowerCase();
  if (!query || catalog.value.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const entry of catalog.value) {
    // 跳过依赖自身条目（锁文件中的元包占位）
    if (entry.depends.some(dep => dep === entry.name)) continue;
    const name = entry.name.toLowerCase();
    let score = -1;
    let matchedAlias: string | undefined;
    if (name === query) {
      score = 0;
    } else if (name.startsWith(query)) {
      score = 1;
    } else if (name.includes(query)) {
      score = 2;
    } else {
      const alias = entry.imports.find(imp => imp.toLowerCase() === query);
      if (alias) {
        score = 3;
        matchedAlias = alias;
      } else if (entry.imports.some(imp => imp.toLowerCase().includes(query))) {
        score = 4;
        matchedAlias = entry.imports.find(imp => imp.toLowerCase().includes(query));
      }
    }
    if (score >= 0) hits.push({ entry, score, matchedAlias });
  }
  hits.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    const installedDiff = Number(isInstalled(b.entry.name)) - Number(isInstalled(a.entry.name));
    if (installedDiff !== 0) return installedDiff;
    return a.entry.name.localeCompare(b.entry.name);
  });
  return hits;
});

const visibleHits = computed(() => searchHits.value.slice(0, searchLimit.value));
const hiddenHitCount = computed(() => Math.max(0, searchHits.value.length - visibleHits.value.length));

/** 确认条展示：即将安装的包 + 尚未安装的依赖（帮助预判下载量） */
const pendingDeps = computed(() => {
  const entry = pendingInstall.value;
  if (!entry) return [];
  return entry.depends.filter(dep => dep !== entry.name && !isInstalled(dep));
});

// ──── 工具函数 ────

function isInstalled(name: string): boolean {
  return installedNames.value.has(name.trim().toLowerCase());
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(epochMs: number): string {
  if (!epochMs) return '-';
  try {
    return new Date(epochMs).toLocaleString();
  } catch {
    return '-';
  }
}

async function hydrate(): Promise<void> {
  const { getPyodideEnvState } = await import('@/utils/pyodide');
  env.value = await getPyodideEnvState();
  await refreshCacheInfo();
  if (env.value.status === 'ready' && catalog.value.length === 0) {
    void loadCatalog();
  }
}

async function refreshCacheInfo(): Promise<void> {
  try {
    const metas = await listFileMeta();
    cacheInfo.count = metas.length;
    cacheInfo.bytes = metas.reduce((sum, meta) => sum + meta.size, 0);
  } catch {
    cacheInfo.count = 0;
    cacheInfo.bytes = 0;
  }
}

async function loadCatalog(): Promise<void> {
  catalogState.value = 'loading';
  try {
    catalog.value = await getPackageCatalog();
    catalogState.value = 'ready';
  } catch {
    // 目录加载失败不阻塞：显示错误态 + 重试按钮，仍可搜索（空结果会被识别为加载失败）
    catalog.value = [];
    catalogState.value = 'error';
  }
}

// ──── 下载 / 核验 / 移除 ────

async function startSetup(): Promise<void> {
  if (downloading.value || verifying.value) return;
  downloading.value = true;
  const controller = new AbortController();
  cancelController.value = controller;

  await updatePyodideEnvState({ status: 'downloading', lastError: '' });
  try {
    for (const file of PYODIDE_CORE_FILES) {
      progress[file.label] = { received: 0, total: -1 };
      await downloadPyodideFile(file.url, {
        signal: controller.signal,
        contentTypeFallback: file.contentType,
        onProgress: (received, total) => {
          progress[file.label] = { received, total };
        },
      });
    }

    downloading.value = false;
    verifying.value = true;
    const { ensurePyodideRuntime } = await import('@/utils/pyodide');
    await ensurePyodideRuntime();
    const verifyResult = await verifyPyodideRuntime();
    await updatePyodideEnvState({
      status: 'ready',
      pythonVersion: verifyResult.pythonVersion,
      verifiedAt: Date.now(),
      lastError: '',
    });
    void loadCatalog();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = controller.signal.aborted || message.includes('取消') || message.includes('abort');
    downloading.value = false;
    await updatePyodideEnvState({
      status: cancelled ? 'idle' : 'error',
      lastError: cancelled ? '' : message,
    });
  } finally {
    verifying.value = false;
    cancelController.value = null;
    await hydrate();
  }
}

function cancelSetup(): void {
  cancelController.value?.abort();
}

async function reverify(): Promise<void> {
  if (verifying.value) return;
  verifying.value = true;
  try {
    const { ensurePyodideRuntime } = await import('@/utils/pyodide');
    await ensurePyodideRuntime();
    const verifyResult = await verifyPyodideRuntime();
    await updatePyodideEnvState({
      status: 'ready',
      pythonVersion: verifyResult.pythonVersion,
      verifiedAt: Date.now(),
      lastError: '',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updatePyodideEnvState({ status: 'error', lastError: message });
  } finally {
    verifying.value = false;
    await hydrate();
  }
}

async function removeEnv(): Promise<void> {
  if (!window.confirm(t('sidepanel.python.removeConfirm'))) return;
  const { clearFiles } = await import('@/utils/pyodide');
  try {
    await clearFiles();
  } catch {
    // 缓存清理失败仍重置状态（残留孤儿条目不影响正确性）
  }
  await updatePyodideEnvState({
    status: 'idle',
    pythonVersion: '',
    verifiedAt: 0,
    packages: [],
    lastError: '',
  });
  testOutcome.value = null;
  await hydrate();
}

// ──── 包安装 / 卸载 ────

/** 点击搜索结果：已安装则提示；否则进入确认（不直接下载） */
function requestInstall(entry: PyodideCatalogEntry): void {
  if (busyPackage.value) return;
  if (isInstalled(entry.name)) {
    installMessage.value = t('sidepanel.python.pkgAlreadyInstalled', {
      name: entry.name,
      version: entry.version,
    });
    return;
  }
  installMessage.value = '';
  pendingInstall.value = entry;
}

function cancelPendingInstall(): void {
  pendingInstall.value = null;
}

/** 确认条：真正执行安装 */
async function confirmInstall(): Promise<void> {
  const entry = pendingInstall.value;
  if (!entry || busyPackage.value) return;
  pendingInstall.value = null;
  await install(entry.name);
}

async function install(name: string): Promise<void> {
  if (busyPackage.value) return;
  busyPackage.value = name;
  installMessage.value = t('sidepanel.python.pkgInstalling', { name });
  try {
    const installed = await installPackages([name]);
    installMessage.value = installed.length
      ? t('sidepanel.python.pkgInstalledOk', { name: installed[0].name, version: installed[0].version })
      : t('sidepanel.python.pkgNotFound');
  } catch (error) {
    installMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    busyPackage.value = '';
    await hydrate();
  }
}

async function togglePackage(name: string): Promise<void> {
  if (isInstalled(name)) {
    await uninstall(name);
    return;
  }
  if (busyPackage.value) return;
  const entry = catalog.value.find(e => e.name.toLowerCase() === name.toLowerCase());
  if (entry) {
    requestInstall(entry);
  } else {
    await install(name);
  }
}

async function uninstall(name: string): Promise<void> {
  if (busyPackage.value) return;
  if (!window.confirm(t('sidepanel.python.pkgRemove', { name }))) return;
  busyPackage.value = name;
  try {
    await uninstallPackages([name]);
    installMessage.value = t('sidepanel.python.pkgRemoved', { name });
  } catch (error) {
    installMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    busyPackage.value = '';
    await hydrate();
  }
}

// ──── 测试运行台 ────

async function runTest(): Promise<void> {
  if (runningTest.value || !code.value.trim()) return;
  runningTest.value = true;
  testOutcome.value = null;
  try {
    const { runPythonCode } = await import('@/utils/pyodide');
    testOutcome.value = await runPythonCode(code.value, { timeoutMs: 60_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    testOutcome.value = {
      ok: false,
      stdout: '',
      stderr: '',
      result: '',
      durationMs: 0,
      timedOut: false,
      errorName: message,
      errorDetail: message,
    };
  } finally {
    runningTest.value = false;
  }
}

// ──── 生命周期 ────

onMounted(async () => {
  await hydrate();
  // 运行时侧（工具自动装包）与本页互为写入方：订阅保持视图同步
  void import('@/utils/pyodide').then(({ watchPyodideEnv }) => {
    unwatchEnv = watchPyodideEnv(state => {
      env.value = state;
    });
  });
});

watch(openEpoch, () => {
  void hydrate();
});

// 查询变化：重置分页截断与待确认项，避免确认条指向过期搜索结果
watch(pkgQuery, () => {
  searchLimit.value = 8;
  pendingInstall.value = null;
});

onUnmounted(() => {
  unwatchEnv?.();
});
</script>
