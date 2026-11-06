import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const outfile = path.resolve('node_modules/.cache/semantic-controls.test.mjs');
await build({
  entryPoints: ['tests/tools/semantic-controls.test.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  external: ['jsdom'],
  loader: { '.css': 'empty' },
});
const result = spawnSync(process.execPath, [outfile], {
  stdio: 'inherit',
  cwd: process.cwd(),
});
process.exit(result.status ?? 1);
