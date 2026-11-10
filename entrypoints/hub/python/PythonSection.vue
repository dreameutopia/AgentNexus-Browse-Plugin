<template>
  <div class="hub-python">
    <!-- ══════════ 头部：标题 / 状态徽标 ══════════ -->
    <header class="hub-python__head">
      <div class="hub-python__title-row">
        <h2 class="hub-python__title">{{ t('hub.python.title') }}</h2>
        <span class="hub-badge hub-python-badge-beta">{{ t('hub.python.betaTag') }}</span>
        <span class="hub-badge" :class="statusBadgeClass">{{ statusBadgeText }}</span>
      </div>
      <p class="hub-hint">{{ t('hub.python.subtitle') }}</p>
      <p class="hub-python__notice">{{ t('hub.python.betaNotice') }}</p>
    </header>

    <!-- ══════════ 运行时 ══════════ -->
    <section class="hub-python__card">
      <h3 class="hub-python__card-title">{{ t('hub.python.runtimeTitle') }}</h3>

      <!-- 未下载：说明 + 下载按钮 -->
      <div v-if="env.status === 'idle'" class="hub-python__stack">
        <p class="hub-hint">{{ t('hub.python.introDesc1') }}</p>
        <p class="hub-hint">{{ t('hub.python.introDesc2') }}</p>
        <div>
          <button type="button" class="hub-btn hub-btn-primary" @click="startSetup">
            {{ t('hub.python.downloadBtn') }}
          </button>
        </div>
      </div>

      <!-- 下载中：逐文件进度 -->
      <div v-else-if="downloading" class="hub-python__stack">
        <p class="hub-hint">{{ t('hub.python.downloadingHint') }}</p>
        <div v-for="file in progressFiles" :key="file.label" class="hub-python__progress">
          <div class="hub-python__progress-head">
            <span class="hub-python__progress-name">{{ file.label }}</span>
            <span class="hub-python__progress-num">{{ file.text }}</span>
          </div>
          <div class="hub-python__progress-bar">
            <div class="hub-python__progress-fill" :style="{ width: file.percent + '%' }"></div>
          </div>
        </div>
        <div>
          <button type="button" class="hub-btn" @click="cancelSetup">
            {{ t('hub.python.cancelBtn') }}
          </button>
        </div>
      </div>

      <!-- 引导 + 核验中 -->
      <div v-else-if="verifying" class="hub-python__stack">
        <p class="hub-hint hub-python__busy">
          <span class="hub-python__spinner" aria-hidden="true"></span>
          {{ t('hub.python.verifyingHint') }}
        </p>
      </div>

      <!-- 就绪：信息 + 操作 -->
      <div v-else-if="env.status === 'ready'" class="hub-python__stack">
        <p class="hub-python__ready-info">
          CPython {{ env.pythonVersion || '?' }} · Pyodide {{ env.version }}
        </p>
        <!-- 运行时详情（管理中心新增：把关键状态显式铺开，不靠一句话概括） -->
        <dl class="hub-python__facts">
          <div class="hub-python__fact">
            <dt>{{ t('hub.python.runtimeDetailTitle') }}</dt>
            <dd>CPython {{ env.pythonVersion || '?' }}</dd>
          </div>
          <div class="hub-python__fact">
            <dt>Pyodide</dt>
            <dd>{{ env.version }}</dd>
          </div>
          <div class="hub-python__fact">
            <dt>{{ t('hub.python.verifiedAt') }}</dt>
            <dd>{{ formatTime(env.verifiedAt) }}</dd>
          </div>
          <div class="hub-python__fact">
            <dt>{{ t('hub.python.cacheTitle') }}</dt>
            <dd>{{ cacheInfo.count }} · {{ formatBytes(cacheInfo.bytes) }}</dd>
          </div>
        </dl>
        <p v-if="cacheInfo.count > 0" class="hub-hint">
          {{ t('hub.python.cacheInfo', { count: cacheInfo.count, size: formatBytes(cacheInfo.bytes) }) }}
        </p>
        <div class="hub-python__actions">
          <button type="button" class="hub-btn" :disabled="verifying" @click="reverify">
            {{ t('hub.python.verifyBtn') }}
          </button>
          <button
            type="button"
            class="hub-btn hub-python-btn-danger"
            :class="{ 'is-armed': armedAction === 'remove-env' }"
            @click="requestRemoveEnv"
          >
            {{ armedAction === 'remove-env' ? t('common.confirm') : t('hub.python.removeBtn') }}
          </button>
        </div>
      </div>

      <!-- 失败：原因 + 重试 -->
      <div v-else class="hub-python__stack">
        <p class="hub-python__error">{{ t('hub.python.errorPrefix') }}{{ env.lastError }}</p>
        <div>
          <button type="button" class="hub-btn hub-btn-primary" @click="startSetup">
            {{ t('hub.python.retryBtn') }}
          </button>
        </div>
      </div>
    </section>

    <!-- ══════════ 包管理（就绪后显示） ══════════ -->
    <section v-if="env.status === 'ready'" class="hub-python__card">
      <div class="hub-python__card-head">
        <h3 class="hub-python__card-title">{{ t('hub.python.pkgTitle') }}</h3>
        <div class="hub-python__card-actions">
          <span class="hub-badge hub-python-badge-neutral">
            {{ t('hub.python.pkgInstalledCount', { count: installedPackages.length }) }}
          </span>
          <button
            v-if="installedPackages.length"
            type="button"
            class="hub-btn hub-python-btn-danger"
            :class="{ 'is-armed': armedAction === 'remove-all-pkgs' }"
            @click="requestRemoveAllPackages"
          >
            {{ armedAction === 'remove-all-pkgs' ? t('common.confirm') : t('hub.python.pkgRemoveAll') }}
          </button>
        </div>
      </div>
      <p class="hub-hint">{{ t('hub.python.pkgHint') }}</p>

      <!-- 已安装 chips -->
      <h4 class="hub-python__sub-label">{{ t('hub.python.pkgInstalledTitle') }}</h4>
      <div v-if="installedPackages.length" class="hub-python__chips">
        <span v-for="pkg in installedPackages" :key="pkg.name" class="hub-python__chip hub-python__chip--installed">
          <span class="hub-python__chip-name">{{ pkg.name }}</span>
          <span class="hub-python__chip-version">{{ pkg.version }}</span>
          <button
            type="button"
            class="hub-python__chip-remove"
            :class="{ 'is-armed': armedAction === `pkg:${pkg.name}` }"
            :title="t('common.delete')"
            @click="requestUninstall(pkg.name)"
          >×</button>
        </span>
      </div>
      <p v-else class="hub-hint">{{ t('hub.python.pkgEmpty') }}</p>

      <!-- 常用包快捷安装 -->
      <h4 class="hub-python__sub-label">{{ t('hub.python.pkgFeatured') }}</h4>
      <div class="hub-python__chips">
        <button
          v-for="entry in featuredEntries"
          :key="entry.name"
          type="button"
          class="hub-python__chip hub-python__chip--button"
          :class="{ 'hub-python__chip--installed': isInstalled(entry.name), 'hub-python__chip--busy': busyPackage === entry.name }"
          :disabled="busyPackage === entry.name || !!busyPackage"
          @click="togglePackage(entry.name)"
        >
          <span class="hub-python__chip-name">{{ entry.name }}</span>
          <span class="hub-python__chip-version">{{ isInstalled(entry.name) ? '✓' : entry.version }}</span>
        </button>
      </div>

      <!-- 目录搜索安装 -->
      <div class="hub-python__search">
        <div class="hub-search hub-search--fill">
          <svg class="hub-search__icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M11.1 10.2a4.6 4.6 0 1 0-.9.9l3 3 .9-.9-3-3zm-4.1.3a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z" fill="currentColor" />
          </svg>
          <input
            v-model.trim="pkgQuery"
            type="search"
            class="hub-list-search"
            :placeholder="t('hub.python.pkgSearchPlaceholder')"
            :aria-label="t('hub.python.pkgSearchPlaceholder')"
          />
        </div>
        <span v-if="catalogState === 'ready'" class="hub-badge hub-python-badge-neutral">
          {{ t('hub.python.pkgCatalogCount', { count: catalog.length }) }}
        </span>
      </div>

      <div v-if="pkgQuery" class="hub-python__results">
        <!-- 目录加载失败：区别于「无匹配」，给出重试入口 -->
        <div v-if="catalogState === 'error'" class="hub-python__empty">
          <p class="hub-hint">{{ t('hub.python.pkgCatalogError') }}</p>
          <button type="button" class="hub-btn" @click="loadCatalog">
            {{ t('common.retry') }}
          </button>
        </div>
        <!-- 目录加载中：避免误报「没有匹配的包」 -->
        <div v-else-if="catalogState === 'loading'" class="hub-python__empty">
          <p class="hub-hint">{{ t('common.loading') }}</p>
        </div>
        <template v-else>
          <button
            v-for="hit in visibleHits"
            :key="hit.entry.name"
            type="button"
            class="hub-python__result"
            :class="{
              'hub-python__result--installed': isInstalled(hit.entry.name),
              'hub-python__result--pending': pendingInstall?.name === hit.entry.name,
              'hub-python__result--busy': busyPackage === hit.entry.name,
            }"
            :disabled="!!busyPackage"
            @click="requestInstall(hit.entry)"
          >
            <span class="hub-python__chip-name">{{ hit.entry.name }}</span>
            <!-- 别名命中提示：sklearn → scikit-learn -->
            <span v-if="hit.matchedAlias" class="hub-python__alias">{{ hit.matchedAlias }}</span>
            <span class="hub-python__chip-version">{{ hit.entry.version }}</span>
            <span v-if="isInstalled(hit.entry.name)" class="hub-python__installed">✓</span>
            <span v-else-if="busyPackage === hit.entry.name" class="hub-python__busy-mark">
              <span class="hub-python__spinner hub-python__spinner--sm" aria-hidden="true"></span>
            </span>
            <span v-else class="hub-python__result-action">
              {{ pendingInstall?.name === hit.entry.name ? t('hub.python.pkgPendingMark') : t('hub.python.pkgInstallAction') }}
            </span>
          </button>
          <div v-if="!searchHits.length && catalogState === 'ready'" class="hub-python__empty">
            <p class="hub-hint">{{ t('hub.python.pkgNotFound') }}</p>
            <p class="hub-hint hub-python__tip">{{ t('hub.python.pkgSearchTip') }}</p>
          </div>
          <div v-if="searchHits.length" class="hub-python__results-foot">
            <span class="hub-hint">
              {{ t('hub.python.pkgSearchCount', { count: searchHits.length }) }}
            </span>
            <button
              v-if="hiddenHitCount > 0"
              type="button"
              class="hub-python__more"
              @click="searchLimit += 16"
            >
              {{ t('hub.python.pkgSearchMore', { count: hiddenHitCount }) }}
            </button>
          </div>
        </template>
      </div>

      <!-- 安装确认条（搜索结果 / 常用包共用） -->
      <div v-if="pendingInstall" class="hub-python__confirm">
        <div class="hub-python__confirm-info">
          <span class="hub-python__chip-name">{{ pendingInstall.name }}</span>
          <span class="hub-python__chip-version">{{ pendingInstall.version }}</span>
          <span class="hub-python__confirm-hint">
            <template v-if="pendingDeps.length">
              {{ t('hub.python.pkgConfirmWithDeps', { deps: pendingDeps.join(', ') }) }}
            </template>
            <template v-else>{{ t('hub.python.pkgConfirmNoDeps') }}</template>
          </span>
        </div>
        <div class="hub-python__confirm-actions">
          <button
            type="button"
            class="hub-btn hub-btn-primary"
            :disabled="!!busyPackage"
            @click="confirmInstall"
          >
            {{ t('hub.python.pkgConfirmInstall') }}
          </button>
          <button type="button" class="hub-btn" :disabled="!!busyPackage" @click="cancelPendingInstall">
            {{ t('common.cancel') }}
          </button>
        </div>
      </div>

      <p
        v-if="installMessage"
        class="hub-hint hub-python__message"
        :class="{ 'hub-python__message--busy': !!busyPackage }"
      >{{ installMessage }}</p>
      <p class="hub-hint">{{ t('hub.python.pkgSourceNote') }}</p>
    </section>

    <!-- ══════════ 测试运行台（就绪后显示） ══════════ -->
    <section v-if="env.status === 'ready'" class="hub-python__card">
      <div class="hub-python__card-head">
        <h3 class="hub-python__card-title">{{ t('hub.python.consoleTitle') }}</h3>
        <button
          v-if="testOutcome"
          type="button"
          class="hub-btn hub-python__copy-btn"
          @click="copyOutput"
        >
          {{ copiedOutput ? t('hub.python.copied') : t('hub.python.copyOutput') }}
        </button>
      </div>
      <p class="hub-hint">{{ t('hub.python.consoleHint') }}</p>

      <!-- 代码片段（管理中心新增：常用范式一键载入，省去每次手写） -->
      <div class="hub-python__snippets">
        <span class="hub-python__sub-label">{{ t('hub.python.snippetTitle') }}</span>
        <div class="hub-python__chips">
          <button
            v-for="snippet in SNIPPETS"
            :key="snippet.id"
            type="button"
            class="hub-python__chip hub-python__chip--button"
            @click="loadSnippet(snippet)"
          >
            <span class="hub-python__chip-name">{{ snippet.label }}</span>
          </button>
        </div>
      </div>

      <textarea
        v-model="code"
        class="hub-python__code"
        rows="10"
        spellcheck="false"
        @keydown.ctrl.enter.prevent="runTest"
        @keydown.meta.enter.prevent="runTest"
      ></textarea>

      <div class="hub-python__console-actions">
        <button type="button" class="hub-btn hub-btn-primary" :disabled="runningTest" @click="runTest">
          {{ runningTest ? t('hub.python.consoleRunning') : t('hub.python.consoleRun') }}
        </button>
        <span v-if="testOutcome" class="hub-hint">{{ t('hub.python.durationInfo', { ms: testOutcome.durationMs }) }}</span>
      </div>

      <div v-if="testOutcome" class="hub-python__output">
        <div v-if="testOutcome.stdout" class="hub-python__output-block">
          <span class="hub-python__output-label">stdout</span>
          <pre>{{ testOutcome.stdout }}</pre>
        </div>
        <div v-if="testOutcome.result" class="hub-python__output-block">
          <span class="hub-python__output-label">result</span>
          <pre>{{ testOutcome.result }}</pre>
        </div>
        <div v-if="testOutcome.stderr" class="hub-python__output-block hub-python__output-block--stderr">
          <span class="hub-python__output-label">stderr</span>
          <pre>{{ testOutcome.stderr }}</pre>
        </div>
        <div v-if="!testOutcome.ok" class="hub-python__output-block hub-python__output-block--error">
          <span class="hub-python__output-label">{{ testOutcome.timedOut ? 'timeout' : 'error' }}</span>
          <pre>{{ testOutcome.timedOut ? t('hub.python.timeoutMessage') : testOutcome.errorDetail || testOutcome.errorName }}</pre>
        </div>
        <p v-if="testOutcome.ok && !testOutcome.stdout && !testOutcome.result && !testOutcome.stderr" class="hub-hint">
          {{ t('hub.python.consoleNoOutput') }}
        </p>
      </div>
    </section>

    <!-- ══════════ 隐私说明 ══════════ -->
    <p class="hub-hint hub-python__foot">{{ t('hub.python.privacyNote') }}</p>
  </div>
