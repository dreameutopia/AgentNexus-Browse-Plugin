# AgentNexus 第三方插件系统设计与实施计划

日期：2026-11-04。以下保留原设计基线；已落地 v1 的使用方法、测试与兼容边界见 [插件开发与维护指南](plugin-developer-guide.zh-CN.md)。设计中的后续扩展项不等于当前版本已交付。

## 1. 推荐决策

采用「声明式插件包 + 宿主统一能力目录 + 受控工具适配器 + GitHub 目录与 Releases」架构。

- 一个包可贡献 tools、skills、agents；三类贡献均进入全局目录，任何智能体均可显式选择已授权的贡献。
- 插件智能体可引用自己的工具/Skill、宿主公开能力；跨插件引用必须声明依赖。
- 本地导入、URL 安装、在线更新共用一个验证、更新和提交管线，不维护三套规则。
- 身份不依赖名称、安装顺序、文件名或版本；禁止同名覆盖、自动加随机后缀、静默截断 ID。
- 插件原件不可变，用户设置独立存储。安装更新以事务切换生效；禁用是运行时撤权。
- v1 支持 Skill、智能体、系统工具的受限别名和远程 MCP 工具。不在扩展特权上下文执行下载的 JS、WASM、Python 或任意插件脚本。
- 扩展点按类型、版本分发，未来添加资源、提示模板等能力时继续复用身份、权限、存储和生命周期。

“无冲突”的可验证承诺应是：每个注册键有唯一所有者；发现任何身份、别名、资源路径冲突就拒绝整次操作，保留原有状态。不能用“概率很小”代替冲突检查，也不能承诺所有第三方服务永不出错。

## 2. 当前代码与必须改造的接入点

本提案基于工作区当前代码，包含尚未提交的后台会话运行时改造。实际落地前需重新核对并行变更。

| 现有代码 | 当前行为与影响 | 计划 |
| --- | --- | --- |
| `tools/registry.ts` | `register()` 对不同实例的同名工具替换；无所有者、批量撤销、代次 | 所有者检查、原子批量发布/撤销、不可变目录快照 |
| `tools/index.ts` | 静态注册内置工具 | 保留内置入口，外部贡献通过插件宿主适配器进入 |
| `entrypoints/background/tools/tool-registry.ts` | 构造时复制工具；WebSocket Schema 把参数展平成列表 | 改读实时目录，保留完整 JSON Schema，通知主程序目录变化 |
| `entrypoints/background/tools/tools-manager-listener.ts` | 以消息 `type` 匹配工具名，部分浏览器工具走专用路径 | 增加独立版本化插件协议；不允许贡献名占用控制消息 |
| `entrypoints/background/tools/index.ts`、`tools.ts` | 有直接调用工具的入口 | 全部经过同一个执行授权网关，避免绕过会话检查 |
| `entrypoints/sidepanel/utils/tools/openai-tools-converter.ts` | sidepanel 单独注册工具；Schema 直接取注册表对象 | 只消费目录快照；传输适配层生成请求名映射 |
| `utils/agents/agent-store.ts` | 主表按 `name`，ID 为二级索引；名称须唯一 | 主键转稳定 ID，名称作为非唯一展示索引 |
| `utils/agents/agent-types.ts` | 工具 ID 上限 64，归一化截断；Skill 引用上限 96 | 新插件引用采用独立严格校验，超长拒绝；避免长 ID 被截成同一个值 |
| `utils/skills/skill-types.ts` | ID 为 base36；模型标识为 `name-id`；来源只有 preset/custom | 增加 plugin 来源及所有者；插件使用全限定引用，保留标准本地 name |
| `utils/skills/skill-store.ts` | `resolveSkill()` 最后按裸名称取首项 | 插件解析禁止裸名称兜底；历史解析单独隔离 |
| `utils/skills/skill-import-export.ts` | 宽容导入，部分异常项跳过；`unzipSync` | 仅复用经审计的基础校验；插件需流式限额解包、整包严格验证 |
| `entrypoints/sidepanel/core/runtime/runtime-builder.ts` | 一次性装配；未知工具被过滤 | 保存解析版本和授权快照；依赖缺失明确诊断 |
| `entrypoints/sidepanel/core/conversation/conversation-engine.ts` | 已有本轮工具白名单与审批；Skill 加载可动态扩容 | 扩容取权限交集，执行前复查撤权；不能只靠装配时白名单 |
| `entrypoints/background/conversation-runtime.ts` | 当前工作区正在将会话运行归后台持有 | 插件生命周期权威也放后台；处理 worker 重启，不依赖面板常驻 |
| `entrypoints/hub/agents/AgentManager.vue` | 静态工具组；额外工具只有数量提示；技能编辑会解析引用 | 外部工具独立容器；保留失效引用，不能编辑保存时静默丢弃 |
| `entrypoints/hub/App.vue` | agents/skills/backup 三分区 | 增加插件中心 |
| `entrypoints/sidepanel/utils/backup/*` | 分区备份、验证、回滚机制 | 增加插件原件、锁定信息、用户覆盖分区；不通过 misc 绕过安装器 |
| `wxt.config.ts` | 浏览器扩展、CSP、宽泛宿主权限 | 插件权限独立限制，绝不继承宿主全部权限 |

