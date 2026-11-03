<script setup lang="ts">
/**
 * 学习策略问号解释框
 *
 * 纯 CSS 触发（hover / focus-within），不引入浮层定位库：
 * 解释卡紧贴问号右侧展开，无外部依赖、无 resize/scroll 失位问题，
 * 键盘 Tab 到问号即可展开（可访问性与鼠标一致）。
 *
 * 内容由调用方以行数组传入——解释文案属于 i18n，组件只负责呈现。
 */
defineProps<{
  /** 卡片标题 */
  title: string;
  /** 逐行说明（每项渲染为一段） */
  lines: string[];
}>();
</script>

<template>
  <span class="learn-hint" tabindex="0" role="button" :aria-label="title">
    <svg
      class="learn-hint__icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M12 2A10 10 0 1 0 12 22A10 10 0 0 0 12 2ZM12 17H13V15H11V16H12V17ZM12.07 11H10.5C10.5 8.5 13.5 8.75 13.5 6.5C13.5 5.12 12.66 4 11.5 4C10.35 4 9.4 4.74 9.08 5.76L10.71 6.42C10.85 5.96 11.14 5.66 11.5 5.66C11.93 5.66 12.28 6.01 12.28 6.5C12.28 7.5 10.5 7.67 10.5 11H12.07Z"
        fill="currentColor"
      />
    </svg>

    <span class="learn-hint__card" role="tooltip">
      <strong class="learn-hint__title">{{ title }}</strong>
      <span v-for="(line, index) in lines" :key="index" class="learn-hint__line">{{ line }}</span>
    </span>
  </span>
</template>

<style scoped>
.learn-hint {
  position: relative;
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
  outline: none;
}

.learn-hint__icon {
  color: var(--learn-text-faint, #9ca3af);
  cursor: help;
  transition: color 0.15s ease;
}

.learn-hint:hover .learn-hint__icon,
.learn-hint:focus-visible .learn-hint__icon {
  color: var(--learn-accent, #667eea);
}

.learn-hint__card {
  position: absolute;
  left: 20px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 60;
  width: 300px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--learn-bg, #ffffff);
  color: var(--learn-text, #1f2937);
  box-shadow:
    0 8px 28px rgba(15, 23, 42, 0.16),
    0 0 0 1px var(--learn-border, #e5e7eb);
  font-size: 12px;
  line-height: 1.7;
  text-align: left;
  /* 默认不可见但保留可聚焦性：hover / focus 展开 */
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity 0.16s ease,
    visibility 0.16s ease;
}

.learn-hint:hover .learn-hint__card,
.learn-hint:focus-visible .learn-hint__card,
.learn-hint:focus-within .learn-hint__card {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}

.learn-hint__title {
  display: block;
  margin-bottom: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--learn-text-strong, #111827);
}

.learn-hint__line {
  display: block;
  color: var(--learn-text-muted, #6b7280);
}

.learn-hint__line + .learn-hint__line {
  margin-top: 6px;
}

.learn-hint__line:last-child {
  color: var(--learn-text-faint, #9ca3af);
}
</style>
