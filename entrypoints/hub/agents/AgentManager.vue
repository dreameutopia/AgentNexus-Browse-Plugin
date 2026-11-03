<template>
  <section class="hub-panel">
    <!-- 列表视图 -->
    <div v-if="!editing" class="hub-list-view">
      <div class="hub-list-toolbar">
        <span class="hub-list-count">{{ t('hub.agentCount', { count: filteredAgents.length }) }}</span>
        <div class="hub-list-filters">
          <input
            v-model.trim="filterQuery"
            type="text"
            class="hub-list-search"
            :placeholder="t('hub.searchAgentPlaceholder')"
          />
          <select v-model="filterCategory" class="hub-list-category">
            <option value="">{{ t('hub.filterAllCategories') }}</option>
            <option v-for="category in availableCategories" :key="category.id" :value="category.id">
              {{ category.labelKey ? t(category.labelKey as MessageKey) : category.id }}
            </option>
          </select>
          <button type="button" class="hub-btn hub-btn-primary" @click="startCreate">
            {{ t('hub.newAgent') }}
          </button>
        </div>
      </div>

      <p v-if="errorMessage" class="hub-error hub-list-error">{{ errorMessage }}</p>

      <div v-if="!filteredAgents.length" class="hub-empty">{{ t('hub.noAgentMatch') }}</div>
      <div v-else class="hub-cards">
        <article v-for="agent in filteredAgents" :key="agent.id" class="hub-card" :class="{ 'is-preset': isPreset(agent) }">
          <div class="hub-card-head">
            <!-- 智能体头像：图片或 emoji，无背景色 -->
            <div class="hub-card-title">
              <AgentAvatar class="hub-card-avatar" :avatar="agent.avatar" :size="26" :label="agent.name" />
              <span class="hub-card-name" :title="agent.name">{{ agent.name }}</span>
            </div>
            <span class="hub-badge" :class="isPreset(agent) ? 'hub-badge-preset' : 'hub-badge-custom'">
              {{ isPreset(agent) ? t('hub.preset') : t('hub.custom') }}
            </span>
          </div>
          <p class="hub-card-desc" :title="agent.description">{{ agent.description }}</p>
          <div class="hub-card-taxonomy">
            <span class="hub-badge hub-badge-category">{{ categoryLabel(agent.category) }}</span>
            <span v-for="tag in agent.tags" :key="tag" class="hub-badge hub-badge-tag">{{ tag }}</span>
          </div>
          <div class="hub-card-meta">
            <span class="hub-card-tools">{{ t('hub.toolCount', { count: agent.tools.length }) }}</span>
            <span v-if="agent.skills?.length" class="hub-card-tools">{{ t('hub.agentSkillCount', { count: agent.skills.length }) }}</span>
            <span v-if="agent.vision" class="hub-badge hub-badge-vision">Vision</span>
            <span class="hub-card-ops">
              <template v-if="!isPreset(agent)">
                <button type="button" class="hub-op" @click="startEdit(agent)">{{ t('hub.edit') }}</button>
                <button type="button" class="hub-op hub-op-danger" @click="removeAgent(agent)">{{ t('hub.delete') }}</button>
              </template>
              <span v-else class="hub-card-readonly">{{ t('hub.presetReadonly') }}</span>
            </span>
          </div>
        </article>
      </div>
    </div>

    <!-- 编辑视图（左右布局：左列基础信息与分类标签，右列工具组与视觉声明） -->
    <form v-else class="hub-editor" @submit.prevent="save">
      <div class="hub-editor-head">
        <h2>{{ editingExisting ? t('hub.editAgent') : t('hub.newAgent') }}</h2>
        <button type="button" class="hub-btn" @click="cancelEdit">{{ t('hub.backToList') }}</button>
      </div>

      <div class="hub-editor-split">
        <!-- 左列：名称 / 描述 / 分类 / 标签 / 系统提示词 -->
        <div class="hub-editor-col">
          <label class="hub-field" :class="{ 'is-invalid': nameInvalid }">
            <span class="hub-field-label">{{ t('hub.fieldName') }}<span class="hub-required" aria-hidden="true">*</span></span>
            <input v-model.trim="form.name" type="text" :maxlength="AGENT_NAME_MAX_CHARS" :placeholder="t('hub.fieldNamePlaceholder')" />
          </label>

          <label class="hub-field" :class="{ 'is-invalid': descriptionInvalid }">
            <span class="hub-field-label">{{ t('hub.fieldDescription') }}<span class="hub-required" aria-hidden="true">*</span></span>
            <input v-model.trim="form.description" type="text" :maxlength="AGENT_DESCRIPTION_MAX_CHARS" :placeholder="t('hub.fieldDescriptionPlaceholder')" />
          </label>

          <!-- 分类：自定义下拉（内置分类 + 智能体/技能中已有自定义分类可复用）；
               选择「新建自定义分类」时，新分类名称输入框与选择器位于同一行，
               保存前经 normalizeCategory 归一化为稳定 id -->
          <div class="hub-field" :class="{ 'is-invalid': customCategoryInvalid }">
            <span class="hub-field-label">
              {{ t('hub.fieldCategory') }}<span v-if="form.category === CATEGORY_CUSTOM_VALUE" class="hub-required" aria-hidden="true">*</span>
            </span>
            <CategorySelect
              v-model="form.category"
              v-model:custom="form.customCategory"
              :allow-uncategorized="true"
              :invalid="customCategoryInvalid"
            />
            <p class="hub-hint">{{ t('hub.fieldCategoryHint') }}</p>
          </div>

          <!-- 标签：多选；回车 / 逗号 / 空格分隔逐个添加（提示与上限反馈由组件内置） -->
          <div class="hub-field">
            <span class="hub-field-label">{{ t('hub.fieldTags') }}</span>
            <TagInput v-model="form.tags" />
          </div>

          <!-- 头像：内置图片任选其一，或自填 emoji（预置 / 自定义 / 导入三类智能体同构） -->
          <div class="hub-field">
            <span class="hub-field-label">{{ t('hub.fieldAvatar') }}</span>
            <div class="hub-avatar-picker">
              <div class="hub-avatar-images">
                <button
                  v-for="option in builtinAvatars"
                  :key="option.id"
                  type="button"
                  class="hub-avatar-option"
                  :class="{ 'is-active': isBuiltinAvatarSelected(option.src) }"
                  :title="option.id"
                  @click="selectBuiltinAvatar(option.src)"
                >
                  <AgentAvatar :avatar="{ type: 'image', src: option.src }" :size="26" />
                </button>
              </div>
              <label class="hub-avatar-emoji-field">
                <span class="hub-field-label">{{ t('hub.fieldAvatarEmoji') }}</span>
                <input
                  v-model.trim="form.avatarEmoji"
                  type="text"
                  :maxlength="AGENT_AVATAR_EMOJI_MAX_CHARS"
                  :placeholder="t('hub.fieldAvatarEmojiPlaceholder')"
                  @input="syncAvatarFromEmoji"
                />
              </label>
              <p class="hub-hint">{{ t('hub.fieldAvatarHint') }}</p>
            </div>
          </div>

          <label class="hub-field" :class="{ 'is-invalid': systemInvalid }">
            <span class="hub-field-label">{{ t('hub.fieldSystem') }}<span class="hub-required" aria-hidden="true">*</span></span>
            <textarea v-model="form.system" rows="14" :placeholder="t('hub.fieldSystemPlaceholder')"></textarea>
          </label>
        </div>

        <!-- 右列：工具组选择 + 视觉声明 -->
        <div class="hub-editor-col">
          <div class="hub-field">
            <div class="hub-groups-head">
              <span class="hub-field-label">{{ t('hub.fieldToolGroups') }}<span class="hub-required" aria-hidden="true">*</span></span>
              <span class="hub-groups-count">{{ t('hub.selectedToolCount', { count: selectedToolCount, max: MAX_TOOLS_PER_AGENT }) }}</span>
            </div>
            <div class="hub-groups-scroll" :class="{ 'is-invalid': groupsInvalid }">
              <div class="hub-groups">
                <label
                  v-for="group in toolGroups"
                  :key="group.id"
                  class="hub-group"
                  :class="{ checked: form.groups.includes(group.id), locked: isGroupLocked(group.id) }"
                >
                  <input
                    type="checkbox"
                    :value="group.id"
                    :checked="form.groups.includes(group.id)"
                    :disabled="isGroupLocked(group.id)"
                    @change="toggleGroup(group.id)"
                  />
                  <span class="hub-group-name">{{ t(group.nameKey) }}</span>
                  <span class="hub-group-desc">{{ t(group.descKey) }}</span>
                  <span v-if="isGroupLocked(group.id)" class="hub-group-lock">{{ t('hub.pythonNotReady') }}</span>
                </label>
              </div>
            </div>
            <p v-if="showLimitHint" class="hub-error">{{ t('hub.toolLimitHint', { max: MAX_TOOLS_PER_AGENT }) }}</p>
            <p v-else-if="extraTools.length > 0" class="hub-hint">{{ t('hub.extraToolsHint', { count: extraTools.length }) }}</p>
          </div>

          <!-- 关联技能：多选（可用清单 = 显式关联 ∪ 工具映射兜底；见 utils/skills/skill-availability） -->
          <div class="hub-field">
            <div class="hub-groups-head">
              <span class="hub-field-label">{{ t('hub.fieldAgentSkills') }}</span>
              <span class="hub-groups-count">{{ t('hub.selectedSkillCount', { count: form.skills.length, max: AGENT_SKILLS_MAX_COUNT }) }}</span>
            </div>
            <div class="hub-groups-scroll">
              <div v-if="!skills.length" class="hub-hint">{{ t('hub.noSkillsAvailable') }}</div>
              <div v-else class="hub-groups">
                <label
                  v-for="skill in skills"
                  :key="skill.id"
                  class="hub-group"
                  :class="{ checked: form.skills.includes(skill.id), 'is-disabled-skill': !skill.enabled }"
                >
                  <input
                    type="checkbox"
                    :value="skill.id"
                    :checked="form.skills.includes(skill.id)"
                    :disabled="!form.skills.includes(skill.id) && form.skills.length >= AGENT_SKILLS_MAX_COUNT"
                    @change="toggleSkill(skill.id)"
                  />
                  <span class="hub-group-name">{{ skillOptionLabel(skill) }}</span>
                  <span class="hub-group-desc">{{ skill.enabled ? skill.description : t('hub.skillDisabledMark') }}</span>
                </label>
              </div>
            </div>
            <p class="hub-hint">{{ t('hub.fieldAgentSkillsHint') }}</p>
          </div>

          <fieldset class="hub-field">
            <legend class="hub-field-label">{{ t('hub.fieldVision') }}</legend>
            <label class="hub-switch-row">
              <input type="checkbox" v-model="form.visionEnabled" />
              <span>{{ t('hub.visionEnable') }}</span>
            </label>
            <template v-if="form.visionEnabled">
              <p class="hub-hint">{{ t('hub.visionCoordinatesHint') }}</p>
              <label class="hub-inline-field hub-vision-tool">
                <span>{{ t('hub.screenshotTool') }}</span>
                <select v-model="form.screenshotTool">
                  <option value="screenshot">screenshot</option>
                </select>
              </label>
              <label class="hub-switch-row">
                <input type="checkbox" v-model="form.reScreenshotAfterTools" />
                <span>{{ t('hub.reScreenshot') }}</span>
              </label>
            </template>
          </fieldset>
        </div>
      </div>

      <div class="hub-editor-footer">
        <span v-if="errorMessage" class="hub-error">{{ errorMessage }}</span>
        <div class="hub-editor-actions">
          <button type="button" class="hub-btn" @click="cancelEdit">{{ t('common.cancel') }}</button>
          <button type="submit" class="hub-btn hub-btn-primary">{{ t('common.save') }}</button>
        </div>
      </div>
    </form>
  </section>
