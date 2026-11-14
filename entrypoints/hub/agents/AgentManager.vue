<template>
  <section class="hub-panel">
    <!-- 列表视图 -->
    <div v-if="!editing" class="hub-list-view">
      <div class="hub-list-toolbar">
        <span class="hub-list-count">{{ t('hub.agentCount', { count: filteredAgents.length }) }}</span>
        <div class="hub-list-filters">
          <div class="hub-search">
            <svg class="hub-search__icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M11.1 10.2a4.6 4.6 0 1 0-.9.9l3 3 .9-.9-3-3zm-4.1.3a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z" fill="currentColor" />
            </svg>
            <input
              v-model.trim="filterQuery"
              type="text"
              class="hub-list-search"
              :placeholder="t('hub.searchAgentPlaceholder')"
            />
          </div>
          <HubSelect
            v-model="filterCategory"
            :options="filterCategoryOptions"
            :aria-label="t('hub.fieldCategory')"
            style="width: 168px"
          />
          <button type="button" class="hub-btn hub-btn-primary" @click="startCreate">
            {{ t('hub.newAgent') }}
          </button>
        </div>
      </div>

      <p v-if="errorMessage" class="hub-error hub-list-error">{{ errorMessage }}</p>

      <div v-if="!filteredAgents.length" class="hub-empty">{{ t('hub.noAgentMatch') }}</div>
      <div v-else class="hub-cards">
        <article
          v-for="agent in filteredAgents"
          :key="agent.id"
          class="hub-card"
          :class="{ 'is-preset': isPreset(agent), 'is-disabled': agent.enabled === false }"
        >
          <div class="hub-card-head">
            <!-- 智能体头像：图片或 emoji，无背景色 -->
            <div class="hub-card-title">
              <AgentAvatar class="hub-card-avatar" :avatar="agent.avatar" :size="26" :label="displayOf(agent).name" />
              <span v-if="agent.plugin" class="hub-badge">{{ agent.plugin.displayName }} · {{ agent.plugin.version }}</span>
              <span class="hub-card-name" :title="displayOf(agent).name">{{ displayOf(agent).name }}</span>
            </div>
            <span class="hub-badge" :class="isPreset(agent) ? 'hub-badge-preset' : 'hub-badge-custom'">
              {{ isPreset(agent) ? t('hub.preset') : t('hub.custom') }}
            </span>
          </div>
          <p class="hub-card-desc" :title="displayOf(agent).description">{{ displayOf(agent).description }}</p>
          <div class="hub-card-taxonomy">
            <span class="hub-badge hub-badge-category">{{ categoryLabel(agent.category) }}</span>
            <span v-for="tag in displayOf(agent).tags" :key="tag" class="hub-badge hub-badge-tag">{{ tag }}</span>
          </div>
          <div class="hub-card-meta">
            <span class="hub-card-tools">{{ t('hub.toolCount', { count: agent.tools.length }) }}</span>
            <span v-if="agent.skills?.length" class="hub-card-tools">{{ t('hub.agentSkillCount', { count: agent.skills.length }) }}</span>
            <span v-if="agent.vision" class="hub-badge hub-badge-vision" :title="t('hub.fieldVision')">
              <svg class="hub-badge-vision__icon" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M1.6 8s2.5-4.2 6.4-4.2S14.4 8 14.4 8s-2.5 4.2-6.4 4.2S1.6 8 1.6 8z" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" />
                <circle cx="8" cy="8" r="1.85" fill="currentColor" />
              </svg>
              <span class="hub-badge-vision__text">{{ t('hub.visionBadge') }}</span>
            </span>
            <!-- 启用 / 停用：停用后该智能体不再出现在输入框的 @ 选择器中 -->
            <HubSwitch
              class="hub-switch-inline"
              :model-value="agent.enabled !== false"
              @update:model-value="toggleEnabled(agent, $event)"
            >{{ agent.enabled === false ? t('hub.disabled') : t('hub.enabled') }}</HubSwitch>
            <span class="hub-card-ops">
              <button v-if="agent.plugin" type="button" class="hub-op" @click="copyPluginAgent(agent)">{{ t('hub.copyPluginAgent') }}</button>
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

    <!-- 编辑视图（左右两张等高卡片：左卡基础信息（整卡内部滚动），右卡清单区（各区占比限高、区内滚动）） -->
    <form v-else ref="editorFormRef" class="hub-editor is-fill" @submit.prevent="save">
      <div class="hub-editor-head">
        <div class="hub-editor-head-main">
          <h2>{{ editingExisting ? t('hub.editAgent') : t('hub.newAgent') }}</h2>
        </div>
        <!-- 头部动作区：返回列表 / 取消 / 保存（取消与保存在返回列表右侧） -->
        <div class="hub-editor-head-actions">
          <button type="button" class="hub-btn" @click="cancelEdit">{{ t('hub.backToList') }}</button>
          <button type="button" class="hub-btn" @click="cancelEdit">{{ t('common.cancel') }}</button>
          <button type="submit" class="hub-btn hub-btn-primary">{{ t('common.save') }}</button>
        </div>
      </div>

      <div class="hub-editor-split hub-editor-split--agent">
        <!-- 左卡：头像 / 名称 / 视觉声明 / 描述 / 分类 / 标签 / 系统提示词。
             短字段走双列栅格（同一行并排），长字段（系统提示词）独占整行并吃满余高 -->
        <div class="hub-editor-col hub-editor-col--form">
          <!-- 头像：上传图片（智能裁剪 + 压缩至 1MB 内）或点选 emoji 卡片。
               预览占位刻意压到最小（emoji 26px / 图片 36px），
               图片形态可点开放大查看并下载 -->
          <div class="hub-field hub-avatar-field">
            <span class="hub-field-label">{{ t('hub.fieldAvatar') }}</span>
            <div class="hub-avatar-picker">
              <div class="hub-avatar-current">
                <component
                  :is="isImageAvatar ? 'button' : 'span'"
                  class="hub-avatar-preview"
                  :class="{ 'is-image': isImageAvatar, 'is-emoji': !isImageAvatar }"
                  :type="isImageAvatar ? 'button' : undefined"
                  :title="isImageAvatar ? t('hub.avatarPreviewTitle') : undefined"
                  :aria-label="isImageAvatar ? t('hub.avatarPreviewTitle') : undefined"
                  @click="isImageAvatar && openAvatarPreview()"
                >
                  <AgentAvatar :avatar="form.avatar" :size="isImageAvatar ? 36 : 26" :label="form.name" />
                </component>
                <div class="hub-avatar-actions">
                  <label class="hub-btn hub-avatar-upload" :title="t('hub.fieldAvatarHint')">
                    {{ t('hub.avatarUpload') }}
                    <input type="file" accept="image/*" hidden @change="onAvatarFileChange" />
                  </label>
                  <button
                    type="button"
                    class="hub-btn"
                    :class="{ 'is-active': showEmojiPicker }"
                    @click="showEmojiPicker = !showEmojiPicker"
                  >
                    {{ t('hub.avatarChooseEmoji') }}
                  </button>
                  <button
                    v-if="form.avatar"
                    type="button"
                    class="hub-btn hub-avatar-clear"
                    @click="clearAvatar"
                  >
                    {{ t('hub.avatarClear') }}
                  </button>
                </div>
              </div>
              <EmojiPicker
                v-if="showEmojiPicker"
                :selected="form.avatar?.type === 'emoji' ? form.avatar.value : ''"
                @select="onEmojiPicked"
                @close="showEmojiPicker = false"
              />
              <p class="hub-hint">{{ t('hub.fieldAvatarHint') }}</p>
              <p v-if="avatarError" class="hub-error">{{ avatarError }}</p>
            </div>
          </div>

          <!-- 名称：单行独占一行 -->
          <label class="hub-field" :class="{ 'is-invalid': nameInvalid }">
            <span class="hub-field-label">{{ t('hub.fieldName') }}<span class="hub-required" aria-hidden="true">*</span></span>
            <input v-model.trim="form.name" type="text" :maxlength="AGENT_NAME_MAX_CHARS" :placeholder="t('hub.fieldNamePlaceholder')" />
          </label>

          <!-- 描述：单行独占一行 -->
          <label class="hub-field" :class="{ 'is-invalid': descriptionInvalid }">
            <span class="hub-field-label">{{ t('hub.fieldDescription') }}<span class="hub-required" aria-hidden="true">*</span></span>
            <input v-model.trim="form.description" type="text" :maxlength="AGENT_DESCRIPTION_MAX_CHARS" :placeholder="t('hub.fieldDescriptionPlaceholder')" />
          </label>

          <!-- 视觉操作开关（原「视觉循环」）：标题 + 问号说明在左、开关在右的整行设置项。
               左端与「名称 / 描述 / 分类 / 标签」的字段标签严格对齐（同一条文本基准线）。
               问号弹自定义解释框（挂编辑器层，机制与关联技能说明共用）。
               本开关是 vision_gui 进入智能体工具面的唯一入口：工具组从不提供
               vision_gui 勾选，运行时按此开关注入工具并触发规程注入 -->
          <fieldset class="hub-field hub-vision-field" :aria-label="t('hub.fieldVision')">
            <div class="hub-vision-head" :class="{ 'is-on': form.visionEnabled }">
              <span class="hub-field-label hub-vision-title">
                {{ t('hub.fieldVision') }}
                <button
                  type="button"
                  class="hub-help-tip"
                  :class="{ 'is-open': activeHelpPop === 'vision' }"
                  :title="t('hub.visionToggleHint')"
                  :aria-label="t('hub.visionToggleHint')"
                  :aria-expanded="activeHelpPop === 'vision'"
                  @click.stop="toggleHelpPop('vision', $event)"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.3" />
                    <path d="M6.3 6.2a1.75 1.75 0 1 1 2.5 1.6c-.5.25-.8.7-.8 1.25v.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                    <circle cx="8" cy="11.6" r="0.85" fill="currentColor" />
                  </svg>
                </button>
              </span>
              <HubSwitch v-model="form.visionEnabled" :aria-label="t('hub.visionEnable')" />
            </div>
            <!-- 视觉操作开启后只留坐标与模型要求的说明：截图工具与「工具后重截图」
                 都是内部实现细节（截图工具恒为 screenshot、重拍恒开），不做成用户开关 -->
            <p v-if="form.visionEnabled" class="hub-hint">{{ t('hub.visionCoordinatesHint') }}</p>
          </fieldset>

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
          </div>

          <!-- 标签：多选；回车 / 逗号 / 空格分隔逐个添加（提示与上限反馈由组件内置） -->
          <div class="hub-field">
            <span class="hub-field-label">{{ t('hub.fieldTags') }}</span>
            <TagInput v-model="form.tags" />
          </div>

          <label class="hub-field hub-field--grow" :class="{ 'is-invalid': systemInvalid }">
            <span class="hub-field-label">{{ t('hub.fieldSystem') }}<span class="hub-required" aria-hidden="true">*</span></span>
            <textarea v-model="form.system" class="hub-field--fill" :placeholder="t('hub.fieldSystemPlaceholder')"></textarea>
          </label>
        </div>

        <!-- 右卡：工具组（带搜索）/ 外部插件工具 / 关联技能；
             三区各为一张独立卡片，均可展开收起，收起时把空间让给其余区 -->
        <div class="hub-editor-col hub-editor-col--lists">
          <!-- 工具组 -->
          <div class="hub-section hub-section--groups" :class="{ 'is-collapsed': collapsedSections.groups }">
            <div class="hub-section-head">
              <button
                type="button"
                class="hub-section-toggle"
                :title="collapsedSections.groups ? t('hub.sectionExpand') : t('hub.sectionCollapse')"
                :aria-expanded="!collapsedSections.groups"
                @click="collapsedSections.groups = !collapsedSections.groups"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" class="hub-section-toggle__chevron" :class="{ 'is-collapsed': collapsedSections.groups }">
                  <path d="M4.5 6.2L8 9.8l3.5-3.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <span class="hub-field-label">{{ t('hub.fieldToolGroups') }}<span class="hub-required" aria-hidden="true">*</span></span>
              <span class="hub-groups-count">{{ t('hub.selectedToolCount', { count: selectedToolCount, max: MAX_TOOLS_PER_AGENT }) }}</span>
              <!-- 视图切换：按工具（默认，每个工具独立一个元素）/ 按组（批量选择） -->
              <HubSegmented
                class="hub-section-view"
                :model-value="toolView"
                :options="toolViewOptions"
                :aria-label="t('hub.fieldToolGroups')"
                @update:model-value="onToolViewChange"
              />
            </div>
            <div class="hub-section-body">
              <div class="hub-section-body-inner">
                <!-- 搜索：按工具视图搜工具名 / 按组视图搜组名与描述 -->
                <div class="hub-search hub-search--fill">
                  <svg class="hub-search__icon" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M11.1 10.2a4.6 4.6 0 1 0-.9.9l3 3 .9-.9-3-3zm-4.1.3a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z" fill="currentColor" />
                  </svg>
                  <input
                    v-model="groupQuery"
                    type="text"
                    class="hub-list-search"
                    :placeholder="toolView === 'tools' ? t('hub.toolSearchPlaceholder') : t('hub.groupSearchPlaceholder')"
                  />
                </div>

                <!-- 按工具视图（默认）：每个工具独立一个可选元素 -->
                <div v-if="toolView === 'tools'" class="hub-groups-scroll" :class="{ 'is-invalid': groupsInvalid }">
                  <div v-if="!filteredToolEntries.length" class="hub-hint">{{ t('hub.toolSearchEmpty') }}</div>
                  <div v-else class="hub-tool-list">
                    <label
                      v-for="entry in filteredToolEntries"
                      :key="entry.toolId"
                      class="hub-tool-row"
                      :class="{ 'is-checked': isToolSelected(entry.toolId), 'is-locked': entry.locked }"
                      :title="entry.toolId"
                    >
                      <input
                        class="hub-check"
                        type="checkbox"
                        :checked="isToolSelected(entry.toolId)"
                        :disabled="entry.locked"
                        @change="toggleGroupTool(entry.groupId, entry.toolId)"
                      />
                      <span class="hub-tool-row-main">
                        <span class="hub-tool-row-id">{{ entry.toolId }}</span>
                        <span class="hub-tool-row-group">{{ t(entry.groupNameKey) }}</span>
                      </span>
                      <span v-if="entry.locked" class="hub-group-lock">{{ t('hub.pythonNotReady') }}</span>
                    </label>
                  </div>
                </div>

                <!-- 按组视图：组头三态复选框 + 组内逐个工具 -->
                <div v-else class="hub-groups-scroll" :class="{ 'is-invalid': groupsInvalid }">
                  <div v-if="!filteredToolGroups.length" class="hub-hint">{{ t('hub.groupSearchEmpty') }}</div>
                  <div v-else class="hub-groups">
                    <div
                      v-for="group in filteredToolGroups"
                      :key="group.id"
                      class="hub-group"
                      :class="{
                        checked: groupSelectionState(group.id) === 'all',
                        'is-partial': groupSelectionState(group.id) === 'some',
                        locked: isGroupLocked(group.id),
                      }"
                    >
                      <!-- 组头：三态复选框（全选 / 部分选 / 未选）+ 组名描述 + 查看 -->
                      <div class="hub-group-head">
                        <input
                          class="hub-check"
                          type="checkbox"
                          :checked="groupSelectionState(group.id) === 'all'"
                          :indeterminate="groupSelectionState(group.id) === 'some'"
                          :disabled="isGroupLocked(group.id)"
                          @change="toggleGroup(group.id)"
                        />
                        <button
                          type="button"
                          class="hub-group-body"
                          :title="t('hub.groupViewDetail')"
                          @click="openGroupDetail(group)"
                        >
                          <span class="hub-group-name">{{ t(group.nameKey) }}</span>
                          <span class="hub-group-desc">{{ t(group.descKey) }}</span>
                        </button>
                        <span v-if="isGroupLocked(group.id)" class="hub-group-lock">{{ t('hub.pythonNotReady') }}</span>
                        <button
                          type="button"
                          class="hub-group-info"
                          :title="t('hub.groupViewDetail')"
                          :aria-label="t('hub.groupViewDetail')"
                          @click.stop="openGroupDetail(group)"
                        >
                          <svg viewBox="0 0 16 16"><path d="M2 8s2.6-4.4 6-4.4S14 8 14 8s-2.6 4.4-6 4.4S2 8 2 8z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.9" fill="currentColor"/></svg>
                        </button>
                      </div>
                      <!-- 组内工具：逐个勾选（与组复选框共享同一扁平集合） -->
                      <div class="hub-group-tools">
                        <label
                          v-for="toolId in groupToolSets.get(group.id)"
                          :key="toolId"
                          class="hub-group-tool"
                          :class="{ 'is-checked': isToolSelected(toolId) }"
                          :title="toolId"
                        >
                          <input
                            class="hub-check"
                            type="checkbox"
                            :checked="isToolSelected(toolId)"
                            :disabled="isGroupLocked(group.id)"
                            @change="toggleGroupTool(group.id, toolId)"
                          />
                          <span class="hub-group-tool-id">{{ toolId }}</span>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
                <p v-if="showLimitHint" class="hub-error">{{ t('hub.toolLimitHint', { max: MAX_TOOLS_PER_AGENT }) }}</p>
                <p v-else-if="extraTools.length > 0" class="hub-hint">{{ t('hub.extraToolsHint', { count: extraTools.length }) }}</p>
              </div>
            </div>
          </div>

          <ExternalToolsPicker
            v-model="selectedToolIds"
            :count="selectedToolCount"
            :max="MAX_TOOLS_PER_AGENT"
            :collapsed="collapsedSections.external"
            @toggle-collapse="collapsedSections.external = !collapsedSections.external"
          />

          <!-- 关联技能：多选（可用清单 = 显式关联 ∪ 工具映射兜底；见 utils/skills/skill-availability） -->
          <div class="hub-section hub-section--skills" :class="{ 'is-collapsed': collapsedSections.skills }">
            <div class="hub-section-head">
              <button
                type="button"
                class="hub-section-toggle"
                :title="collapsedSections.skills ? t('hub.sectionExpand') : t('hub.sectionCollapse')"
                :aria-expanded="!collapsedSections.skills"
                @click="collapsedSections.skills = !collapsedSections.skills"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" class="hub-section-toggle__chevron" :class="{ 'is-collapsed': collapsedSections.skills }">
                  <path d="M4.5 6.2L8 9.8l3.5-3.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <span class="hub-field-label">{{ t('hub.fieldAgentSkills') }}</span>
              <span class="hub-groups-count">{{ t('hub.selectedSkillCount', { count: form.skills.length, max: AGENT_SKILLS_MAX_COUNT }) }}</span>
              <!-- 关联规则说明：问号触发，悬浮卡片展示完整解释（不占用表单竖向空间；
                   与视觉操作说明共用同一套开合/定位机制，见 toggleHelpPop） -->
              <button
                type="button"
                class="hub-help-tip"
                :class="{ 'is-open': activeHelpPop === 'skills' }"
                :title="t('hub.skillsHintTitle')"
                :aria-label="t('hub.skillsHintTitle')"
                :aria-expanded="activeHelpPop === 'skills'"
                @click.stop="toggleHelpPop('skills', $event)"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.3" />
                  <path d="M6.3 6.2a1.75 1.75 0 1 1 2.5 1.6c-.5.25-.8.7-.8 1.25v.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                  <circle cx="8" cy="11.6" r="0.85" fill="currentColor" />
                </svg>
              </button>
            </div>
            <div class="hub-section-body">
              <div class="hub-section-body-inner">
                <!-- 关联技能搜索：按名称 / 描述过滤（可用技能可能很多） -->
                <div class="hub-search hub-search--fill">
                  <svg class="hub-search__icon" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M11.1 10.2a4.6 4.6 0 1 0-.9.9l3 3 .9-.9-3-3zm-4.1.3a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z" fill="currentColor" />
                  </svg>
                  <input v-model="skillQuery" type="text" class="hub-list-search" :placeholder="t('hub.skillSearchPlaceholder')" />
                </div>
                <div class="hub-groups-scroll">
                  <div v-if="!skills.length" class="hub-hint">{{ t('hub.noSkillsAvailable') }}</div>
                  <div v-else-if="!filteredSkills.length" class="hub-hint">{{ t('hub.skillSearchEmpty') }}</div>
                  <div v-else class="hub-groups">
                    <div
                      v-for="skill in filteredSkills"
                      :key="skill.id"
                      class="hub-group"
                      :class="{ checked: form.skills.includes(skill.id), 'is-disabled-skill': !skill.enabled }"
                    >
                      <!-- 技能卡只有一行主体：包进组头行以复用 .hub-group 纵向卡片结构 -->
                      <div class="hub-group-head">
                        <input
                          class="hub-check"
                          type="checkbox"
                          :value="skill.id"
                          :checked="form.skills.includes(skill.id)"
                          :disabled="!form.skills.includes(skill.id) && form.skills.length >= AGENT_SKILLS_MAX_COUNT"
                          @change="toggleSkill(skill.id)"
                        />
                        <button
                          type="button"
                          class="hub-group-body"
                          :title="t('hub.skillViewDetail')"
                          @click="openSkillDetail(skill)"
                        >
                          <span class="hub-group-name">{{ skillOptionLabel(skill) }}</span>
                          <span class="hub-group-desc">{{ skill.enabled ? skill.description : t('hub.skillDisabledMark') }}</span>
                        </button>
                        <button
                          type="button"
                          class="hub-group-info"
                          :title="t('hub.skillViewDetail')"
                          :aria-label="t('hub.skillViewDetail')"
                          @click.stop="openSkillDetail(skill)"
                        >
                          <svg viewBox="0 0 16 16"><path d="M2 8s2.6-4.4 6-4.4S14 8 14 8s-2.6 4.4-6 4.4S2 8 2 8z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.9" fill="currentColor"/></svg>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
                <label v-for="missing in missingSkillRefs" :key="missing" class="hub-hint"><input class="hub-check" type="checkbox" checked @change="toggleSkill(missing)" />{{ missing }} · {{ t('hub.skillDisabledMark') }}</label>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="hub-editor-footer">
        <span v-if="errorMessage" class="hub-error">{{ errorMessage }}</span>
      </div>

      <!-- 问号说明悬浮卡片（skills / vision 共用一个实例）：挂在编辑器层，不受分区卡片裁剪 -->
      <div
        v-if="activeHelpPop"
        ref="helpPopEl"
        class="hub-help-pop"
        role="note"
        :style="{ left: `${helpPopLeft}px`, top: `${helpPopTop}px` }"
      >
        <template v-if="activeHelpPop === 'skills'">
          <p class="hub-help-pop__title">{{ t('hub.skillsHintTitle') }}</p>
          <p class="hub-help-pop__text">{{ t('hub.fieldAgentSkillsHint') }}</p>
        </template>
        <p v-else class="hub-help-pop__text">{{ t('hub.visionToggleHint') }}</p>
      </div>

      <!-- 工具组 / 技能的完整信息悬浮窗卡片 -->
      <div
        v-if="detailCard"
        class="hub-detail-card"
        role="dialog"
        :aria-label="detailCard.title"
        @click.self="detailCard = null"
      >
        <div class="hub-detail-card__panel">
          <div class="hub-detail-card__head">
            <strong class="hub-detail-card__title">{{ detailCard.title }}</strong>
            <button type="button" class="hub-icon-btn" :title="t('common.close')" @click="detailCard = null">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            </button>
          </div>
          <p v-if="detailCard.description" class="hub-detail-card__desc">{{ detailCard.description }}</p>
          <dl v-if="detailCard.rows.length" class="hub-detail-card__rows">
            <div v-for="row in detailCard.rows" :key="row.label" class="hub-detail-card__row">
              <dt>{{ row.label }}</dt>
              <dd>{{ row.value }}</dd>
            </div>
          </dl>

          <!-- 工具明细：完整名称 + 介绍 + 输入参数说明 -->
          <section v-for="tool in detailCard.tools" :key="tool.name" class="hub-detail-tool">
            <div class="hub-detail-tool__head">
              <span class="hub-detail-tool__name">{{ tool.name }}</span>
              <span v-if="tool.version" class="hub-detail-tool__version">v{{ tool.version }}</span>
            </div>
            <p class="hub-detail-tool__desc">{{ tool.description }}</p>
            <div v-if="tool.parameters.length" class="hub-detail-tool__params">
              <span class="hub-detail-tool__params-label">{{ t('hub.detailToolParams') }}</span>
              <div v-for="param in tool.parameters" :key="param.name" class="hub-detail-tool__param">
                <span class="hub-detail-tool__param-name">
                  {{ param.name }}
                  <span class="hub-detail-tool__param-type">{{ param.type }}</span>
                  <span v-if="param.required" class="hub-detail-tool__required">{{ t('hub.detailRequired') }}</span>
                </span>
                <span class="hub-detail-tool__param-desc">{{ param.description }}</span>
              </div>
            </div>
          </section>

          <!-- 技能资源文件 -->
          <div v-if="detailCard.files && detailCard.files.length" class="hub-detail-files">
            <span class="hub-detail-files__label">{{ t('hub.detailSkillFiles') }}</span>
            <div class="hub-detail-files__list">
              <code v-for="file in detailCard.files" :key="file" class="hub-detail-files__item">{{ file }}</code>
            </div>
          </div>
        </div>
      </div>

      <!-- 图片头像放大查看（点缩略图打开；支持下载原图） -->
      <div v-if="avatarPreviewImage" class="hub-image-lightbox" role="dialog" @click.self="avatarPreviewImage = ''">
        <img class="hub-image-lightbox__image" :src="avatarPreviewImage" :alt="t('hub.fieldAvatar')" />
        <div class="hub-image-lightbox__bar">
          <a class="hub-btn" :href="avatarPreviewImage" :download="avatarFileName">{{ t('hub.avatarDownload') }}</a>
          <button type="button" class="hub-btn" @click="avatarPreviewImage = ''">{{ t('common.close') }}</button>
        </div>
      </div>
    </form>
  </section>
