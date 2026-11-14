---
name: xlsx-creator
description: 使用 xlsx_tool 生成 Excel (.xlsx) 文件：多工作表、合并单元格、公式、富文本、超链接、样式美化与自动列宽，并在聊天中输出可下载的文件卡片；批量抓取的数据可经工作区结果文件直接导出（create_from_data 的 dataFiles），数据表可与公式汇总表混排在同一个工作簿。当用户要求"生成/导出/制作 Excel 表格、把数据整理成 xlsx、导出报表/清单/统计表、把抓取结果落盘"时使用。
allowed-tools: xlsx_tool
category: content
tags: excel 表格 导出
---

# Excel 文件生成技能

## 目标

把用户给的表格数据、页面提取结果或你整理的内容，生成一个排版美观的 .xlsx 文件，并在聊天中交付为可下载的文件卡片。

## 核心规则

1. **工具只有 `xlsx_tool` 一个**，用 `action` 区分三种用法：
   - `create`：用声明式结构生成（支持多表、合并单元格、公式、样式等全部能力；也可用 `dataFiles`/`dataRef` 引用数据文件/暂存批次）；
   - `create_from_markdown`：把 Markdown 表格文本转成 xlsx（简单表格快捷路径，文本里多张 `|` 表格会变成多张工作表，`# 标题` 作为表名）；
   - `create_from_data`：批量数据导出入口——`sheets[].dataFiles` 引用工作区数据文件路径列表（js_run run/crawl 每次执行自动保存于 results/ 的结果文件、data_ref_tool 治理产物；跨浏览器重启持久）直接生成工作表，**批量数据一律走此路径，不要手写 rows 复现数据**；可与手写 `rows` 表（公式汇总、分组小计等）混排在同一次调用中；`sheets[].dataRef` 亦可引用 browser_network_capture 的暂存批次（浏览器会话内约 12 小时有效）。
2. **每张表的数据来源三选一**：`dataFiles`（工作区数据文件列表，按列表顺序拼接成一张表）、`dataRef`（暂存批次）与 `rows`（手写行）不能两两出现在同一张表，但不同表可以混用——这正是「批量数据表 + 公式汇总表」一次生成的方式。
3. **默认已自动美化**，不必手写这些样式：表头蓝底白字加粗居中、全表细边框、自动列宽（按内容自适应，中文按双宽估算）、有表头时自动冻结表头。可选项：`zebra: true` 斑马纹、`autoFilter: true` 表头筛选、`landscape: true` 横向打印、`tabColor` 标签色。
4. **文件名**：用户给了就用用户的（无需 `.xlsx` 后缀，会自动补）；没给就用「主题_YYYYMMDD.xlsx」。

## 何时选哪个 action

| 场景 | action |
|---|---|
| 简单二维表、用户贴了 Markdown 表格、或你只需把现有文本表格落盘 | `create_from_markdown` |
| 多张工作表 / 合并单元格 / 复杂表头 / 公式列 / 需要指定样式、列宽、行高 | `create` |
| 批量抓取的数据（有 results/ 结果文件或 dataRef 批次 ID）——含与公式汇总表混排 | `create_from_data` |

## create_from_data 的数据结构速查（批量抓取导出专用）

数据来自结果文件/暂存批次时**永远不要手抄数据行**——用引用直传，杜绝转抄丢失/捏造：

```
{
  "action": "create_from_data",
  "filename": "商品SKU_20261031",
  "sheets": [
    {
      "name": "SKU数据",
      "dataFiles": ["results/run-20261031-….json", "results/run-20261031-….json"],  // 结果文件路径列表（抓取工具响应里的 resultFile.path；多个按列表顺序拼接成一张表——可能重复先 data_ref_tool(action="dedupe", files=[...], by=[主键]) 一步完成拼接+去重；信封/复合数据先 action="project", file=路径)
      "fields": ["title", "price", "url"], // 可选：导出哪些列、什么顺序（缺省全部字段）
      "headers": ["商品名", "价格", "链接"], // 可选：表头文案（缺省用 fields）
      "zebra": true
    },
    {
      "name": "汇总",                      // 混排：手写 rows 表（与数据表分属不同工作表）
      "rows": [
        ["总行数", { "formula": "COUNTA(SKU数据!A2:A9999)" }],
        ["平均价格", { "formula": "AVERAGE(SKU数据!B2:B9999)", "numFmt": "0.00" }]
      ]
    }
  ]
}
```

