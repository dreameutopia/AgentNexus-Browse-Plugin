/**
 * 网站学习（Site Learn）领域类型与常量
 *
 * 分层约定（与项目整体一致）：
 *   learn-types.ts    本文件：纯类型 + 常量，零副作用、零 I/O，可被工具 / 编排 / UI 共用
 *   learn-validate.ts 纯函数校验与派生（配置合法性、模型过滤、策略收敛）
 *   learn-prompts.ts  分阶段 prompt 模板（学习 A/B/C 三套 + 验证两套，见该文件）
 *   learn-draft-store.ts 草稿跨页传递（chrome.storage 一次性 key，带 TTL）
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
 * - text   交给纯文本模型：定位以 CSS 选择器 / XPath + 元素文字为主；
 * - vision 交给视觉模型：可额外描述元素在界面中的位置区域。
 */
export type LearnTargetMode = 'text' | 'vision';

/**
 * 学习策略：决定学习阶段用什么工具组去摸索。
 * - text   用 Auto Action 工具组（枚举器 + 选择器 + 页面脚本）；
 * - vision 用 Vision Action 工具组（带数字标签的截图定位）。
 *
 * 约束：targetMode='vision' 时恒为 'vision'（给视觉模型写的技能，
 * 学习时就该看着界面摸索，没有降级到纯文本的必要）。
 */
export type LearnStrategy = 'text' | 'vision';

/** 用户配置（校验前的原始形态） */
export interface LearnConfig {
  /** 目标站点 URL（http/https） */
  url: string;
  /** 学习目标（自然语言，描述要完成什么） */
  goal: string;
  targetMode: LearnTargetMode;
  strategy: LearnStrategy;
  /** 学习模型 = 验证模型（稳定 id 对：渠道 + 模型） */
  modelRef: LearnModelRef;
  /** 是否自动进入验证阶段（默认 true；false 时学习完直接落盘） */
  autoValidate: boolean;
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
  /** 已剔除未注册工具；非空——它是技能在「/」清单中可见的依据 */
  allowedTools: string[];
  /** 目标操作模式（与 tags 中的模式标签同源；本字段供编排层选用验证智能体） */
  mode: LearnTargetMode;
  /** 一句话执行摘要（可选） */
  summary?: string;
}

/** submit_validation 的返回体 */
export interface ValidationReport {
  passed: boolean;
  /** 不通过时必填（工具层硬校验）；通过时可为改进建议 */
  issues: string[];
  /** 0-100 完成度评分（可选） */
  score?: number;
  /** 一句话结论（可选） */
  summary?: string;
}

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
 * 达到上限时不直接丢弃：编排层会给一次「再给 5 轮收尾提交」的机会
 * （见 use-learn-session 的 onLimitReached 分支）。
 */
export const LEARN_LIMITS = {
  maxIterations: 60,
  maxDurationMs: 30 * 60 * 1000,
} as const;

/** 收尾追加轮数（达上限后给模型一次提交机会） */
export const LEARN_WRAP_UP_EXTRA_ITERATIONS = 5;

// ──── 草稿跨页传递 ────

/**
 * 草稿暂存的 storage key（chrome.storage.local 一次性读取）。
 * body 可达 15000 字符，不进 URL；读取即删 + TTL 过期，避免残留。
 */
export const LEARN_DRAFT_STORAGE_KEY = 'agentNexusSkillDraft';

/** 草稿有效期：超过则 hub 侧按「已过期」处理（走空表单 + 提示） */
export const LEARN_DRAFT_TTL_MS = 10 * 60 * 1000;

/** 跨页深链 hash（hub 据此切到技能分区并触发预填） */
export const LEARN_DRAFT_HASH = '#new-skill';

/** 写入 hub 草稿的载荷形态 */
export interface LearnDraftPayload {
  draft: SkillDraft;
  /** 写入时间（TTL 判定） */
  createdAt: number;
}
