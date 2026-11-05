<template>
  <section class="hub-panel">
    <!-- 列表视图 -->
    <div v-if="!editing" class="hub-list-view">
      <div class="hub-list-toolbar">
        <span class="hub-list-count">{{ t('hub.skillCount', { count: skills.length }) }}</span>
        <div class="hub-list-actions">
          <button type="button" class="hub-btn" @click="triggerImport">{{ t('hub.importSkill') }}</button>
          <button type="button" class="hub-btn hub-btn-primary" :disabled="acceptingDraft" @click="startCreate">
            {{ t('hub.newSkill') }}
          </button>
        </div>
      </div>

      <!-- 隐藏的导入文件选择器（zip / md） -->
      <input
        ref="importInputRef"
        type="file"
        accept=".zip,.md,application/zip,text/markdown"
        class="hub-file-hidden"
        @change="handleImportFile"
      />

      <!-- 导入结果反馈（成功 + 逐条跳过原因，自动过期清除） -->
      <div v-if="importFeedbackLines.length" class="hub-import-feedback" :class="importFeedbackTone">
        <p v-for="(line, index) in importFeedbackLines" :key="index">{{ line }}</p>
      </div>

      <div class="hub-cards">
        <article
          v-for="skill in skills"
          :key="skill.id"
          class="hub-card"
          :class="{ 'is-preset': skill.source === 'preset', 'is-disabled': !skill.enabled }"
        >
          <div class="hub-card-head">
            <span class="hub-card-name" :title="skill.name">{{ skill.name }}</span>
            <span class="hub-badge" :class="skill.source === 'preset' ? 'hub-badge-preset' : 'hub-badge-custom'">
              {{ skill.source === 'preset' ? t('hub.preset') : t('hub.custom') }}
            </span>
          </div>
          <p v-if="skill.plugin" class="hub-hint">{{ skill.plugin.displayName }} · {{ skill.plugin.version }} · {{ skill.plugin.publisher }}</p>
          <p class="hub-card-desc" :title="skill.description">{{ skill.description }}</p>
          <!-- 分类与标签（与智能体卡片同一套徽章与分类规范） -->
          <div class="hub-card-taxonomy">
            <span class="hub-badge hub-badge-category">{{ categoryLabel(skill.category) }}</span>
            <span v-for="tag in skill.tags" :key="tag" class="hub-badge hub-badge-tag">{{ tag }}</span>
          </div>
          <div class="hub-card-meta">
            <span v-if="skill.allowedTools.length > 0" class="hub-card-tools">
              {{ t('hub.allowedToolsCount', { count: skill.allowedTools.length }) }}
            </span>
            <span v-if="resourceCountOf(skill) > 0" class="hub-card-tools">
              {{ t('hub.resourceFileCount', { count: resourceCountOf(skill) }) }}
            </span>
            <HubSwitch
              class="hub-switch-inline"
              :model-value="skill.enabled"
              :disabled="skill.source === 'plugin'"
              @update:model-value="toggleEnabled(skill)"
            >{{ skill.enabled ? t('hub.enabled') : t('hub.disabled') }}</HubSwitch>
            <span class="hub-card-ops">
              <!-- 模型标识不再直接展示原文：保留一键复制（对话/工具调用中的唯一名称） -->
              <button
                type="button"
                class="hub-icon-btn"
                :title="t('hub.modelIdHint')"
                :aria-label="t('common.copy')"
                @click="copyModelId(skill)"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.5" />
                  <path d="M10.5 5.5V3.9a1.4 1.4 0 0 0-1.4-1.4H3.9a1.4 1.4 0 0 0-1.4 1.4v5.2a1.4 1.4 0 0 0 1.4 1.4h1.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                </svg>
              </button>
              <button type="button" class="hub-op" @click="exportSkill(skill)">{{ t('hub.exportSkill') }}</button>
              <template v-if="skill.source === 'custom'">
                <button type="button" class="hub-op" @click="startEdit(skill)">{{ t('hub.edit') }}</button>
                <button type="button" class="hub-op hub-op-danger" @click="removeSkill(skill)">{{ t('hub.delete') }}</button>
              </template>
            </span>
          </div>
        </article>
      </div>
    </div>

    <!-- 编辑视图：简单模式（表单字段）与高级模式（完整 SKILL.md） -->
    <form v-else class="hub-editor" :inert="saving" :aria-busy="saving" @submit.prevent="save">
      <div class="hub-editor-head">
        <h2>{{ editingExisting ? t('hub.editSkill') : t('hub.newSkill') }}</h2>
        <button type="button" class="hub-btn" :disabled="saving" @click="cancelEdit">{{ t('hub.backToList') }}</button>
      </div>

      <!-- 网站学习成果确认卡（预填后内联展示；确认→直接保存，微调→关卡留在表单） -->
      <SkillDraftConfirm
        v-if="draftCard"
        :draft="draftCard.draft"
        :final-name="draftCard.finalName"
        @confirm="confirmDraftCreate"
        @edit="draftCard = null"
      />

      <!-- 模式切换（带确认语义：切换会把当前内容转换为目标形态） -->
      <div class="hub-editor-mode">
        <HubSegmented
          :model-value="editorMode"
          :options="modeOptions"
          :aria-label="t('hub.modeSimple')"
          @update:model-value="onModeChange"
        />
        <p class="hub-hint">{{ editorMode === 'simple' ? t('hub.modeSimpleHint') : t('hub.modeAdvancedHint') }}</p>
      </div>

      <!-- 左右布局：简单模式左列元信息 / 右列提示词；高级模式左列 SKILL.md 原文 / 右列实时校验与资源文件 -->
      <div
        class="hub-editor-split"
        :class="editorMode === 'simple' ? 'hub-editor-split--skill-simple' : 'hub-editor-split--skill-advanced'"
      >
        <!-- 简单模式：name / description / category / tags / prompt 五字段，提交必成功 -->
        <template v-if="editorMode === 'simple'">
          <div class="hub-editor-col">
            <!-- 多文件技能防御性提示：简单模式不触碰资源文件，保存绝不丢文件 -->
            <div v-if="resourceFileCount > 0" class="hub-notice">
              <p>{{ t('hub.resourceFilesNotice', { count: resourceFileCount }) }}</p>
              <div class="hub-resource-chips">
                <span
                  v-for="(content, path) in resourceFiles"
                  :key="path"
                  class="hub-badge hub-badge-tag"
                  :title="t('hub.resourceFileChars', { count: content.length })"
                >{{ path }}</span>
              </div>
              <p class="hub-hint">{{ t('hub.resourceFilesSimpleHint') }}</p>
            </div>

            <label class="hub-field">
              <span class="hub-field-label">{{ t('hub.fieldSkillName') }}</span>
              <input
                v-model.trim="form.name"
                type="text"
                required
                maxlength="64"
                :placeholder="t('hub.fieldSkillNamePlaceholder')"
                @input="form.name = form.name.toLowerCase()"
              />
              <span class="hub-hint">{{ nameHint }}</span>
            </label>

            <label class="hub-field">
              <span class="hub-field-label">{{ t('hub.fieldDescription') }}</span>
              <input v-model.trim="form.description" type="text" required maxlength="1024" :placeholder="t('hub.fieldSkillDescriptionPlaceholder')" />
            </label>

            <!-- 分类（必选）：与智能体同一套分类规范；选择「新建自定义分类」时
                 新分类名称输入框与选择器同行，保存前经 normalizeCategory 归一化 -->
            <div class="hub-field">
              <span class="hub-field-label">
                {{ t('hub.fieldCategory') }}<span class="hub-required" aria-hidden="true">*</span>
              </span>
              <CategorySelect v-model="form.category" v-model:custom="form.customCategory" />
              <span class="hub-hint">{{ t('hub.fieldSkillCategoryHint') }}</span>
            </div>

            <!-- 标签：与智能体同一套标签规范（chips 输入与上限反馈由组件内置） -->
            <div class="hub-field">
              <span class="hub-field-label">{{ t('hub.fieldTags') }}</span>
              <TagInput v-model="form.tags" :hint="t('hub.fieldSkillTagsHint', { max: AGENT_TAGS_MAX_COUNT })" />
            </div>
          </div>

          <div class="hub-editor-col">
            <label class="hub-field hub-field--grow">
              <span class="hub-field-label">{{ t('hub.fieldPrompt') }}</span>
              <textarea v-model="form.body" rows="24" required :placeholder="t('hub.fieldPromptPlaceholder')" class="hub-body-editor hub-field--fill"></textarea>
              <span class="hub-hint">{{ t('hub.fieldBodyHint', { count: form.body.length }) }}</span>
            </label>
          </div>
        </template>

        <!-- 高级模式：左列完整 SKILL.md 原文，右列实时校验 + 资源文件 -->
        <template v-else>
          <div class="hub-editor-col">
            <label class="hub-field hub-field--grow">
              <span class="hub-field-label">{{ t('hub.fieldRawSkillMd') }}</span>
              <textarea
                v-model="form.raw"
                rows="26"
                class="hub-body-editor hub-raw-editor hub-field--fill"
                :placeholder="t('hub.fieldRawSkillMdPlaceholder')"
                spellcheck="false"
              ></textarea>
              <span class="hub-hint">{{ t('hub.fieldRawSkillMdHint') }}</span>
            </label>
          </div>

          <div class="hub-editor-col">
            <!-- 实时校验面板：随输入逐帧更新（computed 驱动），保存按钮联动禁用 -->
            <div
              class="hub-validation"
              :class="rawValidation.ok ? 'is-ok' : 'is-error'"
              role="status"
              aria-live="polite"
            >
              <div class="hub-validation-head">
                <svg v-if="rawValidation.ok" viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
                  <path d="M5.2 8.3l1.9 1.9 3.7-4.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <svg v-else viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
                  <path d="M8 4.6v4.2M8 11.2v.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                </svg>
                <span>{{ t('hub.validationTitle') }}</span>
                <span v-if="!rawValidation.ok" class="hub-validation-count">{{ rawIssues.length }}</span>
              </div>
              <p v-if="rawValidation.ok" class="hub-validation-ok-text">{{ t('hub.validationOk') }}</p>
              <ul v-else class="hub-validation-items">
                <li
                  v-for="(issue, index) in rawIssues"
                  :key="index"
                  class="hub-validation-item"
                  :style="{ animationDelay: `${Math.min(index * 40, 240)}ms` }"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4" />
                    <path d="M8 4.9v3.9M8 11v.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                  </svg>
                  <span>{{ issue }}</span>
                </li>
              </ul>
            </div>

            <!-- 资源文件管理（文件夹式技能）：SKILL.md 之外的文件树增 / 改 / 删 / 重命名 -->
            <div class="hub-field hub-resource-manager">
              <span class="hub-field-label">{{ t('hub.resourceFilesTitle', { count: resourceFileCount }) }}</span>
              <p class="hub-hint">{{ t('hub.resourceFilesHint') }}</p>

              <div v-if="resourceFileCount > 0" class="hub-resource-list">
                <div
                  v-for="(content, path) in resourceFiles"
                  :key="path"
                  class="hub-resource-item"
                  :class="{ 'is-active': resourceEditingPath === path }"
                >
                  <button type="button" class="hub-resource-path" :title="path" @click="openResourceFile(path)">
                    {{ path }}
                  </button>
                  <span class="hub-resource-size">{{ t('hub.resourceFileChars', { count: content.length }) }}</span>
                  <span class="hub-resource-ops">
                    <button type="button" class="hub-op" @click="openResourceFile(path)">{{ t('hub.edit') }}</button>
                    <button type="button" class="hub-op hub-op-danger" @click="removeResourceFile(path)">
                      {{ t('hub.delete') }}
                    </button>
                  </span>
                </div>
              </div>
              <p v-else class="hub-hint">{{ t('hub.resourceFilesEmpty') }}</p>

              <!-- 单文件编辑面板（新建 / 编辑 / 重命名共用） -->
              <div v-if="resourceEditorOpen" class="hub-resource-editor">
                <label class="hub-field">
                  <span class="hub-field-label">{{ t('hub.resourceFilePath') }}</span>
                  <input
                    v-model.trim="resourceForm.path"
                    type="text"
                    maxlength="200"
                    :placeholder="t('hub.resourceFilePathPlaceholder')"
                  />
                  <span v-if="resourceEditingPath && resourceEditingPath !== resourceForm.path" class="hub-hint">
                    {{ t('hub.resourceFileRenameHint', { path: resourceEditingPath }) }}
                  </span>
                </label>
                <label class="hub-field">
                  <span class="hub-field-label">{{ t('hub.resourceFileContent') }}</span>
                  <textarea
                    v-model="resourceForm.content"
                    rows="12"
                    class="hub-body-editor"
                    spellcheck="false"
                  ></textarea>
                </label>
                <p v-if="resourceError" class="hub-error">{{ resourceError }}</p>
                <div class="hub-editor-actions">
                  <button type="button" class="hub-btn" @click="closeResourceEditor">{{ t('common.cancel') }}</button>
                  <button type="button" class="hub-btn hub-btn-primary" @click="saveResourceFile">
                    {{ t('hub.resourceFileSave') }}
                  </button>
                </div>
              </div>
              <button v-else type="button" class="hub-btn" @click="startResourceCreate">
                {{ t('hub.resourceFileAdd') }}
              </button>
            </div>
          </div>
        </template>
      </div>

      <div class="hub-editor-footer">
        <span v-if="errorMessage" class="hub-error">{{ errorMessage }}</span>
        <span v-else-if="editorMode === 'advanced' && resourceEditorOpen" class="hub-hint">
          {{ t('hub.resourceEditorOpenHint') }}
        </span>
        <div class="hub-editor-actions">
          <button type="button" class="hub-btn" @click="cancelEdit">{{ t('common.cancel') }}</button>
          <button type="submit" class="hub-btn hub-btn-primary" :disabled="!canSave || saving">{{ t('common.save') }}</button>
        </div>
      </div>
    </form>
  </section>
