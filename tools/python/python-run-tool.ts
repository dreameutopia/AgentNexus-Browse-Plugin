/**
 * Python 执行工具（python_run）——会话工作区文件管理 + 脚本运行
 *
 * ==================== 新设计（v2，无兼容包袱） ====================
 *
 * 四个 action，全部基于**当前对话的工作区**（根目录 /work-space/<chatId>/）：
 *   - create：新建文件（content 全文，已存在则拒绝）
 *   - edit：修改文件（content 全量重写，或 find+replace 就地替换——精确匹配、
 *     默认唯一命中、replaceAll 可全量替换；非 UTF-8 / 超大文件拒绝就地编辑）
 *   - delete：删除文件（目录一律拒绝）
 *   - run：运行工作区内**已落库**的 .py 脚本（cwd/argv/env/stdin/依赖声明齐备）
 *
 * 工作流契约（描述层强制教学）：先创建脚本文件，再运行——没有内联 code 通道；
 * 脚本报错用 edit 修，不 delete 重建。参数形状严格：未知键一律 PY_INVALID_ARGUMENTS。
 * 路径安全：所有 path 经 isWorkspaceRelativePath（拒绝绝对路径/盘符/.. /反斜杠/
 * 控制符/首尾空白），文件操作与执行都以会话工作区为唯一根，无穿透出口。
 *
 * 执行链路：run → 环境就绪检查 → offscreen 宿主（PYTHON_HOST_RUN）→ worker
 * 执行工作区脚本 → revision CAS 落盘产物。文件操作在本上下文直接经
 * workspace store 完成（同一把 withWorkspaceLock 与运行互斥）。
 *
 * ==================== 错误码契约 ====================
 *
 * PY_INVALID_ARGUMENTS / PY_INVALID_PATH / PY_INVALID_CONTENT / PY_INVALID_EDIT /
 * PY_FILE_EXISTS / PY_FILE_NOT_FOUND / PY_DELETE_DIRECTORY / PY_FILE_TOO_LARGE /
 * PY_INVALID_SCRIPT / PY_CONTEXT / PY_ENV_NOT_READY / PY_BOOT_FAILED /
 * PY_DEPENDENCY_APPROVAL_REQUIRED / PY_INVALID_REQUEST / PY_EXEC_TIMEOUT /
 * PY_EXEC_ERROR / PY_EXEC_CANCELLED / PY_WORKSPACE_ERROR / PY_WORKSPACE_RUNTIME /
 * PY_HOST_BUSY / PY_CONTEXT_NOT_SUPPORTED / PY_INTERNAL_ERROR。
 * 带 [PY_*] 前缀的抛错由 mapError 统一解码展示。
 */

import { executeWorkspaceFileAction, WORKSPACE_EDIT_PROPERTIES } from '@/utils/python-workspace/file-action';
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
import {
  PY_ERR_CONTEXT,
  PY_ERR_NOT_READY,
  PY_ERR_PYTHON,
  PY_ERR_TIMEOUT,
  recordAutoLoadedPackages,
  recordCurrentMicropipPackages,
  type PythonRunOutcome,
} from '@/utils/pyodide/pyodide-runtime';
import { ensureOffscreenHost } from '@/utils/offscreen-host';
import { getPyodideEnvState } from '@/utils/pyodide/pyodide-env';
import { parsePythonScriptRequest, type PythonScriptRequest } from '@/utils/pyodide/python-script-request';
import {
  isPythonHostResult, PYTHON_HOST_CANCEL, PYTHON_HOST_RUN, type PythonHostRun,
} from '@/utils/pyodide/python-host-protocol';
import {
  assertWorkspaceScriptExists,
} from '@/utils/python-workspace/workspace-files';

/** 在途运行 id（kill 时统一撤销；幂等：已结束的 id 撤销为无操作） */
const activeRunIds = new Map<string, { chatId: string; signal?: AbortSignal }>();

const RUN_ONLY_KEYS = [
  'timeoutSeconds', 'module', 'cwd', 'argv', 'env', 'stdin',
  'preflight', 'dependencyMode', 'wheels', 'requirements',
] as const;
const FILE_ONLY_KEYS = ['content', 'find', 'replace', 'replaceAll', 'edits', 'matchMode', 'expectedHash'] as const;
/** 严格参数形状：未知键一律拒绝（防拼写错误静默丢参，也防旧字段残留被忽略） */
const ALLOWED_KEYS = new Set<string>(['action', 'path', ...RUN_ONLY_KEYS, ...FILE_ONLY_KEYS]);

