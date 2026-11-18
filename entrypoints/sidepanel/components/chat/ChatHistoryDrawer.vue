/**
 * 历史会话抽屉
 *
 * 面向用户的会话记录管理入口（数据来自转录引擎 / IndexedDB）：
 *   - 列表展示（标题 / 预览 / 智能体徽标 / 相对时间 / 消息数）
 *   - 点击加载续聊（select 事件，由 App.vue 切换 activeChatId）
 *   - 重命名（行内编辑）、删除（确认后级联删除消息）
 *   - 新会话（new-chat 事件）
 */

<template>
  <Transition name="drawer-fade">
    <div v-if="visible" class="history-drawer-overlay" @click.self="$emit('close')">
      <Transition name="drawer-slide" appear>
        <div ref="drawerRef" class="history-drawer">
          <div class="history-drawer-header">
            <h3>{{ t('sidepanel.app.historyDrawer') }}</h3>
            <div class="history-drawer-actions">
              <button class="history-new-btn" @click="$emit('new-chat')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z" fill="currentColor"/>
                </svg>
                {{ t('sidepanel.app.newChat') }}
              </button>
              <button class="history-close-btn" v-tip="t('common.close')" @click="$emit('close')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
                </svg>
              </button>
            </div>
          </div>

          <div class="history-drawer-body">
            <div v-if="loading" class="history-empty">{{ t('common.loading') }}</div>
            <div v-else-if="!sessions.length" class="history-empty">{{ t('sidepanel.app.historyEmpty') }}</div>
            <div v-else class="history-list">
              <div
                v-for="session in sessions"
                :key="session.chatId"
                class="history-item"
                :class="{ active: session.chatId === activeChatId }"
                @click="$emit('select', session.chatId)"
              >
                <!-- 行内重命名 -->
                <div v-if="renamingId === session.chatId" class="history-rename" @click.stop>
                  <input
                    v-model="renameValue"
                    :placeholder="session.title"
                    @keydown.enter="commitRename"
                    @keydown.esc="cancelRename"
                  />
                  <button class="rename-confirm" v-tip="t('common.confirm')" @click="commitRename">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9,16.17L4.83,12L3.41,13.41L9,19L21,7L19.59,5.59L9,16.17Z" fill="currentColor"/></svg>
                  </button>
                  <button class="rename-cancel" v-tip="t('common.cancel')" @click="cancelRename">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/></svg>
                  </button>
                </div>

                <template v-else>
                  <div class="history-item-title-row">
                    <span class="history-item-title">{{ session.title }}</span>
                    <span class="history-item-time">{{ formatRelativeTime(session.updatedAt) }}</span>
                  </div>
                  <!-- 会话标签：标题下方一行 chip；内置标签走 i18n，自定义标签原样展示 -->
                  <div v-if="session.tags?.length" class="history-item-tags">
                    <span
                      v-for="tag in session.tags"
                      :key="tag.id"
                      class="history-tag"
                      :class="{ 'history-tag--system': isSystemConversationTag(tag) }"
                      :title="tagText(tag)"
                    >{{ tagText(tag) }}</span>
                  </div>
                  <div class="history-item-preview">{{ session.lastMessagePreview || '—' }}</div>
                  <div class="history-item-meta">
                    <span
                      v-if="session.agentName || session.agentId"
                      class="history-badge agent"
                    >{{ agentDisplayName(session) }}</span>
                    <span class="history-item-count">{{ t('sidepanel.app.historyMessages', { count: session.messageCount }) }}</span>
                    <span class="history-item-ops" @click.stop>
                      <!-- 标签编辑：按钮组最左侧；行内展开，不遮挡列表 -->
                      <button
                        class="item-op"
                        :data-tag-edit="session.chatId"
                        v-tip="t('sidepanel.app.tagsEdit')"
                        :aria-label="t('sidepanel.app.tagsEdit')"
                        @click="startTagEdit(session)"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.5,3H13.8L21,10.2V18.5A2.5,2.5 0 0,1 18.5,21H5.5A2.5,2.5 0 0,1 3,18.5V5.5A2.5,2.5 0 0,1 5.5,3M7,7A1.5,1.5 0 0,0 8.5,8.5A1.5,1.5 0 0,0 7,10A1.5,1.5 0 0,0 5.5,8.5A1.5,1.5 0 0,0 7,7M17.5,12.5L11,19H8V16L14.5,9.5L17.5,12.5Z" fill="currentColor"/></svg>
                      </button>
                      <button class="item-op" v-tip="t('sidepanel.app.renameSession')" @click="startRename(session)">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87L20.71,7.04M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z" fill="currentColor"/></svg>
                      </button>
                      <button class="item-op danger" v-tip="t('common.delete')" @click="removeSession(session)">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z" fill="currentColor"/></svg>
                      </button>
                    </span>
                  </div>

                  <!-- 行内标签编辑器：点击标签按钮展开，保存/取消后收起 -->
                  <div
                    v-if="tagEditingId === session.chatId"
                    class="history-tag-editor"
                    @click.stop
                    @keydown.esc="onTagEditorEsc"
                  >
                    <div class="history-tag-editor-head">
                      <span class="history-tag-editor-title">{{ t('sidepanel.app.tagsTitle') }}</span>
                      <span class="history-tag-editor-count">{{ tagDraft.length }}/{{ MAX_CONVERSATION_TAGS }}</span>
                    </div>
                    <div class="history-tag-editor-chips">
                      <span
                        v-for="tag in tagDraft"
                        :key="tag.id"
                        class="history-tag"
                        :class="{ 'history-tag--system': isSystemConversationTag(tag) }"
                      >
                        {{ tagText(tag) }}
                        <button
                          type="button"
                          class="history-tag-remove"
                          :title="t('sidepanel.app.tagsRemove')"
                          :aria-label="t('sidepanel.app.tagsRemove')"
                          :disabled="tagSaving"
                          @click="removeTagFromDraft(tag.id)"
                        >
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/></svg>
                        </button>
                      </span>
                      <span v-if="!tagDraft.length" class="history-tag-editor-empty">{{ t('sidepanel.app.tagsEmpty') }}</span>
                    </div>
                    <div class="history-tag-editor-input-row">
                      <input
                        ref="tagInputRef"
                        v-model="tagInput"
                        class="history-tag-editor-input"
                        :placeholder="t('sidepanel.app.tagsPlaceholder')"
                        :maxlength="MAX_CONVERSATION_TAG_LABEL_LENGTH"
                        :disabled="tagSaving"
                        @input="tagError = ''"
                        @keydown.enter="onTagInputEnter"
                      />
                      <button
                        type="button"
                        class="history-tag-editor-add"
                        :disabled="tagSaving || !tagInput.trim() || tagDraft.length >= MAX_CONVERSATION_TAGS"
                        :title="t('sidepanel.app.tagsAdd')"
                        :aria-label="t('sidepanel.app.tagsAdd')"
                        @click="addTagToDraft"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z" fill="currentColor"/></svg>
                      </button>
                    </div>
                    <p v-if="tagError" class="history-tag-editor-error" role="alert">{{ tagError }}</p>
                    <div class="history-tag-editor-actions">
                      <button type="button" class="history-tag-editor-btn" :disabled="tagSaving" @click="cancelTagEditWithFocus">{{ t('sidepanel.app.tagsCancel') }}</button>
                      <button type="button" class="history-tag-editor-btn primary" :disabled="tagSaving" @click="saveTags">{{ t('sidepanel.app.tagsSave') }}</button>
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import { t } from '@/utils/i18n';
import {
  agentEngine,
  transcriptEngine,
  sessionDeletionEngine,
  type ChatSessionMeta,
} from '../../core';
import { showConfirm } from '../../composables/use-app-dialog';
import { useAgentDisplay } from '@/common/use-agent-display';
import {
  LEARN_CONVERSATION_TAG_ID,
  MAX_CONVERSATION_TAGS,
  MAX_CONVERSATION_TAG_LABEL_LENGTH,
  appendConversationTag,
  isSystemConversationTag,
  normalizeConversationTagLabel,
  normalizeConversationTags,
  type ConversationTag,
} from '@/utils/sessions/conversation-tags';

