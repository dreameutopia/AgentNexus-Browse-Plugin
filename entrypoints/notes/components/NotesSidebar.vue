<template>
  <aside class="sidebar glass">
    <div class="sidebar-header">
      <div class="logo">
        <div class="logo-icon"><NotebookPen :size="18" /></div>
        <span class="logo-text">{{ t('notes.logoText') }}</span>
      </div>
    </div>

    <div class="sidebar-body">
      <button class="new-note-btn" type="button" @click="$emit('create')">
        <Plus :size="16" />
        <span>{{ t('notes.newNote') }}</span>
      </button>

      <div class="search-box">
        <Search :size="14" class="search-icon" />
        <input
          :value="searchQuery"
          type="text"
          :placeholder="t('notes.searchPlaceholder')"
          @input="$emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
        />
      </div>

      <nav class="sidebar-nav">
        <button
          class="nav-item"
          :class="{ active: filterMode === 'all' }"
          type="button"
          @click="$emit('set-filter', 'all', '')"
        >
          <Layers :size="14" />
          <span class="nav-item-label">{{ t('notes.navAll') }}</span>
          <span class="nav-item-count">{{ totalNotes }}</span>
        </button>

        <!-- 文件夹标题 + 右侧新建文件夹图标（新建的空文件夹也保留展示） -->
        <div class="nav-section-title-row">
          <div class="nav-section-title">{{ t('notes.navCategories') }}</div>
          <button
            class="section-action-btn"
            type="button"
            :title="t('notes.newFolder')"
            @click="createModalOpen = true"
          >
            <FolderPlus :size="14" />
          </button>
        </div>

        <!--
          文件夹树：限高 + 内部滚动（max-height 见 .folder-tree），
          笔记多时出现滚动条，不会把侧边栏撑爆或被截断
        -->
        <div class="folder-tree" :title="t('notes.folderTreeHint')">
          <div v-for="folder in categories" :key="folder.category" class="folder-block">
            <div
              class="folder-row"
              :class="{
                active: filterMode === 'category' && filterValue === folder.category,
                'drop-target': dropTarget === folder.category,
              }"
              @click="$emit('set-filter', 'category', folder.category)"
              @dragover.prevent="handleFolderDragOver(folder.category)"
              @dragleave="handleFolderDragLeave(folder.category)"
              @drop.prevent="handleFolderDrop(folder.category)"
            >
              <button
                class="folder-chevron"
                type="button"
                :title="
                  isExpanded(folder.category)
                    ? t('notes.collapseFolder')
                    : t('notes.expandFolder')
                "
                @click.stop="toggleFolder(folder.category)"
              >
                <ChevronRight
                  :size="14"
                  :class="{ expanded: isExpanded(folder.category) }"
                />
              </button>
              <FolderClosed :size="14" class="folder-icon" />
              <span class="folder-name">{{ categoryDisplay(folder.category) }}</span>
              <span class="folder-count">{{ folder.count }}</span>
              <span class="folder-actions">
                <button
                  class="folder-action-btn"
                  type="button"
                  :title="t('notes.renameFolderAction')"
                  @click.stop="startRename(folder)"
                >
                  <Pencil :size="12" />
                </button>
                <button
                  class="folder-action-btn danger"
                  type="button"
                  :title="t('notes.deleteFolderAction')"
                  @click.stop="startDelete(folder)"
                >
                  <Trash2 :size="12" />
                </button>
              </span>
            </div>

            <div
              v-if="isExpanded(folder.category)"
              class="folder-notes"
              @dragover.prevent="handleFolderDragOver(folder.category)"
              @dragleave="handleFolderDragLeave(folder.category)"
              @drop.prevent="handleFolderDrop(folder.category)"
            >
              <button
                v-for="note in notesOf(folder.category)"
                :key="note.id"
                class="folder-note-row"
                :class="{ dragging: draggingNoteId === note.id }"
                type="button"
                draggable="true"
                :title="note.title || t('notes.untitled')"
                @click="$emit('open-note', note.id)"
                @dragstart="handleNoteDragStart($event, note.id)"
                @dragend="handleNoteDragEnd"
              >
                <FileText :size="12" class="folder-note-icon" />
                <span class="folder-note-title">{{ note.title || t('notes.untitled') }}</span>
                <time class="folder-note-time">{{ formatRelativeTime(note.updatedAt) }}</time>
              </button>
              <div v-if="!notesOf(folder.category).length" class="folder-notes-empty">
                {{ t('notes.folderEmpty') }}
              </div>
            </div>
          </div>

          <div v-if="!categories.length" class="folder-notes-empty">
            {{ t('notes.folderEmpty') }}
          </div>
        </div>

        <template v-if="tags.length">
          <div class="nav-section-title">{{ t('notes.navTags') }}</div>
          <div class="nav-tags">
            <button
              v-for="item in tags"
              :key="item.tag"
              class="tag-filter-chip"
              :class="{ active: filterMode === 'tag' && filterValue === item.tag }"
              type="button"
              :title="`${item.tag} (${item.count})`"
              @click="$emit('set-filter', 'tag', item.tag)"
            >
              # {{ item.tag }}
              <span class="tag-count">{{ item.count }}</span>
            </button>
          </div>
        </template>
      </nav>
    </div>

    <div class="sidebar-footer">
      <div class="note-stats">{{ t('notes.countNotes', { count: totalNotes }) }}</div>
      <button
        class="theme-toggle"
        type="button"
        :title="isDark ? t('notes.themeLight') : t('notes.themeDark')"
        @click="$emit('toggle-theme')"
      >
        <Sun v-if="isDark" :size="15" />
        <Moon v-else :size="15" />
      </button>
    </div>

    <!-- 文件夹重命名（输入弹窗） -->
    <PromptModal
      :open="!!renameTarget"
      :title="t('notes.renameFolderTitle')"
      :label="t('notes.renameFolderLabel')"
      :initial-value="renameTarget?.name ?? ''"
      :confirm-text="t('notes.confirm')"
      :cancel-text="t('notes.cancel')"
      :max-length="50"
      @confirm="handleRenameConfirm"
      @cancel="renameTarget = null"
    />

    <!-- 文件夹删除（二次确认弹窗，含其中笔记数量） -->
    <ConfirmModal
      :open="!!deleteTarget"
      :title="t('notes.deleteFolderTitle')"
      :message="
        deleteTarget
          ? t('notes.deleteFolderMessage', {
              name: deleteTarget.name,
              count: deleteTarget.count,
            })
          : ''
      "
      :confirm-text="t('notes.deleteFolderConfirm')"
      :cancel-text="t('notes.cancel')"
      danger
      @confirm="handleDeleteConfirm"
      @cancel="deleteTarget = null"
    />

    <!-- 新建文件夹（空文件夹同样保留展示） -->
    <PromptModal
      :open="createModalOpen"
      :title="t('notes.newFolder')"
      :label="t('notes.renameFolderLabel')"
      :initial-value="''"
      :confirm-text="t('notes.confirm')"
      :cancel-text="t('notes.cancel')"
      :max-length="50"
      @confirm="handleCreateConfirm"
      @cancel="createModalOpen = false"
    />
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  NotebookPen,
  Plus,
  Search,
  Layers,
  FolderClosed,
  FolderPlus,
  Sun,
  Moon,
  ChevronRight,
  Pencil,
  Trash2,
  FileText,
} from 'lucide-vue-next';
import { t } from '@/utils/i18n';
import type { NoteListItem } from '@/utils/notes-database';
import { categoryDisplay, type NoteFilterMode } from '../composables/useNotes';
import { formatRelativeTime } from '../utils/helpers';
import ConfirmModal from './ConfirmModal.vue';
import PromptModal from './PromptModal.vue';

