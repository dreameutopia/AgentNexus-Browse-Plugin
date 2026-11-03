/**
 * 内置笔记页主入口 - Vue 应用
 */
import './style.css';
// highlight.js 代码高亮配色（深色代码块主题）
import 'highlight.js/styles/github-dark.css';
import { createApp } from 'vue';
import App from './App.vue';
import { i18n, initI18n, t } from '@/utils/i18n';

const app = createApp(App);
app.use(i18n);

// 先恢复用户选择的语言再挂载，避免首屏闪错语言
initI18n()
  .catch((error) => console.error('[i18n] init failed:', error))
  .finally(() => {
    // 文档标题跟随语言
    document.title = t('notes.title');
    app.mount('#app');
  });
