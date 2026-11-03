/**
 * 笔记数据 composable（统一模型 v3）
 *
 * 页面只读取插件托管的存储（utils/notes-database，IndexedDB），
 * 与笔记工具（tools/note）、网页剪藏（background）共用同一数据源：
 * - 通过 #note=<uuid> hash 与标签页定位笔记（工具创建笔记后打开页面即定位）；
 * - 监听 NOTES_CHANGED 变更广播：智能体追加内容、剪藏新网页时实时刷新；
 *   当前笔记被外部修改且本地无未保存编辑时自动同步，否则挂"外部更新"标记。
 *
 * 列表状态（搜索 / 分类筛选 / 标签筛选 / 排序）也收敛在本 composable，
 * 页面组件只消费 displayNotes，不各自维护过滤逻辑（避免双处过滤漂移）。
 *
 * 防御性设计：
 * - hash 解码与笔记 ID 形态校验前置，非法 hash 只给出可读提示并回到列表；
 * - openNote 竞态防护：序列号丢弃过期异步结果，最后发起的打开请求胜出；
 * - initialize 失败写入 initError，页面渲染错误面板 + 重试入口；
 * - 保存返回 null（笔记已被删除）时抛出可读错误，编辑器据此提示并停止重试。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { t } from '@/utils/i18n';
import {
  notesDB,
  broadcastNotesChanged,
  isNoteId,
  normalizeCategory,
  CATEGORY_INBOX,
  CATEGORY_AI,
  NOTES_CHANGED_MESSAGE,
  type NoteListItem,
  type NotesChangeAction,
} from '@/utils/notes-database';
import { loadFolders, saveFolders } from '../utils/folder-registry';
import type { Note } from '@/types';

export type NoteFilterMode = 'all' | 'category' | 'tag';
export type NoteSortMode = 'newest' | 'oldest' | 'title';

/** 分类下拉选项：value 为存储中的原始分类 ID（含保留 ID），
 *  label 为界面显示名（保留分类经 i18n 本地化，自定义分类与 value 一致）。
 *  值与显示分离，避免把本地化文案当作分类存回数据库造成保留 ID 分裂 */
export interface NoteCategoryOption {
  value: string;
  label: string;
}

/** 保留分类的界面显示名（其余分类字符串原样展示） */
export function categoryDisplay(category: string): string {
  if (category === CATEGORY_INBOX) return t('notes.categoryInbox');
  if (category === CATEGORY_AI) return t('notes.categoryAI');
  return category;
}

export interface UseNotesOptions {
  /** 当前编辑器是否存在未保存修改（外部更新时决定是否自动覆盖编辑区） */
  isEditorDirty: () => boolean;
  /** 提示通知 */
  showToast: (message: string, type?: 'success' | 'error') => void;
}

