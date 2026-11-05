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
import {
  pluginRequest,
  encodeBytes,
  startPluginClient,
} from '@/utils/plugins/client';
import {
  getPluginSnapshot,
  onPluginsChange,
  applyPluginSnapshot,
} from '@/utils/plugins/catalog';
import {
  invariant,
  LIMITS,
  type InstalledPlugin,
  type PluginPreview,
} from '@/utils/plugins/contracts';
import type { GithubCandidate } from '@/utils/plugins/github';

export type PluginCenterTab = 'installed' | 'discover' | 'review';

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
const results = ref<GithubCandidate[]>([]);
/** 是否已执行过搜索 / 目录加载（区分「初始引导」与「无结果」两种空态） */
const discovered = ref(false);
const catalogUrl = ref('');
const catalogKey = ref('');
const secrets = ref<Record<string, string>>({});
const versions = ref<Record<string, { version: string; digest: string }[]>>({});

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

async function load(): Promise<void> {
  await startPluginClient();
  snapshot.value = await pluginRequest('snapshot');
  applyPluginSnapshot(snapshot.value);
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
    pendingData.value = encodeBytes(new Uint8Array(await file.arrayBuffer()));
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
  });
}

async function remove(p: InstalledPlugin): Promise<void> {
  if (
    !window.confirm(
      t('hub.plugins.uninstallConfirm', { name: p.manifest.displayName }),
    )
  )
    return;
  await run(async () => {
    await pluginRequest('uninstall', {
      key: p.key,
      generation: snapshot.value.generation,
    });
    await load();
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

// ==================== 发现（社区搜索 / 签名目录） ====================

async function search(): Promise<void> {
  await run(async () => {
    results.value = await pluginRequest('search', { query: query.value });
    discovered.value = true;
  });
}

async function loadCatalog(): Promise<void> {
  await run(async () => {
    results.value = await pluginRequest('catalog', {
      url: catalogUrl.value,
      publicKey: catalogKey.value,
    });
    discovered.value = true;
  });
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
    results,
    discovered,
    catalogUrl,
    catalogKey,
    secrets,
    versions,
    activeTab,
    reviewOrigin,
    // 派生
    installed,
    installedTotal,
    hasPendingReview,
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
    saveSecret,
    exportPlugin,
  };
}
