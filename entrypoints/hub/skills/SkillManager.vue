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
    <!-- 编辑视图：简单模式（表单字段）与高级模式（完整 SKILL.md）。
         两种模式都走填满态（is-fill）：编辑器吃满内容卡剩余高度——
         简单模式下右列「提示词（技能正文）」占满窗口剩余空间，不留底部空白 -->
    <form v-else ref="editorRef" class="hub-editor is-fill" :inert="saving" :aria-busy="saving" @submit.prevent="save">
      <div class="hub-editor-head">
        <div class="hub-editor-head-main">
          <h2>{{ editingExisting ? t('hub.editSkill') : t('hub.newSkill') }}</h2>
          <p class="hub-editor-mode-hint">{{ editorMode === 'simple' ? t('hub.modeSimpleHint') : t('hub.modeAdvancedHint') }}</p>
        </div>
        <div class="hub-editor-head-actions">
          <!-- 模式切换（带确认语义：切换会把当前内容转换为目标形态） -->
          <HubSegmented
            :model-value="editorMode"
            :options="modeOptions"
            :aria-label="t('hub.modeSimple')"
            @update:model-value="onModeChange"
          />
          <!-- 头部动作区：返回列表 / 取消 / 保存（取消与保存在返回列表右侧） -->
          <button type="button" class="hub-btn" :disabled="saving" @click="cancelEdit">{{ t('hub.backToList') }}</button>
          <button type="button" class="hub-btn" :disabled="saving" @click="cancelEdit">{{ t('common.cancel') }}</button>
          <button type="submit" class="hub-btn hub-btn-primary" :disabled="!canSave || saving">{{ t('common.save') }}</button>
        </div>
      </div>

      <!-- 网站学习成果确认卡（预填后内联展示；确认→直接保存，微调→关卡留在表单） -->
      <SkillDraftConfirm
        v-if="draftCard"
        :draft="draftCard.draft"
        :final-name="draftCard.finalName"
        @confirm="confirmDraftCreate"
        @edit="draftCard = null"
      />

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

        <!-- 高级模式：VS Code 式双栏——左侧文件树（入口置顶 + 目录分组），右侧当前文件编辑器 -->
        <template v-else>
          <!-- 左：文件树 -->
          <aside class="hub-tree" :aria-label="t('hub.treeHeader')">
            <div
              class="hub-tree-head"
              :class="{ 'is-drop-root': dropTarget?.kind === 'root' }"
              :title="t('hub.treeDragHint')"
              @dragover.prevent="onDragOverRoot"
              @drop.prevent="onDropToRoot"
              @dragleave="onDragLeaveTarget"
            >
              <span class="hub-tree-title">{{ t('hub.treeHeader') }}</span>
              <span class="hub-tree-count">{{ resourceFileCount + 1 }}</span>
              <span v-if="dropTarget?.kind === 'root'" class="hub-tree-drop-hint">{{ t('hub.treeDropRoot') }}</span>
              <!-- 新建文件 / 新建文件夹：两个独立入口（VS Code 资源管理器同款） -->
              <button
                type="button"
                class="hub-icon-btn hub-tree-add"
                :title="t('hub.treeNewFileTitle')"
                :aria-label="t('hub.treeNewFileTitle')"
                @click="beginCreateFile"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3.8 2.4h4.4l2.6 2.6v5.2H3.8z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                  <path d="M11.6 10.4v3.4M9.9 12.1h3.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                </svg>
              </button>
              <button
                type="button"
                class="hub-icon-btn hub-tree-add"
                :title="t('hub.treeNewFolderTitle')"
                :aria-label="t('hub.treeNewFolderTitle')"
                @click="beginCreateFolder"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M2.2 4.3h3.5l1.2 1.4h6.3v6H2.2z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                  <path d="M11.8 10.4v3.4M10.1 12.1h3.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                </svg>
              </button>
            </div>

            <div
              class="hub-tree-body"
              @dragover.prevent="onDragOverTreeBody"
              @drop.prevent="onDropToRoot"
              @dragleave="onDragLeaveTarget"
            >
              <!-- 入口文件（置顶；路径固定，由主编辑语义承载，不可删改、不可拖动） -->
              <div class="hub-tree-item">
                <button
                  type="button"
                  class="hub-tree-row is-entry"
                  :class="{ 'is-active': selectedIsEntry }"
                  @click="selectFile('SKILL.md')"
                  @contextmenu.prevent
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" class="hub-tree-file-icon">
                    <path d="M5 2.6h6v10.8l-3-2.2-3 2.2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
                  </svg>
                  <span class="hub-tree-name">SKILL.md</span>
                  <span v-if="isFileDirty('SKILL.md')" class="hub-tree-dirty" :title="t('hub.treeDirty')" />
                  <span class="hub-tree-badge">{{ t('hub.treeEntryBadge') }}</span>
                </button>
              </div>

              <!-- 树行：目录 / 文件 / 内联输入行（新建文件 / 新建文件夹 / 重命名） -->
              <template v-for="row in treeRows" :key="row.key">
                <!-- 内联输入行 -->
                <div v-if="row.kind === 'input-file' || row.kind === 'input-folder'" class="hub-tree-input-row" :style="{ '--depth': row.depth }">
                  <svg v-if="row.kind === 'input-folder'" viewBox="0 0 16 16" aria-hidden="true" class="hub-tree-file-icon">
                    <path d="M2.4 4.3h3.6l1.2 1.4h6.4v5.9H2.4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                  </svg>
                  <svg v-else viewBox="0 0 16 16" aria-hidden="true" class="hub-tree-file-icon">
                    <path d="M4.2 2.2h5l2.8 2.8v8.8H4.2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
                  </svg>
                  <span v-if="row.inputMode === 'create' && targetFolder" class="hub-tree-input-prefix">{{ targetFolder }}/</span>
                  <input
                    :ref="setTreeInputEl"
                    v-model="treeInputValue"
                    type="text"
                    maxlength="200"
                    :placeholder="
                      row.kind === 'input-folder'
                        ? t('hub.treeNewFolderPlaceholder')
                        : row.inputMode === 'create'
                          ? t('hub.treeNewFileNamePlaceholder')
                          : t('hub.treeRename')
                    "
                    spellcheck="false"
                    @keydown.enter.prevent="commitTreeInput"
                    @keydown.esc.stop="cancelTreeInput"
                  />
                  <button
                    type="button"
                    class="hub-icon-btn"
                    :title="row.inputMode === 'create' ? t('hub.treeCreate') : t('hub.treeRenameApply')"
                    @click="commitTreeInput"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.6 8.4l2.8 2.8 6-6.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
                  </button>
                  <button type="button" class="hub-icon-btn" :title="t('common.cancel')" @click="cancelTreeInput">
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
                  </button>
                </div>

                <!-- 目录行（折叠 / 展开；把文件拖到目录行即可移入该目录） -->
                <button
                  v-else-if="row.kind === 'folder'"
                  type="button"
                  class="hub-tree-row is-folder"
                  :style="{ '--depth': row.depth }"
                  :class="{ 'is-drop-target': dropTarget?.kind === 'folder' && dropTarget.path === row.folderPath }"
                  :aria-expanded="!collapsedFolders.has(row.folderPath ?? '')"
                  draggable="true"
                  @click="selectFolder(row.folderPath ?? '')"
                  @contextmenu.prevent.stop="openContextMenu($event, 'folder', row.folderPath ?? '')"
                  @dragstart="onDragStart($event, row.folderPath ?? '')"
                  @dragend="onDragEnd"
                  @dragover.prevent.stop="onDragOverFolder(row.folderPath ?? '')"
                  @drop.prevent.stop="onDropIntoFolder(row.folderPath ?? '')"
                  @dragleave="onDragLeaveTarget"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" class="hub-tree-chevron" :class="{ 'is-collapsed': collapsedFolders.has(row.folderPath ?? '') }">
                    <path d="M6.2 4.2L10 8l-3.8 3.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                  <svg viewBox="0 0 16 16" aria-hidden="true" class="hub-tree-file-icon">
                    <path d="M2.4 4.4h3.7l1.3 1.5h6.2a1 1 0 0 1 1 1v4.9a1 1 0 0 1-1 1H2.4a1 1 0 0 1-1-1V5.4a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                  </svg>
                  <span class="hub-tree-name">{{ row.label }}</span>
                </button>

                <!-- 文件行（可拖拽：拖到目录 = 移入，拖到文件 = 插到其前，拖到树头 = 移回根目录） -->
                <div
                  v-else
                  class="hub-tree-item"
                  :style="{ '--depth': row.depth }"
                  :class="{ 'is-drop-before': dropTarget?.kind === 'file' && dropTarget.path === row.path }"
                >
                  <button
                    type="button"
                    class="hub-tree-row is-file"
                    :class="{ 'is-active': selectedFile === row.path, 'is-dragging': dragPath === row.path }"
                    :title="row.path"
                    draggable="true"
                    @click="selectFile(row.path ?? '')"
                    @contextmenu.prevent.stop="openContextMenu($event, 'file', row.path ?? '')"
                    @dragstart="onDragStart($event, row.path ?? '')"
                    @dragend="onDragEnd"
                    @dragover.prevent.stop="onDragOverFile(row.path ?? '')"
                    @drop.prevent.stop="onDropBeforeFile(row.path ?? '')"
                    @dragleave="onDragLeaveTarget"
                  >
                    <svg v-if="fileIconKind(row.label) === 'md'" viewBox="0 0 16 16" aria-hidden="true" class="hub-tree-file-icon">
                      <path d="M4.2 2.2h5l2.8 2.8v8.8H4.2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
                      <path d="M6.2 8.6h3.6M6.2 10.8h2.4" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
                    </svg>
                    <svg v-else-if="fileIconKind(row.label) === 'code'" viewBox="0 0 16 16" aria-hidden="true" class="hub-tree-file-icon">
                      <path d="M6.1 5.2L3.4 8l2.7 2.8M9.9 5.2L12.6 8l-2.7 2.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                    <svg v-else viewBox="0 0 16 16" aria-hidden="true" class="hub-tree-file-icon">
                      <path d="M4.2 2.2h5l2.8 2.8v8.8H4.2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
                    </svg>
                    <span class="hub-tree-name">{{ row.label }}</span>
                    <span v-if="isFileDirty(row.path ?? '')" class="hub-tree-dirty" :title="t('hub.treeDirty')" />
                  </button>
                  <span class="hub-tree-ops">
                    <button type="button" class="hub-icon-btn" :title="t('hub.treeRename')" :aria-label="t('hub.treeRename')" @click.stop="beginRenameFile(row.path ?? '')">
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 12l.6-2.4 6.2-6.2 1.8 1.8-6.2 6.2zM9.8 4.4l1.8 1.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /></svg>
                    </button>
                    <button type="button" class="hub-icon-btn hub-icon-btn--danger" :title="t('hub.delete')" :aria-label="t('hub.delete')" @click.stop="removeResourceFile(row.path ?? '')">
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 5h8M6.5 5V3.8h3V5M5.4 5l.5 7.2h4.2l.5-7.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>
                    </button>
                  </span>
                </div>
              </template>

              <p v-if="treeError" class="hub-tree-error" role="alert">{{ treeError }}</p>
              <p v-if="resourceFileCount === 0 && resourceFolders.length === 0 && !treeInput" class="hub-tree-empty">{{ t('hub.resourceFilesEmpty') }}</p>
            </div>
          </aside>

          <!-- 右：当前文件编辑器 -->
          <div class="hub-code">
            <div class="hub-code-head">
              <svg v-if="selectedIsEntry" viewBox="0 0 16 16" aria-hidden="true" class="hub-tree-file-icon">
                <path d="M5 2.6h6v10.8l-3-2.2-3 2.2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
              </svg>
              <svg v-else viewBox="0 0 16 16" aria-hidden="true" class="hub-tree-file-icon">
                <path d="M4.2 2.2h5l2.8 2.8v8.8H4.2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
                <path d="M6.2 8.6h3.6M6.2 10.8h2.4" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" />
              </svg>
              <span class="hub-code-path" :title="selectedFile">{{ selectedFile }}</span>
              <span v-if="isFileDirty(selectedFile)" class="hub-tree-dirty" :title="t('hub.treeDirty')" />
              <span class="hub-code-meta">{{ t('hub.resourceFileChars', { count: selectedIsEntry ? form.raw.length : selectedResourceText.length }) }}</span>
              <button
                v-if="!selectedIsEntry"
                type="button"
                class="hub-icon-btn hub-icon-btn--danger"
                :title="t('hub.delete')"
                :aria-label="t('hub.delete')"
                @click="removeResourceFile(selectedFile)"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 5h8M6.5 5V3.8h3V5M5.4 5l.5 7.2h4.2l.5-7.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>
              </button>
            </div>

            <textarea
              v-if="selectedIsEntry"
              v-model="form.raw"
              class="hub-code-input"
              :placeholder="t('hub.fieldRawSkillMdPlaceholder')"
              spellcheck="false"
            ></textarea>
            <textarea
              v-else
              v-model="selectedResourceText"
              class="hub-code-input"
              :placeholder="t('hub.treeFilePlaceholder')"
              spellcheck="false"
            ></textarea>
          </div>

          <!-- 状态条（通栏，位于文件树与文件编辑器下方）：入口文件 = 实时校验；资源文件 = 环境与读取说明 -->
          <div
            class="hub-editor-status"
            :class="selectedIsEntry ? (rawValidation.ok ? 'is-ok' : 'is-error') : ''"
          >
            <div
              v-if="selectedIsEntry"
              class="hub-validation"
              :class="rawValidation.ok ? 'is-ok' : 'is-error'"
              role="status"
              aria-live="polite"
            >
              <!-- 折叠态：只报问题数量（点击标题展开明细） -->
              <button
                type="button"
                class="hub-validation-head"
                :aria-expanded="validationExpanded"
                :title="validationExpanded ? t('hub.validationCollapse') : t('hub.validationExpand')"
                @click="validationExpanded = !validationExpanded"
              >
                <svg v-if="rawValidation.ok" viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
                  <path d="M5.2 8.3l1.9 1.9 3.7-4.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <svg v-else viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
                  <path d="M8 4.6v4.2M8 11.2v.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                </svg>
                <span>{{ t('hub.validationTitle') }}</span>
                <span v-if="!rawValidation.ok" class="hub-validation-count">{{ t('hub.validationIssueCount', { count: rawIssues.length }) }}</span>
                <span v-else class="hub-validation-ok-badge">{{ t('hub.validationOkBadge') }}</span>
                <svg class="hub-validation-chevron" :class="{ 'is-open': validationExpanded }" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4.5 6.2L8 9.8l3.5-3.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <!-- 展开态：逐条问题明细 -->
              <div v-if="validationExpanded" class="hub-validation-body">
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
            </div>
            <p v-else class="hub-code-note">{{ t('hub.resourceFilesHint') }}</p>
          </div>
        </template>
      </div>

      <div class="hub-editor-footer">
        <span v-if="errorMessage" class="hub-error">{{ errorMessage }}</span>
        <span v-else-if="advancedBlockHint" class="hub-hint">{{ advancedBlockHint }}</span>
      </div>

      <!-- 右键菜单卡片（文件树自定义菜单：新建 / 副本 / 重命名 / 复制路径 / 删除） -->
      <div
        v-if="contextMenu"
        ref="contextMenuEl"
        class="hub-menu"
        role="menu"
        :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      >
        <template v-if="contextMenu.kind === 'file'">
          <button type="button" class="hub-menu-item" @click="menuNewFileIn(parentFolderOf(contextMenu.path))">{{ t('hub.treeNewFileIn') }}</button>
          <button type="button" class="hub-menu-item" @click="menuDuplicateFile(contextMenu.path)">{{ t('hub.treeDuplicate') }}</button>
          <button type="button" class="hub-menu-item" @click="menuRenameFile(contextMenu.path)">{{ t('hub.treeRename') }}</button>
          <button type="button" class="hub-menu-item" @click="menuCopyPath(contextMenu.path)">{{ t('hub.treeCopyPath') }}</button>
          <div class="hub-menu-separator" role="separator"></div>
          <button type="button" class="hub-menu-item is-danger" @click="menuDeleteFile(contextMenu.path)">{{ t('hub.delete') }}</button>
        </template>
        <template v-else>
          <button type="button" class="hub-menu-item" @click="menuNewFileIn(contextMenu.path)">{{ t('hub.treeNewFileIn') }}</button>
          <button type="button" class="hub-menu-item" @click="menuNewFolderIn(contextMenu.path)">{{ t('hub.treeNewFolderIn') }}</button>
          <button type="button" class="hub-menu-item" @click="menuRenameFolder(contextMenu.path)">{{ t('hub.treeRenameFolder') }}</button>
          <button type="button" class="hub-menu-item" @click="menuCopyPath(contextMenu.path)">{{ t('hub.treeCopyPath') }}</button>
          <div class="hub-menu-separator" role="separator"></div>
          <button type="button" class="hub-menu-item is-danger" @click="menuDeleteFolder(contextMenu.path)">{{ t('hub.treeDeleteFolder') }}</button>
        </template>
      </div>
    </form>
  </section>
