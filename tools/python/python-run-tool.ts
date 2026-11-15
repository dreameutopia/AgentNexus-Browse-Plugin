/**
 * Python 执行工具（python_run）——会话工作区文件管理 + 脚本运行
 *
 * ==================== 新设计（v2，无兼容包袱） ====================
 *
 * 六个 action，全部基于**当前对话的工作区**（根目录 /work-space/<chatId>/）：
 *   - create：新建文件（content 全文，已存在则拒绝）
 *   - edit：修改文件（content 全量重写，或 find+replace 就地替换——精确匹配、
 *     默认唯一命中、replaceAll 可全量替换；非 UTF-8 / 超大文件拒绝就地编辑）
 *   - delete：删除文件（目录一律拒绝）
 *   - read：分页读取工作区文本文件（每页 ≤2000 字符，语义与 js_run 逐字一致）
 *   - list：盘点工作区目录（缺失目录显式报错并给出下一步）
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
 * PY_INVALID_ARGUMENTS / PY_INVALID_PATH / PY_INVALID_CONTENT / PY_INVALID_EDIT /
 * PY_FILE_EXISTS / PY_FILE_NOT_FOUND / PY_DELETE_DIRECTORY / PY_FILE_TOO_LARGE /
 * PY_INVALID_SCRIPT / PY_CONTEXT / PY_ENV_NOT_READY / PY_BOOT_FAILED /
 * PY_DEPENDENCY_APPROVAL_REQUIRED / PY_DEPENDENCY_UNRESOLVABLE /
 * PY_INVALID_REQUEST / PY_EXEC_TIMEOUT / PY_EXEC_ERROR / PY_EXEC_CANCELLED /
 * PY_WORKSPACE_ERROR / PY_WORKSPACE_RUNTIME / PY_HOST_BUSY /
 * PY_CONTEXT_NOT_SUPPORTED / PY_INTERNAL_ERROR。
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
import {
  assertWorkspaceScriptExists,
  readWorkspaceFilePage,
} from '@/utils/python-workspace/workspace-files';
import {
  listPageParams,
  listWorkspaceEntries,
} from '@/utils/python-workspace/workspace-listing';

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
  create: ['path', 'content'],
  edit: ['path', 'content', 'find', 'replace', 'replaceAll', 'edits', 'matchMode', 'expectedHash'],
  delete: ['path'],
  read: ['path', 'index'],
  list: ['path', 'offset', 'limit'],
  run: [
    'path', 'timeoutSeconds', 'module', 'cwd', 'argv', 'env', 'stdin',
    'preflight', 'dependencyMode', 'wheels', 'requirements',
  ],
} as const satisfies Record<string, readonly string[]>;

/** 严格参数形状：未知键一律拒绝（防拼写错误静默丢参，也防旧字段残留被忽略） */
const ALLOWED_KEYS = new Set<string>([
  'action', 'path', 'index', 'offset', 'limit',
  ...ACTION_PARAMS.create, ...ACTION_PARAMS.edit, ...ACTION_PARAMS.run,
]);

export class PythonRunTool extends BaseTool {
  name = PYTHON_RUN_TOOL_ID;

