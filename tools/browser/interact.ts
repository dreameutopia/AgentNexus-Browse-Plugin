import { withGuiCancellation } from '../vision/gui-cancellation';
import { BaseBrowserTool } from '../base/browser-tool';
import type { ToolMetadata, ToolExecutionContext } from '../registry';
import type { OpenAITool } from '@/common/openai-types';
import { domActionPayload } from './dom-action-payload';
import { textTargetPayload, focusedTextPayload } from './text-target-payload';
import {
  boundedText,
  exclusiveText,
  textCommand,
  textTab,
} from './text-runtime';
import { resolveAX, invalidateAXPages } from './text-accessibility';
import { resolveKeys } from '../vision/key-definitions';
import { needsPrimaryModifier, resolveTextKeys } from './text-keys';
import { cdpSession } from './cdp-session';
import { CONFIRM_GUIDANCE, CONFIRM_PARAMETER_DESCRIPTION } from '../confirmation-policy';

interface Params {
  action: 'click' | 'fill' | 'focus' | 'keys' | 'type' | 'scroll';
  elementId?: string;
  frameId?: number;
  value?: string;
  keys?: string[];
  deltaX?: number;
  deltaY?: number;
  clear?: boolean;
  description?: string;
  confirm?: boolean;
}
const fields: Record<Params['action'], string[]> = {
  click: [],
  fill: ['value'],
  focus: [],
  keys: ['keys'],
  type: ['value', 'clear'],
  scroll: ['deltaX', 'deltaY'],
};

