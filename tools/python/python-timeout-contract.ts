/**
 * Python 执行超时契约（工具层 + 引擎层，单一事实源）
 *
 * 为什么单独成文件：超时由两层夹击，任何一层写死数字都会让另一层失效——
 *   1. 工具层（tools/python/python-run-tool.ts）：把 timeoutSeconds 传给后台
 *      Python 宿主，超时由宿主强制中断（KeyboardInterrupt），报错文案精确；
 *   2. 引擎层（entrypoints/sidepanel/core/conversation/conversation-engine.ts）：
 *      每个非交互工具的统一执行超时，决定「引擎最多挂多久」。
 * 引擎层若低于工具层，模型收到的是引擎的粗粒度超时文案而不是工具的精确
 * 超时文案（「代码执行超过 N 秒被强制中断」），且工具传的 timeoutSeconds
 * 形同虚设；因此引擎层对本工具按 pythonRunEngineTimeout 抬高（地板 = 上限
 * + 缓冲），判断依据就是这里的同一份常量。工具描述里的默认值/上限文案也由
 * 本文件渲染，避免三处漂移。
 *
 * 与页面脚本层（tools/common/page-exec-timeout.ts）同构：两处都是「工具声明
 * 了可达的超时上限，引擎就必须让那个上限真实可达」。
 */

import {
  PYTHON_RUN_DEFAULT_TIMEOUT_MS,
  PYTHON_RUN_MAX_TIMEOUT_MS,
} from '@/utils/pyodide/pyodide-config';

/**
 * python_run 的工具 id（单一事实源）。
 *
 * 引擎层的超时解析要按工具 id 分派（见 conversation-engine 的
 * resolveToolTimeout），字面量散落在多处迟早会漂移——工具改名而引擎层
 * 没跟着改，超时地板就静默失效（工具声明的上限变成纸面承诺）。
 */
export const PYTHON_RUN_TOOL_ID = 'python_run';

/**
 * 引擎层超时缓冲（毫秒）：注入、序列化、跨进程消息往返的固定开销。
 * 引擎计时器 = 工具声明的超时 + 本缓冲，保证工具自己的精确超时文案
 * （「代码执行超过 N 秒被强制中断」）永远先于引擎兜底到达模型。
 */
export const PYTHON_RUN_TIMEOUT_SAFETY_MS = 15_000;

/**
 * 引擎层单工具执行超时预算下限（毫秒）= 工具上限 + 缓冲。
 *
 * 为什么必须显式抬高：引擎默认 toolTimeoutMs 来自应用设置（默认 20 分钟、
 * 下限 1 分钟）。用户把它调到 1 分钟时，若引擎对本工具仍按统一上界掐断，
 * 工具侧 300s 的 timeout 上限就只是纸面承诺——模型按工具说明传 300000 却
 * 在 60s 收到引擎的粗粒度超时，说明与行为不一致。本常量是引擎对本工具
 * 承诺的**地板**（不是天花板）：实际引擎超时 = max(toolTimeoutMs, 本值)，
 * 应用设置更高时从设置。
 */
export const PYTHON_RUN_ENGINE_TIMEOUT_MS =
  PYTHON_RUN_MAX_TIMEOUT_MS + PYTHON_RUN_TIMEOUT_SAFETY_MS;

/** 工具层 timeoutSeconds 的合法区间（秒）——与工具层的钳制口径一致 */
const PYTHON_RUN_MIN_TIMEOUT_SECONDS = 5;

/**
 * 把任意 timeoutSeconds 入参归一为**工具层实际会采用**的秒数。
 * 不提供 / 非有限数 → 默认值；低于下限 → 下限；高于上限 → 上限。
 * 与工具层的钳制同口径，避免引擎按一个工具并不会采用的时长计时。
 */
export function normalizePythonRunTimeoutSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return PYTHON_RUN_DEFAULT_TIMEOUT_MS / 1000;
  }
  return Math.min(
    Math.max(value, PYTHON_RUN_MIN_TIMEOUT_SECONDS),
    PYTHON_RUN_MAX_TIMEOUT_MS / 1000,
  );
}

/**
 * 计算引擎层对该次调用的执行超时：
 *   max(引擎默认 toolTimeoutMs, 工具上限 + 缓冲, 本次 timeoutSeconds + 缓冲)
 * 参数形态不可信，按类型过滤；越界 timeoutSeconds 在工具层会被拒绝并回传
 * 模型自纠，这里再收敛一次，防止「绕过工具校验直达引擎」的路径把超大值
 * 注入引擎定时器。
 */
export function pythonRunEngineTimeout(args: unknown, defaultTimeoutMs: number): number {
  const base = Math.max(defaultTimeoutMs, PYTHON_RUN_ENGINE_TIMEOUT_MS);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return base;
  const raw = (args as { timeoutSeconds?: unknown }).timeoutSeconds;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return base;
  return Math.max(base, normalizePythonRunTimeoutSeconds(raw) * 1000 + PYTHON_RUN_TIMEOUT_SAFETY_MS);
}
