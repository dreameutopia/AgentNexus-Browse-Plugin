import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const output = path.resolve(
  "node_modules/.cache/conversation-runtime-regression.mjs",
);
mkdirSync(path.dirname(output), { recursive: true });
await build({
  entryPoints: ["tests/conversation-runtime/runtime.test.ts"],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "runtime-dependencies",
      setup(api) {
        api.onResolve(
          {
            filter:
              /conversation-engine$|registry\/skill-engine$|channels\/app-settings$|interact-ui-bridge$|context\/(compactor|transcript-engine|context-meter)$/,
          },
          (args) => ({ path: args.path, namespace: "fake" }),
        );
        api.onLoad({ filter: /.*/, namespace: "fake" }, (args) => ({
          contents: args.path.endsWith("conversation-engine")
            ? `
        export const conversationEngine = globalThis.testEngine;
        export const composeLlmUserMessage = content => ({role:'user',content});
      `
            : args.path.endsWith("skill-engine")
              ? "export const skillEngine = {restore: async()=>{}};"
              : args.path.endsWith("app-settings")
                ? "export const appSettingsStore = {load: async()=>{}, getInteractTimeoutMinutes:()=>20};"
                : args.path.endsWith("compactor")
                  ? 'export const contextCompactor = {compact: input=>globalThis.compactInput(input), buildSummaryMessage: content=>({role:"system",content})};'
                  : args.path.endsWith("transcript-engine")
                    ? "export const transcriptEngine = {setCompaction: async()=>true};"
                    : args.path.endsWith("context-meter")
                      ? "export const COMPACTION_PRE_RUN_RATIO=0.85; export const measureContextUsage=()=>({ratio:globalThis.compactionRatio??0});"
                      : "export const registerInteractHandler=fn=>{globalThis.workerInteract=fn;}; export const getInteractHandler=()=>globalThis.viewInteract;",
        }));
      },
    },
  ],
});
await import(pathToFileURL(output).href);
