# 插件系统工业级复审与彻底重构

## Context

上一轮已把插件系统升级到 Plugin API 1.2（规范布局、全类型 ID 唯一、引用边界、操作日志、启动对账隔离）。本轮目标是对「导入 → 验签 → 布局/引用校验 → 依赖可用性 → 提交 → 目录应用 → 运行时执行 → 回滚/备份 → 启动恢复」全链路逐环节复审，修掉真实缺陷、重复计算、死代码和误导性错误信息，并补齐防御性校验。

两条硬约束：
1. 不用命令行改代码；命令行只做重命名/移动/建目录，所有内容修改用 Edit/Write。
2. 不为简化删功能；不做迁移/兼容；直接删除过时设计。

---

## 一、发现的缺陷与修复方案

### 1. 宿主工具白名单边界可被持久化数据绕过（安全）

`PUBLIC_HOST_TOOLS` 目前只存在于 `entrypoints/background/plugins/execution.ts`，`verifyPackage` 与启动 `reconcilePackages` 都无法用它校验 `capabilities.hostTools`。IndexedDB 被篡改后可声明内部工具（如 `browser_page_exec`），`catalog.pluginToolCeiling()` 会把内部工具名并入插件智能体工具上限，造成越权暴露。

修复：
- 新建 `utils/plugins/host-tools.ts`，迁移 `PUBLIC_HOST_TOOLS` 与 `isPublicHostTool(ref)`。
- `utils/plugins/package.ts` 验包时强制 `builtin/x` 必须在公开集合内。
- `utils/plugins/reconcile.ts` 启动复核 `manifest.capabilities.hostTools` 全部为公开工具。
- `utils/plugins/catalog.ts` 的 `pluginToolCeiling` 再做一次 `isPublicHostTool` 防御过滤。
- `entrypoints/background/plugins/host.ts` 删除已冗余的 `checkHostTools` 调用与函数；`execution.ts` 改用共享集合。

### 2. 包校验细节

`utils/plugins/package.ts`
- `text()` 的 `TextDecoder(fatal)` 遇到非 UTF-8 会抛无错误码的 TypeError：包一层，抛 `INVALID_UTF8` + 路径。
- `integritySchema.files` 的 `path` 仅 `z.string()`：改为复用 `safePath` 语义（长度、字符集、深度、保留名），`size` 上限 `LIMITS.file`，避免完整性清单自身成为攻击面。
- Skill 资源收集把 `SKILL.md` 也塞进了 `skill.files`，形成正文重复：跳过 `entry.path`。
- `capabilities.network` 统一要求「https 源（origin）」：在 `contracts.manifestSchema` 增加 refine，保证 `includes(url.origin)` 的精确匹配语义成立；同时要求 hostTools/secretSlots/network 去重。
- `skill.files` / `resourceBytes` 统计总字节并纳入快照上限（现状只限制压缩包展开）。

### 3. 删除 `optionalDependencies` 死设计

1.2 禁止跨插件引用后，`optionalDependencies` 已无任何运行时语义（只在 schema/校验里出现）。按「删除过时设计」直接移除：
- `utils/plugins/contracts.ts` manifest schema
- `utils/plugins/package.ts` 依赖校验循环
- `utils/plugins/reconcile.ts` manifest 完整性检查
- `utils/plugins/dependencies.ts` 里唯一引用它的回退表达式
- `tests/plugins/plugins.test.ts` fixture

### 4. 依赖可用性计算不再可能整体抛错

`utils/plugins/dependencies.ts`
- 删除跨插件 `REFERENCE_BLOCKED` 分支（1.2 已在验包期禁止跨插件引用，属死代码）。
- 依赖深度超限从 `invariant` 抛错改为 `reasons.set(key,'DEPENDENCY_DEPTH')`，避免一条深链把整个目录打成不可用。
- 环检测不再被后续 `DEPENDENCY_BLOCKED` 覆盖为更模糊的原因。
- `optionalDependencies` 回退表达式随第 3 条删除。

