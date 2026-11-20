/**
 * browser_input —— 快捷键与剪贴板工具（默认注入的核心工具）
 *
 * 存在理由（一次真实任务的复盘）：把 109 行 × 26 列的数据写进 canvas 渲染的
 * 飞书表格，模型走了 61 次调用、两次 30 秒挂起才成功。根因不是模型慢，而是
 * 平台把三件事做在了错误的位置：
 *
 *   1. **剪贴板只有页面 origin 一条路**：页面上下文调用异步剪贴板 API 会挂在
 *      浏览器级权限气泡上（气泡在浏览器 UI 层、不在页面 DOM → DOM 工具永远
 *      观察不到 → 模型只看到脚本超时，只能反复重试同一条死路）。
 *      本工具的剪贴板走**扩展侧**通道（manifest 剪贴板权限 + 离屏文档），
 *      不经过页面 origin，因此没有气泡、不会挂起。
 *   2. **快捷键没有可信入口**：浏览器工具此前只能靠页面脚本硬造粘贴，而页面
 *      合成事件（isTrusted=false）会被目标应用拒绝——实测目标表格据此忽略了
 *      全部粘贴。CDP `Input.dispatchKeyEvent` 派发的是**可信**键事件，能触发
 *      浏览器与页面自身的原生快捷键（Ctrl+V / Ctrl+C / Ctrl+Home…），这才是
 *      整批数据进表格的正路。
 *   3. **「从工作区文件到剪贴板」没有通道**：数据只能靠模型逐字转录进上下文
 *      （14KB TSV 就是一整轮上下文消耗）。本工具直接读工作区文件写入剪贴板，
 *      数据全程不进模型上下文。
 *
 * ==================== 能力面与边界 ====================
 *
 * action 面：
 *   - keys             派发快捷键（可信 CDP 键事件；支持文档级与元素定向）
 *   - type             向当前焦点插入文本（可信输入通道；可先清空）
 *   - clipboard_write  写系统剪贴板（内容来自内联 text 或工作区文件 path）
 *   - clipboard_read   读系统剪贴板文本（敏感读取 → 走工具级审批规则）
 *   - clipboard_paste  写剪贴板 + 派发真实 Ctrl+V（整批数据进表格的正解）
 *
 * 安全边界：
 *   - 读剪贴板可能取到用户复制的凭据/隐私内容 → 声明 requiresConfirmActions，
 *     由会话引擎在执行前向用户确认；写入不涉及读取用户数据，默认不拦。
 *   - 写入/读取的剪贴板内容**不落结果文件、不进日志**——剪贴板里可能有敏感
 *     内容，持久化会扩大暴露面。
 *   - 工作区文件路径沿用 file_util 的同一套校验（无绝对路径出口、无目录穿越）。
 */

import { BaseBrowserTool } from '../base/browser-tool';
import type { ToolMetadata, ToolExecutionContext } from '../registry';
import type { OpenAITool } from '@/common/openai-types';
import { executeScriptBounded } from '../common/frame-read';
import { resolveTabTarget } from './tab-target';
import { browserChrome } from './browser-scope';
import {
  boundedText,
  exclusiveText,
  readableTextError,
  textCommand,
  textTab,
} from './text-runtime';
import { resolveTextKeys, needsPrimaryModifier } from './text-keys';
import { resolveKeys } from '../vision/key-definitions';
import { dispatchKeyChord } from './key-dispatch';
import { cdpSession } from './cdp-session';
import { focusedTextPayload, dedupeFocusEntries } from './text-target-payload';
import { resolveAX, invalidateAXPages } from './text-accessibility';
import { writeClipboardViaOffscreen } from './clipboard-client';
import { CLIPBOARD_MAX_CHARS, CLIPBOARD_PAGE_MSG } from './clipboard-protocol';
import {
  resolveElementFrame,
  describeFrameResolutionFailure,
} from './frame-resolution';
import {
  BROWSER_INPUT_TOOL_ID,
  BROWSER_INPUT_SYSTEM_PROMPT_SECTION,
} from './input-contract';
import { readWorkspaceTextFile } from '@/utils/python-workspace/workspace-files';
import { parseCsv } from '@/utils/python-workspace/tabular';
import {
  CONFIRM_GUIDANCE,
  CONFIRM_PARAMETER_DESCRIPTION,
} from '../confirmation-policy';

