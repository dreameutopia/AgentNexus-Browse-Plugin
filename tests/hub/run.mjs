/**
 * 管理中心（hub）测试运行器
 *
 * 用法：node tests/hub/run.mjs
 *       npm run test:hub
 *
 * 覆盖：
 *   - 技能编辑器（高级模式）：标题栏模式切换、VS Code 式文件树结构、新建文件 /
 *     新建文件夹、右键菜单、拖拽（文件与目录）、校验默认收起（{n} 个问题 + 向上
 *     悬浮卡片）、填满态布局，以及「行内无左侧色条、配色不含蓝紫」的样式契约；
 *   - 智能体编辑器：填满态两卡布局、头部按钮位、卡片上下布局、查看按钮与详情
 *     悬浮窗、三区可折叠、搜索框占满宽度、emoji 悬浮卡片；
 *   - 智能体启停：默认启用、预置 / 自定义可停用、@ 选择器过滤、跨上下文同步；
 *   - 使用监控 + Python 环境（由设置弹窗迁入）：左导航独立入口、指标 / 运行时 /
 *     包管理 / 测试运行台渲染、筛选与排序、实时同步推送刷新、危险操作行内二次
 *     确认，以及「不得出现原生 <select>、配色不含蓝紫」的样式契约。
 *
 * 流程：纯逻辑用例（TS）经 esbuild 打包执行（产物写 node_modules/.cache）；
 * 组件用例（.mjs）自行打包并挂载真实组件。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

// 仓库内缓存目录（external 依赖需从仓库内解析 node_modules）
const workDir = path.join(root, 'node_modules', '.cache', 'agentnexus-hub');
mkdirSync(workDir, { recursive: true });
const outfile = path.join(workDir, 'agent-enable.test.mjs');

/** import.meta.glob 是 Vite 构建期 API，原生 esbuild 不认识——统一改写为返回空对象 */
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
    entryPoints: [path.join(here, 'agent-enable.test.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    outfile,
    logLevel: 'warning',
    loader: { '.css': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty', '.otf': 'empty', '.eot': 'empty' },
    plugins: [importMetaGlobShim],
    absWorkingDir: root,
  });
} catch (error) {
  console.error('[hub] esbuild 打包失败:', error instanceof Error ? error.message : error);
  process.exit(1);
}

const agentEnable = spawnSync(process.execPath, [outfile], { stdio: 'inherit', cwd: root });
if (agentEnable.status !== 0) process.exit(agentEnable.status ?? 1);

const skillEditor = spawnSync(process.execPath, [path.join(here, 'skill-editor.test.mjs')], {
  stdio: 'inherit',
  cwd: root,
});
if (skillEditor.status !== 0) process.exit(skillEditor.status ?? 1);

const agentEditor = spawnSync(process.execPath, [path.join(here, 'agent-editor.test.mjs')], {
  stdio: 'inherit',
  cwd: root,
});
if (agentEditor.status !== 0) process.exit(agentEditor.status ?? 1);

const usagePython = spawnSync(process.execPath, [path.join(here, 'usage-python.test.mjs')], {
  stdio: 'inherit',
  cwd: root,
});
if (usagePython.status !== 0) process.exit(usagePython.status ?? 1);

const sessionsSection = spawnSync(process.execPath, [path.join(here, 'sessions-section.test.mjs')], {
  stdio: 'inherit',
  cwd: root,
});
process.exit(sessionsSection.status ?? 1);
