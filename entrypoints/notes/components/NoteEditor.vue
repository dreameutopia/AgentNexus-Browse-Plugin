<template>
  <div class="editor-view">
    <header class="editor-topbar">
      <button class="icon-btn" type="button" :title="t('notes.backToList')" @click="handleBackClick">
        <ArrowLeft :size="18" />
      </button>

      <input
        v-model="title"
        class="editor-title-input"
        :placeholder="t('notes.titlePlaceholder')"
        maxlength="200"
        @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
      />

      <div class="editor-header-actions">
        <span
          v-if="externalPending"
          class="external-update-badge"
          :title="t('notes.externalUpdated')"
          @click="handleReloadExternal"
        >
          <RefreshCw :size="12" />
          {{ t('notes.externalUpdated') }}
        </span>

        <span class="save-status" :class="saveStatusClass">{{ saveStatusText }}</span>

        <!-- 导出：txt / md / docx / pdf（图标均为内联 SVG） -->
        <div class="export-wrap" @keydown.esc="handleExportEsc">
          <button
            class="icon-btn"
            :class="{ 'menu-open': exportOpen }"
            type="button"
            :title="t('notes.exportTitle')"
            @click.stop="exportOpen = !exportOpen"
          >
            <Download :size="15" />
          </button>

          <div v-if="exportOpen" class="export-menu" role="menu">
            <button class="export-item" type="button" role="menuitem" @click="handleExport('txt')">
              <span class="export-item-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 3 14 8 19 8" />
                  <line x1="8.5" y1="12.5" x2="15.5" y2="12.5" />
                  <line x1="8.5" y1="15.5" x2="15.5" y2="15.5" />
                  <line x1="8.5" y1="18.5" x2="12.8" y2="18.5" />
                </svg>
              </span>
              <span class="export-item-name">{{ t('notes.exportTxt') }}</span>
              <span class="export-item-ext">.txt</span>
            </button>

            <button class="export-item" type="button" role="menuitem" @click="handleExport('md')">
              <span class="export-item-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 3 14 8 19 8" />
                  <line x1="8.5" y1="13" x2="15.5" y2="13" />
                  <path d="M12 14.8v4.4" />
                  <path d="M9.9 17.3L12 19.4l2.1-2.1" />
                </svg>
              </span>
              <span class="export-item-name">{{ t('notes.exportMd') }}</span>
              <span class="export-item-ext">.md</span>
            </button>

            <button class="export-item" type="button" role="menuitem" @click="handleExport('docx')">
              <span class="export-item-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 3 14 8 19 8" />
                  <text x="12" y="17.4" text-anchor="middle" font-size="8.5" font-weight="700" fill="currentColor" stroke="none" font-family="Arial, Helvetica, sans-serif">W</text>
                </svg>
              </span>
              <span class="export-item-name">{{ t('notes.exportDocx') }}</span>
              <span class="export-item-ext">.docx</span>
            </button>

            <button class="export-item" type="button" role="menuitem" @click="handleExport('pdf')">
              <span class="export-item-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 3 14 8 19 8" />
                  <text x="12" y="17.2" text-anchor="middle" font-size="6.4" font-weight="700" fill="currentColor" stroke="none" font-family="Arial, Helvetica, sans-serif">PDF</text>
                </svg>
              </span>
              <span class="export-item-name">{{ t('notes.exportPdf') }}</span>
              <span class="export-item-ext">.pdf</span>
            </button>
          </div>
        </div>

        <button class="icon-btn" type="button" :title="t('notes.copyId')" @click="copyId">
          <Copy :size="15" />
        </button>
        <button
          class="icon-btn danger-hover"
          type="button"
          :title="t('notes.deleteNote')"
          @click="$emit('delete')"
        >
          <Trash2 :size="15" />
        </button>
      </div>
    </header>

    <div class="editor-subbar">
      <!-- 网页剪藏来源徽标：图标 + 域名，点击打开原文 -->
      <a
        v-if="note.kind === 'webpage' && note.source"
        class="source-badge"
        :href="note.source.url"
        :title="t('notes.openSource') + ': ' + note.source.url"
        target="_blank"
        rel="noopener noreferrer"
      >
        <img
          v-if="note.source.favicon"
          class="source-favicon"
          :src="note.source.favicon"
          alt=""
          @error="($event.target as HTMLImageElement).style.display = 'none'"
        />
        <Globe :size="13" />
        <span class="source-host">{{ sourceHost }}</span>
        <ExternalLink :size="11" />
      </a>
      <span v-else class="kind-badge">
        <StickyNote :size="13" />
        {{ t('notes.kindNote') }}
      </span>

      <span class="subbar-spacer" />

      <div class="category-field">
        <FolderClosed :size="13" />
        <SelectMenu
          :model-value="category"
          :items="categorySelectOptions"
          :title="t('notes.categoryLabel')"
          size="sm"
          @update:model-value="handleCategoryChange"
        />
        <button
          class="icon-btn slim"
          type="button"
          :title="t('notes.customCategoryPrompt')"
          @click="handleCustomCategory"
        >
          <Pencil :size="12" />
        </button>
      </div>
    </div>

    <EditorToolbar :editor="editor" @insert-image="insertImageFile" />

    <div class="editor-body" @click="handleContentClick">
      <EditorContent :editor="editor" class="editor-scroll" />
    </div>

    <footer class="editor-tags-bar">
      <span
        v-for="(tag, index) in tags"
        :key="tag"
        class="editor-tag"
      >
        {{ tag }}
        <button class="editor-tag-remove" type="button" @click="removeTag(index)">
          <X :size="11" />
        </button>
      </span>
      <input
        v-model="tagInput"
        class="editor-tag-input"
        :placeholder="t('notes.tagInputPlaceholder')"
        maxlength="50"
        @keydown.enter.prevent="addTag"
        @keydown.,.prevent="addTag"
      />
      <span class="subbar-spacer" />
      <span class="meta-item" :title="t('notes.createdAt')">
        <Clock :size="12" />
        {{ formatDateTime(note.createdAt) }}
      </span>
      <span class="meta-item" :title="t('notes.updatedAt')">
        <History :size="12" />
        {{ formatDateTime(note.updatedAt) }}
      </span>
    </footer>

    <!-- 自定义文件夹名输入（替代原生 prompt，风格与全局弹窗统一） -->
    <PromptModal
      :open="categoryModalOpen"
      :title="t('notes.customCategoryPrompt')"
      :label="t('notes.renameFolderLabel')"
      :initial-value="category"
      :confirm-text="t('notes.confirm')"
      :cancel-text="t('notes.cancel')"
      :max-length="50"
      @confirm="handleCategoryPromptConfirm"
      @cancel="categoryModalOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useEditor, EditorContent } from '@tiptap/vue-3';