</template>

<script setup lang="ts">
/**
 * 智能体管理：预置（只读展示）+ 自定义（新建/编辑/删除）。
 * 编辑器为左右布局：左列名称/描述/分类/标签/系统提示词，右列工具组（上限 30 个工具）与视觉声明。
 * 采样参数（temperature / maxTokens）与流式开关已移除——统一取用户全局 API 配置，流式恒开。
 * 写入经 utils/agents/agent-store（chrome.storage 权威源），跨上下文实时同步到 sidepanel。
 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';
import { t, type MessageKey } from '@/utils/i18n';
// 智能体头像展示（图片或 emoji，无背景色）：预置 / 自定义 / 导入三类智能体共用
import AgentAvatar from '@/common/AgentAvatar.vue';
import CategorySelect from '../components/CategorySelect.vue';
import TagInput from '../components/TagInput.vue';
import {
  AGENT_AVATAR_EMOJI_MAX_CHARS,
  AGENT_CATEGORY_UNCATEGORIZED,
  AGENT_DESCRIPTION_MAX_CHARS,
  AGENT_NAME_MAX_CHARS,
  AGENT_SKILLS_MAX_COUNT,
  BUILTIN_AGENT_AVATARS,
  BUILTIN_AGENT_CATEGORIES,
  CATEGORY_CUSTOM_VALUE,
  categoryLabelOf,
  generateUniqueAgentId,
  getAllAgents,
  isBuiltinCategory,
  isPresetAgent,
  normalizeAvatar,
  normalizeCategory,
  onAgentsChange,
  removeAgentConfig,
  setAgentConfig,
  type AgentConfig,
  type AgentWriteResult,
} from '@/utils/agents/agent-store';
import { getPresetToolIds, type ToolScenario } from '@/utils/tools/tool-presets';
import { getAllSkills, onSkillsChange, resolveSkill, type SkillRecord } from '@/utils/skills/skill-store';
import { findDuplicateSkillNames } from '@/utils/skills/skill-types';
import {
  getPyodideEnvState,
  watchPyodideEnv,
  type PyodideEnvState,
} from '@/utils/pyodide/pyodide-env';

// ──── 工具组（仅暴露对自定义智能体有意义的场景；特殊流程场景不开放） ────

interface ToolGroupMeta {
  id: ToolScenario;
  nameKey: MessageKey;
  descKey: MessageKey;
}

const toolGroups: ReadonlyArray<ToolGroupMeta> = [
  { id: 'chat', nameKey: 'hub.groupChat', descKey: 'hub.groupChatDesc' },
  { id: 'automation', nameKey: 'hub.groupAutomation', descKey: 'hub.groupAutomationDesc' },
  { id: 'note', nameKey: 'hub.groupNote', descKey: 'hub.groupNoteDesc' },
  { id: 'searchAgent', nameKey: 'hub.groupSearch', descKey: 'hub.groupSearchDesc' },
  { id: 'extendedSearch', nameKey: 'hub.groupExtendedSearch', descKey: 'hub.groupExtendedSearchDesc' },
  { id: 'integratedSearch', nameKey: 'hub.groupIntegratedSearch', descKey: 'hub.groupIntegratedSearchDesc' },
  { id: 'resultScrape', nameKey: 'hub.groupResultScrape', descKey: 'hub.groupResultScrapeDesc' },
  { id: 'pageRead', nameKey: 'hub.groupPageRead', descKey: 'hub.groupPageReadDesc' },
  { id: 'domInteract', nameKey: 'hub.groupDomInteract', descKey: 'hub.groupDomInteractDesc' },
  { id: 'tabsWindows', nameKey: 'hub.groupTabsWindows', descKey: 'hub.groupTabsWindowsDesc' },
  { id: 'scripting', nameKey: 'hub.groupScripting', descKey: 'hub.groupScriptingDesc' },
  { id: 'navigation', nameKey: 'hub.groupNavigation', descKey: 'hub.groupNavigationDesc' },
  { id: 'bookmarkHistory', nameKey: 'hub.groupBookmarkHistory', descKey: 'hub.groupBookmarkHistoryDesc' },
  { id: 'resource', nameKey: 'hub.groupResource', descKey: 'hub.groupResourceDesc' },
  { id: 'resourceCapture', nameKey: 'hub.groupResourceCapture', descKey: 'hub.groupResourceCaptureDesc' },
  { id: 'files', nameKey: 'hub.groupFiles', descKey: 'hub.groupFilesDesc' },
  { id: 'data', nameKey: 'hub.groupData', descKey: 'hub.groupDataDesc' },
  { id: 'networkTools', nameKey: 'hub.groupNetworkTools', descKey: 'hub.groupNetworkToolsDesc' },
  { id: 'visionTools', nameKey: 'hub.groupVisionTools', descKey: 'hub.groupVisionToolsDesc' },
  { id: 'skillLoad', nameKey: 'hub.groupSkillLoad', descKey: 'hub.groupSkillLoadDesc' },
  { id: 'python', nameKey: 'hub.groupPython', descKey: 'hub.groupPythonDesc' },
  { id: 'excalidraw', nameKey: 'hub.groupExcalidraw', descKey: 'hub.groupExcalidrawDesc' },
  { id: 'bilibili', nameKey: 'hub.groupBilibili', descKey: 'hub.groupBilibiliDesc' },
];

/** 场景组工具集合缓存（避免每次比较重复计算） */
const groupToolSets = new Map<string, readonly string[]>(
  toolGroups.map(group => [group.id, getPresetToolIds(group.id)]),
);

