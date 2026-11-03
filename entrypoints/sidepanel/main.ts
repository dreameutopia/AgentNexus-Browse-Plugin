import { createApp } from 'vue';
import './styles/global.css';
import App from './views/App.vue';
import { i18n, initI18n } from '@/utils/i18n';
import { initConfigEngine } from './utils/config';
import { restoreCustomAgentsFromStorage } from '@/utils/agents/agent-store';
import { ensurePersistentStorage } from '@/utils/shared/storage-sync';
import { vTip } from './utils/ui/v-tip';

const app = createApp(App);
app.use(i18n);
// 自定义 tooltip（v-tip）：取代原生 title 的即时解释框
app.directive('tip', vTip);

// 启动顺序：
// 1. 恢复语言（避免首屏闪错语言）
// 2. 初始化配置持久化引擎（localStorage ↔ storage.local 对账，把被清理的配置找回来）
// 3. 恢复自定义智能体（chrome.storage 权威源；必须早于挂载，否则列表读到未恢复状态）
// 4. 请求持久化存储（unlimitedStorage 权限 + navigator.storage.persist，防自动逐出）
// 任一步失败都只记日志，不阻塞挂载（各存储内部已尽最大努力降级）。
initI18n()
  .catch((error) => console.error('[i18n] init failed:', error))
  .then(() => initConfigEngine())
  .catch((error) => console.error('[ConfigEngine] init failed:', error))
  .then(() => restoreCustomAgentsFromStorage())
  .catch((error) => console.error('[AgentStore] storage restore failed:', error))
  .then(() => ensurePersistentStorage())
  .catch((error) => console.error('[Storage] persist request failed:', error))
  .finally(() => app.mount('#app'));