/**
 * 插件中心状态与命令（模块级单例）
 *
 * 页面（PluginManager.vue）与各分区组件共享同一份状态：状态留在模块作用域，
 * usePluginCenter() 只做返回，任何组件调用都读写同一事实源（对齐仓库
 * channel-store 等存储型 composables 的做法）。
 *
 * - 快照同步在模块导入时即订阅，不依赖组件是否挂载（始终监听存储）；
 * - 文案一律走 utils/i18n 的模块级 t()——测试中组件独立挂载、未安装
 *   i18n 插件时依然可用，且 locale 切换可触发响应式重渲染；
 * - 标签导航状态机：预览成功切入「审查」并记录来源标签，确认安装后
 *   回到「已安装」，取消审查回到来源标签。
 */
import { computed, ref } from 'vue';
import { t } from '@/utils/i18n';
import { pluginRequest, refresh, startPluginClient } from '@/utils/plugins/client';
import { toBase64 } from '@/utils/plugins/codec';
import {
  getPluginSnapshot,
  onPluginsChange,
} from '@/utils/plugins/catalog';
import {
  invariant,
  LIMITS,
  type InstalledPlugin,
  type PluginPreview,
} from '@/utils/plugins/contracts';
import type { GithubCandidate } from '@/utils/plugins/github';
import type {
  PluginOperationAction,
  PluginOperationQuery,
  PluginOperationRecord,
} from '@/utils/plugins/operations';
import {
  OFFICIAL_CATALOG_PUBLIC_KEY,
  OFFICIAL_CATALOG_URL,
  isOfficialCatalogConfigured,
} from '@/utils/plugins/official-catalog';

export type PluginCenterTab =
  | 'installed'
  | 'discover'
  | 'review'
  | 'operations';

// ==================== 状态（模块级单例） ====================

const snapshot = ref(getPluginSnapshot());
const busy = ref(false);
const notice = ref<{ text: string; tone: 'ok' | 'error' } | null>(null);
const repository = ref('');
const query = ref('');
const filter = ref('');
const pending = ref<PluginPreview>();
const consent = ref(false);
const pendingData = ref('');
const pendingRepository = ref('');
const pendingRollback = ref(false);
/** 是否已执行过搜索 / 目录加载（区分「初始引导」与「无结果」两种空态） */
const discovered = ref(false);
const catalogUrl = ref('');
const catalogKey = ref('');
// —— 发现页：官方目录为主、社区搜索为辅 ——
/** 官方 + 自定义目录条目（按 repository 去重，先到先占） */
const catalogResults = ref<GithubCandidate[]>([]);
/** GitHub 社区搜索结果（显式按钮触发） */
const communityResults = ref<GithubCandidate[]>([]);
/** 官方目录状态：未部署 / 加载中 / 就绪 / 失败（idle 仅首帧） */
const catalogState = ref<'idle' | 'unconfigured' | 'loading' | 'ok' | 'failed'>(
  isOfficialCatalogConfigured() ? 'idle' : 'unconfigured',
);
/** 官方目录内存缓存新鲜度（5 分钟内不重复拉取） */
let catalogFetchedAt = 0;
// —— 自动更新检查（check-updates 结果，键为 pluginKey） ——
const updates = ref<Record<string, { version: string; digest: string }>>({});
const secrets = ref<Record<string, string>>({});
const versions = ref<Record<string, { version: string; digest: string }[]>>({});
// —— 操作日志（导入/更新/卸载/启动对账） ——
const operations = ref<PluginOperationRecord[]>([]);
const operationsLoading = ref(false);
const operationFilter = ref<{
  pluginKey: string;
  action: '' | PluginOperationAction;
  status: '' | 'success' | 'failure';
}>({ pluginKey: '', action: '', status: '' });

const activeTab = ref<PluginCenterTab>('installed');
/** 审查来源标签：取消审查后回到进入前的分区 */
const reviewOrigin = ref<PluginCenterTab>('installed');

// 快照同步：导入即订阅，存储变更实时反映到列表（组件挂不挂载都生效）
onPluginsChange(() => {
  snapshot.value = getPluginSnapshot();
});

