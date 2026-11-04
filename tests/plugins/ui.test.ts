import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp, h, ref, nextTick } from 'vue';
import PluginManager from '../../entrypoints/hub/plugins/PluginManager.vue';
import ExternalToolsPicker from '../../entrypoints/hub/agents/ExternalToolsPicker.vue';
import { initPluginHost } from '../../entrypoints/background/plugins/host';
import { getPluginSnapshot } from '../../utils/plugins/catalog';
import { pluginRequest } from '../../utils/plugins/client';

const listeners: any[] = [],
  storage = new Map<string, unknown>();
(globalThis as any).chrome = {
  runtime: {
    id: 'test',
    getURL: (path: string) => `chrome-extension://test${path}`,
    onMessage: { addListener: (listener: any) => listeners.push(listener) },
    sendMessage: (message: any) =>
      new Promise((resolve) => {
        let pending = false,
          settled = false;
        const reply = (value: any) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        for (const listener of [...listeners])
          if (
            listener(
              message,
              { id: 'test', url: 'chrome-extension://test/hub.html' },
              reply,
            ) === true
          )
            pending = true;
        if (!pending && !settled) resolve(undefined);
      }),
  },
  storage: {
    local: {
      get: async (key: string) => ({ [key]: storage.get(key) }),
      set: async (values: any) => {
        for (const [k, v] of Object.entries(values)) storage.set(k, v);
      },
      remove: async () => {},
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
};
await initPluginHost();
const mount = document.getElementById('app')!;
const app = createApp(PluginManager);
app.mount(mount);
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    await nextTick();
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    'UI condition timed out: ' + mount.textContent?.slice(0, 1500),
  );
}
await until(() => !!mount.querySelector('input[type=file]'));
const bytes = await readFile(process.env.PLUGIN_UI_FIXTURE!);
const file = mount.querySelector<HTMLInputElement>('input[type=file]')!;
await until(() => !file.disabled);
Object.defineProperty(file, 'files', {
  value: [
    {
      size: bytes.length,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    },
  ],
  configurable: true,
});
file.dispatchEvent(new Event('change', { bubbles: true }));
await until(() => !!mount.querySelector('.review'));
const install = mount.querySelector<HTMLButtonElement>('.review button')!;
assert.equal(install.disabled, true);
const consent = mount.querySelector<HTMLInputElement>(
  '.review input[type=checkbox]',
)!;
consent.checked = true;
consent.dispatchEvent(new Event('change', { bubbles: true }));
await until(() => !install.disabled);
install.click();
await until(
  () =>
    getPluginSnapshot().packages.length === 1 &&
    !mount.querySelector('.review'),
);
assert(mount.textContent?.includes('1.0.0'));
assert(mount.textContent?.includes('Your studio'));
const plugin = getPluginSnapshot().packages[0];
app.unmount();
const selected = ref<string[]>([]),
  pickerApp = createApp({
    setup: () => () =>
      h(ExternalToolsPicker, {
        modelValue: selected.value,
        count: selected.value.length,
        max: 30,
        'onUpdate:modelValue': (value) => {
          selected.value = value;
        },
      }),
  });
pickerApp.mount(mount);
const checkbox = mount.querySelector<HTMLInputElement>(
  'label input[type=checkbox]',
)!;
assert(checkbox && !checkbox.disabled);
checkbox.checked = true;
checkbox.dispatchEvent(new Event('change', { bubbles: true }));
await nextTick();
assert.equal(selected.value[0], plugin.tools[0].ref);
await pluginRequest('enable', {
  key: plugin.key,
  enabled: false,
  generation: getPluginSnapshot().generation,
});
await until(
  () =>
    !!mount.textContent?.includes('已禁用') ||
    !!mount.textContent?.includes('Disabled'),
);
assert.equal(selected.value[0], plugin.tools[0].ref); // Disable must never silently delete the user's selection.
await pluginRequest('uninstall', {
  key: plugin.key,
  generation: getPluginSnapshot().generation,
});
await until(() => !!mount.querySelector('.missing'));
assert.equal(selected.value[0], plugin.tools[0].ref);
pickerApp.unmount();
console.log(
  '[plugins-ui] File import, explicit consent, source/version display, external-tool selection, disable and missing-reference preservation passed.',
);