/** 单个智能体的工具总数上限（组工具并集去重后计数） */
const MAX_TOOLS_PER_AGENT = 30;

// ──── 列表态 ────

const agents = ref<AgentConfig[]>([]);
const refreshList = () => {
  agents.value = getAllAgents();
};

const isPreset = (agent: AgentConfig) => isPresetAgent(agent.id);

/** 分类显示名：内置分类走 i18n，自定义分类原样展示 id；未分类显示为「通用」 */
const categoryLabel = (categoryId: string): string => categoryLabelOf(categoryId, id => t(id as MessageKey));

// 列表筛选（分类 + 关键词，关键词覆盖名称/描述/标签）
const filterQuery = ref('');
const filterCategory = ref('');

/** 数据中实际出现过的分类（内置在前、自定义在后），供筛选下拉使用 */
const availableCategories = computed(() => {
  const used = new Set(agents.value.map(agent => agent.category || AGENT_CATEGORY_UNCATEGORIZED));
  const builtin = BUILTIN_AGENT_CATEGORIES.filter(category => used.has(category.id)).map(category => ({
    id: category.id,
    labelKey: category.labelKey as MessageKey,
  }));
  const custom = [...used]
    .filter(id => !isBuiltinCategory(id))
    .sort()
    .map(id => ({ id, labelKey: null as MessageKey | null }));
  return [...builtin, ...custom];
});

