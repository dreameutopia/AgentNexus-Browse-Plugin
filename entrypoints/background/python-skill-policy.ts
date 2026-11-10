import { isSkillScriptSupportEnabled, watchPyodideEnv } from '@/utils/pyodide/pyodide-env';
import { PYTHON_HOST_SKILL_REVOKED, PYTHON_HOST_SKILL_STATUS } from '@/utils/pyodide/python-host-protocol';

/** Offscreen documents have runtime messaging but cannot read extension storage. */
export function initPythonSkillPolicy(): void {
  const hostUrl = chrome.runtime.getURL('screen-share-offscreen.html');
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== PYTHON_HOST_SKILL_STATUS || sender.id !== chrome.runtime.id || sender.url !== hostUrl) return false;
    void isSkillScriptSupportEnabled().then(respond);
    return true;
  });
  watchPyodideEnv((state, previous) => {
    if (previous.skillScriptsEnabled && !state.skillScriptsEnabled) {
      void chrome.runtime.sendMessage({ type: PYTHON_HOST_SKILL_REVOKED }).catch(() => undefined);
    }
  });
}
