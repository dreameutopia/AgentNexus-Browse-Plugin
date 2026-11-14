import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..',
  ),
  out = path.join(root, 'node_modules/.cache/agentnexus-plugins/tests.mjs');
mkdirSync(path.dirname(out), { recursive: true });
await build({
  entryPoints: [path.join(root, 'tests/plugins/plugins.test.ts')],
  outfile: out,
  bundle: true,
  banner: { js: 'import.meta.glob = () => ({});' },
  platform: 'node',
  format: 'esm',
  packages: 'external',
  alias: { '@': root },
  define: { __APP_VERSION__: '"0.0.1"' },
  logLevel: 'silent',
});
const result = spawnSync(process.execPath, [out], { stdio: 'inherit' });
process.exit(result.status ?? 1);
