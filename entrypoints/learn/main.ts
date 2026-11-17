/**
 * 网站任务学习页主入口。
 *
 * 独立页面只负责收集「学习目标 / 注意事项 / 学习智能体」；
 * 真正的会话由侧边栏创建并运行（见 utils/sessions/learn-launch-bridge）。
 */
import './learn.css';
import { createApp } from 'vue';
import App from './App.vue';
import { i18n, initI18n, t } from '@/utils/i18n';
import { restoreCustomAgentsFromStorage } from '@/utils/agents/agent-store';
import { restoreCustomSkillsFromStorage } from '@/utils/skills/skill-store';
import { ensurePersistentStorage } from '@/utils/shared/storage-sync';

const app = createApp(App);
app.use(i18n);

// 启动顺序：语言恢复 → 智能体/技能注册表对账 → 持久化保障 → 挂载
initI18n()
  .catch(error => console.error('[LearnPage] i18n init failed:', error))
  .then(() => restoreCustomAgentsFromStorage())
  .catch(error => console.error('[LearnPage] agent store restore failed:', error))
  .then(() => restoreCustomSkillsFromStorage())
  .catch(error => console.error('[LearnPage] skill store restore failed:', error))
  .then(() => ensurePersistentStorage())
  .catch(error => console.error('[LearnPage] persist request failed:', error))
  .finally(() => {
    document.title = t('learnPage.title');
    app.mount('#app');
  });
