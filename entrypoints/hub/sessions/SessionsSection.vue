<template>
  <div class="hub-sessions">
    <!-- ══════════ 头部：标题 / 计数 ══════════ -->
    <header class="hub-sessions__head">
      <div class="hub-sessions__head-main">
        <div class="hub-sessions__title-row">
          <h2 class="hub-sessions__title">{{ t('hub.sessions.title') }}</h2>
          <span class="hub-badge hub-sessions-badge-neutral">
            {{ t('hub.sessions.total', { count: sessions.length }) }}
          </span>
          <span v-if="archivedSessions.length" class="hub-badge hub-sessions-badge-neutral">
            {{ t('hub.sessions.archivedTotal', { count: archivedSessions.length }) }}
          </span>
        </div>
        <p class="hub-hint">{{ t('hub.sessions.subtitle') }}</p>
      </div>
      <div class="hub-sessions__head-actions">
        <button type="button" class="hub-btn" :disabled="loading" @click="reload()">
          {{ t('hub.sessions.refresh') }}
        </button>
      </div>
    </header>

    <!-- 反馈条：成功提示 / 加载失败（非阻塞；破坏性确认一律走弹窗） -->
    <p v-if="notice" class="hub-sessions__notice" role="status">{{ notice }}</p>
    <p v-if="loadError" class="hub-sessions__load-error" role="alert">
      {{ t('hub.sessions.loadFailed', { reason: loadError }) }}
    </p>

    <!-- ══════════ 工具栏：搜索 + 内容搜索开关 + 视图切换 ══════════ -->
    <div class="hub-sessions__toolbar">
      <div class="hub-search hub-search--fill hub-sessions__search">
        <svg class="hub-search__icon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M11.1 10.2a4.6 4.6 0 1 0-.9.9l3 3 .9-.9-3-3zm-4.1.3a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z" fill="currentColor" />
        </svg>
        <input
          v-model.trim="query"
          type="search"
          class="hub-list-search"
          :placeholder="contentSearch
            ? t('hub.sessions.searchContentPlaceholder')
            : t('hub.sessions.searchPlaceholder')"
          :aria-label="t('hub.sessions.searchPlaceholder')"
        />
      </div>
      <HubSwitch
        v-model="contentSearch"
        class="hub-sessions__content-switch"
        :aria-label="t('hub.sessions.searchContentToggle')"
        :title="t('hub.sessions.searchContentHint')"
      >
        {{ t('hub.sessions.searchContentToggle') }}
      </HubSwitch>
      <span v-if="contentSearching" class="hub-sessions__searching" role="status">
        {{ t('hub.sessions.searching') }}
      </span>
      <HubSegmented
        v-model="view"
        class="hub-sessions__view"
        :options="viewOptions"
        :aria-label="t('hub.sessions.viewAll')"
      />
    </div>

    <!-- ══════════ 滚动区：唯一出现滚动条的容器 ══════════ -->
    <div class="hub-sessions__scroll">
      <!-- 归档视图：保留策略设置卡（自动删除 + 保留天数） -->
      <section v-if="view === 'archived'" class="hub-sessions__policy" :aria-label="t('hub.sessions.autoDeleteTitle')">
        <div class="hub-sessions__policy-head">
          <h3 class="hub-sessions__policy-title">{{ t('hub.sessions.autoDeleteTitle') }}</h3>
          <HubSwitch
            :model-value="policy.autoDelete"
            :aria-label="t('hub.sessions.autoDeleteTitle')"
            @update:model-value="onAutoDeleteChange"
          />
        </div>
        <p class="hub-hint">
          {{ t('hub.sessions.autoDeleteHint', { days: policy.retentionDays }) }}
        </p>
        <label class="hub-sessions__retention">
          <span class="hub-sessions__retention-label">{{ t('hub.sessions.retentionLabel') }}</span>
          <input
            v-model.number="retentionInput"
            type="number"
            class="hub-sessions__retention-input"
            :min="SESSION_ARCHIVE_MIN_RETENTION_DAYS"
            :max="SESSION_ARCHIVE_MAX_RETENTION_DAYS"
            :disabled="!policy.autoDelete"
            @change="saveRetention"
          />
        </label>
      </section>

      <!-- 加载 / 空态 -->
      <div v-if="loading && !rows.length" class="hub-empty">{{ t('common.loading') }}</div>
      <div v-else-if="!rows.length" class="hub-empty">
        {{ view === 'archived' ? t('hub.sessions.archivedEmpty') : emptyLabel }}
      </div>

      <!-- 会话列表 -->
      <ul v-else class="hub-sessions__list">
        <li
          v-for="row in rows"
          :key="row.chatId"
          class="hub-sessions__row"
          :class="{ 'is-current': row.chatId === activeChatId }"
        >
          <!-- 行内重命名 -->
          <div v-if="renamingId === row.chatId" class="hub-sessions__rename" @click.stop>
            <input
              ref="renameInputRef"
              v-model="renameValue"
              class="hub-sessions__rename-input"
              :placeholder="row.title"
              :aria-label="t('hub.sessions.rename')"
              @keydown.enter="commitRename"
              @keydown.esc="cancelRename"
            />
            <button type="button" class="hub-icon-btn" :title="t('common.confirm')" @click="commitRename">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9,16.17L4.83,12L3.41,13.41L9,19L21,7L19.59,5.59L9,16.17Z" fill="currentColor" /></svg>
            </button>
            <button type="button" class="hub-icon-btn" :title="t('common.cancel')" @click="cancelRename">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor" /></svg>
            </button>
          </div>

          <template v-else>
            <div class="hub-sessions__row-head">
              <span class="hub-sessions__row-title" :title="row.title">{{ row.title }}</span>
              <span v-if="busyIds.has(row.chatId)" class="hub-badge hub-sessions-badge-run">
                {{ t('hub.sessions.runningBadge') }}
              </span>
              <span v-if="row.chatId === activeChatId" class="hub-badge hub-sessions-badge-current">
                {{ t('hub.sessions.currentBadge') }}
              </span>
              <span v-if="row.archivedAt" class="hub-badge hub-sessions-badge-neutral">
                {{ t('hub.sessions.archivedBadge') }}
              </span>
              <span v-if="row.kind === 'site-learn'" class="hub-badge hub-sessions-badge-neutral">
                {{ t('hub.sessions.learnBadge') }}
              </span>
              <span class="hub-sessions__row-time">{{ formatRelativeTime(row.updatedAt) }}</span>
            </div>
            <div class="hub-sessions__row-preview">{{ row.lastMessagePreview || '—' }}</div>
            <!-- 内容搜索命中：条数 + 上下文片段 -->
            <div v-if="contentHitLabelOf(row)" class="hub-sessions__row-hit">
              {{ contentHitLabelOf(row) }}
            </div>
            <div class="hub-sessions__row-meta">
              <span v-if="row.agentName" class="hub-badge hub-sessions-badge-neutral">{{ row.agentName }}</span>
              <span>{{ t('hub.sessions.messages', { count: row.messageCount }) }}</span>
              <span v-if="row.archivedAt" class="hub-sessions__row-retention">
                {{ retentionLabelOf(row) }}
              </span>
              <span class="hub-sessions__row-ops">
                <button
                  type="button"
                  class="hub-icon-btn"
                  :title="t('hub.sessions.open')"
                  :disabled="pendingAction === row.chatId"
                  @click="openInSidebar(row)"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14,3V5H17.59L7.76,14.83L9.17,16.24L19,6.41V10H21V3M19,19H5V5H12V3H5A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V12H19V19Z" fill="currentColor" /></svg>
                </button>
                <button
                  type="button"
                  class="hub-icon-btn"
                  :title="t('hub.sessions.rename')"
                  :disabled="pendingAction === row.chatId"
                  @click="startRename(row)"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87L20.71,7.04M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z" fill="currentColor" /></svg>
                </button>
                <button
                  v-if="!row.archivedAt"
                  type="button"
                  class="hub-icon-btn"
                  :title="t('hub.sessions.archive')"
                  :disabled="pendingAction === row.chatId"
                  @click="archiveSession(row)"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20,8H17V6A2,2 0 0,0 15,4H9A2,2 0 0,0 7,6V8H4A2,2 0 0,0 2,10V19A2,2 0 0,0 4,21H20A2,2 0 0,0 22,19V10A2,2 0 0,0 20,8M9,6H15V8H9V6M20,19H4V10H20V19Z" fill="currentColor" /></svg>
                </button>
                <button
                  v-else
                  type="button"
                  class="hub-icon-btn"
                  :title="t('hub.sessions.unarchive')"
                  :disabled="pendingAction === row.chatId"
                  @click="unarchiveSession(row)"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20,8H17V6A2,2 0 0,0 15,4H9A2,2 0 0,0 7,6V8H4A2,2 0 0,0 2,10V19A2,2 0 0,0 4,21H20A2,2 0 0,0 22,19V10A2,2 0 0,0 20,8M9,6H15V8H9V6M13,16L8.5,11.5L9.91,10.09L13,13.17L18.09,8.09L19.5,9.5L13,16Z" fill="currentColor" /></svg>
                </button>
                <button
                  type="button"
                  class="hub-icon-btn hub-icon-btn--danger"
                  :title="t('hub.sessions.delete')"
                  :disabled="pendingAction === row.chatId"
                  @click="requestDelete(row)"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z" fill="currentColor" /></svg>
                </button>
              </span>
            </div>
          </template>
        </li>
      </ul>

      <div v-if="hasMore" class="hub-sessions__more">
        <button type="button" class="hub-btn" :disabled="loadingMore" @click="loadMore()">
          {{ loadingMore ? t('common.loading') : t('hub.sessions.loadMore') }}
        </button>
      </div>
    </div>

    <!-- ══════════ 删除二次确认（自定义弹窗，绝不用 window.confirm） ══════════ -->
    <HubDialog
      :visible="deleteDialog.visible"
      :title="t('hub.sessions.deleteConfirmTitle')"
      :message="deleteConfirmMessage"
      tone="error"
      :confirm-text="deleteDialog.busy ? t('hub.sessions.deleteBusy') : t('common.delete')"
      :cancel-text="t('common.cancel')"
      :busy="deleteDialog.busy"
      @confirm="confirmDelete"
      @cancel="closeDeleteDialog"
    />

    <!-- ══════════ 提示弹窗（运行中 / 侧边栏未开 / 操作失败） ══════════ -->
    <HubDialog
      :visible="alertDialog.visible"
      :title="alertDialog.title"
      :message="alertDialog.message"
      :tone="alertDialog.tone"
      :confirm-text="t('common.noticeConfirm')"
      cancel-text=""
      @confirm="alertDialog.visible = false"
      @cancel="alertDialog.visible = false"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 管理中心「会话管理」分区 —— 全部会话的检索 / 归档 / 删除
 *
 * 数据面：
 *   - 会话列表 / 重命名 / 归档：直接经转录引擎与会话库读写（与侧边栏同一份
 *     IndexedDB 权威源），任一上下文的改动经 session-bridge 广播实时回流；
 *   - 删除：一律走会话删除引擎（唯一编排入口，级联清理全部绑定数据）；
 *   - 运行态：后台 worker ∪ 侧边栏本地引擎双来源汇总（listBusySessions），
 *     在「打开 / 删除」前拦截，运行中给出等待提示；
 *   - 归档保留策略：session-archive-policy 单一事实源，到期清理由
 *     session-archive-sweeper 执行（切到本分区 / 收到广播 / 改策略时触发）。
 *
 * 布局契约（用户明确要求）：**右侧内容整体不出现滚动条** —— 头部 / 工具栏
 * 固定，只有 .hub-sessions__scroll 这一个会话元素容器在超出时出现滚动条。
 * 弹性链：.hub-content-body → .api-section → .hub-sessions → __scroll，
 * 各级 flex + min-height:0（与智能体 / 技能编辑器的填满态同一套机制）。
 *
 * 防御性约定：
 *   - 所有异步动作带 generation / 竞态守卫，旧结果不覆盖新状态；
 *   - 运行态检查与动作执行之间存在时间窗：删除仍由引擎内部中止运行兜底，
 *     打开由侧边栏二次校验拒绝 —— 双侧各自防御，不依赖单次查询；
 *   - 不使用 window.confirm / window.alert（原生模态冻结整页且样式不可控），
 *     破坏性操作一律走 HubDialog 自定义弹窗。
 */
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from 'vue';
import { t, useLocale } from '@/utils/i18n';
import { chatDatabase } from '@/entrypoints/sidepanel/core/context/chat-database';
import { transcriptEngine } from '@/entrypoints/sidepanel/core/context/transcript-engine';
import { sessionDeletionEngine } from '@/entrypoints/sidepanel/core/context/session-deletion-engine';
import type { ChatSessionMeta } from '@/entrypoints/sidepanel/core/types';
import HubSegmented from '../components/HubSegmented.vue';
import HubSwitch from '../components/HubSwitch.vue';
import HubDialog from '../components/HubDialog.vue';
import {
  listBusySessions,
  notifySessionDeleted,
  readSidepanelActiveChatId,
  requestOpenInSidepanel,
  watchSessionsChanged,
} from '@/utils/sessions/session-bridge';
import {
  loadSessionArchivePolicy,
  saveSessionArchivePolicy,
  watchSessionArchivePolicy,
  SESSION_ARCHIVE_MIN_RETENTION_DAYS,
  SESSION_ARCHIVE_MAX_RETENTION_DAYS,
  type SessionArchivePolicy,
} from '@/utils/sessions/session-archive-policy';
import { sweepExpiredArchivedSessions } from '@/utils/sessions/session-archive-sweeper';