const { displayNameOf } = useAgentDisplay();

const props = defineProps<{
  visible: boolean;
  /** 当前活跃会话（高亮标记） */
  activeChatId?: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'select', chatId: string): void;
  (e: 'new-chat'): void;
  (e: 'deleted', chatId: string): void;
}>();

const sessions = ref<ChatSessionMeta[]>([]);
const loading = ref(false);
const renamingId = ref('');
const renameValue = ref('');
/** 抽屉根节点：用于编辑器关闭后把焦点还给触发按钮 */
const drawerRef = ref<HTMLElement | null>(null);

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 超过 7 天显示日期 */
const formatRelativeTime = (timestamp: number): string => {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return t('common.justNow');
  if (minutes < 60) return t('common.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('common.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  if (days <= 7) return t('common.daysAgo', { count: days });
  return new Date(timestamp).toLocaleDateString();
};

/**
 * 智能体徽标显示名：优先按稳定 ID 解析当前名称（智能体在 hub 改名后徽标跟随更新），
 * ID 失配（智能体已被删除）时退回会话落库时的名称——历史记录展示当时的使用事实。
 * 名称按当前语言渲染（预置智能体切换语言后徽标随之切换）。
 */
const agentDisplayName = (session: ChatSessionMeta): string => {
  if (!session.agentName && !session.agentId) return '';
  const agent = agentEngine.resolveRef(session.agentId, session.agentName);
  return agent ? displayNameOf(agent) : session.agentName;
};

const loadSessions = async () => {
  loading.value = true;
  try {
    const list = await transcriptEngine.listSessions({ limit: 100 });
    // 展示前统一归一化标签：历史/外部写入可能带重复、空标签或超长文本，
    // 模板与筛选逻辑只接受干净结构（写入口同样归一，这是读取侧兜底）
    sessions.value = list.map(session => {
      if (!session.tags) return session;
      const tags = normalizeConversationTags(session.tags);
      return tags.length > 0 ? { ...session, tags } : { ...session, tags: undefined };
    });
  } catch (error) {
    console.warn('[ChatHistoryDrawer] 加载会话列表失败:', error);
    sessions.value = [];
  } finally {
    loading.value = false;
  }
};

// 打开抽屉时刷新列表
watch(
  () => props.visible,
  visible => {
    if (visible) void loadSessions();
    else {
      renamingId.value = '';
      renameValue.value = '';
      cancelTagEdit();
    }
  },
);

// ──── 重命名 ────

const startRename = async (session: ChatSessionMeta) => {
  // 保存标签期间不切换编辑态：避免把已提交的草稿与行内输入框状态搅在一起
  if (tagSaving.value) return;
  // 与标签编辑互斥：同一行只保留一个编辑态，避免输入框互相抢焦点
  cancelTagEdit();
  renamingId.value = session.chatId;
  renameValue.value = session.title;
  await nextTick();
  const input = document.querySelector<HTMLInputElement>('.history-rename input');
  input?.focus();
  input?.select();
};

const commitRename = async () => {
  const chatId = renamingId.value;
  const title = renameValue.value.trim();
  renamingId.value = '';
  renameValue.value = '';
  if (!chatId || !title) return;
  const updated = await transcriptEngine.renameSession(chatId, title);
  if (updated) {
    const index = sessions.value.findIndex(s => s.chatId === chatId);
    if (index !== -1) sessions.value[index] = updated;
  }
};

const cancelRename = () => {
  renamingId.value = '';
  renameValue.value = '';
};

// ──── 标签编辑 ────

const tagEditingId = ref('');
const tagDraft = ref<ConversationTag[]>([]);
const tagInput = ref('');
const tagError = ref('');
const tagSaving = ref(false);
const tagInputRef = ref<HTMLInputElement | null>(null);

/** 标签展示文案：内置标签走 i18n，自定义标签原样展示 */
const tagText = (tag: ConversationTag): string =>
  tag.id === LEARN_CONVERSATION_TAG_ID
    ? t('sidepanel.app.tagsLearn')
    : tag.label ?? '';

const startTagEdit = async (session: ChatSessionMeta) => {
  if (tagSaving.value) return;
  // 与重命名互斥：同一行只保留一个编辑态，避免输入框互相抢焦点
  renamingId.value = '';
  renameValue.value = '';
  tagEditingId.value = session.chatId;
  tagDraft.value = session.tags ? session.tags.map(tag => ({ ...tag })) : [];
  tagInput.value = '';
  tagError.value = '';
  await nextTick();
  tagInputRef.value?.focus();
};

/** 收起编辑器并清空草稿（不处理焦点，供抽屉关闭等非交互路径使用） */
const resetTagEditor = () => {
  tagEditingId.value = '';
  tagDraft.value = [];
  tagInput.value = '';
  tagError.value = '';
};

const cancelTagEdit = () => resetTagEditor();

/** 把焦点还给触发标签编辑的按钮（保存/取消/Esc 后键盘用户不丢失位置） */
const focusTagEditButton = (chatId: string) => {
  if (!chatId) return;
  void nextTick(() => {
    const root = drawerRef.value;
    if (!root) return;
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-tag-edit]'));
    buttons.find(button => button.dataset.tagEdit === chatId)?.focus();
  });
};

