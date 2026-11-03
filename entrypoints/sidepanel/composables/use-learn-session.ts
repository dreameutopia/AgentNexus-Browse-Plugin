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
 * 依赖注入：只向调用方索取 5 件事（事件观察者 / 系统提示条 / 进入聊天态 /
 * 切换会话 / 打开管理中心），其余全部直接使用核心引擎单例——引擎本身即
 * 全局唯一，二次注入只会制造「两个入口各持一份状态」的分裂。
 */

import { computed, ref, type Ref } from 'vue';
import type { MessageKey } from '@/utils/i18n';

import {
  transcriptEngine,
  runtimeBuilder,
  conversationEngine,
  sessionDeletionEngine,
  type ConversationEvent,
  type RunSummary,
} from '@/entrypoints/sidepanel/core';
import { modelRegistry } from '@/entrypoints/sidepanel/utils/channels';
import { streamClient } from '@/entrypoints/sidepanel/utils/stream/stream-client';
import { getPresetToolIds, type ToolScenario } from '@/utils/tools/tool-presets';
import {
  LEARN_LIMITS,
  LEARN_WRAP_UP_EXTRA_ITERATIONS,
  isLearnRunning,
  type LearnPhase,
  type SkillDraft,
  type ValidationReport,
} from '@/utils/learn/learn-types';
import {
  validateLearnConfig,
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
} from '@/utils/learn/learn-prompts';
import { clearLearnDraft, saveLearnDraft } from '@/utils/learn/learn-draft-store';
import { LEARN_DRAFT_HASH, type LearnConfigInput, type ValidatedLearnConfig } from '@/utils/learn/learn-types';

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
  /** 达到轮数上限：是否再给几轮收尾提交 */
  | 'limitWrapUp'
  /** 验证未通过：重新学习 / 仍要创建 */
  | 'validationFail'
  /** 不可恢复失败 */
  | 'failure'
  /** 运行正常结束但没有产出（模型未调用提交工具） */
  | 'noDraft';

/** 弹窗视图（组件按 mode 分支渲染；payload 随模式确定） */
export type LearnDialogView =
  | { mode: 'start'; config: ValidatedLearnConfig; modelLabel: string }
  | { mode: 'stop'; phase: 'learning' | 'validating'; elapsedMs: number; toolCalls: number }
  | { mode: 'limitWrapUp'; iterations: number }
  | { mode: 'validationFail'; report: ValidationReport }
  | { mode: 'failure'; title: string; message: string }
  | { mode: 'noDraft'; reason: string };

/** 弹窗可返回的选择（全集；各模式只接受自己的子集，answerDialog 会校验） */
export type LearnDialogChoice =
  | 'confirm'
  | 'cancel'
  | 'wrapUp'
  | 'stop'
  | 'relearn'
  | 'create'
  | 'retry'
  | 'giveUp'
  | 'ok';

/** 各模式合法选择（非法选择绝不静默执行意外分支，见 answerDialog） */
const DIALOG_CHOICES: Record<LearnDialogMode, readonly LearnDialogChoice[]> = {
  start: ['confirm', 'cancel'],
  stop: ['confirm', 'cancel'],
  limitWrapUp: ['wrapUp', 'stop'],
  validationFail: ['relearn', 'create'],
  failure: ['ok'],
  noDraft: ['retry', 'giveUp'],
};

/**
 * 各模式在「弹窗被顶替 / 状态被重置」时的收敛值。
 *
 * 场景：新弹窗要替换旧弹窗（如用户点终止的瞬间运行恰好结束、post-run 弹窗
 * 顶掉 stop 弹窗），或 reset() 清空状态时仍有 awaitaskDialog 挂起——
 * 旧等待者必须被结算，否则其 await 永久悬挂、状态机卡死。
 * 收敛值一律取「不推进业务」的方向：不开始、不终止、不追加轮次、
 * 不重启学习；validationFail 的 'cancel' 由 runPhase 三路分支
 * （relearn / create / 其余→reset）收敛为「不推进」。
 */
const DIALOG_SETTLE_VALUE: Record<LearnDialogMode, LearnDialogChoice> = {
  start: 'cancel',
  stop: 'cancel',
  limitWrapUp: 'stop',
  validationFail: 'cancel',
  failure: 'ok',
  noDraft: 'giveUp',
};

// ──── 视觉循环配置（与 Vision Action 预设同构） ────

/**
 * 学习 / 验证中需要视觉时的运行配置。
 * 引擎据此在每轮开始与每次工具成功后自动截图并注入多模态消息，
 * 截图工具本身不占模型工具位（模型无法也不需要主动调用它）。
 */
