import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { JSDOM } from 'jsdom';
const dom = new JSDOM(
  '<!doctype html><html><body><div id="app"></div></body></html>',
  { url: 'https://extension.test/hub.html' },
);
for (const key of [
  'window',
  'document',
  'Element',
  'SVGElement',
  'Node',
  'Event',
  'localStorage',
])
  globalThis[key] = dom.window[key];

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;
window.indexedDB = indexedDB;
// JSDOM 无 requestAnimationFrame；提示条 <transition> 卸载时 Vue 会调用。
// 对齐 tests/chat-ui 的做法：用 setTimeout(0) 驱动过渡帧回调。
globalThis.requestAnimationFrame = window.requestAnimationFrame =
  (fn) => setTimeout(fn, 0);
