<template>
  <div v-if="items.length" class="plan-board" :class="{ 'is-expanded': expanded }">
    <!-- 折叠态头部：图标 + 标题 + 完成计数 + 当前进行中的步骤（点击展开全量列表） -->
    <button
      type="button"
      class="plan-board__header"
      :title="expanded ? t('sidepanel.plan.collapse') : t('sidepanel.plan.expand')"
      :aria-expanded="expanded"
      @click="toggleExpanded"
    >
      <span class="plan-board__mark" aria-hidden="true">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 5H10V11H4V5Z M4 13H10V19H4V13Z M12 6H20V8H12V6Z M12 10H20V12H12V10Z M12 16H20V18H12V16Z M12 14H20V15H12V14Z" fill="currentColor" />
        </svg>
      </span>
      <span class="plan-board__title">{{ t('sidepanel.plan.title') }}</span>
      <span class="plan-board__counter">
        {{ doneCount }}<span class="plan-board__counter-sep">/</span>{{ items.length }}
      </span>
      <span v-if="currentStepText" class="plan-board__current" :title="currentStepText">
        <span class="plan-board__current-label">{{ t('sidepanel.plan.currentPrefix') }}</span>{{ currentStepText }}
      </span>
      <svg
        class="plan-board__chevron"
        :class="{ 'is-open': expanded }"
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <!-- 进度条：已完成占比（细线，不喧宾夺主） -->
    <div class="plan-board__track" aria-hidden="true">
      <span class="plan-board__track-fill" :style="{ width: `${progressPercent}%` }"></span>
    </div>

    <!-- 展开态：全量计划项（状态徽标 + id + 步骤 + 标注信息） -->
    <div v-if="expanded" class="plan-board__list">
      <div
        v-for="item in items"
        :key="item.id"
        class="plan-item"
        :class="`is-${item.status}`"
      >
        <span
          class="plan-item__badge"
          :class="`is-${item.status}`"
          role="img"
          :aria-label="statusLabel(item.status)"
          :title="statusLabel(item.status)"
        >
          <Check v-if="item.status === 'done'" :size="11" :stroke-width="3" aria-hidden="true" />
          <X v-else-if="item.status === 'failed'" :size="11" :stroke-width="3" aria-hidden="true" />
          <span v-else-if="item.status === 'in_progress'" class="plan-item__dot" aria-hidden="true"></span>
        </span>
        <span class="plan-item__body">
          <span class="plan-item__line">
            <span class="plan-item__id">{{ item.id }}.</span>
            <span class="plan-item__step">{{ item.step }}</span>
          </span>
          <span v-if="item.message" class="plan-item__message" :title="item.message">{{ item.message }}</span>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 会话计划面板（PlanBoard）
 *
 * 展示当前会话的任务计划（plan_tool 产物）：折叠态为「图标 + 标题 + 完成计数
 * + 进行中的步骤」单行摘要（不打扰输入），展开态为全量计划项（状态徽标、
 * 步骤、成功/失败标注信息）。数据经 plan-store 订阅实时刷新（工具每次
 * 变更即触发），会话切换由 chatId prop 驱动重新加载（持久化数据按会话
 * 隔离，切换历史会话自动回显各自计划）。
 *
 * 样式自带（./plan-board.css）：app.css 经 App.vue 的 <style scoped> 引入，
 * 作用域属性无法穿透到本组件，放在那里等于没放。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { Check, X } from 'lucide-vue-next';
import { t } from '@/utils/i18n';
import { getPlan, onPlanChange, type PlanItem, type PlanItemStatus } from '@/utils/plan/plan-store';
import './plan-board.css';

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

/** 进度条占比（按已完成项计，失败项不计完成） */
const progressPercent = computed(() =>
  items.value.length ? Math.round((doneCount.value / items.value.length) * 100) : 0,
);

/** 折叠态展示的「进行中」步骤（无进行中项时不显示该段） */
const currentStepText = computed(() => {
  const current = items.value.find(item => item.status === 'in_progress');
  return current ? current.step : '';
});

const toggleExpanded = (): void => {
  expanded.value = !expanded.value;
};

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
