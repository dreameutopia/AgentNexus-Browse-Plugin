// 打包工具审批弹窗文案分档预览入口（真实 approval-copy + utils/i18n/core 渲染链路）
// 产物落在 node_modules/.cache（仓库内缓存目录，天然被 git 忽略），不进版本库
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

// 仓库根 = 脚本所在目录（.preview/）的上一级
const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'node_modules', '.cache');
fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(root, '.preview/tool-approval-preview.ts')],
  outfile: path.join(outDir, 'tool-approval-preview.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  logLevel: 'info',
  plugins: [
    {
      // 与 wxt 的 tsconfig paths 同口径的 `@/` 别名（esbuild 未必读到 extends 后的 paths）
      name: 'alias-at',
      setup(api) {
        api.onResolve({ filter: /^@\// }, args => {
          const base = path.join(root, args.path.slice(2));
          for (const candidate of [base, `${base}.ts`, `${base}.vue`, path.join(base, 'index.ts')]) {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { path: candidate };
          }
          return { path: base };
        });
      },
    },
  ],
});
