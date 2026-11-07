/**
 * 网站学习（Site Learn）领域类型与常量
 *
 * 分层约定（与项目整体一致）：
 *   learn-types.ts    本文件：纯类型 + 常量，零副作用、零 I/O，可被工具 / 编排 / UI 共用
 *   learn-validate.ts 纯函数校验与派生（配置合法性、模型过滤、策略收敛）
 *   learn-prompts.ts  分阶段 prompt 模板（学习 A/B/C 三套 + 验证两套，见该文件）
 *   learn-draft-store.ts 草稿跨页传递（持久交接队列、编辑恢复副本与保存回执）
 *   use-learn-session.ts 编排状态机（唯一写入这些类型的业务层）
 *
 * 身份与不变量：
 *   - LearnConfig 经 validateLearnConfig 校验后冻结，进入编排层后不可变；
 *   - SkillDraft 是 submit_skill 的返回体（工具层已校验），编排层只读；
 *   - 两者的字段命名与工具 openaiSchema 严格同名，避免两处漂移。
 */

// ──── 领域枚举 ────

/**
 * 模型引用（结构化形态，与 channels 的 ModelRef 同构）。
 *
 * 刻意不直接 import ModelRef：本模块是零依赖的纯类型层，需要被管理中心（hub）
 * 与工具层同时引用；一旦引入 sidepanel 的渠道类型，就会把整个渠道/流式依赖
 * 拖进 hub 的编译图。同构结构体由 TypeScript 结构化类型天然互通，
 * 调用方传 ModelRef 完全兼容。
 */
export interface LearnModelRef {
  channelId: string;
  modelId: string;
}

/**
 * 目标操作模式：决定产出 SKILL 交给谁用（描述风格 + 验证阶段用哪个智能体）。
 * - text   交给纯文本模型：真实 XPath + 元素文字/属性，现场重采引用；
 * - vision 保留文本能力，额外描述位置、外观、组件形式与界面反馈。
 */
export type LearnTargetMode = 'text' | 'vision';

/**
 * 学习策略：决定学习阶段用什么工具组去摸索。
 * - text   完整 DOM 枚举、指定元素属性、文本交互与页面脚本；无截图循环。
 * - vision 在 text 基础上启用自动截图循环：
 *     · targetMode=text ：仅追加 screenshot——截图只用于帮助理解屏幕元素，
 *       不注入任何 vision_gui 手势工具，操作与取证一律走 DOM 文本通道；
 *     · targetMode=vision：追加 screenshot + vision_gui 手势（+窗口管理），
 *       按需 mark→inspect 打标核对。
 *
 * 约束：targetMode='vision' 时恒为 'vision'（给视觉模型写的技能，
 * 学习时就该看着界面摸索，没有降级到纯文本的必要）。
 */
export type LearnStrategy = 'text' | 'vision';

/**
 * 模式 → tags 中的稳定标签（用户可见、可检索；模式的唯一持久化表达）。
 * 单一事实源：submit_skill 提交时补标签、编排层对账草稿时纠错，
 * 两处都引用本常量，避免文案漂移（hub 侧仅把 tags 当普通字符串展示）。
 */
export const SKILL_MODE_TAG: Record<LearnTargetMode, string> = {
  text: '文本模式',
  vision: '视觉模式',
};

/** 技能 tags 上限（与 hub 技能编辑页一致；submit_skill 与编排层对账共用） */
export const SKILL_MAX_TAGS = 8;

/** 用户配置（校验前的原始形态） */
export interface LearnConfig {
  /** 目标站点 URL（http/https） */
  url: string;
  /** 学习目标（自然语言，描述要完成什么） */
  goal: string;
  /** 可选：用户建议的操作过程与任务约束；须现场核实后写入技能。 */
  additionalDescription?: string;
  targetMode: LearnTargetMode;
  strategy: LearnStrategy;
  /** 学习模型 = 验证模型（稳定 id 对：渠道 + 模型） */
  modelRef: LearnModelRef;
  /** 是否自动进入验证阶段（默认 true；false 时学习完直接落盘） */
  autoValidate: boolean;
  learningLimits?: LearnStageLimits;
  validationLimits?: LearnStageLimits;
}

