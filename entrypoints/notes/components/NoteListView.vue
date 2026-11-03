<template>
  <div class="list-view">
    <header class="list-header">
      <h1 class="list-title">{{ title }}</h1>
      <select
        :value="sortMode"
        class="sort-select"
        :title="t('notes.sortNewest')"
        @change="$emit('update:sortMode', ($event.target as HTMLSelectElement).value as NoteSortMode)"
      >
        <option value="newest">{{ t('notes.sortNewest') }}</option>
        <option value="oldest">{{ t('notes.sortOldest') }}</option>
        <option value="title">{{ t('notes.sortTitle') }}</option>
      </select>
    </header>

    <div v-if="notes.length" class="note-grid">
      <article
        v-for="note in notes"
        :key="note.id"
        class="note-card"
        @click="$emit('open', note.id)"
      >
        <div class="note-card-header">
          <span class="note-card-kind" :class="`kind-${note.kind}`">
            <img
              v-if="note.kind === 'webpage' && note.source?.favicon"
              class="card-favicon"
              :src="note.source.favicon"
              alt=""
              @error="($event.target as HTMLImageElement).style.display = 'none'"
            />
            <Globe v-else-if="note.kind === 'webpage'" :size="12" />
            <StickyNote v-else :size="12" />
            <span>{{ note.kind === 'webpage' ? hostOf(note) : t('notes.kindNote') }}</span>
          </span>
          <button
            class="note-card-delete"
            type="button"
            :title="t('notes.deleteNote')"
            @click.stop="$emit('delete', note.id)"
          >
            <Trash2 :size="14" />
          </button>
        </div>

        <h2 class="note-card-title">{{ note.title || t('notes.untitled') }}</h2>
        <p class="note-card-preview">{{ note.textPreview || t('notes.emptyContent') }}</p>

        <div class="note-card-footer">
          <div class="note-card-chips">
            <span class="category-chip">{{ categoryDisplay(note.category) }}</span>
            <span v-for="tag in note.tags.slice(0, 3)" :key="tag" class="tag-chip">
              # {{ tag }}
            </span>
          </div>
          <time class="note-card-time">{{ formatRelativeTime(note.updatedAt) }}</time>
        </div>
      </article>
    </div>

    <div v-else class="empty-state">
      <div class="empty-icon"><FilePenLine :size="44" /></div>
      <h2 class="empty-title">{{ emptyTitle }}</h2>
      <p class="empty-description">{{ t('notes.emptyDescription') }}</p>
      <button class="empty-create-btn" type="button" @click="$emit('create')">
        <Plus :size="16" />
        <span>{{ t('notes.newNote') }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Trash2, FilePenLine, Plus, Globe, StickyNote } from 'lucide-vue-next';
import { t } from '@/utils/i18n';
import type { NoteListItem } from '@/utils/notes-database';
import { formatRelativeTime } from '../utils/helpers';
import { categoryDisplay, type NoteSortMode } from '../composables/useNotes';

const props = defineProps<{
  notes: NoteListItem[];
  title: string;
  hasFilter: boolean;
  sortMode: NoteSortMode;
}>();

defineEmits<{
  (e: 'open', id: string): void;
  (e: 'delete', id: string): void;
  (e: 'create'): void;
  (e: 'update:sortMode', mode: NoteSortMode): void;
}>();

const emptyTitle = computed(() =>
  props.hasFilter ? t('notes.emptyFiltered') : t('notes.emptyTitle'),
);

/** 网页卡片的站点显示名（域名去 www 前缀） */
function hostOf(note: NoteListItem): string {
  try {
    return new URL(note.source?.url ?? '').hostname.replace(/^www\./, '');
  } catch {
    return t('notes.kindWebpage');
  }
}
</script>
