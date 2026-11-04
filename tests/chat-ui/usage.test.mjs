import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, compileScript } from '@vue/compiler-sfc';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';

const file = path.resolve('entrypoints/sidepanel/components/modals/sections/UsageSection.vue');
const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file });
const script = compileScript(descriptor, { id: 'usage-cache-regression', inlineTemplate: true });
const output = path.resolve('node_modules/.cache/usage-cache-regression.mjs');
mkdirSync(path.dirname(output), { recursive: true });
await build({ stdin: { contents: script.content, loader: 'ts', resolveDir: path.dirname(file) }, outfile: output,
  bundle: true, platform: 'node', format: 'esm', external: ['vue'], plugins: [{ name: 'usage-test-ports', setup(api) {
    api.onResolve({ filter: /@\/utils\/i18n$|usage-metrics-engine$|driver-registry$/ }, args => ({ path: args.path, namespace: 'port' }));
    api.onLoad({ filter: /.*/, namespace: 'port' }, args => ({ contents: args.path.includes('usage-metrics-engine')
      ? 'export const aiUsageMetrics=globalThis.__usageMetrics;'
      : args.path.includes('driver-registry') ? 'export const driverRegistry={get:()=>undefined,tryGet:()=>undefined,list:()=>[]};'
      : 'import {ref} from "vue"; export const t=(key)=>key.split(".").at(-1); export const useLocale=()=>({locale:ref("en")});' }));
  } }] });
const dom = new JSDOM('<div id="app"></div>');
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node']) globalThis[key] = dom.window[key];
const { createApp, nextTick } = await import('vue');
const counters = { requests: 2, success: 2, failed: 0, aborted: 0, inputTokens: 200, outputTokens: 10, totalTokens: 210,
  cachedInputTokens: 100, cacheEligibleInputTokens: 200, cacheReportedRequests: 2, cacheObservedRequests: 2, cacheHitRequests: 1,
  continuationInputTokens: 100, continuationCachedTokens: 100, continuationCacheRequests: 1, reasoningTokens: 0 };
const rows = ['A', 'B'].map(channelId => ({ ...counters, channelId, modelId: channelId, channelLabel: `Channel ${channelId}`,
  model: `model-${channelId}`, provider: 'openai', agentId: 'vision', requestKind: 'chat', lastUsedAt: 1 }));
let snapshot = { schemaVersion: 2, startedAt: 1, updatedAt: 1, totals: { ...counters }, models: rows, scopes: rows,
  recentRequests: rows.map((e, i) => ({ ...e, at: i + 1, kind: 'chat', outcome: 'success', iteration: 2, runId: 'run', prefixChanged: false,
    usage: { inputTokens: 100, ...(i === 0 ? { cachedInputTokens: 0 } : {}) } })), recentErrors: [], hydrated: true };
let listener;
globalThis.__usageMetrics = { getSnapshot: () => snapshot, subscribe: fn => { listener = fn; fn(snapshot); return () => { listener = undefined; }; }, reset: () => {} };
const { default: component } = await import(pathToFileURL(output).href);
const errors = [];
const app = createApp(component);
app.config.errorHandler = error => errors.push(error);
try {
  app.mount('#app'); await nextTick();
  assert.deepEqual(errors, [], 'Actual usage template must mount without errors');
  assert.equal(document.querySelectorAll('select').length, 3);
  assert.equal(document.querySelectorAll('.usage-model-list')[1].children.length, 2);
  assert.match(document.body.textContent, /50(?:\.0)?%/, 'Model cache ratio is visible');
  const channel = document.querySelector('select'); channel.value = 'A'; channel.dispatchEvent(new dom.window.Event('change'));
  await nextTick();
  assert.equal(document.querySelectorAll('.usage-model-list')[1].children.length, 1, 'Channel filter scopes model statistics');
  assert.equal(document.querySelectorAll('.usage-model-list')[2].children.length, 1, 'Same channel filter scopes request details');
  assert.match(document.querySelectorAll('.usage-model-list')[2].textContent, /cachedTokens 0/, 'An explicit zero remains visible');
  channel.value = 'B'; channel.dispatchEvent(new dom.window.Event('change')); await nextTick();
  assert.match(document.querySelectorAll('.usage-model-list')[2].textContent, /cachedTokens —/, 'Unreported usage is not presented as a zero');
  assert.doesNotMatch(document.body.textContent, /NaN|Infinity/);
  snapshot = { ...snapshot, totals: { ...counters, requests: 0 }, models: [], scopes: [], recentRequests: [] };
  listener(snapshot); await nextTick(); assert.ok(document.querySelector('.usage-empty'));
  assert.deepEqual(errors, []);
  console.log('[chat-ui] Actual usage template: model cache ratios, channel filters, zero vs unknown and empty updates passed.');
} finally { app.unmount(); dom.window.close(); delete globalThis.__usageMetrics; }