</template>

<script setup lang="ts">
/**
 * 技能管理：全量启停（含预置，跨上下文同步）+ 自定义技能的新建/编辑/删除
 * + zip / md 导入导出。
 *
 * 编辑器双模式（模式经 HubSegmented 分段控件切换）：
 *   - 简单模式：左列 name / description / category / tags，右列提示词正文；
 *     保存时自动组装规范 SKILL.md（其余 frontmatter 字段在编辑既有技能时
 *     原样保留），百分百可正确创建；分类必选，与智能体共用同一套分类/标签规范；
 *     资源文件不进入表单、保存时原样携带（数据结构保证绝不丢文件）。
 *   - 高级模式：VS Code 式双栏——左侧文件树（SKILL.md 入口置顶 + 目录分组、
 *     新建 / 重命名 / 删除 / 折叠、脏标记圆点），右侧当前文件编辑器
 *     （字数与脏态页头 + 等宽编辑区 + 状态条：入口文件挂实时校验面板，
 *     资源文件挂环境与读取说明）。编辑直接绑定内存文件表，主保存统一落库；
 *     新建/重命名的半敲输入不落库（保存被阻止直至收笔），配额上限持续校验。
 * 模式互切有内容转换：简单 → 高级按表单重组原文；高级 → 简单解析回填
 * （解析失败时阻止切换，避免半份内容静默丢失）。
 */
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
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
  normalizeFolderList,
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

