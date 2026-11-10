import type { PyodideEnvState } from './pyodide-env';
import type { PythonRunOutcome } from './pyodide-runtime';
import type { WorkspaceEntry, WorkspaceSnapshot } from '@/utils/python-workspace/paths';

export const PYTHON_HOST_RUN = 'agentnexus:python-host:run';
export const PYTHON_HOST_CANCEL = 'agentnexus:python-host:cancel';

export interface PythonHostRun {
  type: typeof PYTHON_HOST_RUN;
  id: string;
  chatId?: string;
  code: string;
  timeoutMs: number;
  state: PyodideEnvState;
}

export type PythonWorkerRun = Pick<PythonHostRun, 'chatId' | 'code' | 'timeoutMs' | 'state'> & {
  snapshot?: WorkspaceSnapshot;
};
export type PythonHostResult = { outcome: PythonRunOutcome } | { error: string };
export type PythonWorkerResult = { outcome: PythonRunOutcome; entries?: WorkspaceEntry[] } | { error: string };

export function isPythonHostResult(value: unknown): value is PythonHostResult {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<{ error: unknown; outcome: PythonRunOutcome }>;
  if ('error' in response) return typeof response.error === 'string';
  const outcome = response.outcome;
  return !!outcome && typeof outcome.ok === 'boolean' && typeof outcome.timedOut === 'boolean' &&
    Number.isFinite(outcome.durationMs) &&
    typeof outcome.stdout === 'string' && typeof outcome.stderr === 'string' && typeof outcome.result === 'string' &&
    typeof outcome.errorName === 'string' && typeof outcome.errorDetail === 'string' &&
    (outcome.packageWarning === undefined || typeof outcome.packageWarning === 'string') &&
    Array.isArray(outcome.autoLoadedPackages) && outcome.autoLoadedPackages.every(name => typeof name === 'string') &&
    (outcome.workspaceOutputs === undefined ||
      (Array.isArray(outcome.workspaceOutputs) && outcome.workspaceOutputs.every(path => typeof path === 'string')));
}