</template>

<script setup lang="ts">
/**
 * 技能管理：全量启停（含预置，跨上下文同步）+ 自定义技能的新建/编辑/删除
 * + zip / md 导入导出。
 *
 * 编辑器双模式（左右布局，模式经 HubSegmented 分段控件切换）：
 *   - 简单模式：左列 name / description / category / tags，右列提示词正文；
 *     保存时自动组装规范 SKILL.md（其余 frontmatter 字段在编辑既有技能时
 *     原样保留），百分百可正确创建；分类必选，与智能体共用同一套分类/标签规范；
 *   - 高级模式：左列直接编辑完整 SKILL.md（frontmatter + 正文），右列为
 *     实时校验面板（输入即校验、逐条提示格式问题）+ 资源文件管理。
 * 模式互切有内容转换：简单 → 高级按表单重组原文；高级 → 简单解析回填
 * （解析失败时阻止切换，避免半份内容静默丢失）。
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { t, type MessageKey } from '@/utils/i18n';
import CategorySelect from '../components/CategorySelect.vue';
// Hub 共享自定义控件：分段控件（模式切换）与 iOS 形态开关（技能启停）
import HubSegmented from '../components/HubSegmented.vue';
import HubSwitch from '../components/HubSwitch.vue';
import TagInput from '../components/TagInput.vue';
import {
  AGENT_TAGS_MAX_COUNT,
  CATEGORY_CUSTOM_VALUE,
  categoryLabelOf,
  isBuiltinCategory,
  normalizeCategory,
} from '@/utils/agents/agent-types';
import {
  getAllSkills,
  setCustomSkill,
  removeCustomSkill,
  setSkillEnabled,
  onSkillsChange,
  flushSkillStoreWrites,
  rollbackCustomSkills,
  snapshotCustomSkills,
  type SkillRecord,
  type SkillWriteResult,
} from '@/utils/skills/skill-store';
import {
  readLearnDraft, claimLearnDraftEditor, saveLearnDraftEditor, completeLearnDraft, isLearnDraftEditorState, LEARN_TRANSFER_MARKER,
} from '@/utils/learn/learn-draft-store';
import type { SkillDraft, LearnDraftEditorState } from '@/utils/learn/learn-types';
import SkillDraftConfirm from './SkillDraftConfirm.vue';
import { modelSkillIdOf } from '@/utils/skills/skill-types';
import {
  parseFrontmatter,
  validateSkillMd,
  normalizeSkillName,
  parseAllowedTools,
  parseSkillTags,
  type SkillMdIssue,
} from '@/utils/skills/frontmatter-parser';
import {
  importSkillFromMdText,
  parseSkillZipBytes,
  commitImportCandidates,
  downloadSkillZip,
  type SkillImportReport,
  type SkillImportSkip,
} from '@/utils/skills/skill-import-export';
import {
  SKILL_IMPORT_MAX_FILE_CHARS,
  SKILL_IMPORT_MAX_FILES,
  SKILL_IMPORT_MAX_PACKAGE_BYTES,
  SKILL_IMPORT_MAX_TOTAL_CHARS,
  SKILL_IMPORT_WARN_BYTES,
  SKILL_PATH_MAX_CHARS,
} from '@/utils/skills/skill-types';

// ──── 列表态 ────

const skills = ref<SkillRecord[]>([]);
const refreshList = () => {
  skills.value = getAllSkills();
};

const unsubscribe = onSkillsChange(() => refreshList());
onMounted(refreshList);
onUnmounted(() => unsubscribe());

/** 分类显示名：内置分类走 i18n，自定义分类原样展示 id；缺省归入通用（与智能体同规范） */
const categoryLabel = (categoryId: string): string => categoryLabelOf(categoryId, id => t(id as MessageKey));