/** 用户主动取消：收起并归还焦点 */
const cancelTagEditWithFocus = () => {
  const chatId = tagEditingId.value;
  resetTagEditor();
  focusTagEditButton(chatId);
};

/** 输入法组合中的 Enter/Esc 是候选词操作，不能当作提交/取消 */
const isComposingEvent = (event: KeyboardEvent): boolean =>
  event.isComposing || event.keyCode === 229;

const onTagInputEnter = (event: KeyboardEvent) => {
  if (isComposingEvent(event)) return;
  event.preventDefault();
  addTagToDraft();
};

const onTagEditorEsc = (event: KeyboardEvent) => {
  if (isComposingEvent(event)) return;
  event.stopPropagation();
  event.preventDefault();
  cancelTagEditWithFocus();
};

const addTagToDraft = () => {
  if (tagSaving.value) return;
  if (tagDraft.value.length >= MAX_CONVERSATION_TAGS) {
    tagError.value = t('sidepanel.app.tagsLimit', { count: MAX_CONVERSATION_TAGS });
    return;
  }
  const label = normalizeConversationTagLabel(tagInput.value);
  if (!label) {
    tagError.value = '';
    return;
  }
  if (tagDraft.value.some(tag => tag.label?.toLocaleLowerCase() === label.toLocaleLowerCase())) {
    tagError.value = t('sidepanel.app.tagsDuplicate');
    return;
  }
  tagDraft.value = appendConversationTag(tagDraft.value, label);
  tagInput.value = '';
  tagError.value = '';
  void nextTick(() => tagInputRef.value?.focus());
};

