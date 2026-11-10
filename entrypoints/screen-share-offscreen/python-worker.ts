import { runPythonInWorker } from '@/utils/pyodide/pyodide-runtime';
import type { PythonWorkerResult, PythonWorkerRun } from '@/utils/pyodide/python-host-protocol';
import { runWorkspaceScript } from '@/utils/pyodide/python-script';
import { createScriptNetwork } from '@/utils/pyodide/python-worker-globals';

self.onmessage = async (event: MessageEvent<PythonWorkerRun>) => {
  const port = event.ports[0];
  if (!port) return;
  const reply: (result: PythonWorkerResult) => void = port.postMessage.bind(port);
  const close = port.close.bind(port);
  try {
    const { code, script, chatId, timeoutMs, state, snapshot, micropipManifest } = event.data;
    const options: Parameters<typeof runPythonInWorker>[1] = { chatId, timeoutMs, workerState: state, snapshot };
    if (script) {
      const network = createScriptNetwork();
      options.script = {
        preflight: script.preflight, network,
        run: (pyodide, loadImports, signal) => runWorkspaceScript(pyodide, script, loadImports, signal, network.withPublicIndex),
      };
      // 脚本模式不恢复 micropip 清单（独立依赖通道 + fetch 受限，双保险：宿主已不传）
    } else if (micropipManifest) {
      options.micropipManifest = micropipManifest;
    }
    reply(await runPythonInWorker(code, options));
  } catch (error) {
    reply({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    close();
  }
};