/** 卡片徽章用：技能的资源文件数（SKILL.md 之外） */
function resourceCountOf(skill: SkillRecord): number {
  return Object.keys(skill.files ?? {}).filter(path => path !== 'SKILL.md').length;
}

const toggleEnabled = (skill: SkillRecord) => {
  setSkillEnabled(skill.id, !skill.enabled);
};

const removeSkill = (skill: SkillRecord) => {
  if (skill.source !== 'custom') return;
  if (!window.confirm(t('hub.confirmDeleteSkill', { name: skill.name }))) return;
  removeCustomSkill(skill.id);
};

const exportSkill = (skill: SkillRecord) => {
  downloadSkillZip(skill);
};

/** 复制模型标识到剪贴板（失败静默——非关键路径不弹错） */
const copyModelId = async (skill: SkillRecord) => {
  try {
    await navigator.clipboard.writeText(modelSkillIdOf(skill));
  } catch {
    /* 剪贴板权限被拒等场景忽略 */
  }
};

// ──── 导入 ────

const importInputRef = ref<HTMLInputElement | null>(null);
const importFeedbackLines = ref<string[]>([]);
const importFeedbackTone = ref<'ok' | 'error'>('ok');
let importFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
// 反馈定时器随组件卸载终止，避免对已卸载实例的迟到写入
onUnmounted(() => {
  if (importFeedbackTimer) {
    clearTimeout(importFeedbackTimer);
    importFeedbackTimer = null;
  }
});

const triggerImport = () => {
  importInputRef.value?.click();
};

/** 逐条跳过原因 → 可读文案 */
function importSkipText(skip: SkillImportSkip): string {
  const reasonKeys: Record<SkillImportSkip['reason'], string> = {
    'no-skill-md': 'hub.importSkipNoSkillMd',
    'invalid-name': 'hub.importSkipInvalidName',
    'missing-description': 'hub.importSkipMissingDescription',
    'empty-body': 'hub.importSkipEmptyBody',
    'too-many-files': 'hub.importSkipTooManyFiles',
    'file-too-large': 'hub.importSkipFileTooLarge',
    'total-too-large': 'hub.importSkipTotalTooLarge',
    'skill-limit': 'hub.importSkipSkillLimit',
    oversize: 'hub.importSkipOversize',
    'store-reject': 'hub.importSkipStoreReject',
  };
  return t(reasonKeys[skip.reason] as MessageKey, { source: skip.source });
}

