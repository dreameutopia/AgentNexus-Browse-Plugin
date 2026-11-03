/**
 * 工具领域测试运行器
 *
 * 用法：node tests/tools/run.mjs
 *       npm run test:tools
 *
 * 覆盖：工具注册契约（元数据/Schema 一致性、无重复注册）、场景预设与注册表
 * 对齐、测试面板目录与注册表对齐、TOOL_REGISTRATION_STATUS.md 文档防漂移、
 * 数据暂存区（data-ref store）行为、可交互元素获取工具宿主流程
 *（分页/缓存/过滤提示/参数与受限页防御）、注入荷载真实行为
 *（序列化自包含 + jsdom DOM 的采集/过滤/遮挡/点击填充断言）。
 *
 * 流程：esbuild 把工具领域测试（TS）打包成单文件 → Node 执行。
 * 产物写入 node_modules/.cache（可随时清理、天然被 git 忽略）——
 * 必须放在仓库内：测试将 jsdom 等依赖标记为 external，由 Node 在运行时按
 * 包解析规则加载，产物若落在系统临时目录将找不到 node_modules。
 *
 * 相对其它套件的两点特殊处理：
 *   1. 样式/字体资源：测试在 Node 中运行，按空模块加载（katex CSS 经依赖链进入包）；
 *   2. import.meta.glob 是 Vite 构建期 API，原生 esbuild 不认识——打包时统一改写为
 *      返回空对象的本地函数（被测模块仅在「枚举预置技能文件」处使用它，测试不涉及）。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

// 仓库内缓存目录（见文件头注释：external 依赖需要从仓库内解析 node_modules）
const workDir = path.join(root, 'node_modules', '.cache', 'agentnexus-tools');
mkdirSync(workDir, { recursive: true });
const outfile = path.join(workDir, 'tools.test.mjs');

/** 把 Vite 专属的 import.meta.glob(...) 改写为返回 {} 的本地函数（仅当文件中出现时才改写） */
const importMetaGlobShim = {
  name: 'import-meta-glob-shim',
  setup(buildApi) {
    buildApi.onLoad({ filter: /\.(ts|mts|cts|js|mjs)$/ }, async (args) => {
      if (args.path.includes(`${path.sep}node_modules${path.sep}`)) return undefined;
      const source = await readFileSync(args.path, 'utf8');
      if (!source.includes('import.meta.glob')) return undefined;
      const shimmed =
        'const __importMetaGlobShim = () => ({});\n' +
        source.replace(/import\.meta\.glob/g, '__importMetaGlobShim');
      return { contents: shimmed, loader: 'ts' };
    });
  },
};

try {
  await esbuild.build({
    entryPoints: [path.join(here, 'tools.test.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    logLevel: 'warning',
    outfile,
    // 测试在 Node 中运行，样式与字体资源没有运行时意义：
    // 样式置空（内容不再被解析，字体引用随之消失），字体文件按空模块处理
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
    plugins: [importMetaGlobShim],
    absWorkingDir: root,
  });
} catch (error) {
  console.error('[tools] esbuild 打包失败:', error instanceof Error ? error.message : error);
  process.exit(1);
}

const run = spawnSync(process.execPath, [outfile], {
  stdio: 'inherit',
  cwd: root,
});

process.exit(run.status ?? 1);
