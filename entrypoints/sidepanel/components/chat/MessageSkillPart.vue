<template>
  <div class="skill-container" :class="{ collapsed: !expanded }">
    <!-- 折叠头：默认收起；视觉对齐工具调用行（tool-row）与「查看屏幕」的
         无边框紧凑设计语言，点击展开技能清单 -->
    <button
      type="button"
      class="skill-header"
      :aria-expanded="expanded"
      :title="expanded ? t('sidepanel.chat.skillLoadedCollapse') : t('sidepanel.chat.skillLoadedExpand')"
      @click="expanded = !expanded"
    >
      <span class="skill-icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M13,2L4,6V12C4,16.4 7.8,20.5 12,21.6C16.2,20.5 20,16.4 20,12V6L13,2M12,4.2L18,7.1V12C18,15.4 15.2,18.6 12,19.6C8.8,18.6 6,15.4 6,12V7.1L12,4.2M11,8V13H13V8H11M11,15V17H13V15H11Z" fill="#6366f1"/>
        </svg>
      </span>
      <span class="skill-title">{{ title }}</span>
      <span class="skill-right">
        <svg class="skill-chevron" :class="{ expanded }" width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M9,6L8,7L14,12L8,17L9,18L16,12L9,6Z" fill="currentColor"/>
        </svg>
      </span>
    </button>

    <!-- 展开体：本次运行前自动加载的技能清单（名称 + 稳定 ID） -->
    <ul v-if="expanded" class="skill-body">
      <li v-for="skill in skills" :key="skill.id" class="skill-item">
        <span class="skill-name">{{ skill.name }}</span>
        <span v-if="skill.name !== skill.id" class="skill-id">#{{ skill.id }}</span>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
/**
 * 内联技能激活片段（MessageSkillPart）——「已加载技能」可折叠容器。
 *
 * 语义：用户用 / 预选技能时，会话引擎在运行前自动合成一轮
 * skill_tool(action="load")（模型可见，但不产生工具卡片）。本组件把
 * 「这一轮开始前加载了哪些技能」以单一事实呈现给用户，形态对齐
 * 「查看屏幕」（单行收起条 + 展开体），并作为过程片段参与连续过程小折叠。
 *
 * 数据契约：片段持有加载时刻的快照（id + name），不依赖技能存储的当前
 * 状态——技能随后改名/停用/删除时，历史消息仍准确展示当时加载了什么。
 * 折叠状态是组件本地态；直播期由小折叠统一管理，无需回传。
 */
import { computed, ref } from 'vue';
import { t } from '@/utils/i18n';
import type { SkillPartEntry } from '../../types/chat';

const props = defineProps<{
  /** 本轮运行前自动加载的技能快照（至少一项；空数组由调用方过滤） */
  skills: SkillPartEntry[];
}>();

/** 展开状态（缺省收起：技能激活属于过程信息，不打断正文阅读） */
const expanded = ref(false);

/** 单个技能直接展示名称；多个技能展示数量（名称在展开体逐项列出） */
const title = computed(() =>
  props.skills.length === 1
    ? t('sidepanel.chat.skillLoadedSingle', { name: props.skills[0].name })
    : t('sidepanel.chat.skillLoadedMany', { count: props.skills.length }),
);
</script>

<style scoped>
@import './message-skill-part.css';
</style>
