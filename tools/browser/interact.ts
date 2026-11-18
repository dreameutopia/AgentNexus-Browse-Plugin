import { executeScriptBounded } from '../common/frame-read';
import { withGuiCancellation } from '../vision/gui-cancellation';
import { BaseBrowserTool } from '../base/browser-tool';
import { resolveTabTarget } from './tab-target';
import type { ToolMetadata, ToolExecutionContext } from '../registry';
import type { OpenAITool } from '@/common/openai-types';
import {
  domActionPayload,
  type SemanticActionOptions,
} from './dom-action-payload';
import { textTargetPayload, focusedTextPayload, dedupeFocusEntries } from './text-target-payload';
import { setFileInputPayload } from './set-file-input-payload';
import { readWorkspaceFileBytes } from '@/utils/python-workspace/workspace-files';
import {
  boundedText,
  exclusiveText,
  textCommand,
  textTab,
  readableTextError,
} from './text-runtime';
import { resolveAX, invalidateAXPages } from './text-accessibility';
import { resolveKeys } from '../vision/key-definitions';
import { needsPrimaryModifier, resolveTextKeys } from './text-keys';
import { cdpSession } from './cdp-session';
import { trustedClickGeometryPayload } from './trusted-click-geometry';
import {
  CONFIRM_GUIDANCE,
  CONFIRM_PARAMETER_DESCRIPTION,
} from '../confirmation-policy';

interface Params extends SemanticActionOptions {
  action:
    | 'click'
    | 'fill'
    | 'focus'
    | 'keys'
    | 'type'
    | 'scroll'
    | 'set_checked'
    | 'set_expanded'
    | 'set_selected'
    | 'select'
    | 'set_files';
  elementId?: string;
  frameId?: number;
  value?: string;
  keys?: string[];
  deltaX?: number;
  deltaY?: number;
  clear?: boolean;
  description?: string;
  confirm?: boolean;
  /** 仅 set_files：工作区相对路径清单（inputs/、content/、results/ 下的文件） */
  paths?: string[];
  /**
   * 用 CDP 派发**可信**鼠标事件（isTrusted=true）而非合成 DOM 事件。
   *
   * 合成事件的 isTrusted=false，React/Vue 等受控组件会据此回滚状态——
   * 这类控件用合成点击永远不生效。可信点击能解决它们。
   */
  trusted?: boolean;
  /** 目标标签页（可选；省略=当前活动页；显式传入会先校验并切换到该页） */
  tabId?: number | string;
}
const fields: Record<Params['action'], string[]> = {
  click: [],
  fill: ['value'],
  focus: [],
  keys: ['keys'],
  type: ['value', 'clear'],
  scroll: ['deltaX', 'deltaY'],
  set_checked: ['checked'],
  set_expanded: ['expanded'],
  set_selected: ['selected'],
  select: ['values'],
  set_files: ['paths'],
};

