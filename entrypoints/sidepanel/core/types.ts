/**
 * 核心领域类型（四引擎共用）
 *
 * 分层约定：
 *   registry/    智能体、技能管理（相互独立）
 *   context/     会话转录（用户面，无长度限制）与 AI 上下文（窗口化）
 *   runtime/     会话运行时装配（systemPrompt XML 分区 + 工具去重 + 模型配置）
 *   conversation/ 运行时驱动（对 agent/skill 无感知，只发事件、写转录）
 *
 * 本层零 Vue 依赖，保证可单测、可复用。
 */

import type { ChatMessage } from '../utils/ai/ai-chat-api';
import type { MessageFeedback, MessagePart, ToolCallUI } from '../types/chat';
import type { ModelRef, ResolvedModelEndpoint } from '../utils/channels';

// ==================== 用户面：会话与消息记录（IndexedDB，无长度限制） ====================

/**
 * 会话类型。
 * - 'chat'       普通对话（缺省；旧记录无 kind 字段时读取侧归一到此值）
 * - 'site-learn' 网站学习会话（含其验证段——两段共用同一会话，历史连续可回溯）
 *
 * 用独立字段而非智能体名承载：学习会话的智能体是运行期动态装配的
 * （不落 agent-store），名字可能随版本变化，且「这是什么会话」本就属于
 * 会话自身的属性而非所选智能体的属性。
 */
export type ChatSessionKind = 'chat' | 'site-learn';

/** 会话元信息（sessions store，keyPath: chatId） */
export interface ChatSessionMeta {
  chatId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /**
   * 冗余计数：该会话已持久化的消息条数（列表页免 count 查询）。
   * 由数据库在「写入消息」的同一事务内原子维护（exactly-once），
   * 不依赖调用方手工同步，因此不会与真实消息数漂移。
   */
  messageCount: number;
  /** 最后一条消息预览（截断至 80 字符） */
  lastMessagePreview: string;
  /**
   * 本会话最近一次使用的智能体 ID（'' 或缺省 = 无智能体）。
   * 与 agentName 一同落库：name 是用户可见名称、可被改写，id 才是稳定引用。
   * 恢复会话时优先按 id 解析（改名后仍能正确回显），id 失配（智能体已被删除）
   * 再按 name 兜底；早于该字段引入的历史记录没有它，届时按 name 解析。
   */
  agentId?: string;
  /** 本会话最近一次使用的智能体名（'' = 无智能体；id 的可读别名，用于展示与兜底解析） */
  agentName: string;
  /**
   * 本会话最近一次使用的技能引用列表。
   * v2 起存技能 id（稳定引用，技能改名不失效）；v1 历史会话为技能名——
   * 读取侧经 resolveSkill 三态解析（id / 模型标识 / 名称）统一兼容。
   */
  skillNames: string[];
  /**
   * 本会话最近一次使用的模型引用（稳定 id 对：渠道 + 模型）。
   * null/缺省 = 会话未指定过模型（回落全局默认）。
   * 恢复会话时按 id 解析；引用失效（渠道/模型被删除或禁用）时
   * 解析层自动回落全局默认并提示，绝不阻断会话加载。
   */
  modelRef?: ModelRef | null;
  /**
   * 系统提示词的会话级补充段（systemPrompt 的派生输入之一）。
   *
   * systemPrompt 本身不落库：它由「环境声明 + 智能体指令 + 本字段 +
   * 技能分区」在每次装配时拼装（时间戳已移至本轮用户消息尾部，systemPrompt
   * 逐轮逐字稳定以命中上下文缓存），智能体指令在 hub 编辑后
   * 也应随之更新——落库整串只会得到一份既过期又占空间的副本。落库的是「派生
   * 输入」（agentName / skillNames / modelRef / 本字段），装配层据此可逐字重建
   * 同一份 systemPrompt，会话切换与上下文预算估算因此与真实请求完全同源。
   * 仅 Deep Search 等动态装配方会写入非空值；缺省/空串表示无补充段
   * （旧版本写入的会话记录没有该字段，读取侧一律按空串归一化）。
   */
  systemPromptSuffix?: string;
  /**
   * 上下文压缩状态（模型面专用，用户面转录永不改动）：
   * seq <= compactionUpToSeq 的历史消息已被 LLM 摘要为 compactionSummary，
   * 派生 AI 上下文时以摘要系统消息代替这部分记录。
   */
  compactionSummary?: string;
  compactionUpToSeq?: number;
  /** 最近一次压缩时间（毫秒时间戳；用于摘要头部标注与调试） */
  compactionUpdatedAt?: number;
  /**
   * 会话类型（缺省 = 'chat'；早于该字段引入的历史记录没有它，读取侧一律
   * 归一为 'chat'）。站点学习会话据此在历史列表打标，并在恢复时读回
   * 持久化的技能草稿做成果兜底（草稿暂存失败的降级路径）。
   */
  kind?: ChatSessionKind;
}

