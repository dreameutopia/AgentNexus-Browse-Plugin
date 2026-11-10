/**
 * 网站学习编排状态机（use-learn-session）
 *
 * 单一职责：把「配置 → 学习 → 验证 → 落盘跳转」这条链路的状态与流转收在一处，
 * UI 只读状态、只发意图，不碰引擎；引擎只跑单轮，不感知业务阶段。
 *
 * ┌──────────┐  submitConfig   ┌────────────┐  confirmStart  ┌─────────┐
 * │ idle     │ ──────────────▶ │ configuring│ ─────────────▶ │confirming│
 * └──────────┘   (校验通过)     └────────────┘   (用户确认)    └────┬────┘
 *      ▲                              ▲                    │取消   │ 开始
 *      │ reset()                      └────────────────────┘       ▼
 *      │                                                    ┌────────────┐
 *      │            ┌────────────── 验证不通过·重新学习 ───── │ learning   │
 *      │            ▼                                       └─────┬──────┘
 *      │      ┌────────────┐   submit_skill 成功                   │
 *      │      │ validating │ ◀────────────────────────────────────┘
 *      │      └─────┬──────┘        (autoValidate=true)
 *      │            │ passed=true / 用户选「仍要创建」
 *      │            ▼
 *      │      ┌──────────┐  写草稿 + 跳 hub   ┌──────┐
 *      └──────│ drafting │ ─────────────────▶ │ done │
 *             └──────────┘                    └──────┘
 *
 * 终止路径：运行中 requestAbort() → 弹确认 → abort 引擎 → 等运行退出 →
 *          删除会话（草稿一并作废）→ reset()。**中止即整体丢弃**。
 *
 * 依赖注入：UI 事件、运行状态、会话切换、用户询问与管理中心跳转由调用方提供，
 * 其余直接使用核心引擎单例——引擎本身即
 * 全局唯一，二次注入只会制造「两个入口各持一份状态」的分裂。
 */

import { computed, ref, type Ref } from 'vue';
import type { MessageKey } from '@/utils/i18n';
import type { LocalPageGlow } from '../core/conversation/runtime-protocol';

import {
  transcriptEngine,
  runtimeBuilder,
  conversationEngine,
  sessionDeletionEngine,
  type ChatMessageRecord,
  type ContextUsage,
  type ConversationEvent,
  type RunSummary,
  type ToolApprovalRequest,
} from '@/entrypoints/sidepanel/core';
import { modelRegistry } from '@/entrypoints/sidepanel/utils/channels';
import { streamClient } from '@/entrypoints/sidepanel/utils/stream/stream-client';
import { getPresetToolIds, getSiteLearnScenario, getSiteValidateScenario, type ToolScenario } from '@/utils/tools/tool-presets';
import {
  LEARN_LIMITS,
  LEARN_DEFAULT_EXTENSION_ITERATIONS,
  isLearnRunning,
  learnDraftHash,
  type LearnConfigInput,
  type LearnFailureReport,
  type LearnFeedback,
  type LearnPhase,
  type LearnTargetMode,
  type SkillDraft,
  type ValidatedLearnConfig,
  type ValidationReport,
} from '@/utils/learn/learn-types';
import {
  validateLearnConfig,
  asSkillDraft,
  asValidationReport,
  asLearnFailureReport,
  reconcileSkillDraft,
  applyValidationRevision,
  stageRunLimits,
  isPositiveSafeInteger,
  type LearnConfigErrorCode,
  type LearnConfigField,
  type LearnModelCandidate,
  type LearnConfigValidation,
} from '@/utils/learn/learn-validate';
import {
  buildLearnPrompt,
  buildValidatePrompt,
  learnKickoffMessage,
  validateKickoffMessage,
  forceSubmitMessage,
  forceValidateMessage,
} from '@/utils/learn/learn-prompts';
import { clearLearnDraft, saveLearnDraft } from '@/utils/learn/learn-draft-store';
import { validationToolIds } from '@/utils/learn/learn-tool-policy';

// ──── 弹窗视图模型 ────

/**
 * 只读引用：状态对外暴露但禁止外部改写。
 * 不用 Vue 的 ReadonlyRef（并非所有版本都导出），结构化定义对
 * Ref / ComputedRef 双向兼容，语义与意图一样明确。
 */
type ReadonlyRef<T> = { readonly value: T };


/** 弹窗模式（每种模式对应一组确定的选项，见 LearnDialogChoice） */
export type LearnDialogMode =
  /** 开始前的二次确认（配置摘要 + 风险提示） */
  | 'start'
  /** 运行中终止确认（进度卡片） */
  | 'stop'
  /** 每次触限都明确选择继续、总结或经二次确认丢弃。 */
  | 'limitWrapUp'
  /** 验证未通过：重新学习 / 仍要创建 */
  | 'validationFail'
  /** 学习失败（模型主动提交 status=failed/blocked）：重新学习 / 结束 */
  | 'learnFailed'
  /** 不可恢复失败 */
  | 'failure'
  /** 运行正常结束但没有产出（模型未调用 submit_skill） */
  | 'noDraft';

/** 弹窗视图（组件按 mode 分支渲染；payload 随模式确定） */
export type LearnDialogView =
  | { mode: 'start'; config: ValidatedLearnConfig; modelLabel: string }
  | { mode: 'stop'; phase: 'learning' | 'validating'; elapsedMs: number; toolCalls: number; fromLimit?: boolean }
  | { mode: 'limitWrapUp'; phase: 'learning' | 'validating'; reason: 'max-iterations' | 'max-duration' | 'tool-failures'; iterations: number; minutes: number; extraIterations: number }
  | { mode: 'validationFail'; report: ValidationReport }
  | { mode: 'learnFailed'; report: LearnFailureReport; stage: 'learning' | 'validating' }
  | { mode: 'failure'; title: string; message: string }
  | { mode: 'noDraft'; reason: string };

/** 各模式合法选择（全集；各模式只接受自己的子集，answerDialog 会校验） */
export type LearnDialogChoice =
  | 'confirm'
  | 'cancel'
  | 'extend'
  | 'summarize'
  | 'discard'
  | 'relearn'
  | 'create'
  | 'retry'
  | 'giveUp'
  | 'ok';

/** 各模式合法选择（非法选择绝不静默执行意外分支，见 answerDialog） */
const DIALOG_CHOICES: Record<LearnDialogMode, readonly LearnDialogChoice[]> = {
  start: ['confirm', 'cancel'],
  stop: ['confirm', 'cancel'],
  limitWrapUp: ['extend', 'summarize', 'discard'],
  validationFail: ['relearn', 'create'],
  learnFailed: ['relearn', 'create', 'giveUp'],
  failure: ['ok'],
  noDraft: ['retry', 'giveUp'],
};

/**
 * 弹窗态 → 合法选择（按态而非仅按 mode 分叉）。
 *
 * learnFailed 的合法选择随阶段而变，理由是**成果保全**：
 * - 学习阶段失败：此时还没有草稿，「结束」= 放弃本次学习，无可交付之物；
 * - 验证阶段失败：草稿已经学成并持有，「放弃」会白白丢掉它——该阶段只提供
 *   「重新验证」与「仍要创建」（把草稿交付出去），不提供丢弃。
 * 静态表只给出各 mode 的全集，真正的判定在此按态收敛。
 */
function allowedChoices(view: LearnDialogView): readonly LearnDialogChoice[] {
  if (view.mode === 'learnFailed') {
    return view.stage === 'validating' ? ['relearn', 'create'] : ['relearn', 'giveUp'];
  }
  return DIALOG_CHOICES[view.mode];
}

