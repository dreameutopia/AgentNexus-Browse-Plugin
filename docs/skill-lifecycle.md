# Skill 生命周期与会话工作区

`skill_tool` 与 `plan_tool`、`js_run` 一样是全局会话工具。发现目录只包含 ID 与场景描述；命中任务场景时先加载正文，再按需读取或复制资源。全局生命周期提示词集中在 `tools/skill/skill-prompt.ts`，不在各智能体重复维护。

## 身份与保护

- 所有工具定位参数仅为 `skill_id`，取十进制字符串。名称不参与查询，同名技能可以共存。
- `utils/skills/skill-identity.ts` 是内置映射的唯一来源：1 为 Bilibili 摘要，2 为网络调研报告，3 为 Excel 创建，4 为 `skill-create`，5 为 `skill-edit`。
- 1–1000 全部保留，禁止编辑和删除；4、5 始终全局可发现，不能停用。
- 自建、导入及插件托管技能通过独立 IndexedDB 事务分配从 1001 开始的唯一 ID，删除后不复用。
- 只接受当前数字 ID 与身份键格式，旧名称、组合标识和旧 ID 直接丢弃，不提供迁移或名称回退。

## 操作契约

| action | 行为 |
| --- | --- |
| `load` | 按 ID 分页加载正文及资源目录，返回 `updated_at` |
| `read` | 按技能相对路径分页读取文本；二进制先复制 |
| `copy` | 精确选择文件、目录或 `.`；按原字节复制到当前会话工作区，完全不依赖 Python |
| `create` | 用户明确要求后先加载 ID 4，提交名称、场景描述、正文、可选元数据及工作区文件列表；自动关联当前运行实际生效的智能体 ID |
| `edit` | 用户明确要求后先加载 ID 5；支持全文覆写、唯一精准替换或有序批量替换，以及资源增删；一次原子保存 |
| `delete` | 存在的非内置技能必须通过 interact UI 二次确认；拒绝、取消、无 UI 或版本变化均保留并返回结果 |

创建示例：

```json
{"action":"create","name":"example-report-export","description":"用于导出 https://example.com/reports 上已登录账户的月报。","content":"先将 resources/export.js 复制到工作区，再通过 js_run 动态传入月份执行。验证导出内容与页面筛选一致。","files":[{"path":"scripts/export.js","destination":"resources/export.js"}]}
```

资源默认保存到 `resources/源文件名`；指定目标也必须位于 `resources/`。编辑已有资源需要显式 `replace:true` 或同次 `remove_files`。元属性为空表示保持原值；正文不能变成空技能。`content`、单个 `find/replace` 与 `edits` 三种修改方式互斥；替换共用脚本工具的精确匹配及缩进匹配引擎。资源先在工作区完成修改与验证，再提交，禁止直接修改 Skill 原件。

编辑和删除可传 `expected_updated_at`。工具即使未显式收到该值，也以读取到的版本约束编辑及确认后的删除，避免等待交互期间覆盖并发修改。持久化失败返回失败并恢复内存中的原记录。

复制保留技能相对目录；如果目标已存在，则使用 `<skill_id>/相对路径`，再次冲突时使用 `<skill_id>/copy-2/相对路径` 等新目录。必须使用工具返回的实际路径，不能猜测位置。Python 通过 `cwd` 指定复制目录，完整 Skill 副本也可通过 `SKILL.md` 自动识别项目根。交付物仍统一写入 `outputs/`，回复使用 `<workspace-file path="outputs/report.xlsx" />` 展示下载卡片。

## 插件更新

插件贡献的 Skill 首次安装即复制到本地技能库，拥有全局数字 ID 和插件来源信息，可在用户授权后修改或删除。本地经验不会因为插件刷新或升级自动被覆盖。

同一 Skill 的上游内容变化，以及已安装插件在升级时增加的 Skill，进入插件管理页的“待批准的插件 Skill 更新”入口。审阅界面展示当前版本、上游版本和资源差异；批准同时校验上游摘要及审阅时的本地版本，变化后必须重新审阅。插件下线或删除某个上游 Skill 不自动删除本地经验。已手动删除的本地 Skill 不会因重复刷新相同插件版本自动复活。

备份中的 Skill 分区同时携带内置启停状态、自动关联、插件待批准更新和沉淀提醒偏好；恢复时同批提交，并提供回滚。Skill 只存于 chrome.storage 权威源，不建立 localStorage 镜像；版本号用于按需恢复，读取不会改变 updated_at。插件更新入口只读取摘要，审阅时按目标加载正文与资源差异。

## 主动沉淀

模型完成超过 15 轮的长任务后，依据全局规范询问是否沉淀；没有用户主动要求或明确同意时，禁止调用 create。修订或删除实际验证存在问题的技能同样先说明 ID、问题和证据并取得用户决定。

消息操作栏的复制按钮右侧提供 Skill SVG 入口。当前用户任务超过 20 轮工具批次，或会话超过 40 轮时，在最后一条已正常结束的模型消息下显示沉淀提示。并行工具调用计作同一轮，历史无轮次数记录时按已有工具调用数回退估计；停止/失败/输出进行中不触发。新的用户消息会让旧提示消失。

确认入口会再次弹窗，允许输入补充要求；确认后通过现有发送链路发送用户可见的中英文请求。不会使用或清空正在编辑的输入草稿、附件及页面引用。永久隐藏提醒需要二次确认，写入扩展持久存储；消息工具栏的手动入口始终保留。

## 验证

- `npm run test:skills`：数字 ID、并发分配、内置保护、编辑原子性、资源复制、删除确认、插件托管与更新、提醒阈值，以及实际 Pyodide 脚本执行。
- `node tests/chat-ui/skill-capture.test.mjs`：实际 Vue 组件确认、补充要求、取消、永久隐藏、保存失败及手动入口。
- `npm run test:plugins`、`npm run test:plugins:ui`、`npm run test:chat-ui`：现有插件和消息链路回归。

设计参考：Agent Skills 的 [最佳实践](https://github.com/agentskills/agentskills/blob/main/docs/skill-creation/best-practices.mdx) 与 [描述优化](https://github.com/agentskills/agentskills/blob/main/docs/skill-creation/optimizing-descriptions.mdx)。
