/**
 * 视觉能力守卫（模型 / 智能体 / 图片附件 三方一致性判定的单一事实源）
 *
 * 背景：系统的「视觉能力」由三方共同决定，任何一方缺失都会让视觉相关
 * 的交互退化或失败：
 *
 *   1. **模型**：渠道内模型行的「视觉」声明（ModelOption.vision）。
 *      未声明视觉 → 协议层无法承载 image_url（prepareVisionRequest 抛
 *      PermanentRequestError），带图请求必然失败。
 *   2. **智能体**：AgentConfig.vision 存在 → 该智能体开启视觉循环
 *      （准备阶段自动截屏、工具面含 vision_gui 等）。视觉智能体在无视觉
 *      模型下运行：截图会作为图片部件发给模型 → 模型认不出 → 循环失效。
 *   3. **图片附件**：用户上传的图片需要视觉模型才能被理解。
 *
 * 三条交互链路（上传图片 / 切换模型 / 选择智能体）都必须在动作发生前
 * 提示用户。本模块只做**判定与提示内容构造**，不涉及 UI 与副作用，
 * 便于单测与复用。
 *
 * 设计约定：
 *   - 判定是**纯函数**，输入显式、输出确定；不做任何 IO。
 *   - 「需要提示」与「阻断」分离：本模块只回答「是否需要提示、提示什么」，
 *     是否放行由调用方决定（用户已明确选择「仍然上传/仍然切换/仍然选中」
 *     时一律放行，不再二次阻断）。
 *   - 模型无视觉时，**任何**涉及图片或视觉智能体的组合都需要提示；
 *     反之（模型有视觉）一律无需提示——不制造无谓的打扰。
 */

/** 视觉能力判定输入（三方状态） */
export interface VisionCapabilityContext {
  /** 当前/目标模型是否声明视觉能力（渠道内模型行的视觉开关） */
  modelHasVision: boolean;
  /** 模型展示名（提示文案用；空串 = 未配置/未知） */
  modelLabel?: string;
  /** 本轮待发送附件中的图片数量 */
  pendingImageCount?: number;
  /** 历史会话中用户上传的图片数量（0 = 无） */
  historyImageCount?: number;
  /** 当前选中的智能体是否开启视觉循环（AgentConfig.vision 存在） */
  agentHasVision?: boolean;
  /** 当前选中的智能体展示名（提示文案用） */
  agentLabel?: string;
}

/**
 * 判定上下文（判定入口回填计数后的形态）。
 *
 * 与输入形态分离：`imageCount` 由判定入口统一计算（本轮 + 历史），
 * 文案工厂据此描述上下文规模——避免各处自行相加导致口径漂移。
 */
export interface VisionGuardContext extends VisionCapabilityContext {
  /** 涉及图片的总数量（本轮待发送 + 历史用户上传） */
  imageCount: number;
}

/** 提示场景（三条交互链路的语义区分） */
export type VisionGuardScenario =
  /** 上传图片：模型无视觉能力 */
  | 'upload-image'
  /** 切换模型：目标模型无视觉能力，且上下文存在图片/视觉智能体 */
  | 'switch-model'
  /** 选择智能体：模型无视觉能力，且所选智能体需要视觉 */
  | 'select-agent';

/** 判定结论 */
export interface VisionGuardVerdict {
  /** 是否需要向用户提示 */
  needsWarning: boolean;
  /** 提示场景（needsWarning 为 false 时为 null） */
  scenario: VisionGuardScenario | null;
  /** 提示正文（needsWarning 为 false 时为空串） */
  message: string;
  /** 涉及图片的总数量（本轮 + 历史；用于文案与后续行为） */
  imageCount: number;
}

/**
 * 场景判定（是否需要提示）。
 *
 * 纯判定，不含文案——文案由调用方按 i18n 键构造（保持 i18n 单一事实源）。
 */
export function needsVisionWarning(
  scenario: VisionGuardScenario,
  context: VisionCapabilityContext,
): boolean {
  if (context.modelHasVision) return false;
  switch (scenario) {
    case 'upload-image':
      // 上传图片本身即触发提示（用户正要引入图片）
      return true;
    case 'switch-model':
      // 切换到无视觉模型时，仅当上下文确有图片或视觉智能体才提示
      return (
        (context.pendingImageCount ?? 0) > 0 ||
        (context.historyImageCount ?? 0) > 0 ||
        context.agentHasVision === true
      );
    case 'select-agent':
      // 选中视觉智能体时提示（视觉循环必然要发图给模型）
      return context.agentHasVision === true;
    default: {
      // 未知场景保守提示（防御：新增场景漏实现时不静默放过）
      return true;
    }
  }
}

/**
 * 判定并构造提示结论。
 *
 * 文案由调用方经 messageFactory 按 i18n 键构造——本模块不持有任何面向
 * 用户的字符串（i18n 单一事实源，文案随语言切换即时生效）。
 *
 * @param scenario 交互场景
 * @param context 三方状态
 * @param messageFactory 文案工厂（按场景与计数构造；由调用方注入 i18n 键）
 */
export function evaluateVisionGuard(
  scenario: VisionGuardScenario,
  context: VisionCapabilityContext,
  messageFactory: (scenario: VisionGuardScenario, context: VisionGuardContext) => string,
): VisionGuardVerdict {
  const imageCount = (context.pendingImageCount ?? 0) + (context.historyImageCount ?? 0);
  // 计数回填进 context：文案工厂据此描述上下文规模（避免各处自行相加而口径漂移）
  const enriched: VisionGuardContext = { ...context, imageCount };
  if (!needsVisionWarning(scenario, enriched)) {
    return { needsWarning: false, scenario: null, message: '', imageCount };
  }
  return {
    needsWarning: true,
    scenario,
    message: messageFactory(scenario, enriched),
    imageCount,
  };
}

/**
 * 智能体是否开启视觉循环。
 *
 * 判定依据是 AgentConfig.vision 字段（存在即开启）——与运行时装配
 * （runtime-builder 的 visionOverride 三态）同源：undefined = 纯文本，
 * 对象 = 开启视觉循环。
 *
 * @param agentVision 智能体的 vision 配置（可能为 undefined / null）
 */
export function agentRequiresVision(agentVision: unknown): boolean {
  return agentVision !== undefined && agentVision !== null;
}
