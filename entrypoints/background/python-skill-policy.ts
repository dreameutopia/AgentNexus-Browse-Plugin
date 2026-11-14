import { getPyodideEnvState, watchPyodideEnv } from '@/utils/pyodide/pyodide-env';
import { PYTHON_HOST_ENV_STATUS, PYTHON_HOST_RESET, type PythonHostPolicyResult } from '@/utils/pyodide/python-host-protocol';
import { readMicropipManifest } from '@/utils/pyodide/pyodide-micropip';
import type { MicropipPackage } from '@/utils/pyodide/pyodide-micropip';

/**
 * 环境策略应答（离屏宿主 → 后台）：offscreen 没有 storage 访问权，
 * 每次运行前经本通道确认 environmentId 仍是当前环境且状态就绪，
 * 并顺带取回 micropip 复用清单（运行期网络已放开，所有运行统一恢复）。
 * 另监听环境变化广播：environmentId 切换（删除/重装）→ 通知宿主回收 Worker。
 */
export function initPythonEnvPolicy(): void {
  const hostUrl = chrome.runtime.getURL('screen-share-offscreen.html');
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== PYTHON_HOST_ENV_STATUS || sender.id !== chrome.runtime.id || sender.url !== hostUrl) return false;
    const read = async (): Promise<PythonHostPolicyResult> => {
      const state = await getPyodideEnvState();
      const environmentId = typeof message.environmentId === 'string' ? message.environmentId : '';
      const allowed = state.status === 'ready' && !!environmentId && environmentId === state.environmentId;
      if (!allowed) return { allowed };
      // 清单读取失败只意味着「本次不恢复」（回退空清单），绝不因此拒绝运行
      let micropipManifest: MicropipPackage[] | undefined;
      try {
        micropipManifest = await readMicropipManifest();
      } catch {
        micropipManifest = undefined;
      }
      return { allowed, micropipManifest };
    };
    void read().catch(() => ({ allowed: false })).then(respond).catch(() => undefined);
    return true;
  });
  watchPyodideEnv((state, previous) => {
    if (previous.environmentId !== state.environmentId) {
      void chrome.runtime.sendMessage({ type: PYTHON_HOST_RESET, environmentId: previous.environmentId }).catch(() => undefined);
    }
  });
}
