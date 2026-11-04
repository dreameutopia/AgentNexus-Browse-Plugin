/**
 * 网站学习配置校验与回执对账（纯逻辑层：无 I/O、无全局状态、无 Vue 依赖）
 *
 * 职责边界：
 *   1. 回答「这份配置能不能开始学习」以及「模型清单该怎么过滤」；
 *   2. 对账 submit_skill / submit_validation 的回执——工具层校验不了
 *      「与本次配置的一致性」（mode 是否等于 targetMode、allowedTools 是否
 *      混入阶段外面板），编排层捕获回执时用本层纯函数收口；
 * 不做任何副作用（不弹提示、不清选择、不写存储）——这些由 UI / 编排层
 * 消费本层的结果后自行执行。这样规则可被单测穷举，上层换形态也不影响规则。
 *
 * 三条联动规则（与产品约定一一对应）：
 *   1. 目标操作模式为 vision 时，学习策略强制收敛为 vision（没有切换余地）；
 *   2. 需要视觉的场景（目标 vision，或目标 text 但策略选了 vision）只能选
 *      「能真正接收图片」的模型——模型声明 vision 且协议能力支持图片，
 *      两者缺一不可（否则请求会在 vision.ts 处抛错，白跑一轮学习）；
 *   3. 切换学习策略会让已选模型失效，由 UI 清空并提示重选
 *      （见 shouldClearModelOnStrategyChange）。
 */

import {
  LEARN_FAILURE_REASONS,
  SKILL_MAX_TAGS,
  SKILL_MODE_TAG,
  type LearnConfig,
  type LearnConfigInput,
  type LearnFailureReason,
  type LearnFailureReport,
  type LearnModelRef,
  type LearnStrategy,
  type LearnTargetMode,
  type SkillDraft,
  type ValidatedLearnConfig,
  type ValidationReport,
} from './learn-types';
import {
  SKILL_BODY_MAX_CHARS,
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_NAME_MAX_CHARS,
} from '@/utils/skills/skill-types';

/** 学习目标字符上限（超长会让首轮请求吃掉大量上下文预算） */
export const LEARN_GOAL_MAX_CHARS = 2000;

/** 配置字段（错误按字段归集，UI 据此做内联红字） */
export type LearnConfigField = 'url' | 'goal' | 'targetMode' | 'strategy' | 'modelRef';

/**
 * 校验错误码（机器码，调用方经 i18n 映射为文案）。
 *
 * 与 frontmatter-parser 的 SkillMdIssue.code 同一惯例：纯逻辑层不持有文案，
 * 否则要么把中文写死在可单测层（无法本地化），要么让校验层依赖全局 locale
 * （破坏纯函数性）。码值稳定即可，新增只增不改。
 */
export type LearnConfigErrorCode =
  | 'url-empty'
  | 'url-invalid'
  | 'url-protocol'
  | 'goal-empty'
  | 'goal-too-long'
  | 'target-mode-required'
  | 'strategy-required'
  | 'model-required'
  | 'model-unavailable'
  | 'model-no-vision';

/** 校验结果：成功携带冻结配置，失败携带按字段归集的错误码 */
export type LearnConfigValidation =
  | { ok: true; config: ValidatedLearnConfig }
  | { ok: false; errors: Partial<Record<LearnConfigField, LearnConfigErrorCode>> };

/**
 * 学习模型候选（由 UI 从模型注册表投影而来）。
 *
 * `canAcceptImages` 是**合并后的事实**而非单一声明：调用方必须同时满足
 *   ModelOption.vision（用户逐模型声明）与
 *   driverRegistry 能力（该协议的适配器是否支持图片），
 * 任一为 false 即应传 false。本层不再关心两者如何得出——
 * 「能不能用」只有一个答案，规则收在调用方一处。
 */
export interface LearnModelCandidate {
  /** 稳定键（modelRefKey），用于下拉 v-for 与选中态 */
  key: string;
  ref: LearnModelRef;
  label: string;
  channelName: string;
  canAcceptImages: boolean;
}

/** 一次学习是否需要能接收图片的模型 */
export function needsVisionModel(config: Pick<LearnConfig, 'targetMode' | 'strategy'>): boolean {
  return config.targetMode === 'vision' || config.strategy === 'vision';
}

/**
 * 学习策略收敛：目标操作模式为 vision 时恒为 vision。
 * UI 据此禁用策略切换；校验时再兜一次底，防止绕过 UI 直接构造配置。
 */