/** set_files 的扩展名 → MIME（未收录一律 octet-stream；浏览器对多数场景不敏感） */
const WORKSPACE_MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
function mimeOfWorkspaceFile(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return WORKSPACE_MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * 字节 → base64 分块（每块 ≤ ~600K 字符，注入参数不撑爆）。
 * 除最后一块外按 3 字节对齐切片——各块独立 btoa 后拼接仍是合法 base64
 * （只有末块允许出现 padding）。
 */
function base64ChunksOf(bytes: Uint8Array, maxBytesPerChunk = 450_000): string[] {
  const aligned = Math.floor(maxBytesPerChunk / 3) * 3;
  const chunks: string[] = [];
  const encode = (slice: Uint8Array): string => {
    let binary = '';
    const BATCH = 0x8000;
    for (let i = 0; i < slice.length; i += BATCH)
      binary += String.fromCharCode.apply(
        null,
        Array.from(slice.subarray(i, i + BATCH)),
      );
    return btoa(binary);
  };
  for (let offset = 0; offset < bytes.length; offset += aligned)
    chunks.push(encode(bytes.subarray(offset, Math.min(offset + aligned, bytes.length))));
  return chunks.length ? chunks : [''];
}

export class BrowserInteractTool extends BaseBrowserTool {
  name = 'browser_interact';
  metadata: ToolMetadata = {
    name: this.name,
    description:
      '纯文本节点交互：点击、填充、状态设置、原生按键与输入、聚焦、容器滚动、工作区文件上传（set_files）',
    category: 'browser',
    version: '6.1.0',
    requiresConfirm: true,
  };
  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: this.name,
      description:
        '<interact>\n' +
        '  <capability>操作 browser_observe 返回的引用：点击、填充、状态设置（勾选/展开/选中）、聚焦、原生按键与输入、容器滚动、工作区文件上传。</capability>\n' +
        '  <actions>\n' +
        '    <action name="click">DOM 点击。</action>\n' +
        '    <action name="fill">填充 input/textarea/单选 select；不处理 checkbox/radio/file 或多选 select。</action>\n' +
        '    <action name="set_checked">按布尔目标状态幂等勾选（checkbox/radio/switch/toggle）。</action>\n' +
        '    <action name="set_expanded">按布尔目标状态幂等展开/收起。</action>\n' +
        '    <action name="set_selected">设置 option/tab/treeitem 等的选中状态。</action>\n' +
        '    <action name="select">原生 select 按 value 优先、唯一文字兜底替换选中集合，多选可传 [] 清空；自定义列表每次仅一项，限定 aria-controls/owns 关联或列表内部已渲染选项，不猜全页同名项；自定义多选对 option 分别 set_selected/set_checked。</action>\n' +
        '    <action name="set_files">把工作区文件装载进 file input（paths 传工作区相对路径，如 inputs/简历.pdf；隐藏的 file input 也支持，目标可是其直接引用或包含它的包装元素）。字节从会话工作区读出后注入页面并回读 input.files 校验。把文件内容交给网页=向该站点传输数据：文件含个人隐私（简历/证件等）或目标站点可疑时，按下方 confirm 审批规则请求用户放行。</action>\n' +
        '    <action name="focus">聚焦。</action>\n' +
        '    <action name="keys">一个浏览器原生组合键（如 ["Mod","a"] 全选、["F2"] 编辑、["Escape"] 取消）。**省略 elementId 时派发给当前焦点**（焦点在 body/浮层关闭这类场景用它，不需要先找到焦点元素）。Mod 在 Windows/Linux 映射 Control、在 macOS 映射 Meta。大写字母不隐含 Shift，需要时显式传 Shift；标点按 US 键位，Unicode 用 type。后台窗口（窗口不在前台）同样可派发。</action>\n' +
        '    <action name="type">向已聚焦编辑器插入文本；仅限已聚焦编辑器，不自动进入表格编辑模式。clear=true 先全选退格清空当前编辑器，不能假定它能把 TSV 粘贴为二维单元格。</action>\n' +
        '    <action name="scroll">按 CSS 像素滚动指定容器；省略 elementId 时滚动指定 frame 的文档，仍必须提供从当前观察确定的 frameId，不能猜为 0。</action>\n' +
        '  </actions>\n' +
        '  <references>DOM 引用必须提供 FrameId（同一行的）；keys 省略 elementId 时也省略 frameId；AX 引用自带路由，只支持 focus/keys/type。展开、搜索、滚动、选择后重新观察，虚拟列表不保证全量。本工具没有 hover，不可用 click 冒充悬停。每次必须提供 description 说明目标与意图。</references>\n' +
        '  <trusted>默认派发**合成** DOM 事件（isTrusted=false）。React/Vue 等受控组件会据此回滚状态——表现为「点击/勾选没反应」。这类控件把 click 改为 trusted=true，用 CDP 派发真实鼠标事件（isTrusted=true）。trusted=true 要求目标可见、在视口内且未被遮挡；被遮挡时报 OBSCURED。</trusted>\n' +
        '  <result>outcome 标明实际发生了什么（state_verified / dispatched / not_dispatched / unknown）。成功只表示派发或回读，需检查业务结果。</result>\n' +
        '  <errors>outcome=not_dispatched 表示交互未派发，按错误修正前置条件；unknown 表示可能部分生效，先核对现状，不重放发送/提交。STALE_ELEMENT 表示引用已失效，重新 browser_observe 获取新引用与 FrameId，不要猜测 CSS 或尝试其他 frame；UNOBSERVABLE_STATE 表示控件未暴露目标状态，附 stateCandidates 供判断；FOCUS_CHANGED 的错误文本会直接给出当前焦点在哪个元素（含可用 elementId）——按它给的引用操作，不要盲目重观察；VALUE_MISMATCH 会给出期望值与页面实际值，按差异判断格式约束后再改。</errors>\n' +
        '</interact>' +
        CONFIRM_GUIDANCE,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: Object.keys(fields) },
          checked: {
            type: 'boolean',
            description:
              '仅 set_checked：期望勾选状态；radio 只允许 true，取消时选择同组另一项。' +
              '工具会自动定位状态宿主控件（可见 label 或 role 包装器包裹的隐藏 input），无需手动指定。',
          },
          expanded: {
            type: 'boolean',
            description:
              '仅 set_expanded：期望展开状态，支持 aria-expanded 或原生 summary。',
          },
          selected: {
            type: 'boolean',
            description:
              '仅 set_selected：期望选中状态，用于暴露 aria-selected 的 option/tab/treeitem 等。',
          },
          values: {
            type: 'array',
            maxItems: 100,
            uniqueItems: true,
            items: { type: 'string', maxLength: 2000 },
            description:
              '仅 select：原生 select 按 value 优先、唯一文字兜底替换选中集合；自定义列表只支持单项，先展开后重采。',
          },
          elementId: {
            type: 'string',
            description:
              '原样复制观察结果的 ElementId；文档 scroll、以及「派发给当前焦点」的 keys 可省略',
          },
          tabId: {
            type: 'integer',
            minimum: 0,
            description:
              '目标标签页 ID（可选；省略=当前活动标签页）。显式传入会先核对存在性与可注入性，再切换到该标签页执行。',
          },
          frameId: {
            type: 'number',
            description:
              'DOM 引用同一行的 FrameId；无 elementId 的文档 scroll 与省略 elementId 的 keys 都不需要它，从当前观察确定；AX 引用省略',
          },
          value: {
            type: 'string',
            description:
              'fill/type 的文本，空字符串可清空；最多20000字符。select 的 fill 可传选项值或唯一文字',
          },
          keys: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            items: { type: 'string' },
            description:
              '一个主键和至多4个修饰键。如 ["Mod","a"] 全选、["Control","Shift","z"] 重做、["F2"]。Mod/ControlOrMeta 按平台映射 Control 或 Meta；接受 Ctrl/Cmd/Option/Esc/Return/Del/PgUp/PgDn 等别名。支持 ASCII 字母数字标点、F1-F24、方向/Home/End/PageUp/PageDown/Insert/Tab/Enter/Escape/Backspace/Delete/Space/ContextMenu 及锁定键。组合中的大写字母不隐式添加 Shift，需要时显式传 Shift。标点采用 US 键位；Unicode 用 type。只派发页面按键，不保证触发浏览器菜单、剪贴板权限或系统全局热键；导航/切标签使用专用工具。',
          },
          deltaX: {
            type: 'number',
            description: 'scroll 水平 CSS 像素，正数向右；绝对值最多10000',
          },
          deltaY: {
            type: 'number',
            description: 'scroll 垂直 CSS 像素，正数向下；绝对值最多10000',
          },
          clear: {
            type: 'boolean',
            description: 'type 前用全选与退格清空当前编辑器；默认false',
          },
          description: {
            type: 'string',
            description: '具体目标、所属记录及操作意图',
          },
          confirm: {
            type: 'boolean',
            description: CONFIRM_PARAMETER_DESCRIPTION,
          },
          trusted: {
            type: 'boolean',
            description:
              '仅 action="click"：用 CDP 派发可信鼠标事件（isTrusted=true）而非合成 DOM 事件。' +
              '合成事件会被 React/Vue 受控组件回滚（勾选/展开点了没反应）——' +
              '合成点击无效且元素可见可点时改用 trusted=true。',
          },
          paths: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            uniqueItems: true,
            items: { type: 'string', minLength: 1, maxLength: 300 },
            description:
              '仅 set_files：工作区相对路径（如 inputs/简历.pdf、content/x.png、results/chart.xlsx），1-5 个。' +
              '文件从会话工作区读出后注入目标 file input；单次传输合计上限 8MB。' +
              '注意：这会把文件内容交给该网页——传输个人隐私文件或目标站点可疑时，按 confirm 审批规则请求用户放行。',
          },
        },
        required: ['action', 'description'],
        anyOf: Object.keys(fields).map((action) => ({
          type: 'object',
          properties: { action: { type: 'string', enum: [action] } },
          required: [
            'action',
            // scroll（文档滚动）与 keys（省略即派发给当前焦点）允许无引用调用
            ...(action === 'scroll' || action === 'keys'
              ? []
              : ['elementId']),
            ...(['fill', 'type'].includes(action)
              ? ['value']
              : action === 'keys'
                ? ['keys']
                : action === 'select'
                  ? ['values']
                  : action === 'set_checked'
                    ? ['checked']
                    : action === 'set_expanded'
                      ? ['expanded']
                      : action === 'set_selected'
                        ? ['selected']
                        : action === 'set_files'
                          ? ['paths']
                          : []),
          ],
        })),
      },
    },
  };

  async execute(
    input: Params,
    context?: ToolExecutionContext,
    beforeTrustedClick?: (tab: chrome.tabs.Tab & { id: number }, signal?: AbortSignal) => Promise<void>,
  ) {
    this.ensureBackgroundContext();
    let validated = false;
    let dispatched = false;
    /** keys/type 的真实输入是否已送进 CDP——区分「焦点动了但没打字」与「打了一半」 */
    let inputDispatched = false;
    let domFailure: {
      errorCode?: string;
      phase?: string;
      /** 控件语义诊断（状态宿主/勾选前后值/候选信号）——错误响应必须带给模型 */
      controlElementId?: string;
      observedBefore?: boolean | 'mixed' | null;
      observedAfter?: boolean | 'mixed' | null;
      stateCandidates?: Record<string, unknown>;
      suggestedAction?: string;
      /** VALUE_MISMATCH 的期望/实际值（错误文案里已有摘要，这里是完整体） */
      expectedValue?: string;
      actualValue?: string;
    } | undefined;
    try {
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        !Object.hasOwn(fields, input.action)
      )
        throw new Error('action 无效');
      const allowed = new Set([
        'action',
        'elementId',
        'frameId',
        'tabId',
        'description',
        'confirm',
        'trusted',
        ...fields[input.action],
      ]);
      if (Object.keys(input).some((k) => !allowed.has(k)))
        throw new Error('存在不属于该 action 的参数，请按 Schema 调用');
      if (typeof input.description !== 'string' || !input.description.trim())
        throw new Error('description 必须说明目标与意图');
      if (input.confirm !== undefined && typeof input.confirm !== 'boolean')
        throw new Error('confirm 必须为布尔值');
      if (input.trusted !== undefined && typeof input.trusted !== 'boolean')
        throw new Error('trusted 必须为布尔值');
      if (input.trusted && input.action !== 'click')
        throw new Error(
          'INVALID_ARGUMENT：trusted 目前只支持 action="click"；其它动作请用默认的合成事件路径。',
        );
      if (
        ['fill', 'type'].includes(input.action) &&
        (typeof input.value !== 'string' || input.value.length > 20000)
      )
        throw new Error('value 必须是最多20000字符的字符串');
      if (input.clear !== undefined && typeof input.clear !== 'boolean')
        throw new Error('clear 必须为布尔值');
      for (const [action, field] of [
        ['set_checked', 'checked'],
        ['set_expanded', 'expanded'],
        ['set_selected', 'selected'],
      ] as const)
        if (input.action === action && typeof input[field] !== 'boolean')
          throw new Error(field + ' 必须为布尔值');
      if (
        input.action === 'select' &&
        (!Array.isArray(input.values) ||
          input.values.length > 100 ||
          input.values.some(
            (value) => typeof value !== 'string' || value.length > 2000,
          ) ||
          new Set(input.values).size !== input.values.length)
      )
        throw new Error('values 必须是最多100项、无重复的字符串数组');
      if (input.action === 'scroll') {
        for (const delta of [input.deltaX ?? 0, input.deltaY ?? 0])
          if (!Number.isFinite(delta) || Math.abs(delta) > 10000)
            throw new Error('滚动量必须是绝对值不超过10000的有限数值');
        if (!(input.deltaX || input.deltaY))
          throw new Error('scroll 至少有一个非零滚动量');
      }
      if (input.action === 'set_files') {
        if (
          !Array.isArray(input.paths) ||
          !input.paths.length ||
          input.paths.length > 5 ||
          input.paths.some(
            (path) => typeof path !== 'string' || !path.trim() || path.length > 300,
          )
        )
          throw new Error(
            'paths 必须是 1-5 个非空的工作区相对路径字符串（如 inputs/简历.pdf）',
          );
      }
      const ax =
        typeof input.elementId === 'string' &&
        input.elementId.startsWith('ax:');
      const match =
        typeof input.elementId === 'string'
          ? /^anx:(\d+):[a-f0-9-]+:\d+$/.exec(input.elementId)
          : null;
      /** 无引用 keys：派发给当前焦点/文档级（Escape 关闭浮层等）——不需要 frameId 与 elementId */
      const focusScopedKeys =
        input.action === 'keys' && input.elementId === undefined;
      if (
        !ax &&
        !focusScopedKeys &&
        (!Number.isSafeInteger(input.frameId) || input.frameId! < 0)
      )
        throw new Error(
          'DOM 操作必须提供观察结果的 FrameId（文档 scroll 与省略 elementId 的 keys 除外）',
        );
      if (
        !ax &&
        !(input.action === 'scroll' && input.elementId === undefined) &&
        !focusScopedKeys &&
        !match
      )
        throw new Error('INVALID_ELEMENT_ID：请原样使用观察结果引用');
      if (ax && input.frameId !== undefined)
        throw new Error('AX 引用自带路由，请省略 frameId');
      if (ax && !['focus', 'keys', 'type'].includes(input.action))
        throw new Error(
          'AX 引用仅支持 focus/keys/type；DOM 操作请重采 DOM 引用',
        );
      let parsedKeys =
        input.action === 'keys'
          ? resolveTextKeys(
              input.keys,
              needsPrimaryModifier(input.keys) ? 'win' : undefined, // syntax check only; resolve actual platform below
            )
          : [];
      if (
        input.action === 'keys' &&
        parsedKeys.filter((k) => !k.modifier).length !== 1
      )
        throw new Error('keys 必须且只能包含一个主键');
      validated = true;
      if (input.action === 'keys' && needsPrimaryModifier(input.keys))
        parsedKeys = resolveTextKeys(
          input.keys,
          (
            await boundedText(
              chrome.runtime.getPlatformInfo(),
              '读取平台按键映射',
            )
          ).os,
        );
      const p = structuredClone(input);
      return await withGuiCancellation(
        context?.requestId,
        (signal) =>
          exclusiveText(async () => {
            if (signal?.aborted) throw new Error('CANCELLED：操作尚未开始');
            const target = await resolveTabTarget({
              tabId: input.tabId,
              tool: 'browser_interact',
              context,
            });
            if (!target.ok) throw new Error(target.error);
            const tab = await textTab(context);
            if (match && Number(match[1]) !== tab.id)
              throw new Error(
                `WRONG_TAB：该引用属于标签页 ${Number(match[1])}，当前活动页是 ${tab.id}。` +
                  `传 tabId=${Number(match[1])} 重试（会自动切换到该页），或重新观察后使用新引用。`
              );
            invalidateAXPages(tab.id);
            await this.focus(tab.id, true, context);
            const deadline = Date.now() + 20_000;
            const check = async () => {
              if (signal?.aborted)
                throw new Error('CANCELLED：输入已停止，先观察现状');
              if (Date.now() > deadline)
                throw new Error('TIMEOUT：操作超时，先观察现状');
              const current = await textTab(context);
              if (current.id !== tab.id || current.url !== tab.url)
                throw new Error('TARGET_CHANGED：标签页或页面变化，输入停止');
            };
            const dom = async (
              phase: Parameters<typeof textTargetPayload>[0],
            ) => {
              await check();
              if (phase === 'scroll' || phase === 'focus') dispatched = true;
              const results = await boundedText(
                executeScriptBounded({
                  target: { tabId: tab.id, frameIds: [p.frameId!] },
                  world: 'ISOLATED',
                  func: textTargetPayload,
                  args: [
                    phase,
                    p.elementId || '',
                    p.deltaX ?? 0,
                    p.deltaY ?? 0,
                  ],
                }, undefined, undefined, context),
                '核验节点',
              );
              const result = results[0]?.result;
              if (results.length !== 1 || !result || result.error)
                throw new Error(
                  result?.error ||
                    'INJECTION_NO_RESULT：目标 frame 未返回注入结果，无法确认是否执行；请先观察现状。重新采集元素不能修复注入故障。',
                );
              return result;
            };
            if (p.action === 'scroll')
              return this.createSuccessResponse(await dom('scroll'));
            // 文件装载：独立通道（工作区字节 → 分块注入 → input.files 回读），
            // 不走可见性/遮挡闸门——隐藏 file input 是该控件族的正确形态
            if (p.action === 'set_files')
              return await this.executeSetFiles(p, tab, check, context);
            /**
             * 可信点击（trusted=true）：用 CDP Input.dispatchMouseEvent 派发
             * **真实可信**的鼠标事件（isTrusted=true）。
             *
             * 为什么需要：合成事件（element.dispatchEvent / element.click()）
             * 的 isTrusted=false，React 受控组件会据此回滚状态——这类控件用
             * 合成点击**永远勾不上**。仓库的视觉通道早已用可信事件（gui-driver
             * 的 Input.dispatchMouseEvent），文本通道此前没有，这里补齐。
             *
             * 默认仍是合成事件（trusted 省略/false），保证既有行为零变化；
             * 由模型在合成点击失败时自行升级。
             */
            if (p.trusted && p.action === 'click') {
              await check();
              // 注意：dispatched 置位在坐标采集**之后**——采集失败（失效/遮挡/视口外）
              // 时点击从未派发，错误必须说「未派发」而不是「可能部分生效」。
              const geometry = await this.collectTrustedGeometry(
                tab.id,
                p.frameId!,
                p.elementId!,
                context,
              );
              if ('error' in geometry) throw new Error(geometry.error);
              if (!geometry.visible)
                throw new Error(
                  'NOT_RENDERED：目标不可见（隐藏或零面积），无法派发可信点击。' +
                    '若目标是自定义控件的可见表面，请对可见表面（label/包装器）使用 trusted 点击。',
                );
              if (!geometry.inViewport)
                throw new Error(
                  'OFFSCREEN：目标不在视口内，无法派发可信点击。' +
                    '请先用 browser_interact(action="scroll") 把它滚入视口，或改用合成点击。',
                );
              if (!geometry.hitTarget)
                throw new Error(
                  `OBSCURED：目标的可点位置被其它元素遮挡（命中 ${geometry.hitDescription}）。` +
                    '请先关闭遮挡物，或改用合成点击。',
                );
              if (beforeTrustedClick) {
                await beforeTrustedClick(tab, signal);
                await check();
              }
              dispatched = true;
              await this.dispatchTrustedClick(
                tab.id,
                geometry.topLevel.x,
                geometry.topLevel.y,
                context,
              );
              return this.createSuccessResponse(
                {
                  outcome: 'trusted_click_dispatched',
                  trusted: true,
                  point: geometry.topLevel,
                  hit: geometry.hitDescription,
                },
                '可信点击已派发（CDP 真实鼠标事件，isTrusted=true）。请重新观察页面确认业务结果。',
              );
            }
            if (
              [
                'click',
                'fill',
                'set_checked',
                'set_expanded',
                'set_selected',
                'select',
              ].includes(p.action)
            ) {
              await check();
              dispatched = true;
              const results = await boundedText(
                executeScriptBounded({
                  target: { tabId: tab.id, frameIds: [p.frameId!] },
                  world: 'ISOLATED',
                  func: domActionPayload,
                  // Chrome injection args use JSON serialization; undefined is
                  // rejected even though structuredClone accepts it.
                  args: [
                    p.action as Parameters<typeof domActionPayload>[0],
                    p.elementId!,
                    p.value ?? '',
                    Object.fromEntries(
                      ['checked', 'expanded', 'selected', 'values']
                        .filter((key) => key in p)
                        .map((key) => [key, p[key as keyof Params]]),
                    ),
                  ],
                }, undefined, undefined, context),
                'DOM 交互',
              );
              const result = results[0]?.result;
              if (result?.outcome === 'not_dispatched') dispatched = false;
              if (result?.error) domFailure = {
                errorCode: result.errorCode || result.error.match(/^([A-Z][A-Z0-9_]+)[:：]/)?.[1] || 'DOM_ACTION_FAILED',
                phase: result.phase || p.action,
                // 诊断字段随错误一起出舱：模型据此区分「没点上」与「点上了被回滚」
                ...(result.controlElementId ? { controlElementId: result.controlElementId } : {}),
                ...(result.observedBefore !== undefined ? { observedBefore: result.observedBefore } : {}),
                ...(result.observedAfter !== undefined ? { observedAfter: result.observedAfter } : {}),
                ...(result.stateCandidates ? { stateCandidates: result.stateCandidates as Record<string, unknown> } : {}),
                ...(result.suggestedAction ? { suggestedAction: result.suggestedAction } : {}),
                ...(typeof result.expectedValue === 'string' ? { expectedValue: result.expectedValue } : {}),
                ...(typeof result.actualValue === 'string' ? { actualValue: result.actualValue } : {}),
              };
              if (results.length !== 1 || !result?.success || result.error) {
                // 关键诊断直接进错误文案：模型首先读的是 error 字符串，
                // 只放在 data 里会被忽略。格式紧凑，只带决策需要的字段。
                const diagnostics = [
                  result?.observedBefore !== undefined
                    ? `勾选前=${String(result.observedBefore)}`
                    : '',
                  result?.observedAfter !== undefined
                    ? `勾选后=${String(result.observedAfter)}`
                    : '',
                  result?.controlElementId
                    ? `状态宿主=${result.controlElementId}`
                    : '',
                  result?.stateCandidates?.ariaChecked !== undefined &&
                  result?.stateCandidates?.ariaChecked !== null
                    ? `aria-checked=${String(result.stateCandidates.ariaChecked)}`
                    : '',
                  Array.isArray(result?.stateCandidates?.classNames) &&
                  (result.stateCandidates.classNames as string[]).length
                    ? `class=${(result.stateCandidates.classNames as string[]).slice(0, 4).join('.')}`
                    : '',
                ].filter(Boolean);
                throw new Error(
                  (result?.error || 'INJECTION_NO_RESULT：目标 frame 未返回注入结果，无法确认是否执行；请先观察现状。重新采集元素不能修复注入故障。') +
                    (diagnostics.length ? `（${diagnostics.join('，')}）` : ''),
                );
              }
              return this.createSuccessResponse(
                {
                  ...result,
                  focus: await this.focus(tab.id, undefined, context),
                  outcome:
                    result.outcome ||
                    (p.action === 'fill' ? 'value_verified' : 'dispatched'),
                },
                result.message,
              );
            }
            const guard = async (editable = false) => {
              await check();
              // 无引用 keys：不做元素级焦点核验（派发对象就是「当前焦点/文档」，
              // 由 CDP 路由），只保证标签页与会话仍然有效
              if (focusScopedKeys) return;
              if (ax) {
                const target = await resolveAX(p.elementId!, context);
                if (target.tabId !== tab.id) throw new Error('WRONG_TAB');
                const resolved = await textCommand(tab.id, 'DOM.resolveNode', {
                  backendNodeId: target.backendNodeId,
                  objectGroup: 'agentnexus-text',
                }, undefined, context);
                const objectId = resolved.object?.objectId;
                if (!objectId)
                  throw new Error('STALE_ELEMENT：AX 目标不能解析');
                try {
                  const r = await textCommand(
                    tab.id,
                    'Runtime.callFunctionOn',
                    {
                      objectId,
                      // 不查 ownerDocument.hasFocus()：CDP 派发对后台窗口有效，
                      // 窗口不在前台不该把 AX 键盘面整个打死（与 DOM 路径同策略）
                      functionDeclaration: `function(){return {focused:this.getRootNode().activeElement===this&&!this.matches(':disabled')&&!this.closest('[inert],[aria-disabled="true"],[data-disabled]:not([data-disabled="false"])'),editable:!!(!this.matches('[readonly],:disabled')&&!this.closest('[inert],[aria-disabled="true"],[aria-readonly="true"],[data-disabled]:not([data-disabled="false"])')&&(this.isContentEditable||this.localName==='textarea'||(this.localName==='input'&&['text','search','email','password','url','tel','number'].includes(this.type))))};}`,
                      returnByValue: true,
                    }, undefined, context
                  );
                  if (
                    !r.result?.value?.focused ||
                    (editable && !r.result.value.editable)
                  )
                    throw new Error('FOCUS_CHANGED：AX 目标不是当前可编辑焦点');
                } finally {
                  await textCommand(tab.id, 'Runtime.releaseObject', {
                    objectId,
                  }, undefined, context).catch(() => undefined);
                }
              } else await dom(editable ? 'type' : 'verify');
            };
            if (ax) {
              const target = await resolveAX(p.elementId!, context);
              dispatched = true;
              await textCommand(tab.id, 'DOM.focus', {
                backendNodeId: target.backendNodeId,
              }, undefined, context);
            } else if (!focusScopedKeys) await dom('focus');
            if (p.action === 'focus')
              return this.createSuccessResponse({
                outcome: 'focused',
                focus: await this.focus(tab.id, undefined, context),
              });
            await boundedText(cdpSession.attach(tab.id, context), '附加输入会话');
            const epoch = cdpSession.getEpoch(tab.id);
            const inputCommand = async (method: string, params: object) => {
              await guard(p.action === 'type');
              if (cdpSession.getEpoch(tab.id) !== epoch)
                throw new Error('STALE_SESSION：调试会话变化');
              try {
                await textCommand(tab.id, method, params, undefined, context);
                inputDispatched = true;
              } catch (error) {
                await cdpSession.detach(tab.id, context);
                throw error;
              }
            };
            const chord = async (keys: ReturnType<typeof resolveKeys>) => {
              const held: typeof keys = [];
              let modifiers = 0;
              let failedGesture = false;
              let gestureError: unknown;
              const failed: string[] = [];
              try {
                for (const k of keys) {
                  await guard(p.action === 'type');
                  if (cdpSession.getEpoch(tab.id) !== epoch)
                    throw new Error('STALE_SESSION');
                  modifiers |= k.modifier;
                  const text =
                    !k.modifier && !(modifiers & ~8)
                      ? k.key.length === 1
                        ? modifiers & 8
                          ? k.shifted || k.key
                          : k.key
                        : k.key === 'Enter'
                          ? '\r'
                          : undefined
                      : undefined;
                  const dispatchedKey =
                    k.key.length === 1 && modifiers & 8
                      ? k.shifted || k.key
                      : k.key;
                  held.push({ ...k, key: dispatchedKey });
                  await textCommand(tab.id, 'Input.dispatchKeyEvent', {
                    type: 'keyDown',
                    key: dispatchedKey,
                    code: k.code,
                    windowsVirtualKeyCode: k.windowsVirtualKeyCode,
                    modifiers,
                    ...(text !== undefined
                      ? {
                          text,
                          unmodifiedText: text,
                        }
                      : {}),
                  }, undefined, context);
                  inputDispatched = true;
                }
              } catch (error) {
                failedGesture = true;
                gestureError = error;
              } finally {
                for (const k of held.reverse()) {
                  modifiers &= ~k.modifier;
                  try {
                    await textCommand(tab.id, 'Input.dispatchKeyEvent', {
                      type: 'keyUp',
                      key: k.key,
                      code: k.code,
                      windowsVirtualKeyCode: k.windowsVirtualKeyCode,
                      modifiers,
                    }, undefined, context);
                  } catch {
                    failed.push(k.key);
                  }
                }
                if (failedGesture || failed.length)
                  await cdpSession.detach(tab.id, context).catch(() => undefined);
              }
              if (failed.length)
                throw new Error(
                  'CLEANUP_FAILED：未确认释放按键，已请求脱离会话；请观察现状',
                );
              if (failedGesture) throw gestureError;
            };
            if (p.action === 'keys') await chord(parsedKeys);
            else {
              if (p.clear) {
                const platform = await chrome.runtime.getPlatformInfo();
                await chord(
                  resolveKeys([
                    platform.os === 'mac' ? 'Meta' : 'Control',
                    'a',
                  ]),
                );
                await chord(resolveKeys(['Backspace']));
              }
              await inputCommand('Input.insertText', { text: p.value! });
            }
            return this.createSuccessResponse({
              outcome: 'dispatched',
              focus: await this.focus(tab.id, undefined, context),
              hint: '检查当前选区/编辑器和保存反馈；按键可能改变焦点，下一步使用新 focus 引用。',
            });
          }),
        context?.signal,
      );
    } catch (error) {
      const message = readableTextError(error);
      /**
       * keys/type 的「焦点动了但输入没出去」单列：焦点切换是已发生的副作用，
       * 但请求的按键/文本一个都没进 CDP——按「未派发」报，错误文案说明焦点
       * 已变。混进「可能部分生效」会让模型误以为打了一半而不敢重发。
       */
      const focusOnly =
        (input?.action === 'keys' || input?.action === 'type') &&
        dispatched &&
        !inputDispatched;
      const result = this.createErrorResponse(
        focusOnly
          ? '焦点已切换但输入未派发；按错误中的当前焦点引用修正后重试（keys 可省略 elementId 派发给当前焦点）'
          : dispatched
            ? '纯文本交互失败；结果可能部分生效，请先观察现状，不自动重试'
            : validated
              ? '交互未派发；请按错误处理前置条件后再操作'
              : 'INVALID_ARGUMENT：交互未派发；修正参数后重试，无需仅因参数错误重新观察',
        new Error(message),
      );
      return {
        ...result,
        data: {
          outcome: !dispatched || focusOnly ? 'not_dispatched' : 'unknown',
          errorKind: !validated
            ? 'INVALID_ARGUMENT'
            : !dispatched || focusOnly
              ? 'PRECONDITION_FAILED'
              : 'EXECUTION_UNCERTAIN',
          cause: domFailure || {errorCode:message.match(/^([A-Z][A-Z0-9_]+)[:：]/)?.[1] || 'TEXT_INTERACTION_FAILED',phase:validated ? 'dispatch' : 'validate'},
        },
      };
    }
  }
  /**
   * 采集可信点击所需的几何信息（元素视口坐标 + frame 偏移 + 命中检查）。
   *
   * 必须在**目标 frame 内**注入：getBoundingClientRect() 返回的是 frame 局部
   * 坐标，直接拿去派发会点到错误位置（多层 iframe 会累积偏差）。
   */
  private async collectTrustedGeometry(
    tabId: number,
    frameId: number,
    elementId: string,
    context?: ToolExecutionContext,
  ): Promise<
    | {
        local: { x: number; y: number };
        rect: { x: number; y: number; width: number; height: number };
        frameOffset: { x: number; y: number };
        framesDeep: number;
        hitTarget: boolean;
        hitDescription: string;
        inViewport: boolean;
        visible: boolean;
        topLevel: { x: number; y: number };
      }
    | { error: string }
  > {
    const results = await boundedText(
      executeScriptBounded({
        target: { tabId, frameIds: [frameId] },
        world: 'ISOLATED',
        func: trustedClickGeometryPayload,
        args: [elementId],
      }, undefined, undefined, context),
      '采集点击坐标',
    );
    const payload = results[0]?.result as
      | {
          local: { x: number; y: number };
          rect: { x: number; y: number; width: number; height: number };
          frameOffset: { x: number; y: number };
          framesDeep: number;
          hitTarget: boolean;
          hitDescription: string;
          inViewport: boolean;
          visible: boolean;
          topLevel: { x: number; y: number };
        }
      | { error: string }
      | undefined;
    if (!payload) return { error: 'INJECTION_NO_RESULT：目标 frame 未返回几何信息' };
    if ('error' in payload) return payload;
    return payload;
  }

  /**
   * 派发可信鼠标点击（CDP Input.dispatchMouseEvent）。
   *
   * 事件序列与真实鼠标一致：move → press → release。CDP 注入的事件在页面侧
   * isTrusted=true，React/Vue 的受控状态因此会正常响应。
   */
  private async dispatchTrustedClick(
    tabId: number,
    x: number,
    y: number,
    context?: ToolExecutionContext,
  ): Promise<void> {
    await boundedText(cdpSession.attach(tabId, context), '附加调试会话');
    const epoch = cdpSession.getEpoch(tabId);
    const send = async (type: string, extra: Record<string, unknown>) => {
      await textCommand(
        tabId,
        'Input.dispatchMouseEvent',
        { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra },
        undefined,
        context,
      );
    };
    // 先移动到目标（部分框架在 hover 时才渲染出可点表面）
    await textCommand(
      tabId,
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0 },
      undefined,
      context,
    );
    if (cdpSession.getEpoch(tabId) !== epoch)
      throw new Error('STALE_SESSION：调试会话变化');
    // press/release 必须配对：按下后任何异常都必须释放，否则页面会留下
    // 「鼠标一直按着」的状态（拖拽选择、拖动排序全被带偏）。
    let pressed = false;
    try {
      await send('mousePressed', {});
      pressed = true;
      if (cdpSession.getEpoch(tabId) !== epoch)
        throw new Error('STALE_SESSION：调试会话变化');
    } finally {
      if (pressed) await send('mouseReleased', {}).catch(() => undefined);
    }
  }

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
        .filter((r) => r.result)
        .map((r) => ({ ...r.result, frameId: r.frameId })),
    );
  }
  /**
   * set_files：会话工作区文件 → file input。
   *
   * 数据流：chatId 定位工作区 → 读字节（合计 ≤8MB）→ 分块 base64 注入页面
   * 缓冲 → commit 组装 File/DataTransfer 赋值并派发 input/change → 回读
   * input.files 校验。任何一步失败都会 best-effort 清理页面缓冲；失败路径
   * 里文件从未写进控件（commit 内部先组装后一次赋值），语义是「未派发」，
   * 例外只有 commit 的 VERIFY_FAILED（已赋值但页面回读不符 → unknown）。
   */
  private async executeSetFiles(
    p: Params,
    tab: { id: number; url: string },
    check: () => Promise<void>,
    context?: ToolExecutionContext,
  ) {
    const chatId =
      typeof context?.chatId === 'string' ? context.chatId.trim() : '';
    if (!chatId)
      throw new Error(
        'INVALID_ARGUMENT：set_files 需要会话工作区上下文（当前调用未携带 chatId，仅聊天内可用）',
      );
    const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
    const specs: Array<{ name: string; size: number; mime: string }> = [];
    const chunkLists: string[][] = [];
    let totalBytes = 0;
    for (const rawPath of p.paths!) {
      const path = rawPath.trim();
      let snapshot: { path: string; bytes: Uint8Array; size: number };
      try {
        snapshot = await readWorkspaceFileBytes(
          chatId,
          path,
          context?.signal,
          MAX_TOTAL_BYTES,
        );
      } catch (error) {
        // 工作区读取失败（路径非法/不存在/超限）：原样透出可分析的分类文本
        throw new Error('WORKSPACE_READ_FAILED：' + readableTextError(error));
      }
      totalBytes += snapshot.size;
      if (totalBytes > MAX_TOTAL_BYTES)
        throw new Error(
          `FILE_TOO_LARGE：set_files 单次传输合计上限 8MB（当前已 ${totalBytes} 字节）。更大的文件请让用户在页面手动上传。`,
        );
      const name = path.split('/').pop() || path;
      specs.push({ name, size: snapshot.size, mime: mimeOfWorkspaceFile(name) });
      chunkLists.push(base64ChunksOf(snapshot.bytes));
    }
    const token = crypto.randomUUID().replace(/-/g, '');
    try {
      for (let fileIndex = 0; fileIndex < chunkLists.length; fileIndex++) {
        for (const chunk of chunkLists[fileIndex]) {
          await check();
          await boundedText(
            executeScriptBounded({
              target: { tabId: tab.id, frameIds: [p.frameId!] },
              world: 'ISOLATED',
              func: setFileInputPayload,
              args: ['append', token, fileIndex, chunk, p.elementId || '', []],
            }, undefined, undefined, context),
            '传输文件字节',
          );
        }
      }
      await check();
      const results = await boundedText(
        executeScriptBounded({
          target: { tabId: tab.id, frameIds: [p.frameId!] },
          world: 'ISOLATED',
          func: setFileInputPayload,
          args: ['commit', token, 0, '', p.elementId!, specs],
        }, undefined, undefined, context),
        '装载文件',
      );
      const result = results[0]?.result as
        | { error?: string; files?: Array<{ name: string; size: number }>; message?: string; outcome?: string }
        | undefined;
      if (results.length !== 1 || !result)
        throw new Error(
          'INJECTION_NO_RESULT：目标 frame 未返回装载结果，无法确认是否执行；请观察页面上传回显后再决定。',
        );
      if (result.error) {
        // VERIFY_FAILED = 已赋值但页面回读不符：文件可能部分生效 → unknown
        if (result.error.startsWith('VERIFY_FAILED'))
          return {
            ...this.createErrorResponse(result.error),
            data: {
              outcome: 'unknown',
              errorKind: 'EXECUTION_UNCERTAIN',
              cause: { errorCode: 'VERIFY_FAILED', phase: 'verify' },
            },
          };
        throw new Error(result.error);
      }
      return this.createSuccessResponse(
        {
          ...result,
          outcome: result.outcome || 'files_set',
          focus: await this.focus(tab.id, undefined, context),
        },
        result.message ||
          '文件已装载并回读一致；业务接收情况请观察页面回显。',
      );
    } catch (error) {
      // 中途失败：清理页面侧暂存缓冲（commit 内部也有 finally 兜底）
      await executeScriptBounded({
        target: { tabId: tab.id, frameIds: [p.frameId!] },
        world: 'ISOLATED',
        func: setFileInputPayload,
        args: ['cleanup', token, 0, '', '', []],
      }, undefined, undefined, context).catch(() => undefined);
      throw error;
    }
  }
}
export const browserInteractTool = new BrowserInteractTool();