const filteredAgents = computed(() => {
  const query = filterQuery.value.toLowerCase();
  const category = filterCategory.value;
  return agents.value.filter(agent => {
    const agentCategory = agent.category || AGENT_CATEGORY_UNCATEGORIZED;
    if (category && agentCategory !== category) return false;
    if (!query) return true;
    return (
      agent.name.toLowerCase().includes(query) ||
      agent.description.toLowerCase().includes(query) ||
      agent.tags.some(tag => tag.toLowerCase().includes(query))
    );
  });
});

const unsubscribe = onAgentsChange(() => refreshList());
onMounted(refreshList);
onUnmounted(() => unsubscribe());

// ──── 关联技能（列表来自技能存储，跨上下文实时刷新） ────

/** 全部技能（预置 + 自定义），供关联多选 */
const skills = ref<SkillRecord[]>([]);
const refreshSkills = () => {
  skills.value = getAllSkills();
};
const unsubscribeSkills = onSkillsChange(() => refreshSkills());
onMounted(refreshSkills);
onUnmounted(() => unsubscribeSkills());

/** 列表内重名的技能名（同名是常态）：重名条目补显 id 消歧，否则两行一模一样无法分辨 */
const duplicatedSkillNames = computed(() => findDuplicateSkillNames(skills.value));