// ──── 资源文件（文件夹式技能：SKILL.md 之外的文件树，VS Code 式编辑） ────

/**
 * 资源文件表：相对路径 → 内容。与 SKILL.md 正文（form.raw）分离承载，
 * 简单 / 高级模式切换、保存、草稿预填都不触碰它——「简单模式保存绝不丢文件」
 * 这条防线由数据结构保证，而不是靠流程小心。
 */
const resourceFiles = ref<Record<string, string>>({});
const resourceFileCount = computed(() => Object.keys(resourceFiles.value).length);

/**
 * 显式目录（含空目录）：用户新建、尚未放入文件的目录。
 * 文件路径派生的目录不在此列（由 files 隐含）；空目录若无此字段支撑，
 * 保存后会随技能消失——故作为一等状态随记录持久化。
 */
const resourceFolders = ref<string[]>([]);

/** 高级模式当前打开的文件：'SKILL.md' = 入口原文，否则为资源文件相对路径 */
const selectedFile = ref('SKILL.md');
const selectedIsEntry = computed(() => selectedFile.value === 'SKILL.md');

/** 当前打开的资源文件内容（双向绑定；入口文件走 form.raw，不经此通道） */
const selectedResourceText = computed<string>({
  get: () => {
    const path = selectedFile.value;
    return path !== 'SKILL.md' ? (resourceFiles.value[path] ?? '') : '';
  },
  set: value => {
    const path = selectedFile.value;
    if (path !== 'SKILL.md' && resourceFiles.value[path] !== undefined) {
      resourceFiles.value[path] = value;
    }
  },
});