## 3. 执行环境边界

Chrome MV3 要求扩展功能可从提交代码判断，并限制远程代码；官方特别列出了把远程 JSON 解释成复杂命令的违规情形。因此不能把“下载 JS 后 eval”改名为“JSON 工作流”就视为解决。[Chrome 官方政策](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)

v1 工具执行类型：

| 类型 | 开发者提供 | 宿主执行 |
| --- | --- | --- |
| `host-alias` | 一个已公开系统工具的引用、兼容参数约束、说明 | 固定宿主实现；保留原工具审批和能力边界；不接受代码、任意模板或调用链 |
| `mcp` | HTTPS MCP 服务配置、明确列出的远端工具名与 Schema | 宿主内置 MCP 客户端，通过协议调用服务；业务代码运行在服务端 |
| 后续 `native-service` | 用户独立安装的本地服务 | 独立协议和授权；不让浏览器静默安装/运行二进制 |

Skill 的 `scripts/` 可作为资源被检查，但 v1 不执行；现有 runtime 的“本环境不执行 Skill 脚本”约定继续生效。远程 MCP 可以离线安装配置，断网时工具状态为 unavailable，不能显示为可执行成功。

MCP 采用显式白名单：`tools/list` 中新出现的工具不能自动获得系统注册和执行权。允许 `list_changed` 触发重新检查；Schema 或能力变化要生成待审核变更。沿用标准 `inputSchema`、结果内容块和协议授权，不自行设计第二套通用 RPC。[MCP 工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)、[MCP 授权规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

“支持该执行类型”不等于保证商店审核通过；发布前需核对实际宿主行为和数据披露，不能利用 sandbox/debugger 作为任意插件代码的通用绕过路径。

## 4. 身份和引用规范

### 4.1 三层身份

推荐发布者使用可验证的公钥身份，GitHub 账号为附加验证信息。原因：离线包也必须证明它有资格更新线上安装的插件；GitHub 显示名称或自报 publisher 字符串做不到这一点。

```text
publisherId = "ed25519:" + base32Lower(rawPublicKey32Bytes)
pluginId    = 插件在该发布者下的不可变本地 slug
pluginKey   = publisherId + "/" + pluginId
resourceRef = pluginKey + "/" + localResourceId
registryKey = (kind, resourceRef)  // kind = tool | skill | agent
```

base32 必须无填充、固定 52 字符，解码后重新编码一致；它是原始公钥的可逆编码，不使用短哈希作为身份。示例文档可将长发布者部分简写为 `<publisher>`，存储和签名绝不能简写。

- `pluginId`、工具 local ID、agent local ID：`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`，1–48 字符；Skill local ID 与标准目录/name 一致，最长 64 字符。
- 全限定引用上限统一 256 ASCII 字符；超长直接报错。不 trim、lowercase 或截断非法身份使其“变合法”。
- 插件资源类型各有注册空间，允许同包 tool 和 skill 具有相同 local ID；引用解析必须知道 kind。
- `version` 不在 ID 中；同一 pluginKey 只允许一个活动版本，更新不破坏已保存引用。
- `displayName`、GitHub login、仓库 URL、包文件名、描述和版本都不参与唯一性判断。
- 内置资源新引用为 `builtin/<id>`，用户资源为 `user/<uuid>`；现有裸 ID 只通过显式历史映射兼容。第三方不能注册这两个保留命名空间。
- 注册 API 的 owner 来自安装器验证结果，不能从插件可随意填写的 metadata 中取值。

这是对主流 `publisher + name` 模式的增强：保留开发者易懂的 pluginId，增加离线可验证发布者锚点。VS Code 同样区分 publisher/name、SemVer 与宿主兼容版本，但本项目需要额外解决离线导入认证。[VS Code Manifest](https://code.visualstudio.com/api/references/extension-manifest)

### 4.2 签名与发布者连续性

- CLI `init` 生成发布者密钥、manifest 和模板，开发者无需手写长 publisherId。公钥入包，私钥不入仓库/插件包。
- 包含 `integrity.json`：严格版本化结构，列出除 integrity/signature 外每个文件的路径、字节数与 SHA-256；列表按路径排序。重复路径、未列出文件、漏文件都失败。
- 签名覆盖域分隔串 `AgentNexusPlugin/v1` 与规范化 integrity 文档；integrity 必须覆盖 plugin.json，身份和版本因此也受签名保护。规范化算法固定为 [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)，拒绝重复 JSON 键等歧义输入。
- `signature.json` 提供签名、公钥、算法；重算 publisherId 并核对 manifest。自签名只证明身份连续性，不证明作者可信。
- 已安装插件只有同一发布者合法签名才可更新；离线和在线执行完全相同检查。任何同名包或其他密钥均不能覆盖。
- v1 直接以发布者密钥签名；密钥丢失不能靠修改 manifest 接管旧身份。后续增加根密钥授权的发布子密钥/撤销证书，根公钥仍作为 publisherId。更换根密钥视为新身份，须独立迁移，不悄悄替换。
- 官方目录可把 publisherId 与 GitHub 数字 account ID、repository ID 绑定；昵称只展示。账号绑定变化、仓库转移须人工复核；仓库相同也不能跳过包签名。
- 不支持“没签名但声称同一发布者”的更新捷径。开发者调试使用独立 dev 身份；不污染正式身份的版本历史。

### 4.3 系统配置名与模型协议名

实际保存的工具和 Skill 引用严格采用 `pluginKey/localResourceId`，满足“插件身份 + 实际工具名/skill name”的要求。不同发布者的同名插件、不同插件的同名工具都不会互相覆盖。

完整身份可能含 `/`、`:` 且超过模型接口的函数名长度限制，不能直接写入 `function.name`。传输层为每次请求建立双射表，例如 `px_0001 → 完整 toolRef + releaseDigest + generation`：

- 别名在请求作用域内分配、显式检查唯一，不使用截断或短哈希猜测。
- 所有协议适配器共享该映射；发请求时替换 Schema 名称，回包立刻解码；执行、日志存完整引用。
- 会话历史保存原始协议名及对应映射/完整身份，重建请求时一致重映射 tool_calls 和结果消息；历史工具调用不自动重新执行。
- Skill 的 `name` 继续遵循 Agent Skills 标准；`load_skill` 和文件读取使用完整 skillRef。插件不加入裸名称解析索引。
- 提示词提及本地工具时使用受限引用标记，如 `{{tool:search}}`、`{{tool:builtin/browser_get_page_text}}`；只解析已声明引用，不执行模板表达式，并按本次请求映射渲染工具名。
- 历史裸名称只有迁移器可以解析，且多候选时返回 ambiguous，要求用户选择；不能取第一个注册者。

## 5. 开发者包与 Manifest

`.anplugin` 使用 ZIP 容器，根目录固定，无需 npm 工程或编译步骤。开发者可以只贡献其中任意一种资源：

```text
plugin.json
integrity.json
signature.json
README.md
LICENSE
tools/search.json
skills/research/SKILL.md
skills/research/references/checklist.md
agents/researcher.json
assets/icon.png
```

```json
{
  "$schema": "https://<官方规范域名>/schemas/plugin-v1.json",
  "manifestVersion": 1,
  "publisher": {
    "id": "ed25519:<CLI生成的52字符公钥编码>",
    "displayName": "Example Studio"
  },
  "id": "web-research",
  "displayName": "网页调研",
  "version": "1.2.0",
  "engines": { "agentnexus": ">=0.1.0 <1.0.0", "pluginApi": "^1.0.0" },
  "license": "MIT",
  "repository": "https://github.com/example/web-research",
  "capabilities": {
    "network": ["https://mcp.example.com"],
    "hostTools": ["builtin/browser_get_page_text"],
    "secretSlots": ["service-token"]
  },
  "contributes": {
    "tools": [{ "id": "search", "path": "tools/search.json" }],
    "skills": [{ "id": "research", "path": "skills/research/SKILL.md" }],
    "agents": [{ "id": "researcher", "path": "agents/researcher.json" }]
  },
  "dependencies": {},
  "optionalDependencies": {}
}
```

以上为结构示意，域名、公钥及兼容版本须由正式 SDK/项目版本替换，并非可直接安装的示例包。manifestVersion、pluginApi、宿主 app version 分别管理文件格式、宿主契约和产品版本，不混用。

工具定义保留 MCP 风格 `description/inputSchema/outputSchema`，增加 `executor: { type, ... }`。v1 的 `mcp` 必须声明 server URL、remoteName 与 Schema；`host-alias` 必须声明 target，不允许包装后减弱审批。工具版本默认继承插件版本，不要求开发者维护三套版本号；UI 显示插件版本和工具协议版本（如有）。

agent 定义保留现有 system、category、tags、avatar，工具/技能引用规则如下：

```json
{
  "name": "调研助手",
  "system": "先使用 {{tool:search}} 检索，再依据证据回答。",
  "tools": ["./search", "builtin/browser_get_page_text"],
  "skills": ["./research"]
}
```

安装器将 `./` 相对引用编译为全限定引用；绝不落库相对引用。第三方不能替换固定系统提示、核心工具、vision 策略或审批实现。引用其他插件必须使用完整身份且在 dependencies 中声明版本范围，禁止隐式按显示名称搜索。

Skill 复用标准 SKILL.md/frontmatter/资源目录，不把全限定身份塞进 `name`。`allowed-tools` 在插件作用域编译为 toolRef；它描述所需能力，不能自行授予能力。完整标准文件保持原件，派生结果单独存储。[Agent Skills 规范](https://agentskills.io/specification)

## 6. 全局贡献目录与权限

新增 `ContributionCatalog` 统一查询 tool/skill/agent：每项包含 ref、kind、ownerPluginKey、pluginVersion、releaseDigest、generation、displayName、availability、不可变 descriptor。UI、运行时、后台和 WebSocket 都消费这一事实源。

系统能力分三种：宿主公开且可引用的能力、用户授权后可引用的能力、仅内部使用的控制能力。不是所有已注册内置工具都自动成为插件公共 API。

第三方 Skill/智能体被选中不能突破权限：

```text
实际可调用集合 = 已注册且当前启用的能力
              ∩ 本会话显式配置/批准的工具集合
              ∩ 用户授予插件的能力上限
              ∩ 智能体运行策略（如视觉观察模式）
```

内置核心工具仍按宿主既有策略提供。Skill 激活可以请求将声明工具加入本轮，但超出会话已授权集合时必须走明确授权；`allowed-tools` 本身不是授权来源。插件 A 的代理引用系统工具也必须遵守目标工具原有审批，不能在代理工具 metadata 中声明 false 就跳过。

- 权限在后台网关逐次复查；所有侧栏、runtime message、WebSocket、直接 registry.execute 路径同源，不给直达 executor 的旁路。
- runtime 消息采用 `{protocolVersion, operation, requestId, resourceRef, expectedGeneration, args}`，控制字段不与 args 展开混合。校验 sender、连接身份与宿主生成的运行授权；不信任调用方自报 owner。
- MCP token 不放插件包、agent、日志或普通备份；宿主凭据存储按 pluginKey/server origin 隔离。远端服务不能拿到宿主全局模型密钥或浏览器 Cookie。
- HTTPS 默认只允许声明 origin；检查重定向，禁止凭据跨 origin 发送。localhost/局域网需单独用户授权；不宣称浏览器侧 hostname 检查能完全解决 DNS rebinding。
- 远端 descriptions/annotations 和插件提示词均视为不可信内容，不能影响宿主权限决定；v1 外部有副作用工具默认审批，可信低风险策略由宿主/用户设置。
- 工具注册到全局意味着所有智能体“可以选择”，不意味着自动加入每个会话，也不把全量第三方 Schema 塞入每次模型请求。

## 7. 安装、更新、禁用和卸载

### 7.1 统一事务管线

```text
输入文件 / GitHub Release / URL
  → 有限额下载到 staging
  → 严格解包与结构验证
  → 签名、完整性、身份、版本、兼容性验证
  → 解析全部贡献与依赖，检查引用/Schema/权限变化
  → 生成安装或更新预览（无注册副作用）
  → 用户执行安装/更新并授权必要能力
  → IDB 事务提交 release + active pointer + catalog generation
  → 发布目录变更事件；各上下文按 generation 对账
```

下载、解包、Schema 编译不能在长 IDB transaction 内等待。先生成候选快照，再通过 CAS 比较 expectedGeneration 提交；冲突则重新计算，不覆盖后来写入。一个提交应包含全部受影响贡献与依赖可用性变化，避免看到“工具新、智能体旧”的混合状态。

后台是唯一写入者；IDB 唯一索引是最终约束，内存 Map 或进程锁只是优化。worker 重启时从持久化活动指针恢复；未提交 staging 清理。消息通知可以丢失，因此页面启动、重连和收到更高代次时均可全量/增量对账。

### 7.2 版本处理矩阵

| 输入与已安装记录比较 | 处理 |
| --- | --- |
| pluginKey 不同 | 独立安装，不能覆盖 |
| pluginKey 相同、签名无效/签名者不符 | 拒绝，原插件保持原样 |
| 版本和包摘要均相同 | 幂等，无重复贡献 |
| 相同版本、不同包摘要 | 拒绝“同版本重发”；构建元数据也不能绕过 |
| 更高兼容版本 | 进入统一更新预览 |
| 低版本 | 默认拒绝；仅显式回滚已有可信版本，重新检查兼容/撤销/权限 |
| 不兼容宿主/依赖冲突/缺少必需引用 | 不切换旧版本；显示可诊断原因 |
| 新增权限/域名/远端工具或 Schema 变化 | 待授权，不继承旧授权扩大能力 |

采用 SemVer，稳定/预发布渠道分离，不能按字符串比较版本。v1 禁止 build metadata，简化同版本唯一性；同一版本的发布内容不可变。SemVer 能表达开发者意图，但不能证明兼容，仍需比较贡献接口、引用和依赖约束。[SemVer](https://semver.org/)

CLI 打包必须固定条目顺序、时间戳和压缩设置，生成可重复的包字节；正式发布后离线分发和在线下载复用同一附件。包摘要指整个 `.anplugin` 的 SHA-256，文件清单摘要用于包内验签，两者用途不同；不得因重新压缩内容相同就绕过同版本异摘要规则。

已禁用插件更新后保持禁用；已授权能力不变才可沿用授权。默认自动检查更新、手动安装；以后可允许用户启用兼容且不扩权的自动更新。

### 7.3 即时生效的精确定义

- 安装成功返回前后台已提交活动目录；已打开页面通过代次通知立即刷新，无需重载扩展。
- 新运行使用新版本。正在进行的运行固定 descriptor、Schema 和 releaseDigest，不在一次推理循环中偷偷换实现；更新后旧版本仅供已有运行租约使用，不再接受新租约。
- 对 MCP，租约只能固定客户端契约，不能固定服务端实现。远端 Schema 漂移则调用失败/降级；不能宣称远端服务具备与本地包同等可复现性。
- 禁用提交立即提高撤权 epoch；新调用和排队调用被网关拒绝。对进行中调用发送 AbortSignal、断开连接，晚到结果不再驱动后续动作。
- 无法撤销已发生的远端或浏览器副作用，不能用“取消成功”误导用户；显示已完成、已取消或结果未知。
- 插件智能体被禁用时阻止该智能体继续启动/运行，而不只是移除其自带工具；仅消费该插件工具的其他智能体移除受影响能力并提示。
- 禁用 Skill 后其历史文本无法从模型记忆中抹除，但关联能力必须撤权；下一轮重建发现清单/授权集合，必要时停止依赖它的运行。
- 卸载先撤权，再移除活动贡献；不依赖任意卸载脚本。后台清理连接、缓存、资源句柄、secret binding 和插件数据。默认删除插件专属凭据/数据；保留数据须用户显式选择并隔离保存。
- 用户智能体中的失效引用、历史会话保留完整身份和来源快照，UI 显示缺失，绝不重绑定到另一个同名插件。重装同身份可恢复引用，但已删除凭据/授权不自动恢复。

生命周期状态拆分：`desiredEnabled`、`installedRelease`、`effectiveStatus`（active/disabled/blocked/incompatible/quarantined/error）、`operationStatus`（idle/installing/updating/removing）。避免一个 enabled 布尔值混淆用户意图与实际可用性。

## 8. GitHub 搜索、下载与更新链路

推荐官方维护一个公开 `AgentNexus-Browse-Plugin-Registry` 仓库（与产品仓库同前缀，范围限于浏览器插件产品线），通过 PR 登记发布者/插件，GitHub Actions 校验并产出带签名、递增序号和有效期的目录快照。它不要求先建设专用市场后端。

目录记录包含 pluginKey、展示元数据、已验证 GitHub account/repository 数字 ID、release/tag/asset ID、包 SHA-256、兼容范围、渠道、签名者、撤销状态。目录签名公钥随宿主内置；不能用下载到的公钥验证它自己。缓存最高序号防重放；过期目录不用于静默新安装，已安装插件仍可离线使用。

产品流程：

1. 插件中心默认从官方目录本地搜索/分页，下载 README 展示前经过现有安全渲染。
2. “社区搜索”可选用 GitHub topic `agentnexus-plugin`；结果标未审核，不能假装官方认证，也不扫描执行仓库内容。
3. 支持粘贴 GitHub 仓库/Release URL；解析为 API 查得的 repo ID 和 release asset，不执行 README 提供的安装命令。
4. 下载发布附件 `.anplugin`，核对固定摘要和签名；不以 main 分支 ZIP 或 latest URL 作为不可变安装依据。
5. 保存来源和固定 release/asset/digest；更新按 SemVer 与兼容性筛选，不能直接相信 GitHub 的 latest 标记。
6. 本地导入同身份新版本进入同一更新管线；保留已有线上来源。包内 URL 只是建议，不能偷偷更换更新源。
7. 源迁移单独显式操作，校验发布者签名、仓库绑定和权限；新版本不得自行把源切到另一仓库或域名。
8. 离线安装的插件可以稍后绑定经验证的 GitHub 来源；身份和包验签规则保持一致。

GitHub Release API 支持下载资产及 SHA-256 digest，Immutable Releases 可锁定发布资产与标签。建议模板 Action 默认启用不可变发布；自算摘要并对比目录固定摘要，不能把 SHA-256 当作作者认证。[Release Assets](https://docs.github.com/en/rest/releases/assets)、[Immutable Releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)

未认证 GitHub REST 通常只有每小时 60 次且搜索限制更严，因此不能每次打开界面对所有插件逐个请求。目录缓存、ETag/条件请求、分批检查、退避与限速必须内置；403/429/离线只影响发现/更新，不影响已安装插件启动。GitHub token 可选，不随插件共享，也不发往重定向目标。[GitHub 限流](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

官方目录已按上述模式落地：`AgentNexus-Browse-Plugin-Registry` 仓库经 PR 登记、Actions 校验签名并发布目录快照到 GitHub Pages；目录 URL 与目录公钥内置在扩展（`utils/plugins/official-catalog.ts`），发现页默认走官方目录本地搜索，打开插件中心自动检查更新（6 小时节流、限流中止、仅提示不自动安装）。手填 URL/公钥保留为自托管「自定义目录源（高级）」入口。

## 9. 存储、依赖和用户修改

建议新增独立 IDB 数据库 `agentnexus-plugins`，先实现以下仓库接口：

| Store | 主键/职责 |
| --- | --- |
| publishers | publisherId、公钥、用户信任与可验证账号绑定 |
| packages | pluginKey、installed/active release、desiredEnabled、来源锁、撤权 epoch |
| releases | `(pluginKey, version)` 唯一；digest、原件、派生贡献与验证报告 |
| blobs | 内容摘要索引的资源；复用前核对摘要/长度，不以文件名覆盖 |
| grants | pluginKey 下的授权项、作用域、批准代次 |
| overlays | `(kind, resourceRef)` 的用户设置与 baseDigest |
| pluginData | `(pluginKey, key)` 隔离 KV，按插件配额 |
| operations | 幂等 requestId、状态、失败信息与回收依据 |
| catalogMeta | 全局 generation、schemaVersion、最新已验证目录序号 |

凭据存储另设宿主接口，不能直接把“加密”视为能防住同扩展特权代码；插件隔离来自无法执行特权代码与网关授权。

插件 agent/skill 原件在管理页只读；“复制为自定义”创建独立 user 身份。用户对插件智能体的工具选择等覆盖存在 overlays。更新后按 baseDigest 检查覆盖与删除项，保留并标记冲突，不覆盖用户修改，也不悄悄继承新权限。

依赖使用完整 pluginKey + SemVer range，必需/可选分开。v1 每身份一个活动版本，不加载两份同身份不同版本供不同消费者使用。解析器检查循环、有界图深度、全部反向依赖；不做复杂版本回溯，冲突就显示阻塞链。必需依赖缺失时不得激活；可选能力只影响相应贡献。

禁用/卸载有被依赖项时展示影响；强制操作将依赖者设为 blocked 并统一撤权，不级联删除用户配置。启用、禁用和升级都重新计算有效依赖图。

备份必须通过同一验证/安装管线恢复插件，不直接把备份数据灌入活动目录。默认不包含秘密和运行授权；恢复后重新授权。有旧版备份没有插件分区时按“未提供”处理，不清空本机插件。恢复保留同版本异摘要拒绝规则和失效引用。

## 10. UI 要求

插件中心提供发现、已安装、更新列表；每项显示名称、pluginId、发布者/身份指纹、验证状态、插件版本、来源仓库、权限、贡献数量、有效状态及阻塞原因。支持文件导入、URL 安装、启用禁用、卸载、更新检查、版本回滚和诊断导出。

智能体新建/编辑页在现有系统工具组下新增独立「外部插件工具」容器：按插件分组、可搜索、多选、展示完整引用、来源、发布者、插件版本和可用状态；禁用/缺失项仍能回显为不可用并允许取消。技能选择器提供同样的来源信息。不要把未知插件工具继续藏在 extraTools 数量提示中。

保存表单必须保留用户未主动删除的失效引用；否则用户只改一个名称也会丢掉插件配置。数量上限统一计算系统组与外部选择的并集。大量插件时搜索、虚拟列表和分页，避免一个组件同步渲染所有 Schema/Skill 正文。

更新预览显示旧/新版本、工具 Schema 变化、增删贡献、权限/网络目标变化、依赖影响及覆盖冲突。工具执行卡片和历史同时保留执行时来源/版本；更新后不能把旧执行显示成新版本。

## 11. 防御性工程要求

- 严格 Schema 校验；插件 manifest/贡献顶层未知字段报错，扩展字段仅允许 namespaced `extensions` 区。未知必需贡献类型拒绝，显式可选类型可保留但不激活。
- 包身份、版本、签名、引用非法时失败关闭，不沿用当前 agent 的宽容截断/重命名规则。
- ZIP 拒绝绝对路径、盘符、UNC、反斜杠、NUL、`..`、重复条目、大小写折叠重名、符号链接、嵌套压缩包和非规范 UTF-8 路径；目录虚拟化，不解压到任意真实磁盘路径。
- 路径按规范形式比较，禁止 URL percent 解码/Unicode 归一化产生第二种解释。JSON 拒绝重复键和原型污染危险键；动态索引使用 Map 或 null-prototype 对象。
- 流式下载/解包同时限制压缩字节、累计实际解压字节、单文件大小、条目数量、深度和时间；不能先 unzipSync 完成后才检查总量。CRC/中央目录大小仅作辅助，不能当可信限额。
- 初始建议：压缩 10 MiB、解压合计 30 MiB、500 文件、单文件 5 MiB、目录深度 12、每包 tools 100/skills 50/agents 50；固定常量和可诊断错误。最终按目标设备实测调整。
- 不以总安装插件数量保证性能；按目录分页、懒加载正文与 Schema、只加载所选工具。单请求工具数量/token 预算单独限制，超限要求用户收窄，不能静默少传工具。
- JSON Schema 限制字节数、深度、节点数，禁止远程 `$ref`；本地引用只能解析包内批准 Schema，限制递归/编译时间，过滤不支持的关键字并明确报错。
- 调用隔离：每插件并发数、超时、输入/输出体积、网络速率、数据配额；熔断故障服务，不阻塞其他插件；超时的非幂等工具不自动重试。
- 输出经过统一 ToolResult 验证与渲染净化，限制日志内容，外部 HTML/SVG 不直接成为扩展页代码。图标 v1 限制安全 raster 格式和像素数量。
- 资源删除按所有者和可达性回收，不按同名目录或分类批量删除；保留历史快照所需元数据，活动租约释放后才清理旧实现资源。
- 冲突/失败返回稳定错误码，例如 IDENTITY_MISMATCH、VERSION_CONTENT_CONFLICT、DEPENDENCY_BLOCKED、CAPABILITY_REVOKED、STALE_GENERATION；日志带 pluginKey/版本/operationId，脱敏凭据和用户数据。
- 防止并发安装、恢复备份和更新跨入口相互覆盖：操作幂等键、CAS、事务唯一索引和完整影响集验证共同保障，不能仅依靠 UI 按钮 disabled。

## 12. 实施顺序和完成标准

| 阶段 | 主要工作 | 可验收结果 |
| --- | --- | --- |
| P0 契约与基础改造 | 冻结 identity/ref/manifest/signature；代理协议名映射；agent ID 主键迁移；插件引用严格解析；宿主公共工具契约 | 原有自定义/预置配置迁移后行为一致；跨发布者同名资源能明确区分 |
| P1 插件内核与离线闭环 | IDB/唯一写入者/事务安装器/目录；Skill、agent、host-alias；启停卸载；外部工具容器 | 导入即注册，任意智能体可选择；本地新版本更新旧包；禁用后台立即拒绝调用 |
| P2 完整工具接入 | MCP 适配器、授权、Schema 漂移检测、执行网关覆盖所有入口 | 第三方服务工具可发现、选择和调用；受限策略无法通过代理或 Skill 绕过 |
| P3 GitHub 分发闭环 | 官方目录、签名快照、模板 Actions、社区/URL 入口、限流缓存、在线更新 | 搜索→下载→验签→安装→授权→使用→更新→禁用→卸载可完整演示 |
| P4 稳定性与开发者交付 | CLI/Schema/模板/规范；回滚、备份、故障注入、容量实测与接口扩展测试 | 第三方按模板可自行发布；升级失败与 worker 重启不留下半安装状态 |

P1 可作为内部里程碑，但 P0–P4 才构成本需求的完整交付，不能把 GitHub 搜索更新或后台撤权留作无期限待办。

新增目录建议：

```text
utils/plugins/{identity,refs,manifest,schemas,errors,dependency-graph}.ts
entrypoints/background/plugins/{service,repository,installer,catalog,execution-gateway}.ts
entrypoints/background/plugins/adapters/{host-alias,mcp}.ts
entrypoints/background/plugins/sources/{github,file}.ts
entrypoints/hub/plugins/PluginManager.vue
entrypoints/hub/agents/ExternalToolsPicker.vue
tests/plugins/
examples/plugins/{skill-agent,host-alias,mcp-tool}/
packages/plugin-sdk/   # Schema、CLI、打包签名与验证；实际目录可随构建约束调整
```

必须覆盖的验收测试：

1. 两发布者同 pluginId、同工具/Skill/agent 名，以及与内置/用户资源同名：互不覆盖、引用无歧义。
2. 同一包重复导入幂等；同版本异摘要拒绝；离线包与线上安装可互相更新，来源不被暗改。
3. 伪造 publisher、篡改 manifest/文件、重签为其他密钥、错误签名/目录重放不能更新旧插件。
4. 原子性故障注入：下载断线、配额不足、事务 abort、提交前后 worker 终止，重启只看到完整旧/新快照。
5. 两窗口并发安装/升级/卸载、备份恢复竞争：唯一索引和 CAS 阻止覆盖。
6. 开着智能体编辑器安装插件，无刷新可选；禁用、卸载后失效引用保留，重新编辑保存不丢失。
7. 会话运行中升级不换实现；禁用后排队/新调用被拒绝；晚到结果不触发后续动作；远端副作用状态如实报告。
8. runtime message、WebSocket、registry 直接执行均不能绕过授权；Skill allowed-tools/host-alias 不能扩权。
9. 所有模型协议的名称映射、历史重建、并发请求、动态 Skill 扩容正确；完整长 ID 不被截断。
10. ZIP 炸弹、重复路径/JSON 键、原型污染、恶意 Schema/远程引用、超大结果和路径穿越在预算内失败。
11. 依赖环、必需依赖禁用、升级破坏反向依赖、权限变化、MCP 工具清单/Schema 漂移都有可见诊断。
12. 断网、GitHub 限流、目录过期、服务故障、目录撤销状态不破坏其余插件；备份恢复不自动恢复执行授权。
13. 至少 500 个轻量插件、5,000 个目录贡献做性能基准，记录查询、启动、内存和 UI 延迟；验证懒加载与单请求预算，不预先宣称已达标。

落地时运行现有 compile/build 与相关 tools、skills、backup、channels、conversation-runtime、protocol-contract 测试；新增 tests/plugins 覆盖上述不变量。本次仅设计文档，没有运行测试，也没有声称验证过尚未实现的系统。

## 13. 兼容与后续扩展约定

旧裸工具 ID、agent.name、Skill name/id/modelId 的兼容只在迁移入口处理，进入新领域层后统一稳定引用。迁移保存原始数据和迁移版本，检测重名歧义并报告；不自动替用户选择插件。既有内置工具可先保留协议名，通过显式映射过渡，避免要求一次性重写全部工具实现。

贡献处理器接口建议为 `validate → resolve → describe → activate/dispose`，全部处理器随宿主发布；activate/dispose 是宿主资源管理接口，不是允许插件传入的可执行钩子。新增 kind 复用同一 pluginKey、release、grants、generation 和生命周期事务。

发布规范应提供：JSON Schema/编辑器补全、完整最小例子、CLI init/validate/pack、签名密钥备份说明、GitHub Action 模板、版本兼容表、错误码与变更日志。远程工具开发者直接沿用 MCP SDK；只做 Skill/agent 的开发者只写 JSON 和 Markdown。这样把安全复杂度集中在宿主和打包工具，减少第三方需要学习的自定义机制。
