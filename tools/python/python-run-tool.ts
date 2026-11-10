/**
 * Python 执行工具（python_run）
 *
 * 在扩展的 Pyodide（CPython 3.14 / WebAssembly）运行时中执行 Python 代码，
 * 捕获 stdout / stderr / 末表达式结果返回给模型。
 *
 * ==================== 能力与约束 ====================
 *
 * - 混合加载：JS 引导层随扩展打包；wasm/标准库/包按需从 CDN 下载并缓存于
 *   IndexedDB（见 utils/pyodide）。环境须先在「设置 → Python 环境」中
 *   下载并核验，否则本工具返回 PY_ENV_NOT_READY 引导错误。
 * - 自动按需装包：执行前经 loadPackagesFromImports 解析代码 import，
 *   已下载的包（numpy/pandas/scipy 等）零网络秒载；未下载且在官方目录
 *   中的包会经缓存层自动下载（带 sha256 完整性校验）。
 * - 超时中断：默认 60s、上限 180s；跨域隔离可用时经 SharedArrayBuffer
 *   SIGINT 强制中断死循环（抛出 KeyboardInterrupt）。
 * - 聊天运行使用会话工作区。仅在执行成功并完成事务后保存文件。
 * - 跨调用持久化状态使用工作区文件；解释器可能被回收。
 *
 * ==================== 错误码契约 ====================
 *
 * PY_EMPTY_CODE / PY_CODE_TOO_LONG / PY_CONTEXT_NOT_SUPPORTED /
 * PY_ENV_NOT_READY / PY_BOOT_FAILED / PY_EXEC_TIMEOUT / PY_EXEC_ERROR /
 * PY_INTERNAL_ERROR。
 */

import { BaseTool } from '../base-tool';
import { ToolExecutionContext, ToolMetadata, type ToolSchemaOptions } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
// 子路径直连（不走 @/utils/pyodide 桶文件）：桶文件同时被 PythonSection
// 动态 import，静态 + 动态混合导入会让 Vite 告警「动态导入无法拆 chunk」
import {
  PYODIDE_MAX_CODE_LENGTH,
  PYTHON_RUN_DEFAULT_TIMEOUT_MS,
  PYTHON_RUN_MAX_TIMEOUT_MS,
} from '@/utils/pyodide/pyodide-config';
import {
  PY_ERR_BOOT,
  PY_ERR_CONTEXT,
  PY_ERR_NOT_READY,
  PY_ERR_PYTHON,
  PY_ERR_TIMEOUT,
  PY_ERR_WORKSPACE,
  PY_ERR_WORKSPACE_RUNTIME,
  interruptPythonRun,
  recordAutoLoadedPackages,
  runPythonCode,
  type PythonRunOutcome,
} from '@/utils/pyodide/pyodide-runtime';
import { ensureOffscreenHost } from '@/utils/offscreen-host';
import { getPyodideEnvState, isSkillScriptSupportEnabled } from '@/utils/pyodide/pyodide-env';
import { recordMicropipPackages } from '@/utils/pyodide/pyodide-micropip';
import { parsePythonScriptRequest, type PythonScriptRequest } from '@/utils/pyodide/python-script-request';
import {
  isPythonHostResult, PYTHON_HOST_CANCEL, PYTHON_HOST_RUN, type PythonHostRun,
} from '@/utils/pyodide/python-host-protocol';

export class PythonRunTool extends BaseTool {
  name = 'python_run';

  metadata: ToolMetadata = {
    name: 'python_run',
    description: '在本地 Python 3.14（Pyodide/WebAssembly）沙箱中执行代码并返回输出',
    category: 'code',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['python', 'pyodide', 'wasm', 'compute', 'data', 'pandas', 'numpy'],
  };

