# 插件开发与维护指南（Plugin API 1.0）

## 快速开始

在宿主仓库安装依赖后，使用 Node.js 24 运行：

```powershell
npm run plugin:sdk -- init D:\plugins\web-research
npm run plugin:sdk -- pack D:\plugins\web-research --key D:\plugins\web-research.publisher-key.json
npm run plugin:sdk -- validate D:\plugins\web-research-1.0.0.anplugin
```

`init` 生成可用的工具 + Skill + 智能体示例，并将 Ed25519 私钥写在插件目录之外。不要提交私钥；离线备份它，后续版本必须使用同一发布者密钥。文件和输出已存在时 CLI 拒绝覆盖。

打开管理中心 → 插件，导入 `.anplugin`。检查发布者、权限、工具定义和智能体指令，确认后安装。工具会出现在任意自定义智能体编辑器的「外部插件工具」容器；Skill 和插件智能体也会立即进入各自目录。插件原件只读，避免更新覆盖用户手工修改；自定义智能体可以自由组合系统工具与插件资源。

升级时提高 plugin.json 的 SemVer，用同一密钥重新打包。文件导入、GitHub 在线安装和更新共享相同身份、签名、兼容性和内容校验。安装成功前不会发布一半资源。

## 文件与编辑器补全

根文件为 plugin.json、integrity.json、signature.json。后两项由 CLI 生成。工具、智能体为 JSON；Skill 使用标准目录和 SKILL.md。可只声明 tools、skills、agents 中任意一类。

编辑器 Schema 已生成在 `docs/plugin-schemas/{plugin,tool,agent}-v1.json`。例如开发时将 `$schema` 指向本地 schema 文件；打包前可删除开发路径。`npm run plugin:sdk -- schemas <目录>` 可重新生成，运行时仍以共享 Zod 契约为准。Schema 中 SemVer 字符串的语义约束由 CLI 验证。

包限制：压缩 10 MiB、解压 30 MiB、500 文件、单文件 5 MiB、目录深度 12。路径仅允许 ASCII 字母、数字、`_ . - /`，禁止绝对路径、反斜杠、重复/大小写重名和符号链接。Skill 资源当前为 UTF-8 文本；不把二进制文件放在 Skill 子目录。为了限制扩展消息和内存开销，安装目录的 JSON 快照总大小上限为 24 MiB；超限会拒绝安装并保留原状态。插件备份分区的 Base64 总量上限为 32 MiB，过大时需逐个导出原安装包。

## 稳定身份

```text
publisherId = ed25519:<原始公钥的无填充小写 base32，52 字符>
pluginKey   = publisherId/pluginId
toolRef     = pluginKey/tool-local-id
skillRef    = pluginKey/skill-local-name
agentRef    = pluginKey/agent-local-id
```

ID 永不使用显示名称或版本号。同一发布者不可为两个不同产品复用相同 pluginId；不同发布者可用同名 pluginId。工具、Skill、智能体分别按类型建立唯一注册空间。

在包内工具/技能引用中，`./search` 指本插件贡献；`builtin/browser_get_page_text` 指公开宿主能力；跨插件引用必须是完整 ref，并在 dependencies / optionalDependencies 中声明完整 pluginKey 和版本范围。包内相对引用只供作者书写，保存到运行目录的是完整 ref。

提示词中使用 `{{tool:search}}` 或 `{{tool:builtin/browser_get_page_text}}`；这是受限引用标记，不支持模板表达式。Skill 的标准 `name` 不加命名空间，关联和加载使用 skillRef。模型接口中的短函数名是请求级映射，不是插件的真实身份；不要硬编码 `anp_0` 等传输名。

## Manifest 的主要字段

| 字段                              | 含义                                                         |
| --------------------------------- | ------------------------------------------------------------ |
| manifestVersion                   | 当前必须是 1                                                 |
| publisher.id/displayName          | 可验证公钥身份 / 展示名称                                    |
| id/displayName/version            | 不变本地 ID / 展示名称 / 不含 build metadata 的 SemVer       |
| engines.agentnexus                | 宿主产品兼容版本范围，当前产品版本见 package.json            |
| engines.pluginApi                 | 插件公共 API 范围，当前为 `^1.0.0`                           |
| capabilities.hostTools            | 明确申请的公开宿主工具，所有 builtin 引用须在此声明          |
| capabilities.network              | 明确申请的 HTTPS origin，不含 path，不支持 localhost/私有 IP |
| capabilities.secretSlots          | 宿主管理的按插件隔离的凭据槽名称，包内不得包含实际秘密       |
| contributes                       | 各类贡献的本地 ID 与包内入口文件路径                         |
| dependencies/optionalDependencies | 以完整 pluginKey 为键的 SemVer 范围                          |