type Action =
  | 'keys'
  | 'type'
  | 'clipboard_write'
  | 'clipboard_read'
  | 'clipboard_paste';

interface Params {
  action: Action;
  /** keys：组合键序列（一个主键 + 至多 4 个修饰键） */
  keys?: string[];
  /** type / clipboard_write / clipboard_paste：内联文本 */
  text?: string;
  /** clipboard_write / clipboard_paste：工作区相对路径（与 text 二选一） */
  path?: string;
  /** clipboard_write / clipboard_paste：CSV 文件按制表符分隔转换（表格整表粘贴用） */
  asTsv?: boolean;
  /** type：先全选退格清空当前编辑器 */
  clear?: boolean;
  /** keys/type：元素定向（可选；省略即派发给当前焦点） */
  elementId?: string;
  /** keys/type：元素所在 frame（可选；省略时按 ElementId 自动定位） */
  frameId?: number;
  /** 目标标签页（可选；省略=当前活动页） */
  tabId?: number | string;
  description?: string;
  confirm?: boolean;
}

const ACTIONS: readonly Action[] = [
  'keys',
  'type',
  'clipboard_write',
  'clipboard_read',
  'clipboard_paste',
];

/** 各 action 允许携带的参数（防止跨 action 误传参数）。 */
const ALLOWED_PARAMS: Record<Action, readonly string[]> = {
  keys: ['keys', 'elementId', 'frameId'],
  type: ['text', 'clear', 'elementId', 'frameId'],
  clipboard_write: ['text', 'path', 'asTsv'],
  clipboard_read: [],
  clipboard_paste: ['text', 'path', 'asTsv', 'elementId', 'frameId'],
};

/** 文本长度上限（与剪贴板通道上限一致，避免为超限内容白跑一趟）。 */
const TEXT_MAX_CHARS = CLIPBOARD_MAX_CHARS;

/**
 * 把工作区文件内容转成可直接粘贴的文本。
 *
 * CSV → TSV 是表格整表粘贴的关键：制表符分隔的文本被粘贴到表格应用时会被
 * 按列展开，而逗号分隔不会。解析复用 `utils/python-workspace/tabular.ts` 的
 * RFC 4180 实现（与数据通道同一真相源，避免两套 CSV 语义漂移）。
 */
async function loadClipboardPayload(
  path: string,
  asTsv: boolean,
  chatId: string,
  signal?: AbortSignal,
): Promise<{ text: string; source: string; converted: boolean }> {
  const snapshot = await readWorkspaceTextFile(chatId, path, signal);
  if (!asTsv) {
    return { text: snapshot.content, source: snapshot.path, converted: false };
  }
  const table = parseCsv(snapshot.content);
  const lines: string[] = [];
  if (table.headers.length) lines.push(table.headers.join('\t'));
  for (const row of table.rows) lines.push(row.join('\t'));
  return {
    text: lines.join('\n'),
    source: snapshot.path,
    converted: true,
  };
}