### 5. 启动对账补齐防御性校验

`utils/plugins/reconcile.ts`
- `packageProblems` 增加：
  - `capabilities.hostTools` 全部属于公开宿主工具；
  - `capabilities.network` 为合法 https origin；
  - agent 的 tools/skills、skill 的 allowedTools 只能指向本插件已声明贡献或 builtin 公开工具；
  - 贡献记录的基本形状（tool: description/inputSchema/executor；skill: name/description/body/allowedTools；agent: name/system/tools/skills），防止被篡改记录进入目录后让 `applyPluginSnapshot` 半途抛错；
  - `canonicalContributionPath` 在 id 缺失时给出可读占位而非 `undefined`。
- `changed` 比较忽略运行期字段 `blocked`（见第 6 条）。
- `computeAvailability` 失败分支保留既有 `quarantined` 精确原因，不被通用原因覆盖。

### 6. 消除 `blocked` 持久化冗余

`blocked` 是依赖图派生值，每次 `snapshot()` 都会重算；持久化它既冗余又可能过期。

- 新增 `utils/plugins/contracts.ts` 的 `persistedPackages(packages)`：返回剔除 `blocked` 的副本。
- `utils/plugins/repository.ts` 的 `commit` / `restore` 写库前剔除 `blocked`；`read` / `dump` 读出时也剔除（防御历史脏数据）。
- `reconcile.ts` 的差异比较同样先剔除 `blocked`，避免每次启动因派生字段不同而重复 commit。
- `service.snapshot()` 仍是唯一给 `blocked` 赋值的地方（`computeAvailability`）。
- `InstalledPlugin.quarantined` 保留（它是「安装本身不可信」的持久结论，不能被重算覆盖）。

### 7. Repository 健壮性

`utils/plugins/repository.ts`
- `open()`：同步抛错/首次打开失败时清空缓存 Promise，避免一次失败永久锁死。
- `read()` / `dump()`：`normalizeState` 校验 `generation` 为非负整数、`packages` 为数组、过滤非对象记录，保证 `service.snapshot` 的 catch 分支不会二次抛错。
- `listOperations`：`limit` 做 `Number.isFinite` 归一化，避免 NaN 退化为全量扫描。
- `restore`：校验 release 记录 `id === key@version`、digest 格式，失败给出精确 `INVALID_RELEASE_RECORD`。

### 8. Service 消除重复验签

`utils/plugins/service.ts`
- 新增 `installPreviewed(preview, bytes, expected, approvedDigest)`：安装只接受已验签预览，内部校验 generation/digest 一致性后完成 CAS、可用性、断依赖检查与提交。
- 保留 `install(...)` 作为「预览 + installPreviewed」的薄封装（测试与内部调用）。
- `host.ts` 的 `install` / `github-install` / `rollback-install` 改用 `installPreviewed`，消除每次安装 2 次 SHA-256 + Ed25519 验签与 2 次 DB 读。
- `snapshot()` 的异常分支依赖第 7 条归一化后的 `packages`，不再假设结构完好。

### 9. 启动引导去重

`entrypoints/background/plugins/host.ts`
- `bootstrapHost`：release 缺失检查后只做一次 `computeAvailability`，用提交返回值构造快照直接 `applyPluginSnapshot`，去掉多余的 `service.snapshot()` 读库+重算。
- `backup-export`：`RELEASE_NOT_FOUND` 带上 `key@version`；`backup-restore` 的 `archives` 加 `.min(1)`，避免 replace 空数组静默清空目录。
- `execute`：`approved` 改为可选布尔（未批准时由网关返回 `PLUGIN_APPROVAL_REQUIRED`，而不是 zod 的 `INVALID_PAYLOAD`）；`ref` 先做插件 ref 形状校验。
- `secret`：插件不存在时明确 `PLUGIN_NOT_FOUND`。
- `catalog`：读取的续订序号做数字校验，非有限数按 0。
- `check-updates`：`NO_UPDATE_AVAILABLE` / `NO_PLUGIN_RELEASE` 视为「无更新」而非失败，不再写进 failures；仅 401/403/429 中止批次。
- 删除 `checkHostTools`（第 1 条后由验包/对账保证）。