export function convergeStrategy(
  targetMode: LearnTargetMode,
  requested: LearnStrategy,
): LearnStrategy {
  return targetMode === 'vision' ? 'vision' : requested;
}

/** 按是否需要视觉过滤模型候选（保序，返回原对象引用） */
export function filterLearnModels(
  candidates: readonly LearnModelCandidate[],
  requireVision: boolean,
): LearnModelCandidate[] {
  if (!requireVision) return [...candidates];
  return candidates.filter(candidate => candidate.canAcceptImages);
}

/**
 * 切换（目标模式 / 学习策略）是否应清空已选模型。
 *
 * 判据是**视觉需求是否变化**：清单口径变了，原来的选择可能不再合法
 * （如从「文本+文本」切到「视觉」，旧模型可能不收图）。
 * 只有过滤口径真的变化才清空——策略在同口径内切换时清单不变，
 * 无谓清空是对用户的打扰。两态都要用各自的 targetMode 收敛后比较，
 * 否则「目标模式同时变化」会被错误地判为无需清空。
 */
export function shouldClearModelOnStrategyChange(
  from: { targetMode: LearnTargetMode; strategy: LearnStrategy },
  to: { targetMode: LearnTargetMode; strategy: LearnStrategy },
): boolean {
  return needsVisionModel(from) !== needsVisionModel(to);
}

/** URL 校验：非空 + 可解析 + 仅 http/https（file/data 等协议注入脚本无意义） */
function validateUrl(raw: unknown): LearnConfigErrorCode | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'url-empty';
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'url-invalid';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'url-protocol';
  }
  return null;
}

/** 学习目标校验：非空 + 长度上限 */
/**
 * 文本长度按**码点**计（而非 UTF-16 码元）。
 *
 * 口径必须与 UI 的计数器一致：同一个输入，界面显示「1999/2000」却被校验
 * 拒绝（或反过来）是典型的自相矛盾。码点计数让一个 emoji 记 1 字——
 * 与用户「我打了几个字」的心智一致。
 */
export function countTextChars(text: string): number {
  return Array.from(text).length;
}

function validateGoal(raw: unknown, maxChars: number): LearnConfigErrorCode | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'goal-empty';
  if (countTextChars(raw.trim()) > maxChars) return 'goal-too-long';
  return null;
}

/** 模型引用是否命中候选清单（按 channelId + modelId 精确匹配） */
function findCandidate(
  candidates: readonly LearnModelCandidate[],
  ref: LearnModelRef | null | undefined,
): LearnModelCandidate | undefined {
  if (!ref || typeof ref.channelId !== 'string' || typeof ref.modelId !== 'string') return undefined;
  return candidates.find(c => c.ref.channelId === ref.channelId && c.ref.modelId === ref.modelId);
}

/**
 * 校验完整配置。
 *
 * @param raw        UI 收集的原始配置（未信任）
 * @param candidates 当前可选模型（已由 UI 投影，含 canAcceptImages 合并事实）
 */
export function validateLearnConfig(
  raw: Partial<LearnConfigInput> | null | undefined,
  candidates: readonly LearnModelCandidate[],
): LearnConfigValidation {
  const errors: Partial<Record<LearnConfigField, LearnConfigErrorCode>> = {};
  const input = raw ?? {};

  const urlError = validateUrl(input.url);
  if (urlError) errors.url = urlError;

  const goalError = validateGoal(input.goal, LEARN_GOAL_MAX_CHARS);
  if (goalError) errors.goal = goalError;

  // 目标模式只接受白名单值（脏值不静默回落——回落会改变产出 SKILL 的形态）
  const targetMode = input.targetMode;
  if (targetMode !== 'text' && targetMode !== 'vision') {
    errors.targetMode = 'target-mode-required';
  }

  // 学习策略：目标为 vision 时被收敛锁定，其取值不再参与判定；
  // 目标为 text 时必须是显式二选一（缺省 / 脏值都要用户补选，不替他猜）
  const strategy: LearnStrategy =
    targetMode === 'vision' ? 'vision' : input.strategy === 'vision' ? 'vision' : 'text';
  if (targetMode === 'text' && input.strategy !== 'text' && input.strategy !== 'vision') {
    errors.strategy = 'strategy-required';
  }

  // 模型：必须已选 + 命中候选 +（需要视觉时）能接收图片
  const requireVision =
    targetMode === 'text' || targetMode === 'vision' ? needsVisionModel({ targetMode, strategy }) : false;
  const matched = findCandidate(candidates, input.modelRef);
  if (!input.modelRef) {
    errors.modelRef = 'model-required';
  } else if (!matched) {
    errors.modelRef = 'model-unavailable';
  } else if (requireVision && !matched.canAcceptImages) {
    errors.modelRef = 'model-no-vision';
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    config: {
      url: (input.url as string).trim(),
      goal: (input.goal as string).trim(),
      targetMode: targetMode as LearnTargetMode,
      strategy,
      modelRef: { channelId: matched!.ref.channelId, modelId: matched!.ref.modelId },
      autoValidate: input.autoValidate !== false,
    },
  };
}