/**
 * 文件树内联输入态：新建文件 / 新建文件夹 / 重命名（文件或目录）。
 * 全树同时只允许一个输入行（VS Code 同款），半敲的路径不是内容——
 * 不进编辑器快照，主保存期间视为未收笔。
 */
interface TreeInputState {
  /** 输入的是文件还是目录 */
  kind: 'file' | 'folder';
  /** 新建还是重命名 */
  mode: 'create' | 'rename';
  /** 重命名目标（文件路径或目录路径）；新建时为空 */
  target?: string;
}
const treeInput = ref<TreeInputState | null>(null);
const treeInputValue = ref('');
/** 新建项落在哪个目录（'' = 根目录）；点击目录 / 文件行会更新 */
const targetFolder = ref('');
/** 树内输入的就地错误提示（路径非法 / 重复 / 超限） */
const treeError = ref('');
const treeInputActive = computed(() => treeInput.value !== null);

/** 折叠目录集合（不可变替换保证响应性） */
const collapsedFolders = ref<Set<string>>(new Set());

/** 实时校验面板展开态（默认收起，只显示问题数量） */
const validationExpanded = ref(false);

const treeInputEl = ref<HTMLElement | null>(null);
/** 内联输入行的动态 ref（v-for 内无法用静态 ref 收集；只记元素、不置空，避免重渲染竞态） */
function setTreeInputEl(el: unknown): void {
  if (el instanceof HTMLElement) treeInputEl.value = el;
}
function focusElement(el: HTMLElement | null): void {
  try {
    el?.focus();
  } catch {
    /* JSDOM 等宿主无 focus 实现时静默（聚焦是纯增强，不影响功能） */
  }
}

/**
 * 文件树展示行（扁平化 + 缩进深度；折叠目录的子行不产出）
 *
 * 顺序 = 用户编排顺序：目录按首次出现排序，文件按插入顺序排列，
 * 不做字母排序——拖拽调整位置后必须肉眼可见地留在新位置（与 VS Code
 * 手动拖拽排序的直觉一致）。
 */
interface TreeRow {
  key: string;
  /** folder = 目录行；file = 文件行；input-file / input-folder = 内联输入行 */
  kind: 'folder' | 'file' | 'input-file' | 'input-folder';
  label: string;
  depth: number;
  /** 文件行：完整相对路径 */
  path?: string;
  /** 目录行：目录前缀路径 */
  folderPath?: string;
  /** 输入行：新建还是重命名 */
  inputMode?: 'create' | 'rename';
}

const treeRows = computed<TreeRow[]>(() => {
  interface FolderNode {
    folders: Map<string, FolderNode>;
    files: string[];
  }
  const root: FolderNode = { folders: new Map(), files: [] };
  const ensureFolder = (folderPath: string): FolderNode => {
    if (folderPath === '') return root;
    const parentPath = folderPath.includes('/') ? folderPath.slice(0, folderPath.lastIndexOf('/')) : '';
    const parent = ensureFolder(parentPath);
    let node = parent.folders.get(folderPath);
    if (!node) {
      node = { folders: new Map(), files: [] };
      parent.folders.set(folderPath, node);
    }
    return node;
  };
  // 显式目录（含空目录）先入树，随后由文件路径派生的目录 / 文件补齐
  for (const folderPath of resourceFolders.value) ensureFolder(folderPath);
  // 资源表按键的插入顺序遍历 → 目录与文件均保持用户编排顺序
  for (const path of Object.keys(resourceFiles.value)) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    ensureFolder(dir).files.push(path);
  }

  const rows: TreeRow[] = [];
  const input = treeInput.value;
  /**
   * 遍历产出展示行：
   *   - 新建输入行落在目标目录的首行（根目录即列表顶部，紧随 SKILL.md 之后）；
   *   - 重命名输入行替换被改名的文件 / 目录行（其子项暂不展示）；
   *   - 折叠目录不产出子行（新建目标目录会自动展开，否则输入行不可见）。
   */
  const walk = (node: FolderNode, depth: number, folderPath: string): void => {
    if (input && input.mode === 'create' && folderPath === targetFolder.value) {
      rows.push({
        key: 'i:create',
        kind: input.kind === 'folder' ? 'input-folder' : 'input-file',
        label: '',
        depth,
        inputMode: 'create',
      });
    }
    for (const [path, child] of node.folders) {
      const label = path.split('/').pop() ?? path;
      if (input && input.mode === 'rename' && input.kind === 'folder' && input.target === path) {
        rows.push({ key: `i:rename:${path}`, kind: 'input-folder', label: '', depth, folderPath: path, inputMode: 'rename' });
        continue;
      }
      rows.push({ key: `d:${path}`, kind: 'folder', label, depth, folderPath: path });
      if (!collapsedFolders.value.has(path) || path === targetFolder.value) walk(child, depth + 1, path);
    }
    for (const filePath of node.files) {
      const label = filePath.split('/').pop() ?? filePath;
      if (input && input.mode === 'rename' && input.kind === 'file' && input.target === filePath) {
        rows.push({ key: `i:rename:${filePath}`, kind: 'input-file', label: '', depth, path: filePath, inputMode: 'rename' });
        continue;
      }
      rows.push({ key: `f:${filePath}`, kind: 'file', label, depth, path: filePath });
    }
  };
  walk(root, 0, '');
  return rows;
});

/** 文件图标分型（纯展示；与工具层读取能力无关——一切按纯文本存储） */
function fileIconKind(name: string): 'md' | 'code' | 'file' {
  if (/\.(md|markdown|txt)$/i.test(name)) return 'md';
  if (/\.(py|sh|bash|js|mjs|cjs|ts|json|ya?ml|toml|csv|html|css|xml)$/i.test(name)) return 'code';
  return 'file';
}

/** 与持久层比对的单文件脏标记（新技能没有任何基准 → 一切非空皆未保存） */
function isFileDirty(path: string): boolean {
  const source = editingSource.value?.files ?? {};
  if (path === 'SKILL.md') return form.raw !== (source['SKILL.md'] ?? '');
  return (resourceFiles.value[path] ?? null) !== (source[path] ?? null);
}

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

/** 校验资源路径（originalPath 为重命名时的原路径，排除自比较） */
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

// ──── 文件树操作（新建 / 重命名 / 删除 / 副本 / 右键菜单；输入态防串扰） ────

function cancelTreeInput(): void {
  treeInput.value = null;
  treeInputValue.value = '';
  treeError.value = '';
}

/** 路径的父目录（根级文件返回空串） */
function parentFolderOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

/** 切换选中文件：先收笔（半敲输入不该跟着切走），保证任意时刻只有一个焦点流 */
function selectFile(path: string): void {
  cancelTreeInput();
  selectedFile.value = path;
  // 新建项的落点跟随选中文件所在的目录（VS Code 同款）
  targetFolder.value = path === 'SKILL.md' ? '' : parentFolderOf(path);
}

