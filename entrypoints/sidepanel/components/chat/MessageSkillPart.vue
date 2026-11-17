<template>
  <ul class="skill-container">
    <li v-for="skill in skills" :key="skill.id" class="skill-item">
      <span class="skill-icon" aria-hidden="true"><SkillIcon width="14" height="14" /></span>
      <span class="skill-title" :title="skill.name === skill.id ? skill.name : `${skill.name} (#${skill.id})`">
        {{ t('sidepanel.chat.skillLoadedSingle', { name: skill.name }) }}
      </span>
    </li>
  </ul>
</template>

<script setup lang="ts">
/**
 * 内联技能激活记录：按加载时刻的名称快照逐项展示，无展开/收起交互。
 * 历史技能改名、停用或删除不影响本条记录；稳定 ID 保留在名称提示中。
 */
import { t } from '@/utils/i18n';
import type { SkillPartEntry } from '../../types/chat';
import SkillIcon from './SkillIcon.vue';

defineProps<{
  /** 本轮运行前自动加载的技能快照（空数组由调用方过滤） */
  skills: SkillPartEntry[];
}>();
</script>

<style scoped>
@import './message-skill-part.css';
</style>