const props = defineProps<{
  searchQuery: string;
  filterMode: NoteFilterMode;
  filterValue: string;
  categories: { category: string; count: number }[];
  tags: { tag: string; count: number }[];
  /** 全部笔记（用于展开文件夹时列出其下笔记） */
  notes: NoteListItem[];
  totalNotes: number;
  isDark: boolean;
}>();

const emit = defineEmits<{
  (e: 'create'): void;
  (e: 'update:searchQuery', value: string): void;
  (e: 'set-filter', mode: NoteFilterMode, value: string): void;
  (e: 'toggle-theme'): void;
  /** 打开某篇笔记 */
  (e: 'open-note', id: string): void;
  /** 重命名文件夹（category 为存储中的原始 ID） */
  (e: 'rename-folder', category: string, nextName: string): void;
  /** 删除文件夹（父级弹窗已二次确认） */
  (e: 'delete-folder', category: string): void;
  /** 新建空文件夹 */
  (e: 'create-folder', name: string): void;
  /** 把笔记移动到目标文件夹 */
  (e: 'move-note', noteId: string, category: string): void;
}>();

// ---- 展开状态（默认全部收起；仅会话内记忆，不持久化） ----
const expanded = ref<Set<string>>(new Set());

function isExpanded(category: string): boolean {
  return expanded.value.has(category);
}

