# 备份与存储统计引擎

管理中心（`entrypoints/hub`）「备份与恢复」分区的数据引擎：负责**统计本插件的本地占用**，
以及**导出 / 导入全部配置与数据**。零 Vue 依赖，可单测。

## 模块分层

| 模块 | 职责 | 依赖 |
| --- | --- | --- |
| `bytes.ts` | 纯字节工具：UTF-8 计量、格式化、base64、任意值体积估算 | 无 |
| `ports.ts` | 存储端口：`chrome.storage.local` / `localStorage` / `IndexedDB` 的最小封装 | `config/types` |
| `storage-keys.ts` | **键名单一事实源**：备份分区与统计分类引用同一批键名 | `types` |
| `types.ts` | 类型与契约：文件格式、分区处理器契约、占用报告结构 | `config/engine`、`@/utils/i18n` |
| `format.ts` | 备份文件格式：校验和、序列化、解析（v1 / v2 统一入口） | `config/backup` |
| `sections.ts` | **数据分区处理器注册表**（10 个分区） | 各存储宿主模块 |
| `engine.ts` | 编排器：导出（全量采集）/ 导入（全量校验 → 写入 → 回滚） | `sections`、`format` |
| `storage-stats.ts` | 存储占用统计引擎（分类明细 + 子项 + 口径说明） | 各存储宿主模块 |

消费方只需从 `index.ts` 导入。

## 备份文件格式

```
{ format: 'agentnexus.backup', version: 2, appVersion, exportedAt,
  sections: { <id>: { schema, rev, updatedAt, data } },
  checksum }
```

- **v1**（历史格式）：仅 6 个配置分区，解析器仍然接受（按文件自带 version 复核校验和）。
- **v2**：6 个配置分区 + 10 个数据分区。
- 校验和公式与 `config/backup.ts` 完全一致（`checksumOf({format, version, sections})`），
  因此 v1 / v2 文件同一解析器互通，未知分区仅告警并跳过（前向兼容）。

### 分区清单

| 分区 | 内容 | 存储面 |
| --- | --- | --- |
| `channels` `appSettings` `asrConfig` `systemSettings` `locale` `workflows` | 配置域（配置引擎） | chrome + localStorage |
| `skills` | 自定义技能 + 预置技能启停覆盖 | chrome + localStorage 镜像 |
| `agents` | 自定义智能体 | chrome + localStorage 镜像 |
| `plans` | 会话任务计划 | chrome + localStorage 镜像 |
| `files` | 托管文件 | chrome |
| `metrics` | AI 用量统计 | chrome |
| `misc` | 深搜开关 / 拦截状态 / 任务队列 / 主题 | chrome + localStorage |
| `images` | 图片（Blob → base64），**受「包含多媒体」门控** | IndexedDB |
| `notes` | 笔记与剪藏页面 | IndexedDB |
| `conversations` | 会话元信息 + 消息记录 | IndexedDB |
| `capturedFiles` | 捕获文件（Blob → base64），**受「包含多媒体」门控** | IndexedDB |

## 分区处理器契约

每个数据分区实现 `SectionHandler`：

1. `collect()` — 导出采集；返回 `null` 表示无数据（该分区不进备份文件）。
2. `validate(data)` — **纯函数**结构校验，不得有副作用、不得抛错。
3. `apply(data, strategy)` — 按策略写入。

### 防御性约定

- **全量校验后零写入**：编排器先校验**所有**分区，任一失败即整体拒绝，不写一个字节。
- **分区原子**：分区写失败时先用写前快照还原自身，再把错误抛给编排器；
  编排器负责逆序回滚**其它**已写分区（回滚闭包）。
- **写入走宿主模块 API**：会话 / 图片 / 笔记 / 捕获文件的恢复一律调用其宿主模块的
  原子恢复方法（单事务），保住「唯一索引」「计数不变量」「缓存失效」等约束。
- **收集失败不吞**：采集异常由编排器记入 `issues` 并跳过该分区，
  绝不返回「空数组」冒充「没有数据」。
- **键白名单**：备份文件是外部输入，杂项分区只接受白名单内的键。

### 导入策略

- `replace` — 覆盖导入：以备份为准（本机对应分区被整表替换）。
- `fill` — 补充导入：本机已有数据则跳过该分区，已有值一律保留。

## 存储占用统计

### 三个存储面分别计量

`chrome.storage.local` / `localStorage` / `IndexedDB` **分别**计量、分别对账，
最后合并到分类上。若把三个面的字节混在一个桶里再对账，「本地镜像键」与
「chrome 权威键」会互相污染，导致对账差额失真。

### 分类互斥，合计不缺数

13 个固定分类：对话数据 / 图片 / 笔记 / 捕获文件 / 技能 / 智能体 / 会话计划 /
托管文件 / 用量统计 / 杂项 / 配置 / Python 运行时 / 其他。

- 每个字节**只归属一个分类**；未被任何分类认领的键归入「其他」。
- **分类合计恒等于总占用**：与浏览器权威总量（`getBytesInUse(null)`）的差额
  并入「其他」，并在 `issues` 中说明。
- **「统计为 0」与「统计失败」严格区分**：读不到用 `-1` 表示，UI 显示「—」。

### 两套口径，不互相相加

- **分类（所有权视图）**：字节归谁存放。
- **对话媒体构成（归属视图）**：多媒体按「被哪个会话引用」归属到会话。

两者口径不同，故媒体构成单独呈现，**不参与总计求和**。

### 条目数 vs 字节数

- 字节数是**物理占用**：chrome 与 localStorage 各存一份就各算一份。
- 条目数是**逻辑条目**：5 个技能就是 5 项，不是 10 项（镜像键不重复计数）。

## 测试

```bash
npm run test:backup      # node tests/backup/run.mjs
```

覆盖：格式解析（v1/v2、校验和、未来版本、未知分区）、分区处理器
（采集 / 校验 / 双写 / fill 跳过 / 写入失败时状态不变）、编排器
（非法分区零写入、跨分区失败回滚）、存储统计（未分类键归「其他」、
分类合计恒等于合计、失败报 `-1`）。
