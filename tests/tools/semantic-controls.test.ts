/** Isolated public DOM/AX tool regressions, independent of registry and page-exec work. */
const area = () => {
  const memory = new Map<string, unknown>();
  return {
    get: async (keys?: string | string[]) =>
      Object.fromEntries(
        (keys == null
          ? [...memory.keys()]
          : Array.isArray(keys)
            ? keys
            : [keys]
        )
          .filter((key) => memory.has(key))
          .map((key) => [key, structuredClone(memory.get(key))]),
      ),
    set: async (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values))
        memory.set(key, structuredClone(value));
    },
    remove: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) memory.delete(key);
    },
    clear: async () => memory.clear(),
  };
};
const event = { addListener: () => undefined, removeListener: () => undefined };
const stub = {
  runtime: {
    id: 'semantic-tests',
    getManifest: () => ({ manifest_version: 3 }),
    getPlatformInfo: async () => ({ os: 'win' }),
    sendMessage: async () => undefined,
    onMessage: event,
    onInstalled: event,
    onConnect: event,
  },
  storage: {
    local: area(),
    session: area(),
    managed: area(),
    onChanged: event,
  },
  tabs: {
    query: async () => [],
    get: async () => ({ id: 11, url: 'https://fixture.example/page' }),
    update: async () => ({}),
    onRemoved: event,
  },
  permissions: { contains: async () => true, request: async () => true },
  scripting: { executeScript: async () => [] },
  windows: { getAll: async () => [] },
};
Object.assign(globalThis, { chrome: stub, browser: stub });
let passed = 0;
const failures: string[] = [];
const check = (condition: boolean, label: string, detail?: unknown) => {
  if (condition) passed++;
  else failures.push(label + ': ' + JSON.stringify(detail));
};
const eq = (actual: unknown, expected: unknown, label: string) =>
  check(JSON.stringify(actual) === JSON.stringify(expected), label, {
    actual,
    expected,
  });
const { testElementInteraction } = await import('./element-interaction.test');
const { testTextAutomation } = await import('./text-automation.test');
await testElementInteraction(check, eq);
await testTextAutomation(check, eq);
console.log(`[semantic-controls] passed=${passed} failed=${failures.length}`);
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
}
export {};