function toggleFolder(category: string): void {
  const next = new Set(expanded.value);
  if (next.has(category)) next.delete(category);
  else next.add(category);
  expanded.value = next;
}

// ---- 文件夹下的笔记（按更新时间倒序，与列表页一致） ----
const folderNotes = computed(() => {
  const map = new Map<string, NoteListItem[]>();
  for (const folder of props.categories) map.set(folder.category, []);
  for (const note of props.notes) {
    map.get(note.category)?.push(note);
  }
  return map;
});

function notesOf(category: string): NoteListItem[] {
  return folderNotes.value.get(category) ?? [];
}

// ---- 重命名 / 删除 / 新建弹窗 ----
const renameTarget = ref<{ category: string; name: string } | null>(null);
const deleteTarget = ref<{ category: string; name: string; count: number } | null>(null);
const createModalOpen = ref(false);

function handleCreateConfirm(name: string): void {
  createModalOpen.value = false;
  emit('create-folder', name);
}

function startRename(folder: { category: string }): void {
  renameTarget.value = { category: folder.category, name: categoryDisplay(folder.category) };
}

function startDelete(folder: { category: string; count: number }): void {
  deleteTarget.value = {
    category: folder.category,
    name: categoryDisplay(folder.category),
    count: folder.count,
  };
}

function handleRenameConfirm(next: string): void {
  const target = renameTarget.value;
  renameTarget.value = null;
  if (!target) return;
  // 名称未变化（含保留分类输入其本地化显示名）：视为取消
  if (next === target.name) return;
  emit('rename-folder', target.category, next);
}

function handleDeleteConfirm(): void {
  const target = deleteTarget.value;
  deleteTarget.value = null;
  if (!target) return;
  emit('delete-folder', target.category);
}

// ---- 拖动笔记到文件夹（直接更换分类） ----
const draggingNoteId = ref<string | null>(null);
const dropTarget = ref<string | null>(null);

function handleNoteDragStart(event: DragEvent, noteId: string): void {
  draggingNoteId.value = noteId;
  const transfer = event.dataTransfer;
  if (!transfer) return;
  transfer.effectAllowed = 'move';
  // 双通道携带：text/plain 兼容，自定义类型供同页精确识别
  transfer.setData('text/plain', noteId);
  transfer.setData('application/x-agentnexus-note', noteId);
}

function handleNoteDragEnd(): void {
  draggingNoteId.value = null;
  dropTarget.value = null;
}

function handleFolderDragOver(category: string): void {
  // 仅本页笔记拖动时高亮（外部拖入的文本 / 图片不提示可放置）
  if (!draggingNoteId.value) return;
  dropTarget.value = category;
}

function handleFolderDragLeave(category: string): void {
  if (dropTarget.value === category) dropTarget.value = null;
}

function handleFolderDrop(category: string): void {
  const noteId = draggingNoteId.value;
  dropTarget.value = null;
  draggingNoteId.value = null;
  if (!noteId) return;
  const note = props.notes.find((item) => item.id === noteId);
  // 拖到原文件夹：无变化，不触发保存
  if (!note || note.category === category) return;
  emit('move-note', noteId, category);
}
</script>