/** 技能选项展示名：重名时追加「 · <id>」 */
const skillOptionLabel = (skill: SkillRecord): string =>
  duplicatedSkillNames.value.has(skill.name) ? `${skill.name} · ${skill.id}` : skill.name;

// ──── Python 环境可用性（python 工具组门控；状态源 chrome.storage，跨上下文实时） ────

const pythonEnv = ref<PyodideEnvState | null>(null);
const pythonReady = computed(() => pythonEnv.value?.status === 'ready');
const unsubscribePythonEnv = watchPyodideEnv(state => {
  pythonEnv.value = state;
});
onMounted(async () => {
  pythonEnv.value = await getPyodideEnvState();
});
onUnmounted(() => unsubscribePythonEnv());

/** 工具组是否被锁（当前仅 python 组：环境未下载或未通过核验时不可勾选） */
function isGroupLocked(groupId: ToolScenario): boolean {
  return groupId === 'python' && !pythonReady.value;
}

/** 勾选/取消关联技能（上限内自由切换；取消不受限） */
function toggleSkill(skillId: string): void {
  const index = form.skills.indexOf(skillId);
  if (index === -1) {
    if (form.skills.length >= AGENT_SKILLS_MAX_COUNT) return;
    form.skills.push(skillId);
  } else {
    form.skills.splice(index, 1);
  }
}