const props = defineProps<{
  /** 当前分区是否激活（激活时重新水合，保证跨上下文变更立刻可见） */
  active?: boolean;
}>();

const { locale } = useLocale();

// ==================== 列表状态 ====================

/** 单页大小（与侧边栏历史抽屉同量级；超出走「加载更多」） */
const PAGE_SIZE = 100;

const sessions = ref<ChatSessionMeta[]>([]);
const archivedSessions = ref<ChatSessionMeta[]>([]);
const view = ref<'all' | 'archived'>('all');
const loading = ref(false);
const loadingMore = ref(false);
const loadError = ref('');
/** 当前视图是否还有更多（两个视图各自跟踪） */
const hasMoreAll = ref(false);
const hasMoreArchived = ref(false);
/** 正在执行的会话（后台 ∪ 侧边栏本地；定时与事件双驱动刷新） */
const busyIds = ref<Set<string>>(new Set());
/** 侧边栏当前打开的会话（高亮 + 删除后是否需要通知侧边栏换新会话的判据） */
const activeChatId = ref('');
/** 行内动作进行中（禁用该行按钮，防重复提交） */
const pendingAction = ref('');

const hasMore = computed(() => (view.value === 'archived' ? hasMoreArchived.value : hasMoreAll.value));

const viewOptions = computed(() => [
  { value: 'all', label: t('hub.sessions.viewAll') },
  { value: 'archived', label: t('hub.sessions.viewArchived') },
]);

