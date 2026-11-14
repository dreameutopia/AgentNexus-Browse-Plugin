<!--
  循环守卫停止注记（消息流内终态卡片）

  取代原先的通用系统信息条：达到轮次 / 运行时长上限且未确认继续时，
  停止说明需要给出可执行的后续动作，而不是只让用户自己去输入框重来。

  交互语义（与 API 错误卡片的重试同构，应用层持有全部守卫）：
  - 继续：以自动生成的用户消息「继续」续跑（模型上下文可见，消息流不渲染
    用户气泡）；若注记之后已有任何新输出（用户消息 / 模型输出 / 系统注记），
    点击时由应用层拒绝并给出友好提示——过期判定不在这里做；
  - 修改设置：打开设置弹窗并定位到对应分区（轮次上限 / 循环参数）。

  视觉口径对齐循环守卫确认条（GuardConfirmBar / 计划卡）：白底卡片 +
  --line-soft 描边 + 14px 圆角 + 轻投影；主行动按钮取 --ink-primary 深墨底，
  次行动为中性灰胶囊。按需求不再渲染三角感叹号图标。
-->
<template>
  <div class="guard-stop-notice" role="note">
    <p class="guard-stop-text">{{ text }}</p>
    <div class="guard-stop-actions">
      <button
        type="button"
        class="guard-stop-btn guard-stop-btn-secondary"
        @click="emit('open-settings')"
      >
        {{ t('sidepanel.chat.guardNoticeOpenSettings') }}
      </button>
      <button
        type="button"
        class="guard-stop-btn guard-stop-btn-primary"
        @click="emit('continue')"
      >
        {{ t('sidepanel.chat.guardNoticeContinue') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/utils/i18n';

defineProps<{
  /** 停止说明正文（引擎写入的 notice 片段全文） */
  text: string;
}>();

const emit = defineEmits<{
  continue: [];
  'open-settings': [];
}>();
</script>

<style scoped>
.guard-stop-notice {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 6px 0;
  padding: 10px 12px;
  border-radius: 14px;
  border: 1px solid var(--line-soft, #e4e2de);
  background: #ffffff;
  box-shadow: 0 1px 2px var(--surface-soft, #f3f1ed);
  min-width: 0;
}

.guard-stop-text {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink-primary, #292824);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.guard-stop-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.guard-stop-btn {
  border: none;
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background-color 0.15s ease, transform 0.05s ease;
}

.guard-stop-btn:active {
  transform: scale(0.97);
}

.guard-stop-btn-secondary {
  color: var(--ink-secondary, #787671);
  background: var(--surface-hover, #eeece7);
}

.guard-stop-btn-secondary:hover {
  background: #e4e1da;
}

.guard-stop-btn-primary {
  color: #ffffff;
  background: var(--ink-primary, #292824);
}

.guard-stop-btn-primary:hover {
  background: #44413b;
}
</style>