import {
  ArrowLeft,
  Copy,
  Trash2,
  X,
  Clock,
  History,
  RefreshCw,
  Globe,
  ExternalLink,
  StickyNote,
  FolderClosed,
  Pencil,
  Download,
} from 'lucide-vue-next';
import { t } from '@/utils/i18n';
import type { Note } from '@/types';
import { CATEGORY_INBOX } from '@/utils/notes-database';
import { createEditorExtensions } from '../utils/editor';
import { imageFileToDataUrl, pickImageFiles } from '../utils/image';
import { debounce, formatDateTime, copyText } from '../utils/helpers';
import { categoryDisplay, type NoteCategoryOption } from '../composables/useNotes';
import { exportNote, type NoteExportFormat } from '../utils/export';
import EditorToolbar from './EditorToolbar.vue';
import SelectMenu from './SelectMenu.vue';
import PromptModal from './PromptModal.vue';

const props = defineProps<{
  note: Note;
  saveFn: (
    id: string,
    updates: { title?: string; content?: string; category?: string; tags?: string[] },
  ) => Promise<Note>;
  /** 已有分类列表（value=原始 ID，label=显示名） */
  categoryOptions: NoteCategoryOption[];
  externalPending: boolean;
}>();

const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'delete'): void;
  (e: 'dirty-change', dirty: boolean): void;
  (e: 'reload-external'): void;
  (e: 'notify', payload: { message: string; type: 'success' | 'error' }): void;
}>();

