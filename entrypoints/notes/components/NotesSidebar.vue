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

        <div class="nav-section-title">{{ t('notes.navCategories') }}</div>
        <button
          v-for="item in categories"
          :key="item.category"
          class="nav-item"
          :class="{ active: filterMode === 'category' && filterValue === item.category }"
          type="button"
          @click="$emit('set-filter', 'category', item.category)"
        >
          <FolderClosed :size="14" />
          <span class="nav-item-label">{{ categoryDisplay(item.category) }}</span>
          <span class="nav-item-count">{{ item.count }}</span>
        </button>

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
  </aside>
</template>

<script setup lang="ts">
import { NotebookPen, Plus, Search, Layers, FolderClosed, Sun, Moon } from 'lucide-vue-next';
import { t } from '@/utils/i18n';
import { categoryDisplay, type NoteFilterMode } from '../composables/useNotes';

defineProps<{
  searchQuery: string;
  filterMode: NoteFilterMode;
  filterValue: string;
  categories: { category: string; count: number }[];
  tags: { tag: string; count: number }[];
  totalNotes: number;
  isDark: boolean;
}>();

defineEmits<{
  (e: 'create'): void;
  (e: 'update:searchQuery', value: string): void;
  (e: 'set-filter', mode: NoteFilterMode, value: string): void;
  (e: 'toggle-theme'): void;
}>();
</script>
