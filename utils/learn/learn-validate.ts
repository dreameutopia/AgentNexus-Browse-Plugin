/**
 * 网站学习配置校验（纯逻辑层：无 I/O、无全局状态、无 Vue 依赖）
 *
 * 职责边界：只回答「这份配置能不能开始学习」以及「模型清单该怎么过滤」，
 * 不做任何副作用（不弹提示、不清选择、不写存储）——这些由 UI 层消费本层
 * 的结果后自行执行。这样校验规则可被单测穷举，UI 换形态也不影响规则。
 *
 * 三条联动规则（与产品约定一一对应）：
 *   1. 目标操作模式为 vision 时，学习策略强制收敛为 vision（没有切换余地）；
 *   2. 需要视觉的场景（目标 vision，或目标 text 但策略选了 vision）只能选
 *      「能真正接收图片」的模型——模型声明 vision 且协议能力支持图片，
 *      两者缺一不可（否则请求会在 vision.ts 处抛错，白跑一轮学习）；
 *   3. 切换学习策略会让已选模型失效，由 UI 清空并提示重选
 *      （见 shouldClearModelOnStrategyChange）。
 */

import type {
  LearnConfig,
  LearnConfigInput,
  LearnModelRef,
  LearnStrategy,
  LearnTargetMode,
  ValidatedLearnConfig,
} from './learn-types';

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
function validateGoal(raw: unknown, maxChars: number): LearnConfigErrorCode | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'goal-empty';
  if (raw.trim().length > maxChars) return 'goal-too-long';
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