// ──── 编辑态 ────

const editing = ref(false);
const editingExisting = ref(false);
/** 正在编辑的原始配置（重命名时删除旧键）；null = 新建 */
const editingSource = ref<AgentConfig | null>(null);
const errorMessage = ref('');
/** 勾选新组导致工具总数超限时的提示（变更成功后复位） */
const showLimitHint = ref(false);

const form = reactive({
  name: '',
  description: '',
  system: '',
  /** 分类：内置分类 id / CATEGORY_CUSTOM_VALUE（自定义创建态） / ''（未分类） */
  category: '',
  /** 分类选择为「自定义创建」时的新分类名称（保存前经 normalizeCategory 归一化） */
  customCategory: '',
  tags: [] as string[],
  groups: [] as ToolScenario[],
  /** 不属于任何所选工具组的既有工具（保存时原样保留） */
  extraToolIds: [] as string[],
  /** 关联技能 id 列表（可用清单的显式通道；映射兜底通道无需配置） */
  skills: [] as string[],
  /** 头像（图片或 emoji）；未选择时为 undefined，由 UI 回退默认 emoji */
  avatar: undefined as AgentConfig['avatar'],
  /** emoji 头像输入框的原始文本（与 form.avatar 同步，便于编辑与清空） */
  avatarEmoji: '',
  visionEnabled: false,
  screenshotTool: 'screenshot' as const,
  reScreenshotAfterTools: true,
});

/** 内置头像图片清单（供选择器展示；与预置智能体共用同一批资源） */
const builtinAvatars = BUILTIN_AGENT_AVATARS;

/** 选中内置头像图片：清空 emoji 输入，两种形态互斥（头像只有一种形态） */
function selectBuiltinAvatar(src: string): void {
  form.avatar = { type: 'image', src };
  form.avatarEmoji = '';
}

/** 某个内置头像是否为当前选中的图片形态（供选项高亮判断） */
function isBuiltinAvatarSelected(src: string): boolean {
  return form.avatar?.type === 'image' && form.avatar.src === src;
}

/** emoji 输入变化时同步头像形态：图片形态被 emoji 取代 */
function syncAvatarFromEmoji(): void {
  const value = form.avatarEmoji.trim();
  if (!value) {
    // 输入被清空 → 无头像（UI 回退默认 emoji），不保留此前的图片
    form.avatar = undefined;
    return;
  }
  const normalized = normalizeAvatar({ type: 'emoji', value });
  form.avatar = normalized ?? { type: 'emoji', value };
}

const extraTools = computed(() => form.extraToolIds);

/** 当前已选工具总数（所选组工具并集 + 额外保留工具，去重计数） */
const selectedToolCount = computed(() => {
  const union = new Set<string>(form.extraToolIds);
  for (const groupId of form.groups) {
    for (const toolId of groupToolSets.get(groupId) ?? []) union.add(toolId);
  }
  return union.size;
});

/** 表单最终生效的分类 id（自定义创建态经归一化；空串 = 未分类） */
const resolvedCategory = computed(() =>
  form.category === CATEGORY_CUSTOM_VALUE ? normalizeCategory(form.customCategory) : form.category,
);

const isValid = computed(
  () =>
    form.name.trim().length > 0 &&
    form.description.trim().length > 0 &&
    form.system.trim().length > 0 &&
    form.groups.length > 0 &&
    // 自定义分类必须填写名称，否则保存后会出现「选了自定义却落回未分类」的错觉
    (form.category !== CATEGORY_CUSTOM_VALUE || resolvedCategory.value.length > 0),
);

// ──── 保存前校验与必填高亮 ────
// 交互约定：保存按钮常可点击；点击后 attempted 置位，未填的必填项
// 立即高亮（红框 + 红底）并滚动到首个问题项，随填写自动消除

