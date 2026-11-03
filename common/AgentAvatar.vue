<template>
  <!--
    智能体头像渲染：图片或 emoji 二选一。

    头像区域刻意不做任何背景色 / 底板：预设头像是透明底 PNG，套上底板会显出
    一个色块方框，与「卡片里直接放形象」的预期不符。emoji 形态同理，
    靠字形自身撑起视觉，不加圆形或方形背景。

    图片加载失败（路径写错、文件缺失）时回退到默认 emoji，
    避免头像位置出现一个破图占位。
  -->
  <img
    v-if="isImage && !imageFailed"
    class="agent-avatar agent-avatar-image"
    :src="imageSrc"
    :alt="label"
    :width="size"
    :height="size"
    @error="imageFailed = true"
  />
  <span
    v-else
    class="agent-avatar agent-avatar-emoji"
    :style="{ fontSize: `${size}px` }"
    role="img"
    :aria-label="label"
    >{{ emojiText }}</span
  >
</template>

<script setup lang="ts">
/**
 * 智能体头像展示组件（预置 / 自定义 / 导入三类智能体共用）。
 *
 * 渲染分支只有一条：图片形态走 <img>，emoji 形态走文本节点。
 * 缺省（无头像）由 utils 层回退到默认 emoji，调用方无需处理空态。
 */
import { computed, ref, watch } from 'vue';
import {
  DEFAULT_AGENT_AVATAR,
  isImageAvatar,
  resolveAgentAvatar,
  resolveAvatarImageSrc,
  type AgentAvatar,
} from '@/utils/agents/agent-avatar';

/** 头像来源（缺省 = 默认 emoji）；由调用方传入智能体上的 avatar 字段 */
const props = withDefaults(
  defineProps<{
    avatar?: AgentAvatar | null;
    /** 边长（px）；图片铺满该尺寸，emoji 以同尺寸字号渲染 */
    size?: number;
    /** 无障碍标签（智能体名称）；为空时按装饰性图片处理 */
    label?: string;
  }>(),
  { avatar: null, size: 24, label: '' },
);

/** 有效头像（缺省回退默认 emoji） */
const effectiveAvatar = computed(() => resolveAgentAvatar(props.avatar));

/** 是否图片形态（决定渲染 <img> 还是文本节点） */
const isImage = computed(() => isImageAvatar(props.avatar));

/** 图片形态的可渲染地址（扩展内相对路径 → chrome-extension:// 绝对地址） */
const imageSrc = computed(() => {
  const avatar = effectiveAvatar.value;
  return avatar.type === 'image' ? resolveAvatarImageSrc(avatar.src) : '';
});

/** emoji 形态的显示文本（缺省回退默认 emoji） */
const emojiText = computed(() => {
  const avatar = effectiveAvatar.value;
  return avatar.type === 'emoji' ? avatar.value : DEFAULT_AGENT_AVATAR.value;
});

/** 图片加载失败标记（失败后回退到 emoji，避免出现破图占位） */
const imageFailed = ref(false);

// 换头像后重置失败标记，否则上一张图的加载失败会连带影响新头像
watch(
  () => effectiveAvatar.value,
  () => {
    imageFailed.value = false;
  },
);
</script>

<style scoped>
.agent-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  /* 刻意不加 background：头像区域保持透明，不出现底板色块 */
  background: transparent;
  object-fit: contain;
}

/* emoji 形态：靠字形撑起视觉，行高收避免撑高所在行 */
.agent-avatar-emoji {
  line-height: 1;
  font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
}
</style>