</template>

<script setup lang="ts">
/**
 * 管理中心「Python 环境」分区（下载 / 核验 / 包管理 / 测试运行）
 *
 * 数据流：
 * - 环境状态：chrome.storage.local（watchPyodideEnv 跨上下文订阅，与运行时 / 工具侧共享）
 * - 核心文件下载：downloadPyodideFile（进度 + 可取消 + IndexedDB 落盘）
 * - 核验：ensurePyodideRuntime + verifyPyodideRuntime（功能级冒烟测试），
 *   通过后写入 status='ready' —— 这是 python_run 工具与智能体编辑页
 *   「Python 计算」组可用性的唯一开关
 * - 包管理：锁文件目录（随扩展打包的 pyodide-lock.json）驱动，
 *   installPackages / uninstallPackages（wheel 经缓存层，sha256 校验）
 * - 测试运行台：与 python_run 工具完全同一执行管线（runPythonCode），
 *   在此验证的效果即智能体实际使用的效果
 *
 * 与原「设置弹窗 · Python 环境」的差异（只增不减）：
 *   - 视觉整体换成管理中心的液态玻璃卡片（中性黑白灰，无任何蓝紫）；
 *   - 新增「运行时详情」四宫格（CPython / Pyodide / 核验时间 / 本地缓存）；
 *   - 新增已装包计数、目录规模提示与「移除全部包」；
 *   - 新增代码片段一键载入与运行输出复制；
 *   - 危险操作（删环境 / 删包 / 清空全部包）改为行内二次确认，
 *     不再使用 window.confirm（原生模态在扩展页会冻结整页交互且样式不可控）。
 *
 * 实时同步：环境状态经 watchPyodideEnv 订阅 storage 变更——工具侧自动装包、
 * 侧边栏侧启停运行时等其它上下文写入后，本页视图立即跟随。
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { t } from '@/utils/i18n';
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

const props = defineProps<{
  /** 当前分区是否激活（激活时重新水合状态，保证跨上下文变更立刻可见） */
  active?: boolean;
}>();

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