/** 组装导入反馈文案（成功概要 + 跳过明细 + 丢弃文件明细，行数封顶防刷屏） */
function showImportFeedback(report: SkillImportReport, fileName: string): void {
  const lines: string[] = [];
  if (report.imported.length > 0) {
    lines.push(t('hub.importResult', { count: report.imported.length, file: fileName }));
  } else {
    lines.push(t('hub.importNone', { file: fileName }));
  }
  for (const skip of report.skipped) lines.push(importSkipText(skip));
  // 二进制 / 超限文件被丢弃必须可见：静默丢文件会让用户以为导入是完整的
  if (report.droppedFiles.length > 0) {
    const shown = report.droppedFiles.slice(0, 5);
    for (const dropped of shown) lines.push(t('hub.importDroppedFile', { path: dropped.path }));
    if (report.droppedFiles.length > shown.length) {
      lines.push(t('hub.importDroppedMore', { count: report.droppedFiles.length - shown.length }));
    }
  }
  importFeedbackLines.value = lines;
  importFeedbackTone.value = report.imported.length > 0 ? 'ok' : 'error';
  if (importFeedbackTimer) clearTimeout(importFeedbackTimer);
  importFeedbackTimer = setTimeout(() => {
    importFeedbackLines.value = [];
  }, 20_000);
}

/**
 * 读取并导入所选文件。
 *
 * 工业级门序（前一关不过就不进入下一关，避免无谓的内存开销与副作用）：
 *   1. 包体量硬门（zip）：unzipSync 是同步整包解压，超大包 / 解压炸弹会在
 *      逐技能校验前打爆内存——读文件前用 file.size 一票否决；
 *   2. 解析与逐技能校验（无 SKILL.md / 名称 / 体量上限…）；
 *   3. 5MB 预警确认：超限技能逐个弹窗告知环境风险（无终端、脚本不可执行、
 *      存储与同步成本），拒绝时只跳过超限项、不阻断同包其余技能；
 *   4. 提交写内存表 + 排队持久化；
 *   5. 落盘确认：chrome.storage 写失败 → 回滚到导入前快照并报错，
 *      保证「列表所见 = 持久层所存」，杜绝关页丢数据 / 重试产生重复。
 */
async function handleImportFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // 复位 value，保证同一文件可重复选择导入
  input.value = '';
  if (!file) return;

  try {
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith('.zip')) {
      // 门 1：包体量硬门
      if (file.size > SKILL_IMPORT_MAX_PACKAGE_BYTES) {
        importFeedbackLines.value = [
          t('hub.importPackageTooLarge', {
            file: file.name,
            max: Math.round(SKILL_IMPORT_MAX_PACKAGE_BYTES / (1024 * 1024)),
          }),
        ];
        importFeedbackTone.value = 'error';
        return;
      }

      const buffer = await file.arrayBuffer();
      const fallbackName = normalizeSkillName(file.name.replace(/\.zip$/i, '')) || 'imported-skill';
      // 门 2：解析与逐技能校验
      const parsed = parseSkillZipBytes(new Uint8Array(buffer), fallbackName);

      // 门 3：5MB 预警确认（列表超长截断，防止确认窗被数百个名字撑爆）
      const oversize = parsed.candidates.filter(c => (c.bytes ?? 0) > SKILL_IMPORT_WARN_BYTES);
      let approved = parsed.candidates;
      if (oversize.length > 0) {
        const totalBytes = oversize.reduce((sum, c) => sum + (c.bytes ?? 0), 0);
        const nameList = oversize.map(c => c.name).slice(0, 8).join('、');
        const list = oversize.length > 8 ? `${nameList} 等 ${oversize.length} 个` : nameList;
        const ok = window.confirm(
          t('hub.importOversizeConfirm', {
            count: oversize.length,
            size: (totalBytes / (1024 * 1024)).toFixed(1),
            list,
          }),
        );
        if (!ok) {
          approved = parsed.candidates.filter(c => (c.bytes ?? 0) <= SKILL_IMPORT_WARN_BYTES);
          for (const candidate of oversize) {
            parsed.skipped.push({ source: candidate.name, reason: 'oversize' });
          }
        }
      }

      // 门 4 + 5：提交（先拍回滚点）→ 落盘确认 → 失败回滚
      const snapshot = snapshotCustomSkills();
      const report = commitImportCandidates(approved);
      report.skipped.unshift(...parsed.skipped);
      report.droppedFiles.push(...parsed.droppedFiles);

      const flushed = await flushSkillStoreWrites();
      if (!flushed.ok) {
        rollbackCustomSkills(snapshot);
        importFeedbackLines.value = [
          t('hub.importStorageWriteFailed', { detail: flushed.error ?? '' }),
        ];
        importFeedbackTone.value = 'error';
        return;
      }
      showImportFeedback(report, file.name);
    } else if (lowerName.endsWith('.md')) {
      // md 直导同样过体量门（file.size 以 UTF-8 字节计，与字符上限同量级判定）
      if (file.size > SKILL_IMPORT_MAX_FILE_CHARS * 4) {
        importFeedbackLines.value = [
          t('hub.importSkipFileTooLarge', { source: file.name }),
        ];
        importFeedbackTone.value = 'error';
        return;
      }
      const text = await file.text();
      const fallbackName = file.name.replace(/\.md$/i, '');
      const snapshot = snapshotCustomSkills();
      const report = importSkillFromMdText(text, fallbackName);
      const flushed = await flushSkillStoreWrites();
      if (!flushed.ok) {
        rollbackCustomSkills(snapshot);
        importFeedbackLines.value = [
          t('hub.importStorageWriteFailed', { detail: flushed.error ?? '' }),
        ];
        importFeedbackTone.value = 'error';
        return;
      }
      showImportFeedback(report, file.name);
    } else {
      importFeedbackLines.value = [t('hub.importUnsupportedType', { file: file.name })];
      importFeedbackTone.value = 'error';
    }
  } catch (error) {
    console.warn('[SkillManager] 导入失败:', error);
    importFeedbackLines.value = [t('hub.importFailed', { file: file.name })];
    importFeedbackTone.value = 'error';
  }
}

// ──── 编辑态 ────

const editing = ref(false);
const editingExisting = ref(false);
/** 正在编辑的原始记录（保留其 id / 资源文件 / 启停态）；null = 新建 */
const editingSource = ref<SkillRecord | null>(null);
const errorMessage = ref('');
/** 编辑模式：simple（表单）/ advanced（完整 SKILL.md 原文） */
const editorMode = ref<'simple' | 'advanced'>('simple');

/** 分段控件选项（随界面语言刷新显示名） */
const modeOptions = computed(() => [
  { value: 'simple', label: t('hub.modeSimple') },
  { value: 'advanced', label: t('hub.modeAdvanced') },
]);

