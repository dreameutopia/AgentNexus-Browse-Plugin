// 打包流式预览入口（.vue SFC 经 compiler-sfc 编译 + 真实渲染器全链路）
// 产物落在 node_modules/.cache（仓库内缓存目录，天然被 git 忽略），不进版本库
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { parse, compileScript } from '@vue/compiler-sfc';

const root = process.cwd();
const outDir = path.join(root, 'node_modules', '.cache');
fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(root, '.preview/streaming-preview.ts')],
  outfile: path.join(outDir, 'streaming-preview.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  loader: { '.css': 'empty' },
  logLevel: 'info',
  plugins: [
    {
      name: 'vue-sfc',
      setup(api) {
        api.onResolve({ filter: /\.vue$/ }, args => ({ path: path.resolve(args.resolveDir, args.path), namespace: 'vue-sfc' }));
        api.onLoad({ filter: /.*/, namespace: 'vue-sfc' }, args => {
          const { descriptor } = parse(fs.readFileSync(args.path, 'utf8'), { filename: args.path });
          const script = compileScript(descriptor, { id: 'streaming-preview', inlineTemplate: true });
          return { contents: script.content, loader: 'ts', resolveDir: path.dirname(args.path) };
        });
      },
    },
    {
      name: 'alias-at',
      setup(api) {
        api.onResolve({ filter: /^@\// }, args => {
          const base = path.join(root, args.path.slice(2));
          for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { path: candidate };
          }
          return { path: base };
        });
      },
    },
  ],
});