/** 是否已尝试保存（此后未填的必填项开始高亮，直到补全） */
const attempted = ref(false);

const nameInvalid = computed(() => attempted.value && !form.name.trim());
const descriptionInvalid = computed(() => attempted.value && !form.description.trim());
const systemInvalid = computed(() => attempted.value && !form.system.trim());
const groupsInvalid = computed(() => attempted.value && form.groups.length === 0);
const customCategoryInvalid = computed(
  () => attempted.value && form.category === CATEGORY_CUSTOM_VALUE && resolvedCategory.value.length === 0,
);

/** 由工具列表反推勾选组：组工具全部被包含且确有交集；未覆盖工具进入 extra */
function deriveGroupsFromTools(tools: readonly string[]): { groups: ToolScenario[]; extra: string[] } {
  const owned = new Set(tools);
  const groups: ToolScenario[] = [];
  for (const [groupId, groupTools] of groupToolSets) {
    const overlap = groupTools.some(tool => owned.has(tool));
    const covered = groupTools.every(tool => owned.has(tool));
    if (overlap && covered) groups.push(groupId as ToolScenario);
  }
  const coveredByGroups = new Set(groups.flatMap(g => [...(groupToolSets.get(g) ?? [])]));
  const extra = tools.filter(tool => !coveredByGroups.has(tool));
  return { groups, extra };
}

// ──── 标签编辑（chips 交互与上限反馈见 components/TagInput） ────

function resetForm(): void {
  form.name = '';
  form.description = '';
  form.system = '';
  form.category = '';
  form.customCategory = '';
  form.tags = [];
  form.groups = [];
  form.extraToolIds = [];
  form.skills = [];
  form.avatar = undefined;
  form.avatarEmoji = '';
  form.visionEnabled = false;
  form.screenshotTool = 'screenshot';
  form.reScreenshotAfterTools = true;
  errorMessage.value = '';
  showLimitHint.value = false;
  attempted.value = false;
}

function startCreate(): void {
  editingSource.value = null;
  editingExisting.value = false;
  resetForm();
  editing.value = true;
}

function startEdit(agent: AgentConfig): void {
  if (isPresetAgent(agent.id)) return; // 预置不可编辑（防御）
  editingSource.value = agent;
  editingExisting.value = true;
  const { groups, extra } = deriveGroupsFromTools(agent.tools);
  form.name = agent.name;
  form.description = agent.description;
  form.system = agent.system;
  form.tags = [...agent.tags];
  form.groups = groups;
  form.extraToolIds = extra;
  // 关联技能引用 → id 归一：v1 数据可能以名称 / 模型标识持久化，编辑时统一经
  // resolveSkill（与运行时可用性解析同口径）转为当前记录 id，保证「勾选可见的」
  // 与「保存后生效的」完全一致，消除不可见关联的歧义；解析不到的悬挂引用
  // 丢弃并告警（运行时本就会静默忽略它们，显式丢弃让编辑器所见即所得）
  form.skills = [...(agent.skills ?? [])].reduce<string[]>((ids, ref) => {
    const resolved = resolveSkill(ref);
    if (!resolved) {
      console.warn(`[AgentManager] 智能体 "${agent.name}" 关联的技能引用 "${ref}" 无法解析，已从编辑表单剔除`);
      return ids;
    }
    if (!ids.includes(resolved.id)) ids.push(resolved.id);
    return ids;
  }, []);
  form.visionEnabled = !!agent.vision;
  form.screenshotTool = agent.vision?.screenshotTool ?? 'screenshot';
  form.reScreenshotAfterTools = agent.vision?.reScreenshotAfterTools ?? true;
  // 头像回填：图片形态保留原地址，emoji 形态回填输入框文本（两种形态互斥）
  form.avatar = agent.avatar;
  form.avatarEmoji = agent.avatar?.type === 'emoji' ? agent.avatar.value : '';
  // 非内置分类（历史自定义分类）归入「自定义创建」态并回填名称，
  // 让选择器显示原分类名而不是空白项
  const category = agent.category || '';
  if (!category || isBuiltinCategory(category)) {
    form.category = category;
    form.customCategory = '';
  } else {
    form.category = CATEGORY_CUSTOM_VALUE;
    form.customCategory = category;
  }
  errorMessage.value = '';
  showLimitHint.value = false;
  editing.value = true;
}