// ---- 本地编辑状态（标题/分类/标签与正文统一防抖保存） ----
const title = ref('');
const category = ref('');
const tags = ref<string[]>([]);
const tagInput = ref('');

const dirty = ref(false);
const saving = ref(false);
const saveError = ref(false);
/** 编辑版本号：保存期间有新编辑时不会被误清除 dirty */
let editVersion = 0;
/** 连续保存失败只提示一次（成功后复位），避免通知刷屏 */
let notifiedFailure = false;
/** 本地回填（hydrateFromNote / applyContent）期间抑制"编辑"判定：
 *  标题/分类/标签的赋值会同步触发下方 flush:'sync' watcher，
 *  无此守卫时每次打开笔记/外部同步都会被误判为用户编辑 →
 *  虚假自动保存（bump updatedAt）并让外部实时同步退化为挂起徽标 */
let hydrating = false;
/** 最近一次回填的标题：保存时「标题清空则保留原标题」的回退源
 *  （不能用 props.note.title——切换笔记时它已是新笔记的标题） */
let hydratedTitle = '';

// ---- Tiptap 编辑器（实时渲染，无独立预览模式） ----
const editor = useEditor({
  extensions: createEditorExtensions(),
  content: props.note.content,
  onUpdate: () => {
    markDirty();
  },
  editorProps: {
    // 粘贴图片 → 压缩为 dataURL 直接插入正文
    handlePaste: (view, event) => {
      const files = pickImageFiles(event.clipboardData?.files);
      if (!files.length) return false;
      event.preventDefault();
      files.forEach((file) => void insertImageFile(file));
      return true;
    },
    // 拖拽图片 → 同上
    handleDrop: (view, event) => {
      const dragEvent = event as DragEvent;
      const files = pickImageFiles(dragEvent.dataTransfer?.files);
      if (!files.length) return false;
      event.preventDefault();
      files.forEach((file) => void insertImageFile(file));
      return true;
    },
  },
});

function hydrateFromNote(): void {
  hydrating = true;
  title.value = typeof props.note.title === 'string' ? props.note.title : '';
  category.value = props.note.category || CATEGORY_INBOX;
  tags.value = Array.isArray(props.note.tags) ? [...props.note.tags] : [];
  hydratedTitle = title.value;
  dirty.value = false;
  saveError.value = false;
  emit('dirty-change', false);
  hydrating = false;
}

function applyContent(html: string): void {
  if (!editor.value) return;
  // emitUpdate=false：回填不触发 onUpdate，避免被误判为用户编辑
  editor.value.commands.setContent(html ?? '', { emitUpdate: false });
}

// 防抖保存器必须声明在下方 note.id watcher 之前：
// watcher 带 immediate:true 会在 setup 期间同步回调，若此时访问
// 尚未初始化的 debouncedSave 会触发 TDZ ReferenceError，中断整个
// setup（标题回填 / 保存监听 / 生命周期注册全部失效 → 标题恒为空）
const debouncedSave = debounce(() => {
  if (dirty.value) void doSave();
}, 600);

/**
 * 笔记切换：先把旧笔记的未保存修改落盘（用旧 ID + 当前本地内容，
 * 同步段在回填覆盖本地状态之前完成捕获），随后回填新笔记。
 */
watch(
  () => props.note.id,
  (newId, oldId) => {
    if (oldId !== undefined && oldId !== newId && dirty.value) {
      void doSave(oldId);
    }
    debouncedSave.cancel();
    hydrateFromNote();
    applyContent(props.note.content);
  },
  { immediate: true },
);

// 同一篇笔记被外部更新（智能体写入且本地空闲）：跟随最新内容
watch(
  () => [props.note.title, props.note.content, props.note.category, props.note.tags],
  () => {
    if (dirty.value || saving.value) return;
    hydrateFromNote();
    applyContent(props.note.content);
  },
);

// ---- 自动保存 ----
/**
 * 保存当前（或指定 targetId 的）本地内容。
 * targetId 用于「切换笔记前保存旧笔记」场景：props.note.id 已指向新笔记。
 */
