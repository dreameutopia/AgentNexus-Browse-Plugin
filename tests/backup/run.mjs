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
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const workDir = path.join(os.tmpdir(), 'agentnexus-backup');
mkdirSync(workDir, { recursive: true });
const outfile = path.join(workDir, 'backup.test.mjs');

try {
  await build({
    entryPoints: [path.join(here, 'backup.test.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    logLevel: 'warning',
    outfile,
    // import.meta.glob 是 Vite 构建期 API，原生 esbuild 不认识——统一改写为空对象
    //（依赖链中的 skill-store 顶层即调用它，静态引入后在加载期执行）
    banner: { js: 'import.meta.glob = () => ({});' },
    absWorkingDir: root,
  });
} catch (error) {
  console.error('[backup] esbuild 打包失败:', error instanceof Error ? error.message : error);
  process.exit(1);
}

const run = spawnSync(process.execPath, [outfile], {
  stdio: 'inherit',
  cwd: root,
});

process.exit(run.status ?? 1);
