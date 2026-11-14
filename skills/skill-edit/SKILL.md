---
name: skill-edit
description: 当用户明确授权修订现有 Skill 时加载：按 ID 核对现状，选择正文精准替换/原子批量修改/覆写，协调元数据与 resources 的增删替换并验证；仅用于 AgentNexus 技能修订。
allowed-tools: skill_tool js_run
category: general
---

# 修订现有 Skill

先取得用户对目标 Skill ID 和修订范围的明确授权。若目标、要保留的行为或资源改动有歧义先澄清。内置 ID 1..1000 不能编辑或删除；需要自己的变体时须按用户要求另行创建，不伪装成内置修订。

## 读取并制定最小改动

先 load/read 目标 skill_id，核对元数据、正文、资源清单与 updated_at。只根据本次实际验证的问题和用户要求改进，使技能更通用、可复用且准确；不要把本轮偶发状况固化为无条件限制。

元属性 name、description、compatibility、license、category、tags、allowed_tools：未提供、null、空字符串或空数组代表保持现值。名称和描述规则与创建技能一致，网站类描述应含适用场景与精准 URL，不写具体实现。需要清空某项时不要猜测空值语义，应明确说明当前接口不提供该操作。

## 正文编辑：三种模式互斥

1. 小改动优先 find + replace；find 为精确原文且须唯一命中。替换按字面处理，$ 等不解释。多命中时扩展上下文，确实要全部修改才传 replaceAll=true。
2. 多处关联修改用 edits:[{find,replace,replaceAll?,matchMode?},...]；按序作用于同一副本，任何失败整次不保存。复杂缩进可显式 matchMode=indentation，按完整行块匹配并保留目标缩进与换行；不依赖模糊匹配。
3. 大幅重组才提交 content 全文，仍只给正文，不带 frontmatter。content 与 find/replace、edits 不能同时提供。正文不能变成空内容。

提交最近读取的 expected_updated_at，若版本变化则重新读取并整合，不能用旧副本覆盖他人变更。

## 文件编辑：先复制、再准备、最后原子提交

用 copy 按技能相对路径把要使用的脚本/文件复制到工作区，使用返回的真实路径。严禁直接改技能原件。修订工作区副本、参数化并验证后，再传 files:[工作区路径] 或 {path,destination,replace:true}。

默认目标为 resources/文件名，显式 destination 也必须位于 resources/。新增与现有资源重名时，显式 replace=true，或同一次请求通过 remove_files:[旧技能相对路径] 删除后再添加；禁止删除 SKILL.md。删除、增加、替换资源与正文/元数据改动在同一保存中提交。移除文件时同步修订正文索引，保留仍在使用的资源。

提交 edit 后核对返回 ID 沿用、updated_at 增长及资源清单，按风险验证改动涉及的路径；不反复执行有副作用的生产操作。插件来源技能是本地托管副本，插件的新版本需要在插件管理的待批准更新入口中由用户审核，不能静默覆盖本地修订。

## 删除分支

仅在用户明确选择删除时调用 delete。存在的目标会弹出二次确认；拒绝、取消或版本变化时保留技能，按工具结果说明，不重复请求或绕过。不存在时如实报告未删除。