/** 错误码 → i18n key（调用方经 t() 取文案；集中一处避免 UI 侧散落映射） */
export const LEARN_ERROR_KEYS: Record<LearnConfigErrorCode, string> = {
  'url-empty': 'sidepanel.learn.errUrlEmpty',
  'url-invalid': 'sidepanel.learn.errUrlInvalid',
  'url-protocol': 'sidepanel.learn.errUrlProtocol',
  'goal-empty': 'sidepanel.learn.errGoalEmpty',
  'goal-too-long': 'sidepanel.learn.errGoalTooLong',
  'target-mode-required': 'sidepanel.learn.errTargetMode',
  'strategy-required': 'sidepanel.learn.errStrategy',
  'model-required': 'sidepanel.learn.errModelRequired',
  'model-unavailable': 'sidepanel.learn.errModelUnavailable',
  'model-no-vision': 'sidepanel.learn.errModelNoVision',
};

/**
 * 失败原因码 → i18n key（与 LEARN_ERROR_KEYS 同惯例：纯逻辑层不持有文案）。
 * UI 侧一次性收口映射，避免各组件散落 switch。
 */
export const LEARN_FAILURE_REASON_KEYS: Record<LearnFailureReason, string> = {
  'login-required': 'sidepanel.learn.reasonLoginRequired',
  captcha: 'sidepanel.learn.reasonCaptcha',
  'permission-denied': 'sidepanel.learn.reasonPermissionDenied',
  'target-missing': 'sidepanel.learn.reasonTargetMissing',
  'flow-broken': 'sidepanel.learn.reasonFlowBroken',
  'locator-unstable': 'sidepanel.learn.reasonLocatorUnstable',
  'page-unreachable': 'sidepanel.learn.reasonPageUnreachable',
  timeout: 'sidepanel.learn.reasonTimeout',
  other: 'sidepanel.learn.reasonOther',
};

// ──── 回执对账（submit_skill / submit_validation 的返回体防御） ────
// 工具层已做参数级校验，但工具无法感知本次学习的配置。编排层在事件流里
// 捕获回执时调用本组纯函数：形态（能不能信）与语义（和配置是否一致）
// 都在这里收口，修正项由调用方记日志，便于回溯模型偏差。

/**
 * 视觉能力工具 ID（文本模式技能不得依赖；与 submit_skill 的拒绝口径同源）。
 * 含截图与 OCR：文本执行面没有这些能力，写进 allowedTools 会让技能
 * 在目标智能体上匹配到不存在的工具。
 */
export function isVisualSkillTool(toolId: string): boolean {
  return toolId.startsWith('vision_') || toolId === 'screenshot' || toolId === 'ocr';
}

/** 学习内部工具（提交/验收的终止信号，绝不属于任何技能的执行能力） */
function isLearnInternalTool(toolId: string): boolean {
  return toolId === 'submit_skill' || toolId === 'submit_validation';
}

/**
 * 运行期形态守卫：非对象 / 关键字段缺失或类型不符的回执一律拒绝
 * （宁可走「无产出」分支并记日志，也不带着坏对象前进）。
 * 成功路径的回执由本域工具构造，正常不会触发；此守卫针对的是
 * 事件流里 `data.draft` / `data.report` 这类「任何成功工具都可能携带」
 * 的弱类型出口。
 *
 * 长度与数量上限一并校验（与工具层同一份常量）：守卫是编排层与弱类型出口
 * 之间的最后一道闸门，放行一个超长正文会让它被原样写入跨页存储，
 * 在浏览器配额里挤掉真正该留的数据。
 */