/** 分段控件 → switchMode 桥接（HubSegmented 的 value 为 string，此处收窄回联合类型） */
function onModeChange(value: string): void {
  if (value === 'simple' || value === 'advanced') switchMode(value);
}

const form = reactive({
  name: '',
  description: '',
  /** 分类：内置分类 id / CATEGORY_CUSTOM_VALUE（自定义创建态）/ ''（未选择；分类必选） */
  category: '',
  /** 分类选择为「自定义创建」时的新分类名称（保存前经 normalizeCategory 归一化） */
  customCategory: '',
  /** 标签（与智能体同一套归一化与上限） */
  tags: [] as string[],
  /** 简单模式正文（= SKILL.md body） */
  body: '',
  /** 高级模式完整原文（frontmatter + body） */
  raw: '',
});

/**
 * 简单模式下需要原样保留的 frontmatter 附加行（allowed-tools / compatibility /
 * license 及未知字段）：编辑既有技能时从原文提取，保存时拼回。
 * name / description / category / tags 由表单重写，不在此保留。
 * 原始行原样保留（含注释与引号），不做理解式重写——高级用户手写的值不丢语义。
 */
let preservedFrontmatterLines: string[] = [];

// ──── 资源文件（文件夹式技能：SKILL.md 之外的文件树） ────

/**
 * 资源文件表：相对路径 → 内容。与主编辑区（SKILL.md）分离承载，
 * 简单 / 高级模式切换、保存、草稿预填都不触碰它——「简单模式保存绝不丢文件」
 * 这条防线由数据结构保证，而不是靠流程小心。
 */
const resourceFiles = ref<Record<string, string>>({});
const resourceFileCount = computed(() => Object.keys(resourceFiles.value).length);
/** 单文件编辑面板开关 */
const resourceEditorOpen = ref(false);
/** 正在编辑的既有文件路径（null = 新建；与输入框不同即视为重命名/移动） */
const resourceEditingPath = ref<string | null>(null);
const resourceForm = reactive({ path: '', content: '' });
const resourceError = ref('');

/** 归一化资源路径：反斜杠转正斜杠、去空白与 './' 前缀（与导入清洗同规则） */
function normalizeResourcePath(raw: string): string {
  return raw.replace(/\\/g, '/').trim().replace(/^\.\/+/, '');
}

/** 路径含控制字符（NUL / 换行等，会污染存储键与 zip 导出路径）判定（逐码元扫描，规避 no-control-regex 对意图的误报） */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** 校验资源路径（originalPath 为正在编辑的原路径，重命名时排除自比较） */
function validateResourcePath(path: string, originalPath: string | null): string | null {
  if (
    !path ||
    path.startsWith('/') ||
    // 段级硬边界：拒绝空段（连续 / 或尾随 /）、当前层引用（a/./b）与穿越（..）
    path.split('/').some(segment => segment === '' || segment === '.' || segment === '..') ||
    hasControlCharacter(path)
  ) {
    return t('hub.resourceFileInvalidPath');
  }
  if (path.toLowerCase() === 'skill.md') {
    return t('hub.resourceFileReservedPath');
  }
  if (path.length > SKILL_PATH_MAX_CHARS) {
    return t('hub.resourceFileInvalidPath');
  }
  const others = { ...resourceFiles.value };
  if (originalPath !== null) delete others[originalPath];
  if (others[path] !== undefined) {
    return t('hub.resourceFileDuplicate');
  }
  return null;
}

function closeResourceEditor(): void {
  resourceEditorOpen.value = false;
  resourceEditingPath.value = null;
  resourceForm.path = '';
  resourceForm.content = '';
  resourceError.value = '';
}

function startResourceCreate(): void {
  closeResourceEditor();
  resourceEditorOpen.value = true;
}

function openResourceFile(path: string): void {
  const content = resourceFiles.value[path];
  if (content === undefined) return;
  closeResourceEditor();
  resourceEditingPath.value = path;
  resourceForm.path = path;
  resourceForm.content = content;
  resourceEditorOpen.value = true;
}

/**
 * 保存资源文件（新建 / 覆盖 / 重命名移动共用）。
 * 容量校验与导入同一套上限（单文件 / 总量含 SKILL.md / 文件数），
 * 两处口径不一致会出现「能导入却在编辑器里存不进去」的割裂。
 */
function saveResourceFile(): void {
  const path = normalizeResourcePath(resourceForm.path);
  const pathError = validateResourcePath(path, resourceEditingPath.value);
  if (pathError) {
    resourceError.value = pathError;
    return;
  }
  if (resourceForm.content.length > SKILL_IMPORT_MAX_FILE_CHARS) {
    resourceError.value = t('hub.resourceFileTooLarge', { max: SKILL_IMPORT_MAX_FILE_CHARS });
    return;
  }
  const next = { ...resourceFiles.value };
  if (resourceEditingPath.value !== null && resourceEditingPath.value !== path) {
    delete next[resourceEditingPath.value];
  }
  next[path] = resourceForm.content;
  // 总量按「资源文件 + 当前模式下的 SKILL.md」估算；SKILL.md 变更在保存时再终检
  const skillMdLength =
    editorMode.value === 'simple' ? composeSkillMd().length : form.raw.length;
  const totalChars =
    Object.entries(next).reduce((sum, [, content]) => sum + content.length, 0) + skillMdLength;
  if (totalChars > SKILL_IMPORT_MAX_TOTAL_CHARS) {
    resourceError.value = t('hub.resourceTotalTooLarge', { max: SKILL_IMPORT_MAX_TOTAL_CHARS });
    return;
  }
  if (Object.keys(next).length + 1 > SKILL_IMPORT_MAX_FILES) {
    resourceError.value = t('hub.resourceFileLimit', { max: SKILL_IMPORT_MAX_FILES });
    return;
  }
  resourceFiles.value = next;
  closeResourceEditor();
}

/** 删除资源文件（二次确认；正在编辑该文件时同步关闭编辑面板） */
function removeResourceFile(path: string): void {
  if (!window.confirm(t('hub.confirmDeleteResourceFile', { path }))) return;
  const next = { ...resourceFiles.value };
  delete next[path];
  resourceFiles.value = next;
  if (resourceEditingPath.value === path) closeResourceEditor();
}

// ──── 网站学习成果（持久交接与编辑恢复） ────

/** 学习成果确认卡（预填后展示；null = 无待确认成果） */
const draftCard = ref<{ draft: SkillDraft; finalName: string } | null>(null);
const emit = defineEmits<{ editorState: [editing: boolean] }>();
watch(editing, value => emit('editorState', value), { immediate: true, flush: 'sync' });
const activeTransferId = ref<string | null>(null);
const acceptingDraft = ref(false);
const saving = ref(false);
let releaseEditor: (() => void) | null = null;
let editorWrites: Promise<void> = Promise.resolve();
let editorWriteError = '';
let restoringDraft = false;
let destroyed = false;