const emptyLabel = computed(() => (query.value.trim() ? t('hub.sessions.noMatch') : t('hub.sessions.empty')));

/** 当前视图的原始行（未应用搜索过滤） */
const scopeRows = computed(() => (view.value === 'archived' ? archivedSessions.value : sessions.value));

/**
 * 应用搜索过滤后的展示行。
 * 标题命中恒真；开启内容搜索时，正文命中同样放行（contentHits 驱动）。
 */
const rows = computed(() => {
  const needle = query.value.trim().toLowerCase();
  const list = scopeRows.value;
  if (!needle) return list;
  return list.filter(session => {
    if (session.title.toLowerCase().includes(needle)) return true;
    if (contentSearch.value && contentHits.value?.has(session.chatId)) return true;
    return false;
  });
});

// ==================== 搜索（标题 + 可选内容） ====================

const query = ref('');
/** 内容搜索开关（默认关闭：正文匹配是额外开销，按需开启） */
const contentSearch = ref(false);
const contentSearching = ref(false);
/** chatId → 命中信息（null = 未启用内容搜索 / 无命中） */
const contentHits = ref<Map<string, { count: number; snippet: string }> | null>(null);

/** 搜索代次：切换查询后作废旧一轮结果，防止慢查询覆盖新查询 */
let searchGeneration = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