export function useNotes(options: UseNotesOptions) {
  // ---- 数据状态 ----
  const previews = ref<NoteListItem[]>([]);
  /** 文件夹登记表：所有出现过 / 手动新建的文件夹名（含空文件夹，localStorage 持久化） */
  const folderRegistry = ref<string[]>([]);
  const currentNote = ref<Note | null>(null);
  const loading = ref(false);
  /** 初始化失败原因（非 null 时页面渲染错误面板，用户可重试） */
  const initError = ref<string | null>(null);
  /** 当前笔记被智能体/其它上下文修改，但本地有未保存编辑未能自动同步 */
  const externalUpdatePending = ref(false);

  // ---- 列表筛选状态 ----
  const searchQuery = ref('');
  const filterMode = ref<NoteFilterMode>('all');
  const filterValue = ref('');
  const sortMode = ref<NoteSortMode>('newest');

  const totalNotes = computed(() => previews.value.length);

  /**
   * 文件夹聚合（含计数）：「未分类」始终展示，其余按使用量倒序。
   * 笔记中出现过的分类 ∪ 登记表 —— 空文件夹（无任何笔记）同样保留展示。
   */
  const allCategories = computed(() => {
    const counts = new Map<string, number>();
    counts.set(CATEGORY_INBOX, 0);
    for (const note of previews.value) {
      counts.set(note.category, (counts.get(note.category) || 0) + 1);
    }
    const names = new Set<string>([...counts.keys(), ...folderRegistry.value]);
    return Array.from(names)
      .map((category) => ({ category, count: counts.get(category) || 0 }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  });

  /** 标签聚合（含计数，按使用量倒序） */
  const allTags = computed(() => {
    const counts = new Map<string, number>();
    for (const note of previews.value) {
      for (const tag of note.tags) {
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  });

  /** 搜索 + 分类/标签筛选 + 排序后的最终展示列表 */
  const displayNotes = computed(() => {
    const query = searchQuery.value.trim().toLowerCase();

    const filtered = previews.value.filter((note) => {
      if (filterMode.value === 'category' && note.category !== filterValue.value) return false;
      if (filterMode.value === 'tag' && !note.tags.includes(filterValue.value)) return false;
      if (!query) return true;
      return (
        note.title.toLowerCase().includes(query) ||
        note.textPreview.toLowerCase().includes(query) ||
        note.category.toLowerCase().includes(query) ||
        note.tags.some((tag) => tag.toLowerCase().includes(query))
      );
    });

    const sorted = [...filtered];
    switch (sortMode.value) {
      case 'oldest':
        sorted.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
        break;
      case 'title':
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
      default:
        sorted.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    return sorted;
  });

  /** 列表标题（搜索 > 标签 > 分类 > 全部） */
  const listTitle = computed(() => {
    if (searchQuery.value) return t('notes.listTitleSearch', { query: searchQuery.value });
    if (filterMode.value === 'tag' && filterValue.value) {
      return t('notes.listTitleTag', { value: filterValue.value });
    }
    if (filterMode.value === 'category' && filterValue.value) {
      return t('notes.listTitleCategory', { value: categoryDisplay(filterValue.value) });
    }
    return t('notes.listTitleAll');
  });

  /** 当前筛选是否处于「非全部」状态（空态文案区分） */
  const hasFilter = computed(
    () => Boolean(searchQuery.value) || filterMode.value !== 'all',
  );

  /** 新笔记的默认分类：停留在某个分类视图时沿用该分类，否则「未分类」 */
  function defaultCategoryForCreate(): string {
    if (filterMode.value === 'category' && filterValue.value) return filterValue.value;
    return CATEGORY_INBOX;
  }

  function setFilter(mode: NoteFilterMode, value: string = ''): void {
    filterMode.value = mode;
    filterValue.value = value;
    if (mode !== 'all') searchQuery.value = '';
  }

  // ---- openNote 竞态防护：只有最新一次打开请求的结果才允许生效 ----
  let openSeq = 0;

  // ---- 列表刷新（防抖合并高频写入） ----
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  async function refreshPreviews(): Promise<void> {
    previews.value = await notesDB.listNotePreviews();
    registerCategoriesFromNotes();
  }

  /**
   * 笔记里出现过的分类自动登记为文件夹：
   * 这样把某个文件夹下最后一篇笔记移走 / 删除后，空文件夹仍保留在侧边栏
   * （数据层只有 note.category 字符串，空文件夹需登记表才能承载）。
   */
  function registerCategoriesFromNotes(): void {
    const known = new Set(folderRegistry.value);
    let changed = false;
    for (const note of previews.value) {
      if (!known.has(note.category)) {
        known.add(note.category);
        changed = true;
      }
    }
    if (!changed) return;
    folderRegistry.value = Array.from(known);
    saveFolders(folderRegistry.value);
  }

  function scheduleRefresh(): void {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshPreviews().catch((error) => {
        // 运行期刷新失败：保留旧列表继续可用，仅记录日志
        console.error('[Notes] 刷新笔记列表失败:', error);
      });
    }, 300);
  }

  // ---- Hash 同步 ----
  function setHash(noteId: string | null): void {
    const target = noteId ? `#note=${encodeURIComponent(noteId)}` : '';
    if ((location.hash || '') === target) return;
    // replaceState：不产生历史记录、不触发 hashchange
    history.replaceState(null, '', location.pathname + location.search + target);
  }

  function syncFromHash(): void {
    const match = location.hash.match(/^#note=(.+)$/);
    if (match) {
      // decodeURIComponent 对畸形转义序列会抛 URIError，必须兜底
      let id: string;
      try {
        id = decodeURIComponent(match[1]);
      } catch {
        options.showToast(t('notes.toastInvalidId'), 'error');
        setHash(null);
        return;
      }
      if (!isNoteId(id)) {
        options.showToast(t('notes.toastInvalidId'), 'error');
        setHash(null);
        return;
      }
      if (currentNote.value?.id !== id) {
        void openNote(id);
      }
    } else if (currentNote.value) {
      // hash 被外部清空（如手动编辑地址）：回到列表
      currentNote.value = null;
      externalUpdatePending.value = false;
    }
  }

  // ---- 打开 / 关闭 ----
  async function openNote(id: string): Promise<void> {
    const seq = ++openSeq;
    loading.value = true;
    try {
      if (!isNoteId(id)) {
        options.showToast(t('notes.toastInvalidId'), 'error');
        return;
      }
      const note = await notesDB.getNote(id);
      // 过期请求：期间已发起新的打开/关闭操作，丢弃本次结果
      if (seq !== openSeq) return;

      if (!note) {
        options.showToast(t('notes.toastNoteNotFound'), 'error');
        currentNote.value = null;
        externalUpdatePending.value = false;
        setHash(null);
        return;
      }
      currentNote.value = note;
      externalUpdatePending.value = false;
      setHash(note.id);
    } catch (error) {
      if (seq !== openSeq) return;
      console.error('[Notes] 打开笔记失败:', error);
      options.showToast(t('notes.toastLoadFailed'), 'error');
    } finally {
      if (seq === openSeq) loading.value = false;
    }
  }

  function closeNote(): void {
    openSeq++; // 使仍在途的 openNote 结果失效
    currentNote.value = null;
    externalUpdatePending.value = false;
    setHash(null);
  }

  // ---- CRUD ----
  async function createNote(): Promise<Note> {
    const note = await notesDB.createNote({
      kind: 'note',
      title: t('notes.untitled'),
      category: defaultCategoryForCreate(),
    });
    broadcastNotesChanged('create', note.id);
    scheduleRefresh();
    await openNote(note.id);
    return note;
  }

  /**
   * 保存笔记。笔记已被删除（返回 null）时抛出可读错误：
   * 编辑器据此提示用户并停止把修改写向不存在的目标。
   */
  async function saveNote(
    id: string,
    updates: { title?: string; content?: string; category?: string; tags?: string[] },
  ): Promise<Note> {
    const updated = await notesDB.updateNote(id, updates);
    if (!updated) {
      throw new Error(t('notes.toastSaveDeleted'));
    }
    broadcastNotesChanged('update', id);
    if (currentNote.value?.id === id) {
      currentNote.value = updated;
    }
    scheduleRefresh();
    return updated;
  }

  async function removeNote(id: string): Promise<void> {
    await notesDB.deleteNote(id);
    broadcastNotesChanged('delete', id);
    scheduleRefresh();
    if (currentNote.value?.id === id) {
      closeNote();
    }
  }

  /**
   * 重命名文件夹（分类）：事务内改写其下全部笔记的分类，随后广播刷新。
   * 登记表同步「注销旧名 + 登记新名」（旧文件夹不残留为空）；
   * 当前打开的笔记若在该文件夹内，同步其 category（编辑器下拉随之更新）。
   */
  async function renameFolder(oldCategory: string, newCategory: string): Promise<void> {
    await notesDB.renameCategory(oldCategory, newCategory);
    const nextNames = new Set(folderRegistry.value);
    nextNames.delete(oldCategory);
    nextNames.add(newCategory);
    folderRegistry.value = Array.from(nextNames);
    saveFolders(folderRegistry.value);
    broadcastNotesChanged('update');
    scheduleRefresh();
    if (currentNote.value?.category === oldCategory) {
      currentNote.value = { ...currentNote.value, category: newCategory };
    }
  }

  /**
   * 删除文件夹及其下全部笔记（调用方已完成二次确认）。
   * 同步注销登记（文件夹从侧边栏消失）；当前打开的笔记若在该文件夹内，一并关闭。
   */
  async function deleteFolder(category: string): Promise<void> {
    await notesDB.deleteCategory(category);
    folderRegistry.value = folderRegistry.value.filter((name) => name !== category);
    saveFolders(folderRegistry.value);
    broadcastNotesChanged('delete');
    scheduleRefresh();
    if (currentNote.value?.category === category) {
      closeNote();
    }
  }

  /**
   * 新建空文件夹（写入登记表，立即出现在侧边栏；允许无任何笔记）。
   *
   * @returns false 表示名称为空或已存在（调用方据此提示）
   */
  function createFolder(name: string): boolean {
    const normalized = normalizeCategory(name, '');
    if (!normalized) return false;
    if (allCategories.value.some((item) => item.category === normalized)) return false;
    folderRegistry.value = [...folderRegistry.value, normalized];
    saveFolders(folderRegistry.value);
    return true;
  }

  /** 把笔记移动到另一个文件夹（走统一保存链路：校验 + 广播 + 列表刷新） */
  async function moveNoteToFolder(id: string, category: string): Promise<void> {
    await saveNote(id, { category });
  }

  /**
   * 强制用存储中的最新内容覆盖编辑器（外部更新挂起时由用户触发）
   */
  async function resolveExternalUpdate(): Promise<void> {
    if (!currentNote.value) return;
    const fresh = await notesDB.getNote(currentNote.value.id);
    if (!fresh) {
      options.showToast(t('notes.toastNoteNotFound'), 'error');
      closeNote();
      return;
    }
    currentNote.value = fresh;
    externalUpdatePending.value = false;
  }

  // ---- 变更广播监听（智能体写入 / 剪藏保存 → 实时刷新） ----
  function handleMessage(message: any): void {
    if (message?.type !== NOTES_CHANGED_MESSAGE) return;
    const payload = (message.payload ?? {}) as { action?: NotesChangeAction; noteId?: string };

    scheduleRefresh();

    if (!currentNote.value || !payload.noteId || payload.noteId !== currentNote.value.id) {
      return;
    }

    if (payload.action === 'delete') {
      options.showToast(t('notes.toastNoteDeletedExternal'), 'error');
      closeNote();
      return;
    }

    if (options.isEditorDirty()) {
      // 编辑器有未保存修改：不覆盖，挂起提示由用户决定
      externalUpdatePending.value = true;
      return;
    }

    // 空闲状态：直接同步最新内容（智能体边写、页面边显示）
    const noteId = currentNote.value.id;
    notesDB
      .getNote(noteId)
      .then((fresh) => {
        if (fresh && currentNote.value?.id === noteId) {
          currentNote.value = fresh;
        }
      })
      .catch((error) => console.error('[Notes] 同步外部更新失败:', error));
  }

  function handleHashChange(): void {
    syncFromHash();
  }

  // ---- 初始化 ----
  async function initialize(): Promise<void> {
    loading.value = true;
    initError.value = null;
    try {
      folderRegistry.value = loadFolders();
      await refreshPreviews();
      syncFromHash();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[Notes] 初始化失败:', error);
      initError.value = message;
      throw error;
    } finally {
      loading.value = false;
    }
  }

  onMounted(() => {
    window.addEventListener('hashchange', handleHashChange);
    // chrome.runtime 在非扩展环境（本地调试直接打开 html）下不存在，需防御
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(handleMessage);
    }
  });

  onUnmounted(() => {
    window.removeEventListener('hashchange', handleHashChange);
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.removeListener(handleMessage);
    }
    if (refreshTimer) clearTimeout(refreshTimer);
  });

  return {
    // 数据
    previews,
    currentNote,
    loading,
    initError,
    totalNotes,
    externalUpdatePending,
    // 列表状态
    searchQuery,
    filterMode,
    filterValue,
    sortMode,
    displayNotes,
    allCategories,
    allTags,
    listTitle,
    hasFilter,
    setFilter,
    // 动作
    initialize,
    openNote,
    closeNote,
    createNote,
    saveNote,
    removeNote,
    createFolder,
    renameFolder,
    deleteFolder,
    moveNoteToFolder,
    resolveExternalUpdate,
    refreshPreviews,
  };
}