function editorSnapshot(): LearnDraftEditorState {
  return JSON.parse(JSON.stringify({ form, editorMode: editorMode.value, preservedFrontmatterLines,
    resourceFiles: resourceFiles.value, resourceEditorOpen: resourceEditorOpen.value,
    resourceEditingPath: resourceEditingPath.value, resourceForm }));
}
function queueEditorCopy(): void {
  const id = activeTransferId.value;
  if (!id || restoringDraft) return;
  const snapshot = editorSnapshot();
  editorWrites = editorWrites.then(async () => {
    const result = await saveLearnDraftEditor(id, snapshot);
    editorWriteError = result.ok ? '' : result.error;
    if (!result.ok) errorMessage.value = t('hub.learnEditorCopyFailed', { detail: result.error });
  }).catch(error => { editorWriteError = String(error); errorMessage.value = t('hub.learnEditorCopyFailed', { detail: String(error) }); });
}
watch(() => activeTransferId.value ? JSON.stringify(editorSnapshot()) : '', queueEditorCopy, { flush: 'sync' });
onUnmounted(() => { destroyed = true; void editorWrites.finally(() => releaseEditor?.()); });

/** Only the shell's explicit user acknowledgement can open this form. */
async function acceptLearnDraft(id: string): Promise<{ ok: boolean; error?: string }> {
  if (acceptingDraft.value || saving.value) return { ok: false, error: t('hub.learnHandoffBusy') };
  if (activeTransferId.value === id) return { ok: true };
  if (editing.value) return { ok: false, error: t('hub.learnHandoffSaveFirst') };
  acceptingDraft.value = true;
  let claim: Awaited<ReturnType<typeof claimLearnDraftEditor>> | null = null;
  try {
    claim = await claimLearnDraftEditor();
    if (!claim.ok) return claim;
    const result = await readLearnDraft(id);
    if (destroyed) return { ok: false, error: t('hub.learnHandoffReadFailed') };
    if (result.status !== 'ok') return { ok: false, error: t('hub.learnHandoffReadFailed') };
    if (result.transfer.status !== 'pending') return { ok: false, error: t('hub.learnHandoffAlreadyHandled') };
    if (editing.value) return { ok: false, error: t('hub.learnHandoffSaveFirst') };
    const state = result.transfer.editorState;
    if (state !== undefined && !isLearnDraftEditorState(state)) return { ok: false, error: t('hub.learnHandoffReadFailed') };
    const saved = getAllSkills().find(skill => skill.source === 'custom' && parseFrontmatter(skill.files['SKILL.md'] ?? '').data[LEARN_TRANSFER_MARKER] === id);
    if (saved && !state) {
      const acknowledged = await completeLearnDraft(id, saved.id);
      return acknowledged.ok ? { ok: false, error: t('hub.learnHandoffAlreadyHandled') } : acknowledged;
    }
    restoringDraft = true;
    startCreateWithDraft(result.transfer.draft);
    if (state) {
      Object.assign(form, state.form); editorMode.value = state.editorMode;
      preservedFrontmatterLines = [...state.preservedFrontmatterLines];
      resourceFiles.value = { ...state.resourceFiles }; resourceEditorOpen.value = state.resourceEditorOpen;
      resourceEditingPath.value = state.resourceEditingPath; Object.assign(resourceForm, state.resourceForm);
    }
    if (saved) { editingSource.value = saved; editingExisting.value = true; }
    preservedFrontmatterLines = preservedFrontmatterLines.filter(line => !line.startsWith(LEARN_TRANSFER_MARKER + ':'));
    preservedFrontmatterLines.push(LEARN_TRANSFER_MARKER + ': ' + id);
    activeTransferId.value = id;
    releaseEditor = claim.release; claim = null;
    editorWriteError = '';
    restoringDraft = false;
    queueEditorCopy();
    return { ok: true };
  } catch (error) { return { ok: false, error: String(error) }; }
  finally { restoringDraft = false; if (claim?.ok) claim.release(); acceptingDraft.value = false; }
}

/**
 * 预填表单并弹出确认卡。
 * 保留生成的原名；技能身份由 id 区分，同名不会覆盖既有技能。
 */
function startCreateWithDraft(draft: SkillDraft): void {
  startCreate(); // 进入创建态、清空表单（resetForm 同步复位确认卡）
  const finalName = draft.name;
  form.name = finalName;
  form.description = draft.description;
  form.body = draft.body;
  form.tags = [...draft.tags];
  // 分类回填（与 startEdit 同规则：内置直选，自定义进「自定义创建」态）
  if (!draft.category || isBuiltinCategory(draft.category)) {
    form.category = draft.category;
    form.customCategory = '';
  } else {
    form.category = CATEGORY_CUSTOM_VALUE;
    form.customCategory = draft.category;
  }
  // allowed-tools 经保留行进 frontmatter：简单模式的表单不承载该字段，
  // 但它是技能在「/」引用清单可见性的唯一依据，丢失 = 建完也引用不到
  preservedFrontmatterLines = draft.allowedTools.length > 0
    ? [`allowed-tools: ${draft.allowedTools.join(' ')}`]
    : [];
  preservedFrontmatterLines.push(`x-learning-mode: ${draft.mode}`);
  if (draft.summary) preservedFrontmatterLines.push(`x-learning-summary: ${JSON.stringify(draft.summary)}`);
  draftCard.value = { draft, finalName };
}

/** 确认卡「确认创建」：走既有保存链路（表单已预填完整；字段被改非法时逐条报错、卡片保留可重试） */
function confirmDraftCreate(): void {
  save();
}

const normalizedFormName = computed(() => normalizeSkillName(form.name));

/** 表单最终生效的分类 id（自定义创建态经归一化；空串 = 尚未选择） */
const resolvedCategory = computed(() =>
  form.category === CATEGORY_CUSTOM_VALUE ? normalizeCategory(form.customCategory) : form.category,
);

/** 名称提示：输入与规范化结果不一致时展示实际将保存的名称 */
const nameHint = computed(() => {
  if (!form.name) return t('hub.fieldSkillNameHint');
  const normalized = normalizedFormName.value;
  if (!normalized) return t('hub.skillNameInvalid');
  return normalized === form.name
    ? t('hub.fieldSkillNameHint')
    : t('hub.skillNameWillNormalize', { name: normalized });
});

/** 简单模式可保存：名称规范化合法 + 描述/正文非空 + 分类已选择（分类必选） */
const simpleValid = computed(
  () =>
    /^[a-z0-9]+(-[a-z0-9]+)*$/.test(normalizedFormName.value) &&
    normalizedFormName.value.length > 0 &&
    form.description.trim().length > 0 &&
    resolvedCategory.value.length > 0 &&
    form.body.trim().length > 0,
);