function contentHitOf(chatId: string): { count: number; snippet: string } | undefined {
  return contentHits.value?.get(chatId);
}

/** 行内命中文案（未命中返回空串，v-if 据此隐藏） */
function contentHitLabelOf(row: ChatSessionMeta): string {
  const hit = contentHitOf(row.chatId);
  if (!hit) return '';
  return `${t('hub.sessions.contentHit', { count: hit.count })} · ${hit.snippet}`;
}

/** 防抖触发内容搜索（300ms；与列表过滤解耦 —— 过滤即时，正文扫描延后） */
function scheduleContentSearch(): void {
  if (searchTimer) clearTimeout(searchTimer);
  if (!contentSearch.value || !query.value.trim()) {
    contentHits.value = null;
    contentSearching.value = false;
    searchGeneration++;
    return;
  }
  searchTimer = setTimeout(() => void runContentSearch(), 300);
}

/** 执行内容搜索：在当前视图范围内逐会话扫描正文（分批并发 + 代次守卫） */
async function runContentSearch(): Promise<void> {
  const generation = ++searchGeneration;
  const needle = query.value.trim();
  if (!needle || !contentSearch.value) {
    contentHits.value = null;
    contentSearching.value = false;
    return;
  }
  contentSearching.value = true;
  const hits = new Map<string, { count: number; snippet: string }>();
  try {
    const targets = scopeRows.value.filter(session => (session.messageCount ?? 0) > 0);
    // 分批并发：一次性 Promise.all 会对大会话数开上百个 IDB 事务
    const CHUNK = 8;
    for (let i = 0; i < targets.length; i += CHUNK) {
      if (generation !== searchGeneration) return; // 已被更新的查询取代
      const chunk = targets.slice(i, i + CHUNK);
      const results = await Promise.all(
        chunk.map(async session => ({
          chatId: session.chatId,
          match: await chatDatabase.findContentMatch(session.chatId, needle),
        })),
      );
      if (generation !== searchGeneration) return;
      for (const { chatId, match } of results) {
        if (match) hits.set(chatId, match);
      }
    }
    if (generation !== searchGeneration) return;
    contentHits.value = hits;
  } catch (error) {
    if (generation !== searchGeneration) return;
    console.warn('[SessionsSection] 内容搜索失败:', error);
    contentHits.value = new Map();
    showNotice(t('hub.sessions.searchFailed'));
  } finally {
    if (generation === searchGeneration) contentSearching.value = false;
  }
}