// ==================== 派生 ====================

const installed = computed(() =>
  snapshot.value.packages.filter((p) =>
    `${p.key} ${p.manifest.displayName} ${p.manifest.publisher.displayName}`
      .toLowerCase()
      .includes(filter.value.toLowerCase()),
  ),
);

const installedTotal = computed(() => snapshot.value.packages.length);
const hasPendingReview = computed(() => !!pending.value);

/** 目录条目按当前关键词的本地过滤（空关键词显示全部，不区分大小写包含） */
const officialMatches = computed(() => {
  const q = query.value.trim().toLowerCase();
  return q
    ? catalogResults.value.filter((c) =>
        `${c.name} ${c.description} ${c.repository}`.toLowerCase().includes(q),
      )
    : catalogResults.value;
});
/** 发现页展示列表：目录结果在前（已验签徽章），社区结果按 repository 去重追加 */
const discoverResults = computed(() => {
  const q = query.value.trim().toLowerCase(),
    seen = new Set(officialMatches.value.map((c) => c.repository));
  const community = communityResults.value.filter((c) => {
    if (seen.has(c.repository)) return false;
    seen.add(c.repository);
    return (
      !q ||
      `${c.name} ${c.description} ${c.repository}`.toLowerCase().includes(q)
    );
  });
  return [...officialMatches.value, ...community];
});

// ==================== 提示条 ====================

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function showNotice(text: string, tone: 'ok' | 'error' = 'ok'): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  notice.value = { text, tone };
  // 成功提示 6 秒自动消失；错误提示保留到手动关闭或下一次操作开始
  if (tone === 'ok') {
    noticeTimer = setTimeout(() => {
      notice.value = null;
      noticeTimer = null;
    }, 6000);
  } else {
    noticeTimer = null;
  }
}

function dismissNotice(): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = null;
  notice.value = null;
}

// ==================== 标签导航 ====================

function goToTab(tab: PluginCenterTab): void {
  activeTab.value = tab;
  // 进入发现页即静默拉取官方目录（未部署则保持降级空态）
  if (tab === 'discover') void ensureOfficialCatalog();
  if (tab === 'operations') void loadOperations();
}

/** 拿到待审查安装后切入审查标签（记录来源，便于取消后返回） */
function adoptReviewTab(): void {
  if (activeTab.value !== 'review') reviewOrigin.value = activeTab.value;
  activeTab.value = 'review';
}

// ==================== 通用执行器 ====================

async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  dismissNotice();
  try {
    await action();
  } catch (e) {
    showNotice(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    busy.value = false;
  }
}

let clientReady = false;
async function load(): Promise<void> {
  if (clientReady) await refresh();
  else {
    // 首次加载由 startPluginClient 完成监听注册与首轮快照。
    await startPluginClient();
    clientReady = true;
  }
  snapshot.value = getPluginSnapshot();
}

// ==================== 操作日志 ====================

async function loadOperations(): Promise<void> {
  if (operationsLoading.value) return;
  operationsLoading.value = true;
  try {
    const filter: PluginOperationQuery = { limit: 100 };
    if (operationFilter.value.pluginKey)
      filter.pluginKey = operationFilter.value.pluginKey;
    if (operationFilter.value.action)
      filter.action = operationFilter.value.action;
    if (operationFilter.value.status)
      filter.status = operationFilter.value.status;
    operations.value = await pluginRequest<PluginOperationRecord[]>(
      'operations',
      filter,
    );
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    operationsLoading.value = false;
  }
}

async function clearOperations(): Promise<void> {
  if (!window.confirm(t('hub.plugins.operationsClearConfirm'))) return;
  await run(async () => {
    await pluginRequest('operations-clear', {});
    operations.value = [];
    showNotice(t('hub.plugins.operationsCleared'));
  });
}

// ==================== 预览与安装 ====================

function clearPreview(): void {
  pending.value = undefined;
  pendingData.value = '';
  pendingRepository.value = '';
  consent.value = false;
  pendingRollback.value = false;
}