/** 高级模式实时校验（编辑态下 name 缺省回落原技能名） */
const rawValidation = computed(() =>
  validateSkillMd(form.raw, { fallbackName: editingSource.value?.name }),
);

/** 校验问题 → 可读文案列表 */
const rawIssues = computed<string[]>(() =>
  rawValidation.value.issues.map((issue: SkillMdIssue) => {
    const keyMap: Record<SkillMdIssue['code'], string> = {
      'missing-frontmatter': 'hub.skillMdIssueMissingFrontmatter',
      'unclosed-frontmatter': 'hub.skillMdIssueUnclosedFrontmatter',
      'missing-name': 'hub.skillMdIssueMissingName',
      'invalid-name': 'hub.skillMdIssueInvalidName',
      'name-too-long': 'hub.skillMdIssueNameTooLong',
      'missing-description': 'hub.skillMdIssueMissingDescription',
      'missing-category': 'hub.skillMdIssueMissingCategory',
      'empty-body': 'hub.skillMdIssueEmptyBody',
    };
    return t(keyMap[issue.code] as MessageKey, { detail: issue.detail ?? '' });
  }),
);

/**
 * 可保存判定：
 *   - 简单模式：表单校验通过；
 *   - 高级模式：SKILL.md 校验通过 **且** 资源文件编辑面板已关闭——
 *     面板内容只有在面板内「保存文件」后才进入文件表，主保存带着未保存的
 *     面板直接提交会静默丢掉那份编辑。禁用 + 提示，而不是替用户决定。
 */
const canSave = computed(() =>
  editorMode.value === 'simple'
    ? simpleValid.value
    : rawValidation.value.ok && !resourceEditorOpen.value,
);

function resetForm(): void {
  form.name = '';
  form.description = '';
  form.category = '';
  form.customCategory = '';
  form.tags = [];
  form.body = '';
  form.raw = '';
  preservedFrontmatterLines = [];
  errorMessage.value = '';
  draftCard.value = null;
  resourceFiles.value = {};
  closeResourceEditor();
}

function startCreate(): void {
  editingSource.value = null;
  editingExisting.value = false;
  resetForm();
  editorMode.value = 'simple';
  editing.value = true;
}

/** 从既有 SKILL.md 提取需原样保留的 frontmatter 附加行（除 name/description/category/tags 外） */
function extractPreservedFrontmatterLines(skillMd: string): string[] {
  const lines = skillMd.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return [];
  const preserved: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === '---' || line.trim() === '...') break;
    // 缩进行 / 空行只作为「上一个已保留键」的续行跟随保留；
    // name / description / category / tags 被跳过后其续行不保留
    // （这几个字段将由表单重写）
    if (/^\s/.test(line) || !line.trim()) {
      if (preserved.length > 0) preserved.push(line);
      continue;
    }
    const key = (line.split(':')[0] ?? '').trim().toLowerCase();
    if (key === 'name' || key === 'description' || key === 'category' || key === 'tags') continue;
    preserved.push(line);
  }
  // 去除尾随空行（拼接时由模板控制空行，避免重复空行累积）
  while (preserved.length > 0 && !preserved[preserved.length - 1].trim()) {
    preserved.pop();
  }
  return preserved;
}

function startEdit(skill: SkillRecord): void {
  if (skill.source !== 'custom') return; // 预置不可编辑（防御）
  editingSource.value = skill;
  editingExisting.value = true;
  const skillMd = skill.files['SKILL.md'] ?? '';
  form.name = skill.name;
  form.description = skill.description;
  form.body = skill.body.replace(/\s+$/, '');
  form.raw = skillMd;
  // 资源文件整体带入（浅拷贝隔离编辑副本；保存时与重写的 SKILL.md 合并落库）
  resourceFiles.value = Object.fromEntries(
    Object.entries(skill.files).filter(([path]) => path !== 'SKILL.md'),
  );
  closeResourceEditor();
  // 分类回填：内置分类直接选中；自定义分类进入「自定义创建」态并回填名称
  // （历史数据缺分类时由存储层归入通用，此处不会出现空白项）
  if (!skill.category || isBuiltinCategory(skill.category)) {
    form.category = skill.category;
    form.customCategory = '';
  } else {
    form.category = CATEGORY_CUSTOM_VALUE;
    form.customCategory = skill.category;
  }
  form.tags = [...skill.tags];
  preservedFrontmatterLines = extractPreservedFrontmatterLines(skillMd);
  errorMessage.value = '';
  editorMode.value = 'simple';
  editing.value = true;
}

async function cancelEdit(): Promise<void> {
  if (saving.value) return;
  await editorWrites;
  if (editorWriteError) { errorMessage.value = t('hub.learnEditorCopyFailed', { detail: editorWriteError }); return; }
  finishEditing();
}
function finishEditing(): void {
  activeTransferId.value = null;
  releaseEditor?.(); releaseEditor = null;
  editorWriteError = '';
  editing.value = false; editingSource.value = null; resetForm();
}

/**
 * frontmatter 单行标量序列化：值含行内注释特征（" #"）、以 # 开头、首尾空白、
 * 或本身形如引号包裹值时，用双引号包裹并转义内部引号/反斜杠，
 * 保证「保存 → 重新解析」往返不丢内容（解析端见 frontmatter-parser 的反转义）。
 */