export interface LearnStageLimits {
  maxIterations: number;
  maxDurationMinutes: number;
}

/** 校验后的冻结配置（编排层只接受此形态，杜绝「带病运行」） */
export type ValidatedLearnConfig = LearnConfig;

/**
 * UI 收集的原始配置（校验前）。
 * 与 LearnConfig 的唯一差异：modelRef 可为 null（= 用户尚未选择）——
 * 让「未选」与「选了但失效」在类型上就能区分，校验层据此给出不同错误码
 * （model-required vs model-unavailable），UI 文案不会张冠李戴。
 */
export type LearnConfigInput = Omit<LearnConfig, 'modelRef'> & {
  modelRef: LearnModelRef | null;
};

/**
 * submit_skill 的返回体（工具层校验通过后才有此形态）。
 * 字段与 submit_skill 的 openaiSchema 一一对应。
 */
export interface SkillDraft {
  /** kebab-case 英文名（已规范化并通过 pattern 校验） */
  name: string;
  description: string;
  category: string;
  /** 已含模式标签（文本模式 / 视觉模式），最多 8 个 */
  tags: string[];
  /** SKILL.md 正文（Markdown，不含 frontmatter），≤ SKILL_BODY_MAX_CHARS */
  body: string;
  /** 已校验为注册工具且符合目标模式；非空——用于技能能力匹配 */
  allowedTools: string[];
  /** 目标操作模式（与 tags 中的模式标签同源；本字段供编排层选用验证智能体） */
  mode: LearnTargetMode;
  /** 一句话执行摘要（可选） */
  summary?: string;
}

/** submit_validation 的返回体 */
export interface ValidationReport {
  passed: boolean;
  /** 尚未解决的执行/复用问题；不通过时非空，通过时必须为空。 */
  issues: string[];
  /** 不影响当前流程正确性的可选建议，不用于隐藏未修复的问题。 */
  suggestions?: string[];
  /** 通过时需要实际样本/状态、结果回执及覆盖限制；修订可沿用 revision.evidence。 */
  evidence?: string[];
  /** 0-100 可复用性评分（可选，不代替证据） */
  score?: number;
  /** 一句话结论（可选） */
  summary?: string;
  /** 仅在修订后的流程已重新验证通过时提供；不改变技能身份、模式或工具权限。 */
  revision?: ValidationRevision;
}

export interface ValidationRevision {
  body: string;
  summary: string;
  /** 实际复核的样本差异、结果及覆盖限制，不是未经验证的建议。 */
  evidence: string[];
}

// ──── 终态分化：成功提交 / 失败提交 ────

/**
 * 学习终态提交的状态（submit_skill 的 status 参数）。
 *
 * 为什么要分化：终态工具此前只有「成功」一条路——成功必须同时交出合格的
 * name/正文/工具清单，模型探索未完成时写不出合格正文，提交失败后拿到的只是
 * 参数错误，拿不到任何「为什么没学成」的信息，于是常常改用一句文本总结收尾，
 * 终态工具被无视、已探明的知识也随会话沉底。
 *
 * 现在失败也是**一等终态**：模型不必交出合格正文就能收尾，只需说清卡在哪、
 * 为什么、以及已经探明了什么——失败同样有产出，编排层也拿得到确定的原因。
 */
export type LearnSubmitStatus =
  /** 学习成功：交出可入库的技能草稿 */
  | 'success'
  /** 学习失败：流程本身没走通，原因已定位（换策略重试有意义） */
  | 'failed'
  /** 被外部条件阻断：必须由人完成某一步（登录、验证码、扫码、付费、授权） */
  | 'blocked';

