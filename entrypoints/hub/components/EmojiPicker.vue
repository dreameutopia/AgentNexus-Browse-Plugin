<template>
  <!--
    头像 emoji 选择悬浮卡片：类别 tab + 网格点选。
    数据来自 utils/agents/emoji-presets（全量清单，模块初始化时已去重）；
    选中回传 select 事件，由父级写入 form.avatar（与图片形态互斥）并收起卡片；
    点击组件外部或按 Esc 经 close 事件请求收起（收起决策在父级）。
  -->
  <div ref="rootRef" class="emoji-picker" role="listbox" :aria-label="t('hub.avatarChooseEmoji')">
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
 * 头像 emoji 选择悬浮卡片（仅头像编辑器使用）。
 * 单选模式：点击即选中并冒泡给父级；selected 仅用于高亮当前头像。
 * 悬浮语义：卡片绝对定位于头像行下方（父级 .hub-avatar-picker 是定位锚），
 * 点击外部 / Esc 发出 close 事件，由父级决定收起。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { t, type MessageKey } from '@/utils/i18n';
import { EMOJI_CATEGORIES } from '@/utils/agents/emoji-presets';

defineProps<{
  /** 当前已选 emoji（图片形态或空时传空串，仅影响高亮） */
  selected?: string;
}>();

const emit = defineEmits<{
  /** 用户点选了某个 emoji（父级负责写入头像并收起卡片） */
  select: [emoji: string];
  /** 请求收起（点击外部 / Esc；父级负责收起） */
  close: [];
}>();

/** 当前激活的类别 tab（默认第一个：笑脸） */
const activeId = ref(EMOJI_CATEGORIES[0]?.id ?? '');

/** 当前类别的 emoji 列表 */
const activeEmojis = computed(
  () => EMOJI_CATEGORIES.find(category => category.id === activeId.value)?.emojis ?? [],
);

/** 点击组件外部 → 请求收起（捕获阶段监听，先于其它点击处理） */
const rootRef = ref<HTMLElement | null>(null);
function handleDocumentPointerDown(event: PointerEvent): void {
  const target = event.target as Node | null;
  if (target && rootRef.value?.contains(target)) return;
  emit('close');
}

function handleDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown, true);
  document.addEventListener('keydown', handleDocumentKeydown, true);
});
onUnmounted(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
  document.removeEventListener('keydown', handleDocumentKeydown, true);
});
</script>

<style scoped>
/* 悬浮卡片：绝对定位于头像行下方（父级 .hub-avatar-picker 提供 position: relative），
   实底白卡 + 柔影 + 向下展开的进场动画，不占据表单布局高度 */
.emoji-picker {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 50;
  border: 1px solid var(--line-soft, #e4e2de);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.97);
  backdrop-filter: blur(18px) saturate(150%);
  -webkit-backdrop-filter: blur(18px) saturate(150%);
  box-shadow: 0 12px 32px rgba(41 40 36 / 16%), 0 1px 3px rgba(41 40 36 / 8%);
  overflow: hidden;
  animation: emojiPickerPop 0.16s cubic-bezier(0.22, 0.61, 0.36, 1) both;
  transform-origin: top left;
}

@keyframes emojiPickerPop {
  from {
    opacity: 0;
    transform: translateY(-4px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.emoji-picker-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 8px 8px 0;
  border-bottom: 1px solid rgba(41 40 36 / 6%);
}

.emoji-picker-tab {
  border: none;
  background: transparent;
  font-size: 11px;
  font-family: inherit;
  color: var(--ink-secondary, #787671);
  padding: 4px 9px;
  border-radius: 7px;
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}

.emoji-picker-tab:hover {
  color: var(--ink-primary, #292824);
  background: rgba(41 40 36 / 5%);
}

.emoji-picker-tab.is-active {
  color: var(--ink-primary, #292824);
  background: rgba(41, 40, 36, 0.1);
  font-weight: 600;
}

.emoji-picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(34px, 1fr));
  gap: 2px;
  padding: 8px;
  width: min(340px, 68vw);
  max-height: 224px;
  overflow-y: auto;
}

.emoji-picker-item {
  border: 1px solid transparent;
  background: transparent;
  border-radius: 9px;
  font-size: 20px;
  line-height: 1;
  padding: 5px 0;
  cursor: pointer;
  font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
  transition: background 0.12s ease, border-color 0.12s ease, transform 0.18s cubic-bezier(0.32, 0.72, 0, 1);
}

.emoji-picker-item:hover {
  background: rgba(255, 255, 255, 0.7);
  border-color: rgba(41 40 36 / 8%);
  transform: translateY(-1px);
}

.emoji-picker-item:active {
  transform: scale(0.92);
}

.emoji-picker-item.is-active {
  border-color: rgba(41, 40, 36, 0.4);
  background: rgba(41, 40, 36, 0.1);
}
</style>
