/**
 * plan 固定注入契约（系统提示词分区 + 默认工具 ID）
 *
 * 与 tools/interact/interact-prompt.ts 同构的「固定 prompt + 默认工具」
 * 单一事实源：
 *   - PLAN_SYSTEM_PROMPT_SECTION：无条件注入所有会话的系统提示词分区
 *     （runtime-builder 装配，位于交互准则分区之后）；
 *   - PLAN_TOOL_ID：无条件并入所有会话工具集的工具 ID（任何智能体不可裁剪）。
 *
 * 文案对齐 plan-tool.ts 的实际行为（create 整体替换、failed 必填原因等），
 * 与 note_tool 的分工（执行状态 vs 知识沉淀）在两处工具描述中互相呼应。
 */

/** 无条件注入会话的计划工具 ID（runtime-builder 装配） */
export const PLAN_TOOL_ID = 'plan_tool' as const;

/**
 * 固定系统提示词分区：任务计划准则。
 *
 * 设计要点（对齐 Claude Code TodoWrite / Task 工具的官方实践）：
 *   - 3 步及以上的多步任务才建计划，简单请求不建（避免噪音）；
 *   - 状态生命周期 pending → in_progress → done/failed，完成一项标一项，
 *     不允许提前标记或事后批量补标；
 *   - 失败必须记录原因（message 必填由工具层硬校验，此处预告保持一致）；
 *   - create 是整体替换（旧状态丢失）：优先用 add/edit/delete 演进计划；
 *   - 与 note_tool 分工：计划记「执行状态」，笔记记「知识与证据」。
 */
export const PLAN_SYSTEM_PROMPT_SECTION = `<task-plan-guidelines>
任务计划准则（全局固定注入）——plan_tool 管理当前会话的任务计划（步骤清单 + 执行状态），帮助你在长难任务中保持方向、不漏步骤：

何时建立计划：
- 任务可拆为 3 个及以上明确步骤，或是多阶段长难任务（多站点调研、多轮操作与验证、用户列出多项要求）时，动手前先用 action=create 建立计划；
- 单步请求、简单问答、闲聊不要建计划（噪音大于价值）。

计划生命周期：
1. create：建立初始步骤清单。每个会话只有一份计划；再次 create 会整体替换既有计划并丢失全部已记录状态，仅在确实需要推翻重来时使用；
2. add：执行中发现新步骤时追加条目，不要为加一步而推翻重建；
3. edit：开始执行某项时标 status="in_progress"；成功完成标 status="done"（message 简要写明成果或关键产出）；失败标 status="failed" 且 message 必填（写清失败原因与已尝试的办法）；需要重做的项可改回 "pending"（改状态时不带 message，旧标注会自动作废）。标注跟随状态：每条 message 描述的都是当前状态，重做成功后不要沿用旧的失败原因；
4. delete：随任务推进失去意义的条目（如被证实不需要的步骤）及时删除；
5. read：不确定剩余步骤或状态时随时读取全量计划（含每项 id、状态与标注信息），以读到的为准继续执行，不要凭记忆推断。

使用纪律：
- 状态即时更新：完成一项标一项；严禁提前标记尚未执行的项，也不许全部做完再批量补标；
- 步骤粒度合适：一项对应一个可独立验证的阶段性成果（如「检索三个平台并汇总有效来源」），不要把单次工具调用当作一步；
- id 纪律：所有 edit/delete 只使用 create/add/read 返回的真实 id，禁止臆造。
</task-plan-guidelines>`;