/** 选中目录：同时把它设为新建项的落点，并折叠 / 展开（VS Code 同款单击行为） */
function selectFolder(folderPath: string): void {
  cancelTreeInput();
  targetFolder.value = folderPath;
  toggleFolder(folderPath);
}

/** 展开目录（新建输入行落在折叠目录里时不可见，必须先展开） */
function expandFolder(folderPath: string): void {
  if (!folderPath || !collapsedFolders.value.has(folderPath)) return;
  const next = new Set(collapsedFolders.value);
  next.delete(folderPath);
  collapsedFolders.value = next;
}

/** 新建文件：输入行落在目标目录内（可再带子路径，如 steps/plan.md） */
function beginCreateFile(): void {
  cancelTreeInput();
  treeInput.value = { kind: 'file', mode: 'create' };
  treeInputValue.value = '';
  expandFolder(targetFolder.value);
  void nextTick(() => focusElement(treeInputEl.value));
}

/** 新建文件夹：输入行落在目标目录内 */
function beginCreateFolder(): void {
  cancelTreeInput();
  treeInput.value = { kind: 'folder', mode: 'create' };
  treeInputValue.value = '';
  expandFolder(targetFolder.value);
  void nextTick(() => focusElement(treeInputEl.value));
}

/** 重命名文件（输入框只带文件名；输入含 / 时按根目录相对路径处理） */
function beginRenameFile(path: string): void {
  if (resourceFiles.value[path] === undefined) return;
  cancelTreeInput();
  treeInput.value = { kind: 'file', mode: 'rename', target: path };
  treeInputValue.value = path.slice(path.lastIndexOf('/') + 1);
  void nextTick(() => focusElement(treeInputEl.value));
}

/** 重命名文件夹（改名 = 目录内所有文件随前缀迁移） */
function beginRenameFolder(folderPath: string): void {
  cancelTreeInput();
  treeInput.value = { kind: 'folder', mode: 'rename', target: folderPath };
  treeInputValue.value = folderPath.slice(folderPath.lastIndexOf('/') + 1);
  void nextTick(() => focusElement(treeInputEl.value));
}

/** 内联输入提交：按「新建文件 / 新建文件夹 / 重命名文件 / 重命名文件夹」分发 */
function commitTreeInput(): void {
  const input = treeInput.value;
  if (!input) return;
  if (input.mode === 'create') {
    if (input.kind === 'file') commitCreateFile();
    else commitCreateFolder();
    return;
  }
  if (input.kind === 'file') commitRenameFile(input.target ?? '');
  else commitRenameFolder(input.target ?? '');
}

/** 新建文件：落点 = 目标目录 + 输入（输入可再带子目录） */
function commitCreateFile(): void {
  const raw = treeInputValue.value.trim();
  if (!raw) {
    cancelTreeInput();
    return;
  }
  const relative = normalizeResourcePath(raw);
  const path = targetFolder.value ? `${targetFolder.value}/${relative}` : relative;
  const pathError = validateResourcePath(path, null);
  if (pathError) {
    treeError.value = pathError;
    return;
  }
  // 文件数上限（含 SKILL.md；与导入同一套口径）
  if (Object.keys(resourceFiles.value).length + 1 + 1 > SKILL_IMPORT_MAX_FILES) {
    treeError.value = t('hub.resourceFileLimit', { max: SKILL_IMPORT_MAX_FILES });
    return;
  }
  resourceFiles.value = { ...resourceFiles.value, [path]: '' };
  cancelTreeInput();
  selectedFile.value = path;
}

/**
 * 校验目录路径：段级边界 + 长度 + 与既有目录重名。
 * 既有目录 = 显式目录 ∪ 文件路径派生的目录。
 */
function validateFolderPath(path: string, originalPath: string | null): string | null {
  if (
    !path ||
    path.startsWith('/') ||
    path.split('/').some(segment => segment === '' || segment === '.' || segment === '..') ||
    hasControlCharacter(path)
  ) {
    return t('hub.resourceFolderInvalidPath');
  }
  if (path.length > SKILL_PATH_MAX_CHARS) {
    return t('hub.resourceFolderInvalidPath');
  }
  const existing = existingFolderPaths();
  if (existing.has(path) && path !== originalPath) {
    return t('hub.resourceFolderDuplicate');
  }
  return null;
}

/** 现有目录集合：显式目录 ∪ 文件路径派生目录 */
function existingFolderPaths(): Set<string> {
  const folders = new Set<string>(resourceFolders.value);
  for (const path of Object.keys(resourceFiles.value)) {
    const dir = parentFolderOf(path);
    if (!dir) continue;
    // 逐级补齐（a/b/c.md → a、a/b）
    const segments = dir.split('/');
    for (let index = 1; index <= segments.length; index++) {
      folders.add(segments.slice(0, index).join('/'));
    }
  }
  return folders;
}

/** 新建文件夹：落点 = 目标目录 + 输入（输入可再带层级，如 assets/img） */
function commitCreateFolder(): void {
  const raw = treeInputValue.value.trim();
  if (!raw) {
    cancelTreeInput();
    return;
  }
  const relative = normalizeResourcePath(raw);
  const path = targetFolder.value ? `${targetFolder.value}/${relative}` : relative;
  const pathError = validateFolderPath(path, null);
  if (pathError) {
    treeError.value = pathError;
    return;
  }
  // 逐级补齐父目录（a/b → 同时建出 a）
  const segments = path.split('/');
  const created = [...resourceFolders.value];
  for (let index = 1; index <= segments.length; index++) {
    const folder = segments.slice(0, index).join('/');
    if (!created.includes(folder)) created.push(folder);
  }
  resourceFolders.value = created;
  cancelTreeInput();
  // 新目录成为当前落点，便于紧接着在其中新建文件
  targetFolder.value = path;
  expandFolder(parentFolderOf(path));
}

/** 重命名文件：保持原有顺序迁移；输入含 / 时按根目录相对路径处理 */
function commitRenameFile(from: string): void {
  const raw = treeInputValue.value.trim();
  if (!raw) {
    cancelTreeInput();
    return;
  }
  const normalized = normalizeResourcePath(raw);
  const to = normalized.includes('/')
    ? normalized
    : parentFolderOf(from)
      ? `${parentFolderOf(from)}/${normalized}`
      : normalized;
  if (to === from) {
    cancelTreeInput();
    return;
  }
  const pathError = validateResourcePath(to, from);
  if (pathError) {
    treeError.value = pathError;
    return;
  }
  const next: Record<string, string> = {};
  for (const [path, content] of Object.entries(resourceFiles.value)) {
    next[path === from ? to : path] = content;
  }
  resourceFiles.value = next;
  if (selectedFile.value === from) selectedFile.value = to;
  cancelTreeInput();
}

