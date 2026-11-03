<template>
  <div class="app-container">
    <NotesSidebar
      :search-query="searchQuery"
      :filter-mode="filterMode"
      :filter-value="filterValue"
      :categories="allCategories"
      :tags="allTags"
      :notes="previews"
      :total-notes="totalNotes"
      :is-dark="isDark"
      @create="handleCreate"
      @update:search-query="searchQuery = $event"
      @set-filter="handleSetFilter"
      @toggle-theme="toggleTheme"
      @open-note="openNote"
      @rename-folder="handleRenameFolder"
      @delete-folder="handleDeleteFolder"
      @create-folder="handleCreateFolder"
      @move-note="handleMoveNote"
    />

    <main class="main-content glass">
      <!-- 初始加载中 -->
      <div v-if="initState === 'loading'" class="status-panel">
        <Loader2 class="status-spinner" :size="36" />
        <p class="status-text">{{ t('notes.loading') }}</p>
      </div>

      <!-- 初始化失败：错误面板 + 重试入口（而非静默空列表） -->
      <div v-else-if="initState === 'error'" class="status-panel">
        <div class="status-icon status-icon-error"><AlertCircle :size="40" /></div>
        <h2 class="status-title">{{ t('notes.loadFailedTitle') }}</h2>
        <p v-if="initError" class="status-detail">{{ initError }}</p>
        <p class="status-hint">{{ t('notes.loadFailedHint') }}</p>
        <button class="retry-btn" type="button" @click="handleRetry">
          <RefreshCw :size="16" />
          <span>{{ t('notes.retry') }}</span>
        </button>
      </div>

      <NoteEditor
        v-else-if="currentNote"
        ref="editorRef"
        :note="currentNote"
        :save-fn="saveNote"
        :category-options="categoryOptions"
        :external-pending="externalUpdatePending"
        @back="handleBack"
        @delete="handleDeleteCurrent"
        @dirty-change="editorDirty = $event"
        @reload-external="resolveExternalUpdate"
        @notify="handleNotify"
      />

      <NoteListView
        v-else
        :notes="displayNotes"
        :title="listTitle"
        :has-filter="hasFilter"
        :sort-mode="sortMode"
        @open="openNote"
        @delete="handleDelete"
        @create="handleCreate"
        @update:sort-mode="sortMode = $event"
      />
    </main>

    <!-- 笔记删除二次确认（列表卡片 / 编辑器删除按钮共用） -->
    <ConfirmModal
      :open="deleteTarget.open"
      :title="t('notes.deleteNoteTitle')"
      :message="t('notes.confirmDeleteNote')"
      :confirm-text="t('notes.confirm')"
      :cancel-text="t('notes.cancel')"
      danger
      @confirm="confirmDelete"
      @cancel="deleteTarget.open = false"
    />

    <ToastContainer :toasts="toasts" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { Loader2, AlertCircle, RefreshCw } from 'lucide-vue-next';
import { t } from '@/utils/i18n';
import { useTheme } from './composables/useTheme';
import { useToast } from './composables/useToast';
import { useNotes, categoryDisplay, type NoteFilterMode } from './composables/useNotes';import NotesSidebar from './components/NotesSidebar.vue';
import NoteListView from './components/NoteListView.vue';
import NoteEditor from './components/NoteEditor.vue';
import ToastContainer from './components/ToastContainer.vue';
import ConfirmModal from './components/ConfirmModal.vue';

// Composables
const { isDark, toggleTheme } = useTheme();
const { toasts, showToast } = useToast();

// 编辑器是否有未保存修改（useNotes 依据它决定外部更新是否可自动覆盖）
const editorDirty = ref(false);

const {
  previews, currentNote, totalNotes, externalUpdatePending, initError,
  searchQuery, filterMode, filterValue, sortMode,
  displayNotes, allCategories, allTags, listTitle, hasFilter, setFilter,
  initialize, openNote, closeNote,
  createNote, saveNote, removeNote, createFolder, renameFolder, deleteFolder, moveNoteToFolder,
  resolveExternalUpdate,
} = useNotes({
  isEditorDirty: () => editorDirty.value,
  showToast,
});

// 编辑器实例：Esc 关闭前先落盘未保存修改
const editorRef = ref<InstanceType<typeof NoteEditor> | null>(null);

