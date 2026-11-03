<template>
  <div v-if="items.length" class="plan-board" :class="{ 'is-expanded': expanded }">
    <!-- 折叠态头部：标题 + 进度 + 当前进行中的步骤（点击展开全量列表） -->
    <button
      type="button"
      class="plan-board-header"
      :title="expanded ? t('sidepanel.plan.collapse') : t('sidepanel.plan.expand')"
      @click="toggleExpanded"
    >
      <svg class="plan-board-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M4 5H10V11H4V5Z M4 13H10V19H4V13Z M12 6H20V8H12V6Z M12 10H20V12H12V10Z M12 16H20V18H12V16Z M12 14H20V15H12V14Z" fill="currentColor" />
      </svg>
      <span class="plan-board-title">{{ t('sidepanel.plan.title') }}</span>
      <span class="plan-board-progress">{{ t('sidepanel.plan.progress', { done: doneCount, total: items.length }) }}</span>
      <span v-if="currentStepText" class="plan-board-current" :title="currentStepText">
        {{ t('sidepanel.plan.currentPrefix') }}{{ currentStepText }}
      </span>
      <svg
        class="plan-board-chevron"
        :class="{ 'is-open': expanded }"
        width="10" height="10" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"
      >
        <path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <!-- 展开态：全量计划项（状态图标 + id + 步骤 + 标注信息） -->
    <div v-if="expanded" class="plan-board-list">
      <div
        v-for="item in items"
        :key="item.id"
        class="plan-item"
        :class="`is-${item.status}`"
      >
        <span
          class="plan-item-icon"
          role="img"
          :aria-label="statusLabel(item.status)"
          :title="statusLabel(item.status)"
        >{{ statusGlyph(item.status) }}</span>
        <span class="plan-item-body">
          <span class="plan-item-line">
            <span class="plan-item-id">{{ item.id }}.</span>
            <span class="plan-item-step">{{ item.step }}</span>
          </span>
          <span v-if="item.message" class="plan-item-message" :title="item.message">{{ item.message }}</span>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 会话计划面板（PlanBoard）
 *
 * 展示当前会话的任务计划（plan_tool 产物）：折叠态为「标题 + 完成进度 +
 * 进行中的步骤」单行摘要（不打扰输入），展开态为全量计划项（状态图标、
 * 步骤、成功/失败标注信息）。数据经 plan-store 订阅实时刷新（工具每次
 * 变更即触发），会话切换由 chatId prop 驱动重新加载（持久化数据按会话
 * 隔离，切换历史会话自动回显各自计划）。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { t } from '@/utils/i18n';
import { getPlan, onPlanChange, type PlanItem, type PlanItemStatus } from '@/utils/plan/plan-store';

const props = defineProps<{
  /** 当前会话 id（计划隔离键；空串时面板自然隐藏——无计划可展示） */
  chatId: string;
}>();

const items = ref<PlanItem[]>([]);
const expanded = ref(false);

/** 从 store 重载当前会话计划（浅拷贝数组，避免持有内部引用） */
const reload = (): void => {
  items.value = getPlan(props.chatId);
};

// 会话切换 → 重载对应计划（历史会话回显）；展开态保持用户选择不重置
watch(
  () => props.chatId,
  () => reload(),
);

// 计划变更订阅：只响应当前会话的变更（其它会话的并发运行互不打扰）
let unsubscribe: (() => void) | null = null;
onMounted(() => {
  reload();
  unsubscribe = onPlanChange(changedChatId => {
    if (changedChatId === props.chatId) reload();
  });
});
onUnmounted(() => {
  unsubscribe?.();
  unsubscribe = null;
});

const doneCount = computed(() => items.value.filter(item => item.status === 'done').length);

/** 折叠态展示的「进行中」步骤（无进行中项时不显示该段） */
const currentStepText = computed(() => {
  const current = items.value.find(item => item.status === 'in_progress');
  return current ? current.step : '';
});

const toggleExpanded = (): void => {
  expanded.value = !expanded.value;
};

/** 状态 → 图标字形（语义色由 is-* 类在 CSS 中控制） */
function statusGlyph(status: PlanItemStatus): string {
  switch (status) {
    case 'pending':
      return '○';
    case 'in_progress':
      return '◐';
    case 'done':
      return '✓';
    case 'failed':
      return '✕';
  }
}

/** 状态 → 无障碍标签 / 悬浮气泡文案 */
function statusLabel(status: PlanItemStatus): string {
  switch (status) {
    case 'pending':
      return t('sidepanel.plan.pending');
    case 'in_progress':
      return t('sidepanel.plan.inProgress');
    case 'done':
      return t('sidepanel.plan.done');
    case 'failed':
      return t('sidepanel.plan.failed');
  }
}
</script>