- 对象数组数据用 `fields` 选列/定序（字段名拼写错误会被校验拒绝并提示实际字段）；二维数组数据可用 `headers` 定表头或 `firstRowAsHeader: true`。字段值若是嵌套对象/数组，会以 JSON 文本写入单元格——需要拆列请先用 `data_ref_tool(action="project", flatten=true)` 展平。
- `name/title/merges/columns/cells/freeze/autoFilter/zebra` 等样式选项与 `create` 完全一致；`cells` 可在数据区之外追加注释/落款。
- `create_from_data` 至少要有一个 `dataFiles` 或 `dataRef` 数据表（否则改用 `create`）；`fields` 只对数据表有效。
- 报错常见原因：数据文件不存在（用 js_run(action="list", path="results") 盘点）或不是数组（信封结构先 project）；dataRef 批次已过期；同一张表给了两种数据来源；行数超单表 5000 上限（分 sheet/分文件）。

## create 的数据结构速查

```
{
  "action": "create",
  "filename": "销售报表_20261030",
  "sheets": [{
    "name": "汇总",                     // 必填，≤31 字符，不含 : \ / ? * [ ]
    "title": "2026年10月销售汇总",       // 可选：跨全部列合并的大标题
    "headers": ["地区", "销售额", "环比"], // 表头（自动美化+冻结）
    "rows": [
      ["华东", 125000, 0.18],
      [{ "formula": "SUM(B2:B3)" }],     // 公式：不带等号（或带也兼容）
      [{ "richText": [{"text":"重点","bold":true},{"text":"客户"}] }],
      [{ "link": "https://example.com", "v": "打开链接" }],
      [{ "date": "2026-10-30" }],
      [123, { "v": 0.256, "numFmt": "0.00%" }]
    ],
    "cells": [{ "ref": "E2", "v": "备注", "style": { "fillColor": "#FFF3CD" } }],
    "merges": ["A1:C1"],                // 只允许区域内左上角带数据
    "columns": [{ "width": 20 }, { "numFmt": "#,##0" }],
    "zebra": true
  }]
}
```

- 单元格六种值形态**只能选一**：`v/value`（纯值）、`formula`、`richText`、`link`（配 `v` 作显示文字）、`date`。
- 颜色统一 `#RRGGBB` 或颜色名；对齐 `hAlign: left|center|right`、`vAlign: top|middle|bottom`。
- 复杂表头套路：第 1 行放 `title`，或用 `headers` + `merges`（如两级表头 `"A1:B1"`、`"A2:A3"` 合并后实现分组表头）。
- 单表时 `sheet`（对象）与 `sheets`（数组）二选一，同时提供会报错。
- 布尔开关（zebra/autoFilter/landscape 等）只接受 true/false，传字符串会报错。

## 生成成功后必须做的事（输出契约）

文件已保存到当前会话工作区 outputs/。按全局会话工作区规范交付工具返回的 file.marker（例如 `<workspace-file path="outputs/销售报表.xlsx" />`），不要使用旧的 fileId 标记。用一两句话说明工作表结构；如果结果带 warnings，向用户转述提示。

## 错误处理

- 工具失败**不会中断对话**，错误信息格式为 `参数不合法 → sheets[0].rows[3][2].style.fillColor: 无效颜色 "xyz"（支持 #RGB/#RRGGBB/...）`——**按报错里的路径和原因修正参数后重试**，最多重试 2 次。
- 常见错误：同一张表同时提供两种数据来源（rows/dataFiles/dataRef 三选一，分到不同工作表）；`create_from_data` 没有任何数据表；`fields` 出现在手写表上；`markdown` 与 `sheets` 参数跨 action 误传（各属于自己的 action）；对象数组数据传 `firstRowAsHeader`（其自动生成表头）；merge 区域内非左上角含数据；工作表名超 31 字符或含 `: \ / ? * [ ]`；单元格同时给了两种值形态；行数超过 5000。
- 重试仍失败：向用户说明具体原因，并给出你已经整理好的数据（Markdown 表格），不要静默放弃。

## 容量限制

单文件 ≤16 张工作表、单表 ≤5000 行、总单元格 ≤50000、单表 ≤200 处合并。导出前先估算：**50000 ÷ 导出列数 = 单文件行数上限**（如 8 列 ≈ 6250 行，实际还受单表 5000 行约束）——预计超限时先与用户确认拆分方案（如按月份拆多表），不要撞报错再拆。

## 边界情况

- 用户只说"导出"没给内容：先从当前对话/页面数据整理出表格再生成，不要生成空文件。
- 数据来自批量抓取（results/ 结果文件或 dataRef 批次）：一律用 `create_from_data` 直接引用导出，禁止把数据行抄进参数；多个结果文件按序合成一个——可能重复时用 `data_ref_tool(action="dedupe", files=[...])` 拼接+去重一步完成（无重复时直接 `action="merge", files=[...]`，或不预先合并把路径列表直接放进 dataFiles）；信封包装的响应或「一格两表」的复合数据先 `data_ref_tool(action="project")` 投影为关系表（path 指向对象/数组，carry 携带父键列）。
- 用户要求 CSV：本技能只做 xlsx；可先说明并生成 xlsx，或按用户坚持提供 Markdown 表格文本。
