/**
 * Python 执行工具（python_run）
 *
 * 在侧边栏页内的 Pyodide（CPython 3.14 / WebAssembly）沙箱中执行 Python 代码，
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
 * - 沙箱边界：无本地磁盘访问、默认无网络（pyodide:open 系列除外）、
 *   不触碰浏览器数据——天然安全，无需人审门（requiresApproval=false）。
 * - 每次执行独立捕获输出，但共享同一解释器实例：跨调用持久化的状态
 *   （全局变量、内存文件 /home/pyodide）视为特性而非缺陷，模型可利用
 *   它做多步计算（先写数据，再逐步处理）。
 *
 * ==================== 错误码契约 ====================
 *
 * PY_EMPTY_CODE / PY_CODE_TOO_LONG / PY_CONTEXT_NOT_SUPPORTED /
 * PY_ENV_NOT_READY / PY_BOOT_FAILED / PY_EXEC_TIMEOUT / PY_EXEC_ERROR /
 * PY_INTERNAL_ERROR。
 */

import { BaseTool } from '../base-tool';
import { ToolMetadata } from '../registry';
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
  runPythonCode,
  type PythonRunOutcome,
} from '@/utils/pyodide/pyodide-runtime';

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

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'python_run',
      description:
        '在浏览器内的 Python 3.14 沙箱（Pyodide/WebAssembly）中执行 Python 代码并返回 stdout/stderr 与末表达式结果。' +
        '适合数据分析、数值计算、文本处理、格式转换等任务：常用科学计算包（numpy、pandas、scipy、matplotlib、scikit-learn、sympy 等）' +
        '会按代码 import 自动加载（首次使用需下载、之后本地秒载）。沙箱无本地磁盘与浏览器数据访问权限，代码在本机执行不上传。' +
        '支持顶层 await；同一会话内全局变量与内存文件系统（/home/pyodide）跨调用保留，可分步处理大数据。' +
        '打印中文/结果请直接 print()；复杂对象建议 print(json.dumps(...))。',
      parameters: {
        type: 'object',
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
        required: ['code'],
      },
    },
  };

  async execute(params: { code?: unknown; timeoutSeconds?: unknown }): Promise<ToolResult> {
    try {
      // ── 1. 输入校验（LLM 参数不可信） ──
      const code = typeof params.code === 'string' ? params.code : '';
      if (!code.trim()) {
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
        outcome = await runPythonCode(code, { timeoutMs });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes(`[${PY_ERR_CONTEXT}]`)) {
          return this.buildError(PY_ERR_CONTEXT, message.replace(`[${PY_ERR_CONTEXT}] `, ''));
        }
        if (message.includes(`[${PY_ERR_NOT_READY}]`)) {
          return this.buildError(
            PY_ERR_NOT_READY,
            'Python 环境未就绪：请在扩展设置的「Python 环境」分区下载并核验运行时后重试。',
          );
        }
        if (message.includes(`[${PY_ERR_BOOT}]`)) {
          return this.buildError(PY_ERR_BOOT, message.replace(`[${PY_ERR_BOOT}] `, ''), '可尝试在设置中重新核验或重新下载核心文件');
        }
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
        return this.buildError(PY_ERR_PYTHON, `Python 执行出错：${outcome.errorName}`, `\n${outcome.errorDetail}`);
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

  /** 成功输出：stdout / stderr / 结果 / 耗时 / 自动加载包 */
  private formatSuccess(outcome: PythonRunOutcome): string {
    const sections: string[] = ['✅ Python 执行成功', `耗时: ${outcome.durationMs}ms`];
    if (outcome.autoLoadedPackages.length > 0) {
      sections.push(`自动加载包: ${outcome.autoLoadedPackages.join(', ')}`);
    }
    if (outcome.stdout) sections.push(`\n[stdout]\n${outcome.stdout}`);
    if (outcome.result) sections.push(`\n[result]\n${outcome.result}`);
    if (outcome.stderr) sections.push(`\n[stderr]\n${outcome.stderr}`);
    if (!outcome.stdout && !outcome.result && !outcome.stderr) {
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
