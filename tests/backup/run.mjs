/**
 * 备份与存储统计引擎测试运行器
 *
 * 用法：node tests/backup/run.mjs
 *       npm run test:backup
 *
 * 流程：esbuild 把引擎测试（TS）打包成单文件 → Node 执行。
 * 产物写到系统临时目录，不污染仓库。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const isWin = process.platform === 'win32';

const esbuildBin = path.join(
  root,
  'node_modules',
  '.bin',
  isWin ? 'esbuild.cmd' : 'esbuild'
);

if (!existsSync(esbuildBin)) {
  console.error(`[backup] 未找到 esbuild: ${esbuildBin}`);
  console.error('[backup] 请先安装依赖（npm install / pnpm install）后重试');
  process.exit(1);
}

const workDir = path.join(os.tmpdir(), 'agentnexus-backup');
mkdirSync(workDir, { recursive: true });
const outfile = path.join(workDir, 'backup.test.mjs');

const build = spawnSync(
  esbuildBin,
  [
    path.join(here, 'backup.test.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=es2022',
    '--log-level=warning',
    `--outfile=${outfile}`,
  ],
  { stdio: 'inherit', cwd: root, shell: isWin }
);

if (build.error) {
  console.error('[backup] esbuild 调用失败:', build.error.message);
  process.exit(1);
}
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const run = spawnSync(process.execPath, [outfile], {
  stdio: 'inherit',
  cwd: root,
});

process.exit(run.status ?? 1);
