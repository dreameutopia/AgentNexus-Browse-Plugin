/**
 * 技能领域测试运行器
 *
 * 用法：node tests/skills/run.mjs
 *       npm run test:skills
 *
 * 覆盖：内置技能 id 保留区间与两类 id 生成器（确定性 / 随机 + 并发保护）、
 * 同名技能全链路（写入 / 查询 / 解析 / 导入不重命名）、合成 load_skill 激活轮
 * 的消息形态与真实工具回传同源、指令装配（优先级约定 / 资源清单 / 环境说明 /
 * 超长截断）、发现清单排除已激活项。
 *
 * 流程：esbuild 把技能领域测试（TS）打包成单文件 → Node 执行。
 * 产物写入 node_modules/.cache（可随时清理、天然被 git 忽略）——
 * 必须放在仓库内：产物若落在系统临时目录将找不到 node_modules。
 *
 * import.meta.glob 是 Vite 构建期 API，原生 esbuild 不认识——打包时统一改写为
 * 返回数据的本地函数：应用代码里只有 skill-store 用到它（枚举预置技能），
 * 因此这里把仓库内 skills/ 目录的真实文件按同一键格式（/skills/<目录>/<相对路径>）
 * 读出来注入，让「预置装配 / 保留区间 id / 与自定义同名共存 / 硬编码引用命中」
 * 这些真实链路可被断言（见 skills.test.ts 第 6、7 节）。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

// 仓库内缓存目录（见文件头注释：产物需要从仓库内解析 node_modules）
const workDir = path.join(root, 'node_modules', '.cache', 'agentnexus-skills');
mkdirSync(workDir, { recursive: true });
const outfile = path.join(workDir, 'skills.test.mjs');

/**
 * 按 Vite glob 的键格式读取仓库内 skills/ 的全部 .md 文件。
 * 目录不存在时返回空表——此时依赖内置技能的断言会带着明确信息失败，
 * 而不是被一个「合成替身」悄悄掩盖真实装配问题。
 */
function readPresetGlobFromDisk() {
  const skillsRoot = path.join(root, 'skills');
  const glob = {};
  const walk = (dir, relDir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry);
      const rel = relDir ? `${relDir}/${entry}` : entry;
      if (statSync(abs).isDirectory()) {
        walk(abs, rel);
      } else if (entry.endsWith('.md')) {
        glob[`/skills/${rel}`] = readFileSync(abs, 'utf8');
      }
    }
  };
  walk(skillsRoot, '');
  return glob;
}

const presetGlob = readPresetGlobFromDisk();

/** 把 Vite 专属的 import.meta.glob(...) 改写为返回真实预置数据的本地函数（仅当文件中出现时才改写） */
const importMetaGlobShim = {
  name: 'import-meta-glob-shim',
  setup(buildApi) {
    buildApi.onLoad({ filter: /\.(ts|mts|cts|js|mjs)$/ }, async (args) => {
      if (args.path.includes(`${path.sep}node_modules${path.sep}`)) return undefined;
      const source = await readFileSync(args.path, 'utf8');
      if (!source.includes('import.meta.glob')) return undefined;
      const shimmed =
        `const __importMetaGlobShim = () => (${JSON.stringify(presetGlob)});\n` +
        source.replace(/import\.meta\.glob/g, '__importMetaGlobShim');
      return { contents: shimmed, loader: 'ts' };
    });
  },
};

try {
  await esbuild.build({
    entryPoints: [path.join(here, 'skills.test.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    logLevel: 'warning',
    outfile,
    // 被测链路不含样式/字体；显式声明以防未来引入时静默失败
    loader: {
      '.css': 'empty',
      '.woff': 'empty',
      '.woff2': 'empty',
      '.ttf': 'empty',
      '.otf': 'empty',
      '.eot': 'empty',
    },
    plugins: [importMetaGlobShim],
    absWorkingDir: root,
  });
} catch (error) {
  console.error('[skills] esbuild 打包失败:', error instanceof Error ? error.message : error);
  process.exit(1);
}

const run = spawnSync(process.execPath, [outfile], {
  stdio: 'inherit',
  cwd: root,
});

process.exit(run.status ?? 1);