</template>

<script setup lang="ts">
/**
 * 智能体管理：预置（只读展示）+ 自定义（新建/编辑/删除）。
 * 编辑器为左右两张等高卡片：左卡（整卡内部滚动）头像 / 名称 / 描述 / 视觉操作 /
 * 分类 / 标签 / 系统提示词（各占整行，左端共用同一条文本基准线）；右卡（各区占比限高、
 * 区内滚动）工具组（带搜索，上限 30 个工具）/ 外部插件工具 / 关联技能。emoji 头像选择为
 * 悬浮卡片，选中或点击外部自动收起；图片头像可点开放大查看并下载。
 * 采样参数（temperature / maxTokens）与流式开关已移除——统一取用户全局 API 配置，流式恒开。
 * 写入经 utils/agents/agent-store（chrome.storage 权威源），跨上下文实时同步到 sidepanel。
 */
import { replaceAgentSkillLinks } from '@/utils/agents/agent-skill-links';
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { t, type MessageKey } from '@/utils/i18n';
// 智能体头像展示（图片或 emoji，无背景色）：预置 / 自定义 / 导入三类智能体共用
import AgentAvatar from '@/common/AgentAvatar.vue';
// 智能体展示文案随界面语言切换（预置智能体的多语言文案；自定义智能体沿用其自填文案）
import { useAgentDisplay } from '@/common/use-agent-display';
import CategorySelect from '../components/CategorySelect.vue';
// Hub 共享自定义控件：玻璃选择框与 iOS 形态开关（设计语言统一，见 hub.css）
import HubSelect from '../components/HubSelect.vue';
import HubSegmented from '../components/HubSegmented.vue';
import HubSwitch from '../components/HubSwitch.vue';
import ExternalToolsPicker from './ExternalToolsPicker.vue';
import TagInput from '../components/TagInput.vue';
// 头像 emoji 选择卡片（全量清单网格，取代原预置图片选择）
import EmojiPicker from '../components/EmojiPicker.vue';
// 头像上传处理：智能裁剪 + 自动压缩到 1MB 内，返回可持久化的 data URL
import {
  AVATAR_ERR_NOT_IMAGE,
  processAvatarImage,
} from '@/utils/agents/avatar-image';
import {
  AGENT_CATEGORY_UNCATEGORIZED,
  AGENT_DESCRIPTION_MAX_CHARS,
  AGENT_NAME_MAX_CHARS,
  AGENT_SKILLS_MAX_COUNT,
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
  setAgentEnabled,
  type AgentConfig,
  type AgentWriteResult,
} from '@/utils/agents/agent-store';
import { getPresetToolIds, type ToolScenario } from '@/utils/tools/tool-presets';
// vision_gui 身份常量：工具组不提供勾选，编辑入口对存量勾选残留做剔除归一
//（运行时装配另有一道同口径归一，见 runtime-builder「视觉操作开关注入」）
import { VISION_GUI_TOOL_ID } from '@/tools/vision/gui-contract';
// 工具元数据（完整名称 / 介绍 / 输入参数）：按需加载，管理页主 bundle 不含工具实现
import { loadToolDefinitions } from '@/utils/tools/tool-metadata';
import type { ToolDefinition } from '@/entrypoints/sidepanel/components/tool/types';
import { getAllSkills, onSkillsChange, getSkillById, type SkillRecord } from '@/utils/skills/skill-store';
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
  // note 组已移除：note_tool 与 plan_tool 同为 CORE_SESSION_TOOL_IDS 无条件注入的
  // 核心工具，对所有智能体恒定可用，作为可选工具组展示只会制造「勾选才有」的歧义；
  // 存量自定义智能体 tools 里的 note_tool 依然有效（扁平已选集合原样往返，
  // 不属于任何组也不会被丢弃）
  { id: 'webSearch', nameKey: 'hub.groupWebSearch', descKey: 'hub.groupWebSearchDesc' },
  { id: 'pageRead', nameKey: 'hub.groupPageRead', descKey: 'hub.groupPageReadDesc' },
  { id: 'domInteract', nameKey: 'hub.groupDomInteract', descKey: 'hub.groupDomInteractDesc' },
  { id: 'tabsWindows', nameKey: 'hub.groupTabsWindows', descKey: 'hub.groupTabsWindowsDesc' },
  { id: 'scripting', nameKey: 'hub.groupScripting', descKey: 'hub.groupScriptingDesc' },
  { id: 'bookmarkHistory', nameKey: 'hub.groupBookmarkHistory', descKey: 'hub.groupBookmarkHistoryDesc' },
  { id: 'resource', nameKey: 'hub.groupResource', descKey: 'hub.groupResourceDesc' },
  { id: 'files', nameKey: 'hub.groupFiles', descKey: 'hub.groupFilesDesc' },
  { id: 'data', nameKey: 'hub.groupData', descKey: 'hub.groupDataDesc' },
  { id: 'networkTools', nameKey: 'hub.groupNetworkTools', descKey: 'hub.groupNetworkToolsDesc' },
  { id: 'visionTools', nameKey: 'hub.groupVisionTools', descKey: 'hub.groupVisionToolsDesc' },
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