/** 重命名文件夹：目录内文件随前缀迁移，显式目录同步改名 */
function commitRenameFolder(from: string): void {
  const raw = treeInputValue.value.trim();
  if (!raw) {
    cancelTreeInput();
    return;
  }
  const normalized = normalizeResourcePath(raw);
  if (normalized.includes('/')) {
    // 目录改名只接受名称（跨层移动交给拖拽，避免「改名」语义含混）
    treeError.value = t('hub.resourceFolderInvalidPath');
    return;
  }
  const parent = parentFolderOf(from);
  const to = parent ? `${parent}/${normalized}` : normalized;
  if (to === from) {
    cancelTreeInput();
    return;
  }
  const pathError = validateFolderPath(to, from);
  if (pathError) {
    treeError.value = pathError;
    return;
  }
  const prefix = `${from}/`;
  const next: Record<string, string> = {};
  for (const [path, content] of Object.entries(resourceFiles.value)) {
    next[path.startsWith(prefix) ? `${to}${path.slice(from.length)}` : path] = content;
  }
  resourceFiles.value = next;
  resourceFolders.value = resourceFolders.value.map(folder =>
    folder === from
      ? to
      : folder.startsWith(prefix)
        ? `${to}${folder.slice(from.length)}`
        : folder,
  );
  if (selectedFile.value.startsWith(prefix)) {
    selectedFile.value = `${to}${selectedFile.value.slice(from.length)}`;
  }
  cancelTreeInput();
}

/** 删除资源文件（二次确认；选中态与输入态指向该文件时同步回退） */
function removeResourceFile(path: string): void {
  if (resourceFiles.value[path] === undefined) return;
  if (!window.confirm(t('hub.confirmDeleteResourceFile', { path }))) return;
  const next = { ...resourceFiles.value };
  delete next[path];
  resourceFiles.value = next;
  if (selectedFile.value === path) selectedFile.value = 'SKILL.md';
  if (treeInput.value?.mode === 'rename' && treeInput.value.target === path) cancelTreeInput();
}

/** 删除文件夹（二次确认；目录内文件与子目录一并删除） */
function removeResourceFolder(folderPath: string): void {
  const prefix = `${folderPath}/`;
  const files = Object.keys(resourceFiles.value).filter(path => path.startsWith(prefix));
  const folders = resourceFolders.value.filter(folder => folder === folderPath || folder.startsWith(prefix));
  if (!files.length && !folders.length) return;
  if (!window.confirm(t('hub.treeConfirmDeleteFolder', { path: folderPath, count: files.length }))) return;
  const next: Record<string, string> = {};
  for (const [path, content] of Object.entries(resourceFiles.value)) {
    if (!path.startsWith(prefix)) next[path] = content;
  }
  resourceFiles.value = next;
  resourceFolders.value = resourceFolders.value.filter(
    folder => folder !== folderPath && !folder.startsWith(prefix),
  );
  if (selectedFile.value.startsWith(prefix)) selectedFile.value = 'SKILL.md';
  if (treeInput.value?.mode === 'rename' && treeInput.value.target === folderPath) cancelTreeInput();
}

/**
 * 创建副本：在原文件之后插入一份同内容副本，文件名带 -copy 后缀
 * （已存在则递增为 -copy-2 / -copy-3…），副本直接打开。
 */
function duplicateResourceFile(path: string): void {
  const content = resourceFiles.value[path];
  if (content === undefined) return;
  if (Object.keys(resourceFiles.value).length + 1 + 1 > SKILL_IMPORT_MAX_FILES) {
    treeError.value = t('hub.resourceFileLimit', { max: SKILL_IMPORT_MAX_FILES });
    return;
  }
  const dir = parentFolderOf(path);
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let index = 1;
  let candidate = `${base}-copy${ext}`;
  while (true) {
    const full = dir ? `${dir}/${candidate}` : candidate;
    if (resourceFiles.value[full] === undefined && !resourceFolders.value.includes(full)) {
      const next: Record<string, string> = {};
      let inserted = false;
      for (const [existing, existingContent] of Object.entries(resourceFiles.value)) {
        next[existing] = existingContent;
        if (existing === path) {
          next[full] = content;
          inserted = true;
        }
      }
      if (!inserted) next[full] = content;
      resourceFiles.value = next;
      selectedFile.value = full;
      return;
    }
    index += 1;
    candidate = `${base}-copy-${index}${ext}`;
  }
}

/** 复制资源文件路径到剪贴板（失败静默——非关键路径不弹错） */
async function copyResourcePath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
  } catch {
    /* 剪贴板权限被拒等场景忽略 */
  }
}

function toggleFolder(folderPath: string): void {
  const next = new Set(collapsedFolders.value);
  if (next.has(folderPath)) next.delete(folderPath);
  else next.add(folderPath);
  collapsedFolders.value = next;
}

// ──── 文件树右键菜单（自定义小菜单卡片） ────

interface ContextMenuState {
  kind: 'file' | 'folder';
  /** 目标路径（文件路径或目录路径） */
  path: string;
  /** 相对编辑器左上角的位置（编辑器为定位祖先） */
  x: number;
  y: number;
}

const contextMenu = ref<ContextMenuState | null>(null);
const contextMenuEl = ref<HTMLElement | null>(null);
const editorRef = ref<HTMLElement | null>(null);

/** 右键打开菜单：定位到光标处，并夹紧在编辑器可视范围内 */
function openContextMenu(event: MouseEvent, kind: 'file' | 'folder', path: string): void {
  event.preventDefault();
  event.stopPropagation();
  const rect = editorRef.value?.getBoundingClientRect();
  contextMenu.value = {
    kind,
    path,
    x: event.clientX - (rect?.left ?? 0),
    y: event.clientY - (rect?.top ?? 0),
  };
  void nextTick(() => clampContextMenu());
}

/** 菜单贴边翻转：超出编辑器右 / 下边界时向内收 */
function clampContextMenu(): void {
  const menu = contextMenuEl.value;
  const editor = editorRef.value;
  const state = contextMenu.value;
  if (!menu || !editor || !state) return;
  const menuRect = menu.getBoundingClientRect();
  const editorRect = editor.getBoundingClientRect();
  const maxX = editorRect.width - menuRect.width - 8;
  const maxY = editorRect.height - menuRect.height - 8;
  contextMenu.value = {
    ...state,
    x: Math.max(8, Math.min(state.x, maxX)),
    y: Math.max(8, Math.min(state.y, maxY)),
  };
}

function closeContextMenu(): void {
  contextMenu.value = null;
}

/** 点击菜单外部 / Esc 时关闭菜单 */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!contextMenu.value) return;
  const target = event.target as Node | null;
  if (target && contextMenuEl.value?.contains(target)) return;
  closeContextMenu();
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown, true));
onUnmounted(() => document.removeEventListener('pointerdown', onDocumentPointerDown, true));

