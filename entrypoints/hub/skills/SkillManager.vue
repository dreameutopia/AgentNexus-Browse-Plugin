<template>
  <section class="hub-panel">
    <!-- 列表视图 -->
    <div v-if="!editing" class="hub-list-view">
      <div class="hub-list-toolbar">
        <span class="hub-list-count">{{ t('hub.skillCount', { count: skills.length }) }}</span>
        <div class="hub-list-actions">
          <button type="button" class="hub-btn" @click="triggerImport">{{ t('hub.importSkill') }}</button>
          <button type="button" class="hub-btn hub-btn-primary" @click="startCreate">
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
          <!-- 模型标识（name-id）：对模型暴露的唯一名称，点击复制 -->
          <button
            type="button"
            class="hub-model-id"
            :title="t('hub.modelIdHint')"
            @click="copyModelId(skill)"
          >{{ modelSkillIdOf(skill) }}</button>
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
            <label class="hub-switch-row hub-switch-inline" @click.stop>
              <input
                type="checkbox"
                :checked="skill.enabled"
                @change="toggleEnabled(skill)"
              />
              <span>{{ skill.enabled ? t('hub.enabled') : t('hub.disabled') }}</span>
            </label>
            <span class="hub-card-ops">
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
    <form v-else class="hub-editor" @submit.prevent="save">
      <div class="hub-editor-head">
        <h2>{{ editingExisting ? t('hub.editSkill') : t('hub.newSkill') }}</h2>
        <button type="button" class="hub-btn" @click="cancelEdit">{{ t('hub.backToList') }}</button>
      </div>

      <!-- 网站学习成果确认卡（预填后内联展示；确认→直接保存，微调→关卡留在表单） -->
      <SkillDraftConfirm
        v-if="draftCard"
        :draft="draftCard.draft"
        :final-name="draftCard.finalName"
        @confirm="confirmDraftCreate"
        @edit="draftCard = null"
      />

      <!-- 交付信号在编辑中到达：挂起提示（编辑结束自动接手，见 cancelEdit） -->
      <p v-if="pendingDraftImport" class="hub-hint hub-draft-pending">
        {{ t('hub.learnDraftPending') }}
      </p>

      <!-- 模式切换（带确认语义：切换会把当前内容转换为目标形态） -->
      <div class="hub-mode-switch" role="group">
        <button
          type="button"
          class="hub-mode-btn"
          :class="{ active: editorMode === 'simple' }"
          @click="switchMode('simple')"
        >{{ t('hub.modeSimple') }}</button>
        <button
          type="button"
          class="hub-mode-btn"
          :class="{ active: editorMode === 'advanced' }"
          @click="switchMode('advanced')"
        >{{ t('hub.modeAdvanced') }}</button>
      </div>
      <p class="hub-hint">{{ editorMode === 'simple' ? t('hub.modeSimpleHint') : t('hub.modeAdvancedHint') }}</p>

      <!-- 简单模式：name / description / category / tags / prompt 五字段，提交必成功 -->
      <template v-if="editorMode === 'simple'">
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

        <label class="hub-field">
          <span class="hub-field-label">{{ t('hub.fieldPrompt') }}</span>
          <textarea v-model="form.body" rows="16" required :placeholder="t('hub.fieldPromptPlaceholder')" class="hub-body-editor"></textarea>
          <span class="hub-hint">{{ t('hub.fieldBodyHint', { count: form.body.length }) }}</span>
        </label>
      </template>

      <!-- 高级模式：完整 SKILL.md 原文（frontmatter + 正文），提交前严格校验 -->
      <template v-else>
        <label class="hub-field">
          <span class="hub-field-label">{{ t('hub.fieldRawSkillMd') }}</span>
          <textarea
            v-model="form.raw"
            rows="22"
            class="hub-body-editor hub-raw-editor"
            :placeholder="t('hub.fieldRawSkillMdPlaceholder')"
            spellcheck="false"
          ></textarea>
          <span class="hub-hint">{{ t('hub.fieldRawSkillMdHint') }}</span>
        </label>
        <!-- 实时校验结果（逐条列出，保存按钮联动禁用） -->
        <ul v-if="rawIssues.length" class="hub-raw-issues">
          <li v-for="(issue, index) in rawIssues" :key="index">{{ issue }}</li>
        </ul>
      </template>

      <div class="hub-editor-footer">
        <span v-if="errorMessage" class="hub-error">{{ errorMessage }}</span>
        <div class="hub-editor-actions">
          <button type="button" class="hub-btn" @click="cancelEdit">{{ t('common.cancel') }}</button>
          <button type="submit" class="hub-btn hub-btn-primary" :disabled="!canSave">{{ t('common.save') }}</button>
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
 * 编辑器双模式：
 *   - 简单模式：name / description / category / tags / prompt 五字段，保存时
 *     自动组装规范 SKILL.md（其余 frontmatter 字段在编辑既有技能时原样保留），
 *     百分百可正确创建；分类必选，与智能体共用同一套分类/标签规范；
 *   - 高级模式：直接编辑完整 SKILL.md（frontmatter + 正文），提交时经
 *     validateSkillMd 严格校验并逐条提示格式问题（含缺失 category 字段）。
 * 模式互切有内容转换：简单 → 高级按表单重组原文；高级 → 简单解析回填
 * （解析失败时阻止切换，避免半份内容静默丢失）。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { t, type MessageKey } from '@/utils/i18n';
