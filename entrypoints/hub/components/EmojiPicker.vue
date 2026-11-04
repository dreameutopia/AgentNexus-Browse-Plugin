<template>
  <!--
    头像 emoji 选择卡片：类别 tab + 网格点选。
    数据来自 utils/agents/emoji-presets（全量清单，模块初始化时已去重）；
    选中回传 select 事件，由父级写入 form.avatar（与图片形态互斥）。
  -->
  <div class="emoji-picker" role="listbox" :aria-label="t('hub.avatarChooseEmoji')">
    <div class="emoji-picker-tabs" role="tablist">
      <button
        v-for="category in EMOJI_CATEGORIES"
        :key="category.id"
        type="button"
        role="tab"
        class="emoji-picker-tab"
        :class="{ 'is-active': activeId === category.id }"
        :aria-selected="activeId === category.id"
        @click="activeId = category.id"
      >
        {{ t(category.labelKey as MessageKey) }}
      </button>
    </div>
    <div class="emoji-picker-grid">
      <button
        v-for="emoji in activeEmojis"
        :key="emoji"
        type="button"
        class="emoji-picker-item"
        :class="{ 'is-active': emoji === selected }"
        role="option"
        :aria-selected="emoji === selected"
        :title="emoji"
        @click="emit('select', emoji)"
      >
        {{ emoji }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 头像 emoji 选择卡片（仅头像编辑器使用）。
 * 单选模式：点击即选中并冒泡给父级；selected 仅用于高亮当前头像。
 */
import { computed, ref } from 'vue';
import { t, type MessageKey } from '@/utils/i18n';
import { EMOJI_CATEGORIES } from '@/utils/agents/emoji-presets';

defineProps<{
  /** 当前已选 emoji（图片形态或空时传空串，仅影响高亮） */
  selected?: string;
}>();

const emit = defineEmits<{
  /** 用户点选了某个 emoji（父级负责写入头像） */
  select: [emoji: string];
}>();

/** 当前激活的类别 tab（默认第一个：笑脸） */
const activeId = ref(EMOJI_CATEGORIES[0]?.id ?? '');

/** 当前类别的 emoji 列表 */
const activeEmojis = computed(
  () => EMOJI_CATEGORIES.find(category => category.id === activeId.value)?.emojis ?? [],
);
</script>

<style scoped>
.emoji-picker {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  background: #fff;
  overflow: hidden;
}

.emoji-picker-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 8px 8px 0;
  border-bottom: 1px solid #f3f4f6;
}

.emoji-picker-tab {
  border: none;
  background: transparent;
  font-size: 11px;
  color: #6b7280;
  padding: 4px 8px;
  border-radius: 6px 6px 0 0;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.emoji-picker-tab:hover {
  color: #374151;
  background: #f3f4f6;
}

.emoji-picker-tab.is-active {
  color: #667eea;
  background: rgba(102, 126, 234, 0.1);
  font-weight: 600;
}

.emoji-picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(34px, 1fr));
  gap: 2px;
  padding: 8px;
  max-height: 220px;
  overflow-y: auto;
}

.emoji-picker-item {
  border: 1px solid transparent;
  background: transparent;
  border-radius: 8px;
  font-size: 20px;
  line-height: 1;
  padding: 5px 0;
  cursor: pointer;
  font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
  transition: background 0.12s, border-color 0.12s;
}

.emoji-picker-item:hover {
  background: #f3f4f6;
  border-color: #e5e7eb;
}

.emoji-picker-item.is-active {
  border-color: #667eea;
  background: rgba(102, 126, 234, 0.12);
}
</style>