export type ChatMessageStatus = 'streaming' | 'done' | 'error' | 'aborted';

/**
 * 消息记录（messages store，keyPath: id；[chatId, seq] 唯一索引）。
 * 完整保存用户消息与模型渲染结果（正文/推理/工具调用），不做长度裁剪；
 * 工具结果超大内容由写入侧按 TOOL_CONTENT_LIMIT 预截断，避免单条记录失控。
 * 图片不以二进制落库：本字段以内容哈希引用指向独立图片库（core/images/image-store），
 * 同一张图片全库只存一份，消息层永远只持有引用。
 */
export interface ChatMessageRecord {
  /** Exact model-facing rounds, independent of aggregated UI text/tool cards.
   * Images use storage-only content references; old records use legacy replay. */
  modelMessages?: ChatMessage[];
  /** Effective history after an explicit compaction. Original rounds stay above. */
  modelContext?: ChatMessage[];
  /** Current unfinished stream, checkpointed alongside the UI for crash recovery. */
  modelPartial?: ChatMessage;
  id: string;
  chatId: string;
  /** 会话内单调递增序号，用于排序与分页 */
  seq: number;
  role: 'user' | 'assistant';
  /** 最终文本内容（多模态输入时为文字部分；图片经 imageRefs 引用，不入正文） */
  content: string;
  parts: MessagePart[];
  reasoning: string;
  toolCalls: ToolCallUI[];
  status: ChatMessageStatus;
  error?: string;
  /**
   * 关联图片（内容哈希 SHA-256 hex；图片本体存于独立图片库，见 core/images）。
   * 语义按角色区分：
   *   - user：本轮上传的图片 ∪ 派生引用——落库归一化会把 modelMessages 里
   *     的协议图片引用（如 vision 首截图）并入本字段（图片回收/GC 按「消息
   *     是否引用」计数，必须完整反映协议历史持有的引用）；
   *   - assistant：vision 循环的自动截图（UI 查看/放大/下载）；新记录通过
   *     modelMessages 精确重放截图位置，旧截图不授权新的坐标操作。
   * 缺省 = 无图片。写入前经 normalizeImageRefs 收敛（去重/上限/形态校验）。
   * UI 展示用户气泡底部图片区时应改用 uploadImageRefs（只含用户上传），
   * 避免派生引用把 vision 截图重复展示为「用户发送的附属图片」。
   */
  imageRefs?: string[];
  /**
   * 用户消息的「主动上传」图片子集（⊆ imageRefs，内容哈希同源）。
   * 仅 user 角色记录使用；新记录恒写入（空上传 = 空数组，与旧记录的
   * undefined 区分——undefined 视为旧格式，UI 回退展示 imageRefs）。
   * vision 首截图等引擎注入的引用只进 imageRefs（GC 需要），不进本字段：
   * 用户气泡底部图片区据此只展示用户真正上传的图片，截图一律走助手消息
   * 的内联「查看屏幕」片段展示。
   */
  uploadImageRefs?: string[];
  usage?: ChatMessageUsage;
  /**
   * 用户对本条模型消息的反馈（赞/踩）。
   * 缺省 = 未反馈；清除反馈经 transcriptEngine.setMessageFeedback(null)
   * 删除本键（而非写入 null），保证读取侧只需真值判定。
   */
  feedback?: MessageFeedback;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessageUsage {
  /** 工具循环轮数 */
  iterations: number;
  durationMs: number;
  toolCalls: number;
}

// ==================== 模型配置（runtime 装配产物） ====================

/**
 * 单次运行模型配置 = 解析后的端点快照（utils/channels/model-registry 产出）：
 * 协议驱动 / 端点 / 凭据 / 重试 / 采样默认值 / 上下文阈值 / 来源引用，
 * 运行期不可变（见 utils/stream/types.ts 的 ModelEndpoint 契约）。
 * 不携带任何输出上限（max output tokens）：对话请求不封装生成上限，
 * 由提供商按模型能力决定（Claude 协议必填项由其适配器自适应处理）。
 * API key 只存在于内存，绝不落库。
 */
export type ResolvedModelConfig = ResolvedModelEndpoint;

// ==================== 运行时（runtime-builder 一次性装配，不可变） ====================

export interface RuntimeLimits {
  /** 工具循环最大轮数（装配时取应用设置的对话轮次上限，文本与视觉策略统一） */
  maxIterations: number;
  /** 单次运行最大时长（毫秒） */
  maxDurationMs: number;
  /** 单个工具执行超时（毫秒） */
  toolTimeoutMs: number;
  /**
   * 连续「整轮工具全部失败」触发延续确认的轮数阈值（装配时取应用设置；
   * 任一轮有成功调用即归零）。达到阈值经 onLimitReached('tool-failures')
   * 交由用户决策是否继续。
   */
  maxConsecutiveFailedToolRounds: number;
}

/** Vision 智能体运行配置（截图 → 多模态消息 → 循环中按需重截图）；定义归属智能体域（utils/agents/agent-types），此处转发供会话引擎与 runtime 装配使用 */
import type { VisionRuntimeConfig as VisionRuntimeConfigImpl } from '@/utils/agents/agent-types';
export type { VisionRuntimeConfigImpl as VisionRuntimeConfig };
type VisionRuntimeConfig = VisionRuntimeConfigImpl;

export interface ConversationRuntime {
  pluginToolCeiling?: string[];
  pluginOwners?: string[];
  pluginBindings?: Record<string, { digest: string; epoch: number }>;
  agentId?: string;
  /** Stable advertised catalog. Execution still checks toolIds / loaded skills. */
  advertisedToolIds?: string[];
  chatId: string;
  /** XML 分区后的系统提示词（environment / interaction-guidelines / agent-instructions / supplementary-context / available-skills） */
  systemPrompt: string;
  /** Set 去重后的有序工具 ID 列表 */
  toolIds: string[];
  /** Built-in guide capability ceiling, enforced again at execution time. */
  toolPolicy?: 'vision-assistant';
  model: ResolvedModelConfig;
  limits: RuntimeLimits;
  vision: VisionRuntimeConfig | null;
  /** 本轮用户输入（空字符串 = 仅继续既有上下文） */
  userInput: string;
  /**
   * 本轮用户上传图片（data URL 列表）。
   * 与 vision 截图一同进入多模态用户消息；转录落库的是 imageRefs
   * （内容哈希引用，图片本体存于独立图片库），data URL 仅存在于运行期。
   */
  userImages: string[];
  /**
   * 本轮上传文件信封（<upload_file> XML：文件元信息 + 第 1 页预览，预算封顶）。
   * 文本附件发送时已注册进会话文件库（8 位短 id + 确定性分页），全文由
   * read_file 按页续读；信封拼入本轮模型用户消息并随 modelMessages 保留，
   * 用户可见正文仅存 userInput（摘要标记）。空串 = 无文本附件。
   */
  attachmentPrompt: string;
  /** AI 面初始上下文（历史派生，不含本轮用户消息与 system） */
  initialContext: ChatMessage[];
  /**
   * 初始上下文里已出现的**视口截图**内容哈希（ImageRef 列表）。
   *
   * 用途：模型可见上下文的唯一截图保障——历史截图以协议引用回到上下文，
   * 其像素证据模型已持有；本轮新拍的视口图若哈希命中其中之一，则不再
   * 重复附图（只保留描述文本与新 screenshotId）。
   *
   * 口径：不含用户上传图片（用户素材语义独立，即使内容相同也不复用）；
   * 区域放大图一并计入是安全的——命中意味着模型已持有完全相同的字节
   * （提取规则见 viewport-ref-collector）。哈希取自历史记录的图片引用，
   * 与图片库的内容寻址完全同源。
   */
  priorViewportImageRefs: string[];
  /**
   * 合成激活轮：用户用 / 预选技能时，系统代发的一轮 load_skill 调用
   * （assistant tool_calls + tool 结果，见 skillEngine.buildActivationRound）。
   * 会话引擎把它追加在本轮用户消息之后并保存在 modelMessages，
   * UI 不显示这轮「凭空出现」的工具调用。未预选技能时为空数组。
   */
  activationContext: ChatMessage[];
  /**
   * 初始上下文对应的用户面最大 seq（priorRecords 为空时为 0）。
   * 用途：运行中压缩的「边界对齐持久化」——仅当压缩边界恰好落在本轮用户消息
   * （即被压缩的头部 = 初始上下文全体）时，才能以该 seq 作为压缩点安全落库；
   * 边界落在运行内（如 vision 合成消息之前）时压缩跨越了未定稿的流式记录，
   * 无法用 seq 表达，一律不持久化。
   */
  priorMaxSeq: number;
  /**
   * 发送前压缩（后台 worker 在引擎运行前执行）的结果回执。
   * 引擎在创建助手记录时把它种子为一条 compaction 片段（record.parts），
   * 与 UI 侧「缓冲 pre-run 事件、assistant-start 时种子」落成同一时间线；
   * 缺省 = 本次发送前未发生压缩。
   *
   * 载荷形状与压缩事件、压缩片段状态同源（不含 trigger——发送前压缩的
   * trigger 恒为 'pre-run'，由两侧各自补齐，避免载荷与展示语义耦合）。
   */
  preRunCompaction?: PreRunCompactionPayload;
}

/**
 * 发送前压缩的结果载荷（引擎回执 / UI 事件缓冲 / 压缩片段种子三处共用）。
 *
 * 两侧（引擎 record.parts 与 UI 直播消息）必须承载**同一份数据**——它们
 * 在 assistant-complete 的按下标合并中互为对照，任何字段差异都会让
 * 终态覆盖后出现「消息里是成功行、历史里是失败行」的分叉。
 */
export interface PreRunCompactionPayload {
  /** 压缩是否成功（失败时 error 必填，token 数字段缺省无意义） */
  status: 'success' | 'error';
  /** 被压缩原文的 token 估算量 */
  originalTokens?: number;
  /** 摘要的 token 估算量 */
  summaryTokens?: number;
  /** 压缩产出的摘要全文（<summary> XML；展开详情用） */
  summary?: string;
  /** 失败原因（仅 error） */
  error?: string;
  /** 压缩耗时（毫秒） */
  durationMs?: number;
}

// ==================== 会话引擎事件（UI 框架无关） ====================

export type ConversationEvent =
  | { type: 'user-message'; chatId: string; record: ChatMessageRecord }
  | { type: 'assistant-start'; chatId: string; messageId: string }
  | { type: 'token'; chatId: string; messageId: string; delta: string }
  | { type: 'reasoning'; chatId: string; messageId: string; delta: string }
  | {
      /** 系统注记（守卫停止说明、截断注记等）：以独立系统信息条呈现，不混入正文 */
      type: 'notice';
      chatId: string;
      messageId: string;
      text: string;
    }
  | { type: 'tool-call'; chatId: string; messageId: string; call: ToolCallUI }
  | {
      type: 'tool-result';
      chatId: string;
      messageId: string;
      callId: string;
      status: 'success' | 'error';
      result?: unknown;
      error?: string;
      executionTimeMs: number;
    }
  | { type: 'assistant-complete'; chatId: string; record: ChatMessageRecord }
  | {
      type: 'assistant-error';
      chatId: string;
      messageId: string;
      error: string;
      /** 本轮实际执行时长（毫秒；收尾 finalize 已写入 usage，事件携带供 UI 即时展示） */
      durationMs?: number;
    }
  | {
      type: 'aborted';
      chatId: string;
      messageId: string;
      /** 本轮实际执行时长（毫秒；同 assistant-error，供中止消息展示耗时） */
      durationMs?: number;
    }
  /**
   * 消息新增一张关联图片（vision 自动截图入库完成）。
   * UI 据此把图片挂接到对应消息的图片区（默认收起，可查看/放大/下载）；
   * 图片本体在独立图片库，事件只携带内容哈希引用。
   */
  | { type: 'message-image'; chatId: string; messageId: string; imageRef: string }
  /** 循环守卫触发（轮数/时长上限、连续工具失败）；确认交互经 RunOptions.onLimitReached */
  | { type: 'guard'; chatId: string; kind: 'max-iterations' | 'max-duration' | 'tool-failures' }
  | {
      /**
       * 上下文压缩进度（用户可感知）：开始 / 成功 / 失败（失败时优雅降级为窗口裁剪）。
       * 运行中压缩携带 messageId：UI 据此把进度写入直播消息的压缩片段
       * （与引擎侧 record.parts 双写同一状态）；发送前压缩发生在助手记录
       * 创建之前，无 messageId——UI 缓冲结果并在 assistant-start 时种子进消息
       * （引擎侧经 runtime.preRunCompaction 持久化同一数据）。
       */
      type: 'compaction';
      chatId: string;
      phase: 'start' | 'done' | 'failed';
      trigger: 'pre-run' | 'runtime';
      /** 压缩所属的助手记录（仅 runtime 触发；pre-run 时缺省） */
      messageId?: string;
      /** 压缩对象的 token 估算量（start）/ 摘要的 token 估算量（done） */
      originalTokens?: number;
      summaryTokens?: number;
      /** 压缩产出的摘要全文（done；UI 展开详情与 pre-run 种子共用） */
      summary?: string;
      /** 压缩耗时（done/failed；UI 直播片段与 record.parts 双写同一数值） */
      durationMs?: number;
      error?: string;
    }
  | {
      /**
       * 上下文用量快照：引擎主循环每轮测量（及压缩成功后复测）时发射。
       * 数据与该次真实请求的全量口径一致（系统提示词 + 工具定义 + 消息），
       * 普通对话的用量环与学习/验证状态条共用同一事件源——任何运行期间
       * 展示的都是「最近一次请求的真实负载」，而非发送前的静态估算。
       */
      type: 'context-usage';
      chatId: string;
      usage: ContextUsage;
    };

/**
 * 上下文用量测量（全量口径：系统提示词 + 工具定义 + 对话消息，token 计量）。
 * 计量方式与 ContextWindowGuard 一致（utils/ai/token-estimate 唯一实现：
 * 文本启发式估算 + 图片固定 1200 token），保证环上显示的比例与实际裁剪行为同源。
 */
export interface ContextUsage {
  /** 系统提示词 token 估算 */
  systemTokens: number;
  /** 工具定义（OpenAI JSON Schema）token 估算 */
  toolsTokens: number;
  /** 对话消息文本部分（含运行中工具结果）token 估算 */
  messagesTokens: number;
  /** 对话消息中的图片成本（1200 token/张） */
  imageTokens: number;
  /** 全量合计 */
  totalTokens: number;
  /** 上下文窗口 token 阈值 */
  threshold: number;
  /** 占比（0..1，可能大于 1 表示已超限） */
  ratio: number;
}

/** 运行结束摘要 */
export interface RunSummary {
  chatId: string;
  messageId: string;
  status: ChatMessageStatus;
  iterations: number;
  durationMs: number;
  error?: string;
  /** 本次运行内发生的上下文压缩次数 */
  compactions: number;
  /** 最近一次请求的全量上下文用量（环上进度条数据源；运行零请求时缺省） */
  contextUsage?: ContextUsage;
}
