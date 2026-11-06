/**
 * 上下文压缩领域测试运行器
 *
 * 用法：node tests/compaction/run.mjs
 *       npm run test:compaction
 *
 * 覆盖：
 *   - boundary.test.ts：compaction-boundary 纯模块的两种边界模式
 *     （user-boundary / group-boundary）、头部实质判定（二次压缩空转防护）、
 *     切分不变量（无损拼接 / 组边界 / 无悬空 tool_call / 预算约束）与防御回退；
 *   - compactor.test.ts：压缩器本体的提示词契约、结果清洗与自愈、
 *     分段归并、预算/次数防御、摘要记忆消息（plan_tool 回读引导等）。
 *
 * 被测依赖链：boundary 侧（context-window-guard / token-estimate /
 * summary-message / channel-types）均为零副作用纯模块；compactor 侧经
 * ai-chat-api 引用 tools/index.ts（openai-tools-converter 的工具注册表），
 * 依赖链中的 skill-store 使用 Vite 专属的 import.meta.glob——与 tests/tools
 * 套件同款 shim 改写（返回空对象；测试不涉及预置技能文件枚举）。
 * 产物写入 node_modules/.cache（可随时清理、天然被 git 忽略）——必须放在
 * 仓库内：产物若落在系统临时目录将找不到 node_modules。
 */

import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

/** 把 Vite 专属的 import.meta.glob(...) 改写为返回 {} 的本地函数（仅当文件中出现时才改写） */
const importMetaGlobShim = {
  name: "import-meta-glob-shim",
  setup(buildApi) {
    buildApi.onLoad({ filter: /\.(ts|mts|cts|js|mjs)$/ }, async (args) => {
      if (args.path.includes(`${path.sep}node_modules${path.sep}`)) return undefined;
      const source = await readFileSync(args.path, "utf8");
      if (!source.includes("import.meta.glob")) return undefined;
      const shimmed =
        "const __importMetaGlobShim = () => ({});\n" +
        source.replace(/import\.meta\.glob/g, "__importMetaGlobShim");
      return { contents: shimmed, loader: "ts" };
    });
  },
};

const entries = [
  { entry: "tests/compaction/boundary.test.ts", output: "node_modules/.cache/compaction-boundary.test.mjs" },
  { entry: "tests/compaction/compactor.test.ts", output: "node_modules/.cache/compactor-compactor.test.mjs" },
];

for (const { entry, output } of entries) {
  const resolved = path.resolve(output);
  mkdirSync(path.dirname(resolved), { recursive: true });
  await build({
    entryPoints: [entry],
    outfile: resolved,
    bundle: true,
    platform: "node",
    format: "esm",
    plugins: [importMetaGlobShim],
  });
  await import(pathToFileURL(resolved).href);
}