const isPreset = (agent: AgentConfig) => isPresetAgent(agent.id) || !!agent.plugin;

// 智能体展示文案（随界面语言切换；编辑表单仍用规范名 agent.name 作为存储键）
const { displayOf } = useAgentDisplay();

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

/** 筛选下拉选项（自绘选择框用）：全部 + 各分类的当前语言显示名 */
const filterCategoryOptions = computed(() => [
  { value: '', label: t('hub.filterAllCategories') },
  ...availableCategories.value.map(category => ({
    value: category.id,
    label: category.labelKey ? t(category.labelKey) : category.id,
  })),
]);

const filteredAgents = computed(() => {
  const query = filterQuery.value.toLowerCase();
  const category = filterCategory.value;
  return agents.value.filter(agent => {
    const agentCategory = agent.category || AGENT_CATEGORY_UNCATEGORIZED;
    if (category && agentCategory !== category) return false;
    if (!query) return true;
    // 匹配用当前语言的展示文案——用户看到什么就搜得到什么
    const { name, description, tags } = displayOf(agent);
    return (
      name.toLowerCase().includes(query) ||
      description.toLowerCase().includes(query) ||
      tags.some(tag => tag.toLowerCase().includes(query))
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

// ──── 工具组 / 关联技能搜索（按当前语言的显示名 / 描述过滤；搜索词不参与保存） ────

/** 工具区视图：tools = 每个工具独立元素（默认）/ groups = 按组批量选择 */
const toolView = ref<'tools' | 'groups'>('tools');

/** 视图切换选项（随界面语言刷新显示名） */
const toolViewOptions = computed(() => [
  { value: 'tools', label: t('hub.toolViewTools') },
  { value: 'groups', label: t('hub.toolViewGroups') },
]);

/** 分段控件 → 视图状态桥接（HubSegmented 的 value 为 string） */
function onToolViewChange(value: string): void {
  toolView.value = value === 'groups' ? 'groups' : 'tools';
}

/** 扁平工具条目：每个工具带上所属组（用于扁平视图展示归属与锁定态传递）
 *  同一工具可能出现在多个组（如 browser_observe 同属多个场景预设），
 *  扁平列表按工具去重（取首个所属组），避免重复 key 与重复行。 */
interface ToolEntry {
  toolId: string;
  groupId: ToolScenario;
  groupNameKey: MessageKey;
  locked: boolean;
}

const allToolEntries = computed<ToolEntry[]>(() => {
  const entries: ToolEntry[] = [];
  const seen = new Set<string>();
  for (const group of toolGroups) {
    for (const toolId of groupToolSets.get(group.id) ?? []) {
      if (seen.has(toolId)) continue;
      seen.add(toolId);
      entries.push({
        toolId,
        groupId: group.id,
        groupNameKey: group.nameKey,
        locked: isGroupLocked(group.id),
      });
    }
  }
  return entries;
});

const groupQuery = ref('');
const filteredToolGroups = computed(() => {
  const query = groupQuery.value.trim().toLowerCase();
  if (!query) return toolGroups;
  return toolGroups.filter(
    group =>
      t(group.nameKey).toLowerCase().includes(query) ||
      t(group.descKey).toLowerCase().includes(query),
  );
});

/** 扁平视图的过滤：按工具 id 或所属组名匹配 */
const filteredToolEntries = computed(() => {
  const query = groupQuery.value.trim().toLowerCase();
  if (!query) return allToolEntries.value;
  return allToolEntries.value.filter(
    entry =>
      entry.toolId.toLowerCase().includes(query) ||
      t(entry.groupNameKey).toLowerCase().includes(query),
  );
});

const skillQuery = ref('');
const filteredSkills = computed(() => {
  const query = skillQuery.value.trim().toLowerCase();
  if (!query) return skills.value;
  return skills.value.filter(skill => {
    const haystack = [
      skillOptionLabel(skill),
      skill.description,
      skill.origin?.pluginKey ?? '',
      ...skill.tags,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });
});

// ──── 右卡三区的展开 / 收起（收起后把空间让给其余区；外部工具与技能默认收起） ────

const collapsedSections = reactive({ groups: false, external: true, skills: true });

/** 问号说明悬浮卡片（skills / vision 共用一套开合、定位与外点关闭机制） */
type HelpPopKind = 'skills' | 'vision';
/** 当前展开的说明框（null = 收起）；同一时刻至多一个 */
const activeHelpPop = ref<HelpPopKind | null>(null);
const helpPopEl = ref<HTMLElement | null>(null);
/** 说明框位置：相对编辑器（position: relative 的定位祖先） */
const helpPopLeft = ref(0);
const helpPopTop = ref(0);
const editorFormRef = ref<HTMLElement | null>(null);

/** 问号点击：开合并定位到按钮下方（说明框挂编辑器层，需按按钮位置换算坐标）；
 *  已展开另一个说明框时直接切换目标（互斥单开） */
function toggleHelpPop(kind: HelpPopKind, event: MouseEvent): void {
  if (activeHelpPop.value === kind) {
    activeHelpPop.value = null;
    return;
  }
  const button = event.currentTarget as HTMLElement | null;
  const rect = button?.getBoundingClientRect();
  const host = editorFormRef.value?.getBoundingClientRect();
  // 说明框宽 360px：右缘对齐按钮右缘，顶端贴在按钮下方 6px
  const width = 360;
  helpPopLeft.value = Math.max(8, (rect?.right ?? 0) - (host?.left ?? 0) - width);
  helpPopTop.value = (rect?.bottom ?? 0) - (host?.top ?? 0) + 6;
  activeHelpPop.value = kind;
}

/** 点击组件外部 / Esc 收起说明框 */
function onHelpPopPointerDown(event: PointerEvent): void {
  if (!activeHelpPop.value) return;
  const target = event.target as Node | null;
  if (target && helpPopEl.value?.contains(target)) return;
  // 问号按钮自身由 click 切换，这里排除以免"点一次开、立刻又被关"
  if (target instanceof Element && target.closest('.hub-help-tip')) return;
  activeHelpPop.value = null;
}
function onHelpPopKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') activeHelpPop.value = null;
}
onMounted(() => {
  document.addEventListener('pointerdown', onHelpPopPointerDown, true);
  document.addEventListener('keydown', onHelpPopKeydown, true);
});
onUnmounted(() => {
  document.removeEventListener('pointerdown', onHelpPopPointerDown, true);
  document.removeEventListener('keydown', onHelpPopKeydown, true);
});

// ──── 工具组 / 技能详情悬浮窗卡片 ────

/** 单个工具的展示模型：完整名称 + 介绍 + 输入参数（含说明） */
interface DetailToolInfo {
  name: string;
  description: string;
  version?: string;
  parameters: { name: string; type: string; required: boolean; description: string }[];
}

/** 详情卡片的展示模型 */
interface DetailCard {
  title: string;
  description?: string;
  /** 概要行（分类 / 标签 / 来源 …） */
  rows: { label: string; value: string }[];
  /** 工具明细（完整名称 + 介绍 + 输入参数） */
  tools: DetailToolInfo[];
  /** 技能的资源文件路径 */
  files?: string[];
}

const detailCard = ref<DetailCard | null>(null);
/** 详情卡加载序号：异步取元数据期间用户可能已关闭或切换目标，用序号丢弃过期结果 */
let detailSeq = 0;

/** 工具定义 → 展示模型（插件工具等无静态元数据时给出兜底说明） */
function toToolInfo(definition: ToolDefinition | undefined, id: string): DetailToolInfo {
  if (!definition) {
    return { name: id, description: '（该工具由插件提供，没有内置说明）', parameters: [] };
  }
  return {
    name: definition.name,
    description: definition.description,
    version: definition.version,
    parameters: Object.entries(definition.parameters ?? {}).map(([name, parameter]) => ({
      name,
      type: parameter.type ?? 'string',
      required: definition.required.includes(name),
      description: parameter.description ?? '',
    })),
  };
}

/** 工具组详情：逐个工具的完整名称、介绍与输入参数 */
async function openGroupDetail(group: ToolGroupMeta): Promise<void> {
  const seq = ++detailSeq;
  const toolIds = groupToolSets.get(group.id) ?? [];
  const definitions = await loadToolDefinitions();
  if (seq !== detailSeq) return;
  detailCard.value = {
    title: t(group.nameKey),
    description: t(group.descKey),
    rows: [],
    tools: toolIds.map(id => toToolInfo(definitions[id], id)),
  };
}

/** 技能详情：完整介绍 + 概要 + 预授权工具明细 + 资源文件 */
async function openSkillDetail(skill: SkillRecord): Promise<void> {
  const seq = ++detailSeq;
  const definitions = await loadToolDefinitions();
  if (seq !== detailSeq) return;
  const filePaths = Object.keys(skill.files ?? {});
  detailCard.value = {
    title: skillOptionLabel(skill),
    description: skill.enabled ? skill.description : t('hub.skillDisabledMark'),
    rows: [
      { label: t('hub.detailSkillCategory'), value: categoryLabel(skill.category) },
      { label: t('hub.detailSkillTags'), value: skill.tags.length ? skill.tags.join('、') : '—' },
      {
        label: t('hub.detailSkillSource'),
        value: skill.origin
          ? `${skill.origin.pluginKey} ${skill.origin.version}`
          : t('hub.custom'),
      },
    ],
    tools: skill.allowedTools.map(id => toToolInfo(definitions[id], id)),
    files: filePaths,
  };
}

// ──── 编辑态 ────

const editing = ref(false);
const emit = defineEmits<{ editorState: [editing: boolean] }>();
watch(editing, value => emit('editorState', value), { immediate: true, flush: 'sync' });
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
  /** 关联技能 id 列表（可用清单的显式通道；映射兜底通道无需配置） */
  skills: [] as string[],
  /** 头像（图片或 emoji）；未选择时为 undefined，由 UI 回退默认 emoji */
  avatar: undefined as AgentConfig['avatar'],
  /** 富组件等运行能力；编辑器不直接暴露，编辑/复制插件智能体时原样保留 */
  capabilities: undefined as AgentConfig['capabilities'],
  visionEnabled: false,
});

/**
 * 工具选择的唯一事实源：扁平的已选工具 id 列表。
 * 直接对应 AgentConfig.tools —— 保存原样落库、编辑原样回填，
 * 「只选组内一部分工具」的往返不丢失（旧的组派生模型会把部分选降级成散装工具）。
 * 组复选框是它的批量入口（全选 / 取消全选，三态），组内每个工具各有独立复选框。
 */
const selectedToolIds = ref<string[]>([]);

/**
 * 智能体工具面归一（编辑入口的 vision_gui 剔除层）。
 *
 * vision_gui 仅经「视觉操作」开关注入——数据层已剔除自定义记录的残留
 * （normalizeAgentConfig），装配层另有兜底（runtime-builder 的
 * applyVisionToggleToolSurface，覆盖插件/预置等未过归一的来源）；
 * 本函数是编辑边界层：工具组与外部工具选择器都不提供它的勾选入口，
 * 回填与保存两个方向统一剔除，保证：
 *   - 回显不出现「不属于任何组的 vision_gui」（否则会落进额外工具提示）；
 *   - 从预置/插件复制工具面时（来源可能含 vision_gui）草稿即干净；
 *   - 保存即收敛，旧数据经一次编辑彻底移除该残留。
 * 只剔除 vision_gui 这一个受控工具，其余工具（插件工具 / 历史散装工具）原样保留。
 */
function sanitizeAgentTools(ids: readonly string[]): string[] {
  return [...new Set(ids)].filter(id => id !== VISION_GUI_TOOL_ID);
}

/** emoji 选择卡片是否展开（与上传通道并列的第二条头像来源） */
const showEmojiPicker = ref(false);
/** 头像处理失败的可读文案（空串 = 无错误） */
const avatarError = ref('');
/** 图片头像放大查看的 data URL（空串 = 未打开） */
const avatarPreviewImage = ref('');

/** 当前头像是否为图片形态（决定预览尺寸：图片可点开放大，emoji 保持最小占位） */
const isImageAvatar = computed(() => form.avatar?.type === 'image');

/** 下载文件名：沿用智能体名（非法字符回落 avatar） */
const avatarFileName = computed(() => {
  const name = form.name.trim() || 'avatar';
  return `${name.replace(/[^\w.-]+/g, '_')}.png`;
});

/** 打开图片头像的放大查看层 */
function openAvatarPreview(): void {
  const avatar = form.avatar;
  if (!avatar || avatar.type !== 'image') return;
  avatarPreviewImage.value = avatar.src;
}

/** 从 emoji 悬浮卡片点选：写入 emoji 形态头像（与图片形态互斥）并收起卡片 */
function onEmojiPicked(emoji: string): void {
  form.avatar = { type: 'emoji', value: emoji };
  avatarError.value = '';
  showEmojiPicker.value = false;
}

/** 清除头像：回到无头像状态（UI 回退默认 emoji） */
function clearAvatar(): void {
  form.avatar = undefined;
  avatarError.value = '';
  avatarPreviewImage.value = '';
}

/**
 * 上传图片：经 processAvatarImage 智能裁剪 + 压缩到 1MB 内后写入 data URL。
 * 处理前清空 input.value，保证同一文件重复选择也能触发 change。
 */
async function onAvatarFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  avatarError.value = '';
  try {
    const dataUrl = await processAvatarImage(file);
    form.avatar = { type: 'image', src: dataUrl };
    showEmojiPicker.value = false;
  } catch (error) {
    avatarError.value =
      error instanceof Error && error.message === AVATAR_ERR_NOT_IMAGE
        ? t('hub.avatarUploadInvalid')
        : t('hub.avatarUploadFailed');
  }
}

/** 已选但不属于任何工具组的工具（插件工具 / 历史遗留工具），保存时原样保留 */
const extraTools = computed(() => {
  const inAnyGroup = new Set<string>();
  for (const tools of groupToolSets.values()) for (const id of tools) inAnyGroup.add(id);
  return selectedToolIds.value.filter(id => !inAnyGroup.has(id));
});
const missingSkillRefs = computed(() => form.skills.filter(ref => !skills.value.some(skill => skill.id === ref)));

/** 当前已选工具总数（扁平集合，直接对应保存的 tools 列表） */
const selectedToolCount = computed(() => selectedToolIds.value.length);

/** 组勾选状态（三态）：all=组内全部已选、some=部分选、none=全未选 */
function groupSelectionState(groupId: ToolScenario): 'none' | 'some' | 'all' {
  const tools = groupToolSets.get(groupId) ?? [];
  if (!tools.length) return 'none';
  let count = 0;
  for (const id of tools) if (selectedToolIds.value.includes(id)) count++;
  if (count === 0) return 'none';
  return count === tools.length ? 'all' : 'some';
}

/** 表单最终生效的分类 id（自定义创建态经归一化；空串 = 未分类） */
const resolvedCategory = computed(() =>
  form.category === CATEGORY_CUSTOM_VALUE ? normalizeCategory(form.customCategory) : form.category,
);

const isValid = computed(
  () =>
    form.name.trim().length > 0 &&
    form.description.trim().length > 0 &&
    form.system.trim().length > 0 &&
    selectedToolIds.value.length > 0 &&
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
const groupsInvalid = computed(() => attempted.value && selectedToolIds.value.length === 0);
const customCategoryInvalid = computed(
  () => attempted.value && form.category === CATEGORY_CUSTOM_VALUE && resolvedCategory.value.length === 0,
);

// ──── 标签编辑（chips 交互与上限反馈见 components/TagInput） ────

function resetForm(): void {
  form.name = '';
  form.description = '';
  form.system = '';
  form.category = '';
  form.customCategory = '';
  form.tags = [];
  selectedToolIds.value = [];
  form.skills = [];
  form.avatar = undefined;
  form.capabilities = undefined;
  form.visionEnabled = false;
  errorMessage.value = '';
  showLimitHint.value = false;
  attempted.value = false;
  showEmojiPicker.value = false;
  avatarError.value = '';
  avatarPreviewImage.value = '';
  groupQuery.value = '';
  skillQuery.value = '';
  detailCard.value = null;
  collapsedSections.groups = false;
  // 外部插件工具与关联技能默认收起（多数智能体不涉及，先让出空间给工具组）
  collapsedSections.external = true;
  collapsedSections.skills = true;
  toolView.value = 'tools';
  activeHelpPop.value = null;
}

function startCreate(): void {
  editingSource.value = null;
  editingExisting.value = false;
  resetForm();
  editing.value = true;
}

function copyPluginAgent(agent: AgentConfig): void {
  startCreate();
  const names = new Set(getAllAgents().map(a => a.name));
  const base = agent.name.slice(0, 20) + ' (copy)'; let name = base;
  for (let n = 2; names.has(name) && n < 1000; n++) name = base + n;
  form.name = name; form.description = agent.description; form.system = agent.system;
  form.tags = [...agent.tags];
  // 工具经归一化带入（扁平集合去重 + 剔除 vision_gui 残留；组状态由勾选集合派生）
  selectedToolIds.value = sanitizeAgentTools(agent.tools);
  form.skills = [...(agent.skills ?? [])]; form.category = agent.category; form.avatar = agent.avatar;
  form.capabilities = agent.capabilities ? structuredClone(agent.capabilities) : undefined;
  // 视觉操作声明随复制带入（与 startEdit 同口径）：否则复制视觉智能体会静默
  // 丢掉开关——新不变量下 vision_gui 由开关驱动，丢开关等于丢能力
  form.visionEnabled = !!agent.vision;
}

function startEdit(agent: AgentConfig): void {
  if (isPresetAgent(agent.id) || agent.plugin) return; // 预置不可编辑（防御）
  editingSource.value = agent;
  editingExisting.value = true;
  form.name = agent.name;
  form.description = agent.description;
  form.system = agent.system;
  form.tags = [...agent.tags];
  // 工具经归一化回填：部分选中的组在往返后保持部分选（旧派生规则会降级丢失），
  // 并剔除 vision_gui 历史残留（该工具仅经「视觉操作」开关注入，见 sanitizeAgentTools）
  selectedToolIds.value = sanitizeAgentTools(agent.tools);
  // 关联技能引用 → id 归一：v1 数据可能以名称 / 模型标识持久化，编辑时统一经
  // getSkillById（与运行时可用性解析同口径）转为当前记录 id，保证「勾选可见的」
  // 与「保存后生效的」完全一致，消除不可见关联的歧义；解析不到的悬挂引用
  // 保留失效引用：只修改其它字段时，不能静默删除插件配置。
  form.skills = [...(agent.skills ?? [])].reduce<string[]>((ids, ref) => {
    const resolved = getSkillById(ref);
    if (!resolved) {
      console.warn(`[AgentManager] 智能体 "${agent.name}" 关联的技能引用 "${ref}" 暂不可用，编辑表单保留该引用`);
      if (!ids.includes(ref)) ids.push(ref);
      return ids;
    }
    if (!ids.includes(resolved.id)) ids.push(resolved.id);
    return ids;
  }, []);
  form.visionEnabled = !!agent.vision;
  // 头像回填：图片（含历史预置图片与上传的 data URL）或 emoji 形态原样保留
  form.avatar = agent.avatar;
  form.capabilities = agent.capabilities
    ? structuredClone(agent.capabilities)
    : undefined;
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
  const tools = groupToolSets.get(groupId) ?? [];
  if (groupSelectionState(groupId) === 'all') {
    // 已全选 → 取消该组全部工具
    const removing = new Set(tools);
    selectedToolIds.value = selectedToolIds.value.filter(id => !removing.has(id));
    showLimitHint.value = false;
    return;
  }
  // 未全选（含部分选）→ 补齐该组全部工具
  const next = [...selectedToolIds.value];
  const owned = new Set(next);
  for (const toolId of tools) if (!owned.has(toolId)) next.push(toolId);
  if (next.length > MAX_TOOLS_PER_AGENT) {
    showLimitHint.value = true;
    return;
  }
  showLimitHint.value = false;
  selectedToolIds.value = next;
}

/**
 * 组内单个工具的勾选 / 取消（逐个勾选）。
 * 与整组勾选共用同一份扁平已选集合，因此「只选组内一部分」会被原样保留，
 * 重新打开时仍是部分选状态（旧派生规则会把部分选降级成散装工具而丢失组信息）。
 */
function toggleGroupTool(groupId: ToolScenario, toolId: string): void {
  if (isGroupLocked(groupId)) return;
  if (selectedToolIds.value.includes(toolId)) {
    selectedToolIds.value = selectedToolIds.value.filter(id => id !== toolId);
    showLimitHint.value = false;
    return;
  }
  if (selectedToolIds.value.length + 1 > MAX_TOOLS_PER_AGENT) {
    showLimitHint.value = true;
    return;
  }
  showLimitHint.value = false;
  selectedToolIds.value = [...selectedToolIds.value, toolId];
}

/** 工具是否已选（组内外统一口径） */
function isToolSelected(toolId: string): boolean {
  return selectedToolIds.value.includes(toolId);
}

function removeAgent(agent: AgentConfig): void {
  if (isPresetAgent(agent.id)) return;
  if (!window.confirm(t('hub.confirmDeleteAgent', { name: agent.name }))) return;
  const result = removeAgentConfig(agent.name);
  if (!result.ok) errorMessage.value = writeErrorText(result);
}

/**
 * 启用 / 停用智能体（预置、插件、自定义均可）。
 * 停用后该智能体不再出现在侧边栏输入框的 @ 选择器中，但仍在管理中心可见、可重新启用。
 * 存储层负责广播变更与跨上下文同步（自定义走记录本身，预置/插件走启停覆盖表）。
 */
function toggleEnabled(agent: AgentConfig, enabled: boolean): void {
  if (!setAgentEnabled(agent.id, enabled)) {
    errorMessage.value = t('hub.errorAgentToggle');
  }
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

async function save(): Promise<void> {
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

  // 工具集合归一后落库（扁平事实源，组内部分选中也原样保留；
  // vision_gui 残留最后防线——正常路径回填时已剔除，此处防御未来新增入口）
  const tools = sanitizeAgentTools(selectedToolIds.value);

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
    tools,
    skills: [...form.skills],
    category: resolvedCategory.value,
    tags: [...form.tags],
    ...(form.visionEnabled
      ? {
          // 视觉运行配置的两个字段都是内部常量：截图工具恒为 screenshot，
          // 「工具后重截图」恒开（视觉循环的心跳，关掉模型就看不到自己刚操作的页面）。
          // 编辑器不再暴露这两个控件，落库时直接写死。
          vision: {
            screenshotTool: 'screenshot',
            screenshotArgs: {},
            reScreenshotAfterTools: true,
          },
        }
      : {}),
    ...(avatar ? { avatar } : {}),
    ...(form.capabilities
      ? { capabilities: structuredClone(form.capabilities) }
      : {}),
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
  try { await replaceAgentSkillLinks(result.agent.id, config.skills ?? []); }
  catch (error) { errorMessage.value = String(error); return; }
  cancelEdit();
}
</script>
