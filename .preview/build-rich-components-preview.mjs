// 打包富组件预览入口（真实渲染器 → 浏览器可执行 bundle）
// 产物落在 node_modules/.cache（仓库内缓存目录，天然被 git 忽略），不进版本库
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'node_modules', '.cache');
fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(root, '.preview/rich-components-preview.ts')],
  outfile: path.join(outDir, 'rich-components-preview.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  loader: { '.css': 'empty' },
  logLevel: 'info',
  plugins: [
    {
      name: 'alias-at',
      setup(api) {
        // '@/' → 仓库根；补齐 ts / index.ts 扩展名解析
        api.onResolve({ filter: /^@\// }, args => {
          const base = path.join(root, args.path.slice(2));
          for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
              return { path: candidate };
            }
          }
          return { path: base };
        });
      },
    },
  ],
});
