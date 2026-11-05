/**
 * 管理中心（Hub）主入口 - Vue 应用
 *
 * 独立管理页：智能体与技能的完整配置。与 sidepanel 共享同一份数据
 * （chrome.storage 权威源 + 跨上下文实时同步），保存即刻生效于对话侧。
 */
import './hub.css';
// 插件中心的视觉层独立成文件（与 hub.css 同为页面级样式，由入口统一引入）
import './plugins/plugin-center.css';
import { createApp } from 'vue';
import App from './App.vue';
import { i18n, initI18n, t } from '@/utils/i18n';
import { restoreCustomAgentsFromStorage } from '@/utils/agents/agent-store';
import { restoreCustomSkillsFromStorage } from '@/utils/skills/skill-store';
import { ensurePersistentStorage } from '@/utils/shared/storage-sync';

const app = createApp(App);
app.use(i18n);

// 启动顺序：语言恢复 → 存储权威源对账（对齐 sidepanel 侧最新数据）→ 持久化保障 → 挂载
initI18n()
  .catch((error) => console.error('[Hub] i18n init failed:', error))
  .then(() => restoreCustomAgentsFromStorage())
  .catch((error) => console.error('[Hub] agent store restore failed:', error))
  .then(() => restoreCustomSkillsFromStorage())
  .catch((error) => console.error('[Hub] skill store restore failed:', error))
  .then(() => ensurePersistentStorage())
  .catch((error) => console.error('[Hub] persist request failed:', error))
  .finally(() => {
    document.title = t('hub.title');
    app.mount('#app');
  });