async function doSave(targetId?: string): Promise<void> {
  const noteId = targetId ?? props.note.id;
  const version = editVersion;
  // 同步构建保存快照：即便随后本地状态被回填覆盖，本次保存内容不受影响
  const updates = {
    title: title.value.trim() || hydratedTitle,
    content: editor.value ? editor.value.getHTML() : props.note.content,
    category: category.value,
    tags: [...tags.value],
  };

  saving.value = true;
  try {
    await props.saveFn(noteId, updates);
    notifiedFailure = false;
    saveError.value = false;
    if (version === editVersion) {
      dirty.value = false;
      emit('dirty-change', false);
    }
  } catch (error) {
    console.error('[Notes] 保存失败:', error);
    saveError.value = true;
    if (!notifiedFailure) {
      notifiedFailure = true;
      const reason = error instanceof Error ? error.message : String(error);
      emit('notify', { message: `${t('notes.saveFailed')}: ${reason}`, type: 'error' });
    }
  } finally {
    saving.value = false;
  }
}

function markDirty(): void {
  if (hydrating) return; // 回填赋值不是用户编辑
  editVersion += 1;
  dirty.value = true;
  emit('dirty-change', true);
  debouncedSave();
}

// 标题 / 分类 / 标签变更同样进入统一防抖保存。
// flush:'sync'：回填（hydrateFromNote）期间同步触发并被 hydrating 守卫拦截；
// 若用默认异步 flush，守卫在回调执行时已复位，刚打开的笔记会被误判为"已编辑"
watch([title, category], markDirty, { flush: 'sync' });
watch(
  tags,
  () => {
    markDirty();
  },
  { deep: true, flush: 'sync' },
);

/** 立即落盘未保存修改（返回按钮 / Esc / 父级调用） */
async function flushSave(): Promise<void> {
  if (!dirty.value) return;
  debouncedSave.cancel();
  await doSave();
}

// 供父组件（App）在 Esc 等全局快捷键中调用
defineExpose({ flushSave });

async function handleBackClick(): Promise<void> {
  await flushSave();
  emit('back');
}

function handleKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (event.repeat) return;
    if (dirty.value) void doSave();
  }
}

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  if (dirty.value) {
    event.preventDefault();
    event.returnValue = '';
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
  window.addEventListener('beforeunload', handleBeforeUnload);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('beforeunload', handleBeforeUnload);
  document.removeEventListener('click', closeExportMenu);
  // 卸载前若有未保存修改：丢弃防抖定时器，尽力直接落盘
  // （saveFn 对已删除的笔记抛可读错误，不会复活数据）
  debouncedSave.cancel();
  if (dirty.value) void doSave();
});

// ---- 保存状态指示 ----
const saveStatusText = computed(() => {
  if (saving.value) return t('notes.saving');
  if (saveError.value) return t('notes.saveFailed');
  if (dirty.value) return t('notes.dirty');
  return t('notes.saved');
});

const saveStatusClass = computed(() => {
  if (saving.value) return 'status-saving';
  if (saveError.value) return 'status-error';
  if (dirty.value) return 'status-dirty';
  return 'status-saved';
});

// ---- 来源 / 分类 / 标签 ----
const sourceHost = computed(() => {
  try {
    return new URL(props.note.source?.url ?? '').hostname.replace(/^www\./, '');
  } catch {
    return props.note.source?.url ?? '';
  }
});

/** 分类下拉候选：按原始 ID 去重；当前分类若不在已有列表（自定义输入）
 *  也会补入，保证选中的值一定存在于选项中 */
const categorySelectOptions = computed<NoteCategoryOption[]>(() => {
  const options = props.categoryOptions.filter(
    (option, index) => props.categoryOptions.findIndex((o) => o.value === option.value) === index,
  );
  if (category.value && !options.some((option) => option.value === category.value)) {
    options.unshift({ value: category.value, label: categoryDisplay(category.value) });
  }
  if (!options.length) {
    options.push({ value: CATEGORY_INBOX, label: categoryDisplay(CATEGORY_INBOX) });
  }
  return options;
});

function handleCategoryChange(value: string): void {
  if (value && value !== category.value) category.value = value;
}

/** 自定义文件夹：弹窗输入新文件夹名（可编辑当前值；初始值用原始 ID 防止显示名被存回库） */
const categoryModalOpen = ref(false);

function handleCustomCategory(): void {
  categoryModalOpen.value = true;
}

