/**
 * 可信按键派发（单一实现，被 browser_input 与 browser_interact 共用）。
 *
 * 为什么要抽出来：按键派发包含一整套不能漂移的细节——
 *   修饰键按下顺序与反序释放（press/release 必须配对，否则页面留下「按键一直按着」，
 *   拖拽选择、拖动排序全被带偏）；
 *   焦点核验（元素级按键前必须确认目标就是当前可编辑焦点，否则键打进了别处）；
 *   调试会话世代校验（会话中途被替换时必须停手，不能把按键发到未知上下文）；
 *   按下失败时的成对释放与失败键清单。
 * 两处各写一份必然漂移，漂移后的表现是「按键偶尔不生效」这类无法定位的问题。
 *
 * 本模块只做**派发**，不负责选目标（DOM 引用 / AX 引用 / 文档级由调用方决定），
 * 也不负责业务语义——那属于工具层。
 */

import type { ToolExecutionContext } from '../registry';
import { textCommand } from './text-runtime';
import { resolveKeys } from '../vision/key-definitions';

/** 派发结果。 */
export interface KeyDispatchResult {
  /** 实际按下的键（派发成功即视为已送达 CDP） */
  pressed: string[];
  /** 释放失败的键（未确认释放） */
  released: string[];
}

/**
 * 派发一个组合键（可信键事件，isTrusted=true）。
 *
 * 事件序列与真实键盘一致：修饰键依次 keyDown → 主键 keyDown → 主键 keyUp →
 * 修饰键反序 keyUp。CDP 注入的事件在页面侧 isTrusted=true，React/Vue 受控
 * 组件与 canvas 应用（飞书表格等）因此会像真实用户按键一样响应——这是把整批
 * 数据写进表格的正路（页面合成事件会被这些应用按 isTrusted 拒绝）。
 *
 * @param beforeEach 每个键按下前的守卫（用于焦点核验与会话世代校验）；
 *                    抛错即中止派发，已按下的键会在 finally 中被释放。
 */
export async function dispatchKeyChord(
  tabId: number,
  keys: ReturnType<typeof resolveKeys>,
  options: {
    /** 每个键按下前的守卫 */
    beforeEach?: () => Promise<void>;
    /** 每个键**成功按下后**的回调（调用方据此标记"输入已送出"，
     *  用于区分「焦点动了但没打字」与「打了一半」）。 */
    onKeyDown?: () => void | Promise<void>;
    /** 结果不确定时的回调（脱离调试会话等）：按下失败或释放未确认时，
     *  会话状态已不可知——必须断开，否则后续命令可能打在未知的按键状态上。 */
    onUncertain?: () => void | Promise<void>;
    context?: ToolExecutionContext;
  } = {},
): Promise<KeyDispatchResult> {
  const held: typeof keys = [];
  let modifiers = 0;
  const failed: string[] = [];
  const pressed: string[] = [];
  let gestureError: unknown;
  let gestureFailed = false;
  try {
    for (const key of keys) {
      await options.beforeEach?.();
      modifiers |= key.modifier;
      /**
       * 文本负载：只有「无修饰键的可见字符」才随 keyDown 携带 text，
       * 否则浏览器会把它当成组合键的一部分而重复插入。Enter 携带 \r
       * 让表单/单元格编辑器提交。
       */
      const text =
        !key.modifier && !(modifiers & ~8)
          ? key.key.length === 1
            ? modifiers & 8
              ? key.shifted || key.key
              : key.key
            : key.key === 'Enter'
              ? '\r'
              : undefined
          : undefined;
      const dispatchedKey =
        key.key.length === 1 && modifiers & 8 ? key.shifted || key.key : key.key;
      held.push({ ...key, key: dispatchedKey });
      await textCommand(
        tabId,
        'Input.dispatchKeyEvent',
        {
          type: 'keyDown',
          key: dispatchedKey,
          code: key.code,
          windowsVirtualKeyCode: key.windowsVirtualKeyCode,
          modifiers,
          ...(text !== undefined ? { text, unmodifiedText: text } : {}),
        },
        undefined,
        options.context,
      );
      pressed.push(dispatchedKey);
      await options.onKeyDown?.();
    }
  } catch (error) {
    gestureFailed = true;
    gestureError = error;
  } finally {
    // 反序释放：主键先松，修饰键后松
    for (const key of held.reverse()) {
      modifiers &= ~key.modifier;
      try {
        await textCommand(
          tabId,
          'Input.dispatchKeyEvent',
          {
            type: 'keyUp',
            key: key.key,
            code: key.code,
            windowsVirtualKeyCode: key.windowsVirtualKeyCode,
            modifiers,
          },
          undefined,
          options.context,
        );
      } catch {
        failed.push(key.key);
      }
    }
  }
  if (failed.length || gestureFailed) {
    /**
     * 结果不确定 → 交由调用方脱离调试会话。
     *
     * 两种不确定都必须断开：释放失败意味着修饰键可能仍处于按下状态
     * （页面会以为用户一直按着 Ctrl），按下失败则可能只送出了半个手势。
     * 两种情况下继续复用同一会话，后续按键会叠加在未知状态上。
     */
    await options.onUncertain?.();
  }
  if (failed.length) {
    throw new Error(
      'CLEANUP_FAILED：未确认释放按键（' +
        failed.join('/') +
        '），已请求脱离会话；请观察现状',
    );
  }
  if (gestureFailed) throw gestureError;
  return { pressed, released: failed };
}
