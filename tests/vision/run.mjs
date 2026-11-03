import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = process.cwd();
const outfile = path.join(root, 'node_modules/.cache/vision-tests.mjs');
await build({ entryPoints: ['tests/vision/vision.test.ts'], outfile, bundle: true, platform: 'node', format: 'esm', target: 'es2022', external: ['jsdom'], absWorkingDir: root });
process.exit(spawnSync(process.execPath, [outfile], { stdio: 'inherit' }).status ?? 1);
