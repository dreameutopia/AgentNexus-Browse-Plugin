/**
 * jsdom 无自带 TypeScript 类型（也未安装 @types/jsdom）；
 * 测试仅用到 JSDOM 构造与 window 对象，这里做最小声明以通过类型检查。
 */
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: { pretendToBeVisual?: boolean; url?: string; runScripts?: 'outside-only' | 'dangerously' });
    readonly window: Window & typeof globalThis;
  }
}
