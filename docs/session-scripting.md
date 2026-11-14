# 会话脚本与文本文件引擎

会话通过全局默认 `js_run` 使用页面 JavaScript，Python 环境就绪后可使用 `python_run`。两者复用 `utils/python-workspace/file-action.ts` 与 `workspace-files.ts`（分页读取引擎与 `results/` 结果目录见 `workspace-files.ts` / `data-files.ts`），与上传附件、技能资源及文件卡片共享当前会话的 IndexedDB 工作区。无需安装 Python 即可创建、读取、编辑和删除文本文件。

`tools/javascript/js-prompt.ts` 是通用流程的唯一提示词来源，由 runtime-builder 无条件注入。智能体只补充自身场景约束。两个 JavaScript 入口都不在智能体可选工具组中；不提供旧脚本名称或旧配置迁移。backend 的内联入口继续独立注册，原工具文件不变；会话装配、schema 导出和执行闸门均排除它。

## 调用契约

| action | 输入与行为 |
|---|---|
| create | `path/content`，创建任意扩展名的 UTF-8 文本；存在则拒绝；`results/` 子树为工具写入域，手工创建被拒 |
| edit | `path` 加 `content`、`find/replace` 或 `edits` 三选一；`results/` 下拒绝就地编辑 |
| delete | 删除普通文件或链接本身；拒绝目录（含 `results/` 下的结果文件清理） |
| read | `path` + 可选 `index`（页码，1 起、默认 1）分页读取任意工作区文本文件；每页 ≤2000 字符，返回当前页码/总页数/nextIndex 与 `sha256`；一次只读一个文件 |
| list | 按可选目录 `path`、`offset/limit` 盘点工作区 |
| run | `path` 指向已保存的 `.js/.mjs/.cjs`，可配 `args/world/strategy/awaitPromise/timeout/tabId/frameId/label/confirm/expectedHash`；完整结果自动落盘 `results/` 结果文件（≤10MB），响应只回传前 2000 字符 |
| crawl | 同一脚本按 targets 逐页执行，支持动态参数、frame、逐目标与整批预算、间隔、身份检查、结果文件落盘和逐目标账本 |

示例：

```json
{"action":"create","path":"scripts/collect.js","content":"const { selector, limit } = $args[0]; return [...document.querySelectorAll(selector)].slice(0, limit).map(node => ({text: node.textContent}));"}
```

```json
{"action":"run","path":"scripts/collect.js","args":[{"selector":".item","limit":3}],"label":"样本"}
```

验证后对同一文件更换参数执行。JavaScript 是在网页中运行的 async 函数体，允许 await/return，既不具备扩展宿主文件权限，也不是 Node/ESM 模块加载器。脚本内容按读取时的不可变快照执行，结果携带实际脚本路径与 SHA-256。每次 run/crawl 的完整结果自动保存为 `results/` 下的独立 JSON 结果文件（命名 `<kind>-<时间戳>-<随机>-<label?>.json`，随会话工作区持久、跨浏览器重启可用），响应仅回传前 2000 字符，超出部分用 read 从 `index=2` 按页续读；下载文件则由文件生产工具保存至 `outputs/` 并交付文件卡片。

## 编辑语义

默认逐字符精确匹配，必须唯一命中；`replaceAll=true` 才替换所有非重叠命中。替换内容按字面处理，`$&`、`$1` 等不会被解释。UTF-8 BOM 和未修改区域的换行保持原样。非 UTF-8 文件会明确报错，避免静默损坏。

显式 `matchMode="indentation"` 按完整行块的相对缩进匹配，允许整体缩进偏移，替换内容对齐目标缩进与换行；不自动猜测近似文本。`edits` 按顺序作用于同一内存快照，任一替换失败则整次不提交。`expectedHash` 使用 read 返回的 SHA-256，文件变化时拒绝编辑。所有修改共用工作区锁、revision CAS、会话归属和配额校验；取消或删除会话后不得提交文件。

模型直供文本单项上限 200000 字符；就地编辑与脚本读取上限 8 MiB；批量编辑最多 100 项。JS 动态参数只接受 JSON 数组，最多 100000 个节点、64 层、1000000 字符，拒绝循环引用、非有限数字、BigInt、函数和隐式丢失的 undefined。文本 read 每页 ≤2000 字符（页边界收缩避免拆开 Unicode 代理对，文件上限 16 MiB）；结果文件与数据文件单文件 ≤10MB；list 默认 100、最多 200 项。

## 执行与权限

页面执行完整复用已有引擎：MAIN/ISOLATED、auto/cdp/scripting、frame 定向、动态参数与 Promise 模式（backend 内联入口另有默认暂存与有界预览；会话入口的结果统一落工作区结果文件）。仅在用户代码尚未执行的 CSP 权限探测失败时升级通道；用户代码开始后不自动重放。

run 的 timeout 默认 30000、上限 300000 毫秒；crawl 按逐目标及整批预算执行。会话引擎保留对应的外层超时缓冲。超时只结束等待，不保证页面脚本停止，也没有最终结果轮询句柄。CDP 取消会尽力终止当前求值；注入通道无法保证强制停止，回执不明时必须先检查现状。审批沿用现有敏感/资金操作规则，对 run/crawl 生效。观察型视觉助手可使用文件动作与数据读取，schema、会话执行闸门和工具自身都拒绝 run/crawl。

侧边栏向后台转发时，会话 ID、审批状态、观察策略及取消 ID 使用独立宿主信封传递，不作为模型工具参数；后台只接受扩展 UI 发来的会话信封。JS 文件动作不消耗视觉截图，run 按可能改变页面处理并触发续拍。

验证入口：`npm run test:js`、`npm run test:workspace`，以及技能、管理中心、插件和会话运行时回归。
