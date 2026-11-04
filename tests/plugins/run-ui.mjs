import { build } from 'esbuild';
import { parse, compileScript } from '@vue/compiler-sfc';
import { readFile, mkdir, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..',
  ),
  out = path.join(root, 'node_modules/.cache/agentnexus-plugins/ui.mjs');
await mkdir(path.dirname(out), { recursive: true });
await build({
  entryPoints: [path.join(root, 'tests/plugins/ui.test.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  alias: { '@': root },
  define: { __APP_VERSION__: '"0.0.1"' },
  logLevel: 'silent',
  plugins: [
    {
      name: 'vue-sfc',
      setup(build) {
        build.onLoad({ filter: /\.vue$/ }, async (args) => {
          const { descriptor } = parse(await readFile(args.path, 'utf8'), {
            filename: args.path,
          });
          const script = compileScript(descriptor, {
            id: 'plugins-ui-test',
            inlineTemplate: true,
          });
          return {
            contents: script.content,
            loader: 'ts',
            resolveDir: path.dirname(args.path),
          };
        });
      },
    },
  ],
});
const fixtureDir = path.join(
  root,
  'node_modules/.cache/agentnexus-plugins/ui-fixture',
);
const pluginDir = path.join(fixtureDir, 'plugin-example'),
  fixture = path.join(fixtureDir, 'plugin-example-1.0.0.anplugin');
try {
  await access(fixture);
} catch {
  await mkdir(fixtureDir, { recursive: true });
  for (const args of [
    ['init', pluginDir],
    [
      'pack',
      pluginDir,
      '--key',
      pluginDir + '.publisher-key.json',
      '--out',
      fixture,
    ],
  ]) {
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'scripts/plugin-cli.mjs'), ...args],
      { cwd: root, encoding: 'utf8' },
    );
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  }
}
const result = spawnSync(
  process.execPath,
  [
    '--import',
    pathToFileURL(path.join(root, 'tests/plugins/dom-setup.mjs')).href,
    out,
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PLUGIN_UI_FIXTURE: fixture },
  },
);
process.exit(result.status ?? 1);
