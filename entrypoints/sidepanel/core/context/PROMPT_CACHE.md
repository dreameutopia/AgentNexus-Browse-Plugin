# 模型历史与提示缓存

## 不变量

- `content / parts / toolCalls` 是 UI 转录，不能用其拼接结果替代新记录的模型历史。
- `modelMessages` 保留原始用户输入（含附件、一次性时间戳和首截图）、技能激活轮、每轮助手消息、工具结果及视觉续拍消息。新用户输入只追加在历史之后。
- `nativeReplay` 保留提供商的原生输出顺序与推理续接状态：Responses output items/encrypted reasoning、Claude thinking/signature/redacted blocks、Gemini 全部 parts（含空文本签名块）、OpenAI 兼容 reasoning_content、Ollama thinking。仅原协议、模型和端点可回放这些 opaque 状态，不把其内部封装直接发送到其他协议。
- 原生状态也与凭据指纹隔离，避免同一网关 URL/模型名下换账号后回放账户绑定签名；不把密钥写入消息、诊断或日志。常规缓存路由 key 不包含凭据。
- 新版 Claude thinking 还绑定完整前缀：每次输出保存输入前缀指纹，按一次线性扫描核验，避免逐块重复扫描长截图历史。压缩或显式配置更新使旧绑定失效时，仅在发送副本中移除失效 thinking/redacted blocks，普通文本和工具结果保留，原始记录不修改。中断恢复保留已完成的原生块及可见的部分正文，未完成的工具参数不伪造成已完成调用。
- 图片以 `agentnexus-image:<内容哈希>` 存储，发送前恢复原始字节及 detail；该内部 URI 不得发送给模型。图片引用同时进入数据库引用索引，不能只按 UI 的 64 张图片上限回收。
- 图片解码使用每条记录的快照，不依赖全局 128 项 LRU 同时命中。缺图保留其余消息，并明确标注缺失证据。
- `modelPartial` 是当前未完成流的检查点。中断后的工具调用必须配失败/未完成结果，不能伪造成功；完成轮次原文不因错误卡片或 UI 格式清洗而改写。
- 数据库写入失败时，当前进程保留该消息快照，后续读取合并未落库记录，不从旧数据库快照悄悄重建更短历史。写入有独立纪元，迟到的旧写失败不会覆盖新成功状态。存储故障仍通过既有通知报告；关闭进程前未能持久化的数据不承诺永久保存。
- 真正压缩后保存 `modelContext` 检查点，下一次发送继续压缩后的有效历史；完整 `modelMessages` 保留用于审计，不在重载时反向展开已压缩历史。摘要时间使用稳定 ISO 格式，旧摘要缺时间时不生成新的当前时间。
- 合成技能调用 ID 在运行内生成一次并持久化，跨运行不能重用相同 ID。
- 同一配置下工具目录排序稳定；可用技能的工具预先声明，但执行仍受基础工具与已加载技能授权检查。视觉助手的观察白名单同时约束目录及执行。
- 每次运行固定工具 schema 快照，计量与发送使用同一快照；运行中注册表变化不能改写已发送的定义。
- 发现清单不因预选技能变化而删除条目；激活正文追加在本轮输入之后。
- 窗口守卫内部排序字段不得进入 token 计量。窗口能容纳时，模型工具结果不受 UI 的 8KB 限制。未发生压缩却检测到既有历史变化时停止本次请求并保留记录；超窗且压缩未成功时，不发送删掉历史的请求。
- 旧记录没有协议快照时继续兼容重建，不虚构无法恢复的截图或中间轮次。新版本不能追溯修复过去未保存的信息。

## 视觉安全与上下文容量

历史截图可用于理解过去的操作和结果；只有最新且通过文档、标签页、几何及会话校验的截图才允许坐标操作。历史持久化不延长截图的操作有效期。

自动视觉续拍通过 `toolFeedbackFor` 标识为客户端工具反馈。Claude 将这些文字和图片放进对应 tool_result 的 content，而不把自动“继续”当作新的人类任务；原始用户输入不带此标识。该路由字段不发送给其他协议，不改变既有内容块。

达到上下文预算后，仍按既有阈值压缩/窗口保护；压缩是允许改变历史前缀的明确边界，完整 UI 转录及协议记录仍保留。没有通过删除截图、降低图片 detail 或删减附件来制造高命中率。

