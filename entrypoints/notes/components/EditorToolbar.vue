<template>
  <div class="editor-toolbar" v-if="editor">
    <button
      class="tb-btn"
      type="button"
      :disabled="!editor.can().undo()"
      :title="t('notes.tbUndo')"
      @click="editor.chain().focus().undo().run()"
    >
      <Undo2 :size="15" />
    </button>
    <button
      class="tb-btn"
      type="button"
      :disabled="!editor.can().redo()"
      :title="t('notes.tbRedo')"
      @click="editor.chain().focus().redo().run()"
    >
      <Redo2 :size="15" />
    </button>

    <span class="tb-divider" />

    <SelectMenu
      :model-value="headingValue"
      :items="headingItems"
      :title="t('notes.headingParagraph')"
      size="xs"
      @update:model-value="handleHeadingChange"
    />

    <button
      class="tb-btn"
      :class="{ active: editor.isActive('bold') }"
      type="button"
      :title="t('notes.tbBold')"
      @click="editor.chain().focus().toggleBold().run()"
    >
      <Bold :size="15" />
    </button>
    <button
      class="tb-btn"
      :class="{ active: editor.isActive('italic') }"
      type="button"
      :title="t('notes.tbItalic')"
      @click="editor.chain().focus().toggleItalic().run()"
    >
      <Italic :size="15" />
    </button>
    <button
      class="tb-btn"
      :class="{ active: editor.isActive('strike') }"
      type="button"
      :title="t('notes.tbStrike')"
      @click="editor.chain().focus().toggleStrike().run()"
    >
      <Strikethrough :size="15" />
    </button>
    <button
      class="tb-btn"
      :class="{ active: editor.isActive('code') }"
      type="button"
      :title="t('notes.tbCode')"
      @click="editor.chain().focus().toggleCode().run()"
    >
      <Code :size="15" />
    </button>

    <span class="tb-divider" />

    <button
      class="tb-btn"
      :class="{ active: editor.isActive('bulletList') }"
      type="button"
      :title="t('notes.tbBulletList')"
      @click="editor.chain().focus().toggleBulletList().run()"
    >
      <List :size="15" />
    </button>
    <button
      class="tb-btn"
      :class="{ active: editor.isActive('orderedList') }"
      type="button"
      :title="t('notes.tbOrderedList')"
      @click="editor.chain().focus().toggleOrderedList().run()"
    >
      <ListOrdered :size="15" />
    </button>
    <button
      class="tb-btn"
      :class="{ active: editor.isActive('blockquote') }"
      type="button"
      :title="t('notes.tbQuote')"
      @click="editor.chain().focus().toggleBlockquote().run()"
    >
      <Quote :size="15" />
    </button>
    <button
      class="tb-btn"
      :class="{ active: editor.isActive('codeBlock') }"
      type="button"
      :title="t('notes.tbCodeBlock')"
      @click="editor.chain().focus().toggleCodeBlock().run()"
    >
      <SquareCode :size="15" />
    </button>
    <button
      class="tb-btn"
      type="button"
      :title="t('notes.tbHr')"
      @click="editor.chain().focus().setHorizontalRule().run()"
    >
      <Minus :size="15" />
    </button>

    <span class="tb-divider" />

    <button
      class="tb-btn"
      :class="{ active: editor.isActive('link') }"
      type="button"
      :title="t('notes.tbLink')"
      @click="handleLink"
    >
      <Link2 :size="15" />
    </button>
    <button
      class="tb-btn"
      type="button"
      :title="t('notes.tbImage')"
      @click="fileInput?.click()"
    >
      <ImagePlus :size="15" />
    </button>
    <button
      class="tb-btn"
      type="button"
      :title="t('notes.tbClearFormat')"
      @click="editor.chain().focus().unsetAllMarks().clearNodes().run()"
    >
      <RemoveFormatting :size="15" />
    </button>

    <!-- 隐藏的图片选择器：选中即插入光标位置 -->
    <input
      ref="fileInput"
      type="file"
      accept="image/*"
      multiple
      hidden
      @change="handleFileChange"
    />

    <!-- 链接输入（替代原生 prompt，风格与全局弹窗统一；留空 = 移除链接） -->
    <PromptModal
      :open="linkModalOpen"
      :title="t('notes.tbLink')"
      :label="t('notes.linkPrompt')"
      :initial-value="lastLinkHref"
      placeholder="https://"
      :allow-empty="true"
      :max-length="2048"
      :confirm-text="t('notes.confirm')"
      :cancel-text="t('notes.cancel')"
      @confirm="handleLinkConfirm"
      @cancel="linkModalOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  Undo2,
  Redo2,
  Bold,
  Italic,
  Strikethrough,
  Code,
  List,
  ListOrdered,
  Quote,
  SquareCode,
  Minus,
  Link2,
  ImagePlus,
  RemoveFormatting,
} from 'lucide-vue-next';
import type { Editor } from '@tiptap/vue-3';
import { t } from '@/utils/i18n';
import SelectMenu from './SelectMenu.vue';
import PromptModal from './PromptModal.vue';

const props = defineProps<{
  editor: Editor | undefined;
}>();

const emit = defineEmits<{
  (e: 'insert-image', file: File): void;
}>();

const fileInput = ref<HTMLInputElement | null>(null);

/** 当前标题级别（0 = 正文段落） */
const headingValue = computed(() => {
  const editor = props.editor;
  if (!editor || !editor.isActive('heading')) return '0';
  const level = editor.getAttributes('heading').level;
  return String(Array.isArray(level) ? level[0] ?? 0 : level ?? 0);
});

/** 标题级别候选（computed 保持语言切换时文案响应式） */
const headingItems = computed(() => [
  { value: '0', label: t('notes.headingParagraph') },
  { value: '1', label: t('notes.heading1') },
  { value: '2', label: t('notes.heading2') },
  { value: '3', label: t('notes.heading3') },
]);

function handleHeadingChange(value: string): void {
  const editor = props.editor;
  if (!editor) return;
  if (value === '0') {
    editor.chain().focus().setParagraph().run();
  } else {
    editor.chain().focus().setHeading({ level: Number(value) as 1 | 2 | 3 }).run();
  }
}

// ---- 链接（自定义输入弹窗，替代原生 prompt） ----
const linkModalOpen = ref(false);
/** 打开弹窗时预填的既有链接地址 */
const lastLinkHref = ref('');

/** 链接：选中状态下再次点击即移除；否则弹窗输入 URL */
function handleLink(): void {
  const editor = props.editor;
  if (!editor) return;

  if (editor.isActive('link')) {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    return;
  }

  lastLinkHref.value = String(editor.getAttributes('link').href ?? '');
  linkModalOpen.value = true;
}

function handleLinkConfirm(url: string): void {
  linkModalOpen.value = false;
  const editor = props.editor;
  if (!editor) return;
  const href = url.trim();
  if (!href) {
    editor.chain().focus().unsetLink().run();
    return;
  }
  editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
}

function handleFileChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  // 清空 value：允许连续选择同一文件时再次触发 change
  input.value = '';
  files.forEach((file) => emit('insert-image', file));
}
</script>
