/**
 * 文档工具 DOM 环境测试（独立进程）
 *
 * 与其它工具测试分开跑的原因：它会挂载 JSDOM 覆盖全局（document/window/
 * navigator 等），放进同一个进程会污染后续用例。
 *
 * 用法：node tests/tools/run-document-dom.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

// 产物必须落在仓库内：测试依赖 jsdom，运行时按 Node 解析规则找 node_modules
const workDir = path.join(root, 'node_modules', '.cache', 'agentnexus-document-dom');
mkdirSync(workDir, { recursive: true });
const outfile = path.join(workDir, 'document-dom.test.mjs');

try {
  await esbuild.build({
    entryPoints: [path.join(here, 'document-dom.test.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    logLevel: 'warning',
    outfile,
    // 测试在 Node 中运行，样式与字体资源没有运行时意义
    loader: {
      '.css': 'empty',
      '.woff': 'empty',
      '.woff2': 'empty',
      '.ttf': 'empty',
      '.otf': 'empty',
      '.eot': 'empty',
    },
    // jsdom 含原生 require 动态引用，打包会破坏——保持外部依赖由 Node 运行时解析
    external: ['jsdom'],
    absWorkingDir: root,
  });
} catch (error) {
  console.error('[document-dom] esbuild 打包失败:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const run = spawnSync(process.execPath, [outfile], {
  stdio: 'inherit',
  cwd: root,
});

process.exit(run.status ?? 1);
