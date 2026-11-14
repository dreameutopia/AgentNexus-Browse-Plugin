/**
 * 文档工具（document_tool）的注册入口 —— **仅 sidepanel**
 *
 * ==================== 为什么单独一个模块 ====================
 *
 * background 的 conversation-runtime 复用了 sidepanel 的会话层模块
 * （conversation-engine → openai-tools-converter），因此这两个入口共享
 * 一批模块，Vite 会把它们放进 background 的 chunk。
 *
 * 若在 openai-tools-converter 里静态引用文档工具，它带来的重依赖
 * （docx 1.6MB、katex 0.6MB、markdown-it、highlight.js，合计约 2.7MB）
 * 就会一并落进 background 主包——而 background 是 service worker 入口
 * （Vite 强制 inlineDynamicImports），无法拆成按需加载的独立 chunk，
 * 等于让扩展冷启动白背 2.7MB。
 *
 * 文档工具全程在 sidepanel 执行（执行器先查当前上下文的注册表，命中即
 * 本地执行，不转发 background），因此它**只需要**在 sidepanel 注册。
 * 本模块由 sidepanel/main.ts 在加载 App 之前导入，保证注册早于任何
 * 工具查询。
 */

import { registerDocumentTools } from '@/tools/document';

registerDocumentTools();