/** 取消审查：清空预览并回到进入审查前的标签 */
function cancelReview(): void {
  clearPreview();
  activeTab.value = reviewOrigin.value;
}

async function importFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  await run(async () => {
    clearPreview();
    invariant(file.size <= LIMITS.archive, 'ARCHIVE_LIMIT');
    pendingData.value = toBase64(new Uint8Array(await file.arrayBuffer()));
    pending.value = await pluginRequest('preview', { data: pendingData.value });
    adoptReviewTab();
  });
}

async function previewGithub(
  url: string,
  key?: string,
  expected?: GithubCandidate,
): Promise<void> {
  await run(async () => {
    clearPreview();
    const result = await pluginRequest('github-preview', {
      repository: url,
      ...(key ? { key } : {}),
    });
    if (expected?.verifiedCatalog)
      invariant(
        result.preview.plugin.key === expected.key &&
          result.preview.plugin.digest === expected.digest &&
          result.preview.plugin.manifest.version === expected.version,
        'CATALOG_RELEASE_MISMATCH',
      );
    pending.value = result.preview;
    pendingRepository.value = url;
    adoptReviewTab();
  });
}

async function install(): Promise<void> {
  await run(async () => {
    invariant(pending.value && consent.value, 'CONSENT_REQUIRED');
    const p = pending.value;
    if (pendingRollback.value)
      await pluginRequest('rollback-install', {
        key: p.plugin.key,
        version: p.plugin.manifest.version,
        generation: p.generation,
        digest: p.plugin.digest,
      });
    else
      await pluginRequest(
        pendingRepository.value ? 'github-install' : 'install',
        pendingRepository.value
          ? {
              repository: pendingRepository.value,
              key: p.plugin.key,
              generation: p.generation,
              digest: p.plugin.digest,
            }
          : {
              data: pendingData.value,
              generation: p.generation,
              digest: p.plugin.digest,
            },
      );
    clearPreview();
    activeTab.value = 'installed';
    await load();
    await loadOperations();
    showNotice(t('hub.plugins.installedOk'));
  });
}

// ==================== 已安装操作 ====================

async function listVersions(p: InstalledPlugin): Promise<void> {
  await run(async () => {
    versions.value[p.key] = await pluginRequest('versions', { key: p.key });
  });
}

async function rollback(key: string, version: string): Promise<void> {
  await run(async () => {
    clearPreview();
    pending.value = await pluginRequest('rollback-preview', { key, version });
    pendingRollback.value = true;
    adoptReviewTab();
  });
}

async function toggle(p: InstalledPlugin): Promise<void> {
  await run(async () => {
    await pluginRequest('enable', {
      key: p.key,
      enabled: !p.enabled,
      generation: snapshot.value.generation,
    });
    await load();
    await loadOperations();
  });
}

async function remove(p: InstalledPlugin): Promise<void> {
  // 卸载被依赖插件会让依赖者立即变为不可用；确认框必须展示影响面。
  const dependents = snapshot.value.packages.filter(
    (candidate) =>
      candidate.key !== p.key &&
      candidate.enabled &&
      Object.prototype.hasOwnProperty.call(
        candidate.manifest.dependencies,
        p.key,
      ),
  );
  const message = dependents.length
    ? t('hub.plugins.uninstallDependents', {
        name: p.manifest.displayName,
        list: dependents.map((x) => x.manifest.displayName).join(', '),
      })
    : t('hub.plugins.uninstallConfirm', { name: p.manifest.displayName });
  if (!window.confirm(message)) return;
  await run(async () => {
    await pluginRequest('uninstall', {
      key: p.key,
      generation: snapshot.value.generation,
    });
    await load();
    await loadOperations();
  });
}

async function saveSecret(key: string, slot: string): Promise<void> {
  await run(async () => {
    const id = `${key}/${slot}`;
    await pluginRequest('secret', {
      key,
      slot,
      value: secrets.value[id] ?? '',
    });
    delete secrets.value[id];
    showNotice(t('hub.plugins.secretUpdated'));
  });
}

