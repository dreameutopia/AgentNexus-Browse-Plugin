// 打包欢迎语 Python 安装引导标签预览入口
// （.vue SFC 经 compiler-sfc 编译 + 真实 pyodide-env 订阅链路）
// 产物落在 node_modules/.cache（仓库内缓存目录，天然被 git 忽略），不进版本库
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { parse, compileScript } from '@vue/compiler-sfc';

const root = process.cwd();
const outDir = path.join(root, 'node_modules', '.cache');
fs.mkdirSync(outDir, { recursive: true });

// 样式：取 SFC <style> 原文单独落盘（预览不打 scopeId——选择器本身唯一，
// 生产构建由 Vite 负责 scoped 变换）
const sfcFile = path.join(root, 'entrypoints/sidepanel/components/greeting/GreetingPythonTag.vue');
const { descriptor } = parse(fs.readFileSync(sfcFile, 'utf8'), { filename: sfcFile });
fs.writeFileSync(
  path.join(outDir, 'greeting-python-tag.css'),
  descriptor.styles.map(style => style.content).join('\n'),
);

await build({
  entryPoints: [path.join(root, '.preview/greeting-python-tag.ts')],
  outfile: path.join(outDir, 'greeting-python-tag.js'),
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
          const { descriptor: desc } = parse(fs.readFileSync(args.path, 'utf8'), { filename: args.path });
          const script = compileScript(desc, { id: 'greeting-python-tag-preview', inlineTemplate: true });
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