function cancelEdit(): void {
  editing.value = false;
  editingSource.value = null;
  resetForm();
}

/** 勾选/取消工具组；勾选前校验并集工具数不超过上限（取消不受限）；锁定的组不可操作 */
function toggleGroup(groupId: ToolScenario): void {
  if (isGroupLocked(groupId)) return;
  const index = form.groups.indexOf(groupId);
  if (index === -1) {
    const union = new Set<string>(form.extraToolIds);
    for (const id of form.groups) {
      for (const toolId of groupToolSets.get(id) ?? []) union.add(toolId);
    }
    for (const toolId of groupToolSets.get(groupId) ?? []) union.add(toolId);
    if (union.size > MAX_TOOLS_PER_AGENT) {
      showLimitHint.value = true;
      return;
    }
    showLimitHint.value = false;
    form.groups.push(groupId);
  } else {
    showLimitHint.value = false;
    form.groups.splice(index, 1);
  }
}

function removeAgent(agent: AgentConfig): void {
  if (isPresetAgent(agent.id)) return;
  if (!window.confirm(t('hub.confirmDeleteAgent', { name: agent.name }))) return;
  const result = removeAgentConfig(agent.name);
  if (!result.ok) errorMessage.value = writeErrorText(result);
}

/** 写入失败原因 → 可读文案（区分原因而非一律「保存失败」，便于用户对症处理） */
function writeErrorText(result: Extract<AgentWriteResult, { ok: false }>): string {
  switch (result.reason) {
    case 'name-exists':
      return t('hub.errorNameExists');
    case 'preset-name':
      return t('hub.errorNamePreset');
    case 'preset-id':
      return t('hub.errorPresetId');
    case 'preset-delete':
      return t('hub.errorPresetDelete');
    case 'not-found':
      return t('hub.errorNotFound');
    default:
      return t('hub.errorInvalidAgent');
  }
}

function save(): void {
  // 保存前校验：未通过 → 高亮全部未填的必填项、给出提示并滚动到首个问题项，
  // 不进入写入流程（补全后高亮随计算属性自动消除）
  attempted.value = true;
  if (!isValid.value) {
    errorMessage.value = t('hub.errorRequiredFields');
    void nextTick(() => {
      document
        .querySelector('.hub-field.is-invalid, .hub-groups-scroll.is-invalid')
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return;
  }
  const name = form.name.trim();

  // 组工具合并（保序去重）+ 额外工具保留
  const toolIdSet = new Set<string>();
  for (const groupId of form.groups) {
    for (const toolId of groupToolSets.get(groupId) ?? []) toolIdSet.add(toolId);
  }
  for (const toolId of form.extraToolIds) toolIdSet.add(toolId);

  // ID 生命周期：新建时由名称生成唯一 ASCII slug；编辑时恒等保留原 ID。
  // ID 被会话元信息（agentId）等处引用，改名不应让既有引用失配
  const id = editingSource.value?.id ?? generateUniqueAgentId(name);

  // 头像：图片或 emoji（缺省 = 无头像，由 UI 回退默认 emoji）
  const avatar = normalizeAvatar(form.avatar);

  const config: AgentConfig = {
    id,
    name,
    description: form.description.trim(),
    system: form.system,
    tools: [...toolIdSet],
    skills: [...form.skills],
    category: resolvedCategory.value,
    tags: [...form.tags],
    ...(form.visionEnabled
      ? {
          vision: {
            screenshotTool: form.screenshotTool,
            screenshotArgs: {},
            reScreenshotAfterTools: form.reScreenshotAfterTools,
          },
        }
      : {}),
    ...(avatar ? { avatar } : {}),
  };

  // 名称冲突与重命名原子性均在存储层执行（单一事实源，UI 不再自建一套冲突判定）：
  // previousName 标识「正在编辑的旧键」，改名时旧键在本次写入的同一变更内移除
  const result = setAgentConfig(config, {
    previousName: editingSource.value?.name,
  });
  if (!result.ok) {
    errorMessage.value = writeErrorText(result);
    return;
  }
  cancelEdit();
}
</script>