未知顶层字段报错。v1 不支持任意 JS/脚本、激活/卸载钩子、任意 HTTP 模板、动态工作流和直接操作 chrome.*。新增贡献类型须随宿主版本发布校验器和处理器；第三方不能提交可执行的扩展点实现。

## 工具执行类型

### host-alias

```json
{
  "description": "读取当前网页正文作为调研证据。",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  },
  "executor": {
    "type": "host-alias",
    "target": "builtin/browser_get_page_text"
  }
}
```

公开宿主工具表位于 `entrypoints/background/plugins/execution.ts` 的 PUBLIC_HOST_TOOLS。当前包括正文/页面信息/标签页列表、导航、书签与历史检索。宿主可在后续 API 版本扩大公开表，内部终止/控制工具不自动开放。

第三方工具默认需要会话操作审批。代理不会获得宿主全部扩展权限，也不能通过填写 metadata 关闭审批。限制了传入参数的代理仍调用原宿主实现。

### mcp（Streamable HTTP）

```json
{
  "description": "检索团队知识库。",
  "inputSchema": {
    "type": "object",
    "properties": { "query": { "type": "string", "maxLength": 1000 } },
    "required": ["query"],
    "additionalProperties": false
  },
  "executor": {
    "type": "mcp",
    "url": "https://mcp.example.com/mcp",
    "remoteName": "search",
    "secretSlot": "service-token"
  }
}
```

在 manifest 申请 `network: ["https://mcp.example.com"]` 和 `secretSlots: ["service-token"]`。安装后在插件卡片配置 token；宿主仅向该插件该 origin 发送 Bearer token，不跟随 MCP 重定向，不发送 Cookie。无凭据服务可省略 secretSlot。

v1 支持公开服务和手工配置 Bearer token；遇到 OAuth-only 服务会返回明确认证错误，不伪装连接成功，也不自动打开认证跳转。远端工具使用标准 MCP SDK 实现；不得将 OAuth token 直接写入包。

每次调用先执行 initialize / tools/list，核对 remoteName、完整 inputSchema 和 outputSchema，再 tools/call。工具新出现、名称不存在或 Schema 漂移不会自动授权；需作者发布新版本并让用户审核。每插件并发上限 4，总调用截止 60 秒、请求参数 128 KiB、单响应 1 MiB。副作用调用不自动重试。

JSON Schema 是无需 eval 的有界解释器，当前支持 type、properties、required、additionalProperties 布尔值、items、enum、const、anyOf/oneOf/allOf、minimum/maximum、minLength/maxLength、minItems/maxItems，以及 title/description/default 注解。根为 object。暂不支持 `$ref`、pattern/format 和其他关键字；会在打包时明确拒绝。Schema 限制 32 KiB、12 层、500 节点，分支最多 8 项。不要向宿主发送远端任意 Schema 要求其生成代码。

## 更新、禁用与回滚

- pluginKey 相同、签名有效、更高兼容版本才可常规更新；同版本不同包字节摘要拒绝。CLI 固定 ZIP 条目排序、时间戳与压缩设置，便于重复打包验证。
- 发布附件创建后应在离线分发、在线下载间复用同一文件，避免重新压缩造成同版本内容冲突。
- 升级保持插件原有启停状态。所有更新经过完整预览，不静默扩权。
- 当前实现采取保守策略：更新使旧执行绑定失效，使用旧版本的运行会中止/返回版本变化错误；不会在运行中切换到新工具实现。重新发起运行即可使用新版本。
- 禁用立即撤权并尝试中止进行中调用；取消不能撤销已发生的服务端/浏览器副作用。失效引用保留在用户配置中，不绑定同名替代物。
- 历史版本按钮仅允许恢复本机保存过的可信发布，重新验签并检查兼容性；卸载会删除该插件的本地发布历史和凭据。
- 扩展完整备份包含当前安装包，不含凭据；恢复后插件保持禁用，用户重新启用。旧备份没有 plugins 分区时不会清空本机插件。

## GitHub 发布与发现

1. 在仓库添加 `agentnexus-plugin` topic，使其可被社区搜索发现。
2. 在默认分支保留源码、README 和许可证；manifest version 与 Release tag `vX.Y.Z` 一致。
3. Release 中只上传一个 `.anplugin` 附件；客户端使用 GitHub asset digest 与包签名双重验证。
4. 建议开启 Immutable Releases：先创建 draft、上传附件，再发布。
5. 用户可搜索仓库，或粘贴 GitHub 仓库 URL 检查和安装。更新源记录 repository 数字 ID；重建同名仓库不能接管更新。
6. 离线导入的插件也可通过同身份 GitHub 包更新；同一包首次在线安装可显式绑定来源。已有来源不会被包内 repository 字符串更改。