### 10. 运行时执行

`entrypoints/background/plugins/execution.ts`
- 改用共享 `PUBLIC_HOST_TOOLS`。
- 捕获块统一经 `describeOperationError` 输出 `CODE: detail`，避免 SDK 异常只留一句不可分析文本。
- 区分「超时」与「能力撤销」：`controller.abort('timeout' | 'revoked')`，错误信息对应 `PLUGIN_HOST_TIMEOUT` / `CAPABILITY_REVOKED`。
- 秘密值读取后校验 `typeof === 'string' && length > 0`，否则 `SECRET_REQUIRED`。
- MCP 连接/列表/调用异常包装为 `MCP_FAILED` 并保留原始 message。

### 11. JSON / Schema 可诊断性

`utils/plugins/json.ts`
- 未闭合字符串改为 `invariant(false,'INVALID_JSON',...)`，不再抛裸 Error。
- `INVALID_JSON` / `INVALID_JSON_NUMBER` / `DUPLICATE_OR_UNSAFE_KEY` 纳入阶段映射。

`utils/plugins/schema.ts`
- `checkSchema` 的错误 detail 带字段路径（如 `properties.x.pattern`）。
- `validateArguments` 记录首个失败路径与期望/实际类型，错误 detail 形如 `properties.count: expected integer, received string`，而不是只有 `INVALID_ARGUMENTS`。

### 12. 错误码阶段映射补全

`utils/plugins/operations.ts`
- 补全：`DOWNLOAD_FAILED/DOWNLOAD_LIMIT/NETWORK_TARGET_REJECTED`（download）、`GITHUB_* / NO_* / AMBIGUOUS_RELEASE_ASSET / INVALID_CANDIDATE`（download）、`INVALID_UTF8 / INVALID_JSON / INVALID_JSON_NUMBER / DUPLICATE_OR_UNSAFE_KEY`（manifest）、`INVALID_PAYLOAD / UNKNOWN_PLUGIN_OPERATION / MANAGEMENT_ONLY / PLUGIN_SENDER_REJECTED`（request）、`VALIDATION_BUDGET`（schema）、`BACKUP_LIMIT / ROLLBACK_EXPIRED / INVALID_RELEASE_RECORD / CATALOG_*`（commit）、`TOOL_NOT_FOUND / INVALID_EXECUTOR / MCP_FAILED / PLUGIN_EXECUTION_FAILED / NATIVE_REPLAY_DEPTH / TOOL_REQUEST_LIMIT`（runtime）。
- 目的：日志「阶段」不再把下载失败归到 request。

### 13. Catalog / Client

`utils/plugins/catalog.ts`
- `pluginSkills` 排除 `quarantined` 安装（隔离包不贡献任何内容，包括禁用态列表项）。
- `pluginToolCeiling` 增加公开工具过滤。

`utils/plugins/client.ts`
- 删除重复的 `encodeBytes`，改从新 `utils/plugins/codec.ts` 引入 `toBase64`（`codec.ts` 同时承载 `base32/decode64/sha256`，`package.ts`、`github.ts`、`host.ts`、测试改为从 codec 导入，消除重复实现）。
- `pluginRequest` 超时定时器在成功/失败后 `clearTimeout`，不再遗留计时器。
- 新增 `replacePluginSnapshot` 场景：当宿主 generation 回退（用户清空扩展数据/重装宿主）时，`refresh` 用无 generation 门槛的替换路径重建目录，避免页面永久停留在旧快照。
- `refresh` 仍保留失败不致命语义。

### 14. UI 可诊断性