/** 菜单动作：在指定目录中新建文件 */
function menuNewFileIn(folderPath: string): void {
  closeContextMenu();
  targetFolder.value = folderPath;
  beginCreateFile();
}

/** 菜单动作：在指定目录中新建文件夹 */
function menuNewFolderIn(folderPath: string): void {
  closeContextMenu();
  targetFolder.value = folderPath;
  beginCreateFolder();
}

/** 菜单动作：重命名文件 */
function menuRenameFile(path: string): void {
  closeContextMenu();
  beginRenameFile(path);
}

/** 菜单动作：重命名文件夹 */
function menuRenameFolder(path: string): void {
  closeContextMenu();
  beginRenameFolder(path);
}

/** 菜单动作：复制路径 */
function menuCopyPath(path: string): void {
  closeContextMenu();
  void copyResourcePath(path);
}

/** 菜单动作：删除文件 */
function menuDeleteFile(path: string): void {
  closeContextMenu();
  removeResourceFile(path);
}

/** 菜单动作：删除文件夹 */
function menuDeleteFolder(path: string): void {
  closeContextMenu();
  removeResourceFolder(path);
}

/** 菜单动作：创建副本 */
function menuDuplicateFile(path: string): void {
  closeContextMenu();
  duplicateResourceFile(path);
}

// ──── 文件树拖放（移入目录 / 同级重排 / 移回根目录） ────

/** 正在拖动的资源文件路径（null = 当前没有拖拽） */
const dragPath = ref<string | null>(null);

/** 放置目标类型：目录（移入）/ 文件（插到它前面）/ 根目录（移回顶层） */
type DropTargetKind = 'folder' | 'file' | 'root';
interface DropTarget {
  kind: DropTargetKind;
  /** 目录路径或目标文件路径（根目录为空串） */
  path: string;
}

/** 当前放置目标（null = 未悬停在任何落点上） */
const dropTarget = ref<DropTarget | null>(null);