可复制 `docs/plugin-release-workflow.yml` 到第三方插件仓库的 `.github/workflows/release.yml`。配置 SDK 仓库与固定提交、签名私钥 secret、受保护 release 环境后使用；此文件不会在当前宿主仓库自动执行。Actions 按已核对的完整提交固定：[checkout](https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1)、[setup-node](https://github.com/actions/setup-node/commit/949feb2413d6458794dcd2491c4babbbce0c15c1)。维护者应按依赖更新流程复核新版本。

## 官方目录与市场

在线市场由官方签名目录驱动：目录托管在官方 `AgentNexus-Browse-Plugin-Registry` 仓库的 GitHub Pages（`catalog.json`），目录 URL 与 Ed25519 目录公钥**内置在扩展构建里**（`utils/plugins/official-catalog.ts`），用户在插件中心搜索、安装、更新全程不接触任何密钥——签名验证、防重放（递增序号）、有效期检查全部在后台静默完成。

- 发现页默认按关键词本地筛选官方目录条目；「搜索 GitHub 社区」按钮扩展到社区搜索（结果明确标注未审核）。
- 打开插件中心自动检查已安装插件的更新（后台 6 小时节流、逐项容错、GitHub 限流即中止），发现新版本仅提示「可更新 vX.Y.Z」，安装仍走审查确认。
- 自托管目录场景：插件中心「自定义目录源（高级）」可填入 HTTPS 目录地址与独立可信渠道取得的目录公钥 Base64，验证规则与官方目录完全一致。

未签名目录结构：

```json
{
  "version": 1,
  "sequence": 1,
  "expiresAt": "2027-01-01T00:00:00.000Z",
  "plugins": [
    {
      "key": "ed25519:<52字符公钥>/web-research",
      "name": "网页调研",
      "description": "根据网页信息生成有引用的回答。",
      "repository": "https://github.com/example/web-research",
      "version": "1.0.0",
      "digest": "<安装包的64字符SHA-256>"
    }
  ]
}
```

使用独立目录签名密钥：

```powershell
npm run plugin:sdk -- catalog-sign unsigned-catalog.json --key catalog-private-jwk.json --out catalog.json
```

目录登记流程：向官方 `AgentNexus-Browse-Plugin-Registry` 仓库提交 PR，在 `plugins/` 下新增登记条目（字段与上表 `plugins[]` 单条一致）；CI 校验字段格式、核对对应 GitHub Release 资产存在且摘要一致、下载验签并比对插件身份后，以递增序号重建签名目录并发布到 Pages。目录签名与插件作者签名职责不同；目录公钥不从目录自身取得，轮换目录密钥需随扩展版本分发新公钥（与发布者密钥丢失同规则：不可用旧身份接管）。

目录撤销名单、发布者子密钥轮换、OAuth 服务授权和第三方 UI 贡献是后续独立 API 扩展，不默认放权；社区项明确显示未审核，不宣称 GitHub 账号已经过官方认证。

## 模块维护与验证

- `utils/plugins`：版本化契约、严格解析、包验证、Schema、仓库事务、依赖、生命周期服务、网络来源和客户端目录。领域验证与 Vue/Chrome 消息解耦。
- `entrypoints/background/plugins`：唯一后台协议入口、来源校验、执行网关、MCP 与公开宿主工具。
- `entrypoints/hub/plugins`、`ExternalToolsPicker.vue`：管理及选择 UI；只消费快照和后台操作。
- `scripts/plugin-cli.mjs`：创建、打包、验签、Schema 生成和目录签名；共享宿主验证逻辑。
- 既有用户智能体的名称键保持兼容；插件贡献有独立的 ID 目录和精确引用查询，不加入裸名称兼容索引。

运行 `npm run test:plugins:ui` 可挂载真实 Vue 组件，验证文件导入、显式授权、来源版本展示、工具选择和撤权后失效引用保留；测试自动生成自己的签名样例，不依赖手工准备。运行 `npm run test:plugins` 覆盖签名/篡改、同名隔离、版本重发、CAS、更新撤权、依赖阻塞、MCP Schema 漂移、GitHub 摘要、目录重放、后台 sender 与备份恢复。现有 tools、skills、backup、channels、conversation-runtime、contract 套件继续执行。生产发布前还需在真实浏览器安装扩展验证 UI，并与实际部署的 GitHub 目录和 MCP 服务做端到端验证；Node 中的模拟测试不能替代这些外部环境检查。