function handleCategoryPromptConfirm(next: string): void {
  categoryModalOpen.value = false;
  const cleaned = next.trim();
  if (cleaned && cleaned !== category.value) {
    category.value = cleaned.slice(0, 50);
  }
}

function addTag(): void {
  const value = tagInput.value.trim().replace(/^#+/, '');
  if (!value) return;
  if (value.length > 50 || tags.value.length >= 50) {
    emit('notify', { message: t('notes.toastTagLimit'), type: 'error' });
    return;
  }
  if (!tags.value.includes(value)) {
    tags.value.push(value);
  }
  tagInput.value = '';
}

function removeTag(index: number): void {
  tags.value.splice(index, 1);
}

// ---- 图片插入（工具栏按钮 / 粘贴 / 拖拽汇聚于此） ----
async function insertImageFile(file: File): Promise<void> {
  try {
    const src = await imageFileToDataUrl(file);
    if (!editor.value) return;
    editor.value.chain().focus().setImage({ src, alt: file.name.replace(/\.[^.]+$/, '') }).run();
    // setImage 是编辑器事务，onUpdate → markDirty 已覆盖保存触发
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    emit('notify', { message: `${t('notes.toastImageFailed')}: ${reason}`, type: 'error' });
  }
}

/** 正文内链接：统一拦截到新标签页打开（避免工作区标签页被导航走） */
function handleContentClick(event: MouseEvent): void {
  const anchor = (event.target as HTMLElement).closest('a');
  if (!anchor) return;
  const href = anchor.getAttribute('href');
  if (!href) return;
  event.preventDefault();
  try {
    window.open(href, '_blank', 'noopener');
  } catch {
    // 弹窗被拦截等场景静默忽略
  }
}

/**
 * 接受外部更新：本地未保存编辑作废（防抖保存因 dirty=false 自动跳过），
 * 随后父组件用存储中的最新内容刷新 props.note，watcher 据此回填编辑器
 */
function handleReloadExternal(): void {
  debouncedSave.cancel();
  dirty.value = false;
  saveError.value = false;
  notifiedFailure = false;
  emit('dirty-change', false);
  emit('reload-external');
}

// ---- 复制 ----
async function copyId(): Promise<void> {
  const ok = await copyText(props.note.id);
  emit(
    'notify',
    ok
      ? { message: t('notes.idCopied'), type: 'success' }
      : { message: t('notes.toastCopyFailed'), type: 'error' },
  );
}

// ---- 导出（txt / md / docx / pdf） ----
const exportOpen = ref(false);

async function handleExport(format: NoteExportFormat): Promise<void> {
  exportOpen.value = false;
  // 标题以本地编辑态优先（未保存的改动也要进文件名）；正文取编辑器实时内容
  const exportTitle = title.value.trim() || hydratedTitle || t('notes.untitled');
  try {
    const outcome = await exportNote(format, {
      title: exportTitle,
      html: editor.value?.getHTML() ?? props.note.content,
      subtitle: `${t('notes.updatedAt')} ${formatDateTime(props.note.updatedAt)}`,
    });
    if (format === 'pdf') {
      // PDF 走打印管线：提示用户在打印面板选择「另存为 PDF」
      emit('notify', { message: t('notes.exportPdfHint'), type: 'success' });
    } else {
      emit('notify', {
        message: t('notes.exportDone', { file: outcome.fileName ?? '' }),
        type: 'success',
      });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    emit('notify', { message: `${t('notes.exportFailed')}: ${reason}`, type: 'error' });
  }
}

/** Esc 关闭导出菜单（菜单开着时阻断全局「返回列表」，否则放行） */
function handleExportEsc(event: KeyboardEvent): void {
  if (!exportOpen.value) return;
  event.stopPropagation();
  event.preventDefault();
  exportOpen.value = false;
}

function closeExportMenu(): void {
  exportOpen.value = false;
}

// 菜单展开期间监听文档级点击：点其它区域即收起（触发按钮带 .stop 不受影响）
watch(exportOpen, (open) => {
  if (open) document.addEventListener('click', closeExportMenu);
  else document.removeEventListener('click', closeExportMenu);
});
</script>