import CategorySelect from '../components/CategorySelect.vue';
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
  getSkillByName,
  uniqueSkillName,
  type SkillRecord,
  type SkillWriteResult,
} from '@/utils/skills/skill-store';
import {
  takeLearnDraft,
  hasLearnDraft,
  type LearnDraftTakeResult,
} from '@/utils/learn/learn-draft-store';
import type { SkillDraft } from '@/utils/learn/learn-types';
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
  importSkillsFromZipBytes,
  importSkillFromMdText,
  downloadSkillZip,
  type SkillImportReport,
  type SkillImportSkip,
} from '@/utils/skills/skill-import-export';

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
    'store-reject': 'hub.importSkipStoreReject',
  };
  return t(reasonKeys[skip.reason] as MessageKey, { source: skip.source });
}

/** 组装导入反馈文案（成功概要 + 重命名明细 + 跳过明细） */
function showImportFeedback(report: SkillImportReport, fileName: string): void {
  const lines: string[] = [];
  if (report.imported.length > 0) {
    lines.push(t('hub.importResult', { count: report.imported.length, file: fileName }));
  } else {
    lines.push(t('hub.importNone', { file: fileName }));
  }
  for (const skip of report.skipped) lines.push(importSkipText(skip));
  importFeedbackLines.value = lines;
  importFeedbackTone.value = report.imported.length > 0 ? 'ok' : 'error';
  if (importFeedbackTimer) clearTimeout(importFeedbackTimer);
  importFeedbackTimer = setTimeout(() => {
    importFeedbackLines.value = [];
  }, 15_000);
}