const LEARN_VISION_RUNTIME = {
  screenshotTool: 'screenshot' as const,
  screenshotArgs: {},
  reScreenshotAfterTools: true,
};

// ──── 注入依赖 ────

export interface LearnSessionDeps {
  /** 转发给 UI 的会话事件（App 的 handleConversationEvent） */
  observer: (event: ConversationEvent) => void;
  /** 系统提示条（配置切换、降级提示等） */
  notify: (text: string) => void;
  /** 从欢迎页切入聊天页 */
  showChat: () => void;
  /** 把 UI 焦点切到指定会话（学习会话创建后） */
  setActiveChat: (chatId: string) => void;
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
  /** 是否处于学习态（含配置与收尾——这些阶段同样不接受普通输入） */
  isLearnActive: ReadonlyRef<boolean>;
  /** 是否正在运行（决定是否显示终止按钮） */
  isLearnRunning: ReadonlyRef<boolean>;
  /** 配置面板表单重置纪元（openModal 递增；「返回修改」不递增以保留输入） */
  formEpoch: ReadonlyRef<number>;
  /** 草稿暂存失败的降级说明是否待展示（收尾阶段置位，用户确认后清除） */
  degradedNotice: ReadonlyRef<boolean>;
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
  answerDialog: (choice: LearnDialogChoice) => void;
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

