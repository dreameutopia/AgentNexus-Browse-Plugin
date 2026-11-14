import type { PyodideEnvState } from './pyodide-env';
import type { PythonRunOutcome } from './pyodide-runtime';
import type { WorkspaceEntry, WorkspaceSnapshot } from '@/utils/python-workspace/paths';
import type { PythonScriptRequest } from './python-script-request';
import type { MicropipPackage } from './pyodide-micropip';
import { isWorkspaceOutput, WORKSPACE_MAX_ENTRIES } from '@/utils/python-workspace/paths';

export const PYTHON_HOST_RUN = 'agentnexus:python-host:run';
export const PYTHON_HOST_CANCEL = 'agentnexus:python-host:cancel';
/** 环境活性查询（宿主无 storage 访问权，经后台校验 environmentId 后应答复用清单） */
export const PYTHON_HOST_ENV_STATUS = 'agentnexus:python-host:env-status';
/**
 * 环境删除广播（管理中心「删除Python环境」后发送）：
 * 宿主收到后回收 Python Worker——内存文件系统里的包随回收清空，
 * 否则残留实例会让删除后的首次运行"带病"复用旧包。
 */
export const PYTHON_HOST_RESET = 'agentnexus:python-host:reset';

/**
 * 运行请求（新契约：一切执行都是「工作区内 .py 脚本」，没有内联 code，
 * 也没有 grant 字段——技能授权只存在于 skill_tool 的复制环节）。
 */
export interface PythonHostRun {
  type: typeof PYTHON_HOST_RUN;
  id: string;
  /** 会话工作区键（必填：执行与产物都绑定当前对话工作区） */
  chatId: string;
  script: PythonScriptRequest;
  /** pypi 依赖审批结果（仅 dependencyMode='pypi' 且非 preflight 时宿主要求为 true） */
  scriptDependencyApproved?: true;
  timeoutMs: number;
  state: PyodideEnvState;
}

export type PythonWorkerRun = Pick<PythonHostRun, 'chatId' | 'script' | 'timeoutMs' | 'state'> & {
  snapshot?: WorkspaceSnapshot;
  /**
   * micropip 复用清单（宿主经环境策略应答读取后传入；worker 无 chrome 访问权）。
   * 运行期网络已放开，脚本运行同样恢复复用包。
   */
  micropipManifest?: MicropipPackage[];
};
export type PythonHostResult = { outcome: PythonRunOutcome } | { error: string };
export type PythonWorkerResult = { outcome: PythonRunOutcome; entries?: WorkspaceEntry[] } | { error: string };
export type PythonHostPolicyResult = { allowed: boolean; micropipManifest?: MicropipPackage[] };

/** micropip 清单条目的宽松形态校验（入账前 pyodide-micropip 内还会再清洗一次） */
export function isMicropipPackage(value: unknown): value is MicropipPackage {
  if (!value || typeof value !== 'object') return false;
  const pkg = value as Partial<MicropipPackage>;
  return boundedText(pkg.name, 256) && boundedText(pkg.version, 256) &&
    (pkg.url === null || boundedText(pkg.url, 8192)) &&
    (pkg.sha256 === null || boundedText(pkg.sha256, 256)) &&
    typeof pkg.installedAt === 'number' && Number.isFinite(pkg.installedAt) && pkg.installedAt >= 0;
}

function boundedText(value: unknown, max = 262144): value is string { return typeof value === 'string' && value.length <= max; }

export function isPythonHostResult(value: unknown): value is PythonHostResult {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<{ error: unknown; outcome: PythonRunOutcome }>;
  if ('error' in response) return boundedText(response.error, 32000) && !('outcome' in response);
  const outcome = response.outcome;
  return !!outcome && typeof outcome.ok === 'boolean' && typeof outcome.timedOut === 'boolean' &&
    Number.isFinite(outcome.durationMs) && outcome.durationMs >= 0 &&
    boundedText(outcome.stdout) && boundedText(outcome.stderr) && boundedText(outcome.result) &&
    boundedText(outcome.errorName, 1024) && boundedText(outcome.errorDetail) &&
    (outcome.packageWarning === undefined || boundedText(outcome.packageWarning)) &&
    Array.isArray(outcome.autoLoadedPackages) && outcome.autoLoadedPackages.length <= 2048 && outcome.autoLoadedPackages.every(name => boundedText(name, 256)) &&
    (outcome.workspaceOutputs === undefined ||
      (Array.isArray(outcome.workspaceOutputs) && outcome.workspaceOutputs.length <= WORKSPACE_MAX_ENTRIES && outcome.workspaceOutputs.every(path => typeof path === 'string' && isWorkspaceOutput(path)))) &&
    (outcome.micropipPackages === undefined ||
      (Array.isArray(outcome.micropipPackages) && outcome.micropipPackages.length <= 2048 && outcome.micropipPackages.every(isMicropipPackage)));
}
