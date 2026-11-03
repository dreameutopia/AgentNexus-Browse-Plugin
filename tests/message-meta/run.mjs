/**
 * 消息元数据领域测试运行器
 *
 * 用法：node tests/message-meta/run.mjs
 *       npm run test:message-meta
 *
 * 流程：esbuild 把测试（TS）打包成单文件（含 `@` 别名解析）→ Node 执行。
 * 产物写到系统临时目录，不污染仓库（对齐 saved-page-markdown 的做法）。
 */

import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const workDir = path.join(os.tmpdir(), 'agentnexus-message-meta');
mkdirSync(workDir, { recursive: true });
const outfile = path.join(workDir, 'message-meta.test.mjs');

try {
  buildSync({
    entryPoints: [path.join(here, 'message-meta.test.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    // 被测模块经 `@/utils/i18n` 等别名引用项目根，与 wxt 的别名约定一致
    alias: { '@': root },
    outfile,
    logLevel: 'warning',
  });
} catch (error) {
  console.error('[message-meta] esbuild 打包失败:', error instanceof Error ? error.message : error);
  process.exit(1);
}

const run = spawnSync(process.execPath, [outfile], {
  stdio: 'inherit',
  cwd: root,
});

try {
  rmSync(workDir, { recursive: true, force: true });
} catch {
  /* 清理失败不影响测试结论 */
}

if (run.error) {
  console.error('[message-meta] 测试执行失败:', run.error.message);
  process.exit(1);
}
process.exit(run.status ?? 1);