/** 危险操作的行内二次确认状态（键 = 动作标识；null 表示未待确认） */
const armedAction = ref<string | null>(null);
let disarmTimer: ReturnType<typeof setTimeout> | undefined;

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
      return 'hub-python-badge-ok';
    case 'error':
      return 'hub-python-badge-bad';
    default:
      return 'hub-python-badge-warn';
  }
});

const statusBadgeText = computed(() => {
  if (downloading.value) return t('hub.python.statusDownloading');
  if (verifying.value) return t('hub.python.statusVerifying');
  switch (env.value.status) {
    case 'ready':
      return t('hub.python.statusReady');
    case 'error':
      return t('hub.python.statusError');
    default:
      return t('hub.python.statusIdle');
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

// ──── 危险操作：行内二次确认 ────

/** 首次点击进入待确认态；3 秒内再次点击才真正执行（防误触） */
function armAction(key: string, execute: () => void | Promise<void>): void {
  if (armedAction.value === key) {
    disarm();
    void execute();
    return;
  }
  armedAction.value = key;
  if (disarmTimer !== undefined) clearTimeout(disarmTimer);
  disarmTimer = setTimeout(() => {
    armedAction.value = null;
  }, 3000);
}

function disarm(): void {
  armedAction.value = null;
  if (disarmTimer !== undefined) {
    clearTimeout(disarmTimer);
    disarmTimer = undefined;
  }
}

// ──── 水合与目录 ────

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

/** 彻底删除 Python 环境（行内二次确认） */
function requestRemoveEnv(): void {
  armAction('remove-env', async () => {
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
    catalog.value = [];
    catalogState.value = 'loading';
    await hydrate();
  });
}

// ──── 包安装 / 卸载 ────

/** 点击搜索结果：已安装则提示；否则进入确认（不直接下载） */
function requestInstall(entry: PyodideCatalogEntry): void {
  if (busyPackage.value) return;
  if (isInstalled(entry.name)) {
    installMessage.value = t('hub.python.pkgAlreadyInstalled', {
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
  installMessage.value = t('hub.python.pkgInstalling', { name });
  try {
    const installed = await installPackages([name]);
    installMessage.value = installed.length
      ? t('hub.python.pkgInstalledOk', { name: installed[0].name, version: installed[0].version })
      : t('hub.python.pkgNotFound');
  } catch (error) {
    installMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    busyPackage.value = '';
    await hydrate();
  }
}

async function togglePackage(name: string): Promise<void> {
  if (isInstalled(name)) {
    requestUninstall(name);
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

/** 卸载单个包（行内二次确认） */
function requestUninstall(name: string): void {
  armAction(`pkg:${name}`, async () => {
    if (busyPackage.value) return;
    busyPackage.value = name;
    try {
      await uninstallPackages([name]);
      installMessage.value = t('hub.python.pkgRemoved', { name });
    } catch (error) {
      installMessage.value = error instanceof Error ? error.message : String(error);
    } finally {
      busyPackage.value = '';
      await hydrate();
    }
  });
}

/** 卸载全部已装包（行内二次确认） */
function requestRemoveAllPackages(): void {
  armAction('remove-all-pkgs', async () => {
    const names = installedPackages.value.map(pkg => pkg.name);
    if (!names.length) return;
    busyPackage.value = names.join(',');
    try {
      await uninstallPackages(names);
      installMessage.value = t('hub.python.pkgRemoved', { name: `${names.length} packages` });
    } catch (error) {
      installMessage.value = error instanceof Error ? error.message : String(error);
    } finally {
      busyPackage.value = '';
      await hydrate();
    }
  });
}

// ──── 代码片段 ────

interface Snippet {
  id: string;
  label: string;
  code: string;
}

/** 常用范式（一键载入测试台；标签为代码标识符，不做翻译） */
const SNIPPETS: readonly Snippet[] = [
  {
    id: 'version',
    label: 'sys.version',
    code: [
      'import sys',
      'print(sys.version)',
      'print(sys.executable)',
    ].join('\n'),
  },
  {
    id: 'json',
    label: 'json',
    code: [
      'import json',
      'data = {"name": "AgentNexus", "ok": True, "items": [1, 2, 3]}',
      'print(json.dumps(data, ensure_ascii=False, indent=2))',
      'data',
    ].join('\n'),
  },
  {
    id: 'numpy',
    label: 'numpy',
    code: [
      'import numpy as np',
      'a = np.arange(12).reshape(3, 4)',
      'print(a)',
      'print("sum:", a.sum(), "mean:", round(float(a.mean()), 4))',
      'a',
    ].join('\n'),
  },
  {
    id: 'pandas',
    label: 'pandas',
    code: [
      'import pandas as pd',
      'df = pd.DataFrame({"x": [1, 2, 3], "y": [4.5, 5.5, 6.5]})',
      'print(df.describe())',
      'df',
    ].join('\n'),
  },
  {
    id: 'sqlite',
    label: 'sqlite3',
    code: [
      'import sqlite3',
      'con = sqlite3.connect(":memory:")',
      'con.execute("create table t(id integer, name text)")',
      'con.execute("insert into t values (1, \'nexus\')")',
      'print(con.execute("select * from t").fetchall())',
    ].join('\n'),
  },
];

function loadSnippet(snippet: Snippet): void {
  code.value = snippet.code;
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

/** 复制运行输出（stdout / result / stderr 依次拼接） */
const copiedOutput = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

async function copyOutput(): Promise<void> {
  const outcome = testOutcome.value;
  if (!outcome) return;
  const text = [outcome.stdout, outcome.result, outcome.stderr]
    .filter(part => part && part.length > 0)
    .join('\n');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copiedOutput.value = true;
    if (copyTimer !== undefined) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copiedOutput.value = false; }, 2000);
  } catch (error) {
    copiedOutput.value = false;
    console.warn('[Hub] Python 输出复制失败:', error);
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

// 切到该分区时重新水合：跨上下文的变更（工具侧装包 / 侧边栏侧启停）立刻可见
watch(
  () => props.active,
  active => {
    if (active) void hydrate();
  },
);

// 查询变化：重置分页截断与待确认项，避免确认条指向过期搜索结果
watch(pkgQuery, () => {
  searchLimit.value = 8;
  pendingInstall.value = null;
});

onUnmounted(() => {
  unwatchEnv?.();
  if (disarmTimer !== undefined) clearTimeout(disarmTimer);
  if (copyTimer !== undefined) clearTimeout(copyTimer);
});
</script>

<style>
@import './python-section.css';
</style>