  metadata: ToolMetadata = {
    name: PYTHON_RUN_TOOL_ID,
    description:
      '会话工作区文件管理 + Python 脚本运行（create/edit/delete/read/list/run；先创建脚本文件，再运行；依赖声明与解析模式成对使用）',
    category: 'code',
    version: '3.0.0',
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
        '在当前会话工作区中管理文件并运行 Python 脚本（Python 3.14 / Pyodide / WASM 沙箱，无终端与本地文件系统）。\n' +
        '<workflow>固定两步：① create 把脚本写入工作区（如 scripts/report.py）；② run 执行该已存在的 .py。' +
        'run 不接受内联代码。脚本报错时 read 读回出错处 → edit 定点修复 → 再 run，不要 delete 后重建，也不要重复执行同一条失败命令。' +
        '交付文件写 outputs/ 并在回复里输出 <workspace-file path="outputs/xxx.csv" />。</workflow>\n' +
        '<actions>' +
        'create=新建文件（content 为全文；已存在则报错，改用 edit）；' +
        'edit=修改文件（content 全量重写，或 find+replace 就地替换：find 须与文件内容逐字符精确匹配，含缩进、空白与换行，默认要求唯一命中，可加 replaceAll=true 替换全部命中；多处修改可用 edits 原子批量替换，复杂缩进可显式 matchMode="indentation"；expectedHash 可防覆盖并发改动）；' +
        'delete=删除文件（目录不可删）；' +
        'read=分页读取工作区文本文件（index 指定页码，每页 ≤2000 字符，响应携带 index/pageCount/hasMore/nextIndex 与 sha256）；' +
        'list=盘点工作区目录（path 省略或传 "." 即列根目录；offset/limit 分页；目录不存在会报错并给出下一步）；' +
        'run=执行工作区内已存在的 .py 脚本。' +
        '</actions>\n' +
        '<dependencies>依赖有三条通道，声明与解析是两件事：' +
        '① 脚本同目录及项目根的 requirements.txt、PEP 723 元数据块与 pyproject.toml 会被自动发现，无需声明；' +
        '② 官方目录内的包（numpy、pandas、scipy、matplotlib、scikit-learn 等）按 import 自动加载，也无需声明；' +
        '③ 官方目录没有的纯 Python 包才需要显式声明：requirements=["包名"] 且 dependencyMode="pypi"——' +
        'requirements 声明「要什么」，dependencyMode="pypi" 才决定「从哪装」，两者缺一不可：' +
        '只给 requirements 而不给 dependencyMode="pypi"，该包在 catalog 模式下既不会被安装也不在官方目录内，运行必然失败。' +
        'dependencyMode="pypi" 会触发用户审批，且只支持纯 Python wheel；含 C 扩展的包只能用官方目录内的版本或自备兼容 .whl（wheels 指定）。' +
        '不确定某个包能否安装时，先 action="run" 加 preflight=true 做静态预检（不执行、不安装、不写工作区）。</dependencies>\n' +
        '<runtime>执行根目录为 /work-space/<chatId>/（脚本内可用 os.environ["AGENTNEXUS_WORKSPACE"] 定位）：相对路径读写 inputs/、outputs/；' +
        '脚本运行期可联网（fetch/HTTP 取数均可）。用 cwd、argv、env、stdin 传参（env 仅放非敏感配置）；包内入口可传 module（点分名，须与 path 指向同一文件）。' +
        '关闭文件、内存映射和数据库连接后再结束调用，输出文件优先用 with 管理；执行失败时丢弃未提交的工作区改动。' +
        '遇到不支持的内存映射、并行进程或系统命令，改用普通读写、分块和单进程 Python 实现；依赖必须支持 Pyodide/WASM；' +
        '避免用 JavaScript 桥接绕过工作区访问权限；确实无法安装时改用 csv/JSON 等标准库格式交付。' +
        '打印中文/结果请直接 print()；复杂对象建议 print(json.dumps(..., ensure_ascii=False))。</runtime>\n' +
        '<paths>所有 path 都是相对当前对话工作区根目录的路径：禁止绝对路径、盘符与 ..，越界一律拒绝。' +
        'results/ 是工具产物的结果目录，只能 read/list/delete，不能手工 create/edit。</paths>',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'edit', 'delete', 'read', 'list', 'run'],
            description:
              'create=新建文件；edit=修改文件；delete=删除文件；read=分页读取工作区文本文件；list=盘点工作区目录；run=运行已存在的 .py 脚本',
          },
          path: {
            type: 'string',
            description:
              '相对会话工作区根目录的路径（如 scripts/report.py）。create/edit/delete/read 必填；run 必填且须为工作区内已存在的 .py；list 可省略（或传 "."）以列出根目录。禁止绝对路径、盘符与 ..',
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
          index: {
            type: 'integer',
            minimum: 1,
            description:
              '仅 read：页码（1 起，默认 1）。每页 ≤2000 字符，响应携带 index/pageCount/hasMore/nextIndex；续读直接传 nextIndex',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            description: '仅 list：条目偏移，默认 0',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            description: '仅 list：每页最多返回的条目数（默认 100、最多 200）',
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
          { properties: { action: { type: 'string', enum: ['create'] } }, required: ['action', 'path', 'content'] },
          { properties: { action: { type: 'string', enum: ['edit'] } }, required: ['action', 'path'] },
          { properties: { action: { type: 'string', enum: ['delete'] } }, required: ['action', 'path'] },
          { properties: { action: { type: 'string', enum: ['read'] } }, required: ['action', 'path'] },
          { properties: { action: { type: 'string', enum: ['list'] } }, required: ['action'] },
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
          `未知参数：${unknownKeys.join(', ')}。本工具仅接受 action、path、content、find、replace、replaceAll、index/offset/limit 与 run 专用参数（timeoutSeconds/module/cwd/argv/env/stdin/preflight/dependencyMode/wheels/requirements）`);
      }
      if (typeof action !== 'string' || !(action in ACTION_PARAMS)) {
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
      // path 必填性按 action 区分：list 可省略（省略即列根目录），其余必填
      if (action !== 'list' && (typeof path !== 'string' || !path)) {
        return action === 'run'
          ? this.buildError('PY_INVALID_SCRIPT', 'run 需要 path（工作区相对 .py 路径）')
          : this.buildError('PY_INVALID_PATH', 'path 必填：相对会话工作区根目录的路径');
      }
      if (action === 'create' && content === undefined) {
        return this.buildError('PY_INVALID_ARGUMENTS', 'action="create" 需要 content（文件全文，可为空串）');
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
      if (replaceAll !== undefined && typeof replaceAll !== 'boolean') {
        return this.buildError('PY_INVALID_ARGUMENTS', 'replaceAll 必须是布尔值');
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

      // ── 3. 分流：文件操作（本上下文存储事务） / 读取盘点 / 运行（offscreen 宿主） ──
      if (action === 'run') return await this.runScript(args, context, chatId);
      if (action === 'read') return await this.readFile(args, chatId, context?.signal);
      if (action === 'list') return await this.listDirectory(args, chatId, context?.signal);
      return await executeWorkspaceFileAction(action as 'create' | 'edit' | 'delete', args, chatId, context?.signal);
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

  /**
   * action="read"：分页读取工作区文本文件。
   *
   * 与 js_run 的 read 语义**逐字一致**（同一分页引擎、同一字段形状、同一
   * 续读约定）——两个工具操作同一个会话工作区，模型在两者间切换时不应
   * 看到两种形状。
   */
  private async readFile(
    args: Record<string, unknown>,
    chatId: string,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    let page: Awaited<ReturnType<typeof readWorkspaceFilePage>>;
    try {
      page = await readWorkspaceFilePage(chatId, args.path, args.index, signal);
    } catch (error) {
      // 分页参数与路径错误都归到可自纠的参数错误：页码越界时错误自带总页数，
      // 模型按回显修正即可，不必再读一遍文件确认页数
      return this.buildError(
        'PY_INVALID_ARGUMENTS',
        toolErrorDetails(error, 'PY').replace(/^\[PY_[A-Z_]+\]\s*/, ''),
      );
    }
    const shapeNote =
      page.pageCount > 1
        ? `共 ${page.pageCount} 页（${page.totalChars} 字符），${page.hasMore ? `续读传 index=${page.nextIndex}` : '已是最后一页'}`
        : page.pageCount === 1
          ? '全文一页返回'
          : '文件为空';
    return {
      success: true,
      isError: false,
      primary: 'content',
      content: [{
        type: 'text',
        text: `已读取 ${page.path} 第 ${page.index}/${page.pageCount} 页（本页 ${page.content.length} 字符；${shapeNote}）。\n\n${page.content}`,
      }],
      data: { ...page },
    };
  }

  /**
   * action="list"：盘点工作区目录。
   *
   * 与 js_run 的 list 共用 utils/python-workspace/workspace-listing：
   * 同一实现、同一报错文案、同一分页口径。
   */
  private async listDirectory(
    args: Record<string, unknown>,
    chatId: string,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    let page: { offset: number; limit: number };
    try {
      page = listPageParams(args.offset, args.limit);
    } catch (error) {
      return this.buildError(
        'PY_INVALID_ARGUMENTS',
        error instanceof Error ? error.message : String(error),
      );
    }
    const listing = await listWorkspaceEntries(chatId, args.path, page.offset, page.limit, signal);
    const scope = args.path === undefined || args.path === '.' ? '根目录' : `目录 ${args.path}`;
    return {
      success: true,
      isError: false,
      primary: 'content',
      content: [{
        type: 'text',
        text: `已列出${scope}的 ${listing.entries.length} 项（共 ${listing.total} 项${listing.hasMore ? `，还有更多，用 offset=${listing.nextOffset} 续查` : ''}）：\n` +
          listing.entries.map((entry) => `- ${entry.path}（${entry.kind === 'file' ? `${entry.bytes} 字节` : entry.kind === 'directory' ? '目录' : '链接'}）`).join('\n'),
      }],
      data: listing,
    };
  }

  /**
   * 依赖契约前置判定（工具层，不等 worker 跑完）。
   *
   * 判据来源：官方目录（Pyodide 锁文件）+ 已安装包（micropip 复用清单）。
   * 只在 catalog 模式下判定——pypi 模式由 runner 的 micropip 实际解析，
   * 含 C 扩展的 wheel 装不装得上只有它能诊断。
   *
   * 放在「存在性预检之后、环境检查之前」：脚本不存在是更根本的错误，
   * 先报它；脚本存在但依赖契约不成立时，这里给出带具体包名与具体下一步的
   * 结论，而不是让模型等 worker 跑完后收到一段 Python traceback。
   */
  private async checkDependencyContract(
    script: PythonScriptRequest,
  ): Promise<ToolResult | null> {
    if (script.dependencyMode !== 'catalog' || !script.requirements.length) return null;
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
        const detail = [
          outcome.stderr ? '[stderr]\n' + outcome.stderr.slice(-2400) : '',
          outcome.errorDetail,
          // packageWarning 承载两类信息：锁文件包自动加载失败 + micropip 清单恢复警告
          outcome.packageWarning ? '依赖提示：' + outcome.packageWarning : '',
          importRootCause,
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