// ==================== 归档保留策略 ====================

const policy = ref<SessionArchivePolicy>({ autoDelete: true, retentionDays: 30 });
const retentionInput = ref<number>(policy.value.retentionDays);

/** 归档行的保留期文案：到期自动删除日期 / 已关闭 */
function retentionLabelOf(row: ChatSessionMeta): string {
  if (!policy.value.autoDelete) return t('hub.sessions.autoDeleteOff');
  const archivedAt = Number(row.archivedAt);
  if (!Number.isFinite(archivedAt)) return '';
  const due = new Date(archivedAt + policy.value.retentionDays * 24 * 60 * 60 * 1000);
  return t('hub.sessions.autoDeleteAt', { date: formatDate(due) });
}

async function onAutoDeleteChange(value: boolean): Promise<void> {
  policy.value = await saveSessionArchivePolicy({ autoDelete: value });
  showNotice(t('hub.sessions.retentionSaved'));
  // 开启自动删除后立即尝试清理（已到期的当场删掉，不必等下次激活）
  if (value) void runSweep();
}

async function saveRetention(): Promise<void> {
  const raw = Number(retentionInput.value);
  if (!Number.isFinite(raw) || raw < SESSION_ARCHIVE_MIN_RETENTION_DAYS) {
    // 非法输入（清空 / 负数）：回弹到当前生效值，不写入
    retentionInput.value = policy.value.retentionDays;
    return;
  }
  policy.value = await saveSessionArchivePolicy({ retentionDays: raw });
  retentionInput.value = policy.value.retentionDays;
  showNotice(t('hub.sessions.retentionSaved'));
  if (policy.value.autoDelete) void runSweep();
}

/** 触发一次到期清理，然后刷新列表（清理结果由 CHANGED 广播 / 本函数刷新承接） */
async function runSweep(): Promise<void> {
  try {
    const result = await sweepExpiredArchivedSessions();
    if (result.deleted.length > 0) await reload();
  } catch (error) {
    console.warn('[SessionsSection] 归档到期清理失败:', error);
  }
}

// ==================== 反馈 ====================

const notice = ref('');
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function showNotice(message: string): void {
  notice.value = message;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = '';
  }, 3500);
}

/** 提示弹窗（运行中 / 侧边栏未开 / 失败）——单按钮，非破坏性 */
const alertDialog = ref({
  visible: false,
  tone: 'warn' as 'info' | 'warn' | 'error',
  title: '',
  message: '',
});

function showAlert(message: string, tone: 'info' | 'warn' | 'error' = 'warn', title = ''): void {
  alertDialog.value = {
    visible: true,
    tone,
    title: title || t('common.notice'),
    message,
  };
}

// ==================== 加载与实时同步 ====================

/** 数据代次：并发 reload 时旧结果直接丢弃 */
let loadGeneration = 0;