  requiresApprovalFor(args: unknown): boolean {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
    const request = args as { scriptPath?: unknown; dependencyMode?: unknown; preflight?: unknown };
    return typeof request.scriptPath === 'string' && request.dependencyMode === 'pypi' && request.preflight !== true;
  }

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'python_run',
      description:
        '在浏览器内的 Python 3.14 沙箱（Pyodide/WebAssembly）中执行 Python。' +
        '适合数据分析、数值计算、文本处理、格式转换等任务：官方目录内的常用科学计算包（numpy、pandas、scipy、matplotlib、scikit-learn、sympy 等）' +
        '会按代码 import 自动加载（首次使用需下载）。支持顶层 await。' +
        '官方目录没有的纯 Python 包（如 openpyxl、flask、python-dotenv）用 micropip 安装：在同一次调用中先 ' +
        'import micropip 后 await micropip.install("包名")，再 import 使用；只支持纯 Python wheel，含 C 扩展的包必须在官方目录内。' +
        'micropip 装过的包会记入复用清单：后续调用直接 import 即可，无需重复安装（管理中心可查看清单；' +
        '默认跨浏览器重启全局复用，关闭全局复用后仅当前浏览器会话内复用）。' +
        '聊天调用自动以 /work-space/<chatId>/ 为当前目录。用 open()、pathlib 等按相对路径读写，上传原件位于 inputs/，交付文件写入 outputs/（支持子目录）。' +
        '关闭文件、内存映射和数据库连接后再结束调用。输出文件优先用 with 管理。工作区支持普通文件、目录及内部符号链接；交付请写普通文件。执行失败时丢弃未提交的工作区改动。' +
        '若库需要文件对象，传入 open(..., "rb"/"wb") 或 io.BytesIO；若库需要实际路径，传入工作区内路径，或在 tempfile.TemporaryDirectory() 内处理后复制产物到 outputs/。' +
        '遇到不支持的内存映射、并行进程或系统命令，改用普通读写、分块和单进程 Python 实现。依赖必须支持 Pyodide/WASM。避免用 JavaScript 桥接绕过工作区访问权限。' +
        '确实无法安装时，改用 csv/JSON 等标准库格式交付；有 xlsx_tool 时也可将整理好的结构化数据交给该工具。' +
        '向用户提供下载时，在最终回复正文独立一行输出 <workspace-file path="outputs/report.csv" />，只引用已保存的 outputs/ 相对路径。XML 属性中的 &, ", <, > 分别用 &amp;、&quot;、&lt;、&gt;。' +
        '打印中文/结果请直接 print()；复杂对象建议 print(json.dumps(...))。',
      parameters: {
        type: 'object',
        required: ['code'],
        additionalProperties: false,
        properties: {
          code: {
            type: 'string',
            description: '要执行的 Python 源码（支持顶层 await）',
          },
          timeoutSeconds: {
            type: 'number',
            description: `可选超时（秒），默认 ${PYTHON_RUN_DEFAULT_TIMEOUT_MS / 1000}，最大 ${PYTHON_RUN_MAX_TIMEOUT_MS / 1000}；超时会被强制中断`,
          },
        },
      },
    },
  };

  private readonly scriptSchema: OpenAITool = {
    type: 'function',
    function: {
      ...this.openaiSchema.function,
      description: this.openaiSchema.function.description +
        ' 脚本模式中 code 与 scriptPath 二选一。技能资源可由 skill_tool(action="copy") 复制。' +
        'scriptPath 与 cwd 相对工作区根目录，技能脚本默认从技能副本根目录运行。' +
        '脚本可用 os.environ["AGENTNEXUS_WORKSPACE"] 定位 inputs/、outputs/。' +
        '先用 preflight 检查依赖、环境变量和平台限制。参数按字面传递，env 仅放非敏感配置。' +
        '脚本默认使用官方目录和本地 wheel，经会话审批可用公开 PyPI。只运行可信来源的脚本。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        anyOf: [{ required: ['code'] }, { required: ['scriptPath'] }],
        properties: {
          ...this.openaiSchema.function.parameters?.properties,
          scriptPath: { type: 'string', description: '工作区相对 .py 路径，不能与 code 一起传' },
          module: { type: 'string', description: '可选，对应 python -m 的包内运行方式，如 package.report。必须与 scriptPath 指向同一个文件。' },
          cwd: { type: 'string', description: '脚本当前目录，相对工作区根目录，"." 表示工作区根目录' },
          argv: { type: 'array', items: { type: 'string' }, description: '脚本命令行参数，不含脚本名' },
          env: { type: 'object', additionalProperties: { type: 'string' }, description: '临时非敏感环境变量映射' },
          stdin: { type: 'string', description: '脚本标准输入文本，省略时为 EOF' },
          preflight: { type: 'boolean', description: '仅静态预检，不运行脚本、安装依赖或写入工作区' },
          dependencyMode: { type: 'string', enum: ['catalog', 'pypi'], description: 'catalog 为默认；经用户授权可用 pypi 解析声明依赖' },
          wheels: { type: 'array', items: { type: 'string' }, description: '明确选用的工作区相对 .whl 路径，须兼容 Pyodide' },
          requirements: { type: 'array', items: { type: 'string' }, description: '补充确认过的 PEP 508 依赖，例如 pypdf>=5。不要传 URL、索引、VCS 或凭据。' },
        },
      },
    },
  };

  getSchema(options: ToolSchemaOptions): OpenAITool {
    return options.skillMode === 'workspace' ? this.scriptSchema : this.openaiSchema;
  }

  async execute(params: { code?: unknown; scriptPath?: unknown; timeoutSeconds?: unknown } & Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    try {
      // ── 1. 输入校验（LLM 参数不可信） ──
      const code = typeof params?.code === 'string' ? params.code : '';
      let script: PythonScriptRequest | undefined;
      const { scriptPath, module, cwd, argv, env, stdin, preflight, dependencyMode, wheels, requirements } = params ?? {};
      if (scriptPath !== undefined) {
        if (context?.skillMode !== 'workspace' || !await isSkillScriptSupportEnabled()) {
          return this.buildError('PY_SKILL_SCRIPTS_DISABLED', '当前会话未启用脚本模式。开启设置后请发起新一轮对话。');
        }
        if (params.code !== undefined) return this.buildError('PY_INVALID_SCRIPT', 'code 与 scriptPath 只能提供其一');
        if (!context?.chatId) return this.buildError(PY_ERR_CONTEXT, '脚本执行需要会话工作区');
        try {
          script = parsePythonScriptRequest({ path: scriptPath, module, cwd, argv, env, stdin, preflight, dependencyMode, wheels, requirements });
        } catch (error) {
          return this.buildError('PY_INVALID_SCRIPT', error instanceof Error ? error.message : String(error));
        }
        if (!script.preflight && script.dependencyMode === 'pypi' && !context.toolApproved) {
          return this.buildError('PY_DEPENDENCY_APPROVAL_REQUIRED', '安装公开 PyPI 依赖需通过会话审批。也可使用官方目录或兼容的本地 wheel。');
        }
      } else if ([module, cwd, argv, env, stdin, preflight, dependencyMode, wheels, requirements].some(value => value !== undefined)) {
        return this.buildError('PY_INVALID_SCRIPT', '脚本参数需要同时提供 scriptPath');
      }
      if (!script && !code.trim()) {
        return this.buildError('PY_EMPTY_CODE', 'code 参数不能为空，请提供完整的 Python 源码');
      }
      if (code.length > PYODIDE_MAX_CODE_LENGTH) {
        return this.buildError(
          'PY_CODE_TOO_LONG',
          `代码长度 ${code.length} 字符超出上限 ${PYODIDE_MAX_CODE_LENGTH}，请精简或分步执行`,
        );
      }
      const timeoutSeconds =
        typeof params.timeoutSeconds === 'number' && Number.isFinite(params.timeoutSeconds)
          ? params.timeoutSeconds
          : PYTHON_RUN_DEFAULT_TIMEOUT_MS / 1000;
      const timeoutMs = Math.round(
        Math.min(Math.max(timeoutSeconds, 5), PYTHON_RUN_MAX_TIMEOUT_MS / 1000) * 1000,
      );

      // ── 2. 执行（运行时内部已做就绪校验/启动/串行化/超时中断） ──
      let outcome: PythonRunOutcome;
      try {
        outcome = await this.run(code, timeoutMs, context, script);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith(`[${PY_ERR_CONTEXT}]`)) {
          return this.buildError(PY_ERR_CONTEXT, message.replace(`[${PY_ERR_CONTEXT}] `, ''));
        }
        if (message.startsWith(`[${PY_ERR_NOT_READY}]`)) {
          return this.buildError(
            PY_ERR_NOT_READY,
            'Python 环境未就绪：请在扩展设置的「Python 环境」分区下载并核验运行时后重试。',
          );
        }
        if (message.startsWith(`[${PY_ERR_BOOT}]`)) {
          return this.buildError(PY_ERR_BOOT, message.replace(`[${PY_ERR_BOOT}] `, ''), '可尝试在设置中重新核验或重新下载核心文件');
        }
        for (const code of [PY_ERR_TIMEOUT, PY_ERR_WORKSPACE, PY_ERR_WORKSPACE_RUNTIME, 'PY_EXEC_CANCELLED', 'PY_HOST_BUSY', 'PY_INVALID_SCRIPT', 'PY_SKILL_SCRIPTS_DISABLED']) {
          if (message.startsWith(`[${code}]`)) return this.buildError(code, message.replace(`[${code}] `, ''));
        }
        if (context?.signal?.aborted) return this.buildError('PY_EXEC_CANCELLED', 'Python 执行已取消');
        throw error;
      }

      // ── 3. 结果格式化 ──
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
          // packageWarning 现在承载两类信息：锁文件包自动加载失败 + micropip 清单恢复警告
          outcome.packageWarning ? '依赖提示：' + outcome.packageWarning : '',
        ]
          .filter(Boolean).join('\n');
        return this.buildError(PY_ERR_PYTHON, `Python 执行出错：${outcome.errorName}`, `\n${detail}`);
      }

      this.log(`执行成功 (${outcome.durationMs}ms, 自动加载包: ${outcome.autoLoadedPackages.join(',') || '无'})`);
      return {
        success: true,
        content: [
          {
            type: 'text',
            text: this.formatSuccess(outcome),
          },
        ],
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`执行失败: ${message}`, 'error');
      return this.buildError('PY_INTERNAL_ERROR', `工具执行发生未预期异常：${message}`);
    }
  }

  /** Conversation calls are cancelled through their own signal. */
  async kill(_args?: unknown, context?: ToolExecutionContext): Promise<void> {
    if (!context?.signal && typeof window !== 'undefined') interruptPythonRun();
  }

  private async run(code: string, timeoutMs: number, context?: ToolExecutionContext, script?: PythonScriptRequest): Promise<PythonRunOutcome> {
    const { chatId, signal } = context ?? {};
    if (typeof window !== 'undefined' && !script) return runPythonCode(code, { timeoutMs, chatId, signal });
    if (!chrome.offscreen?.createDocument) {
      throw new Error(`[${PY_ERR_CONTEXT}] 当前浏览器无法启动后台 Python 执行环境`);
    }
    const state = await getPyodideEnvState();
    if (state.status !== 'ready') throw new Error(`[${PY_ERR_NOT_READY}]`);
    try {
      await ensureOffscreenHost();
    } catch (error) {
      throw new Error(`[${PY_ERR_CONTEXT}] 无法启动后台 Python 宿主：${error instanceof Error ? error.message : String(error)}`);
    }
    signal?.throwIfAborted();
    const id = crypto.randomUUID();
    const request: PythonHostRun = { type: PYTHON_HOST_RUN, id, code, script, timeoutMs, chatId, state };
    const cancel = () => {
      void chrome.runtime.sendMessage({ type: PYTHON_HOST_CANCEL, id }).catch(() => undefined);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const result: unknown = await chrome.runtime.sendMessage(request).catch(error => {
        throw new Error(`[${PY_ERR_CONTEXT}] 后台 Python 通道断开：${error instanceof Error ? error.message : String(error)}`);
      });
      if (!isPythonHostResult(result)) throw new Error(`[${PY_ERR_CONTEXT}] 后台 Python 执行环境未返回有效响应`);
      if ('error' in result) throw new Error(result.error);
      if (result.outcome.autoLoadedPackages.length) void recordAutoLoadedPackages(result.outcome.autoLoadedPackages);
      // worker 无 storage 访问权：micropip 探测结果回传到此（SW）再入清单
      if (result.outcome.micropipPackages?.length) void recordMicropipPackages(result.outcome.micropipPackages);
      return result.outcome;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  /** 成功输出：stdout / stderr / 结果 / 耗时 / 自动加载包 / micropip 复用清单 */
  private formatSuccess(outcome: PythonRunOutcome): string {
    const sections: string[] = ['✅ Python 执行成功', `耗时: ${outcome.durationMs}ms`];
    if (outcome.autoLoadedPackages.length > 0) {
      sections.push(`自动加载包: ${outcome.autoLoadedPackages.join(', ')}`);
    }
    if (outcome.micropipPackages?.length) {
      sections.push(`micropip 复用清单: ${outcome.micropipPackages.map(pkg => `${pkg.name} ${pkg.version}`).join(', ')}`);
    }
    if (outcome.packageWarning) sections.push(`依赖提示：${outcome.packageWarning}`);
    if (outcome.workspaceOutputs?.length) {
      const paths = outcome.workspaceOutputs.slice(0, 30);
      sections.push(`\n[已保存的工作区产物]\n${paths.map(path => JSON.stringify(path)).join('\n')}`);
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

  /** 构造统一格式（阶段错误码 + 可读信息）的错误结果 */
  private buildError(code: string, message: string, suffix?: string): ToolResult {
    return {
      success: false,
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