/**
 * 学习失败的机器原因码（模型选择，UI 映射文案）。
 *
 * 只列「卡点性质」而非「卡点细节」——细节由 detail 承载，枚举负责让用户
 * 与后续决策能一眼看出这是「换个策略就能重试」还是「必须人工介入」。
 */
export const LEARN_FAILURE_REASONS = [
  /** 需要登录 / 账号态失效 */
  'login-required',
  /** 验证码 / 扫码 / 人机校验 */
  'captcha',
  /** 权限不足 / 被禁 / 需授权 */
  'permission-denied',
  /** 目标页面或目标元素不存在 */
  'target-missing',
  /** 流程已变更、中途断链或无响应 */
  'flow-broken',
  /** 定位线索不稳定（每次刷新都变、无法重采） */
  'locator-unstable',
  /** 页面无法访问（网络、跨域、加载失败） */
  'page-unreachable',
  /** 超时未完成 */
  'timeout',
  /** 其它 */
  'other',
] as const;

export type LearnFailureReason = (typeof LEARN_FAILURE_REASONS)[number];

/** 失败原因是否「必须由人完成」（UI 据此给出不同建议：等待人工 vs 换策略重试） */
export function isHumanBlockedReason(reason: LearnFailureReason): boolean {
  return reason === 'login-required' || reason === 'captcha' || reason === 'permission-denied';
}

/**
 * 学习失败报告（submit_skill 以 status=failed/blocked 提交时的返回体）。
 *
 * findings 是这份报告最有价值的部分：**失败也有产出**——已跑通的步骤、
 * 已确认的定位线索、已踩到的坑都记在这里，用户拿到的不是一句「失败了」，
 * 而是一份「学到了什么 + 卡在哪 + 下一步怎么办」。
 */
export interface LearnFailureReport {
  /** 失败原因分类（机器码） */
  reason: LearnFailureReason;
  /** 具体说明：卡在哪一步、期望什么、实际发生什么 */
  detail: string;
  /** 已探明的可复用知识（即使失败也有价值） */
  findings: string[];
  /** 建议的下一步（人工介入 / 换策略 / 缩小目标） */
  suggestion?: string;
}

/** 上一轮运行的反馈（注入下一轮学习 prompt，让模型带着问题清单重来） */
export type LearnFeedback =
  /** 盲测未通过：技能本身有问题 */
  | { kind: 'validation'; report: ValidationReport }
  /** 学习本身失败：流程没走通，原因已定位 */
  | { kind: 'failure'; report: LearnFailureReport };

// ──── 状态机 ────

/**
 * 学习会话阶段（编排层状态机的唯一真值）。
 *
 * 单向流转：idle → configuring → confirming → learning → validating → drafting → done
 *
 *   - confirming 点「返回修改」→ configuring（配置面板保留已填内容）；
 *   - 任一运行阶段经用户终止 / 不可恢复失败 → reset() → idle
 *     （中止即整体丢弃：草稿、报告、会话一并作废，故不设独立终止态——
 *     reset 后与「从未开始」不可区分正是「已丢弃」的语义）；
 *   - drafting 交付完成即入 done。交付有两条路径，终态相同：
 *     正常路径 = 向后台提交草稿与摘要 → 暂存草稿（chrome.storage）→ 新标签页打开管理中心；
 *     降级路径 = 暂存草稿失败 → 草稿改由会话详情承载（只随消息回放，
 *     不进技能创建流程）→ 流程照常结束并提示用户手动重建技能——
 *     单点存储故障不应卡死收尾，故不设独立降级终态（hub 侧确认不回流 sidepanel，
 *     故无 hubConfirm 态）。
 */