async function reload(): Promise<void> {
  const generation = ++loadGeneration;
  loading.value = true;
  loadError.value = '';
  try {
    const [active, archived] = await Promise.all([
      chatDatabase.listSessions({ scope: 'active', limit: PAGE_SIZE }),
      chatDatabase.listSessions({ scope: 'archived', limit: PAGE_SIZE }),
    ]);
    if (generation !== loadGeneration) return;
    sessions.value = active;
    archivedSessions.value = archived;
    hasMoreAll.value = active.length >= PAGE_SIZE;
    hasMoreArchived.value = archived.length >= PAGE_SIZE;
    await refreshBusy();
    activeChatId.value = await readSidepanelActiveChatId();
  } catch (error) {
    if (generation !== loadGeneration) return;
    loadError.value = error instanceof Error ? error.message : String(error);
    console.warn('[SessionsSection] 加载会话列表失败:', error);
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}

/** 追加当前视图的下一页 */
async function loadMore(): Promise<void> {
  if (loadingMore.value || !hasMore.value) return;
  loadingMore.value = true;
  try {
    const scope = view.value === 'archived' ? 'archived' : 'active';
    const current = view.value === 'archived' ? archivedSessions.value : sessions.value;
    const next = await chatDatabase.listSessions({
      scope,
      limit: PAGE_SIZE,
      offset: current.length,
    });
    const seen = new Set(current.map(item => item.chatId));
    const appended = next.filter(item => !seen.has(item.chatId));
    if (view.value === 'archived') {
      archivedSessions.value = [...archivedSessions.value, ...appended];
      hasMoreArchived.value = next.length >= PAGE_SIZE;
    } else {
      sessions.value = [...sessions.value, ...appended];
      hasMoreAll.value = next.length >= PAGE_SIZE;
    }
    await refreshBusy();
  } catch (error) {
    console.warn('[SessionsSection] 加载更多失败:', error);
    showNotice(t('hub.sessions.actionFailed', {
      reason: error instanceof Error ? error.message : String(error),
    }));
  } finally {
    loadingMore.value = false;
  }
}

/** 刷新运行态（打开 / 删除前的拦截判据 + 行内「执行中」徽标） */
async function refreshBusy(): Promise<void> {
  const ids = [...new Set([
    ...sessions.value.map(item => item.chatId),
    ...archivedSessions.value.map(item => item.chatId),
  ])];
  if (ids.length === 0) {
    busyIds.value = new Set();
    return;
  }
  try {
    busyIds.value = await listBusySessions(ids);
  } catch (error) {
    console.warn('[SessionsSection] 查询运行态失败:', error);
  }
}

/**
 * 运行态闸门：目标会话或侧边栏当前会话正在执行 → 提示等待，返回 false。
 *
 * 同时检查两处：目标会话在跑（不能删 / 不能切到一个正在写的会话）；
 * 侧边栏当前会话在跑（切换会被侧边栏先停掉，必须等它跑完）。
 */
async function ensureIdle(chatId: string): Promise<boolean> {
  const candidates = new Set<string>([chatId]);
  if (activeChatId.value) candidates.add(activeChatId.value);
  let busy: Set<string>;
  try {
    busy = await listBusySessions([...candidates]);
  } catch (error) {
    // 查询失败不能当作「空闲」放行破坏性操作；但也不该永久卡死 ——
    // 提示用户稍后重试（引擎侧仍有中止兜底）
    console.warn('[SessionsSection] 运行态查询失败:', error);
    showAlert(t('hub.sessions.actionFailed', {
      reason: error instanceof Error ? error.message : String(error),
    }), 'error');
    return false;
  }
  if (busy.size > 0) {
    showAlert(t('hub.sessions.busyHint'), 'warn');
    return false;
  }
  return true;
}

// ==================== 动作：打开 / 重命名 / 归档 ====================

async function openInSidebar(row: ChatSessionMeta): Promise<void> {
  if (pendingAction.value) return;
  pendingAction.value = row.chatId;
  try {
    if (!(await ensureIdle(row.chatId))) return;
    const result = await requestOpenInSidepanel(row.chatId);
    if (result === 'opened') {
      activeChatId.value = row.chatId;
      showNotice(t('hub.sessions.opened'));
    } else if (result === 'rejected') {
      showAlert(t('hub.sessions.sidepanelRejected'), 'warn');
    } else {
      showAlert(t('hub.sessions.sidepanelUnavailable'), 'warn');
    }
  } finally {
    pendingAction.value = '';
  }
}

// ──── 重命名 ────

const renamingId = ref('');
const renameValue = ref('');
const renameInputRef = ref<HTMLInputElement[] | HTMLInputElement | null>(null);

async function startRename(row: ChatSessionMeta): Promise<void> {
  renamingId.value = row.chatId;
  renameValue.value = row.title;
  await nextTick();
  const input = Array.isArray(renameInputRef.value)
    ? renameInputRef.value[0]
    : renameInputRef.value;
  input?.focus();
  input?.select();
}

async function commitRename(): Promise<void> {
  const chatId = renamingId.value;
  const title = renameValue.value.trim();
  if (!chatId || !title) {
    cancelRename();
    return;
  }
  const row = scopeRows.value.find(item => item.chatId === chatId);
  if (row && row.title === title) {
    cancelRename();
    return;
  }
  renamingId.value = '';
  renameValue.value = '';
  pendingAction.value = chatId;
  try {
    const updated = await transcriptEngine.renameSession(chatId, title);
    if (!updated) {
      // 会话已在他处删除：刷新列表让它消失，而不是留一行点不动的死数据
      showAlert(t('hub.sessions.actionFailed', { reason: 'not found' }), 'error');
      await reload();
      return;
    }
    applyLocalUpdate(updated);
    showNotice(t('hub.sessions.renamed'));
  } catch (error) {
    showAlert(t('hub.sessions.actionFailed', {
      reason: error instanceof Error ? error.message : String(error),
    }), 'error');
  } finally {
    pendingAction.value = '';
  }
}

function cancelRename(): void {
  renamingId.value = '';
  renameValue.value = '';
}

// ──── 归档 / 取消归档 ────

async function archiveSession(row: ChatSessionMeta): Promise<void> {
  if (pendingAction.value) return;
  pendingAction.value = row.chatId;
  try {
    const updated = await transcriptEngine.archiveSession(row.chatId);
    if (!updated) {
      showAlert(t('hub.sessions.actionFailed', { reason: 'not found' }), 'error');
      await reload();
      return;
    }
    // 乐观迁移：立即从当前列表移入归档列表（顺序以归档时刻为准，重载后校准）
    sessions.value = sessions.value.filter(item => item.chatId !== row.chatId);
    archivedSessions.value = [updated, ...archivedSessions.value.filter(item => item.chatId !== row.chatId)];
    hasMoreAll.value = sessions.value.length >= PAGE_SIZE;
    showNotice(t('hub.sessions.archived'));
    void reload();
  } catch (error) {
    showAlert(t('hub.sessions.actionFailed', {
      reason: error instanceof Error ? error.message : String(error),
    }), 'error');
  } finally {
    pendingAction.value = '';
  }
}

async function unarchiveSession(row: ChatSessionMeta): Promise<void> {
  if (pendingAction.value) return;
  pendingAction.value = row.chatId;
  try {
    const updated = await transcriptEngine.unarchiveSession(row.chatId);
    if (!updated) {
      showAlert(t('hub.sessions.actionFailed', { reason: 'not found' }), 'error');
      await reload();
      return;
    }
    archivedSessions.value = archivedSessions.value.filter(item => item.chatId !== row.chatId);
    sessions.value = [updated, ...sessions.value.filter(item => item.chatId !== row.chatId)];
    hasMoreArchived.value = archivedSessions.value.length >= PAGE_SIZE;
    showNotice(t('hub.sessions.unarchived'));
    void reload();
  } catch (error) {
    showAlert(t('hub.sessions.actionFailed', {
      reason: error instanceof Error ? error.message : String(error),
    }), 'error');
  } finally {
    pendingAction.value = '';
  }
}

/** 把单条更新后的会话同步进本地列表（按其归档态归位） */
function applyLocalUpdate(updated: ChatSessionMeta): void {
  const target = updated.archivedAt === undefined ? sessions : archivedSessions;
  const other = updated.archivedAt === undefined ? archivedSessions : sessions;
  other.value = other.value.filter(item => item.chatId !== updated.chatId);
  const index = target.value.findIndex(item => item.chatId === updated.chatId);
  if (index >= 0) {
    const next = [...target.value];
    next[index] = updated;
    target.value = next;
  } else {
    target.value = [updated, ...target.value];
  }
}

// ──── 删除（自定义二次确认弹窗） ────

const deleteDialog = ref({
  visible: false,
  busy: false,
  session: null as ChatSessionMeta | null,
});

const deleteConfirmMessage = computed(() => {
  const session = deleteDialog.value.session;
  if (!session) return '';
  const base = t('hub.sessions.deleteConfirmMessage', { title: session.title });
  // 删除的正是侧边栏当前会话：明确告知后续行为（删除后回到新会话）
  return session.chatId === activeChatId.value
    ? `${base}\n${t('hub.sessions.deleteConfirmCurrent')}`
    : base;
});

async function requestDelete(row: ChatSessionMeta): Promise<void> {
  if (pendingAction.value || deleteDialog.value.busy) return;
  pendingAction.value = row.chatId;
  try {
    // 运行中一律先拦（弹窗提示等待），不进入确认框
    if (!(await ensureIdle(row.chatId))) return;
    deleteDialog.value = { visible: true, busy: false, session: row };
  } finally {
    pendingAction.value = '';
  }
}

function closeDeleteDialog(): void {
  if (deleteDialog.value.busy) return; // 删除进行中不允许关闭（防半途取消的错觉）
  deleteDialog.value = { visible: false, busy: false, session: null };
}

async function confirmDelete(): Promise<void> {
  const session = deleteDialog.value.session;
  if (!session || deleteDialog.value.busy) return;
  deleteDialog.value = { ...deleteDialog.value, busy: true };
  try {
    // 删除前最后复核运行态：确认框打开期间任务可能已启动
    const busy = await listBusySessions([session.chatId]);
    if (busy.size > 0) {
      closeDeleteDialog();
      showAlert(t('hub.sessions.busyHint'), 'warn');
      return;
    }
    const result = await sessionDeletionEngine.deleteSession(session.chatId);
    if (result.issues.length > 0) {
      console.warn('[SessionsSection] 删除会话存在非致命问题:', result.issues);
    }
    // 通知侧边栏：正打开该会话时由它清缓存并回到新会话
    notifySessionDeleted(session.chatId);
    deleteDialog.value = { visible: false, busy: false, session: null };
    showNotice(t('hub.sessions.deleted'));
    await reload();
  } catch (error) {
    deleteDialog.value = { ...deleteDialog.value, busy: false };
    showAlert(t('hub.sessions.actionFailed', {
      reason: error instanceof Error ? error.message : String(error),
    }), 'error');
  }
}

// ==================== 生命周期与实时订阅 ====================

let unsubscribeBridge: (() => void) | null = null;
let unsubscribePolicy: (() => void) | null = null;
let busyTimer: ReturnType<typeof setInterval> | null = null;
/** 重载去抖：广播密集到达时（如批量清理）合并为一次刷新 */
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReload(): void {
  if (!props.active) return;
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => void reload(), 200);
}

