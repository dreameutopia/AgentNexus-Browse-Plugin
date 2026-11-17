/**
 * Python 执行工具（python_run）——工作区脚本运行
 *
 * ==================== 职责边界（v3） ====================
 *
 * 唯一的 action 是 run：运行当前会话工作区内**已落库**的 .py 脚本
 * （cwd/argv/env/stdin/依赖声明齐备）。
 *
 * 工作区文件的创建、读取、编辑、删除、复制、盘点与搜索**统一由 file_util
 * 承担**——本工具不再暴露 create/edit/delete/read/list，避免同一份文件
 * 语义在两个工具间漂移。脚本报错时的正确做法是：
 *   file_util(action="read") 读回出错处 → file_util(action="edit") 定点修复
 *   → python_run(action="run") 再执行。
 *
 * 参数形状严格：未知键一律 PY_INVALID_ARGUMENTS。
 * 路径安全：run 的 path 经 isWorkspaceRelativePath（拒绝绝对路径/盘符/.. /
 * 反斜杠/控制符/首尾空白），执行以会话工作区为唯一根，无穿透出口。
 *
 * 执行链路：run → 环境就绪检查 → offscreen 宿主（PYTHON_HOST_RUN）→ worker
 * 执行工作区脚本 → revision CAS 落盘产物。
 *
 * ==================== 依赖契约前置判定 ====================
 *
 * 「这个包装不装得上」必须在**工具层**回答，而不是等 worker 跑完再抛一段
 * Python traceback：模型看到 traceback 学不到「该加 dependencyMode="pypi"
 * 还是该换标准库」。因此 run 之前先做契约判定（utils/pyodide/dependency-contract）：
 * 官方目录（Pyodide 锁文件）+ 已安装包（micropip 复用清单）为可用集合，
 * 声明的包不在集合内 → 直接返回带具体包名与具体下一步的错误。
 *
 * ==================== 错误码契约 ====================
 *
 * PY_INVALID_ARGUMENTS / PY_INVALID_SCRIPT / PY_FILE_NOT_FOUND / PY_CONTEXT /
 * PY_ENV_NOT_READY / PY_BOOT_FAILED / PY_DEPENDENCY_APPROVAL_REQUIRED /
 * PY_DEPENDENCY_UNRESOLVABLE / PY_INVALID_REQUEST / PY_EXEC_TIMEOUT /
 * PY_EXEC_ERROR / PY_EXEC_CANCELLED / PY_WORKSPACE_ERROR /
 * PY_WORKSPACE_RUNTIME / PY_HOST_BUSY / PY_CONTEXT_NOT_SUPPORTED /
 * PY_INTERNAL_ERROR。
 * 带 [PY_*] 前缀的抛错由 mapError 统一解码展示；[WORKSPACE_*] 由
 * toolErrorDetails 按码映射为 [PY_*]（只译错误码，不动用户内容）。
 */

