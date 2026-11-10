import { runPythonInWorker } from '@/utils/pyodide/pyodide-runtime';
import type { PythonWorkerResult, PythonWorkerRun } from '@/utils/pyodide/python-host-protocol';

self.onmessage = async (event: MessageEvent<PythonWorkerRun>) => {
  const port = event.ports[0];
  if (!port) return;
  const reply: (result: PythonWorkerResult) => void = port.postMessage.bind(port);
  const close = port.close.bind(port);
  try {
    const { code, chatId, timeoutMs, state, snapshot } = event.data;
    reply(await runPythonInWorker(code, { chatId, timeoutMs, workerState: state, snapshot }));
  } catch (error) {
    reply({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    close();
  }
};