function onFocus(): void {
  // 切回本页时对账：期间其它上下文的改动（含侧边栏内删除）在此收敛
  scheduleReload();
}

onMounted(() => {
  void hydrate();
  unsubscribeBridge = watchSessionsChanged(() => scheduleReload());
  unsubscribePolicy = watchSessionArchivePolicy(next => {
    policy.value = next;
    retentionInput.value = next.retentionDays;
  });
  window.addEventListener('focus', onFocus);
});

onUnmounted(() => {
  unsubscribeBridge?.();
  unsubscribePolicy?.();
  window.removeEventListener('focus', onFocus);
  if (busyTimer) clearInterval(busyTimer);
  if (reloadTimer) clearTimeout(reloadTimer);
  if (searchTimer) clearTimeout(searchTimer);
  if (noticeTimer) clearTimeout(noticeTimer);
});

/** 首次水合：拉列表 + 策略 + 运行态，并触发一次到期清理 */
async function hydrate(): Promise<void> {
  policy.value = await loadSessionArchivePolicy();
  retentionInput.value = policy.value.retentionDays;
  await reload();
  void runSweep();
}

// 激活切换：进入本分区时重新水合 + 启停运行态轮询
watch(
  () => props.active,
  active => {
    if (active) {
      void hydrate();
      if (busyTimer) clearInterval(busyTimer);
      // 运行态轮询（5s）：徽标与闸门跟随任务起止实时变化
      busyTimer = setInterval(() => void refreshBusy(), 5000);
    } else if (busyTimer) {
      clearInterval(busyTimer);
      busyTimer = null;
    }
  },
  { immediate: true },
);

// 搜索联动：查询词 / 开关 / 视图变化 → 重新调度内容搜索
watch([query, contentSearch, view], () => scheduleContentSearch());
// 视图切换或列表更新后，内容命中需要对新范围重算
watch([sessions, archivedSessions], () => {
  if (contentSearch.value && query.value.trim()) scheduleContentSearch();
});

// ==================== 格式化 ====================

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 超过 7 天显示日期 */
function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return t('common.justNow');
  if (minutes < 60) return t('common.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('common.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  if (days <= 7) return t('common.daysAgo', { count: days });
  return formatDate(new Date(timestamp));
}

/** 日期（跟随语言；失败回落 ISO 日期部分） */
function formatDate(date: Date): string {
  try {
    const tag = locale.value === 'zh-CN' ? 'zh-CN' : 'en-US';
    return new Intl.DateTimeFormat(tag, { year: 'numeric', month: 'numeric', day: 'numeric' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}
</script>

<style>
@import './sessions-section.css';
</style>