// 编辑器分类下拉的候选项：value=原始分类 ID（保留 ID 亦是 ID），label=显示名
const categoryOptions = computed(() =>
  allCategories.value.map((item) => ({
    value: item.category,
    label: categoryDisplay(item.category),
  })),
);

// ---- 初始加载状态机（loading → ready / error，error 可重试） ----
const initState = ref<'loading' | 'ready' | 'error'>('loading');

async function doInitialize(): Promise<void> {
  initState.value = 'loading';
  try {
    await initialize();
    initState.value = 'ready';
  } catch (error) {
    console.error('[Notes] 初始化失败:', error);
    initState.value = 'error';
  }
}

function handleRetry(): void {
  void doInitialize();
}

// ---- 操作 ----
async function handleCreate() {
  try {
    await createNote();
  } catch (error) {
    console.error('[Notes] 创建笔记失败:', error);
    showToast(t('notes.toastCreateFailed'), 'error');
  }
}

/** 删除确认弹窗状态（列表卡片与编辑器删除按钮共用同一入口） */
const deleteTarget = ref<{ open: boolean; id: string | null }>({ open: false, id: null });

function handleDelete(id: string) {
  deleteTarget.value = { open: true, id };
}

async function confirmDelete() {
  const id = deleteTarget.value.id;
  deleteTarget.value = { open: false, id: null };
  if (!id) return;
  try {
    await removeNote(id);
    showToast(t('notes.toastNoteDeleted'), 'success');
  } catch (error) {
    console.error('[Notes] 删除笔记失败:', error);
    showToast(t('notes.toastDeleteFailed'), 'error');
  }
}

async function handleDeleteCurrent() {
  if (!currentNote.value) return;
  handleDelete(currentNote.value.id);
}

// ---- 文件夹（分类）操作：新建 / 重命名 / 删除 / 笔记移动 ----
function handleCreateFolder(name: string) {
  try {
    const created = createFolder(name);
    if (created) {
      showToast(t('notes.toastFolderCreated'), 'success');
    } else {
      showToast(t('notes.toastFolderExists'), 'error');
    }
  } catch (error) {
    console.error('[Notes] 新建文件夹失败:', error);
    showToast(t('notes.toastFolderCreateFailed'), 'error');
  }
}

async function handleRenameFolder(category: string, nextName: string) {
  try {
    await renameFolder(category, nextName);
    showToast(t('notes.toastFolderRenamed'), 'success');
  } catch (error) {
    console.error('[Notes] 重命名文件夹失败:', error);
    showToast(t('notes.toastFolderRenameFailed'), 'error');
  }
}

async function handleDeleteFolder(category: string) {
  try {
    await deleteFolder(category);
    showToast(t('notes.toastFolderDeleted'), 'success');
  } catch (error) {
    console.error('[Notes] 删除文件夹失败:', error);
    showToast(t('notes.toastFolderDeleteFailed'), 'error');
  }
}

async function handleMoveNote(noteId: string, category: string) {
  try {
    await moveNoteToFolder(noteId, category);
    showToast(t('notes.toastNoteMoved'), 'success');
  } catch (error) {
    console.error('[Notes] 移动笔记失败:', error);
    showToast(t('notes.toastMoveFailed'), 'error');
  }
}

/** 返回列表：先把编辑器未保存修改落盘，再关闭（关闭不丢数据） */
async function handleBack() {
  try {
    await editorRef.value?.flushSave();
  } catch {
    // 保存失败已在编辑器内部提示；仍允许返回
  }
  closeNote();
}

function handleSetFilter(mode: NoteFilterMode, value: string) {
  setFilter(mode, value);
}

function handleNotify(payload: { message: string; type: 'success' | 'error' }) {
  showToast(payload.message, payload.type);
}

// Esc 返回列表（同样先落盘）
async function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && currentNote.value && initState.value === 'ready') {
    await handleBack();
  }
}

// 笔记关闭/切换时清掉编辑器脏标记：卸载后的编辑器不再发 dirty-change 事件，
// 残留的 true 会让 isEditorDirty 误判「用户正在编辑」，导致外部同步被错误挂起
watch(currentNote, (note) => {
  if (!note) editorDirty.value = false;
});

onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
  void doInitialize();
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
});
</script>