- `entrypoints/hub/plugins/composables/use-plugin-center.ts`：`load()` 改为一次 `refresh()` + 从 catalog 读值，去掉 `startPluginClient` 已做过的重复 snapshot 请求。
- `PluginInstalledCard.vue`：当 `plugin.quarantined` 或 `plugin.blocked` 时，展示可展开的诊断行（原文原因 + 错误码），而不是只放在 `title` 悬浮提示里；长原因允许换行。
- 其余 UI 结构、DOM 契约与 i18n key 保持不变，避免破坏 `tests/plugins/ui.test.ts`。

### 15. wire-names

`utils/plugins/wire-names.ts`
- 200 工具上限检查前移到编码开始处；`native` 递归保持深度上限，不新增行为。

---

## 二、涉及文件清单

**核心域（改）**
- `utils/plugins/contracts.ts`
- `utils/plugins/package.ts`
- `utils/plugins/json.ts`
- `utils/plugins/archive.ts`（如需补充 `INVALID_UTF8` 细节）
- `utils/plugins/schema.ts`
- `utils/plugins/dependencies.ts`
- `utils/plugins/reconcile.ts`
- `utils/plugins/repository.ts`
- `utils/plugins/service.ts`
- `utils/plugins/catalog.ts`
- `utils/plugins/client.ts`
- `utils/plugins/operations.ts`
- `utils/plugins/github.ts`
- `entrypoints/background/plugins/host.ts`
- `entrypoints/background/plugins/execution.ts`

**新增（必要）**
- `utils/plugins/host-tools.ts`（去掉 execution→package 的循环依赖，集中公开工具白名单）
- `utils/plugins/codec.ts`（base64/hex/base32，消除 client/package 重复实现）

**UI（改）**
- `entrypoints/hub/plugins/composables/use-plugin-center.ts`
- `entrypoints/hub/plugins/components/PluginInstalledCard.vue`

**测试（改/补）**
- `tests/plugins/plugins.test.ts`：fixture 移除 `optionalDependencies`、codec 导入、`installPreviewed` 覆盖、非公开 host tool 隔离、skill.files 不含 SKILL.md、`strictJson` 错误码、参数校验路径、repository 脏数据归一化、无更新不记失败。
- `tests/plugins/ui.test.ts`：仅随 client/catalog API 调整导入；DOM 契约不动。

**文档（按需）**
- `docs/plugin-*.md`：同步「移除 optionalDependencies」「公开宿主工具白名单在验包期强制」「network 必须为 origin」。

---

## 三、执行顺序

1. 先落共享模块 `host-tools.ts` / `codec.ts`，再改 contracts（network origin、去 optionalDependencies、persistedPackages）。
2. 包校验链：package → json → schema → archive。
3. 目录链：dependencies → reconcile → repository。
4. 服务/宿主：service → catalog → client → host → execution → github → operations。
5. UI 小改 + 测试补齐 + 文档同步。
6. 每完成一组用 Edit 逐文件修改（禁止命令行批量替换），组间跑一次相关测试。

---

## 四、验证

按顺序执行：
- `npm run test:plugins`
- `npm run test:plugins:ui`
- `npm run test:hub`
- `npm run test:skills`
- `npm run test:i18n`
- `npm run test:conversation-runtime`
- `npx eslint <本轮修改文件>`

补充人工链路检查：
- 本地包导入 → 审查 → 安装 → 启用 → 会话内工具调用 → 禁用 → 重新启用。
- GitHub 预览/安装 → 更新检查徽章 → 回滚到历史版本。
- 备份导出 → replace 恢复（禁用态）→ 备份回滚。
- 篡改 IndexedDB：非法 host tool / 非法 ref / 缺 release → 启动隔离且管理页可卸载。

已知环境问题：全量 `npm run compile` 目前被工作区中与本任务无关的 data-ref 改动（`DataRefStoreEngine.extract` 缺失）阻断；本轮以插件相关测试 + eslint 为准，并在最终说明中明确该旁路阻断。
