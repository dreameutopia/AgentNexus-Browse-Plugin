import { runPythonInWorker } from '@/utils/pyodide/pyodide-runtime';
import type { PythonWorkerResult, PythonWorkerRun } from '@/utils/pyodide/python-host-protocol';
import { runWorkspaceScript } from '@/utils/pyodide/python-script';

self.onmessage = async (event: MessageEvent<PythonWorkerRun>) => {
  const port = event.ports[0];
  if (!port) return;
  const reply: (result: PythonWorkerResult) => void = port.postMessage.bind(port);
  const close = () => port.close();
  try {
    const { script, chatId, timeoutMs, state, snapshot, micropipManifest } = event.data;
    reply(await runPythonInWorker({
      chatId, timeoutMs, workerState: state, snapshot, micropipManifest,
      script: {
        preflight: script.preflight,
        run: (pyodide, loadImports, signal) => runWorkspaceScript(pyodide, script, loadImports, signal),
      },
    }));
  } catch (error) {
    reply({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    close();
  }
};
