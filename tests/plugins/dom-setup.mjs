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
