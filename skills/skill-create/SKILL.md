---
name: skill-create
description: 当用户明确要求把实践经验创建为新 Skill 时加载：确定范围、组织可复用正文、整理并验证 resources 资源、调用 create；仅用于 AgentNexus 技能创作。
allowed-tools: skill_tool js_run
category: general
---

# 创建可复用 Skill

仅在用户明确要求创建或同意沉淀经验后执行。若用户只是完成常规任务，不代表授权创建。先确认目标网站、精准操作、URL 范围和排除范围；有实质歧义先问清。

## 组织内容

- name：网站名加精准操作，采用标准小写 kebab-case，例如 bilibili-export-video-comments。单一、清晰，不用泛化的万能名称；非网站内部工具按实际领域命名。
- description：写明什么时候使用、精准 URL（必要时说明路径和匹配范围）、输入对象与关键前提，例如登录状态、权限和支持的页面类型。只描述适用性，不解释实现。
- content：仅提交正文，不含 frontmatter。保持简洁，包含目标与范围、前提、可靠的数据/操作入口、可复用工作流、关键分支及失败停止条件、结果验证和交付方式。区分已验证经验与尚未验证假设，不把偶发失败提升为所有场景的铁律。
- 保留用户意图和权限边界。不得固化密码、Cookie、令牌、账号私密信息、临时 DOM 引用、过期截图 ID 或本次任务专用页码。

## 资源准备

先在当前会话工作区整理脚本、模板和参考文件。可用脚本优先复用同一个文件，通过 $args（JS）或 argv/env/stdin（Python，env 不放秘密）传入 URL、选择器、页码、范围、列配置等变化项；只有共享上下文与错误处理一致时才合并小脚本，不强行合并无关步骤。

用小样本或无副作用方式验证，再检查错误处理、重复执行与完成判据。技能资源禁止原地修改：已有技能的资源先 copy，再在工作区修订。

create.files 接受工作区文件路径字符串或 {path,destination}。默认目标为 resources/文件名；有同名文件或需要保留结构时显式给出 resources/ 下的精确目标。正文按这些目标路径索引，例如 resources/collect.js，并说明何时复制、如何传参和期待的结果。不要把资源全文重复塞进正文，也不要提交无关临时文件。

## 提交与核验

调用 skill_tool 的 create，传 name、description、content、必要 files，可按实际需要传 category、tags、compatibility、license、allowed_tools。不要猜测或指定 ID，成功结果会给出由系统分配的 skill_id，并自动关联调用智能体。

检查结果 ID、资源路径和关联对象；失败时按具体错误修复，不重复创建同一份技能。最终说明保存了什么、适用范围及 ID，不声称覆盖了未验证场景。
