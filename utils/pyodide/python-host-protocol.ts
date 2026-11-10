import type { PyodideEnvState } from './pyodide-env';
import type { PythonRunOutcome } from './pyodide-runtime';
import type { WorkspaceEntry, WorkspaceSnapshot } from '@/utils/python-workspace/paths';
import type { PythonScriptRequest } from './python-script-request';
import type { MicropipPackage } from './pyodide-micropip';

export const PYTHON_HOST_RUN = 'agentnexus:python-host:run';
export const PYTHON_HOST_CANCEL = 'agentnexus:python-host:cancel';
export const PYTHON_HOST_SKILL_STATUS = 'agentnexus:python-host:skill-status';
export const PYTHON_HOST_SKILL_REVOKED = 'agentnexus:python-host:skill-revoked';
/**
 * 环境删除广播（管理中心「删除Python环境」后发送）：
 * 宿主收到后回收 Python Worker——内存文件系统里的包随回收清空，
 * 否则残留实例会让删除后的首次运行"带病"复用旧包。
 */
export const PYTHON_HOST_RESET = 'agentnexus:python-host:reset';

export interface PythonHostRun {
  type: typeof PYTHON_HOST_RUN;
  id: string;
  chatId?: string;
  code: string;
  script?: PythonScriptRequest;
  timeoutMs: number;
  state: PyodideEnvState;
}

export type PythonWorkerRun = Pick<PythonHostRun, 'chatId' | 'code' | 'script' | 'timeoutMs' | 'state'> & {
  snapshot?: WorkspaceSnapshot;
  /**
   * micropip 复用清单（宿主读取后传入；worker 无 chrome 访问权）。
   * 脚本模式不携带——脚本有独立依赖通道且 fetch 受限。
   */
  micropipManifest?: MicropipPackage[];
};
export type PythonHostResult = { outcome: PythonRunOutcome } | { error: string };
export type PythonWorkerResult = { outcome: PythonRunOutcome; entries?: WorkspaceEntry[] } | { error: string };

/** micropip 清单条目的宽松形态校验（入账前 pyodide-micropip 内还会再清洗一次） */
function isMicropipPackage(value: unknown): value is MicropipPackage {
  if (!value || typeof value !== 'object') return false;
  const pkg = value as Partial<MicropipPackage>;
  return typeof pkg.name === 'string' && typeof pkg.version === 'string' &&
    (pkg.url === null || typeof pkg.url === 'string') &&
    (pkg.sha256 === null || typeof pkg.sha256 === 'string') &&
    typeof pkg.installedAt === 'number';
}

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
      (Array.isArray(outcome.workspaceOutputs) && outcome.workspaceOutputs.every(path => typeof path === 'string'))) &&
    (outcome.micropipPackages === undefined ||
      (Array.isArray(outcome.micropipPackages) && outcome.micropipPackages.every(isMicropipPackage)));
}