export class BrowserInputTool extends BaseBrowserTool {
  name = BROWSER_INPUT_TOOL_ID;
  metadata: ToolMetadata = {
    name: this.name,
    description:
      '快捷键派发与系统剪贴板（写入/读取/整表粘贴）：可信按键事件、扩展侧剪贴板通道、从工作区文件直接粘贴',
    category: 'browser',
    version: '1.0.0',
    // 读取系统剪贴板可能取到用户复制的凭据/隐私内容 → 整动作级人审门。
    // 匹配的是**完整 action 名**（审批判定按 args.action 精确比对）。
    requiresApprovalActions: ['clipboard_read'],
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: this.name,
      description:
        '<browser-input>\n' +
        '  <capability>派发浏览器/页面原生快捷键（可信键事件，isTrusted=true，会触发 Ctrl+V 粘贴、Ctrl+C 复制、Ctrl+Home 定位等原生行为）；读写系统剪贴板；把整批数据（内联文本或工作区文件）一次性粘贴进目标页面。</capability>\n' +
        '  <actions>\n' +
        '    <action name="keys">派发一个组合键（如 ["Mod","v"] 粘贴、["Mod","c"] 复制、["Mod","Home"] 回到文档开头、["Escape"] 关闭浮层）。省略 elementId 时派发给当前焦点。**按键是可信事件**：目标应用会像真实用户按键一样响应，这是把数据写进 canvas 表格/富文本编辑器的标准路径。</action>\n' +
        '    <action name="type">向当前焦点插入文本（可先 clear=true 全选退格清空）。走真实输入通道，适合富文本、canvas 编辑器、表格单元格；普通 input/textarea/select 用 browser_interact(action="fill") 更直接。</action>\n' +
        '    <action name="clipboard_write">把文本写入系统剪贴板。内容二选一：text=内联文本，或 path=工作区相对路径（读工作区文件，数据不进模型上下文）。asTsv=true 时把 CSV 文件转成制表符分隔（粘贴进表格即按列展开）。</action>\n' +
        '    <action name="clipboard_read">读取系统剪贴板文本。剪贴板可能含用户复制的凭据/隐私内容，属敏感读取，会向用户请求确认。</action>\n' +
        '    <action name="clipboard_paste">一步完成「写剪贴板 + 派发真实 Ctrl+V」：内容同样支持 text/path（asTsv 可选）。适用于把整批数据写进 canvas 表格、在线文档等无 DOM 单元格的界面——逐格填写不可行。</action>\n' +
        '  </actions>\n' +
        '  <references>elementId/frameId 仅 keys/type/clipboard_paste 可用：给出时按键与输入定向到该元素；省略时作用于当前焦点。frameId 可省略——工具按 ElementId 自动定位所在 frame（与 browser_observe 结果同源），显式传值则以显式值为准。</references>\n' +
        '  <clipboard>剪贴板走扩展侧通道，不经过页面 origin：不触发浏览器权限气泡、不会挂起、无需页面在前台。浏览器 UI 层的权限气泡（如「查看复制到剪贴板的文本和图像」）不在页面 DOM 里，任何观察工具都看不到它——写操作长时间无响应时优先改用本工具，而不是在页面脚本里重试 navigator.clipboard。</clipboard>\n' +
        '  <result>outcome 标明实际发生了什么（dispatched / clipboard_written / clipboard_pasted / clipboard_read / not_dispatched）。剪贴板内容不会写入结果文件或日志。</result>\n' +
        '  <errors>clipboard_read 未获批准时停止，不要改用页面脚本绕过审批。写剪贴板失败会给出可定位原因（权限不可用、离屏宿主未就绪、内容超限），按提示修正后重试，不要换页面脚本重试同一条路。</errors>\n' +
        '</browser-input>' +
        CONFIRM_GUIDANCE,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: [...ACTIONS] },
          keys: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            items: { type: 'string' },
            description:
              '仅 keys：一个主键 + 至多 4 个修饰键。如 ["Mod","a"] 全选、["Mod","v"] 粘贴、["Mod","c"] 复制、["Mod","Home"] 文档开头、["F2"] 编辑、["Escape"] 取消。Mod/ControlOrMeta 按平台映射 Control 或 Meta；接受 Ctrl/Cmd/Option/Esc/Return/Del/PgUp/PgDn 等别名。组合中的大写字母不隐含 Shift，需要时显式传 Shift；标点采用 US 键位；Unicode 用 type。',
          },
          text: {
            type: 'string',
            maxLength: TEXT_MAX_CHARS,
            description:
              'type 的插入文本；clipboard_write/clipboard_paste 的内联内容。与 path 二选一（同时传报错）。',
          },
          path: {
            type: 'string',
            minLength: 1,
            maxLength: 300,
            description:
              '仅 clipboard_write/clipboard_paste：工作区相对路径（如 outputs/商品榜单.csv、results/run-xxx.json）。文件从会话工作区读出，内容不进模型上下文。与 text 二选一。',
          },
          asTsv: {
            type: 'boolean',
            description:
              '仅 clipboard_write/clipboard_paste：把 CSV 文件转成制表符分隔（表头 + 数据行），粘贴进表格应用时按列展开。默认 false（按原文件内容写入）。',
          },
          clear: {
            type: 'boolean',
            description: '仅 type：插入前先全选并退格清空当前编辑器；默认 false',
          },
          elementId: {
            type: 'string',
            description:
              '仅 keys/type/clipboard_paste：原样复制 browser_observe 结果的 ElementId；省略即作用于当前焦点',
          },
          frameId: {
            type: 'number',
            description:
              '仅 keys/type/clipboard_paste：元素所在 frame（与 ElementId 同行）。可省略——工具按 ElementId 自动定位所在 frame；显式传入则以显式值为准。',
          },
          tabId: {
            type: 'integer',
            minimum: 0,
            description:
              '目标标签页 ID（可选；省略=当前活动标签页）。显式传入会先核对存在性与可注入性，再切换到该标签页执行。',
          },
          description: {
            type: 'string',
            description: '具体目标、所属记录及操作意图',
          },
          confirm: {
            type: 'boolean',
            description: CONFIRM_PARAMETER_DESCRIPTION,
          },
        },
        required: ['action', 'description'],
        anyOf: ACTIONS.map((action) => ({
          type: 'object',
          properties: { action: { type: 'string', enum: [action] } },
          required: [
            'action',
            ...(action === 'keys'
              ? ['keys']
              : action === 'type'
                ? ['text']
                : action === 'clipboard_read'
                  ? []
                  : []),
          ],
        })),
      },
    },
  };

  async execute(input: Params, context?: ToolExecutionContext) {
    this.ensureBackgroundContext();
    /**
     * 是否已把动作派发出去。
     *
     * 这个事实决定失败时的定性：「未派发」= 改参数即可重试；「已派发但结果
     * 未确认」= 必须先观察现状，否则会重复发送（提交类动作重复发送是真实
     * 事故来源）。派发路径在内部统一置位——用可变闭包而非返回值传递，
     * 是因为失败可能发生在派发**之后**的任意一步（按键中途失败、剪贴板
     * 写入成功但粘贴失败），只有共享的���量能如实反映"已经动过手"。
     */
    let dispatched = false;
    try {
      this.validate(input);
      if (input.action === 'clipboard_read') {
        return await this.readClipboard(context);
      }
      if (input.action === 'clipboard_write') {
        return await this.writeClipboard(input, context);
      }
      if (input.action === 'clipboard_paste') {
        return await this.pasteClipboard(input, context, () => {
          dispatched = true;
        });
      }
      return await this.dispatchInput(input, () => {
        dispatched = true;
      }, context);
    } catch (error) {
      const message = readableTextError(error);
      /**
       * 错误分类必须与 browser_interact 同构：模型据此区分「改参数即可重试」
       * 与「已经动过手、先观察现状」，否则会在不确定状态下重复发送
       * （提交/粘贴类动作重复发送是真实事故来源）。
       *
       * - INVALID_ARGUMENT：参数形态错误，未触碰浏览器与工作区；
       * - PRECONDITION_FAILED：前置条件未满足（页面/标签页/工作区不可用）；
       * - EXECUTION_UNCERTAIN：已派发但结果未确认。
       */
      const errorKind = !dispatched
        ? message.startsWith('INVALID_ARGUMENT')
          ? 'INVALID_ARGUMENT'
          : 'PRECONDITION_FAILED'
        : 'EXECUTION_UNCERTAIN';
      return {
        ...this.createErrorResponse(
          dispatched
            ? '输入已派发但结果未确认；请先观察现状，不要重复发送'
            : '输入未派发；请按错误提示修正参数或前置条件后重试',
          new Error(message),
        ),
        data: {
          outcome: dispatched ? 'unknown' : 'not_dispatched',
          errorKind,
          cause: {
            errorCode:
              message.match(/^([A-Z][A-Z0-9_]+)[:：]/)?.[1] ??
              (dispatched ? 'INPUT_UNCERTAIN' : 'INPUT_REJECTED'),
            phase: dispatched ? 'dispatch' : 'validate',
          },
        },
      };
    }
  }

  /** 参数校验：形态错误必须在触碰浏览器/工作区之前拦下。 */
  private validate(input: Params): void {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('INVALID_ARGUMENT：参数必须是对象');
    if (!ACTIONS.includes(input.action))
      throw new Error(`INVALID_ARGUMENT：action 必须是 ${ACTIONS.join(' / ')} 之一`);
    if (typeof input.description !== 'string' || !input.description.trim())
      throw new Error('INVALID_ARGUMENT：description 必须说明目标与意图');
    if (input.confirm !== undefined && typeof input.confirm !== 'boolean')
      throw new Error('INVALID_ARGUMENT：confirm 必须为布尔值');
    const allowed = new Set([
      'action',
      'description',
      'confirm',
      'tabId',
      ...ALLOWED_PARAMS[input.action],
    ]);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length)
      throw new Error(
        `INVALID_ARGUMENT：${unknown.join('/')} 不属于 action="${input.action}" 的参数集合`,
      );
    if (input.action === 'keys') {
      if (!Array.isArray(input.keys) || !input.keys.length)
        throw new Error('INVALID_ARGUMENT：keys 必须是非空数组');
      if (input.keys.some((key) => typeof key !== 'string'))
        throw new Error('INVALID_ARGUMENT：keys 的每一项都必须是字符串');
    }
    if (input.action === 'type') {
      if (typeof input.text !== 'string')
        throw new Error('INVALID_ARGUMENT：type 必须提供 text');
      if (input.text.length > TEXT_MAX_CHARS)
        throw new Error(
          `INVALID_ARGUMENT：text 超过上限 ${TEXT_MAX_CHARS} 字符（超长内容请用文件交付）`,
        );
    }
    if (input.clear !== undefined && typeof input.clear !== 'boolean')
      throw new Error('INVALID_ARGUMENT：clear 必须为布尔值');
    if (
      input.action === 'clipboard_write' ||
      input.action === 'clipboard_paste'
    ) {
      const hasText = typeof input.text === 'string';
      const hasPath = typeof input.path === 'string';
      if (hasText && hasPath)
        throw new Error('INVALID_ARGUMENT：text 与 path 只能二选一');
      if (!hasText && !hasPath)
        throw new Error('INVALID_ARGUMENT：必须提供 text 或 path 之一');
      if (hasText && input.text!.length > TEXT_MAX_CHARS)
        throw new Error(
          `INVALID_ARGUMENT：text 超过上限 ${TEXT_MAX_CHARS} 字符（超长内容请用文件交付）`,
        );
      if (hasPath && (!input.path!.trim() || input.path!.length > 300))
        throw new Error('INVALID_ARGUMENT：path 必须是 1-300 字符的工作区相对路径');
    }
    if (input.asTsv !== undefined && typeof input.asTsv !== 'boolean')
      throw new Error('INVALID_ARGUMENT：asTsv 必须为布尔值');
  }

  /** 读取系统剪贴板（敏感操作：由工具级审批规则把关）。 */
  private async readClipboard(context?: ToolExecutionContext) {
    const response = await this.readClipboardText(context);
    if (!response.ok) throw new Error(response.error!);
    return this.createSuccessResponse(
      {
        outcome: 'clipboard_read',
        text: response.text ?? '',
        chars: (response.text ?? '').length,
      },
      `已读取系统剪贴板（${(response.text ?? '').length} 字符）。内容不写入结果文件或日志。`,
    );
  }

  /**
   * 读取剪贴板文本的执行方。
   *
   * service worker 无焦点 → `navigator.clipboard.readText()` 在其中不可靠；
   * 由持有焦点的扩展页面上下文执行。离屏文档明确拒绝读取（见 clipboard-host）。
   */
  private async readClipboardText(
    context?: ToolExecutionContext,
  ): Promise<{ ok: boolean; text?: string; error?: string }> {
    const viaMessage = await this.requestClipboardReadFromExtensionPage(context);
    if (viaMessage.ok) return viaMessage;
    // 扩展页面通路不可用时如实报错，绝不用「空字符串」冒充读取成功。
    return viaMessage;
  }

  /**
   * 通过消息请求具备焦点的扩展页面代读剪贴板。
   *
   * sidepanel 是扩展进程里的真实文档（非 service worker），有 DOM 与焦点，
   * `navigator.clipboard.readText()` 在其中可靠可用。
   */
  private async requestClipboardReadFromExtensionPage(
    context?: ToolExecutionContext,
  ): Promise<{
    ok: boolean;
    text?: string;
    error?: string;
  }> {
    try {
      const response = await browserChrome(context).runtime.sendMessage({
        type: CLIPBOARD_PAGE_MSG.READ,
      });
      if (!response) {
        return {
          ok: false,
          error:
            'CLIPBOARD_READ_UNAVAILABLE：没有可用的扩展页面上下文来读取剪贴板。' +
            '请打开侧边栏面板后重试，或改用不需要读取剪贴板的路径（如直接用工作区文件写入目标）。',
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          error:
            response.error ||
            'CLIPBOARD_READ_FAILED：扩展页面读取剪贴板失败。',
        };
      }
      return { ok: true, text: String(response.text ?? '') };
    } catch (error) {
      return {
        ok: false,
        error:
          'CLIPBOARD_READ_FAILED：读取剪贴板的请求失败：' +
          readableTextError(error),
      };
    }
  }

  /** 写入系统剪贴板（内容来自内联文本或工作区文件）。 */
  private async writeClipboard(input: Params, context?: ToolExecutionContext) {
    const payload = await this.resolvePayload(input, context);
    await writeClipboardViaOffscreen(payload.text, context);
    return this.createSuccessResponse(
      {
        outcome: 'clipboard_written',
        chars: payload.text.length,
        source: payload.source,
        convertedToTsv: payload.converted,
      },
      `已写入系统剪贴板（${payload.text.length} 字符${payload.converted ? '，已按制表符分隔转换' : ''}）。`,
    );
  }

  /**
   * 整表粘贴：写剪贴板 + 派发真实 Ctrl+V。
   *
   * 顺序不可颠倒——先写后派发；Ctrl+V 走 CDP 可信键事件，浏览器读取的是
   * 真实系统剪贴板，因此必须先确保内容已落盘。
   */
  private async pasteClipboard(
    input: Params,
    context: ToolExecutionContext | undefined,
    markDispatched: () => void,
  ) {
    const payload = await this.resolvePayload(input, context);
    await writeClipboardViaOffscreen(payload.text, context);
    return await this.dispatchPaste(input, context, markDispatched);
  }

  /** 组装待写入的剪贴板内容（内联 or 工作区文件）。 */
  private async resolvePayload(
    input: Params,
    context?: ToolExecutionContext,
  ): Promise<{ text: string; source: string; converted: boolean }> {
    if (typeof input.path === 'string') {
      const chatId = typeof context?.chatId === 'string' ? context.chatId.trim() : '';
      if (!chatId)
        throw new Error(
          'INVALID_ARGUMENT：从工作区文件读取剪贴板内容需要会话工作区上下文（当前调用未携带 chatId）',
        );
      try {
        return await loadClipboardPayload(
          input.path,
          input.asTsv === true,
          chatId,
          context?.signal,
        );
      } catch (error) {
        throw new Error(
          'WORKSPACE_READ_FAILED：读取工作区文件失败：' + readableTextError(error),
        );
      }
    }
    return {
      text: input.text ?? '',
      source: 'inline',
      converted: false,
    };
  }

  /** 派发 Ctrl+V（真实可信键事件 → 浏览器原生粘贴）。 */
  private async dispatchPaste(
    input: Params,
    context: ToolExecutionContext | undefined,
    markDispatched: () => void,
  ) {
    const target = await resolveTabTarget({
      tabId: input.tabId,
      tool: this.name,
      context,
    });
    if (!target.ok) throw new Error(target.error);
    const tab = await textTab(context);
    await boundedText(cdpSession.attach(tab.id, context), '附加输入会话');
    const epoch = cdpSession.getEpoch(tab.id);
    const platform = await chrome.runtime.getPlatformInfo();
    const chord = resolveTextKeys(
      [platform.os === 'mac' ? 'Meta' : 'Control', 'v'],
    );
    markDispatched();
    await dispatchKeyChord(tab.id, chord, {
      context,
      beforeEach: async () => {
        if (cdpSession.getEpoch(tab.id) !== epoch)
          throw new Error('STALE_SESSION：调试会话变化');
      },
    });
    return this.createSuccessResponse(
      {
        outcome: 'clipboard_pasted',
        tabId: tab.id,
        focus: await this.focus(tab.id, undefined, context),
        hint:
          '已写入剪贴板并派发真实 Ctrl+V。粘贴结果以页面回显为准——表格类页面请核对目标区域内容与保存状态。',
      },
      '剪贴板内容已写入并派发真实粘贴按键。',
    );
  }

  /** 派发 keys / type。 */
  private async dispatchInput(
    input: Params,
    markDispatched: () => void,
    context?: ToolExecutionContext,
  ) {
    const target = await resolveTabTarget({
      tabId: input.tabId,
      tool: this.name,
      context,
    });
    if (!target.ok) throw new Error(target.error);
    const tab = await textTab(context);
    invalidateAXPages(tab.id);
    await boundedText(cdpSession.attach(tab.id, context), '附加输入会话');
    const epoch = cdpSession.getEpoch(tab.id);
    const ax =
      typeof input.elementId === 'string' && input.elementId.startsWith('ax:');

    if (ax) {
      const axTarget = await resolveAX(input.elementId!, context);
      if (axTarget.tabId !== tab.id) throw new Error('WRONG_TAB');
      markDispatched();
      await textCommand(
        tab.id,
        'DOM.focus',
        { backendNodeId: axTarget.backendNodeId },
        undefined,
        context,
      );
    } else if (input.elementId) {
      // DOM 引用：先聚焦目标元素再输入/按键。
      // frameId 可省略——按 ElementId 自动定位所属 frame（与 browser_interact
      // 同一套推导，见 tools/browser/frame-resolution.ts）；省略 elementId
      // 则作用于当前焦点，不需要 frameId。
      let frameId = input.frameId;
      if (frameId === undefined) {
        const resolution = await resolveElementFrame(tab.id, input.elementId, {
          context,
        });
        if (resolution.status !== 'resolved') {
          throw new Error(
            describeFrameResolutionFailure(resolution, input.elementId),
          );
        }
        frameId = resolution.frameId;
      }
      markDispatched();
      await this.focusElement(tab.id, frameId, input.elementId, context);
    }

    if (input.action === 'keys') {
      const parsed = resolveTextKeys(
        input.keys,
        needsPrimaryModifier(input.keys)
          ? (await chrome.runtime.getPlatformInfo()).os
          : undefined,
      );
      if (parsed.filter((key) => !key.modifier).length !== 1)
        throw new Error('INVALID_ARGUMENT：keys 必须且只能包含一个主键');
      await dispatchKeyChord(tab.id, parsed, {
        context,
        beforeEach: async () => {
          if (cdpSession.getEpoch(tab.id) !== epoch)
            throw new Error('STALE_SESSION：调试会话变化');
        },
      });
    } else {
      if (input.clear) {
        const platform = await chrome.runtime.getPlatformInfo();
        await dispatchKeyChord(
          tab.id,
          resolveKeys([platform.os === 'mac' ? 'Meta' : 'Control', 'a']),
          {
            context,
            beforeEach: async () => {
              if (cdpSession.getEpoch(tab.id) !== epoch)
                throw new Error('STALE_SESSION：调试会话变化');
            },
          },
        );
        await dispatchKeyChord(tab.id, resolveKeys(['Backspace']), {
          context,
          beforeEach: async () => {
            if (cdpSession.getEpoch(tab.id) !== epoch)
              throw new Error('STALE_SESSION：调试会话变化');
          },
        });
      }
      await textCommand(
        tab.id,
        'Input.insertText',
        { text: input.text! },
        undefined,
        context,
      );
    }

    return this.createSuccessResponse(
      {
        outcome: 'dispatched',
        tabId: tab.id,
        focus: await this.focus(tab.id, undefined, context),
        hint: '检查当前选区/编辑器的业务回显；按键可能改变焦点，下一步使用新的 focus 引用。',
      },
      input.action === 'keys'
        ? '快捷键已派发（可信键事件）。'
        : '文本已插入当前焦点。',
    );
  }

  /**
   * 聚焦 DOM 引用目标。
   *
   * 复用 browser_interact 的注入核验路径（同一套引用注册表与失效判定），
   * 保证两个工具对「引用是否还有效」的判断完全一致。
   */
  private async focusElement(
    tabId: number,
    frameId: number,
    elementId: string,
    context?: ToolExecutionContext,
  ): Promise<void> {
    const results = await boundedText(
      executeScriptBounded({
        target: { tabId, frameIds: [frameId] },
        world: 'ISOLATED',
        func: focusReferencePayload,
        args: [elementId],
      }, undefined, undefined, context),
      '聚焦目标元素',
    );
    const result = results[0]?.result as { error?: string } | undefined;
    if (results.length !== 1 || !result)
      throw new Error(
        'INJECTION_NO_RESULT：目标 frame 未返回注入结果，无法确认是否聚焦。',
      );
    if (result.error) throw new Error(result.error);
  }

  /** 当前焦点读取（与 browser_interact 同源口径）。 */
  private async focus(tabId: number, invalidate = false, context?: ToolExecutionContext) {
    const results = await boundedText(
      executeScriptBounded({
        target: { tabId, allFrames: true },
        world: 'ISOLATED',
        func: focusedTextPayload,
        args: [invalidate],
      }, undefined, undefined, context),
      '读取当前焦点',
    );
    return dedupeFocusEntries(
      results
        .filter((result) => result.result)
        .map((result) => ({ ...result.result, frameId: result.frameId })),
    );
  }
}

/** 聚焦指定引用的注入载荷（自包含，可被 chrome.scripting 序列化）。 */
async function focusReferencePayload(elementId: string) {
  const registry = (document as unknown as {
    __agentNexusReferences?: {
      resolve(id: string): Element | null;
      describe?(element: Element): { states?: { disabled?: boolean; readonly?: boolean } };
    };
  }).__agentNexusReferences;
  const element = registry?.resolve(elementId) as HTMLElement | null;
  if (!element) {
    return {
      error:
        'STALE_ELEMENT：引用已失效（元素被替换或页面已变化）。请重新 browser_observe 获取新的 ElementId 与 FrameId，不要复用旧引用。',
    };
  }
  const states = registry?.describe?.(element)?.states;
  if (states?.disabled || states?.readonly)
    return { error: 'NOT_ACTIONABLE：目标控件处于禁用或只读状态，无法聚焦。' };
  element.focus();
  return { success: true, tag: element.localName };
}

export const browserInputTool = new BrowserInputTool();