/**
 * 各模式在「弹窗被顶替 / 状态被重置」时的收敛值。
 *
 * 场景：新弹窗要替换旧弹窗（如用户点终止的瞬间运行恰好结束、post-run 弹窗
 * 顶掉 stop 弹窗），或 reset() 清空状态时仍有 await askDialog 挂起——
 * 旧等待者必须被结算，否则其 await 永久悬挂、状态机卡死。
 *
 * 收敛值取「不替用户做选择」的方向：尽量不擅自重启、不擅自追加轮次。
 * 但**成果保全优先于不推进**：当阶段已经持有草稿时，丢弃是不可逆的损失，
 * 而把草稿交付到管理中心只是打开一个预填表单（用户不点确认就不会建技能），
 * 是可逆的。因此验证相关弹窗的收敛值统一取 'create'（交付草稿）。
 */
const DIALOG_SETTLE_VALUE: Record<LearnDialogMode, LearnDialogChoice> = {
  start: 'cancel',
  stop: 'cancel',
  limitWrapUp: 'cancel',
  validationFail: 'create',
  learnFailed: 'giveUp',
  failure: 'ok',
  noDraft: 'giveUp',
};

/**
 * 弹窗态 → 收敛值（按态分叉：learnFailed 的验证阶段要保住草稿）。
 *
 * learnFailed 在验证阶段持有草稿，收敛值必须是 'create'（交付）而不是
 * 'giveUp'（放弃）——'giveUp' 走的分支会 reset 掉 draft，等于白丢一次学习。
 */
function settleValueFor(view: LearnDialogView): LearnDialogChoice {
  if (view.mode === 'learnFailed') {
    return view.stage === 'validating' ? 'create' : 'giveUp';
  }
  return DIALOG_SETTLE_VALUE[view.mode];
}

// ──── 视觉循环配置（与视觉通用助手预设同构） ────

/**
 * 学习 / 验证中需要视觉时的运行配置。
 * 引擎据此在每轮开始与每次工具成功后自动截图并注入多模态截图消息——
 * 自动截图不消耗模型的工具调用轮次。视觉组合的工具面仍会携带 screenshot
 * 工具（见 tool-presets 组合口径）：截图失效时模型可主动调用它恢复观察；
 * 坐标手势工具（vision_gui）只出现在视觉目标组合。
 */
const LEARN_VISION_RUNTIME = {
  screenshotTool: 'screenshot' as const,
  screenshotArgs: {},
  reScreenshotAfterTools: true,
};

/**
 * 强制收尾轮的运行预算。
 *
 * 收尾轮只干一件事——把终态交出来。它不该再展开探索（否则一轮探索可能
 * 再烧掉几十轮 token，最后还是空手而归），所以轮数与时长都比正常学习
 * 段紧一档：给模型写草稿/失败报告的余量是够的，再放开就没有约束力了。
 */
const LEARN_FORCE_SUBMIT_LIMITS = {
  maxIterations: 8,
  maxDurationMs: 5 * 60 * 1000,
} as const;

/**
 * 收尾轮携带的历史记录上限（条）。
 *
 * 收尾轮只需要「模型刚才探索到了什么」，不需要从头重读全部过程：条数越多，
 * 上下文越重（视觉模式每轮还带一张截图），越容易顶满模型窗口反而把收尾轮
 * 挤掉。取最近若干条即可——它们包含最新一轮的笔记与结论。
 */
const LEARN_FORCE_SUBMIT_HISTORY = 16;

/**
 * 「装配完成但用户已要求终止」的专用异常。
 *
 * 与普通运行错误区分开：这不是失败，只是**不该开始**——会话即将被删除，
 * 此时启动运行只会写出孤儿记录。编排层据此静默收敛，不弹失败弹窗。
 */
class LearnRunAbortedError extends Error {
  constructor() {
    super('学习运行在启动前被终止');
    this.name = 'LearnRunAbortedError';
  }
}

// ──── 注入依赖 ────

export interface LearnSessionDeps {
  beginPageGlow?: () => LocalPageGlow | undefined;
  /** 转发给 UI 的会话事件（App 的 handleConversationEvent） */
  observer: (event: ConversationEvent) => void;
  /** 系统提示条（配置切换、降级提示等） */
  notify: (text: string) => void;
  /** 从欢迎页切入聊天页 */
  showChat: () => void;
  /** 把 UI 焦点切到指定会话（学习会话创建后） */
  setActiveChat: (chatId: string) => void;
  /** 本地学习引擎的运行生命周期（不经过普通发送入口和后台 onSettled） */
  setResponding: (chatId: string, responding: boolean) => void;
  /** 与普通会话共用工具审批 UI，返回用户真实选择。 */
  requestToolApproval: (request: ToolApprovalRequest) => Promise<boolean>;
  /** 运行退出/终止时收敛本会话挂起的审批及 interact 询问。 */
  dismissQuestions: (chatId: string) => void;
  /** 打开管理中心（跳 hub，携带深链 hash）；返回是否成功打开（失败由编排层降级提示） */
  openHub: (hash: string) => boolean | Promise<boolean>;
  /**
   * 文案翻译。key 用 MessageKey 而非 string：所有学习文案在编译期即校验，
   * 拼错 key 立刻报错而不是运行时回落成 key 原文。
   */
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
}

/** 对外 API（App.vue 消费的全部状态与动作；内部状态 config/draft/report 等不外露） */
export interface LearnSessionApi {
  phase: ReadonlyRef<LearnPhase>;
  errors: ReadonlyRef<Partial<Record<LearnConfigField, LearnConfigErrorCode>>>;
  dialog: Ref<LearnDialogView | null>;
  /** 已运行时长（毫秒；未运行为 0） */
  elapsedMs: ReadonlyRef<number>;
  /** 本阶段已发起的工具调用数（状态条展示） */
  toolCalls: ReadonlyRef<number>;
  /**
   * 本阶段最近一次请求的真实上下文用量（引擎每轮测量经 context-usage 事件
   * 外发，与普通对话的用量环同一数据源）。学习运行期间底部工具栏隐藏，
   * 用量环不可见——状态条据此呈现「距离阈值还有多远」，压缩触发前用户
   * 可预判长任务的窗口压力。null = 尚未发起任何请求。
   */
  contextUsage: ReadonlyRef<ContextUsage | null>;
  /** 是否处于学习态（含配置与收尾——这些阶段同样不接受普通输入） */
  isLearnActive: ReadonlyRef<boolean>;
  /** 是否正在运行（决定是否显示终止按钮） */
  isLearnRunning: ReadonlyRef<boolean>;
  /**
   * 当前是否处于「强制收尾轮」（模型没交终态，编排层补跑的一轮）。
   * 状态条据此说明「为什么又多跑了一轮」，避免用户以为界面卡住。
   */
  isForceSubmitting: ReadonlyRef<boolean>;
  /** 配置面板表单重置纪元（openModal 递增；「返回修改」不递增以保留输入） */
  formEpoch: ReadonlyRef<number>;
  /** 草稿暂存失败的降级说明是否待展示（收尾阶段置位，用户确认后清除） */
  degradedNotice: ReadonlyRef<boolean>;
  recovery: ReadonlyRef<{ chatId: string; draft: SkillDraft } | null>;
  /** 关闭降级说明弹窗 */
  dismissDegradedNotice: () => void;

  /** 模型候选（按当前配置实时过滤；下拉数据源） */
  modelCandidates: ReadonlyRef<LearnModelCandidate[]>;