export function asSkillDraft(value: unknown): SkillDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const draft = value as Partial<SkillDraft>;
  if (typeof draft.name !== 'string' || !draft.name) return null;
  if (draft.name.length > SKILL_NAME_MAX_CHARS) return null;
  if (typeof draft.description !== 'string' || typeof draft.category !== 'string') return null;
  if (draft.description.length > SKILL_DESCRIPTION_MAX_CHARS) return null;
  if (typeof draft.body !== 'string' || !draft.body) return null;
  if (draft.body.length > SKILL_BODY_MAX_CHARS) return null;
  if (draft.mode !== 'text' && draft.mode !== 'vision') return null;
  if (!Array.isArray(draft.allowedTools) || !draft.allowedTools.every(id => typeof id === 'string')) return null;
  if (!Array.isArray(draft.tags) || !draft.tags.every(tag => typeof tag === 'string')) return null;
  if (draft.tags.length > SKILL_MAX_TAGS) return null;
  // summary 可选：存在时必须是字符串（形态不符直接拒绝，不做静默丢弃）
  if (draft.summary !== undefined && typeof draft.summary !== 'string') return null;
  return draft as SkillDraft;
}

/** 同 asSkillDraft：验收报告的形态守卫（passed 必须是布尔、issues 必须是字符串数组） */
export function asValidationReport(value: unknown): ValidationReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const report = value as Partial<ValidationReport>;
  if (typeof report.passed !== 'boolean') return null;
  if (!Array.isArray(report.issues)) return null;
  return {
    passed: report.passed,
    issues: report.issues.filter((issue): issue is string => typeof issue === 'string'),
    ...(typeof report.score === 'number' && Number.isFinite(report.score) ? { score: report.score } : {}),
    ...(typeof report.summary === 'string' ? { summary: report.summary } : {}),
  };
}

/**
 * 失败报告的形态守卫（submit_skill 以 status=failed/blocked 提交时的返回体）。
 *
 * 判据：reason 必须是已知机器码、detail 必须是非空字符串、findings 必须是
 * 字符串数组。缺一不可——失败报告的价值全在「说清楚了」，缺字段的报告和
 * 没有报告一样没用，宁可按无产出处理也不要放行半截描述。
 */
export function asLearnFailureReport(value: unknown): LearnFailureReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const report = value as Partial<LearnFailureReport>;
  if (typeof report.reason !== 'string') return null;
  if (!(LEARN_FAILURE_REASONS as readonly string[]).includes(report.reason)) return null;
  if (typeof report.detail !== 'string' || !report.detail.trim()) return null;
  if (!Array.isArray(report.findings) || !report.findings.every(item => typeof item === 'string')) {
    return null;
  }
  return {
    reason: report.reason as LearnFailureReason,
    detail: report.detail.trim(),
    findings: report.findings.map(item => item.trim()).filter(Boolean),
    ...(typeof report.suggestion === 'string' && report.suggestion.trim()
      ? { suggestion: report.suggestion.trim() }
      : {}),
  };
}

/**
 * 草稿与目标操作模式对账（防御「模型提交的 mode / 工具与配置不一致」）：
 * - mode ≠ targetMode：就地纠正，并同步纠正 tags 中的模式标签
 *   （否则文本目标可能落下一个带「视觉模式」标签、可声明视觉工具的技能）；
 * - 文本目标混入视觉工具 / 学习内部工具：剥离；
 * - 剥离后 allowedTools 为空：返回 null（技能不可执行，按无产出处理）；
 * - tags 超上限或缺正确模式标签：补齐并截断。
 * 修正项由调用方 console.warn 记录。入参应先经 asSkillDraft 形态守卫。
 */
export function reconcileSkillDraft(draft: SkillDraft, targetMode: LearnTargetMode): SkillDraft | null {
  const correctTag = SKILL_MODE_TAG[targetMode];
  const allModeTags = Object.values(SKILL_MODE_TAG);
  const hasWrongTag = draft.tags.some(tag => allModeTags.includes(tag) && tag !== correctTag);
  const needsTagFix = draft.mode !== targetMode || hasWrongTag || !draft.tags.includes(correctTag);

  let tags = draft.tags;
  if (needsTagFix) {
    tags = [...draft.tags.filter(tag => !allModeTags.includes(tag)), correctTag];
    if (tags.length > SKILL_MAX_TAGS) tags = tags.slice(-SKILL_MAX_TAGS);
  }

  let allowedTools = [...new Set(draft.allowedTools)];
  const disallowed = (id: string): boolean =>
    isLearnInternalTool(id) || (targetMode === 'text' && isVisualSkillTool(id));
  allowedTools = allowedTools.filter(id => !disallowed(id));
  if (allowedTools.length === 0) return null;

  return { ...draft, mode: targetMode, tags, allowedTools };
}
