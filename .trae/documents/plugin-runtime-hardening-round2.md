# Plugin API 1.3 复审收尾：边界一致性与错误语义加固

## Context

本轮已完成 Plugin API 1.3 的全链路改造（host-workflow、页面原语、三级审批、旧引用迁移、官方 Bilibili 插件）。在逐行复审契约、验包、启动对账、执行网关、工作流、原语、审批与迁移链路后，主体逻辑已闭环；但仍有若干**防御纵深不一致、错误码不精确、运行时诊断不足**的残余问题：

- 验包期拒绝的私有/回环网络声明，在**启动对账**里仍可能被放行（篡改持久化记录可把 `https://localhost` 注入 `pluginOrigins`）。
- 执行网关把「60s 超时」在部分竞态下误报为 `CAPABILITY_REVOKED`；MCP 流式超限错误码会被 SDK 吞成 `MCP_FAILED`。
- 工作流对「模型输入经占位符放大后的步骤参数」缺少运行时字节预算复检。
- 页面原语的部分错误信息不够可分析（`requests` 非数组、`location` 未 trim、响应字段未归一）。
- 审批缓存无参撤销的语义与存储清理不一致。

本计划只做**加固与纠偏**，不简化任何功能、不改动既有审批/执行语义、不引入新依赖。所有代码内容修改使用编辑工具逐处完成，命令仅用于编译、测试与打包验证。

## 修复清单

### 1. 网络边界单一事实源（高）

- `utils/plugins/reconcile.ts`
  - 删除本地弱校验 `networkOriginOf`，改为复用 `contracts.publicHttpsProblem`：
    `new URL(value)` 后要求 `!publicHttpsProblem(url) && url.origin === value`。
  - 与验包期 `manifestSchema.networkOrigin` 完全同口径，杜绝「验包拒绝、启动放行」。
- `utils/plugins/package.ts`
  - MCP executor URL 在校验 `network.includes(origin)` 之前先跑 `publicHttpsProblem`，私有/回环/IP 字面量给出 `NETWORK_TARGET_REJECTED`，避免误报为 `UNDECLARED_NETWORK`。
- `utils/plugins/network.ts`、`utils/plugins/contracts.ts` 保持现状（单一实现，不复制逻辑）。

### 2. 执行网关错误语义与资源收敛（高）

- `entrypoints/background/plugins/execution.ts`
  - 执行结束后的能力复检按 `controller.signal.reason` 区分：
    `timeout` → `PLUGIN_HOST_TIMEOUT`，其余 → `CAPABILITY_REVOKED`。
  - `cancelled` Promise 的 abort 监听器在操作正常完成后移除，避免残留监听。
  - MCP 流式读取超限抛 `PluginError('MCP_RESPONSE_LIMIT')`，不再被 SDK 统一收敛为 `MCP_FAILED`。

### 3. 工作流预算与失败分类（中）

- `utils/plugins/workflow.ts`
  - 模板解析后、调用前对 `stepArgs` 做 `assertBounded(..., WORKFLOW_LIMITS.args)` 复检（模型输入可放大静态模板）。
  - `outputOf` 在无步骤可用时给出稳定文案，避免 `WORKFLOW_OUTPUT_STEP: undefined`。
  - `HARD_FAILURE_PREFIXES` 补充 `NETWORK_TARGET_REJECTED`、`MCP_ORIGIN_MISMATCH`：安全类失败不能被 optional 步骤吞掉。
- `utils/plugins/operations.ts`
  - 补齐缺失的错误码 → 阶段映射：`PLUGIN_ORIGIN_REQUIRED`、`INVALID_RESULT`、`WORKFLOW_STEP_LIMIT`、`WORKFLOW_DUPLICATE_STEP`、`WORKFLOW_OUTPUT_OPTIONAL`。

### 4. 页面原语健壮性（中）

- `tools/common/plugin-origin.ts`
  - `chrome.tabs.query` 包 try/catch，异常收敛为 `TAB_NOT_FOUND`（与 `chrome.tabs.get` 一致）。
- `tools/browser/page-http-tool.ts`
  - `requests` 非数组与超限分别返回精确 `INVALID_ARGUMENT`。
  - `location` 编译前统一 trim（校验与使用同一字符串）。
  - openaiSchema：`url` 增加 `maxLength: 4096`，`project` 用 `anyOf` 声明三种合法形状（模型可读）。
  - 响应归一化：`status`/`bytes` 非有限数字落 0，`truncated` 强制布尔；`data` 为 `undefined` 且非 optional 时按缺失处理。
  - `projectProblem` 增加单条路径长度上限（256），与声明一致。
- `tools/browser/media-control-tool.ts`
  - 宿主侧提前校验：`setRate` 必须有 `rate`、`setVolume` 必须有 `volume`，返回可读 `INVALID_ARGUMENT`。
  - 页面返回值做最小形状校验（`ok` 布尔）后再拼装成功响应。

### 5. 审批缓存语义（中）

- `utils/plugins/approvals.ts`
  - 无参 `revokePluginApprovals()` 清理**全部**记录（内存 + `chrome.storage.session`），与函数名一致；带 key 时行为不变。
  - 读取到过期 storage 记录时顺带删除，避免会话存储堆积。
  - 保留旧格式（纯数字 expiresAt）兼容与说明。

### 6. 测试与文档

- `tests/plugins/plugins.test.ts` 新增：
  - 启动对账拒绝 `https://localhost` / `https://[::1]` / `https://10.0.0.1` 的篡改网络声明（→ quarantined）。
  - 无参 `revokePluginApprovals()` 清空全部会话审批。
  - 工作流占位符放大后参数超限 → `WORKFLOW_ARGS_LIMIT`。
  - optional 步骤遇到 `NETWORK_TARGET_REJECTED` 仍中止（硬失败）。
- `docs/plugin-developer-guide.zh-CN.md`：仅在错误码/语义对外可见时补一句（预计无需大改）。
- 复核 `plugins/official/bilibili/**`（manifest、search/subtitle/jump、agent、skill）与 `legacy-refs.ts` 映射，不改功能。

## 非目标

- 不重构既有宿主工具实现，不改三级审批语义，不简化任何能力。
- 不触碰 `conversation-engine.ts` 中既有的 `['4','5']` 内置技能白名单（历史设计，与本轮无关）。
- 不新增依赖、不修改发布密钥与 `.anplugin` 内容（重新打包仅用于验证）。

## 实施顺序

1. 网络口径统一（reconcile / package）
2. 网关错误语义与 MCP 限制（execution）
3. 工作流预算与硬失败分类（workflow）
4. 错误码阶段映射（operations）
5. 页面原语（plugin-origin / page-http / media-control）
6. 审批缓存（approvals）
7. 测试补充
8. 全量回归

## 验证

- `npm run compile`
- `npm run test:plugins`（含新增用例）
- `npm run test:all`
- `npm run plugin:sdk` 的 pack/validate（对 `plugins/official/bilibili` 验证签名与布局，记录新 digest，不替换发布密钥）
- 链路模拟核对：
  - `search`：navigate → optional wait → extract（0 结果仍成功）
  - `subtitle`：location → view → player → subtitle
  - `jump`：host-alias + 数字/字符串时间
  - `browser_page_http`：location 不匹配、投影缺失、optional 失败
  - `browser_media_control`：直播 seek、setRate/setVolume 缺参