/** 读取并导入所选文件（zip 走批量解析，md 走单文解析；异常统一可读反馈） */
async function handleImportFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // 复位 value，保证同一文件可重复选择导入
  input.value = '';
  if (!file) return;

  try {
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith('.zip')) {
      const buffer = await file.arrayBuffer();
      const fallbackName = normalizeSkillName(file.name.replace(/\.zip$/i, '')) || 'imported-skill';
      const report = importSkillsFromZipBytes(new Uint8Array(buffer), fallbackName);
      showImportFeedback(report, file.name);
    } else if (lowerName.endsWith('.md')) {
      const text = await file.text();
      const fallbackName = file.name.replace(/\.md$/i, '');
      const report = importSkillFromMdText(text, fallbackName);
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

// ──── 网站学习成果（草稿深链消费） ────

/** 学习成果确认卡（预填后展示；null = 无待确认成果） */
const draftCard = ref<{ draft: SkillDraft; finalName: string } | null>(null);
/** 编辑中收到交付信号：挂起为待导入（peek 不消费，见 consumeLearnDraft） */
const pendingDraftImport = ref(false);

/**
 * 消费网站学习草稿（外壳在深链 / 挂载时调用；one-shot 由存储层保证幂等）。
 *
 * @param viaHash 是否由深链触发——深链对用户承诺了「成果已送达」，
 *                缺失 / 过期 / 形态非法都要明确告知；常规打开只在拿到
 *                有效草稿时静默接手（完成未竟的交付），不打扰无关访问。
 *
 * 编辑态冲突：绝不打断用户正在编辑的内容——peek 探测后挂起为待导入信号
 * （读取即删的语义留给用户真正接手的那一刻），编辑结束时自动接手。
 */
async function consumeLearnDraft(viaHash: boolean): Promise<void> {
  if (editing.value) {
    if (await hasLearnDraft()) pendingDraftImport.value = true;
    return;
  }
  applyDraftResult(await takeLearnDraft(), viaHash);
}

/** 按消费结果分流：有效草稿 → 预填；否则按触发口径决定是否提示 */
function applyDraftResult(result: LearnDraftTakeResult, viaHash: boolean): void {
  if (result.status === 'ok') {
    startCreateWithDraft(result.draft);
    return;
  }
  if (!viaHash) return; // 常规打开：无草稿 / 已过期 / 脏数据一律静默
  startCreate();
  errorMessage.value = t(
    result.status === 'invalid' ? 'hub.learnDraftInvalid' : 'hub.learnDraftExpired',
  );
}

/**
 * 预填表单并弹出确认卡。
 * 名称在预填时就做重名避让——AI 生成的名字与既有技能撞车概率不低，
 * 避让只是给一个不撞车的默认名（同名本身已合法、不会导致保存失败），
 * 用户仍可在表单里改回原名。
 */
function startCreateWithDraft(draft: SkillDraft): void {
  startCreate(); // 进入创建态、清空表单（resetForm 同步复位确认卡）
  pendingDraftImport.value = false;
  const finalName = getSkillByName(draft.name) ? uniqueSkillName(draft.name) : draft.name;
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

const canSave = computed(() =>
  editorMode.value === 'simple' ? simpleValid.value : rawValidation.value.ok,
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

function cancelEdit(): void {
  editing.value = false;
  editingSource.value = null;
  resetForm();
  // 编辑期间挂起的交付信号：编辑结束即接手（保留深链提示口径——
  // 若等待期间草稿过期/被清，用户会得到明确告知而不是静默落空）
  if (pendingDraftImport.value) {
    pendingDraftImport.value = false;
    void consumeLearnDraft(true);
  }
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

function save(): void {
  if (!canSave.value) {
    errorMessage.value = t('hub.errorSkillInvalid');
    return;
  }

  // 两种模式最终都收敛为「完整 SKILL.md 原文 + 显式 name/description」
  const skillMd = editorMode.value === 'simple' ? composeSkillMd() : form.raw;
  const parsed = parseFrontmatter(skillMd);
  const name = normalizeSkillName(
    parsed.data['name'] || editingSource.value?.name || form.name,
  );
  const description = (parsed.data['description'] || form.description || '').trim();

  // 资源文件保留：仅重写 SKILL.md，其余文件（references 等）原样携带
  const files: Record<string, string> = { ...(editingSource.value?.files ?? {}) };
  files['SKILL.md'] = skillMd;

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
    id: editingSource.value?.id,
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
  // 成功创建（且本次来自学习成果确认卡）→ 关掉确认卡：
  // 成果已落库，卡片再挂着会让「确认一次后仍显示待确认」误导用户重复点击
  //（表单校验失败 / 存储层拒绝时保留卡片，故只在成功路径清理）
  draftCard.value = null;
  cancelEdit();
}

/** 供外壳（hub App）在深链 / 挂载时调用的草稿消费入口 */
defineExpose({ consumeLearnDraft });
</script>