const removeTagFromDraft = (tagId: string) => {
  if (tagSaving.value) return;
  tagDraft.value = tagDraft.value.filter(tag => tag.id !== tagId);
  tagError.value = '';
};

const saveTags = async () => {
  const chatId = tagEditingId.value;
  if (!chatId || tagSaving.value) return;
  tagSaving.value = true;
  try {
    const updated = await transcriptEngine.setSessionTags(chatId, tagDraft.value);
    if (!updated) {
      tagError.value = t('sidepanel.app.tagsSaveFailed');
      return;
    }
    const index = sessions.value.findIndex(session => session.chatId === chatId);
    if (index !== -1) sessions.value[index] = updated;
    resetTagEditor();
    focusTagEditButton(chatId);
  } catch (error) {
    console.warn('[ChatHistoryDrawer] 保存会话标签失败:', error);
    tagError.value = t('sidepanel.app.tagsSaveFailed');
  } finally {
    tagSaving.value = false;
  }
};

// ──── 删除 ────

const removeSession = async (session: ChatSessionMeta) => {
  // 应用内非阻塞确认（与守卫确认条同一理由取代 window.confirm：
  // 原生同步模态会冻结 sidepanel 的 JS 线程，样式与按钮也无法定制）
  const confirmed = await showConfirm(
    t('sidepanel.app.deleteSessionConfirm', { title: session.title }),
    t('common.delete'),
    'warn',
  );
  if (!confirmed) return;
  try {
    // 走会话删除引擎（唯一编排入口）：转录级联 + 图片按引用回收 +
    // 计划墓碑 + 运行中止 + 孤儿图片兜底，散落调用必然漏删
    const result = await sessionDeletionEngine.deleteSession(session.chatId);
    if (result.issues.length > 0) {
      console.warn('[ChatHistoryDrawer] 删除会话存在非致命问题:', result.issues);
    }
    sessions.value = sessions.value.filter(s => s.chatId !== session.chatId);
    // 通知外层（若删除的是当前活跃会话，由 App 侧重置界面，避免悬挂的 activeChatId 产生孤儿记录）
    emit('deleted', session.chatId);
  } catch (error) {
    console.warn('[ChatHistoryDrawer] 删除会话失败:', error);
  }
};
</script>

<style scoped>
/* 抽屉样式随组件持有（scoped 对本组件模板元素生效）；
   此前样式放在 app.css 经 App.vue 的 <style scoped> 导入，作用域属性无法匹配
   子组件内部元素，导致整个抽屉样式失效 */
@import './chat-history-drawer.css';
</style>