function fmScalar(value: string): string {
  const needsQuoting =
    value === '' ||
    /\s#/.test(value) ||
    value.startsWith('#') ||
    value !== value.trim() ||
    /^".*$/s.test(value) ||
    /^'.*$/s.test(value);
  if (!needsQuoting) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 简单模式：由表单 + 保留行重组完整 SKILL.md（分类恒写入——分类必选） */
function composeSkillMd(): string {
  const lines = [
    '---',
    `name: ${normalizedFormName.value}`,
    `description: ${fmScalar(form.description.replace(/\n/g, ' '))}`,
    `category: ${fmScalar(resolvedCategory.value)}`,
    ...(form.tags.length > 0 ? [`tags: ${form.tags.join(' ')}`] : []),
    ...preservedFrontmatterLines,
    '---',
    '',
    form.body,
  ];
  return lines.join('\n');
}

/**
 * 模式切换（内容随动，双向无损）：
 *   simple → advanced：按当前表单重组原文；
 *   advanced → simple：解析原文回填三字段，解析失败时阻止切换并提示。
 */
function switchMode(target: 'simple' | 'advanced'): void {
  if (target === editorMode.value) return;
  errorMessage.value = '';

  if (target === 'advanced') {
    // 校验简单模式表单后再重组（空表单也允许切换，重组结果由高级模式校验兜底）
    form.raw = composeSkillMd();
    editorMode.value = 'advanced';
    return;
  }

  // advanced → simple：先严格解析，失败则留在高级模式
  const validation = validateSkillMd(form.raw, { fallbackName: editingSource.value?.name });
  if (!validation.ok) {
    errorMessage.value = t('hub.modeSwitchBlocked');
    return;
  }
  const rawName = validation.data['name'];
  form.name = normalizeSkillName(rawName || editingSource.value?.name || form.name);
  form.description = (validation.data['description'] || '').trim();
  form.body = validation.body.replace(/\s+$/, '');
  // 分类 / 标签随原文回填（与 startEdit 同一回填规则；校验已保证 category 非空）
  const rawCategory = normalizeCategory(validation.data['category']);
  if (!rawCategory || isBuiltinCategory(rawCategory)) {
    form.category = rawCategory;
    form.customCategory = '';
  } else {
    form.category = CATEGORY_CUSTOM_VALUE;
    form.customCategory = rawCategory;
  }
  form.tags = parseSkillTags(validation.data['tags']);
  preservedFrontmatterLines = extractPreservedFrontmatterLines(form.raw);
  editorMode.value = 'simple';
}

/** 存储层失败原因 → 可读文案（同名已合法，写入层只可能 invalid / not-found） */
function writeErrorText(result: Extract<SkillWriteResult, { ok: false }>): string {
  switch (result.reason) {
    case 'not-found':
      return t('hub.errorSkillNotFound');
    default:
      // 'invalid'（名称规范化后为空/非法）：与表单校验同一口径的兜底文案
      return t('hub.errorSkillInvalid');
  }
}

async function save(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try { await saveImpl(); }
  catch (error) { errorMessage.value = String(error); }
  finally { saving.value = false; }
}
async function saveImpl(): Promise<void> {
  if (!canSave.value) {
    // 区分不可保存原因：资源面板未收起（提示收面板）而非笼统的「表单不完整」
    errorMessage.value =
      editorMode.value === 'advanced' && resourceEditorOpen.value
        ? t('hub.resourceEditorOpenHint')
        : t('hub.errorSkillInvalid');
    return;
  }

  const submittedSnapshot = JSON.stringify(editorSnapshot());
  // 两种模式最终都收敛为「完整 SKILL.md 原文 + 显式 name/description」
  let skillMd = editorMode.value === 'simple' ? composeSkillMd() : form.raw;
  if (activeTransferId.value) {
    const id = activeTransferId.value;
    if (parseFrontmatter(skillMd).data[LEARN_TRANSFER_MARKER] !== id) {
      const lines = skillMd.replace(/\r\n/g, '\n').split('\n');
      const end = lines.findIndex((line, index) => index > 0 && (line.trim() === '---' || line.trim() === '...'));
      if (lines[0]?.trim() !== '---' || end < 1) throw new Error(t('hub.errorSkillInvalid'));
      skillMd = ['---', ...lines.slice(1, end).filter(line => !line.startsWith(LEARN_TRANSFER_MARKER + ':')), `${LEARN_TRANSFER_MARKER}: ${id}`, ...lines.slice(end)].join('\n');
    }
  }
  const parsed = parseFrontmatter(skillMd);
  const name = normalizeSkillName(
    parsed.data['name'] || editingSource.value?.name || form.name,
  );
  const description = (parsed.data['description'] || form.description || '').trim();

  // 资源文件与重写的 SKILL.md 合并（简单模式同样保留资源文件——数据结构保证不丢）
  const files: Record<string, string> = { ...resourceFiles.value };
  files['SKILL.md'] = skillMd;

  // 总量终检（与导入同一套上限；资源面板已按同一口径预检，此处兜底 SKILL.md 本身）
  const totalChars = Object.entries(files).reduce((sum, [, content]) => sum + content.length, 0);
  if (totalChars > SKILL_IMPORT_MAX_TOTAL_CHARS) {
    errorMessage.value = t('hub.resourceTotalTooLarge', { max: SKILL_IMPORT_MAX_TOTAL_CHARS });
    return;
  }

  // allowed-tools 保留判定：frontmatter 中的 allowed-tools 行未被用户改动时，
  // 显式沿用原记录的归一化列表——保留可能存在的持久化覆盖（反序列化语义），
  // 避免「只改了描述却让预授权工具静默回退」；行被改动（高级模式编辑
  // frontmatter）则缺省传入，以新声明的值为准（用户显式意图优先）
  const prevAllowedLine = parseAllowedTools(
    parseFrontmatter(editingSource.value?.files['SKILL.md'] ?? '').data['allowed-tools'],
  ).join('\u0000');
  const nextAllowedLine = parseAllowedTools(parsed.data['allowed-tools']).join('\u0000');
  const keepAllowedTools =
    !!editingSource.value && prevAllowedLine === nextAllowedLine
      ? { allowedTools: editingSource.value.allowedTools }
      : {};

  const result = setCustomSkill({
    id: editingSource.value?.id ?? (activeTransferId.value ? getAllSkills().find(skill =>
      skill.source === 'custom' && parseFrontmatter(skill.files['SKILL.md'] ?? '').data[LEARN_TRANSFER_MARKER] === activeTransferId.value)?.id : undefined),
    name,
    files,
    description,
    enabled: editingSource.value?.enabled ?? true,
    ...keepAllowedTools,
  });
  if (!result.ok) {
    errorMessage.value = writeErrorText(result);
    return;
  }

  // 落盘确认：chrome.storage 写失败时保留编辑态（用户可重试保存或先导出），
  // 绝不让「界面提示已保存、重启后技能消失」的静默丢失发生
  editingSource.value = result.skill;
  editingExisting.value = true;
  const flushed = await flushSkillStoreWrites();
  if (!flushed.ok) {
    errorMessage.value = t('hub.errorSkillStorageWrite', { detail: flushed.error ?? '' });
    return;
  }
  // 防御程序化更新/异步回调：保存途中出现的新编辑不能被旧保存结果关闭。
  if (JSON.stringify(editorSnapshot()) !== submittedSnapshot) {
    errorMessage.value = t('hub.editorChangedDuringSave');
    return;
  }

  // 成功创建（且本次来自学习成果确认卡）→ 关掉确认卡：
  // 成果已落库，卡片再挂着会让「确认一次后仍显示待确认」误导用户重复点击
  //（表单校验失败 / 存储层拒绝时保留卡片，故只在成功路径清理）
  if (activeTransferId.value) {
    await editorWrites;
    const acknowledged = await completeLearnDraft(activeTransferId.value, result.skill.id);
    if (!acknowledged.ok) { errorMessage.value = t('hub.learnHandoffAckFailed'); return; }
  }
  draftCard.value = null;
  finishEditing();
}

/** 供外壳在用户主动确认后调用；深链与挂载不能直接触发预填。 */
defineExpose({ acceptLearnDraft });
</script>
