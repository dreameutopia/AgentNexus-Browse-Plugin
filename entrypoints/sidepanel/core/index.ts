/**
 * 核心引擎层统一出口
 *
 * 五引擎分工（详见各模块头注释）：
 *   registry/     智能体引擎、技能引擎（管理 + 解析，相互独立）
 *   context/      转录引擎（用户面，IndexedDB 无长度限制）、AI 上下文引擎（窗口化派生）
 *   runtime/      运行时装配（systemPrompt XML 分区 + 工具去重 + 模型配置 + 初始上下文 + 合成激活轮）
 *   conversation/ 会话引擎（驱动循环，事件输出，写转录；对 agent/skill 零感知）
 *   tools/        工具执行引擎（工具执行的唯一通道：强制串行 / 强制中断 /
 *                 有界超时 / 轮次闸门——会话引擎只做编排与上下文写入）
 *
 * 使用流程：
 *   transcriptEngine.createSession() → runtimeBuilder.build() → conversationEngine.run(runtime, { observer })
 *
 * 引擎层零 Vue 依赖；App 层通过 observer 事件驱动 UI、通过 onChange 感知注册表变更。
 */

export {
  agentEngine,
  DEFAULT_AGENT_SYSTEM_PROMPT,
  DEFAULT_SESSION_AGENT_ID,
} from './registry/agent-engine';
export { skillEngine, SKILL_TOOL_IDS } from './registry/skill-engine';
export type { ActivationRound } from './registry/skill-engine';
// 智能体领域类型（供 UI 构建选择器/分组视图；具体读写一律经 agentEngine 门面）
export type { AgentConfig, AgentCategoryGroup, AgentDisplayText } from '@/utils/agents/agent-types';
// 头像解析（图片地址 → 可渲染 src；缺省 → 默认 emoji）
export {
  DEFAULT_AGENT_AVATAR,
  resolveAgentAvatar,
  resolveAvatarImageSrc,
  isImageAvatar,
  type AgentAvatar,
} from '@/utils/agents/agent-avatar';
export { chatDatabase, mergeMessagePatch, buildMatchSnippet } from './context/chat-database';
export type { SessionListOptions, SessionListScope, MessagesPage } from './context/chat-database';
export { transcriptEngine } from './context/transcript-engine';
export type {
  CreateSessionInput,
  EffectiveContext,
  FeedbackWriteResult,
  PersistenceIssue,
} from './context/transcript-engine';
// 会话删除的唯一编排入口（转录 + 图片按引用回收 + 计划墓碑 + 运行中止 + 孤儿兜底）
export { sessionDeletionEngine } from './context/session-deletion-engine';
export type { SessionDeleteResult } from './context/session-deletion-engine';
export { contextEngine } from './context/context-engine';
export { contextCompactor, CompactionError } from './context/compactor';
export type { CompactionInput, CompactionResult } from './context/compactor';
export {
  measureContextUsage,
  COMPACTION_PRE_RUN_RATIO,
  COMPACTION_RUNTIME_RATIO,
} from './context/context-meter';
export { runtimeBuilder } from './runtime/runtime-builder';
export type { RuntimeBuildInput } from './runtime/runtime-builder';
// 图片库门面（UI 渲染层用 object URL 展示、用 meta 生成下载文件名；
// 二进制与缓存细节全部封装在 image-store 内，调用方只见引用）
export { imageStore, isImageRef, normalizeImageRefs, SHORT_ID_PATTERN } from './images/image-store';
export type { ImageRef } from './images/image-store';
export {
  conversationEngine,
  composeLlmUserMessage,
  ChatBusyError,
  EmptyRunInputError,
} from './conversation/conversation-engine';
export type {
  ConversationDeps,
  RunOptions,
  GuardKind,
  ToolApprovalRequest,
} from './conversation/conversation-engine';
// 工具执行引擎（工具执行的**唯一通道**：强制串行 / 强制中断 / 有界超时 /
// 轮次闸门。会话引擎只做编排与上下文写入，执行与结算一律经由它。）
export {
  toolExecutionEngine,
  ToolExecutionEngine,
  TOOL_INTERRUPTED_BY_USER,
  describeToolFailure,
} from './tools/tool-execution-engine';
export type {
  ToolBatchOptions,
  ToolBatchResult,
  ToolCallContext,
  ToolCallOutcome,
  ToolCallPlan,
  ToolInterruptReport,
  ToolOutcomeReason,
} from './tools/tool-execution-engine';

export type {
  ChatSessionMeta,
  ChatSessionKind,
  ChatMessageRecord,
  ChatMessageStatus,
  ChatMessageUsage,
  ContextUsage,
  ResolvedModelConfig,
  RuntimeLimits,
  VisionRuntimeConfig,
  ConversationRuntime,
  ConversationEvent,
  RunSummary,
  PreRunCompactionPayload,
} from './types';
export type { SkillRecord } from '@/utils/skills/skill-types';