普通文本循环也能接收工具返回的多模态截图，单批图片不再只保留最后四张；刷新后的视口追加在工具原始证据之后。压缩器看到实际图片，而不是只有“附图”占位。压缩负载过大时按原始顺序分段并归并摘要，最多 3 层、16 次模型请求；无法完整处理时保留原记录并报错，不故意漏掉最早记录。LLM 摘要本身是有损语义压缩，原始证据始终保留，不承诺数学意义的无损摘要。

## 协议策略

| 协议 | 行为 |
| --- | --- |
| OpenAI Chat Completions / Responses | 保留完整前缀与原生输出 items；Responses 保留原始消息边界并请求 encrypted reasoning。仅官方端点使用稳定 `prompt_cache_key`。网关明确拒参时有定向降级，不改写输入历史。 |
| Claude Messages | system 固定断点、先前轮次断点、当前轮次断点及顶层自动缓存，使用默认 ephemeral TTL。旧网关明确拒绝顶层字段时保留块断点；连块断点也拒绝才关闭指令并告警。 |
| Gemini generateContent | 保留原生 parts 顺序和签名边界，包括工具、文本以及空文本签名；只有无签名的文本流增量可以合并。 |
| DeepSeek 等 OpenAI 兼容渠道 | 保持标准请求，利用渠道自动缓存；标准 cached_tokens 与 DeepSeek hit_tokens 字段均支持。 |
| Ollama | 保留 thinking；done=true 行仍先处理正文和工具，避免终止块内容丢失。未上报缓存字段显示未知，不推断为零命中。 |

不强制启用更高写入费用的延长 TTL，也不创建 Gemini 显式缓存对象（涉及额外生命周期、费用和模型能力差异）。十分钟等待、服务端逐出、最低缓存长度或渠道路由变化可能使缓存过期；客户端不能保证一个固定命中率。

官方依据（2026-11-03 核对）：

- https://developers.openai.com/api/docs/guides/prompt-caching
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://ai.google.dev/gemini-api/docs/caching
- https://api-docs.deepseek.com/guides/kv_cache/
- https://api-docs.deepseek.com/guides/thinking_mode/
- https://developers.openai.com/api/docs/guides/reasoning
- https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
- https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything

与 Claude Code 的做法一致：固定前部工具和基础指令，增量更新放入后续消息，避免为了切换阶段频繁改变工具集合。切换模型、端点、智能体配置或代码版本是显式配置边界；不能为了缓存而忽略用户的新配置。Claude/Gemini 要求连续同角色消息合并时，只在最后一个 turn 追加 parts/blocks；已有块不改写。缓存断点属于传输元数据，可以移动，不作为模型提示正文。

## 统计

总账保留；模型维度按协议 + channelId + modelId 隔离，避免相同 wire model 的不同渠道混账。额外按渠道/模型/智能体/请求类别聚合。最近 100 条记录包含 runId、轮次、usage、前缀共同消息数和压缩/裁剪标记，不保存提示正文、页面或密钥。

- 输入 Token 缓存占比 = 缓存输入 token / 同时上报输入与缓存信息的输入 token。
- 请求命中比例 = 缓存 token > 0 的请求数 / 有完整缓存报告的请求数。
- 后续轮次缓存占比仅统计同一运行第 2 轮起的聊天请求；摘要压缩独立分类。
- 未上报与零命中严格区分。v1 总账迁移保留，新维度不猜测旧请求的渠道/智能体；旧账没有请求命中分布，因此不参与新增的请求级比例。
- “前缀稳定”是客户端消息级诊断，不承诺服务商隐藏提示、路由或实际 KV 缓存命中。

## 验证

`npm run test:tools` 包含真实 ConversationEngine 的视觉多轮、重载及下一次发送的前缀比较，附件/图片/技能轮次保留、150 张图片引用、缺图/损坏记录/中断配对、统计隔离与 v1 迁移。

`npm run test:contract` 检查协议请求、usage 与兼容降级；`npm run test:image-context` 包含无裁剪时 token 数一致的回归断言；`npm run test:chat-ui` 覆盖实际 Vue 组件初始化。

`tests/protocol-contract/native-cache.test.ts` 模拟五种协议 × 文本/视觉，每种 3 轮工具调用，检查最终请求体的既有消息/块前缀、原生推理状态、JSON 重载和跨端点隔离。核心引擎集成回归还覆盖文本截图、6 张图片完整传递、大于 8KB 的工具结果、schema 变化隔离、意外历史变化拦截，以及包含实际图片的分段压缩。测试不访问真实付费模型，不将客户端稳定性等同于服务商命中率。