export class BrowserInteractTool extends BaseBrowserTool {
  name = 'browser_interact';
  metadata: ToolMetadata = {
    name: this.name,
    description: '纯文本节点交互：点击、填充、原生按键与输入、聚焦、容器滚动',
    category: 'browser',
    version: '6.0.0',
    requiresConfirm: true,
  };
  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: this.name,
      description:
        '操作 browser_observe 返回的引用。click/fill 是 DOM 操作；focus/keys/type 使用实际焦点与浏览器输入，不接受坐标。type 仅限已聚焦编辑器，不自动进入表格编辑模式。keys 是一个组合键，Enter/F2/Tab 可切换编辑状态；操作后使用返回的 focus 引用或重新观察。scroll 按 CSS 像素滚动指定容器；省略 elementId 时滚动指定 frame 的文档，仍必须提供从当前观察确定的 frameId，不能猜为0。DOM 引用必须提供 FrameId；AX 引用自带路由，只支持 focus/keys/type。本工具没有 hover，不可用 click 冒充悬停。description 必填。成功只表示派发或回读，需检查业务结果。错误 outcome=not_dispatched 表示交互未派发，按错误修正；unknown 表示可能部分生效，先核对现状，不重放发送/提交。' + CONFIRM_GUIDANCE,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: Object.keys(fields) },
          elementId: {
            type: 'string',
            description: '原样复制观察结果的 ElementId；只有文档 scroll 可省略',
          },
          frameId: {
            type: 'number',
            description: 'DOM 引用同一行的 FrameId；无 elementId 的文档 scroll 也必填，从当前观察确定；AX 引用省略',
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
        },
        required: ['action', 'description'],
      },
    },
  };

  async execute(input: Params, context?: ToolExecutionContext) {
    this.ensureBackgroundContext();
    let validated = false;
    let dispatched = false;
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
        'description',
        'confirm',
        ...fields[input.action],
      ]);
      if (Object.keys(input).some((k) => !allowed.has(k)))
        throw new Error('存在不属于该 action 的参数，请按 Schema 调用');
      if (typeof input.description !== 'string' || !input.description.trim())
        throw new Error('description 必须说明目标与意图');
      if (input.confirm !== undefined && typeof input.confirm !== 'boolean')
        throw new Error('confirm 必须为布尔值');
      if (
        ['fill', 'type'].includes(input.action) &&
        (typeof input.value !== 'string' || input.value.length > 20000)
      )
        throw new Error('value 必须是最多20000字符的字符串');
      if (input.clear !== undefined && typeof input.clear !== 'boolean')
        throw new Error('clear 必须为布尔值');
      if (input.action === 'scroll') {
        for (const delta of [input.deltaX ?? 0, input.deltaY ?? 0])
          if (!Number.isFinite(delta) || Math.abs(delta) > 10000)
            throw new Error('滚动量必须是绝对值不超过10000的有限数值');
        if (!(input.deltaX || input.deltaY))
          throw new Error('scroll 至少有一个非零滚动量');
      }
      const ax = typeof input.elementId === 'string' && input.elementId.startsWith('ax:');
      const match = typeof input.elementId === 'string' ? /^anx:(\d+):[a-f0-9-]+:\d+$/.exec(input.elementId) : null;
      if (!ax && (!Number.isSafeInteger(input.frameId) || input.frameId! < 0))
        throw new Error('DOM 操作必须提供观察结果的 FrameId（文档 scroll 也必填）');
      if (!ax && !(input.action === 'scroll' && input.elementId === undefined) && !match)
        throw new Error('INVALID_ELEMENT_ID：请原样使用观察结果引用');
      if (ax && input.frameId !== undefined) throw new Error('AX 引用自带路由，请省略 frameId');
      if (ax && !['focus', 'keys', 'type'].includes(input.action)) throw new Error('AX 引用仅支持 focus/keys/type；DOM 操作请重采 DOM 引用');
      let parsedKeys =
        input.action === 'keys'
          ? resolveTextKeys(
              input.keys,
              needsPrimaryModifier(input.keys) ? 'win' : undefined // syntax check only; resolve actual platform below
            )
          : [];
      if (
        input.action === 'keys' &&
        parsedKeys.filter((k) => !k.modifier).length !== 1
      )
        throw new Error('keys 必须且只能包含一个主键');
      validated = true;
      if (input.action === 'keys' && needsPrimaryModifier(input.keys))
        parsedKeys = resolveTextKeys(input.keys, (await boundedText(chrome.runtime.getPlatformInfo(), '读取平台按键映射')).os);
      const p = structuredClone(input);
      return await withGuiCancellation(
        context?.requestId,
        (signal) =>
          exclusiveText(async () => {
            if (signal?.aborted) throw new Error('CANCELLED：操作尚未开始');
            const tab = await textTab();
            if (match && Number(match[1]) !== tab.id)
              throw new Error('WRONG_TAB：切回来源标签页或重新观察');
            invalidateAXPages(tab.id);
            await this.focus(tab.id, true);
            const deadline = Date.now() + 20_000;
            const check = async () => {
              if (signal?.aborted)
                throw new Error('CANCELLED：输入已停止，先观察现状');
              if (Date.now() > deadline)
                throw new Error('TIMEOUT：操作超时，先观察现状');
              const current = await textTab();
              if (current.id !== tab.id || current.url !== tab.url)
                throw new Error('TARGET_CHANGED：标签页或页面变化，输入停止');
            };
            const dom = async (
              phase: Parameters<typeof textTargetPayload>[0]
            ) => {
              await check();
              if (phase === 'scroll' || phase === 'focus') dispatched = true;
              const results = await boundedText(
                chrome.scripting.executeScript({
                  target: { tabId: tab.id, frameIds: [p.frameId!] },
                  world: 'ISOLATED',
                  func: textTargetPayload,
                  args: [
                    phase,
                    p.elementId || '',
                    p.deltaX ?? 0,
                    p.deltaY ?? 0,
                  ],
                }),
                '核验节点'
              );
              const result = results[0]?.result;
              if (results.length !== 1 || !result || result.error)
                throw new Error(
                  result?.error ||
                    'INJECTION_NO_RESULT：目标 frame 未返回注入结果，无法确认是否执行；请先观察现状。重新采集元素不能修复注入故障。'
                );
              return result;
            };
            if (p.action === 'scroll')
              return this.createSuccessResponse(await dom('scroll'));
            if (p.action === 'click' || p.action === 'fill') {
              await check();
              dispatched = true;
              const results = await boundedText(
                chrome.scripting.executeScript({
                  target: { tabId: tab.id, frameIds: [p.frameId!] },
                  world: 'ISOLATED',
                  func: domActionPayload,
                  // Chrome injection args use JSON serialization; undefined is
                  // rejected even though structuredClone accepts it.
                  args: [p.action, p.elementId!, p.value ?? ''],
                }),
                'DOM 交互'
              );
              const result = results[0]?.result;
              if (results.length !== 1 || !result?.success || result.error)
                throw new Error(
                  result?.error ||
                    'INJECTION_NO_RESULT：目标 frame 未返回注入结果，无法确认是否执行；请先观察现状。重新采集元素不能修复注入故障。'
                );
              return this.createSuccessResponse(
                {
                  ...result,
                  focus: await this.focus(tab.id),
                  outcome:
                    p.action === 'fill' ? 'value_verified' : 'dispatched',
                },
                result.message
              );
            }
            const guard = async (editable = false) => {
              await check();
              if (ax) {
                const target = await resolveAX(p.elementId!);
                if (target.tabId !== tab.id) throw new Error('WRONG_TAB');
                const resolved = await textCommand(tab.id, 'DOM.resolveNode', {
                  backendNodeId: target.backendNodeId,
                  objectGroup: 'agentnexus-text',
                });
                const objectId = resolved.object?.objectId;
                if (!objectId)
                  throw new Error('STALE_ELEMENT：AX 目标不能解析');
                try {
                  const r = await textCommand(
                    tab.id,
                    'Runtime.callFunctionOn',
                    {
                      objectId,
                      functionDeclaration: `function(){return {focused:this.ownerDocument.hasFocus()&&this.getRootNode().activeElement===this,editable:!!(!this.matches('[readonly],[disabled],[aria-readonly="true"]')&&(this.isContentEditable||this.localName==='textarea'||(this.localName==='input'&&['text','search','email','password','url','tel','number'].includes(this.type))))};}`,
                      returnByValue: true,
                    }
                  );
                  if (
                    !r.result?.value?.focused ||
                    (editable && !r.result.value.editable)
                  )
                    throw new Error('FOCUS_CHANGED：AX 目标不是当前可编辑焦点');
                } finally {
                  await textCommand(tab.id, 'Runtime.releaseObject', {
                    objectId,
                  }).catch(() => undefined);
                }
              } else await dom(editable ? 'type' : 'verify');
            };
            if (ax) {
              const target = await resolveAX(p.elementId!);
              dispatched = true;
              await textCommand(tab.id, 'DOM.focus', {
                backendNodeId: target.backendNodeId,
              });
            } else await dom('focus');
            if (p.action === 'focus')
              return this.createSuccessResponse({
                outcome: 'focused',
                focus: await this.focus(tab.id),
              });
            await boundedText(cdpSession.attach(tab.id), '附加输入会话');
            const epoch = cdpSession.getEpoch(tab.id);
            const inputCommand = async (method: string, params: object) => {
              await guard(p.action === 'type');
              if (cdpSession.getEpoch(tab.id) !== epoch)
                throw new Error('STALE_SESSION：调试会话变化');
              try {
                await textCommand(tab.id, method, params);
              } catch (error) {
                await cdpSession.detach(tab.id);
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
                  });
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
                    });
                  } catch {
                    failed.push(k.key);
                  }
                }
                if (failedGesture || failed.length)
                  await cdpSession.detach(tab.id).catch(() => undefined);
              }
              if (failed.length)
                throw new Error(
                  'CLEANUP_FAILED：未确认释放按键，已请求脱离会话；请观察现状'
                );
              if (failedGesture) throw gestureError;
            };
            if (p.action === 'keys') await chord(parsedKeys);
            else {
              if (p.clear) {
                const platform = await chrome.runtime.getPlatformInfo();
                await chord(
                  resolveKeys([platform.os === 'mac' ? 'Meta' : 'Control', 'a'])
                );
                await chord(resolveKeys(['Backspace']));
              }
              await inputCommand('Input.insertText', { text: p.value! });
            }
            return this.createSuccessResponse({
              outcome: 'dispatched',
              focus: await this.focus(tab.id),
              hint: '检查当前选区/编辑器和保存反馈；按键可能改变焦点，下一步使用新 focus 引用。',
            });
          }),
        context?.signal
      );
    } catch (error) {
      const result = this.createErrorResponse(
        dispatched ? '纯文本交互失败；结果可能部分生效，请先观察现状，不自动重试'
          : validated ? '交互未派发；请按错误处理前置条件后再操作'
            : 'INVALID_ARGUMENT：交互未派发；修正参数后重试，无需仅因参数错误重新观察', error);
      return { ...result, data: { outcome: dispatched ? 'unknown' : 'not_dispatched', errorKind: !validated ? 'INVALID_ARGUMENT' : dispatched ? 'EXECUTION_UNCERTAIN' : 'PRECONDITION_FAILED' } };
    }
  }
  private async focus(tabId: number, invalidate = false) {
    const results = await boundedText(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'ISOLATED',
        func: focusedTextPayload,
        args: [invalidate],
      }),
      '读取当前焦点'
    );
    return results
      .filter((r) => r.result)
      .map((r) => ({ ...r.result, frameId: r.frameId }));
  }
}
export const browserInteractTool = new BrowserInteractTool();
