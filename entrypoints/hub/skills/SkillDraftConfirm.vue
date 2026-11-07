<script setup lang="ts">
/**
 * 网站学习成果确认卡（预填后内联展示，非模态）
 *
 * 文案「已为你预填到下方表单」表明它是表单上方的引导条而非弹窗：
 * 用户能直接看到预填结果再决定——确认 → 走既有保存链路；微调 → 关卡
 * 留在表单继续编辑。纯受控：草稿经 props 传入，动作 emit 上抛，
 * 保存等业务判断留在 SkillManager（与既有编辑链路同源）。
 */
import { t } from '@/utils/i18n';
import type { SkillDraft } from '@/utils/learn/learn-types';

const props = defineProps<{
  draft: SkillDraft;
  /** 实际将保存的名称（与草稿原名不同 = 预填时已自动避让重名） */
  finalName: string;
}>();

const emit = defineEmits<{
  /** 确认创建：由父级执行保存 */
  confirm: [];
  /** 先去微调：关闭卡片，留在表单编辑 */
  edit: [];
}>();

/** 目标模式标签文案（与 sidepanel 配置面板同一 i18n 源，两侧口径一致） */
function modeLabel(): string {
  return props.draft.mode === 'vision'
    ? t('sidepanel.learn.targetModeVision')
    : t('sidepanel.learn.targetModeText');
}
</script>

<template>
  <div class="draft-card" role="status">
    <div class="draft-card__head">
      <span class="draft-card__badge" aria-hidden="true">✨</span>
      <div class="draft-card__heading">
        <h3 class="draft-card__title">{{ t('hub.learnDraftTitle') }}</h3>
        <p class="draft-card__intro">{{ t('hub.learnDraftIntro') }}</p>
      </div>
    </div>

    <dl class="draft-card__meta">
      <div class="draft-card__row">
        <dt>{{ t('hub.fieldSkillName') }}</dt>
        <dd>
          <code class="draft-card__code">{{ finalName }}</code>
          <span v-if="finalName !== draft.name" class="draft-card__renamed">
            {{ t('hub.learnDraftRenamed', { name: finalName }) }}
          </span>
        </dd>
      </div>
      <div class="draft-card__row">
        <dt>{{ t('hub.learnDraftMode') }}</dt>
        <dd>{{ modeLabel() }}</dd>
      </div>
      <div class="draft-card__row">
        <dt>{{ t('hub.learnDraftTools') }}</dt>
        <dd class="draft-card__tools">
          <code v-for="tool in draft.allowedTools" :key="tool" class="draft-card__code">{{ tool }}</code>
        </dd>
      </div>
    </dl>

    <div class="draft-card__actions">
      <button type="button" class="hub-btn" @click="emit('edit')">
        {{ t('hub.learnDraftEdit') }}
      </button>
      <button type="button" class="hub-btn hub-btn-primary" @click="emit('confirm')">
        {{ t('hub.learnDraftConfirm') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 玻璃确认卡（中性灰阶：管理中心为纯黑白灰体系，不使用任何彩色底）
   变量带回退，设置弹窗变量不可用时仍是完整可读的卡片 */
.draft-card {
  margin: 0 0 14px;
  padding: 14px 16px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.62);
  border: 1px solid rgba(41, 40, 36, 0.14);
  backdrop-filter: blur(16px) saturate(150%);
  -webkit-backdrop-filter: blur(16px) saturate(150%);
  box-shadow: var(--glass-inset, inset 0 1px 0 rgba(255, 255, 255, 0.92)),
    0 8px 24px rgba(41 40 36 / 6%);
}

.draft-card__head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 10px;
}

.draft-card__badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border-radius: 9px;
  background: rgba(41, 40, 36, 0.1);
  font-size: 14px;
}

.draft-card__heading {
  min-width: 0;
}

.draft-card__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--ink-primary, #292824);
}

.draft-card__intro {
  margin: 4px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-secondary, #787671);
}

.draft-card__meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 0 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(41, 40, 36, 0.05);
  border: 1px solid rgba(41, 40, 36, 0.1);
}

.draft-card__row {
  display: grid;
  grid-template-columns: 84px 1fr;
  gap: 10px;
  font-size: 12.5px;
  line-height: 1.6;
}

.draft-card__row dt {
  color: var(--ink-secondary, #787671);
}

.draft-card__row dd {
  margin: 0;
  color: var(--ink-primary, #292824);
  word-break: break-word;
}

.draft-card__code {
  padding: 1px 6px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.72);
  border: 1px solid rgba(41 40 36 / 8%);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

.draft-card__renamed {
  display: block;
  margin-top: 2px;
  font-size: 11.5px;
  color: #d97706;
}

.draft-card__tools {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.draft-card__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