import { workspaceArtifact } from '@/utils/python-workspace/artifact-contract';
import { errorDetails, toolErrorDetails } from '@/utils/shared/error-details';
import { BaseTool } from '../base-tool';
import { ToolExecutionContext, ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import {
  PYTHON_RUN_DEFAULT_TIMEOUT_MS,
  PYTHON_RUN_MAX_TIMEOUT_MS,
} from '@/utils/pyodide/pyodide-config';
import { normalizePythonRunTimeoutSeconds, PYTHON_RUN_TOOL_ID } from './python-timeout-contract';
import {
  PY_ERR_CONTEXT,
  PY_ERR_NOT_READY,
  PY_ERR_PYTHON,
  PY_ERR_TIMEOUT,
  getPackageCatalog,
  recordAutoLoadedPackages,
  recordCurrentMicropipPackages,
  type PythonRunOutcome,
} from '@/utils/pyodide/pyodide-runtime';
import { readMicropipManifest } from '@/utils/pyodide/pyodide-micropip';
import {
  evaluateRequirements,
  normalizePackageName,
  renderRequirementGuidance,
  summarizeRequirements,
} from '@/utils/pyodide/dependency-contract';
import { ensureOffscreenHost } from '@/utils/offscreen-host';
import { getPyodideEnvState } from '@/utils/pyodide/pyodide-env';
import { parsePythonScriptRequest, type PythonScriptRequest } from '@/utils/pyodide/python-script-request';
import {
  isPythonHostResult, PYTHON_HOST_CANCEL, PYTHON_HOST_RUN, type PythonHostRun,
} from '@/utils/pyodide/python-host-protocol';
import { assertWorkspaceScriptExists } from '@/utils/python-workspace/workspace-files';
import { WORKSPACE_SANDBOX_PRESET_DIRECTORIES } from '@/utils/python-workspace/workspace-directories';
import { WorkspaceMissingChatError } from '@/utils/python-workspace/paths';

/** 在途运行 id（kill 时统一撤销；幂等：已结束的 id 撤销为无操作） */
const activeRunIds = new Map<string, { chatId: string; signal?: AbortSignal }>();

/**
 * 每个 action 的参数白名单（单一事实源）。
 *
 * 为什么要按 action 分组而不是「全局允许集 + 跨 action 排除」：后者要求模型
 * 记住「哪些参数属于哪个 action」，出错时报错也只能说「不接受参数」而不说
 * 「这个 action 接受什么」。按 action 分组后：
 *   - 校验与回传用同一份表（错误信息直接回传该 action 的合法参数集）；
 *   - 新增 action 时只需加一行，不必在多处补排除逻辑。
 *
 * 与 ALLOWED_KEYS 的关系：ALLOWED_KEYS 是「全局认识的键」（用于识别拼写错误），
 * ACTION_PARAMS 是「本 action 允许的键」（用于识别串参）。前者答「这键存在吗」，
 * 后者答「这键在此 action 合法吗」——两者都要，缺一不可。
 */
const ACTION_PARAMS = {
  run: [
    'path', 'timeoutSeconds', 'module', 'cwd', 'argv', 'env', 'stdin',
    'preflight', 'dependencyMode', 'wheels', 'requirements',
  ],
} as const satisfies Record<string, readonly string[]>;

/** 严格参数形状：未知键一律拒绝（防拼写错误静默丢参，也防旧字段残留被忽略）。
 *  直接从 ACTION_PARAMS 派生（并集）——手工维护第二份清单迟早与白名单漂移。 */
const ALLOWED_KEYS = new Set<string>([
  'action',
  ...Object.values(ACTION_PARAMS).flatMap(keys => [...keys]),
]);

export class PythonRunTool extends BaseTool {
  name = PYTHON_RUN_TOOL_ID;

  metadata: ToolMetadata = {
    name: PYTHON_RUN_TOOL_ID,
    description:
      '运行会话工作区内已保存的 Python 脚本（Python 3.14 / Pyodide / WASM 沙箱；脚本的创建、读取、编辑、删除请用 file_util）',
    category: 'code',
    version: '4.0.0',
    author: 'AgentNexus',
    tags: ['python', 'pyodide', 'wasm', 'compute', 'data', 'pandas', 'numpy', 'workspace'],
  };

  requiresApprovalFor(args: unknown): boolean {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    const request = args as { action?: unknown; dependencyMode?: unknown; preflight?: unknown };
    return request.action === 'run' && request.dependencyMode === 'pypi' && request.preflight !== true;
  }

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: PYTHON_RUN_TOOL_ID,
      description:
        '运行当前会话工作区内已保存的 Python 脚本（Python 3.14 / Pyodide / WASM 沙箱，无终端与本地文件系统）。\n' +
        '<workflow>固定两步：① 用 file_util(action="create") 把脚本写入工作区（如 scripts/report.py）；② 用 run 执行该已存在的 .py。' +
        'run 不接受内联代码。脚本报错时用 file_util(action="read") 读回出错处 → file_util(action="edit") 定点修复 → 再 run；' +
        '不要重复执行同一条失败命令。文件的新建/读取/编辑/删除/复制/盘点/搜索全部由 file_util 承担，本工具只负责执行。' +
        '交付文件写 outputs/ 并在回复里输出 <workspace-file path="outputs/xxx.csv" />。</workflow>\n' +
        '<actions>run=执行工作区内已存在的 .py 脚本。</actions>\n' +
        '<dependencies>依赖有三条通道，声明与解析是两件事：' +
        '① 脚本同目录及项目根的 requirements.txt、PEP 723 元数据块与 pyproject.toml 会被自动发现，无需声明；' +
        '② 官方目录内的包（numpy、pandas、scipy、matplotlib、scikit-learn 等）按 import 自动加载，也无需声明；' +
        '③ 官方目录没有的纯 Python 包才需要显式声明：requirements=["包名"] 且 dependencyMode="pypi"——' +
        'requirements 声明「要什么」，dependencyMode="pypi" 才决定「从哪装」，两者缺一不可：' +
        '只给 requirements 而不给 dependencyMode="pypi"，该包在 catalog 模式下既不会被安装也不在官方目录内，运行必然失败。' +
        'dependencyMode="pypi" 会触发用户审批，且只支持纯 Python wheel；含 C 扩展的包只能用官方目录内的版本或自备兼容 .whl（wheels 指定）。' +
        '不确定某个包能否安装时，先 action="run" 加 preflight=true 做静态预检（不执行、不安装、不写工作区）。</dependencies>\n' +
        '<runtime>执行根目录为 /work-space/<chatId>/（脚本内可用 os.environ["AGENTNEXUS_WORKSPACE"] 定位）：相对路径读写工作区；' +
        `沙箱内已存在的一级目录为 ${WORKSPACE_SANDBOX_PRESET_DIRECTORIES.map((d) => d + '/').join('、')}，可直接 open(path, "w") 写入；` +
        '写更深层级时父目录不存在会抛 FileNotFoundError——脚本内先 os.makedirs(dir, exist_ok=True)；' +
        '脚本运行期可联网（fetch/HTTP 取数均可）。用 cwd、argv、env、stdin 传参（env 仅放非敏感配置）；包内入口可传 module（点分名，须与 path 指向同一文件）。' +
        '关闭文件、内存映射和数据库连接后再结束调用，输出文件优先用 with 管理；执行失败时丢弃未提交的工作区改动。' +
        '遇到不支持的内存映射、并行进程或系统命令，改用普通读写、分块和单进程 Python 实现；依赖必须支持 Pyodide/WASM；' +
        '避免用 JavaScript 桥接绕过工作区访问权限；确实无法安装时改用 csv/JSON 等标准库格式交付。' +
        'print() 的输出会随本次执行结果回显在 [stdout] 段——需要看输出直接看回显，不必把结果写进文件再读回；' +
        '打印中文/结果请直接 print()；复杂对象建议 print(json.dumps(..., ensure_ascii=False))。</runtime>\n' +
        '<paths>所有 path 都是相对当前对话工作区根目录的路径：禁止绝对路径、盘符与 ..，越界一律拒绝。' +
        '目录与结果区（inputs/、outputs/、results/ 等）的语义遵循全局会话工作区规范。</paths>',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['run'],
            description: 'run=运行工作区内已存在的 .py 脚本（文件操作请用 file_util）',
          },
          path: {
            type: 'string',
            description:
              '相对会话工作区根目录的脚本路径（如 scripts/report.py），必须是已存在的 .py；请先用 file_util 创建或编辑脚本。禁止绝对路径、盘符与 ..',
          },
          timeoutSeconds: {
            type: 'number',
            description: `仅 run：可选超时（秒），默认 ${PYTHON_RUN_DEFAULT_TIMEOUT_MS / 1000}，最大 ${PYTHON_RUN_MAX_TIMEOUT_MS / 1000}；超时会被强制中断`,
          },
          module: {
            type: 'string',
            description: '仅 run：点分模块名（对应 python -m），必须与 path 指向同一个文件',
          },
          cwd: {
            type: 'string',
            description: '仅 run：脚本当前目录，相对工作区根目录，"." 表示根目录；缺省为脚本所属项目目录',
          },
          argv: {
            type: 'array',
            items: { type: 'string' },
            description: '仅 run：脚本命令行参数，不含脚本名',
          },
          env: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: '仅 run：临时非敏感环境变量映射',
          },
          stdin: { type: 'string', description: '仅 run：脚本标准输入文本，省略时为 EOF' },
          preflight: {
            type: 'boolean',
            description: '仅 run：静态预检——不运行脚本、不安装依赖、不写工作区，输出依赖/环境变量/平台限制报告',
          },
          dependencyMode: {
            type: 'string',
            enum: ['catalog', 'pypi'],
            description:
              '仅 run：catalog=官方目录（默认）；pypi=公开 PyPI 解析（需用户审批）。用 requirements 声明官方目录没有的包时必须传 pypi',
          },
          wheels: {
            type: 'array',
            items: { type: 'string' },
            description: '仅 run：明确选用的工作区相对 .whl 路径，须兼容 Pyodide',
          },
          requirements: {
            type: 'array',
            items: { type: 'string' },
            description:
              '仅 run：官方目录没有的纯 Python 包，PEP 508 声明（如 ["pypdf>=5"]）。必须与 dependencyMode="pypi" 同时使用；不要传 URL、索引、VCS 或凭据',
          },
        },
        anyOf: [
          { properties: { action: { type: 'string', enum: ['run'] } }, required: ['action', 'path'] },
        ],
      },
    },
  };

  async execute(params: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
    try {
      // ── 1. 参数防御（模型/桥接参数不可信；形态错误不触碰任何存储） ──
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return this.buildError('PY_INVALID_ARGUMENTS',
          `参数必须是 JSON 对象（收到 ${params === null ? 'null' : Array.isArray(params) ? 'array' : typeof params}）`);
      }
      const args = params as Record<string, unknown>;
      const { action, path, timeoutSeconds } = args;
      // 严格参数形状先行：未知键（拼写错误、旧字段残留、桥接噪声）一律拒绝并点名
      const unknownKeys = Object.keys(args).filter(key => !ALLOWED_KEYS.has(key));
      if (unknownKeys.length) {
        return this.buildError('PY_INVALID_ARGUMENTS',
          `未知参数：${unknownKeys.join(', ')}。本工具仅接受 action 与按 action 分组的参数：${
            Object.entries(ACTION_PARAMS)
              .map(([name, keys]) => `${name}→${keys.join('/')}`)
              .join('；')
          }`);
      }
      // hasOwnProperty 而不是 `in`：`in` 会穿透原型链——action="constructor" /
      // "toString" / "__proto__" 都能命中 Object.prototype，随后索引白名单
      // 取到函数对象直接抛 TypeError，模型收到的却是「未预期异常」。
      if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(ACTION_PARAMS, action)) {
        return this.buildError('PY_INVALID_ARGUMENTS',
          `action 必须是 ${Object.keys(ACTION_PARAMS).join(' / ')} 之一（收到 ${JSON.stringify(String(action).slice(0, 40))}）`);
      }
      // 每个 action 有自己的参数白名单：跨 action 串参在此一次性拒绝，
      // 并回传该 action 允许的参数——模型据此无需猜测即可改对。
      // 类型标注为 readonly string[]：as const 的元组会让 includes 的形参
      // 窄化成字面量联合，传入任意键名时报类型错误。
      const allowed: readonly string[] = ACTION_PARAMS[action as keyof typeof ACTION_PARAMS];
      const stray = Object.keys(args).filter(key => key !== 'action' && !allowed.includes(key));
      if (stray.length) {
        return this.buildError('PY_INVALID_ARGUMENTS',
          `action="${action}" 不接受参数：${stray.join(', ')}（该 action 仅接受 ${allowed.join(', ')}）`);
      }
      // path 必填：run 只能执行已保存的脚本文件
      if (typeof path !== 'string' || !path) {
        return this.buildError('PY_INVALID_SCRIPT', 'run 需要 path（工作区相对 .py 路径）；请先用 file_util 创建脚本');
      }
      if (action === 'run' && timeoutSeconds !== undefined &&
          (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds))) {
        return this.buildError('PY_INVALID_ARGUMENTS',
          `timeoutSeconds 必须是有限数字（秒），收到 ${JSON.stringify(timeoutSeconds)}`);
      }

      // ── 2. 会话工作区上下文（所有 action 的硬前提） ──
      const chatId = context?.chatId;
      if (!chatId || typeof chatId !== 'string' || chatId.length > 255) {
        return this.buildError('PY_CONTEXT',
          'python_run 需要当前会话工作区（chatId）：脚本运行绑定当前对话的工作区根目录。请在会话内调用；无会话上下文的通道不支持本工具。');
      }

      // ── 3. 唯一分流：运行（offscreen 宿主）；文件操作统一由 file_util 承担 ──
      return await this.runScript(args, context, chatId);
    } catch (error) {
      return this.mapError(error, context);
    }
  }

  /** 强制终止：撤销全部在途运行（幂等；abort 信号路径已另行撤销，重复无害）。 */
  async kill(_args?: unknown, context?: ToolExecutionContext): Promise<void> {
    for (const [id, run] of activeRunIds) {
      if (context?.chatId && run.chatId !== context.chatId) continue;
      if (context?.signal && run.signal !== context.signal) continue;
      try {
        void chrome.runtime.sendMessage({ type: PYTHON_HOST_CANCEL, id }).catch(() => undefined);
      } catch {
        // chrome 通道不可用时放弃撤销：kill 的失败不得影响引擎结算
      }
      activeRunIds.delete(id);
    }
  }

  /**
   * 依赖契约前置判定（工具层，不等 worker 跑完）。
   *
   * 判据来源：官方目录（Pyodide 锁文件）+ 已安装包（micropip 复用清单）。
   * 只判定**显式 requirements 参数**：requirements.txt / PEP 723 / pyproject
   * 自动发现的依赖由 runner 判定（那三条通道的发现逻辑在 Python 侧，
   * 在此重复实现必然漂移）。
   *
   * 两个豁免：
   *   - preflight=true：干跑查询的语义就是「报告依赖状况」，报告本身就是
   *     产物，不得被前置判定拦下；
   *   - dependencyMode="pypi"：由 runner 的 micropip 实际解析，含 C 扩展的
   *     wheel 装不装得上只有它能诊断。
   *
   * 放在「存在性预检之后、环境检查之前」：脚本不存在是更根本的错误，
   * 先报它；脚本存在但依赖契约不成立时，这里给出带具体包名与具体下一步的
   * 结论，而不是让模型等 worker 跑完后收到一段 Python traceback。
   */
  private async checkDependencyContract(
    script: PythonScriptRequest,
  ): Promise<ToolResult | null> {
    if (script.preflight || script.dependencyMode !== 'catalog' || !script.requirements.length) return null;
    let catalog: Set<string>;
    let installed: Set<string>;
    try {
      catalog = new Set((await getPackageCatalog()).map((entry) => normalizePackageName(entry.name)));
      installed = new Set(
        (await readMicropipManifest()).map((entry) => normalizePackageName(entry.name)),
      );
    } catch (error) {
      // 判定是**增强**不是**闸门**：官方目录或复用清单读不出来时，
      // 绝不能把一次本可成功的运行拦下来——放行，失败仍由 runner 给出真实诊断。
      this.log('依赖契约预判跳过（目录/清单不可读）：' + errorDetails(error), 'warn');
      return null;
    }
    const summary = summarizeRequirements(
      evaluateRequirements(script.requirements, { catalog, installed, mode: script.dependencyMode }),
    );
    if (summary.allSatisfied) return null;
    return this.buildError('PY_DEPENDENCY_UNRESOLVABLE', renderRequirementGuidance(summary));
  }

  // ──── 脚本运行 ────

  private async runScript(
    args: Record<string, unknown>,
    context: ToolExecutionContext | undefined,
    chatId: string,
  ): Promise<ToolResult> {
    const { path, module, cwd, argv, env, stdin, preflight, dependencyMode, wheels, requirements, timeoutSeconds } = args;
    let script: PythonScriptRequest;
    try {
      script = parsePythonScriptRequest({ path, module, cwd, argv, env, stdin, preflight, dependencyMode, wheels, requirements });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 最常见的误用：把页面脚本（.js）交给 Python 运行器。给出唯一正确去向，
      // 而不是让模型在两种运行器之间反复试错。
      const wrongExtension =
        typeof path === 'string' && path.trim() && !path.trim().toLowerCase().endsWith('.py');
      return this.buildError(
        'PY_INVALID_SCRIPT',
        wrongExtension
          ? `${message}\npython_run 只执行工作区内的 .py 文件；页面内脚本请用 js_run(action="run", path="scripts/x.js")，纯数据整形可直接用 data_ref_tool。`
          : message,
      );
    }
    if (script.dependencyMode === 'pypi' && !script.preflight && !context?.toolApproved) {
      return this.buildError('PY_DEPENDENCY_APPROVAL_REQUIRED',
        '安装公开 PyPI 依赖需通过会话审批。也可使用官方目录（catalog）或兼容的本地 wheel。');
    }
    // 存在性预检（只读）：脚本缺失在工具层就以 PY_FILE_NOT_FOUND 呈现
    await assertWorkspaceScriptExists(chatId, script.path);

    // 依赖契约前置判定：官方目录外的包在 catalog 模式下必然装不上，
    // 在此给出带具体包名与具体下一步的结论（不等 worker 跑完再抛 traceback）
    const dependencyError = await this.checkDependencyContract(script);
    if (dependencyError) return dependencyError;

    const state = await getPyodideEnvState();
    if (state.status !== 'ready') {
      // 精准错误：把当前状态与唯一修复入口明确交给模型，要求它转告用户。
      // 环境已删除 / 未安装时，本工具可能仍被历史配置引用，必须在执行前拦截。
      const reason = state.status === 'idle'
        ? '尚未安装'
        : state.status === 'downloading'
          ? '正在安装中'
          : `异常（${state.lastError || '未知原因'}）`;
      return this.buildError(PY_ERR_NOT_READY,
        `Python 环境未就绪（${reason}）：如需 Python 相关能力，请提示用户前往管理中心的「Python 环境」页面下载并核验运行时，完成后重试；安装完成前不要重复调用 python_run。`);
    }
    try {
      await ensureOffscreenHost();
    } catch (error) {
      return this.buildError(PY_ERR_CONTEXT,
        `无法启动后台 Python 宿主：${error instanceof Error ? error.message : String(error)}`);
    }
    context?.signal?.throwIfAborted();

    // 超时归一与引擎层共用同一份契约（tools/python/python-timeout-contract.ts）：
    // 两层各写一套数字会让「引擎按 A 计时、工具按 B 中断」互相错位。
    const timeoutMs = Math.round(normalizePythonRunTimeoutSeconds(timeoutSeconds) * 1000);

    const id = crypto.randomUUID();
    const request: PythonHostRun = {
      type: PYTHON_HOST_RUN,
      id,
      chatId,
      script,
      timeoutMs,
      state,
      scriptDependencyApproved:
        script.dependencyMode === 'pypi' && !script.preflight && context?.toolApproved ? true : undefined,
    };
    activeRunIds.set(id, { chatId, signal: context?.signal });
    const cancel = () => {
      try { void chrome.runtime.sendMessage({ type: PYTHON_HOST_CANCEL, id }).catch(() => undefined); }
      catch (error) { this.log('Python 撤销通道不可用：' + errorDetails(error), 'error'); }
    };
    context?.signal?.addEventListener('abort', cancel, { once: true });
    try {
      const result: unknown = await chrome.runtime.sendMessage(request).catch(error => {
        throw new Error(`[${PY_ERR_CONTEXT}] 后台 Python 通道断开：${errorDetails(error)}`);
      });
      context?.signal?.throwIfAborted();
      if (!isPythonHostResult(result)) throw new Error(`[${PY_ERR_CONTEXT}] 后台 Python 执行环境未返回有效响应`);
      if ('error' in result) throw new Error(result.error);
      const outcome: PythonRunOutcome = result.outcome;
      if (outcome.autoLoadedPackages.length) void recordAutoLoadedPackages(outcome.autoLoadedPackages, state.environmentId).catch(error => this.log('包清单保存失败：' + errorDetails(error), 'error'));
      // worker 无 storage 访问权：micropip 探测结果回传到此（SW/侧边栏）再入清单
      if (outcome.micropipPackages?.length) void recordCurrentMicropipPackages(outcome.micropipPackages, state.environmentId).catch(error => this.log('micropip 清单保存失败：' + errorDetails(error), 'error'));

      if (outcome.timedOut) {
        return this.buildError(
          PY_ERR_TIMEOUT,
          `代码执行超过 ${timeoutMs / 1000} 秒被强制中断（KeyboardInterrupt）。请优化算法、减少数据量或分步执行`,
          outcome.stdout ? `\n中断前已输出：\n${outcome.stdout.slice(-2000)}` : undefined,
        );
      }
      if (!outcome.ok) {
        const combined = `${outcome.errorName ?? ''}\n${outcome.stderr ?? ''}\n${outcome.errorDetail ?? ''}`;
        // 依赖类失败占实际运行失败的大头：把「为什么失败 + 下一步怎么做」
        // 直接写进错误正文，避免模型反复盲试同一条路径
        const dependencyHint =
          /ScriptDependencyError|ModuleNotFoundError|No module named|Unsatisfied dependencies|micropip|Couldn't find a pure Python 3 wheel/i.test(
            combined,
          )
            ? '\n[依赖处置建议]\n' +
              '1. 数据落盘优先用标准库（csv/json/xml/zipfile）写出 outputs/*.csv|json——无需任何第三方包；\n' +
              '2. 生成 xlsx/docx/pptx 不要引入 Python 库：本轮工具清单提供对应专用工具时优先用（xlsx_tool 支持 sheets[].dataFiles 直接读取 results/ 数据文件零转录导出），否则用标准库写 csv/json；\n' +
              '3. 确需纯 Python 包时：requirements=["包名"] 且 dependencyMode="pypi"（会请求用户审批；安装成功后进入复用清单，后续无需重复声明）——两者必须同时给，只给 requirements 在默认 catalog 模式下必然失败；\n' +
              '4. 含 C 扩展的包只能在官方目录内使用，或把兼容 Pyodide 的 .whl 放进工作区并用 wheels=["xxx.whl"] 指定；\n' +
              '5. 不要原样重复调用失败的命令——先按上述顺序换方案。'
            : '';
        // 「脚本 import 的包不在官方目录」是最高频的失败根因，且报错本身
        // 只说「No module named」而不说「这个包装不上」——补一句根因，
        // 模型才知道该换包还是该加 dependencyMode，而不是反复 import 同一个包。
        const importRootCause = /No module named|ModuleNotFoundError/i.test(combined)
          ? '\n[根因] 该模块不在 Pyodide 官方目录内，默认不会安装。请改用官方目录内的包、' +
            '用 requirements=["包名"] 且 dependencyMode="pypi" 显式安装，或用标准库等价实现替代它。'
          : '';
        // 路径类失败（目录不存在 / 路径不是目录）：脚本直接写 MEMFS，open() 不会
        // 自动建父目录。没有这条指引时模型只看到裸 FileNotFoundError，转而去
        // file_util 建占位文件再重跑——绕两轮仍未解决根因。
        const pathHint =
          /FileNotFoundError|NotADirectoryError|IsADirectoryError/i.test(combined)
            ? '\n[路径处置建议]\n' +
              `1. 沙箱内已存在的一级目录：${WORKSPACE_SANDBOX_PRESET_DIRECTORIES.map((d) => d + '/').join('、')}——` +
              '写入这些目录下的文件可直接 open(path, "w")；\n' +
              '2. 写更深层级（如 outputs/2026/a.csv）时父目录不存在会抛 FileNotFoundError——' +
              '脚本内先 os.makedirs("outputs/2026", exist_ok=True) 再写；\n' +
              '3. 读到「不是目录」说明路径中的某一段是文件——先用 file_util(action="list") 看该目录的实际内容；\n' +
              '4. 不要用 file_util 建占位文件来「试出」目录是否存在——那是脚本 os.makedirs 的职责。'
            : '';
        const detail = [
          outcome.stderr ? '[stderr]\n' + outcome.stderr.slice(-2400) : '',
          outcome.errorDetail,
          // packageWarning 承载两类信息：锁文件包自动加载失败 + micropip 清单恢复警告
          outcome.packageWarning ? '依赖提示：' + outcome.packageWarning : '',
          importRootCause,
          pathHint,
          dependencyHint,
        ]
          .filter(Boolean).join('\n');
        return this.buildError(PY_ERR_PYTHON, `Python 执行出错：${outcome.errorName}`, `\n${detail}`);
      }
      this.log(`执行成功 (${outcome.durationMs}ms, 自动加载包: ${outcome.autoLoadedPackages.join(',') || '无'})`);
      const files = (outcome.workspaceOutputs ?? []).map(path => workspaceArtifact(path));
      return { ...this.buildSuccess(this.formatSuccess(outcome)), primary: 'content', data: { files } };
    } finally {
      context?.signal?.removeEventListener('abort', cancel);
      activeRunIds.delete(id);
    }
  }

  // ──── 结果与错误格式化 ────

  /** 成功输出：stdout / stderr / 结果 / 耗时 / 自动加载包 / micropip 复用清单 */
  private formatSuccess(outcome: PythonRunOutcome): string {
    const sections: string[] = ['✅ Python 执行成功', `耗时: ${outcome.durationMs}ms`];
    if (outcome.autoLoadedPackages.length > 0) {
      sections.push(`自动加载包: ${outcome.autoLoadedPackages.join(', ')}`);
    }
    if (outcome.micropipPackages?.length) {
      sections.push(`micropip 复用清单: ${outcome.micropipPackages.map(pkg => `${pkg.name} ${pkg.version}`).join(', ')}`);
    }
    if (outcome.packageWarning) sections.push(`依赖提示: ${outcome.packageWarning}`);
    if (outcome.workspaceOutputs?.length) {
      const paths = outcome.workspaceOutputs.slice(0, 30);
      sections.push(`\n[已保存的工作区产物]\n${paths.map(path => workspaceArtifact(path).marker).join('\n')}`);
      if (outcome.workspaceOutputs.length > paths.length) sections.push('更多产物可用 pathlib 列出。');
    }
    if (outcome.stdout) sections.push(`\n[stdout]\n${outcome.stdout}`);
    if (outcome.result) sections.push(`\n[result]\n${outcome.result}`);
    if (outcome.stderr) sections.push(`\n[stderr]\n${outcome.stderr}`);
    if (!outcome.stdout && !outcome.result && !outcome.stderr && !outcome.workspaceOutputs?.length) {
      sections.push('\n（代码无输出：如需查看变量请 print() 或在末尾写表达式）');
    }
    return sections.join('\n');
  }

  /**
   * 统一错误映射：带 [PY_*] 前缀的抛错按前缀解码为错误码 + 可读正文
   * （宿主、workspace-files、workspace-listing、运行时全部走同一约定）；
   * 会话缺失显式映射 PY_CONTEXT；中止优先；其余兜底为 PY_INTERNAL_ERROR
   * 并保留原始诊断文本（可分析、可定位，绝不吞掉原因）。
   */
  private mapError(error: unknown, context?: ToolExecutionContext): ToolResult {
    if (context?.signal?.aborted) return this.buildError('PY_EXEC_CANCELLED', 'Python 执行已取消');
    if (error instanceof WorkspaceMissingChatError) {
      return this.buildError('PY_CONTEXT', '会话不存在或已删除，无法访问其工作区');
    }
    const message = toolErrorDetails(error, 'PY');
    const matched = /^\[(PY_[A-Z0-9_]+)\]([\s\S]*)$/.exec(message);
    if (matched) return this.buildError(matched[1], matched[2].replace(/^ /, ''));
    this.log(`执行失败: ${message}`, 'error');
    return this.buildError('PY_INTERNAL_ERROR', `工具执行发生未预期异常：${message}`);
  }

  private buildSuccess(text: string): ToolResult {
    return { success: true, content: [{ type: 'text', text }], isError: false };
  }

  /** 构造统一格式（阶段错误码 + 可读信息）的错误结果 */
  private buildError(code: string, message: string, suffix?: string): ToolResult {
    return {
      success: false,
      error: `[${code}] ${message}${suffix ?? ''}`,
      content: [
        {
          type: 'text',
          text: `❌ [${code}] ${message}${suffix ?? ''}`,
        },
      ],
      isError: true,
    };
  }
}