export class PythonRunTool extends BaseTool {
  name = 'python_run';

  metadata: ToolMetadata = {
    name: 'python_run',
    description: '会话工作区文件管理 + Python 脚本运行（create/edit/delete/run；先创建脚本文件，再运行）',
    category: 'code',
    version: '2.0.0',
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
      name: 'python_run',
      description:
        '在当前会话工作区中管理文件并运行 Python 脚本（Python 3.14 / Pyodide / WASM 沙箱，无终端与本地文件系统）。' +
        '工作流固定为「先创建脚本文件，再运行」：用 action="create" 把脚本写入工作区（如 scripts/report.py），用 action="run" 执行；' +
        '修改文件用 action="edit"——局部改动优先 find+replace 就地替换（find 须与文件内容逐字符精确匹配，含缩进、空白与换行，默认要求唯一命中，可加 replaceAll=true 替换全部命中），多处修改可用 edits 原子批量替换，复杂缩进可显式 matchMode="indentation"；expectedHash 可防覆盖并发改动。只有大改才用 content 全量重写；删除用 action="delete"。' +
        '运行只接受已落库的文件（create 写入、技能 copy 或上次运行保存的），不支持内联代码或直接执行命令。' +
        '脚本报错时用 edit 修复出错处后重新 run，不要 delete 后重建。' +
        '所有 path 都是相对当前对话工作区根目录的路径：禁止绝对路径、盘符与 ..，越界一律拒绝。' +
        '交付文件按全局会话工作区规范保存到 outputs/。' +
        '运行（action="run"，path 须为工作区内已存在的 .py）：依赖三通道——脚本同目录及项目根的 requirements.txt、PEP 723 元数据块与 pyproject.toml 会自动发现；' +
        '官方目录内的包（numpy、pandas、scipy、matplotlib、scikit-learn 等）按 import 自动加载（首次使用需下载）；' +
        '官方目录没有的纯 Python 包用 requirements 参数声明：默认 catalog 模式，经用户审批可用 dependencyMode="pypi" 从公开 PyPI 解析' +
        '（仅纯 Python wheel；含 C 扩展的包必须在官方目录内或提供兼容的本地 wheels）。' +
        'micropip 安装过的包进入复用清单，后续运行直接 import 即可（管理中心可查看；默认跨浏览器重启全局复用）。' +
        '脚本运行期可联网（fetch/HTTP 取数均可）。用 cwd、argv、env、stdin 传参（env 仅放非敏感配置）；包内入口可传 module（点分名，须与 path 指向同一文件）。' +
        '建议先 preflight=true 静态预检依赖、环境变量与平台限制（不执行、不安装、不写工作区），再正式运行。' +
        '执行根目录为 /work-space/<chatId>/（脚本内可用 os.environ["AGENTNEXUS_WORKSPACE"] 定位）：相对路径读写 inputs/、outputs/；' +
        '关闭文件、内存映射和数据库连接后再结束调用，输出文件优先用 with 管理；执行失败时丢弃未提交的工作区改动。' +
        '遇到不支持的内存映射、并行进程或系统命令，改用普通读写、分块和单进程 Python 实现；依赖必须支持 Pyodide/WASM；' +
        '避免用 JavaScript 桥接绕过工作区访问权限；确实无法安装时改用 csv/JSON 等标准库格式交付。' +
        '打印中文/结果请直接 print()；复杂对象建议 print(json.dumps(..., ensure_ascii=False))。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'path'],
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'edit', 'delete', 'run'],
            description: 'create=新建文件；edit=修改文件；delete=删除文件；run=运行工作区 .py 脚本',
          },
          path: {
            type: 'string',
            description: '相对会话工作区根目录的路径（如 scripts/report.py）；禁止绝对路径、盘符与 ..',
          },
          content: {
            type: 'string',
            description: '仅 create（必填，文件全文，可为空串）与 edit（全量重写；局部改动优先 find+replace）：文件内容',
          },
          find: {
            type: 'string',
            description: '仅 edit：定位串——须与文件内容逐字符精确匹配（含缩进、空白与换行），与 replace 同时提供',
          },
          replace: {
            type: 'string',
            description: '仅 edit：替换文本（可为空串表示删除命中段），与 find 同时提供',
          },
          replaceAll: {
            type: 'boolean',
            description: '仅 edit：true 时替换全部命中（默认 false，要求唯一命中）；只能与 find+replace 一起使用',
          },
          ...WORKSPACE_EDIT_PROPERTIES,
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
            description: '仅 run：catalog=官方目录（默认）；pypi=公开 PyPI 解析（需用户审批）',
          },
          wheels: {
            type: 'array',
            items: { type: 'string' },
            description: '仅 run：明确选用的工作区相对 .whl 路径，须兼容 Pyodide',
          },
          requirements: {
            type: 'array',
            items: { type: 'string' },
            description: '仅 run：补充确认过的 PEP 508 依赖，例如 pypdf>=5。不要传 URL、索引、VCS 或凭据',
          },
        },
        anyOf: [
          { properties: { action: { type: 'string', enum: ['create'] } }, required: ['action', 'path', 'content'] },
          { properties: { action: { type: 'string', enum: ['edit'] } }, required: ['action', 'path'] },
          { properties: { action: { type: 'string', enum: ['delete'] } }, required: ['action', 'path'] },
          { properties: { action: { type: 'string', enum: ['run'] } }, required: ['action', 'path'] },
        ],
      },
    },
  };

  async execute(params: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
    try {
      // ── 1. 参数防御（模型/桥接参数不可信；形态错误不触碰任何存储） ──
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return this.buildError('PY_INVALID_ARGUMENTS', '参数必须是 JSON 对象');
      }
      const args = params as Record<string, unknown>;
      const { action, path, content, find, replace, replaceAll, timeoutSeconds } = args;
      // 严格参数形状先行：未知键（拼写错误、旧字段残留、桥接噪声）一律拒绝并点名
      const unknownKeys = Object.keys(args).filter(key => !ALLOWED_KEYS.has(key));
      if (unknownKeys.length) {
        return this.buildError('PY_INVALID_ARGUMENTS',
          `未知参数：${unknownKeys.join(', ')}。本工具仅接受 action、path、content、find、replace、replaceAll 与 run 专用参数（timeoutSeconds/module/cwd/argv/env/stdin/preflight/dependencyMode/wheels/requirements）`);
      }
      if (action !== 'create' && action !== 'edit' && action !== 'delete' && action !== 'run') {
        return this.buildError('PY_INVALID_ARGUMENTS',
          `action 必须是 create / edit / delete / run 之一（收到 ${JSON.stringify(String(action).slice(0, 40))}）`);
      }
      if (typeof path !== 'string' || !path) {
        return action === 'run'
          ? this.buildError('PY_INVALID_SCRIPT', 'run 需要 path（工作区相对 .py 路径）')
          : this.buildError('PY_INVALID_PATH', 'path 必填：相对会话工作区根目录的路径');
      }
      const strayRun = RUN_ONLY_KEYS.filter(key => args[key] !== undefined);
      if (action !== 'run' && strayRun.length) {
        return this.buildError('PY_INVALID_ARGUMENTS',
          `action="${action}" 不接受运行参数：${strayRun.join(', ')}（这些参数仅用于 action="run"）`);
      }
      const strayFile = FILE_ONLY_KEYS.filter(key => args[key] !== undefined);
      if (action === 'run' && strayFile.length) {
        return this.buildError('PY_INVALID_ARGUMENTS',
          `action="run" 不接受文件参数：${strayFile.join(', ')}（写文件请用 create/edit）`);
      }
      if (action === 'delete' && strayFile.length) {
        return this.buildError('PY_INVALID_ARGUMENTS', `action="delete" 不接受参数：${strayFile.join(', ')}`);
      }
      if (action === 'create' && FILE_ONLY_KEYS.filter(key => key !== 'content').some(key => args[key] !== undefined)) {
        return this.buildError('PY_INVALID_ARGUMENTS',
          'action="create" 只接受 content（新建全文）；修改已有文件请用 action="edit"');
      }
      if (action === 'create' && content === undefined) {
        return this.buildError('PY_INVALID_ARGUMENTS', 'action="create" 需要 content（文件全文，可为空串）');
      }
      if (action !== 'edit' && replaceAll !== undefined) {
        return this.buildError('PY_INVALID_ARGUMENTS', 'replaceAll 仅用于 action="edit"');
      }
      if (replaceAll !== undefined && typeof replaceAll !== 'boolean') {
        return this.buildError('PY_INVALID_ARGUMENTS', 'replaceAll 必须是布尔值');
      }
      if (action === 'edit' && content === undefined && find === undefined && replace === undefined && args.edits === undefined) {
        return this.buildError('PY_INVALID_ARGUMENTS',
          'action="edit" 需要 content（全量重写）或 find+replace（就地替换，可加 replaceAll）');
      }
      if ((find === undefined) !== (replace === undefined)) {
        return this.buildError('PY_INVALID_ARGUMENTS', 'find 与 replace 必须同时提供');
      }
      if (replaceAll === true && (find === undefined || replace === undefined)) {
        return this.buildError('PY_INVALID_ARGUMENTS', 'replaceAll 只能与 find+replace 一起使用');
      }
      if (replaceAll === true && content !== undefined) {
        return this.buildError('PY_INVALID_ARGUMENTS', 'replaceAll 与 content 互斥（content 是全量重写）');
      }
      if (action === 'run' && timeoutSeconds !== undefined &&
          (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds))) {
        return this.buildError('PY_INVALID_ARGUMENTS', 'timeoutSeconds 必须是有限数字（秒）');
      }

      // ── 2. 会话工作区上下文（所有 action 的硬前提） ──
      const chatId = context?.chatId;
      if (!chatId || typeof chatId !== 'string' || chatId.length > 255) {
        return this.buildError('PY_CONTEXT',
          'python_run 需要当前会话工作区（chatId）：文件操作与脚本运行都绑定当前对话的工作区根目录。请在会话内调用；无会话上下文的通道不支持本工具。');
      }

      // ── 3. 分流：文件操作（本上下文存储事务） / 运行（offscreen 宿主） ──
      if (action === 'run') return await this.runScript(args, context, chatId);
      return await executeWorkspaceFileAction(action, args, chatId, context?.signal);
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

  // ──── 文件操作 ────

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
      return this.buildError('PY_INVALID_SCRIPT', error instanceof Error ? error.message : String(error));
    }
    if (script.dependencyMode === 'pypi' && !script.preflight && !context?.toolApproved) {
      return this.buildError('PY_DEPENDENCY_APPROVAL_REQUIRED',
        '安装公开 PyPI 依赖需通过会话审批。也可使用官方目录（catalog）或兼容的本地 wheel。');
    }
    // 存在性预检（只读）：脚本缺失在工具层就以 PY_FILE_NOT_FOUND 呈现
    await assertWorkspaceScriptExists(chatId, script.path);

    const state = await getPyodideEnvState();
    if (state.status !== 'ready') {
      return this.buildError(PY_ERR_NOT_READY,
        'Python 环境未就绪：请在扩展设置的「Python 环境」分区下载并核验运行时后重试。');
    }
    try {
      await ensureOffscreenHost();
    } catch (error) {
      return this.buildError(PY_ERR_CONTEXT,
        `无法启动后台 Python 宿主：${error instanceof Error ? error.message : String(error)}`);
    }
    context?.signal?.throwIfAborted();

    const requested = typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds)
      ? timeoutSeconds
      : PYTHON_RUN_DEFAULT_TIMEOUT_MS / 1000;
    const timeoutMs = Math.round(Math.min(Math.max(requested, 5), PYTHON_RUN_MAX_TIMEOUT_MS / 1000) * 1000);

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
        const detail = [
          outcome.stderr ? '[stderr]\n' + outcome.stderr.slice(-2400) : '',
          outcome.errorDetail,
          // packageWarning 承载两类信息：锁文件包自动加载失败 + micropip 清单恢复警告
          outcome.packageWarning ? '依赖提示：' + outcome.packageWarning : '',
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
   * （宿主、workspace-files、运行时全部走同一约定）；中止优先；其余兜底。
   */
  private mapError(error: unknown, context?: ToolExecutionContext): ToolResult {
    if (context?.signal?.aborted) return this.buildError('PY_EXEC_CANCELLED', 'Python 执行已取消');
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
