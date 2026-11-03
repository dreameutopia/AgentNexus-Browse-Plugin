---
name: web-research-report
description: 围绕一个主题进行多来源网络调研，交叉验证后产出带引用来源的结构化研究报告。当用户要求"调研/研究/深入分析某主题、对比多个方案、给出有出处的报告"时使用。
allowed-tools: browser_navigate browser_get_page_text browser_get_page_info bing_search baidu_search zhihu_search csdn_search github_search note_tool
category: search
tags: 调研报告 引用来源 多平台
---

# 网络调研报告技能

## 目标

针对用户给定的主题，完成一次多来源、可追溯的网络调研，并输出结构化研究报告。

## 工作流程

1. **拆解问题**：把主题拆成 3~5 个具体的子问题。用 `note_tool(action="create")` 建调研笔记并记录原始需求与计划（返回的 noteId 后续全程使用；忘记时用 `note_tool(action="list")` 找回）。
2. **多源检索**：优先使用各站搜索工具（`bing_search` / `baidu_search` / `zhihu_search` / `csdn_search` / `github_search`）检索子问题关键词；搜索后如需读取结果页面，用 `browser_navigate` 打开具体链接，再用 `browser_get_page_text` 提取正文。
3. **交叉验证**：同一关键结论至少找到两个独立来源；来源之间冲突时明确记录分歧，不要擅自裁决。
4. **过程留痕**：每读完一个有价值的页面，立即用 `note_tool(action="append")` 记录：来源 URL、核心观点、对你的子问题的回答程度。
5. **汇总产出**：调用 `note_tool(action="get")` 回顾全部笔记，然后输出报告。

## 报告格式

- **结论摘要**：3 句以内回答用户的核心问题。
- **分主题发现**：按子问题组织，每个结论后标注 `[来源: 域名]`。
- **分歧与不确定**：列出未能在多来源交叉验证的结论。
- **参考链接列表**：去重后的全部来源 URL。

## 边界情况

- 搜索结果全部无关时，更换关键词重试一轮；仍失败则如实说明并给出已尝试的关键词。
- 页面需要登录才能看正文时，记录"该来源不可读"，不要臆测内容。
- 笔记过长时可用 `note_tool(action="update")` 压缩重写（先 `action="get"` 备份要点再重写）。
- noteId 只能来自 create/list 的返回值，禁止臆造。
