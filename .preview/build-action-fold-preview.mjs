// 打包消息操作栏收起 / 展开预览入口（.vue SFC 经 compiler-sfc 编译 + 真实渲染器全链路）
// 产物落在 node_modules/.cache（仓库内缓存目录，天然被 git 忽略），不进版本库
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { parse, compileScript } from '@vue/compiler-sfc';

const root = process.cwd();
const outDir = path.join(root, 'node_modules', '.cache');
fs.mkdirSync(outDir, { recursive: true });

// 预览环境无 chrome.runtime / IndexedDB：核心图片库替换为固定占位实现
const CORE_STUB = `
export const imageStore = { getObjectUrl: async () => '' };
export const SHORT_ID_PATTERN = /^sha-[a-z0-9]+$/;
export const isImageRef = () => false;
export const normalizeImageRefs = refs => refs ?? [];
`;

await build({
  entryPoints: [path.join(root, '.preview/action-fold-preview.ts')],
  outfile: path.join(outDir, 'action-fold-preview.js'),
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
          const script = compileScript(descriptor, { id: 'action-fold-preview', inlineTemplate: true });
          return { contents: script.content, loader: 'ts', resolveDir: path.dirname(args.path) };
        });
      },
    },
    {
      name: 'stub-sidepanel-core',
      setup(api) {
        // '../../core'（core 目录索引）与 '../../core/images/image-store'
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
