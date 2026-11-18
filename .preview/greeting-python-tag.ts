/**
 * 预览入口：欢迎语 · Python 安装引导标签（GreetingPythonTag）
 *
 * 走生产组件路径（entrypoints/sidepanel/components/greeting/GreetingPythonTag.vue）
 * + 真实 pyodide-env 订阅（watchPyodideEnv / getPyodideEnvState），
 * 仅 chrome.storage 用内存桩模拟「跨上下文推送」：
 *   - 预览页按钮写 status=ready / idle 并广播 onChanged，标签应即时消失 / 重现；
 *   - 点击标签触发 open 事件（真实侧边栏由 App.vue 打开管理中心 #python）。
 */
import { createApp, h } from 'vue';
import GreetingPythonTag from '../entrypoints/sidepanel/components/greeting/GreetingPythonTag.vue';
import { PYODIDE_ENV_STORAGE_KEY } from '../utils/pyodide/pyodide-config';
import { i18n, setLocale } from '../utils/i18n';

setLocale('zh-CN');

// ── chrome.storage 内存桩（local 读写 + onChanged 广播，形态对齐真实 API） ──
type StorageChangeListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  area: string,
) => void;
const listeners = new Set<StorageChangeListener>();
const store: Record<string, unknown> = {};
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: async (key: string) => ({ [key]: store[key] }),
      set: async (patch: Record<string, unknown>) => {
        const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
        for (const [key, value] of Object.entries(patch)) {
          changes[key] = { oldValue: store[key], newValue: value };
          store[key] = value;
        }
        for (const listener of listeners) listener(changes, 'local');
      },
    },
    onChanged: {
      addListener: (listener: StorageChangeListener) => listeners.add(listener),
      removeListener: (listener: StorageChangeListener) => listeners.delete(listener),
    },
  },
};

function setHint(text: string): void {
  const el = document.getElementById('open-hint');
  if (el) el.textContent = text;
}

// 预览页控制台：模拟管理中心安装完成 / 删除环境的跨上下文推送
(globalThis as unknown as { __setPythonEnvStatus: (status: string) => Promise<void> }).__setPythonEnvStatus =
  async (status: string) => {
    await (chrome.storage.local.set as (patch: Record<string, unknown>) => Promise<void>)({
      [PYODIDE_ENV_STORAGE_KEY]: { status },
    });
    setHint(
      status === 'ready'
        ? '已推送 status=ready（安装完成）→ 标签应立即消失'
        : `已推送 status=${status} → 标签应重新出现`,
    );
  };

createApp({
  render: () =>
    h(GreetingPythonTag, {
      onOpen: () => setHint('已触发 open 事件（真实侧边栏里会打开管理中心 #python）'),
    }),
})
  .use(i18n)
  .mount('#tag-root');