  openModal: () => void;
  closeModal: () => void;
  /** 收集到的原始配置 → 校验 → 进入二次确认；返回是否通过 */
  submitConfig: (raw: LearnConfigInput) => boolean;
  /** 终止运行（弹确认 → abort → 清理） */
  requestAbort: () => Promise<void>;
  /** 响应弹窗选择 */
  answerDialog: (choice: LearnDialogChoice, extraIterations?: number) => void;
  /** 中止 / 整体丢弃的清理入口（会话被删除等外部触发时调用）：
   *  先 abort 等本轮 run 干净退出（转录仍在）→ 再级联删除 → 清草稿与状态。
   *  与 requestAbort 的确认后路径同源，只是不弹终止确认 */
  cleanupSession: () => Promise<void>;
  /** 刷新模型候选（用户从设置弹窗返回时调用——清单可能已变化） */
  refreshModels: () => void;
}

export function useLearnSession(deps: LearnSessionDeps): LearnSessionApi {
  // ──── 状态 ────
  const phase = ref<LearnPhase>('idle');
  const config = ref<ValidatedLearnConfig | null>(null);
  const draft = ref<SkillDraft | null>(null);
  const report = ref<ValidationReport | null>(null);
  const errors = ref<Partial<Record<LearnConfigField, LearnConfigErrorCode>>>({});
  const dialog = ref<LearnDialogView | null>(null);
  const sessionChatId = ref('');
  const elapsedMs = ref(0);
  const toolCalls = ref(0);
  /** 本阶段真实上下文用量（引擎 context-usage 事件驱动；阶段开始时复位） */
  const contextUsage = ref<ContextUsage | null>(null);
  /**
   * 配置面板表单重置纪元：openModal（新的学习意图）递增，组件 watch 它清空表单；
   * 「返回修改」（confirming → configuring）不递增——用户点返回是为了改内容，
   * 不是重来，清空输入违背按钮文案的承诺。
   */
  const formEpoch = ref(0);

  /** 运行中会话的模型候选快照（进入配置面板时刷新） */
  const allCandidates = ref<LearnModelCandidate[]>([]);
  /** 草稿暂存失败的降级说明：仅在收尾阶段因失败而置位，用户确认后清除 */
  const degradedNotice = ref(false);
  /** 强制收尾轮进行中（状态条据此给出说明） */
  const forceSubmitting = ref(false);
  /**
   * 学习失败报告（模型以 status=failed/blocked 提交的终态）。
   * 与 draft 互斥：终态工具一次只产出其一——要么交技能草稿，要么交失败原因。
   */
  const failure = ref<LearnFailureReport | null>(null);

  // ──── 运行期私有状态 ────
  /** 当前在跑的 run Promise（终止时需等待其干净退出） */
  let activeRun: Promise<RunSummary> | null = null;
  let activeGlow: LocalPageGlow | undefined;
  /** 用户已请求终止：post-run 一律不再推进业务（清理由 requestAbort 负责） */
  let aborting = false;
  /**
   * 终止流程进行中（用户点「终止」→ 清理完成）。
   *
   * 独立于 aborting：终止确认弹窗会顶替在场的运行中弹窗（收尾守卫弹窗），
   * 引擎随即因该弹窗被结算而停下——此刻尚未真正 abort，编排层必须知道
   * 「这次停止是终止流程造成的」，不要再推进任何业务分支（不要再弹失败
   * 结论、不要补跑收尾轮），否则两个弹窗会叠加、状态机会走偏。
   */
  let terminating = false;
  /**
   * 用户已明确决定结束本阶段运行（收尾弹窗选「直接结束」/ 终止流程顶替弹窗）。
   *
   * 置位后编排层**不再补跑收尾轮**：「终态必须被调用」的兜底不能覆盖用户的
   * 明确决定——用户说停就停，接下来走失败路径给出确定结论即可。
   */
  let runEndedByUser = false;
  /** 轮数上限的收尾机会每次阶段运行只给一次（runPhase 起始复位） */
  let limitAction: 'summarize' | 'discard' | null = null;
  // 重新学习需携带上一轮的反馈（盲测问题清单 或 学习失败报告）；
  // 不能清空报告后重复同一份失败技能。
  let learningFeedback: LearnFeedback | null = null;
  /** 弹窗应答器 */
  let resolveDialog: ((choice: LearnDialogChoice) => void) | null = null;
  /** 运行计时器 */
  let tickTimer: number | null = null;
  let startedAt = 0;

  // ──── 派生 ────
  // 学习态 = 配置与运行期间（不接受普通输入）；'done' 是交付后的静止态，
  // 此时输入区恢复正常——用户可以继续在该会话里对话
  const isLearnActive = computed(() => phase.value !== 'idle' && phase.value !== 'done');
  const isLearnRunningFlag = computed(() => isLearnRunning(phase.value));

  /** 下拉数据源：全部可选模型（面板内按当前表单状态自行过滤，见 learn-validate 的纯函数） */
  const modelCandidates = computed<LearnModelCandidate[]>(() => [...allCandidates.value]);

  // ──── 弹窗原语 ────

  /**
   * 打开确认弹窗并等待选择。
   * 单槽防御：新弹窗顶替旧弹窗时（真实时序：用户点终止的瞬间运行恰好结束，
   * post-run 弹窗要顶掉 stop 弹窗），旧等待者先按该模式的收敛值结算——
   * 悬挂的 await 会让状态机永久卡死，收敛值绝不推进业务（见 DIALOG_SETTLE_VALUE）。
   */
  function askDialog(view: LearnDialogView): Promise<LearnDialogChoice> {
    return new Promise<LearnDialogChoice>(resolve => {
      const superseded = resolveDialog;
      const supersededView = dialog.value;
      if (superseded && supersededView) {
        console.warn('[LearnSession] 弹窗被顶替:', supersededView.mode, '→', view.mode);
        superseded(settleValueFor(supersededView));
      }
      resolveDialog = resolve;
      dialog.value = view;
    });
  }

  /**
   * 结算弹窗（关闭并唤醒等待者）。
   * @returns 选择是否被接受；非法选择被忽略且弹窗保持打开——
   *          用户必须从合法选项中做出选择，绝不因错发事件推进流程。
   */
  function answerDialog(choice: LearnDialogChoice, extraIterations?: number): boolean {
    const resolver = resolveDialog;
    const current = dialog.value;
    if (!resolver || !current) return false;
    const allowed = allowedChoices(current);
    if (!allowed.includes(choice)) {
      console.warn('[LearnSession] 非法弹窗选择被忽略:', current.mode, choice);
      return false;
    }
    if (current.mode === 'limitWrapUp' && choice === 'extend') {
      if (!isPositiveSafeInteger(extraIterations)) return false;
      current.extraIterations = extraIterations;
    }
    resolveDialog = null;
    dialog.value = null;
    resolver(choice);
    return true;
  }

  /**
   * 结算当前在场的弹窗（按给定值或该模式的收敛值），返回是否确实结算了一扇。
   *
   * 用途：程序性收敛——终止流程要顶替在场的运行中弹窗、reset 要唤醒悬挂的
   * 等待者。两者都走同一个「结算并唤醒」的原语，避免两处各写一套而漏掉
   * 「先清 resolver 再清 dialog」的顺序（顺序错了会让旧等待者永久悬挂）。
   */
  function settleDialog(settleValue?: LearnDialogChoice): boolean {
    const resolver = resolveDialog;
    const current = dialog.value;
    if (!resolver || !current) return false;
    resolveDialog = null;
    dialog.value = null;
    resolver(settleValue ?? settleValueFor(current));
    return true;
  }

  // ──── 模型候选 ────

  function refreshModelCandidates(): void {
    try {
      // 直接读注册表的响应式清单（与可用性判定同源），不再自行过滤
      allCandidates.value = modelRegistry.options.map(option => ({
        key: option.key,
        ref: option.ref,
        label: option.label,
        channelName: option.channelName,
        // 双重判定：模型声明支持图片 + 该协议适配器确实支持（缺一则请求会抛错）
        canAcceptImages: option.vision && streamClient.getCapabilities(option.protocol).vision === true,
      }));
    } catch (error) {
      console.warn('[LearnSession] 读取模型清单失败:', error);
      allCandidates.value = [];
    }
  }

  // ──── 计时 ────

  function startTicker(): void {
    stopTicker();
    startedAt = Date.now();
    elapsedMs.value = 0;
    tickTimer = window.setInterval(() => {
      elapsedMs.value = Date.now() - startedAt;
    }, 1000);
  }

  function stopTicker(): void {
    if (tickTimer !== null) {
      window.clearInterval(tickTimer);
      tickTimer = null;
    }
    elapsedMs.value = 0;
  }

  // ──── 配置阶段 ────

  function openModal(): void {
    // 运行 / 配置 / 确认中不允许重复进入（并发入口会把状态机打乱）；
    // drafting 中草稿正移交 hub，重开面板会与交付流程竞争
    if (
      isLearnRunningFlag.value ||
      phase.value === 'configuring' ||
      phase.value === 'confirming' ||
      phase.value === 'drafting'
    ) {
      return;
    }
    // 'done'（上次学习已交付）残留态：进入配置即回到干净起点
    if (phase.value !== 'idle') void reset({ keepConfig: false });
    // 新的学习意图 → 递增纪元，配置面板据此清空上次输入
    formEpoch.value += 1;
    refreshModelCandidates();
    errors.value = {};
    phase.value = 'configuring';
  }

  function closeModal(): void {
    if (phase.value !== 'configuring') return;
    errors.value = {};
    phase.value = 'idle';
  }

  /** 中止 / 整体丢弃的清理入口：abort 运行 → 等其干净退出 → 级联删会话 → 清草稿与状态。
   *  顺序即正确性：先 abort → 等本轮 run 干净退出（此时转录仍在）→ 再删会话；
   *  反过来会在运行未退出时删库，让收尾 flush 写出孤儿记录。
   *  与 requestAbort 的确认后路径同源，只是不弹终止确认（调用方已做决策）。
   *  清理失败不抛错：草稿与状态仍要作废，残留孤儿记录由删除引擎兜底 */
  async function cleanupSessionImpl(): Promise<void> {
    const chatId = sessionChatId.value;
    if (!chatId) return;
    aborting = true;
    terminating = true;
    try {
      deps.dismissQuestions(chatId);
      activeGlow?.stop();
      conversationEngine.abort(chatId);
      if (activeRun) await activeRun.catch(() => undefined);
      activeRun = null;
      await sessionDeletionEngine.deleteSession(chatId);
    } catch (error) {
      console.error('[LearnSession] 终止清理失败:', error);
    } finally {
      // 中止即整体丢弃：草稿、报告、会话一并作废
      try { await clearLearnDraft(chatId); }
      catch (error) { console.warn('[LearnSession] 成果清理失败，已保留备份:', error); }
      finally { await reset({ keepConfig: false }); }
    }
  }

  function submitConfig(raw: LearnConfigInput): boolean {
    refreshModelCandidates();
    const result: LearnConfigValidation = validateLearnConfig(raw, allCandidates.value);
    if (!result.ok) {
      errors.value = result.errors;
      return false;
    }
    errors.value = {};
    config.value = result.config;
    draft.value = null;
    report.value = null;
    failure.value = null;
    // 上次收尾遗留的降级说明随新一轮配置一并清掉：它属于上一次交付，
    // 挂在这里会让用户以为本次学习还没开始就已「成果丢失」
    degradedNotice.value = false;
    phase.value = 'confirming';
    // 解析模型展示名：确认卡要显示人可读名称，而不是 channelId/modelId 一串 id
    const matched = allCandidates.value.find(
      candidate =>
        candidate.ref.channelId === result.config.modelRef.channelId &&
        candidate.ref.modelId === result.config.modelRef.modelId,
    );
    void askDialog({
      mode: 'start',
      config: result.config,
      modelLabel: matched ? `${matched.label}${matched.channelName ? ` · ${matched.channelName}` : ''}` : '',
    }).then(choice => {
      // UI 驱动的应答由 handleDialogChoice 处理；此续体只兜底「弹窗被顶替 /
      // 被 reset 程序性收敛」的路径——若 phase 仍停在 confirming（无人接手），
      // 退回配置面板，绝不让状态死锁在弹窗已消失的中间态
      if (choice !== 'confirm' && phase.value === 'confirming') {
        phase.value = 'configuring';
      }
    });
    return true;
  }

  // ──── 运行 ────

  /** 场景 → 工具组（学习按目标模式×策略、验证只按目标模式，两者严格分离） */
  function scenarioFor(kind: 'learning' | 'validating'): ToolScenario {
    const cfg = config.value!;
    if (kind === 'learning') return getSiteLearnScenario(cfg);
    return getSiteValidateScenario(cfg.targetMode);
  }

  /** 该阶段是否需要视觉循环（学习看策略、验证看目标模式）。
   *  文本目标 × 视觉策略同样启用：自动截图仅用于帮助理解屏幕元素，
   *  该组合的工具面没有 vision_gui（见 tool-presets 的组合口径）。 */
  function visionFor(kind: 'learning' | 'validating'): boolean {
    const cfg = config.value!;
    return kind === 'learning' ? cfg.strategy === 'vision' : cfg.targetMode === 'vision';
  }

  /**
   * 事件观察者包装：转发给 UI 之外，捕获终止型工具的产出。
   * 按会话 id 过滤，避免把其它会话的提交误认为本阶段产出。
   * 回执先过形态守卫（asSkillDraft / asValidationReport / asLearnFailureReport），
   * 学习回执再与目标模式对账（reconcileSkillDraft）——模型可能提交与配置不一致的
   * mode / 工具，不修正就会落下一个错误模式标签或依赖视觉工具的文本技能。
   *
   * 学习段的终态有两种：草稿（data.draft）与失败报告（data.failure）。
   * 二者互斥——先到的那个即本次学习的终态，后到的忽略（终态工具一次只产出其一）。
   */
  function makeObserver(kind: 'learning' | 'validating', targetMode: LearnTargetMode) {
    const chatId = sessionChatId.value;
    const calls = new Map<string, string>();
    return (event: ConversationEvent): void => {
      deps.observer(event);
      // 用量快照先于阶段门过滤：它是引擎对「最近一次真实请求负载」的客观陈述，
      // 与业务阶段流转（弹窗顶替、收尾轮切换）无关；按会话过滤防跨会话串扰。
      if (event.type === 'context-usage' && event.chatId === chatId) {
        contextUsage.value = event.usage;
      }
      if (event.chatId !== chatId || phase.value !== kind || aborting || terminating) return;
      if (event.type === 'tool-call') {
        toolCalls.value += 1;
        calls.set(event.call.id, event.call.name);
      }
      if (event.type !== 'tool-result' || event.status !== 'success') return;
      // Page data may contain draft/report-shaped objects; only the stage's terminal tool owns them.
      const expected = kind === 'learning' ? 'submit_skill' : 'submit_validation';
      if (calls.get(event.callId) !== expected) return;
      calls.delete(event.callId);
      if (kind === 'learning' ? draft.value || failure.value : report.value) return;
      const data = (event.result as { data?: Record<string, unknown> } | undefined)?.data;
      if (!data) return;
      if (kind === 'learning' && data.draft) {
        const rawDraft = asSkillDraft(data.draft);
        const reconciled = rawDraft ? reconcileSkillDraft(rawDraft, targetMode) : null;
        if (!reconciled) {
          // 形态非法或剥离阶段外工具后无可用工具：按无产出处理（noDraft 分支给重试）
          console.warn('[LearnSession] submit_skill 回执形态非法或无法对账，按无产出处理:', data.draft);
          return;
        }
        if (rawDraft) {
          const fixes: string[] = [];
          if (rawDraft.mode !== reconciled.mode) fixes.push(`mode ${rawDraft.mode} → ${reconciled.mode}`);
          if (rawDraft.tags.join(' ') !== reconciled.tags.join(' ')) fixes.push('tags 模式标签已纠正');
          if (rawDraft.allowedTools.length !== reconciled.allowedTools.length) fixes.push('allowedTools 已剥离阶段外工具');
          if (fixes.length > 0) console.warn('[LearnSession] submit_skill 回执与配置不一致，已对账修正:', fixes.join('；'));
        }
        draft.value = reconciled;
        // 草稿随消息回放（降级兜底）：把提交体持久化到会话补充段。
        // 暂存（chrome.storage）失败或管理中心未打开时，成果不再只活在内存里——
        // 重新打开该会话即可从消息里取回，这是「草稿暂存失败」降级承诺的兑现
        // （正常路径也写：跨页交接与回放互不影响，见 setSystemPromptSuffix 注释）
        void transcriptEngine.setSystemPromptSuffix(chatId, JSON.stringify(reconciled))
          .catch(error => console.warn('[LearnSession] 草稿回放存储失败:', error));
      } else if (kind === 'learning' && data.failure) {
        // 失败终态：模型以 status=failed/blocked 提交，原因已定位。
        // 形态非法按无产出处理（走强制收尾轮，模型还有机会重提一次）。
        const parsed = asLearnFailureReport(data.failure);
        if (!parsed) {
          console.warn('[LearnSession] submit_skill 失败回执形态非法，按未提交处理:', data.failure);
          return;
        }
        failure.value = parsed;
      } else if (kind === 'validating' && data.report) {
        const parsed = asValidationReport(data.report);
        if (!parsed) {
          console.warn('[LearnSession] submit_validation 回执形态非法，按无产出处理:', data.report);
          return;
        }
        if (parsed.revision) {
          if (!draft.value) return;
          draft.value = applyValidationRevision(draft.value, parsed);
          void transcriptEngine.setSystemPromptSuffix(chatId, JSON.stringify(draft.value))
            .catch(error => console.warn('[LearnSession] 修订草稿回放存储失败:', error));
        }
        report.value = parsed;
      }
    };
  }

  /**
   * 跑一次引擎（一个阶段的一次运行），返回原始运行结果。
   *
   * 与业务分流解耦：终态判定（草稿 / 失败报告 / 都没交）由调用方读状态做，
   * 这里只负责「跑一次」并如实报告跑成什么样。
   *
   * 强制收尾轮（forceSubmit）与普通轮的两点差异：
   *   1. 首轮消息换成「立即交终态」的纠正指令；
   *   2. **携带本次探索的历史**——冷启动的收尾轮会从头再摸索一遍，
   *      很可能再次空手而归；带上自己的探索痕迹，模型才能把已知的
   *      线索直接写成草稿或失败报告。验证段只携带本次验证产生的记录，
   *      不携带学习段或先前尝试的历史。
   * 收尾轮另有更紧的轮数预算（只用于收尾，不允许再展开探索）。
   */
  async function runEngineOnce(
    kind: 'learning' | 'validating',
    options?: {
      forceSubmit?: boolean;
      priorRecords?: ChatMessageRecord[];
      contextSummary?: string;
      contextSummaryAt?: number;
    },
  ): Promise<RunSummary> {
    const cfg = config.value!;
    const chatId = sessionChatId.value;
    const skillDraft = draft.value;
    const forceSubmit = options?.forceSubmit === true;
    limitAction = null;
    const glow = deps.beginPageGlow?.();
    activeGlow = glow;

    // 装配与运行包在同一个 promise 里：**activeRun 必须在装配开始时就占位**。
    // 否则用户在装配阶段（runtimeBuilder.build 是异步的）点终止，终止逻辑
    // 看不到任何在跑的运行，会直接删掉会话；随后装配完成、运行照常启动，
    // 在已被删除的会话上写出一批孤儿记录。
    const runPromise = (async (): Promise<RunSummary> => {
      deps.setResponding(chatId, true);
      const stageTools = kind === 'validating' ? validationToolIds(skillDraft!) : [...getPresetToolIds(scenarioFor(kind))];
      const built = await runtimeBuilder.build({
        chatId,
        userInput:
          kind === 'learning'
            ? forceSubmit
              ? forceSubmitMessage(cfg)
              : learnKickoffMessage(cfg)
            : forceSubmit
              ? forceValidateMessage(cfg, skillDraft!)
              : validateKickoffMessage(cfg, skillDraft!),
        agentName: null,
        skillNames: [],
        // 学习/盲测禁用技能发现：不注入发现清单与 load_skill，防止既有技能
        // 污染试错过程、破坏盲测，或经技能携带工具把 vision_gui 注入文本目标
        disableSkillDiscovery: true,
        modelRef: cfg.modelRef,
        extraToolIds: stageTools,
        agentSystemOverride:
          kind === 'learning' ? buildLearnPrompt(cfg, learningFeedback) : buildValidatePrompt(cfg, skillDraft!),
        // 学习/验证是长任务：覆盖默认的 20 轮 / 10 分钟；收尾轮再收紧一档
        limitsOverride: forceSubmit
          ? { ...LEARN_LIMITS, ...LEARN_FORCE_SUBMIT_LIMITS }
          : stageRunLimits(cfg, kind),
        // 视觉三态：需要时启用视觉循环，不需要时显式禁用（不继承任何智能体声明）
        visionOverride: visionFor(kind) ? LEARN_VISION_RUNTIME : null,
        // 首轮冷启动；收尾轮仅带本阶段、本次尝试的证据，防止无证据判通过。
        priorRecords: options?.priorRecords ?? [],
        // 压缩摘要（收尾轮带上，模型才看得见被压缩掉的早期探索）
        ...(options?.contextSummary
          ? { contextSummary: options.contextSummary, contextSummaryAt: options.contextSummaryAt }
          : {}),
      });
      // The null-agent fallback may add default tools. Remove them as well from
      // both advertised schemas and execution policy so they cannot mask missing dependencies.
      const ceiling = new Set(stageTools);
      const runtime = kind === 'validating' ? { ...built,
        toolIds: built.toolIds.filter(id => ceiling.has(id)),
        advertisedToolIds: (built.advertisedToolIds ?? built.toolIds).filter(id => ceiling.has(id)),
      } : built;

      // 装配期间用户可能已请求终止：此时绝不能再启动运行（会话即将被删除，
      // 启动只会写出孤儿记录）。以异常退出，交由调用方按「已终止」收敛。
      if (aborting || terminating) {
        throw new LearnRunAbortedError();
      }

      return conversationEngine.run(runtime, {
        beginPageOperation: glow?.beginPageOperation,
        observer: makeObserver(kind, cfg.targetMode),
        onLimitReached: limitKind => handleLimitReached(limitKind, runtime.limits, kind),
        resetBudgetOnContinue: true,
        onToolApproval: request => deps.requestToolApproval(request),
      });
    })();

    activeRun = runPromise;
    try {
      return await runPromise;
    } finally {
      glow?.stop();
      if (activeGlow === glow) activeGlow = undefined;
      activeRun = null;
      deps.dismissQuestions(chatId);
      deps.setResponding(chatId, false);
    }
  }

  /**
   * 跑一个阶段（学习或验证）。
   *
   * 历史口径：每阶段首次运行冷启动，验证不带学习痕迹。
   * 强制收尾轮仅携带本次、同阶段的记录和新摘要，保证答复与复核证据不丢失。
   * 转录始终连续记录，历史可回溯。
   *
   * **终态强制**：终态工具（submit_skill / submit_validation）必须被调用。
   * 引擎对「模型只回了一段文本」没有任何约束——历史上这条经常被违反，
   * 表现是运行结束但编排层拿不到任何产出，只能弹一个「可能是没调用 submit_skill」
   * 的猜测式提示。现在改成两段式：
   *   1. 正常跑完并交了终态 → 按终态分流（草稿 / 失败报告 / 验收结论）；
   *   2. 没交终态 → **自动补一轮收尾轮**（纠正指令：成功就 success，失败就 failed），
   *      不打断用户、不弹窗（用户已明确决定结束时不补跑，见 runEndedByUser）；
   *   3. 补跑后仍未交 → 以**确定的**失败原因收场，不再靠猜。
   */
  async function runPhase(kind: 'learning' | 'validating'): Promise<void> {
    const cfg = config.value;
    if (!cfg) return;
    const chatId = sessionChatId.value;
    if (!chatId) return;

    const skillDraft = draft.value;
    if (kind === 'validating' && !skillDraft) {
      // 防御：没有草稿就无法验证（正常路径不会发生，拦住以免空跑一轮）
      await handleNoDraft(kind, 'sidepanel.learn.noDraftValidating');
      return;
    }

    phase.value = kind;
    if (kind === 'validating') report.value = null;

    // 本阶段开始前的记录基线：强制收尾轮只携带**本次尝试**产生的记录，
    // 不把上一轮学习的痕迹带进来（与「重新学习」冷启动的口径一致）。
    const baselineIds = new Set<string>();
    let baselineSummary = '';
    let baselineReady = false;
    {
      try {
        const before = await transcriptEngine.getEffectiveContext(chatId);
        baselineSummary = before.summary;
        for (const record of before.records) baselineIds.add(record.id);
        baselineReady = true;
      } catch (error) {
        console.warn('[LearnSession] 读取收尾轮基线失败，按无历史处理:', error);
      }
    }

    // Normal completion without a terminal submission gets the existing recovery pass.
    // Budget guards instead wait for an explicit choice; only 'summarize' switches passes.
    let forceSubmit = false;
    while (true) {
      forceSubmitting.value = forceSubmit;
      if (!forceSubmit) {
        toolCalls.value = 0;
        // 阶段计量复位：上一阶段（含失败重学）的用量不属于本阶段，
        // 残留数字会让状态条在首轮请求前误报窗口压力
        contextUsage.value = null;
        // 用户决定标记按阶段复位：新阶段开始时用户尚未表达任何停止意图
        runEndedByUser = false;
        startTicker();
      }

      let summary: RunSummary;
      try {
        // 收尾轮带上本次探索的痕迹：模型据此直接写草稿/失败报告，
        // 而不是冷启动后丢失已核对的结果；验证仅带本次验证的证据。
        const carry = forceSubmit && baselineReady
          ? await collectCurrentAttemptContext(chatId, baselineIds, baselineSummary)
          : null;
        summary = await runEngineOnce(kind, {
          forceSubmit,
          priorRecords: carry?.records,
          contextSummary: carry?.summary,
          contextSummaryAt: carry?.compactedAt,
        });
      } catch (error) {
        stopTicker();
        // 启动前被终止：不是失败，静默收敛（终止流程正在接管清理）
        if (error instanceof LearnRunAbortedError || aborting || terminating) return;
        const message = error instanceof Error ? error.message : String(error);
        console.error('[LearnSession] 阶段运行失败:', error);
        await handleFatalFailure(kind, message);
        return;
      }

      // 用户已请求终止：清理由 requestAbort 统一负责，这里绝不推进业务
      if (aborting || terminating) {
        stopTicker();
        return;
      }
      if (phase.value !== kind || sessionChatId.value !== chatId) return;
      if (limitAction === 'discard') {
        await cleanupSessionImpl();
        return;
      }

      if (summary.status === 'error') {
        stopTicker();
        await handleFatalFailure(kind, summary.error || deps.t('sidepanel.learn.failureUnknown'));
        return;
      }
      if (summary.status === 'aborted') {
        // 非 requestAbort 路径的中止（如会话被外部删除）：按失败收敛
        stopTicker();
        await reset({ keepConfig: true });
        return;
      }

      // ── 终态已交：按终态分流 ──
      if (kind === 'learning' && draft.value) {
        stopTicker();
        if (cfg.autoValidate) {
          await runPhase('validating');
        } else {
          await proceedToDrafting();
        }
        return;
      }
      if (kind === 'learning' && failure.value) {
        stopTicker();
        await handleLearnFailure(failure.value);
        return;
      }
      if (kind === 'validating' && report.value) {
        stopTicker();
        await handleValidationOutcome();
        return;
      }
      if (limitAction === 'summarize') {
        forceSubmit = true;
        continue;
      }

      // ── 未交终态 ──
      if (!forceSubmit) {
        // 用户已明确结束本阶段（收尾弹窗选「直接结束」）：不补跑收尾轮——
        // 用户的决定优先于「终态必须被调用」的兜底，直接给出一个确定结论。
        if (runEndedByUser) {
          stopTicker();
          await handleLearnFailure(buildMissingOutcomeFailure(kind), kind);
          return;
        }
        // 补一轮收尾轮：不打断用户，只在状态条上给一句提示
        deps.notify(deps.t('sidepanel.learn.forceSubmitNotice'));
        forceSubmit = true;
        continue;
      }
      // 补跑后仍未交：确定性的失败原因（不是「可能是没调用」这种猜测）
      stopTicker();
      await handleLearnFailure(buildMissingOutcomeFailure(kind), kind);
      return;
    }
  }

  /** 验证段收尾分流：通过了就去落盘，不通过由用户决定重新学习 / 仍要创建 */
  async function handleValidationOutcome(): Promise<void> {
    const reportValue = report.value;
    if (!reportValue) {
      await handleNoDraft('validating', 'sidepanel.learn.noDraftValidating');
      return;
    }
    if (reportValue.passed) {
      await proceedToDrafting();
      return;
    }
    const choice = await askDialog({ mode: 'validationFail', report: reportValue });
    if (choice === 'relearn') {
      learningFeedback = { kind: 'validation', report: reportValue };
      draft.value = null;
      report.value = null;
      failure.value = null;
      await runPhase('learning');
      return;
    }
    if (choice === 'create') {
      // 终止流程接管时不再交付：交付与「整体丢弃」互相矛盾，
      // 而终止的语义是用户明确要求丢弃本次学习的一切成果。
      if (aborting || terminating) return;
      // 仍要创建：沿用现有草稿直接落盘
      await proceedToDrafting();
      return;
    }
    // 三路兜底：非法/被顶替的收敛值一律「不推进」——不落盘、不重启，
    // 安全回到可重入起点（弹窗已被 answerDialog 挡住非法值，此路仅防程序缺陷）
    await reset({ keepConfig: true });
  }

  /**
   * 学习失败（模型主动提交 status=failed/blocked，或收尾轮后仍未交终态）：
   * 展示失败原因 → 用户选「重新学习 / 仍要创建 / 结束」。
   *
   * - 「重新学习」把失败报告作为反馈注入下一轮 prompt（<previous-failure> 分区），
   *   让模型带着「上次卡在哪、已经探明了什么」重来，而不是从零重复同一份失败；
   * - 「仍要创建」只在验证阶段出现（草稿已学成并持有）：把它交付出去，
   *   绝不因为一次验收没结论就把成果丢掉；
   * - 「结束」只在学习阶段出现（此时没有草稿，放弃即无可交付之物）。
   *
   * 失败报告本身随工具回执留在会话记录里，结束后仍可回看。
   */
  async function handleLearnFailure(
    failureReport: LearnFailureReport,
    stage: 'learning' | 'validating' = 'learning',
  ): Promise<void> {
    const choice = await askDialog({ mode: 'learnFailed', report: failureReport, stage });
    if (choice === 'relearn') {
      if (stage === 'validating') {
        // 验证段没有结论：草稿还在，重跑的是**验收**而不是学习——
        // 丢掉一份已经学成的技能去「重新学习」是用户不该被迫承担的损失。
        report.value = null;
        failure.value = null;
        await runPhase('validating');
        return;
      }
      learningFeedback = { kind: 'failure', report: failureReport };
      draft.value = null;
      report.value = null;
      failure.value = null;
      await runPhase('learning');
      return;
    }
    if (choice === 'create') {
      // 仍要创建：把已学成的草稿交付出去（验证阶段的成果保全路径）。
      // 终止流程接管时不交付——交付与「整体丢弃」互相矛盾。
      if (aborting || terminating) return;
      await proceedToDrafting();
      return;
    }
    // 结束：失败不产出技能，但原因已展示给用户（且留在会话记录里）
    await reset({ keepConfig: true });
  }

  /** 补跑收尾轮后仍未交终态：构造一份确定的失败原因（不靠猜） */
  function buildMissingOutcomeFailure(
    kind: 'learning' | 'validating',
  ): LearnFailureReport {
    return {
      reason: 'other',
      detail:
        kind === 'learning'
          ? deps.t('sidepanel.learn.failureNoSubmitDetailLearning')
          : deps.t('sidepanel.learn.failureNoSubmitDetailValidating'),
      findings: [],
      suggestion: deps.t('sidepanel.learn.failureNoSubmitSuggestion'),
    };
  }

  /**
   * 收集本次尝试产生的会话上下文（供强制收尾轮携带探索痕迹）。
   *
   * 只取基线之后产生的记录——上一轮学习（「重新学习」的上一轮）的痕迹
   * 不带进来，否则模型会把两轮探索混在一起。压缩摘要一并带上：被压缩
   * 掉的早期探索正是「已经走通了哪些步骤」的关键证据。
   *
   * 记录数封顶（LEARN_FORCE_SUBMIT_HISTORY）：按记录边界截断是安全的
   * ——每条记录的协议历史自包含（助手消息与其工具结果同属一条），
   * 不会出现悬空的 tool_call。取最近若干条即可覆盖「刚才探索到了什么」。
   */
  async function collectCurrentAttemptContext(
    chatId: string,
    baselineIds: ReadonlySet<string>,
    baselineSummary: string,
  ): Promise<{ records: ChatMessageRecord[]; summary: string; compactedAt: number }> {
    try {
      const ctx = await transcriptEngine.getEffectiveContext(chatId);
      const fresh = ctx.records.filter(record => !baselineIds.has(record.id));
      return {
        records: fresh.slice(-LEARN_FORCE_SUBMIT_HISTORY),
        summary: ctx.summary === baselineSummary ? '' : ctx.summary,
        compactedAt: ctx.compactedAt,
      };
    } catch (error) {
      console.warn('[LearnSession] 读取收尾轮历史失败，按无历史处理:', error);
      return { records: [], summary: '', compactedAt: 0 };
    }
  }

  /** Explicit choices on every budget boundary; never turn an extension into forced submission. */
  async function handleLimitReached(
    kind: 'max-iterations' | 'max-duration' | 'tool-failures',
    limits: { maxIterations: number; maxDurationMs: number },
    stage: 'learning' | 'validating',
  ): Promise<boolean> {
    while (!aborting && !terminating && phase.value === stage) {
      const view: Extract<LearnDialogView, { mode: 'limitWrapUp' }> = {
        mode: 'limitWrapUp', phase: stage, reason: kind,
        iterations: limits.maxIterations, minutes: limits.maxDurationMs / 60_000,
        extraIterations: LEARN_DEFAULT_EXTENSION_ITERATIONS,
      };
      const choice = await askDialog(view);
      if (aborting || terminating || phase.value !== stage) return false;
      if (choice === 'extend') {
        if (!isPositiveSafeInteger(view.extraIterations)) continue;
        limits.maxIterations = view.extraIterations;
        return true;
      }
      if (choice === 'summarize') {
        limitAction = 'summarize';
        return false;
      }
      if (choice !== 'discard') return false;
      const confirmed = await askDialog({ mode: 'stop', phase: stage, elapsedMs: elapsedMs.value, toolCalls: toolCalls.value, fromLimit: true });
      if (aborting || terminating || phase.value !== stage) return false;
      if (confirmed === 'confirm') {
        // Cleanup must happen AFTER runEngineOnce settles; awaiting activeRun here deadlocks.
        limitAction = 'discard';
        runEndedByUser = true;
        return false;
      }
      // Cancelling discard returns to the budget choices without resuming the engine.
    }
    return false;
  }

  /**
   * 阶段不可恢复失败时的收尾（引擎错误 / 准备阶段异常）。
   *
   * **成果保全**：验证段失败时草稿已经学成并持有，直接 reset 会把它连同
   * 会话一起丢掉——那是用户几十分钟探索的成果。此时改为先把草稿交付出去
   * （与管理中心的正常路径一致），错误以提示条告知，不阻断交付。
   * 学习段失败时没有草稿可保，按常规失败弹窗处理。
   */
  async function handleFatalFailure(kind: 'learning' | 'validating', message: string): Promise<void> {
    // 终止流程接管时一律不推进：交付与「整体丢弃」互相矛盾
    if (aborting || terminating) return;
    if (kind === 'validating' && draft.value) {
      deps.notify(deps.t('sidepanel.learn.failureDraftKeptNotice'));
      await proceedToDrafting();
      return;
    }
    await askDialog({
      mode: 'failure',
      title: deps.t('sidepanel.learn.failureTitle'),
      message,
    });
    await reset({ keepConfig: true });
  }

  /** 运行结束但没有产出：给重试机会，而不是静默丢弃已试错的轮次 */
  async function handleNoDraft(kind: 'learning' | 'validating', reasonKey: MessageKey): Promise<void> {
    const choice = await askDialog({ mode: 'noDraft', reason: deps.t(reasonKey) });
    if (choice === 'retry') {
      // 验证段无草稿时重跑验证必然还是无草稿（防御路径，正常不可达）：
      // 回到学习阶段重新学一遍，才是「重试」的真实语义。
      if (kind === 'validating' && !draft.value) {
        await runPhase('learning');
        return;
      }
      await runPhase(kind);
      return;
    }
    await reset({ keepConfig: true });
  }

  // ──── 落盘与跳转 ────

  async function proceedToDrafting(): Promise<void> {
    const skillDraft = draft.value;
    if (!skillDraft) {
      await reset({ keepConfig: true });
      return;
    }
    phase.value = 'drafting';
    stopTicker();
    forceSubmitting.value = false;

    // 会话回放与独立交接副本分别落盘；交接失败保留内存下载/重试入口，不打开空表单。
    try { await transcriptEngine.setSystemPromptSuffix(sessionChatId.value, JSON.stringify(skillDraft)); }
    catch (error) { console.warn('[LearnSession] 会话恢复副本写入失败，将继续保存独立交接副本:', error); }
    const saved = await saveLearnDraft(skillDraft, sessionChatId.value);
    if (!saved.ok) {
      deps.notify(deps.t('sidepanel.learn.draftSaveDegraded'));
      degradedNotice.value = true;
      phase.value = 'done';
      return;
    }

    // 导航失败不影响持久成果；手动打开管理中心或重试均使用同一交接记录。
    let opened = false;
    try {
      opened = await deps.openHub(learnDraftHash(saved.id));
    } catch (error) {
      console.error('[LearnSession] 跳转管理中心失败:', error);
    }

    // 交付完成 → 回到静止态：输入区恢复正常，草稿已移交 hub，
    // 本侧不再持有任何待办（'done' 语义由这次转移完整表达）；
    // 降级弹窗保留到用户确认——它是成果丢失的唯一强提示，随手关闭会失去告知
    phase.value = 'done';
    deps.notify(deps.t(opened ? 'sidepanel.learn.handoffDone' : 'sidepanel.learn.openHubFailed'));
  }

  // ──── 启动 ────

  async function confirmStart(): Promise<void> {
    const cfg = config.value;
    if (!cfg || phase.value !== 'confirming') return;

    phase.value = 'learning';
    aborting = false;
    terminating = false;
    runEndedByUser = false;
    learningFeedback = null;
    draft.value = null;
    report.value = null;
    failure.value = null;
    toolCalls.value = 0;
    contextUsage.value = null;
    // 新一轮开跑：上次交付遗留的降级说明不再适用（其成果已由本轮接替）
    degradedNotice.value = false;

    try {
      const session = await transcriptEngine.createSession({
        // 不绑定智能体：学习是运行期动态装配，写 agentName 会让该会话在
        // 后续普通发送时 resolve 到不存在的智能体而装配失败
        agentId: '',
        agentName: '',
        skillNames: [],
        modelRef: cfg.modelRef,
        kind: 'site-learn',
      });
      sessionChatId.value = session.chatId;
      deps.setActiveChat(session.chatId);
      deps.showChat();
    } catch (error) {
      console.error('[LearnSession] 创建学习会话失败:', error);
      deps.notify(deps.t('sidepanel.learn.sessionCreateFailed'));
      await reset({ keepConfig: true });
      return;
    }

    await runPhase('learning');
  }

  // ──── 终止 ────

  /**
   * 终止运行（弹确认 → abort → 整体丢弃）。
   *
   * **终止入口必须始终可用**：原实现「在场有弹窗就让位」会锁死用户——
   * 模型撞轮数上限弹出收尾弹窗时，用户既不能继续也不能终止，只能干等。
   * 现在终止是最高优先级的用户意图：
   *   1. 若预算选择在场，复用其丢弃确认；取消时仍停在预算选择。
   *   2. 弹终止确认（顶替在场的弹窗）；
   *   3. 确认 → 整体清理（删会话、清草稿）；取消 → 收场（给一个确定结论），
   *      不让状态机停在「运行已停但无人接管」的中间态。
   */
  async function requestAbort(): Promise<void> {
    if (!isLearnRunningFlag.value) return;
    // 终止确认自身已在场：忽略重复触发（避免叠加同一语义的弹窗）
    if (dialog.value?.mode === 'stop') return;
    // The guard already pauses the engine. Keep it pending through discard confirmation;
    // cancelling must return to the same choices, without ending the run.
    if (dialog.value?.mode === 'limitWrapUp') {
      answerDialog('discard');
      return;
    }

    terminating = true;
    // 结算在场的运行中弹窗（收尾守卫），让引擎尽快停下来
    if (dialog.value) {
      const supersededView = dialog.value;
      settleDialog(settleValueFor(supersededView));
      // 等引擎退出，避免「弹窗已关但运行还在跑」的重叠态
      if (activeRun) await activeRun.catch(() => undefined);
    }

    const kind = phase.value === 'validating' ? 'validating' : 'learning';
    const choice = await askDialog({
      mode: 'stop',
      phase: kind,
      elapsedMs: elapsedMs.value,
      toolCalls: toolCalls.value,
    });
    if (choice === 'confirm') {
      await cleanupSessionImpl();
      return;
    }
    // 取消终止：运行已停（收尾弹窗被结算所致），必须给一个确定的收场，
    // 否则状态机会停在「没有运行也没有结论」的悬空态。
    terminating = false;
    if (!activeRun && isLearnRunningFlag.value) {
      await handleLearnFailure(buildMissingOutcomeFailure(kind), kind);
    }
  }

  // ──── 重置 ────

  async function reset(options: { keepConfig: boolean }): Promise<void> {
    stopTicker();
    activeGlow?.stop();
    activeGlow = undefined;
    activeRun = null;
    aborting = false;
    terminating = false;
    runEndedByUser = false;
    limitAction = null;
    forceSubmitting.value = false;
    learningFeedback = null;
    // 收敛在途弹窗：reset 意味着业务已被放弃/重置，仍挂在 askDialog 上的
    // await 者按该模式的收敛值结算——直接置空会让其永久悬挂（见 DIALOG_SETTLE_VALUE）。
    // 结算触发的续体是微任务，运行到时本函数同步部分已完成、draft/config 已清，
    // 各续体的「不推进」分支（reset 幂等 / cfg 空判 / 非法值兜底）保证无副作用。
    settleDialog();
    sessionChatId.value = '';
    toolCalls.value = 0;
    contextUsage.value = null;
    draft.value = null;
    report.value = null;
    failure.value = null;
    // 降级说明随流程一并清除：reset 表示业务已放弃，残留的「成果丢失」提示
    // 会误导用户以为当前会话还欠一次交付
    degradedNotice.value = false;
    if (!options.keepConfig) {
      config.value = null;
      errors.value = {};
    }
    phase.value = 'idle';
  }

  // ──── 弹窗动作分发 ────

  function handleDialogChoice(choice: LearnDialogChoice, extraIterations?: number): void {
    const mode = dialog.value?.mode;
    const accepted = answerDialog(choice, extraIterations);
    // 非法选择被 answerDialog 挡下（弹窗保持打开），此处绝不推进
    if (!accepted || mode !== 'start') return;
    // 「开始」在应答后推进（先关弹窗再跑，避免弹窗与运行态叠加）
    if (choice === 'confirm') {
      void confirmStart();
      return;
    }
    // 「返回修改」/ 点遮罩取消：回到配置面板。表单重置由 formEpoch 驱动
    // （此处不递增），已填内容完整保留——这正是「返回修改」承诺的语义。
    // 仅当仍停在 confirming 时才改相位：弹窗可能已被 reset 程序性收敛
    // （此时相位已是 idle），无条件改会把状态机从 idle 顶回 configuring。
    if (phase.value === 'confirming') phase.value = 'configuring';
  }

  return {
    phase: phase as ReadonlyRef<LearnPhase>,
    errors: errors as ReadonlyRef<Partial<Record<LearnConfigField, LearnConfigErrorCode>>>,
    dialog,
    elapsedMs: elapsedMs as ReadonlyRef<number>,
    toolCalls: toolCalls as ReadonlyRef<number>,
    contextUsage: contextUsage as ReadonlyRef<ContextUsage | null>,
    isLearnActive,
    isLearnRunning: isLearnRunningFlag,
    isForceSubmitting: forceSubmitting as ReadonlyRef<boolean>,
    formEpoch,
    degradedNotice: degradedNotice as ReadonlyRef<boolean>,
    recovery: computed(() => phase.value === 'done' && draft.value ? { chatId: sessionChatId.value, draft: draft.value } : null),
    modelCandidates,

    openModal,
    closeModal,
    submitConfig,
    requestAbort,
    answerDialog: handleDialogChoice,
    dismissDegradedNotice: () => {
      degradedNotice.value = false;
    },
    /** 中止 / 整体丢弃时的清理入口（与 requestAbort 内联逻辑同源，供会话删除等外部触发复用） */
    cleanupSession: cleanupSessionImpl,
    refreshModels: refreshModelCandidates,
  };
}