export type LearnPhase =
  /** 未进入学习（输入区为普通对话态） */
  | 'idle'
  /** 配置面板已打开 */
  | 'configuring'
  /** 二次确认弹窗（展示配置摘要与风险提示；取消回 configuring） */
  | 'confirming'
  /** 学习段运行中 */
  | 'learning'
  /** 验证段运行中（autoValidate=false 时跳过） */
  | 'validating'
  /** 草稿组装与跨页传递（写 storage → 跳转 hub；失败时走会话详情降级） */
  | 'drafting'
  /** 已跳转 hub，本侧流程结束（交付完成的静止态，输入区恢复正常） */
  | 'done';

/** 处于「运行中」的阶段（UI 据此隐藏输入区、显示状态条） */
export const RUNNING_PHASES: readonly LearnPhase[] = ['learning', 'validating'] as const;

/** 是否正在运行（决定是否锁定全局响应态、显示终止按钮） */
export function isLearnRunning(phase: LearnPhase): boolean {
  return (RUNNING_PHASES as readonly string[]).includes(phase);
}

// ──── 运行参数常量 ────

/**
 * 学习 / 验证段的循环上限。
 * 学习要大量试错，默认 20 轮 / 10 分钟远不够；取 60 轮 / 30 分钟。
 * 高级设置可独立覆盖学习/验证的预算。每次触限都由用户选择继续、总结或丢弃。
 */
export const LEARN_LIMITS = {
  maxIterations: 60,
  maxDurationMs: 30 * 60 * 1000,
} as const;

/** New windows keep the same duration; only their iteration count is user-selected. */
export const LEARN_DEFAULT_STAGE_LIMITS: Readonly<LearnStageLimits> = {
  maxIterations: LEARN_LIMITS.maxIterations,
  maxDurationMinutes: LEARN_LIMITS.maxDurationMs / 60_000,
};
export const LEARN_DEFAULT_EXTENSION_ITERATIONS = 15;

// ──── 草稿跨页传递 ────

/**
 * 旧版草稿 storage key，仅用于无损迁移；新成果使用独立 ID 的持久记录。
 */
export const LEARN_DRAFT_STORAGE_KEY = 'agentNexusSkillDraft';

/** 旧版有效期，保留兼容；新交接与旧数据迁移均不按此值过期删除。 */
export const LEARN_DRAFT_TTL_MS = 10 * 60 * 1000;

/** 跨页深链 hash（仅提示待接收成果，用户确认后才预填） */
export const LEARN_DRAFT_HASH = '#new-skill';

/**
 * 生成 `#new-skill?id=<transferId>&t=<nonce>`。ID 定位成果，nonce 唤醒已打开的
 * 管理中心；深链只传信号，不携带正文、不自动重置编辑器或删除交接记录。
 */
export function learnDraftHash(transferId?: string): string {
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${LEARN_DRAFT_HASH}?${transferId ? `id=${encodeURIComponent(transferId)}&` : ''}t=${nonce}`;
}

/** Durable outbox: opening a form never acknowledges or deletes its source. */
export interface LearnDraftTransfer {
  version: 2;
  id: string;
  sourceChatId: string;
  createdAt: number;
  draft: SkillDraft;
  status: 'pending' | 'saved' | 'discarded';
  savedSkillId?: string;
  /** User dismissed recovery/reminders; retain original and any open Hub editor. */
  recoveryDismissed?: boolean;
  editorState?: LearnDraftEditorState;
}

export interface LearnDraftEditorState {
  form: { name: string; description: string; category: string; customCategory: string; tags: string[]; body: string; raw: string };
  editorMode: 'simple' | 'advanced';
  preservedFrontmatterLines: string[];
  resourceFiles: Record<string, string>;
  /** 高级模式的显式目录（含空目录）；旧快照缺省时按空处理 */
  resourceFolders?: string[];
  /** 高级模式当前打开的文件（'SKILL.md' 或资源文件相对路径）；新建/重命名等瞬时输入态不持久化 */
  selectedFile: string;
}

/** 旧版草稿载荷，仅用于迁移。 */
export interface LearnDraftPayload {
  draft: SkillDraft;
  /** 原写入时间（迁移时保留） */
  createdAt: number;
}
