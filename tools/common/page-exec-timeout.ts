/**
 * 页面脚本共享超时契约（页面求值层 + 引擎外层，单一事实源）
 *
 * 为什么单独成文件：超时由两层夹击，任何一层写死数字都会让另一层失效——
 *   1. 工具层（tools/browser/page-exec-tool.ts）：页面内 Promise.race 等待脚本，
 *      决定「等多久放弃」；
 *   2. 引擎层（entrypoints/sidepanel/core/conversation/conversation-engine.ts）：
 *      每个非交互工具的统一执行超时，决定「引擎最多挂多久」。
 * 引擎层若低于工具层，模型收到的是引擎的粗粒度超时文案而不是工具的精确
 * 文案（「代码可能仍在运行，先检查现状」），且工具传的 timeout 形同虚设；
 * 因此引擎层对本工具按 pageExecEngineTimeout 抬高（地板 = MAX + 缓冲），
 * 判断依据就是这里的同一份常量。工具描述里的默认值/上限文案也由本文件
 * 渲染，避免三处漂移。
 */

/** 页面求值默认超时（毫秒）：未传 timeout 时的等待时长 */
export const PAGE_EXEC_DEFAULT_TIMEOUT_MS = 30_000;

/** 页面求值超时上限（毫秒）：模型可传的最大值，超出即参数校验失败 */
export const PAGE_EXEC_MAX_TIMEOUT_MS = 300_000;

/** 页面求值最小超时（毫秒）：低于此值几乎必然误判为超时 */
export const PAGE_EXEC_MIN_TIMEOUT_MS = 1_000;

/**
 * 把任意 timeout 入参归一为「可执行的毫秒值」。
 * 未提供 / 非有限数 → 默认值；低于下限 → 下限；高于上限 → 上限。
 * 与严格校验（validatePageExecTimeout）配合使用：校验负责拒绝非法入参，
 * 归一负责把合法但越界的值收敛到边界（与 readRef 的 offset/limit 同策略）。
 */
export function normalizePageExecTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return PAGE_EXEC_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(value, PAGE_EXEC_MIN_TIMEOUT_MS), PAGE_EXEC_MAX_TIMEOUT_MS);
}

/**
 * 严格校验：返回 null 表示合法，否则返回可读错误文案。
 * 越界（<1000 或 >300000）与非有限数一律拒绝——这是模型可控类参数错误，
 * 回传给模型自纠，比静默收敛更能暴露「模型以为自己传了 500000」的误解。
 */
export function validatePageExecTimeout(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `timeout 必须是 ${PAGE_EXEC_MIN_TIMEOUT_MS}..${PAGE_EXEC_MAX_TIMEOUT_MS} 毫秒的有限数字`;
  }
  if (value < PAGE_EXEC_MIN_TIMEOUT_MS || value > PAGE_EXEC_MAX_TIMEOUT_MS) {
    return `timeout 必须是 ${PAGE_EXEC_MIN_TIMEOUT_MS}..${PAGE_EXEC_MAX_TIMEOUT_MS} 毫秒（默认 ${PAGE_EXEC_DEFAULT_TIMEOUT_MS}）`;
  }
  return null;
}

/**
 * 引擎层超时缓冲（毫秒）：注入、序列化、跨进程消息往返的固定开销。
 * 引擎计时器 = 工具声明的 timeout + 本缓冲，保证工具自己的精确超时文案
 * （「代码可能仍在运行，先检查现状」）永远先于引擎兜底到达模型。
 */
export const PAGE_EXEC_TIMEOUT_SAFETY_MS = 15_000;

/**
 * 引擎层单工具执行超时预算上限（毫秒）= 工具上限 + 缓冲。
 *
 * 为什么必须显式抬高：引擎默认 toolTimeoutMs 来自应用设置（默认 30 分钟、
 * 下限 1 分钟）。用户把它调到 1 分钟时，若引擎对本工具仍按统一上界掐断，
 * 工具侧 300s 的 timeout 上限就只是纸面承诺——模型按工具说明传 300000 却
 * 在 60s 收到引擎的粗粒度超时，说明与行为不一致。本常量是引擎对本工具
 * 承诺的**地板**（不是天花板）：实际引擎超时 = max(toolTimeoutMs, 本值)，
 * 应用设置更高时从设置。
 */
/**
 * 引擎层单工具执行超时预算（毫秒）= 工具上限 + 缓冲。
 *
 * 为什么必须显式抬高：引擎默认 toolTimeoutMs 来自应用设置（默认 30 分钟、
 * 下限 1 分钟）。用户把它调到 1 分钟时，若引擎对本工具仍按统一上界掐断，
 * 工具侧 300s 的 timeout 上限就只是纸面承诺——模型按工具说明传 300000 却
 * 在 60s 收到引擎的粗粒度超时，说明与行为不一致。本常量是引擎对本工具
 * 承诺的**地板**（不是天花板）：实际引擎超时 = max(toolTimeoutMs, 本值)，
 * 应用设置更高时从设置。
 */
export const PAGE_EXEC_ENGINE_TIMEOUT_MS = PAGE_EXEC_MAX_TIMEOUT_MS + PAGE_EXEC_TIMEOUT_SAFETY_MS;

/**
 * 计算引擎层对该次调用的执行超时：
 *   max(引擎默认 toolTimeoutMs, 本次 timeout + 缓冲)
 * 参数形态不可信，按类型过滤；越界 timeout 在工具层会被拒绝并回传模型，
 * 这里再收敛一次，防止「绕过工具校验直达引擎」的路径（测试面板预填等）
 * 把超大值注入引擎定时器。
 */
export function pageExecEngineTimeout(args: unknown, defaultTimeoutMs: number): number {
  const base = Math.max(defaultTimeoutMs, PAGE_EXEC_ENGINE_TIMEOUT_MS);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return base;
  const raw = (args as { timeout?: unknown }).timeout;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return base;
  return Math.max(base, normalizePageExecTimeout(raw) + PAGE_EXEC_TIMEOUT_SAFETY_MS);
}