  // ──── 运行期私有状态 ────
  /** 当前在跑的 run Promise（终止时需等待其干净退出） */
  let activeRun: Promise<RunSummary> | null = null;
  /** 用户已请求终止：post-run 一律不再推进业务（清理由 requestAbort 负责） */
  let aborting = false;
  /** 轮数上限的收尾机会只给一次 */
  let wrapUpGranted = false;
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
      if (superseded && dialog.value) {
        console.warn('[LearnSession] 弹窗被顶替:', dialog.value.mode, '→', view.mode);
        superseded(DIALOG_SETTLE_VALUE[dialog.value.mode]);
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
  function answerDialog(choice: LearnDialogChoice): boolean {
    const resolver = resolveDialog;
    const current = dialog.value;
    if (!resolver || !current) return false;
    const allowed = DIALOG_CHOICES[current.mode];
    if (!allowed.includes(choice)) {
      console.warn('[LearnSession] 非法弹窗选择被忽略:', current.mode, choice);
      return false;
    }
    resolveDialog = null;
    dialog.value = null;
    resolver(choice);
    return true;
  }

  // ──── 模型候选 ────

  function refreshModelCandidates(): void {
    try {
      allCandidates.value = modelRegistry.listOptions().map(option => ({
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
    try {
      conversationEngine.abort(chatId);
      if (activeRun) await activeRun.catch(() => undefined);
      activeRun = null;
      await sessionDeletionEngine.deleteSession(chatId);
    } catch (error) {
      console.error('[LearnSession] 终止清理失败:', error);
    } finally {
      // 中止即整体丢弃：草稿、报告、会话一并作废
      await clearLearnDraft();
      await reset({ keepConfig: false });
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

  /** 场景 → 工具组（学习按策略、验证按目标模式，两者严格分离） */
  function scenarioFor(kind: 'learning' | 'validating'): ToolScenario {
    const cfg = config.value!;
    if (kind === 'learning') {
      return cfg.strategy === 'vision' ? 'siteLearnVision' : 'siteLearnText';
    }
    return cfg.targetMode === 'vision' ? 'siteValidateVision' : 'siteValidateText';
  }

  /** 该阶段是否需要视觉循环（学习看策略、验证看目标模式） */
  function visionFor(kind: 'learning' | 'validating'): boolean {
    const cfg = config.value!;
    return kind === 'learning' ? cfg.strategy === 'vision' : cfg.targetMode === 'vision';
  }

  /**
   * 事件观察者包装：转发给 UI 之外，捕获终止型工具的产出。
   * 按会话 id 过滤，避免把其它会话的提交误认为本阶段产出。
   */
  function makeObserver(kind: 'learning' | 'validating') {
    const chatId = sessionChatId.value;
    return (event: ConversationEvent): void => {
      deps.observer(event);
      if (event.chatId !== chatId) return;
      if (event.type === 'tool-call') toolCalls.value += 1;
      if (event.type !== 'tool-result' || event.status !== 'success') return;
      const data = (event.result as { data?: Record<string, unknown> } | undefined)?.data;
      if (!data) return;
      if (kind === 'learning' && data.draft) {
        draft.value = data.draft as SkillDraft;
        // 草稿随消息回放（降级兜底）：把提交体持久化到会话补充段。
        // 暂存（chrome.storage）失败或管理中心未打开时，成果不再只活在内存里——
        // 重新打开该会话即可从消息里取回，这是「草稿暂存失败」降级承诺的兑现
        // （正常路径也写：跨页交接与回放互不影响，见 setSystemPromptSuffix 注释）
        void transcriptEngine.setSystemPromptSuffix(chatId, JSON.stringify(data.draft));
      } else if (kind === 'validating' && data.report) {
        report.value = data.report as ValidationReport;
      }
    };
  }

  /**
   * 跑一个阶段（学习或验证）。
   * 两段都以 priorRecords=[] 起底：验证是**盲测**——模型只能看到技能正文，
   * 不能记得自己当初怎么摸索的，否则验证失去意义；转录仍连续记录，历史可回溯。
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
    toolCalls.value = 0;
    startTicker();

    try {
      const runtime = await runtimeBuilder.build({
        chatId,
        userInput:
          kind === 'learning' ? learnKickoffMessage(cfg) : validateKickoffMessage(cfg, skillDraft!),
        agentName: null,
        skillNames: [],
        modelRef: cfg.modelRef,
        extraToolIds: [...getPresetToolIds(scenarioFor(kind))],
        agentSystemOverride:
          kind === 'learning' ? buildLearnPrompt(cfg) : buildValidatePrompt(cfg, skillDraft!),
        // 学习/验证是长任务：覆盖默认的 20 轮 / 10 分钟
        limitsOverride: { ...LEARN_LIMITS },
        // 视觉三态：需要时启用视觉循环，不需要时显式禁用（不继承任何智能体声明）
        visionOverride: visionFor(kind) ? LEARN_VISION_RUNTIME : null,
        // 盲测：两段都不携带前序历史
        priorRecords: [],
      });

      const runPromise = conversationEngine.run(runtime, {
        observer: makeObserver(kind),
        onLimitReached: limitKind => handleLimitReached(limitKind, runtime.limits),
        // 破坏性操作审批已在工具元数据层声明（requiresConfirm），此处沿用默认通道
      });
      activeRun = runPromise;
      const summary = await runPromise;
      activeRun = null;
      stopTicker();

      // 用户已请求终止：清理由 requestAbort 统一负责，这里绝不推进业务
      if (aborting) return;

      if (summary.status === 'error') {
        await askDialog({
          mode: 'failure',
          title: deps.t('sidepanel.learn.failureTitle'),
          message: summary.error || deps.t('sidepanel.learn.failureUnknown'),
        });
        await reset({ keepConfig: true });
        return;
      }
      if (summary.status === 'aborted') {
        // 非 requestAbort 路径的中止（如会话被外部删除）：按失败收敛
        await reset({ keepConfig: true });
        return;
      }

      if (kind === 'learning') {
        if (draft.value) {
          if (cfg.autoValidate) {
            await runPhase('validating');
          } else {
            await proceedToDrafting();
          }
        } else {
          await handleNoDraft(kind, 'sidepanel.learn.noDraftLearning');
        }
        return;
      }

      // 验证段收尾
      const reportValue = report.value;
      if (!reportValue) {
        await handleNoDraft(kind, 'sidepanel.learn.noDraftValidating');
        return;
      }
      if (reportValue.passed) {
        await proceedToDrafting();
        return;
      }
      const choice = await askDialog({ mode: 'validationFail', report: reportValue });
      if (choice === 'relearn') {
        draft.value = null;
        report.value = null;
        await runPhase('learning');
        return;
      }
      if (choice === 'create') {
        // 仍要创建：沿用现有草稿直接落盘
        await proceedToDrafting();
        return;
      }
      // 三路兜底：非法/被顶替的收敛值一律「不推进」——不落盘、不重启，
      // 安全回到可重入起点（弹窗已被 answerDialog 挡住非法值，此路仅防程序缺陷）
      await reset({ keepConfig: true });
    } catch (error) {
      stopTicker();
      if (aborting) return;
      const message = error instanceof Error ? error.message : String(error);
      console.error('[LearnSession] 阶段运行失败:', error);
      await askDialog({
        mode: 'failure',
        title: deps.t('sidepanel.learn.failureTitle'),
        message,
      });
      await reset({ keepConfig: true });
    }
  }

  /** 轮数上限：给一次「收尾提交」机会；其余守卫一律停止（继续只会重复撞墙） */
  async function handleLimitReached(
    kind: 'max-iterations' | 'max-duration' | 'tool-failures',
    limits: { maxIterations: number },
  ): Promise<boolean> {
    if (kind !== 'max-iterations' || wrapUpGranted) return false;
    const choice = await askDialog({
      mode: 'limitWrapUp',
      iterations: limits.maxIterations,
    });
    if (choice !== 'wrapUp') return false;
    wrapUpGranted = true;
    // 关键：guardIterations 在「继续」时会归零，故这里必须写**相对值**——
    // 写「现值 + N」会放出几十轮。压成 N 即「再给约 N 轮」。
    limits.maxIterations = LEARN_WRAP_UP_EXTRA_ITERATIONS;
    return true;
  }

  /** 运行结束但没有产出：给重试机会，而不是静默丢弃已试错的轮次 */
  async function handleNoDraft(kind: 'learning' | 'validating', reasonKey: MessageKey): Promise<void> {
    const choice = await askDialog({ mode: 'noDraft', reason: deps.t(reasonKey) });
    if (choice === 'retry') {
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

    // 暂存失败不阻断收尾：hub 侧 takeLearnDraft 将得到 none，按「草稿不存在」
    // 打开空表单。此时成果只能靠会话详情（草稿随消息回放）承载，故除系统提示外
    // 再弹一次非阻断说明——阻断会把 drafting 卡死，而恢复路径（重跑学习）
    // 并不依赖此刻的弹窗
    const saved = await saveLearnDraft(skillDraft);
    if (!saved) {
      deps.notify(deps.t('sidepanel.learn.draftSaveDegraded'));
      degradedNotice.value = true;
    }

    // 跳转失败（标签页创建被拒等）：草稿仍在 storage（TTL 10 分钟内有效），
    // 明确告知手动打开管理中心即可继续，绝不静默吞掉失败
    let opened = false;
    try {
      opened = await deps.openHub(LEARN_DRAFT_HASH);
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
    wrapUpGranted = false;
    draft.value = null;
    report.value = null;
    toolCalls.value = 0;
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

  async function requestAbort(): Promise<void> {
    if (!isLearnRunningFlag.value) return;
    // 已有弹窗在场（失败/收尾/验证结论等）时终止入口让位：弹窗本身就是
    // 当前的决策点，再叠一个 stop 弹窗会顶替它、让用户在两个语义间错选
    if (dialog.value) return;
    const kind = phase.value === 'validating' ? 'validating' : 'learning';
    const choice = await askDialog({
      mode: 'stop',
      phase: kind,
      elapsedMs: elapsedMs.value,
      toolCalls: toolCalls.value,
    });
    if (choice !== 'confirm') return;

    await cleanupSessionImpl();
  }

  // ──── 重置 ────

  async function reset(options: { keepConfig: boolean }): Promise<void> {
    stopTicker();
    activeRun = null;
    aborting = false;
    wrapUpGranted = false;
    // 收敛在途弹窗：reset 意味着业务已被放弃/重置，仍挂在 askDialog 上的
    // await 者按该模式的收敛值结算——直接置空会让其永久悬挂（见 DIALOG_SETTLE_VALUE）。
    // 结算触发的续体是微任务，运行到时本函数同步部分已完成、draft/config 已清，
    // 各续体的「不推进」分支（reset 幂等 / cfg 空判 / 非法值兜底）保证无副作用。
    const pendingResolver = resolveDialog;
    const pendingMode = dialog.value?.mode;
    resolveDialog = null;
    dialog.value = null;
    if (pendingResolver && pendingMode) {
      pendingResolver(DIALOG_SETTLE_VALUE[pendingMode]);
    }
    sessionChatId.value = '';
    toolCalls.value = 0;
    draft.value = null;
    report.value = null;
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

  function handleDialogChoice(choice: LearnDialogChoice): void {
    const mode = dialog.value?.mode;
    const accepted = answerDialog(choice);
    // 非法选择被 answerDialog 挡下（弹窗保持打开），此处绝不推进
    if (!accepted || mode !== 'start') return;
    // 「开始」在应答后推进（先关弹窗再跑，避免弹窗与运行态叠加）
    if (choice === 'confirm') {
      void confirmStart();
      return;
    }
    // 「返回修改」/ 点遮罩取消：回到配置面板。表单重置由 formEpoch 驱动
    // （此处不递增），已填内容完整保留——这正是「返回修改」承诺的语义
    phase.value = 'configuring';
  }

  return {
    phase: phase as ReadonlyRef<LearnPhase>,
    errors: errors as ReadonlyRef<Partial<Record<LearnConfigField, LearnConfigErrorCode>>>,
    dialog,
    elapsedMs: elapsedMs as ReadonlyRef<number>,
    toolCalls: toolCalls as ReadonlyRef<number>,
    isLearnActive,
    isLearnRunning: isLearnRunningFlag,
    formEpoch,
    degradedNotice: degradedNotice as ReadonlyRef<boolean>,
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