/** 开始拖动：入口文件不可拖动（路径固定，由主编辑语义承载） */
function onDragStart(event: DragEvent, path: string): void {
  if (!path || path === 'SKILL.md') {
    event.preventDefault();
    return;
  }
  dragPath.value = path;
  event.dataTransfer?.setData('text/plain', path);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

/** 拖动结束（放下或中途取消）：清空拖拽态 */
function onDragEnd(): void {
  dragPath.value = null;
  dropTarget.value = null;
}

/** 悬停目录行：落点 = 移入该目录（不能移进自己或自己的子树） */
function onDragOverFolder(folderPath: string): void {
  if (!dragPath.value) return;
  const from = dragPath.value;
  if (from === folderPath || folderPath.startsWith(`${from}/`)) return;
  dropTarget.value = { kind: 'folder', path: folderPath };
}

/** 悬停文件行：落点 = 插到该文件之前 */
function onDragOverFile(path: string): void {
  if (!dragPath.value || path === dragPath.value) return;
  dropTarget.value = { kind: 'file', path };
}

/** 悬停树头：落点 = 移回根目录 */
function onDragOverRoot(): void {
  if (!dragPath.value) return;
  dropTarget.value = { kind: 'root', path: '' };
}

/**
 * 树体空白处悬停 = 根目录落点。
 * 行自身的 dragover 已 stop 冒泡，只有真正落在空白区（target === 容器）才生效。
 */
function onDragOverTreeBody(event: DragEvent): void {
  if (!dragPath.value) return;
  if (event.target !== event.currentTarget) return;
  onDragOverRoot();
}

/** 离开当前放置目标：只有确实离开该元素（而非移到其子元素）才清除高亮 */
function onDragLeaveTarget(event: DragEvent): void {
  const current = event.currentTarget as HTMLElement | null;
  const related = event.relatedTarget as Node | null;
  if (current && related && current.contains(related)) return;
  dropTarget.value = null;
}

/**
 * 落位执行：把拖动的条目移到目标目录（beforePath 非空时插到该文件之前）。
 * 条目可以是文件（单个迁移）或目录（整棵子树随前缀迁移）。
 * 路径合法性与重命名共用同一套校验（重复路径 / 越界 / 保留名），
 * 失败时在树内就地报错，不静默丢弃这次拖动。
 */
function applyFileMove(toDir: string, beforePath: string | null): void {
  const from = dragPath.value;
  dragPath.value = null;
  dropTarget.value = null;
  if (!from) return;
  // 拖到自己身上 = 无操作（否则会被误当成重排）
  if (beforePath === from) return;
  if (resourceFiles.value[from] === undefined) {
    moveResourceFolder(from, toDir, beforePath);
    return;
  }
  const content = resourceFiles.value[from] ?? '';
  const fileName = from.slice(from.lastIndexOf('/') + 1);
  const newPath = toDir ? `${toDir}/${fileName}` : fileName;
  const pathError = validateResourcePath(newPath, from);
  if (pathError) {
    treeError.value = pathError;
    return;
  }
  // 路径与顺序都没变 = 无操作
  if (newPath === from && beforePath === null) return;
  const next: Record<string, string> = {};
  let inserted = false;
  for (const [path, value] of Object.entries(resourceFiles.value)) {
    if (path === from) continue;
    if (beforePath && path === beforePath) {
      next[newPath] = content;
      inserted = true;
    }
    next[path] = value;
  }
  if (!inserted) next[newPath] = content;
  resourceFiles.value = next;
  if (selectedFile.value === from) selectedFile.value = newPath;
  treeError.value = '';
}

/**
 * 目录整体迁移：目录内所有文件与显式子目录随前缀改写，
 * 并按落点插到目标文件之前（或追加到目标目录末尾）。
 */
function moveResourceFolder(from: string, toDir: string, beforePath: string | null): void {
  const prefix = `${from}/`;
  const name = from.slice(from.lastIndexOf('/') + 1);
  const to = toDir ? `${toDir}/${name}` : name;
  if (to === from) return;
  // 目录不能移进自己的子树
  if (to.startsWith(`${from}/`)) {
    treeError.value = t('hub.resourceFolderInvalidPath');
    return;
  }
  const pathError = validateFolderPath(to, from);
  if (pathError) {
    treeError.value = pathError;
    return;
  }
  const moved = Object.entries(resourceFiles.value)
    .filter(([path]) => path.startsWith(prefix))
    .map(([path, content]) => [`${to}${path.slice(from.length)}`, content] as const);
  const next: Record<string, string> = {};
  let inserted = false;
  for (const [path, content] of Object.entries(resourceFiles.value)) {
    if (path.startsWith(prefix)) continue;
    if (beforePath && path === beforePath) {
      for (const [movedPath, movedContent] of moved) next[movedPath] = movedContent;
      inserted = true;
    }
    next[path] = content;
  }
  if (!inserted) {
    for (const [movedPath, movedContent] of moved) next[movedPath] = movedContent;
  }
  resourceFiles.value = next;
  // 显式目录同步改写（源目录本身 + 其下的显式子目录），并补上目标目录
  const folders = resourceFolders.value.map(folder =>
    folder === from
      ? to
      : folder.startsWith(prefix)
        ? `${to}${folder.slice(from.length)}`
        : folder,
  );
  if (!folders.includes(to)) folders.push(to);
  resourceFolders.value = folders;
  if (selectedFile.value.startsWith(prefix)) {
    selectedFile.value = `${to}${selectedFile.value.slice(from.length)}`;
  }
  treeError.value = '';
}

/** 落在目录行：移入该目录（并自动展开，否则文件会“消失”在折叠目录里） */
function onDropIntoFolder(folderPath: string): void {
  applyFileMove(folderPath, null);
  if (collapsedFolders.value.has(folderPath)) {
    const next = new Set(collapsedFolders.value);
    next.delete(folderPath);
    collapsedFolders.value = next;
  }
}

/** 落在文件行：插到该文件之前（跨目录时同时移入其所在目录） */
function onDropBeforeFile(path: string): void {
  const toDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  applyFileMove(toDir, path);
}

/** 落在树头 / 树体空白：移回根目录 */
function onDropToRoot(): void {
  applyFileMove('', null);
}

/**
 * 高级模式文件配额终检（与导入同一套上限：文件数 / 单文件 / 总量含 SKILL.md）。
 * 旧面板流程只在「保存文件」时校验，直接绑定编辑后改为持续校验——
 * 返回 null 表示通过，否则返回可读文案（主保存禁用 + 页脚提示共用）。
 */
const advancedFilesIssue = computed<string | null>(() => {
  const entries = Object.entries(resourceFiles.value);
  if (entries.length + 1 > SKILL_IMPORT_MAX_FILES) {
    return t('hub.resourceFileLimit', { max: SKILL_IMPORT_MAX_FILES });
  }
  for (const [path, content] of entries) {
    if (content.length > SKILL_IMPORT_MAX_FILE_CHARS) {
      return t('hub.resourceFileTooLarge', { max: SKILL_IMPORT_MAX_FILE_CHARS, source: path });
    }
  }
  const totalChars = entries.reduce((sum, [, content]) => sum + content.length, 0) + form.raw.length;
  if (totalChars > SKILL_IMPORT_MAX_TOTAL_CHARS) {
    return t('hub.resourceTotalTooLarge', { max: SKILL_IMPORT_MAX_TOTAL_CHARS });
  }
  return null;
});

/** 高级模式阻止主保存的就地提示（页脚展示，与按钮禁用同一口径） */
const advancedBlockHint = computed<string | null>(() => {
  if (editorMode.value !== 'advanced') return null;
  if (treeInputActive.value) return t('hub.resourceEditorOpenHint');
  return advancedFilesIssue.value;
});

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
    resourceFiles: resourceFiles.value, resourceFolders: resourceFolders.value, selectedFile: selectedFile.value }));
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
async function acceptLearnDraft(id: string): Promise<{ ok: boolean; error?: string; outcome?: 'saved' | 'ignored' }> {
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
    if (result.transfer.status === 'saved') return { ok: false, outcome: 'saved', error: t('hub.learnHandoffAlreadyHandled') };
    if (result.transfer.status === 'discarded' || result.transfer.recoveryDismissed) return { ok: false, outcome: 'ignored', error: t('hub.learnHandoffIgnored') };
    if (editing.value) return { ok: false, error: t('hub.learnHandoffSaveFirst') };
    const state = result.transfer.editorState;
    if (state !== undefined && !isLearnDraftEditorState(state)) return { ok: false, error: t('hub.learnHandoffReadFailed') };
    const saved = getAllSkills().find(skill => skill.source === 'custom' && parseFrontmatter(skill.files['SKILL.md'] ?? '').data[LEARN_TRANSFER_MARKER] === id);
    if (saved && !state) {
      const acknowledged = await completeLearnDraft(id, saved.id);
      return acknowledged.ok ? { ok: false, outcome: 'saved', error: t('hub.learnHandoffAlreadyHandled') } : acknowledged;
    }
    restoringDraft = true;
    startCreateWithDraft(result.transfer.draft);
    if (state) {
      Object.assign(form, state.form); editorMode.value = state.editorMode;
      preservedFrontmatterLines = [...state.preservedFrontmatterLines];
      resourceFiles.value = { ...state.resourceFiles };
      resourceFolders.value = normalizeFolderList(state.resourceFolders);
      // 选中态防御：快照指向的文件可能已被并发删除——失效即回退入口文件
      selectedFile.value =
        state.selectedFile === 'SKILL.md' || state.selectedFile in resourceFiles.value
          ? state.selectedFile
          : 'SKILL.md';
      cancelTreeInput();
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
 *   - 高级模式：SKILL.md 校验通过 **且** 文件树输入已收笔（半敲的新建/重命名
 *     路径不是内容，带着未收笔的输入保存会静默丢掉那一笔）**且** 全部文件
 *     在配额内（文件数 / 单文件 / 总量，与导入同一套口径，持续校验）。
 * 禁用 + 页脚就地提示，而不是替用户决定。
 */
const canSave = computed(() =>
  editorMode.value === 'simple'
    ? simpleValid.value
    : rawValidation.value.ok && !treeInputActive.value && advancedFilesIssue.value === null,
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
  resourceFolders.value = [];
  selectedFile.value = 'SKILL.md';
  targetFolder.value = '';
  collapsedFolders.value = new Set();
  validationExpanded.value = false;
  closeContextMenu();
  cancelTreeInput();
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
  // 显式目录（含空目录）一并带入，空目录才不会在下次打开时消失
  resourceFolders.value = normalizeFolderList(skill.folders);
  selectedFile.value = 'SKILL.md';
  targetFolder.value = '';
  collapsedFolders.value = new Set();
  validationExpanded.value = false;
  closeContextMenu();
  cancelTreeInput();
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
    // 区分不可保存原因：树输入未收笔 / 配额超限给出就地提示，而非笼统的「表单不完整」
    errorMessage.value =
      editorMode.value === 'advanced'
        ? (advancedBlockHint.value ?? t('hub.errorSkillInvalid'))
        : t('hub.errorSkillInvalid');
    // 高级模式下校验未通过时自动展开问题明细——否则用户只看到「保存不了」却看不到原因
    if (editorMode.value === 'advanced' && !rawValidation.value.ok) validationExpanded.value = true;
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
    // 显式目录（含空目录）随记录落库——空目录才不会在下次打开时凭空消失
    folders: resourceFolders.value,
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
