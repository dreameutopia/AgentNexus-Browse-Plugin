/**
 * 历史会话抽屉
 *
 * 面向用户的会话记录管理入口（数据来自转录引擎 / IndexedDB）：
 *   - 列表展示（标题 / 预览 / 智能体与技能徽标 / 相对时间 / 消息数）
 *   - 点击加载续聊（select 事件，由 App.vue 切换 activeChatId）
 *   - 重命名（行内编辑）、删除（确认后级联删除消息）
 *   - 新会话（new-chat 事件）
 */

<template>
  <Transition name="drawer-fade">
    <div v-if="visible" class="history-drawer-overlay" @click.self="$emit('close')">
      <Transition name="drawer-slide" appear>
        <div class="history-drawer">
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
                  <div class="history-item-preview">{{ session.lastMessagePreview || '—' }}</div>
                  <div class="history-item-meta">
                    <!-- 会话自身类型徽章（kind 由转录引擎落库；旧记录无 kind 归一为 chat 不显示） -->
                    <span
                      v-if="session.kind === 'site-learn'"
                      class="history-badge learn"
                    >{{ t('sidepanel.learn.sessionBadge') }}</span>
                    <span
                      v-if="session.agentName || session.agentId"
                      class="history-badge agent"
                    >{{ agentDisplayName(session) }}</span>
                    <span
                      v-for="skillName in session.skillNames"
                      :key="skillName"
                      class="history-badge skill"
                    >{{ skillDisplayName(skillName) }}</span>
                    <span class="history-item-count">{{ t('sidepanel.app.historyMessages', { count: session.messageCount }) }}</span>
                    <span class="history-item-ops" @click.stop>
                      <button class="item-op" v-tip="t('sidepanel.app.renameSession')" @click="startRename(session)">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87L20.71,7.04M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z" fill="currentColor"/></svg>
                      </button>
                      <button class="item-op danger" v-tip="t('common.delete')" @click="removeSession(session)">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z" fill="currentColor"/></svg>
                      </button>
                    </span>
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
  skillEngine,
  transcriptEngine,
  sessionDeletionEngine,
  type ChatSessionMeta,
} from '../../core';
import { showConfirm } from '../../composables/use-app-dialog';

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
 */
const agentDisplayName = (session: ChatSessionMeta): string => {
  if (!session.agentName && !session.agentId) return '';
  const agent = agentEngine.resolveRef(session.agentId, session.agentName);
  return agent ? agent.name : session.agentName;
};

/**
 * 技能徽标显示名：会话可能存技能 id（v2）或技能名（v1），统一解析为当前名称；
 * 技能已被删除时退回原始字符串（展示当时的使用事实，不留空白）。
 */
const skillDisplayName = (skillRef: string): string => {
  return skillEngine.get(skillRef)?.name ?? skillRef;
};

const loadSessions = async () => {
  loading.value = true;
  try {
    sessions.value = await transcriptEngine.listSessions({ limit: 100 });
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
    }
  },
);

// ──── 重命名 ────

const startRename = async (session: ChatSessionMeta) => {
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
