// 打包用户消息气泡预览入口（.vue SFC 经 compiler-sfc 编译 + 真实 Markdown 渲染链路）
// 产物落在 node_modules/.cache（仓库内缓存目录，天然被 git 忽略），不进版本库
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { parse, compileScript } from '@vue/compiler-sfc';

// 仓库根 = 脚本所在目录（.preview/）的上一级
const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'node_modules', '.cache');
fs.mkdirSync(outDir, { recursive: true });

// 预览环境无 chrome.runtime / IndexedDB：核心图片库替换为固定占位图
const PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="180">' +
  '<rect width="100%" height="100%" fill="#e2e8f0"/>' +
  '<rect x="16" y="16" width="200" height="14" rx="4" fill="#cbd5e1"/>' +
  '<text x="50%" y="92%" font-size="13" fill="#94a3b8" text-anchor="middle" font-family="sans-serif">图片占位</text></svg>';
const CORE_STUB = `
export const imageStore = { getObjectUrl: async () => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(PLACEHOLDER_SVG)}) };
export const SHORT_ID_PATTERN = /^sha-[a-z0-9]+$/;
export const isImageRef = () => false;
export const normalizeImageRefs = refs => refs ?? [];
`;

await build({
  entryPoints: [path.join(root, '.preview/user-bubble-preview.ts')],
  outfile: path.join(outDir, 'user-bubble-preview.js'),
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
          const script = compileScript(descriptor, { id: 'user-bubble-preview', inlineTemplate: true });
          return { contents: script.content, loader: 'ts', resolveDir: path.dirname(args.path) };
        });
      },
    },
    {
      name: 'stub-sidepanel-core',
      setup(api) {
        api.onResolve({ filter: /^(\.\.\/)+core(\/images\/image-store)?$/ }, () => ({ path: 'core-stub', namespace: 'core-stub' }));
        api.onLoad({ filter: /.*/, namespace: 'core-stub' }, () => ({ contents: CORE_STUB, loader: 'ts' }));
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