async function exportPlugin(p: InstalledPlugin): Promise<void> {
  await run(async () => {
    const data = await pluginRequest<string>('export', { key: p.key });
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes]));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.manifest.id}-${p.manifest.version}.anplugin`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showNotice(t('hub.plugins.exportDone', { file: a.download }));
  });
}

// ==================== 发现（官方目录为主 / 社区搜索为辅） ====================

/** 目录条目并入（按 repository 去重，已有条目优先保留） */
function mergeCatalog(list: GithubCandidate[]): void {
  const seen = new Set(catalogResults.value.map((c) => c.repository));
  catalogResults.value = [
    ...catalogResults.value,
    ...list.filter((c) => !seen.has(c.repository)),
  ];
}

/**
 * 静默拉取官方目录（内置 URL + 公钥，用户不可见）。
 * 失败不打横幅：离线/限流不影响已安装插件；已有缓存结果则原样保留。
 */
async function ensureOfficialCatalog(force = false): Promise<void> {
  if (!isOfficialCatalogConfigured()) {
    catalogState.value = 'unconfigured';
    return;
  }
  if (
    !force &&
    (catalogState.value === 'loading' ||
      (catalogState.value === 'ok' && Date.now() - catalogFetchedAt < 300_000))
  )
    return;
  catalogState.value = 'loading';
  try {
    mergeCatalog(
      await pluginRequest<GithubCandidate[]>('catalog', {
        url: OFFICIAL_CATALOG_URL,
        publicKey: OFFICIAL_CATALOG_PUBLIC_KEY,
      }),
    );
    catalogFetchedAt = Date.now();
    catalogState.value = 'ok';
    discovered.value = true;
  } catch {
    catalogState.value = catalogResults.value.length ? 'ok' : 'failed';
  }
}

/** GitHub 社区搜索（显式触发；结果带社区徽章追加在目录结果之后） */
async function search(): Promise<void> {
  await run(async () => {
    communityResults.value = await pluginRequest('search', {
      query: query.value,
    });
    discovered.value = true;
  });
}

/** 自定义目录源（高级）：用户手填 URL + 公钥，结果并入目录条目 */
async function loadCatalog(): Promise<void> {
  await run(async () => {
    mergeCatalog(
      await pluginRequest('catalog', {
        url: catalogUrl.value,
        publicKey: catalogKey.value,
      }),
    );
    catalogFetchedAt = Date.now();
    catalogState.value = 'ok';
    discovered.value = true;
  });
}

// ==================== 自动更新检查 ====================

/**
 * 打开插件中心后静默检查（后台 6 小时节流 + 逐项容错）；
 * 仅提示有新版本，安装仍走审查确认。失败完全静默。
 */
async function checkUpdates(): Promise<void> {
  try {
    const list = await pluginRequest<
      { key: string; version: string; digest: string }[]
    >('check-updates');
    updates.value = Object.fromEntries(list.map((u) => [u.key, u]));
    if (list.length)
      showNotice(t('hub.plugins.updatesNotice', { count: list.length }));
  } catch {
    // 更新检查失败不影响任何功能，不打扰用户
  }
}

// ==================== 对外 ====================

export function usePluginCenter() {
  return {
    // 状态
    snapshot,
    busy,
    notice,
    repository,
    query,
    filter,
    pending,
    consent,
    pendingRollback,
    discovered,
    catalogResults,
    communityResults,
    catalogState,
    updates,
    catalogUrl,
    catalogKey,
    secrets,
    versions,
    operations,
    operationsLoading,
    operationFilter,
    activeTab,
    reviewOrigin,
    // 派生
    installed,
    installedTotal,
    hasPendingReview,
    officialMatches,
    discoverResults,
    // 命令
    showNotice,
    dismissNotice,
    goToTab,
    adoptReviewTab,
    run,
    load,
    clearPreview,
    cancelReview,
    importFile,
    previewGithub,
    install,
    listVersions,
    rollback,
    toggle,
    remove,
    search,
    loadCatalog,
    ensureOfficialCatalog,
    checkUpdates,
    saveSecret,
    exportPlugin,
    loadOperations,
    clearOperations,
  };
}
