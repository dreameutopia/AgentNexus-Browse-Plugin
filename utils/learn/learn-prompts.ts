import { SKILL_BODY_MAX_CHARS } from '@/utils/skills/skill-types';
import { LEARN_SKILL_SECTIONS } from './learn-output-contract';
import { validationToolIds } from './learn-tool-policy';
/**
 * 网站学习 Prompt 模板（纯函数：入参 → 字符串，无副作用）
 *
 * ── 为什么按维度拆而不是写 5 份完整 prompt ──
 * 学习配置有两个正交维度：
 *   targetMode（产出 SKILL 给谁用）× strategy（学习时用什么工具摸索）
 * 因 vision 目标强制 vision 策略，有效组合是 3 个；验证段只看 targetMode，是 2 个。
 * 若各写一份完整 prompt，维度一变就要同步改多处、极易漏改且互相漂移。
 * 故本文件把 prompt 拆成**互不重叠的维度块**，每个块只描述一件事：
 *
 *   buildLearnPrompt = ROLE + TASK + WORKFLOW + EXPLORATION(按 strategy × targetMode)
 *                    + RECORDING(按 targetMode，含跨维度转译规则)
 *                    + SKILL_OUTPUT(按 targetMode) + CONSTRAINTS + TERMINATION
 *   buildValidatePrompt = VALIDATE_ROLE + 内嵌 SKILL 全文 + VALIDATE_TASK(独立，
 *                       不复用 learnTask——验证者不感知学习策略) + VALIDATE_METHOD(按 targetMode)
 *                       + VALIDATE_TERMINATION
 *
 * 块之间用具名常量导出，便于单测断言「改 A 不影响 B」与文档引用。
 * 两段任务策略独立：学习描述「怎么摸索」，验证描述「怎么验收和修订」；共享用户过程约束与抽样标准。
 *
 * ── 与动作智能体的隔离（重要）──
 * 本文件**不 import** ELEMENT_INTERACTION_SOP（文本通用助手）与
 * vision-gui-prompt（视觉通用助手的 vision_gui 规程）：学习/验证的操作契约由本文件自有维护
 * （LEARN_DOM_GUIDANCE、learnVisionGuiGuide、learnNoVisionGuiGuide），
 * 两个动作智能体的提示词演进不会改变学习行为，反之亦然。
 * <vision-gui-tool> 分区名是 prompt-hooks 钩子的协议标记：装配方提示词携带
 * 该分区时钩子不再注入智能体的 vision-gui 规程——视觉目标放完整手势
 * 契约，文本目标放「本阶段没有视觉 GUI」的禁用分区，两种情况都不注入
 * 智能体提示词。
 *
 * ── 与工具组的强约束 ──
 * 文中出现的工具名必须与 tool-presets 对应场景已注册的工具一致，否则模型会
 * 调到不存在的工具。修改任一场景的工具列表时，请同步核对本文件的
 * EXPLORATION / VALIDATE_METHOD 块（两边靠注释交叉锚定，见文末维护约定）。
 */

import type {
  LearnConfig,
  LearnFeedback,
  LearnStrategy,
  LearnTargetMode,
  SkillDraft,
} from './learn-types';

// ──── 公共拼装工具 ────

/** XML 分区包裹（正文内已含子标签，这里只负责外层） */
function section(tag: string, body: string): string {
  return `<${tag}>\n${body.trim()}\n</${tag}>`;
}

/** 单行折叠（防换行破坏清单结构） */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ════════════════════════════════════════════════════════════
// 学习段（阶段 1）
// ════════════════════════════════════════════════════════════

/** 角色：与所有学习组合共用 */
export const LEARN_ROLE = section(
  'role',
  `你是网站流程学习 Agent：在真实浏览器中通过试错，**探索并总结**出完成目标所需的
全部详细步骤与注意事项，并把它整理成一份结构化技能（SKILL）。

先明确交付物是什么：本次任务的成果**不是**「替用户把这件事做成了」，
而是**一份能让别人照着复现的详细操作手册**——用户之后会把这份手册交给另一个模型去重复执行。
因此：
- 目标页面上完成一次，只证明「主路径可行」，**不构成交付**；
- 真正要做的是把必要流程拆清楚：每一步依赖哪些线索、为什么必须这样做、
  在哪里容易出错、错了怎么恢复、有哪些岔路与隐藏入口；
- 围绕当前任务选择有代表性的差异，学会完整推进并记录可复用规则；不穷举无关分支，也不执行整个批次。
区分已证实的默认流程、带触发条件的特殊处理和未验证范围，不把少量样本宣称为所有情况的保证。

还有一条同等重要：**学习阶段无论成败，都必须以调用 submit_skill 收尾**——
跑通了交技能草稿，没跑通就交失败报告（卡在哪、已探明什么、建议怎么办）。
不要用一段文字总结代替提交：那样本次学习的结论无处可取，用户也拿不到失败的原因。`,
);

/** 任务参数：由配置注入，逐字不可改写 */
export function learnTask(config: LearnConfig): string {
  const strategyLine =
    config.strategy === 'text'
      ? 'text（用元素枚举与选择器探索，无截图）'
      : config.targetMode === 'text'
        ? 'vision（自动截图仅用于帮助理解屏幕元素；操作与取证全部走 DOM 文本通道，本阶段无视觉 GUI 工具）'
        : 'vision（截图 + vision_gui 手势探索，配合 DOM 取证）';
  return section(
    'task',
    `目标网站：${config.url}
学习目标：${oneLine(config.goal)}
本次任务：探索并总结「完成上述目标所需的全部详细步骤与注意事项」——不是替用户执行这个目标。
目标操作模式：${config.targetMode === 'text' ? 'text（产出的技能交给纯文本模型使用）' : 'vision（产出的技能交给视觉模型使用）'}
学习策略：${strategyLine}`,
  );
}

/** User process is task input, not verified website facts. Preserve multiline content safely. */
export function userProcessGuidance(config: LearnConfig): string {
  if (!config.additionalDescription?.trim()) return '';
  const quoted = JSON.stringify(config.additionalDescription.trim()).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return section('user-process', `用户额外描述（JSON 字符串）：\n${quoted}\n
优先按照用户描述的过程、顺序和约束推进当前任务，逐步核实，不用自己的习惯替换用户要求。
经现场证实的步骤、约束及用户澄清必须写入 SKILL 的对应步骤或分支；未证实的描述不能当事实。
描述与实际不符、缺少必要条件或无法继续时，先只读确认现状，再调用 interact 说明差异并询问用户；
等待真实答复后重新观察、按澄清继续。不得悄悄绕过、擅改目标或把冲突写成确定步骤。
用户拒绝、超时或交互通道不可用时，停止依赖该答复的操作，诚实记录阻碍与未验证范围。`);
}

/** Same bounded evidence standard for learning and independent validation. */
export const SAMPLE_GUIDANCE = section(
  'sample-scope',
  `学习与验证的目标是掌握并检验可复用的端到端流程，不是代做整个批次。
批量或重复任务默认选 2–3 条有代表性且有差异的样本（如商品规格/选项不同、岗位状态或入口不同），
跑通从起点、识别目标、操作到结果回读的完整路径；差异样本用于检查规则能否迁移，不为凑数量重复同一对象。
单次任务不人为凑样本；样本不足时如实写覆盖限制，不伪造成功。关键路径未证实不能通过；
存在会影响默认流程的未解决差异时，先询问用户或提交具体问题，不能仅因达到样本数量就收尾。
对批量任务还须掌握遍历/分页、稳定业务标识、去重、逐条记账、断点恢复、失败隔离与终止条件；
可通过少量翻页及已观察状态验证这些机制，不必遍历或执行全部记录。
先跑通最小端到端闭环，再补会改变操作的关键差异；不先滚完整个列表，不为确认总量一直加载到底。
停止条件是主路径、关键差异及恢复/循环规则已有证据，而不是达到某个页面条数。一次观测的批次大小、总量、命中数仅是样本事实，不能写成站点恒定规则。
抽样数量、真实写操作数量和未来批量执行数量是三件事：2–3 个差异样本可包含已处理状态的只读核对，不要求2–3次新发送。
首次不可逆动作前确定目标对象、内容与用户授权范围；数量或内容歧义会影响实际写入时先 interact，不能用抽样配额替用户决定。
发送、投递等有副作用的步骤：先读已完成状态与回执，以稳定业务标识去重；验证可重新定位和只读核对已完成样本，
不得为了重走流程再次发送/投递，不为制造异常而额外写入。确需新的真实操作时只用尚未处理且符合用户范围的少量样本。
样本、差异、实际结果和未覆盖范围记入 note；SKILL 保留参数化流程、默认路径及特殊情况的识别条件与处理方式，
不得把测试样本的商品 ID、岗位 ID、账号状态或一次偶然成功写成通用前提。`,
);

/**
 * 工作流：所有学习组合共用（探索手段的差异全部由 EXPLORATION 块承担）。
 * 主线是「探索 → 补漏 → 归纳成手册」，不是「完成目标 → 交差」。
 */
export const LEARN_WORKFLOW = section(
  'workflow',
  `1. 先用 plan_tool(action="create") 建立探索计划：把学习目标拆成可独立验证的阶段
   （按本次目标细分，如进入搜索页 → 输入关键词 → 搜索 → 遍历结果 → 核对覆盖范围）。计划列的是
   **要探明的知识点**、最小成功证据与停止条件。只在阶段完成、受阻或计划变更时更新状态，
   不把每次观察/点击拆成计划项，不为同一次状态变化连续维护计划。
2. 用 browser_navigate（waitForLoad=true）打开目标站点，browser_get_page_text 确认可达；
   需要用户手动处理才能继续时调用 interact，等待答复后重采页面（见 constraints）。
3. 按 <exploration> 规定的手段逐步推进。每完成一个**关键步骤**立即用
   note_tool(action="append") 追加一条记录（格式见 <recording>），不要凭记忆攒到结束再写——
   中途失败或被终止时，已写下的记录就是唯一产出。记录要写清「这一步为什么必要」
   「下一步该看到什么」「哪里容易出错」，而不只是「点了什么」。
4. 主路径已有结果回执后再补关键差异：用差异样本核对会改变操作的分支，如规格选择、已完成状态、
   隐藏入口、必要校验、翻页与停止信号。记录识别条件、默认路径和特殊处理；未遇到或不宜触发的情况标为未验证。
5. **回头核对**可复用性：从起始状态重新采集定位线索，换样本检查同一套规则，复核结果回执；
   已完成的发送/投递不重放。发现用户描述与实际冲突时先 interact，不以试错替代用户决策。
6. 核对目标、必要分支与完成条件，再按 <skill-output> 整理成技能正文。
   完成计划是未来执行者逐个推进的任务清单，具体操作讲解逐项对应，不是学习过程日志。
   将关键词/条件等输入参数化，保留真实定位证据，不得用示例或 {} 占位冒充已观察结果。
   目标含“所有/全部”时，技能必须说明遍历、去重、失败记录与终止条件；学习只抽样核对机制，首屏不等于全部。
   区分已观察、实际操作验证和未验证范围；未探明路径不能写成确定可用的步骤。
7. 最后调用 submit_skill 提交——这是学习阶段唯一的结束方式（见 termination）。
   跑通了传 status=success 交技能草稿；没跑通但已定位原因就传 status=failed，
   经 interact 请求人工处理仍无法继续时才传 status=blocked——
   **失败也必须调用 submit_skill**，不许用一段文字总结收尾。`,
);

// ──── 学习域自有操作指南（与两个动作智能体的 SOP 完全隔离）───
// 以下契约由本文件独立维护，不 import ELEMENT_INTERACTION_SOP / vision-gui-prompt。
// 修改任一块时同步核对 tool-presets 的学习/验证场景清单（文中工具名必须在
// 对应场景已注册），两边靠注释交叉锚定。

/**
 * DOM 定位与取证指南（三个学习组合 + 两种验证目标共用）。
 * browser_observe 的调用参数由工具 schema 维护，此处只补充选择观察方式与消歧策略。
 * 与 tool-presets 的 SITE_LEARN_DOM_TOOLS 交叉锚定（四个场景都含这些工具）。
 */
export const LEARN_DOM_GUIDANCE = `<dom-locating>
按本阶段实际提供的工具选择观察与操作方式；未提供的工具不调用，也不靠经验补出可用能力：
【观察】browser_observe 的枚举、节点详情与分页参数以工具说明为准。普通控件不足以理解复杂界面时换 structure/accessibility；需取得可复用 XPath、核对属性或状态时读取节点详情。
browser_get_page_text 读取页面正文；需要加载诊断且该工具可用时再读 browser_get_page_info，不每步机械读取整页与URL。
【消歧】用 Context、role、行列索引、选区和节点属性区分同名目标，无法区分时继续观察，禁止随意选第一个；引用必须来自当前观察结果，不能猜测或构造。
【交互】参数与输入/焦点生命周期以 browser_interact 说明为准；一次只派发一个有依赖的动作。本工具没有 hover；纯文本模式优先已验证的键盘展开/可见入口，必要时验证站点导航参数，不能用普通点击或脚本事件冒充真实悬停。确需能力外动作时记录缺口或 interact。
【反馈与恢复】动作前明确目标业务对象与预期变化，动作后优先核对一个对应业务后置条件，如详情所属记录、输入值或保存回执；有界等待异步状态，不把派发成功、页面load、固定睡眠当业务成功。not_dispatched 按错误修正；unknown/超时先读现状，禁止重放不确定的写操作。引用/焦点失效再重采；WRONG_TAB 切回已记录的来源 tabId，不猜当前标签。
【脚本与网络】仅在对应工具可用且普通观察不足时使用。脚本用 return 返回精简对象，不再 JSON.stringify；可合并独立只读检查，不能把多步有副作用动作藏进长循环。滚动按少量增量执行并核对新增业务ID、加载状态和停止条件。网络只作被动取证，不假设具备接口写权限。
【定位验证】优先可见语义、所属区域和稳定属性；已知 XPath 先验证，未命中再按文字/placeholder/aria-label 搜索。语义角色不等于HTML标签，不能因 role=button 就猜 //button；当前只有一个匹配也不能代替业务对象消歧。同一目标最多连续过滤 3 次，之后换可用的观察方式；空 DOM 或接口拒绝不等于页面没有内容。
【状态与证据】记录稳定业务身份、来源 tabId、操作前状态及业务回执，区分已确认成功/失败/效果未知。弹窗期间 disabled、暂时无响应、消息列表顶部均不是持久已完成或服务端去重保证。新观察反证旧结论时立即更正 note；未读懂的字体数字等数据标为未知，不猜值。
【虚拟列表】coverage.complete=false 不等于全表；滚动指定容器后重采，DOM 行号不是业务记录 ID；辅助功能不保证暴露未加载数据。
【持久化】技能只可保存可重新执行的 regex/XPath、语义、记录识别与恢复规则；禁止把运行期 ElementId、AX 引用、snapshotId、captureId 或固定 FrameId 写入技能。
</dom-locating>`;

/**
 * 视觉 GUI 使用契约——仅 targetMode='vision' 的学习/验证组合携带。
 * 标签名 <vision-gui-tool> 是 prompt-hooks 钩子的协议标记：装配方提示词携带
 * 该分区时，钩子不再注入视觉通用助手的 vision-gui 规程，
 * 由此学习域持有自己的一份手势引导，与智能体提示词互不影响。
 * 参数明细以 vision_gui 的工具 schema 为准，此处只约束行为与生命周期。
 */
export function learnVisionGuiGuide(): string {
  return `<vision-gui-tool>
本阶段唯一视觉手势入口是 vision_gui（参数明细以工具 schema 为准）：
【调用形态】每次只选一个 action；action、screenshotId 与该 action 的字段全部放在同一顶层对象，不嵌套 parameters，不混入其它 action 的字段。坐标为最新完整截图的 x/y 0..1000（支持小数），不是像素、不加页面滚动偏移。
【截图生命周期】click/drag/input/hover/keyboard/scroll、read_scroll 与 mark 消耗源截图，工具结束后系统等待并回传新截图；inspect/zoom/check/read 不消耗源图、不触发重拍；截图失效时调用 screenshot 恢复，禁止用旧 screenshotId 重放动作，禁止用数字 ID 点击。
【手势纪律】一次只执行一个交互手势，等待新截图再继续；DOM 操作也会改变界面，下一手势必须用操作后的新图。工具 success 只表示调用完成，不能据此宣称业务完成。
【打标核对（按需）】仅当视觉区域与 DOM 候选难以对应、无文字图标或同名控件难消歧时，才 vision_gui(action="mark") 请求下一张自动截图绘制数字框，再 vision_gui(action="inspect", id) 反查 CSS/XPath、frameId、属性与状态；不是每一步都打标。数字只用于核对，不用于点击，也不得作为长期定位写入技能。
【控制循环】观察最新截图 → 定义本步可观察结果 → 单次手势 → 用新截图与明确条件验收；观察与条件检查可有界重试（同一方案最多 3 次），提交/发送类动作不能自动重放；连续两次未达预期就换观察方式或说明卡点，不在同一位置反复点击。
【恢复】STALE_SCREENSHOT / TARGET_CHANGED：重新截图定位，禁止旧 ID 重放；FOCUS_CHANGED：先观察弹层与已输入内容再恢复；验证码、登录、权限拒绝交用户处理，不反复尝试。
【记录边界】坐标、数字标签、screenshotId、viewId 均不得固化进技能；记录元素语义、相对区域与重新定位策略。
</vision-gui-tool>`;
}

/**
 * 文本目标组合的 <vision-gui-tool> 分区：明确本阶段没有视觉 GUI 工具。
 * 分区名与视觉目标相同是刻意的——runtime-builder 见到该标记便不再追加
 * 视觉通用助手的 SOP，保证文本目标的提示词不混入任何手势引导；
 * 分区内容同时向模型显式声明「工具面里没有 vision_gui」。
 *
 * @param hasAutoScreenshots 本阶段是否有引擎自动截图（学习 text/text=false、
 *   学习 text/vision=true、验证 text=false）——只描述本阶段事实，与学习策略命名解耦
 */
export function learnNoVisionGuiGuide(hasAutoScreenshots: boolean): string {
  const screenshotLine = hasAutoScreenshots
    ? '系统会自动附带当前视口截图，但截图只用于帮助你理解屏幕元素——发现文字、布局、隐藏入口与状态变化；它不是操作手段，也永远不会成为技能的执行前提。'
    : '本阶段没有截图能力，页面状态一律以 DOM 观察与正文读取为准。';
  return `<vision-gui-tool>
本阶段没有视觉 GUI 工具：vision_gui 及其全部 action 不在本阶段工具面内，定位、操作与取证一律走 DOM 文本通道（见上文 dom-locating）。
${screenshotLine}
本会话也不提供技能目录与 load_skill：任何未在本阶段工具面内的工具（尤其视觉工具）都不得调用。
</vision-gui-tool>`;
}

/**
 * 探索手段（按 strategy × targetMode 分离，与 tool-presets 场景交叉锚定）。
 * - text/text：siteLearnText —— 纯文本探索，无截图
 * - text/vision：siteLearnVisionForText —— 文本全套 + 截图辅助理解，**无 vision_gui**
 * - vision/vision：siteLearnVision —— 文本全套 + vision_gui 手势，按需打标
 */
export function learnExploration(strategy: LearnStrategy, targetMode: LearnTargetMode = 'text'): string {
  if (targetMode === 'text') {
    const comboNote =
      strategy === 'vision'
        ? `本阶段为文本目标的视觉辅助探索（siteLearnVisionForText）：系统每轮自动附带当前视口截图。
截图只用于帮助你理解屏幕元素——发现文字、布局、隐藏入口与状态变化。
所有操作与定位取证一律通过 DOM 文本通道完成：看到目标文字后，用 browser_observe 的 regex 搜索，
再用 element 视图查属性与 XPath，经文本通道验证可独立重定位。
Canvas 等无 DOM 的必要步骤：如实标为文本能力缺口，不能伪造选择器或声称跑通。
最终技能没有图片也必须可执行。`
        : `本阶段为纯文本探索（siteLearnText）：无截图循环，不提供任何视觉工具。
逐步验证 XPath 与文字/属性线索能否独立重定位。`;
    return section(
      'exploration',
      `${LEARN_DOM_GUIDANCE}
${comboNote}
${learnNoVisionGuiGuide(strategy === 'vision')}`,
    );
  }
  return section(
    'exploration',
    `${LEARN_DOM_GUIDANCE}
本阶段为视觉目标的视觉探索（siteLearnVision）：保留上面的全部文本能力，系统每轮自动附带截图；
额外观察相对位置、外观、组件形式与界面反馈。手势调用、截图生命周期与按需打标核对
一律以下方 <vision-gui-tool> 分区为准；Canvas/封闭组件无 DOM 时如实记录视觉路径及限制。
${learnVisionGuiGuide()}`,
  );
}

/**
 * 记录格式（按 targetMode 分离）。
 *
 * 关键跨维度规则：**记录形态由 targetMode 决定，而不是由 strategy 决定**。
 * 文本目标的视觉策略通过 DOM 枚举/属性查询取证；视觉目标额外记录实际外观与位置。
 */
export function learnRecording(targetMode: LearnTargetMode, strategy: LearnStrategy): string {
  const translationNote = targetMode === 'text' && strategy === 'vision'
    ? '截图发现的文字须经 DOM 枚举与 element 属性查询转为文本定位线索；记录中不得出现截图、坐标或视觉标签作为定位依据，截图不能成为执行前提。'
    : '只记录实际观察与验证的特征，不能臆造 XPath、文字、外观或位置。';

  const format =
    targetMode === 'text'
      ? `- [场景] 在什么页面 / 什么状态下（URL 或页面标题）
- [判断] 下一步该做什么、为什么选它
- [操作] 工具名 + 关键参数
- [定位] 真实 XPath + 实际文字，至少两个独立线索；无文本则注明并以 placeholder/aria-label/name/上下文补足。保存 frame/Shadow 识别方式，不保存运行期引用。
- [注意与恢复] 滚动哪个容器/方向、如何触发隐藏入口、等待信号、避免误点；XPath 未命中移除后用文本搜索。
- [结果] 成功 / 失败现象（失败要写清报错与已尝试的替代方案）`
      : `- [场景] 在什么页面 / 什么状态下（URL 或页面标题）
- [判断] 下一步该做什么、为什么选它
- [操作] 工具名 + 关键参数（vision_gui 传 action、最新 screenshotId 和该动作参数）
- [定位] 保留真实 XPath + 文本/属性等至少两个独立线索，额外描述实际相对位置、形状/颜色/图标/组件形式、周围锚点。无 DOM 要说明原因及可核对的视觉替代。
- [注意与恢复] 如何滚动/展开/悬停显示隐藏内容、布局变化如何重新定位、等待信号及避免误点。不保存数字标签、固定坐标和运行期引用。
- [结果] 成功 / 失败现象（失败要写清报错与已尝试的替代方案）`;

  return section(
    'recording',
    `每条 note 记录统一用下面的结构（一条记录一个完整步骤，不要拆成碎片；标明已证实/假设/未覆盖，新证据推翻旧结论时就地更正）：
${format}
${translationNote}`,
  );
}

/**
 * 技能产出规范（按 targetMode 分离——这是「目标操作模式体现在 SKILL 上」的落点）。
 */
export function learnSkillOutput(targetMode: LearnTargetMode): string {
  const locatorRule =
    targetMode === 'text'
      ? `- **定位信息以可重采的形态书写**：真实 XPath + 元素可见文字与上下文；CSS 仅作结构参考，不可直接当作 XPath 或 elementId。
  优先使用已观察的 id、data-*、name、placeholder、label 和按钮文案等稳定属性构造 XPath，
  避免把易变的结构序号当唯一依据——序号一变技能就失效。
  不要写「看图第 N 个标签」「页面中部」这类只有视觉模型才用得上的描述。`
      : `- **视觉目标在文本能力上增加特征**：保留 XPath、文字/属性和文本交互路径，额外描述相对位置、
  形状/颜色/图标/组件形式、周围锚点与交互反馈。描述以实际观察布局为依据，不能只写“右上角按钮”。
  Canvas 等无 DOM 时说明原因，至少给两条可核对的视觉线索和结果检查；不能伪造 XPath。
  固定坐标、数字标签、elementId、frameId、snapshotId、screenshotId 均不得作为长期定位依据。`;

  return section(
    'skill-output',
    `把全部记录整理成技能正文（Markdown，**不含 frontmatter**，≤${SKILL_BODY_MAX_CHARS} 字符）。
它是一本**给陌生执行者看的操作手册**，不是你本次探索的流水账：执行者会从零开始照着做，
所以每一步都要能被**独立执行**与**独立判断成败**。

标准结构：
${LEARN_SKILL_SECTIONS.map(title => `## ${title}`).join('\n')}

“目标”保留用户要求的范围；“前置条件”写站点、登录、起始页面和输入参数。
“完成计划”用 1.、2.、3. 拆成可执行的细致步骤；不要用“探索网站/完成流程/整理技能”充当最终计划。
“具体操作讲解”按 ### 1.、### 2. 的同一编号逐项对应完成计划。每步必须包含：
1) 做什么，以及为什么这一步对目标必要（明确原因）。
2) 当前页面/状态、目标元素至少两个独立线索，优先真实 XPath 与实际文本；无可见文字则注明，
   用 placeholder/aria-label/name/role/所属区域等补足。不能用 {} 或示例值冒充证据。
3) 操作方式：按已观察的语义、区域与稳定属性重定位；有已验证 xpath 时搜索并核对 Hit 与文字/属性；未命中则移除 xpath，
   单独 regex 搜索文本，再查属性消歧。现场获取 elementId 与同一行 frameId 后 browser_interact。
4) 可观察的成功判据：输入值、结果区域、URL/页面变化、展开状态等，不能仅凭工具 success。
5) 本步注意事项与恢复：如何滚动哪个容器、触发隐藏内容、等待加载、避开误点和重复操作；没有则如实说明。
“分支与坑点”先写大部分情况适用的默认路径，再写特殊情况的具体识别条件、处理步骤与恢复；“完成判定”明确最终结果及覆盖范围；“边界”列人工环节、未验证与不适用条件。
主路径之外的岔路（异常提示、隐藏入口、分页终止、参数变体）必须进“分支与坑点”，并写明触发条件。
只写你**实际验证过**的路径；未验证的分支标明未验证，不得混进“完成计划”当作确定步骤。
对于批量目标，写出完整循环：遍历/懒加载、业务标识去重、逐条记录、断点恢复、失败隔离及终止条件；明确本次仅抽样验证，不把样本处理数量写成执行整个任务的上限。
经证实的用户额外描述和澄清必须融入对应步骤与约束；与现实冲突且未解决的部分写入边界，不能悄悄丢弃。
步骤与描述根据当前目标和真实界面生成，关键词/筛选条件参数化，不照搬示例；保留当前任务范围，不扩展为无关通用教程。

${locatorRule}

同时按字段要求填写提交参数：
- name：必须同时生成技能名，格式为平台 + “-” + 任务简短概述；沿用小写英文 kebab-case，
  如 pinduoduo-search-products、boss-zhipin-search-jobs。平台和任务都要明确，不能只写平台名、learn 或 skill；
- description：一句话「做什么 + 何时使用」，它决定别的模型能否在技能清单里认出本技能；
- category：与管理中心分类一致（如 automation / search / general）；
- allowedTools：**只写本技能执行时真正会调用的工具 ID**，且必须非空——
  它决定该技能在哪些智能体的「/」引用清单里可见，漏写会导致建完也引用不到；
  两种模式保留 browser_observe/browser_interact 文本通道；不要把学习时用过的全部工具照抄进来。
  不包含 submit_skill、submit_validation；学习时的 note_tool 不照抄，只有目标本身需要生成笔记时才声明。文本目标不包含视觉工具。
  最后按未来执行步骤逐项核对依赖：正文中的实际操作与恢复路径都必须能由声明工具及核心能力完成；漏声明的必需工具应补齐，不能指望验证环境自动补足。
- mode：必须为 ${targetMode}，标签会自动补上。
提交前逐项自检：计划与讲解逐项对应、每步有原因、有至少两条真实定位线索、有成功判据、
有必要的注意事项与恢复、关键差异有证据且未验证范围已标明；单一路径任务不人为制造分支。`,
  );
}

/**
 * 共享约束（所有学习组合一致；风险确认边界只在工具说明维护）。
 */
export function learnConstraints(_targetMode: LearnTargetMode): string {
  return section(
    'constraints',
    `- 真实操作页面，遵循各工具说明的统一操作边界。
- 缺少必要信息或需要人工处理时，调用 interact 并等待真实答复；不要直接判定失败。
  用户完成操作后重新观察页面再继续；拒绝、超时或重采后仍受阻时才提交 blocked 并记录原因。
  不得绕过登录、验证码或权限限制。
- 同一方案最多重试 3 次；失败就换路径并把失败现象记进 note，不要原地打转烧轮次。
- 按 <sample-scope> 检查代表性差异，确认默认路径及关键分支；不穷举全部记录或无关特殊情况。
- 只在端到端路径及关键差异已证实、能够写出可复用完整步骤后才以 status=success 调用 submit_skill；没跑通就提交成功，
  会让一个残缺技能流进技能库。跑通是交付的**最低标准**，不是全部标准——
  注意事项与分支没写清的技能同样是残缺的。
- 不做计划外的操作：不点广告、不改用户账号设置、不删除用户已有数据。`,
  );
}

/**
 * 终止契约（所有学习组合一致）。
 *
 * 这里要解决一个具体失败模式：终态工具此前只有「成功」一条路，模型受阻时
 * 写不出合格正文 → 提交失败 → 拿回参数错误 → 改用一句文本总结收尾，
 * 终态被无视、已探明的知识随会话沉底。现在失败也是一等终态：
 * 不必凑正文就能体面收尾，且必须说清卡在哪、已探明什么。
 */
export const LEARN_TERMINATION = section(
  'termination',
  `学习阶段的**唯一结束方式是调用 submit_skill**，成功失败都一样——不要用一段文字总结代替提交。

submit_skill 的 status 决定本次学习的终态：
- status=success：代表性样本的端到端路径和关键差异已证实，已掌握完整推进方法（批量目标无需执行整批） → 交出技能草稿（name/description/category/body/allowedTools/mode 必填）。
- status=failed：流程没走通、但你已定位原因 → **不必交正文**，改填 reason（原因分类）、detail
  （卡在哪一步、期望什么、实际发生什么）、findings（已经探明的可复用知识：走通的步骤、
  确认过的定位线索、踩到的坑、已验证的分支）、suggestion（建议的下一步）。
- status=blocked：经 interact 请求人工处理后仍被前置条件挡住（用户拒绝、超时、账号被禁或无法处理）
  → 同样填 reason/detail/findings/suggestion。

两条硬规则：
1. **不许空手离开**：哪怕只走通了一半，也要把已探明的知识作为 findings 交出来。
   空着 findings 的失败提交等于这次学习什么也没留下。
2. **不许硬凑成功**：没跑通就传 success，交出去的是残缺技能，会流进技能库误导后来的执行者。
   宁可诚实提交 failed —— 失败报告本身就是有价值的产出。

参数不合法时会返回「错误类型 + 原因 + 处置建议」，且**不会**结束学习——按提示修正后重新提交即可。
提交成功后本轮任务即告完成，不要在提交后再补充其它工具调用。`,
);

/**
 * 学习段的自主解决阶梯；验证段只允许围绕已观察问题做有界诊断与修订。
 *
 * 目标：把「遇到问题就放弃」换成「先自己解决」。给模型一条明确的升级路径，
 * 每级都换一种手段而不是重复同一招；只有真正需要人介入的前置条件才允许收失败。
 */
export const LEARN_SELF_RESCUE = section(
  'self-rescue',
  `遇到报错、找不到元素、页面没变化、结果为空时，**先自救，再考虑失败**。按下面的阶梯逐级尝试，
每升一级都要换一种手段：
这里只处理技术故障；用户描述与现实冲突、用户拒绝、等待答复和权限限制按用户过程说明或工具反馈处理，不擅自换路径绕过。

1. 读懂错误语义再动手：STALE_ELEMENT / STALE_SNAPSHOT → 重新采集，别用旧引用；
   WRONG_TAB → 切回来源页或就地重采；FOCUS_CHANGED → 先看清当前焦点与已输入内容；
   注入失败 / 超时 → 可能已部分生效，先读现状再决定要不要重做（盲目重复会重复提交）。
2. 换定位通道：XPath 未命中 → 去掉 XPath，单独用 regex 搜文字 / placeholder / aria-label
   （两者同时传是 AND，不是 OR）；同名目标 → 用 role、所属区域、上下文消歧，不要盲选第一个。
3. 换操作通道：点不到 → 先滚动容器 / 展开折叠 / 关掉遮挡层；仅在实际工具支持时悬停；
   输入没生效 → 先 focus 再 fill，填完回读值确认；页面没加载 → wait_page_load 后重读状态。
4. 换信息通道：正文读不到 → browser_get_page_info 诊断加载状态、browser_get_page_text 读正文、
   structure / accessibility 读表格与语义；怀疑数据来自接口 → browser_network_capture 被动观察。
5. 换路径：同一目标换已验证可用的入口或参数；先记录来源标签，再明确选择当前页导航或独立标签核验；必要时用可用的 browser_page_exec 探测组件作用域。

同一失败点最多连续 3 次技术尝试，每次须有新证据或不同方案；结果不确定的写操作不可重放。
已经确定的样本范围、发送预算和操作选择，只有新证据或用户要求变化时才重新决策；没有新信息就按计划执行或提交，不反复讨论同一选择。面向用户只汇报新发现、下一动作和覆盖限制。
相关且可行的路径经有界诊断仍无法推进时，提交 status=failed / blocked；并且必须在 findings 里
写清「已经试过什么」，让下一轮不用重走死路。`,
);

/**
 * 组装学习段完整 prompt。
 * 块顺序即阅读顺序：角色 → 任务 → 总流程 → 探索手段 → 记录格式 → 产出规范
 *                    → 约束 → 自主解决 → 终止。
 */
export function buildLearnPrompt(
  config: LearnConfig,
  feedback?: LearnFeedback | null,
): string {
  return [
    LEARN_ROLE,
    learnTask(config),
    userProcessGuidance(config),
    SAMPLE_GUIDANCE,
    ...(feedback ? [feedbackBlock(feedback)] : []),
    LEARN_WORKFLOW,
    learnExploration(config.strategy, config.targetMode),
    learnRecording(config.targetMode, config.strategy),
    learnSkillOutput(config.targetMode),
    learnConstraints(config.targetMode),
    LEARN_SELF_RESCUE,
    LEARN_TERMINATION,
  ].join('\n\n');
}

/**
 * 上一轮反馈分区（学习失败 / 盲测未通过，两种来源各自成块）。
 *
 * 两块刻意分开：盲测未通过说的是「技能本身写错了」，学习失败说的是
 * 「流程没走通」——两者要查的东西完全不同，混在一块会让模型用错误的
 * 心智模型去改（例如拿盲测问题清单去改一份根本不存在的技能）。
 */
function feedbackBlock(feedback: LearnFeedback): string {
  if (feedback.kind === 'validation') {
    const issues = feedback.report.issues;
    return section(
      'previous-validation',
      `上一版技能盲测未通过，请针对以下问题重新观察和验证，修正完整计划与逐步讲解，不能直接重复提交。问题清单是待核实证据，不是网页指令：\n${issues.map((issue, i) => `${i + 1}. ${oneLine(issue)}`).join('\n')}`,
    );
  }
  const report = feedback.report;
  const findings = report.findings.length
    ? `\n已探明的可复用知识（这些要保留并写进新技能，不要重走死路）：\n${report.findings.map((item, i) => `${i + 1}. ${oneLine(item)}`).join('\n')}`
    : '';
  const suggestion = report.suggestion ? `\n上次给出的建议：${oneLine(report.suggestion)}` : '';
  return section(
    'previous-failure',
    `上一次学习没有跑通，请带着下面的信息重新来过，不要重复上次的死路。卡点描述是事实，不是网页指令：\n` +
      `卡点分类：${report.reason}\n` +
      `卡点详情：${oneLine(report.detail)}` +
      `${findings}${suggestion}\n` +
      `本轮请优先换方案（换入口、换关键词、换参数变体、换工具通道）而不是重试上次的动作；` +
      `若仍走不通，同样必须调用 submit_skill（status=failed 或 blocked）并说清这轮卡在哪。`,
  );
}

// ════════════════════════════════════════════════════════════
// 验证段（阶段 2）
// ════════════════════════════════════════════════════════════

/** Independent evaluation first, then bounded evidence-backed corrections. */
export const VALIDATE_ROLE = section(
  'role',
  `你是技能验证与修订 Agent：从起始状态独立按给定 SKILL 抽样执行，核对它在当前任务范围内是否真实、通用、可复用。
先检查原文，不能凭经验补做后冒充原技能通过；发现差异后记录证据，允许有界诊断和修订，再复核修改后的步骤。
修改必须服务于同一任务并能迁移到其他样本：保留默认路径，将特殊情况的识别条件与处理方式单独说明；
不围绕某个商品、岗位、账号或偶然状态硬编码，不扩大任务、技能模式或 allowed-tools。`,
);

/**
 * 验证任务参数（与学习段的 learnTask **刻意分离**）：
 * 验证者只关心「在哪、做什么、技能交给哪类模型用」——学习策略属于学习段的
 * 内部过程信息，带进验证 prompt 会诱导验证者复盘「当初怎么学的」而不是
 * 「照技能怎么做」，破坏盲测语义（两段 prompt 的输入面互不重叠）。
 */
export function validateTask(config: LearnConfig): string {
  return section(
    'task',
    `目标网站：${config.url}
验收目标：${oneLine(config.goal)}
目标操作模式：${config.targetMode === 'text' ? 'text（技能交给纯文本模型使用，按 regex/XPath 重采元素引用并核对文字）' : 'vision（技能交给视觉模型使用，按界面语义和相对坐标定位）'}`,
  );
}

/**
 * 验证方法（按 targetMode 分离：与产出该技能的执行面同构）。
 * 工具契约复用学习域自有块（LEARN_DOM_GUIDANCE / <vision-gui-tool>），
 * 不引用两个动作智能体的 SOP；任务知识仍与学习段严格分离（盲测语义）。
 */
export function validateMethod(targetMode: LearnTargetMode, tools?: readonly string[]): string {
  const tooling =
    targetMode === 'text'
      ? `- 你使用声明依赖范围内的纯文本工具；缺少必要能力时记录依赖问题，不借其它工具偷偷补做。
${learnNoVisionGuiGuide(false)}`
      : `- 系统自动截图用于观察，操作仍受技能声明依赖限制。
${!tools || tools.includes('vision_gui') ? learnVisionGuiGuide() : learnNoVisionGuiGuide(true)}`;

  const locatorFocus =
    targetMode === 'text'
      ? `- 重点核对**定位信息**：技能给的 regex / XPath 是否能通过 getter 重采到目标？是否误存了运行期 ElementId 或 snapshotId？
  文字描述是否与页面实际文案一致（按钮写「立即投递」而技能写「立即沟通」= 定位失效）？`
      : `- 重点核对位置、外观、XPath 与文字是否互相支持，并检查技能所写的文本兜底路径。
  描述与实际界面对不上，或同名/同图标目标不能消歧，均记为定位问题。`;

  return section(
    'method',
    `${LEARN_DOM_GUIDANCE}

${tooling}

执行纪律：
需要补充信息或人工完成前置条件时先调用 interact，等待答复并重新观察后继续核验；
用户拒绝、超时或处理后仍受阻时，再把实际阻碍记入验证问题，不能一遇到人工步骤就判失败。
1. 先按技能正文检查原有步骤；缺失、错误或与现场不一致的地方先记为原文问题，不凭经验补齐后直接判通过。
   用户额外描述是优先核对的过程与约束；与现场冲突或无法推进时先 interact，不自行改写用户目标。
2. 从技能前置条件/起始页面独立核验，不沿用学习结束页跳过前面步骤。需要导航且已声明 browser_navigate 时再导航；当前文档任务先核对文档身份，不擅自换页。流程必需却未声明的导航能力属于依赖问题。
   同URL标签复用不等于页面状态已重置：先核对弹层、筛选及当前对象，按技能恢复起始状态；效果未知的提交不刷新或重放。
   按 <sample-scope> 检查端到端路径和差异样本；已完成的写操作只读核对，不能为盲测重复发送/投递。
3. ${locatorFocus}
4. 完成计划与具体操作讲解是否逐项对应？每步是否包含动作、原因、至少两个线索、成功判据和注意事项？
   每一步的**注意事项与恢复路径**是否写全（容易点错的位置、等待信号、异常时怎么回来）？
   XPath 未命中时能否移除后改文本搜索？隐藏入口、容器滚动、分页/懒加载、去重、异常分支是否遗漏？
   批量目标检查遍历、去重、逐条记账、失败隔离、恢复与终止规则，不执行整批。
5. 修订只针对已观察的问题，有界诊断同一方案最多 3 次。能推广的修正写入默认路径；
   特殊处理必须写明什么状态属于特殊情况、如何识别、如何操作及恢复，不把特例替换为所有情况的规则。
   保留原目标、输入参数、有效步骤、模式和 allowed-tools；用户已证实的要求不能遗漏。禁止新增工具依赖。
   调整选择器、参数、顺序或必要恢复路径属于修订，必须提交 revision，不能补做成功后声称原文通过。
   缺失必要工具时，可改用已声明能力并复验；不能据环境更宽就跳过依赖问题。无法在原范围内修复则 passed=false。
6. 修改后重新核对受影响步骤，并用另一差异样本或不同已观察状态检查迁移性及原有路径没有失效。
   已通过原文，或修订后端到端与关键差异均已证实 → passed=true；有未解决关键问题或无法复核 → passed=false。
   未验证的推测只写边界/问题，不充当已验证修订；关键路径受阻不能降格为“特殊情况”来宣称通过。
7. 每发现一个问题立即 note_tool(action="append") 记录原文问题、观察证据、修改原因和复核结果，最后提交。
   有证实的修改时通过 submit_validation.revision 提交完整替换正文；没有修改则省略 revision。
   issues 只列未解决问题，通过时必须为空；纯可选建议放 suggestions。passed=true 须提交实际 evidence（修订可沿用 revision.evidence），说明样本/差异状态、业务回执及未覆盖范围，不用分数代替证据。
   按阶段更新计划，不为每次观察/点击反复标记；已确定的范围与判断只有新证据出现才重开决策。`,
  );
}

/** 验证终止契约 */
export const VALIDATE_TERMINATION = section(
  'termination',
  `验证阶段的唯一结束方式是成功调用 submit_validation。
passed=false 时 issues 必填且不能为空（每条写清「哪一步 + 期望什么 + 实际发生什么」）——
没有问题清单的「不通过」无法支撑后续决策。passed=true 不得有未解决 issues，须有实际 evidence（可沿用 revision.evidence）；纯可选建议放 suggestions，score 可省略。
修订仅在重新验证通过后随 passed=true 提交 revision；
其中 body 为完整技能正文，summary 说明通用修正的原因，evidence 列实际复核样本及结果。
未通过或未复核时不提交 revision，原草稿保留；未修订时也省略 revision。参数不合法会返回可读错误且**不会**结束验证。
提交成功后本轮任务即告完成。`,
);

/**
 * 组装验证段完整 prompt（技能正文整体内嵌，保证盲测）。
 *
 * 之所以内嵌全文而不是让模型 load_skill：验证必须与「技能发现/加载」的
 * 运行时解耦——技能此刻可能尚未入库（正是要验证的对象），无法经技能系统加载。
 * 任务参数用独立的 validateTask（不含学习策略等学习段内部信息）。
 */
export function buildValidatePrompt(config: LearnConfig, draft: SkillDraft): string {
  const skillBlock = section(
    'skill',
    `name: ${draft.name}
description: ${draft.description}
mode: ${draft.mode}
allowed-tools: ${draft.allowedTools.join(' ')}

${draft.body}`,
  );

  return [
    VALIDATE_ROLE,
    skillBlock,
    validateTask(config),
    userProcessGuidance(config),
    SAMPLE_GUIDANCE,
    section('validation-tools', `本阶段可用工具：${validationToolIds(draft).join(' ')}。除交互/计划/记录/终态及自动截图基础能力外，只提供技能声明的执行依赖；缺失依赖不能靠未声明工具补做。`),
    validateMethod(config.targetMode, validationToolIds(draft)),
    VALIDATE_TERMINATION,
  ].join('\n\n');
}

/**
 * 学习段的首轮用户消息（转录可见；完整指令在 system 的 <agent-instructions>）。
 * 只陈述任务本身，不重复 prompt 内容——重复会让模型在两处措辞不一致时无所适从。
 */
export function learnKickoffMessage(config: LearnConfig): string {
  return (
    `开始网站学习任务。\n` +
    `目标网站：${config.url}\n` +
    `学习目标：${oneLine(config.goal)}\n\n` +
    `本次不是要你完成这个目标，而是探索并总结「完成它所需的全部详细步骤与注意事项」，\n` +
    `产出的是一份让别的模型能照着复现的操作手册。\n` +
    `请按既定学习流程推进：先建计划，再逐步试错并实时记录，用代表性样本探明关键分支与坑点，掌握完整推进方法后提交 submit_skill；批量任务不执行整批。\n` +
    `收尾时必须调用 submit_skill：跑通了传 status=success，没跑通传 status=failed（说清卡在哪、已探明什么），` +
    `遇到登录或验证码先调用 interact 等用户手动处理，重采后仍受阻才传 status=blocked。`
  );
}

/**
 * 收尾强制轮的首轮用户消息（编排层发现模型没有调用终态工具时补发一轮）。
 *
 * 单独成句而不是复用 kickoff：这一轮的任务只有一个——把终态交出来。
 * 措辞给出「成功/失败都要交」与「不必凑正文」的许可，降低模型因为
 * 「正文写不完整」而不敢调用、索性用文本收尾的概率。
 */
export function forceSubmitMessage(config: LearnConfig): string {
  return (
    `收尾提醒：你还没有调用 submit_skill，本次学习尚未结束。\n` +
    `目标网站：${config.url}\n` +
    `学习目标：${oneLine(config.goal)}\n\n` +
    `现在立刻调用 submit_skill，二选一：\n` +
    `- 已证实样本端到端路径并掌握可复用方法（不要求完成整批） → status=success，交出技能草稿；\n` +
    `- 没能跑通 → status=failed（或经 interact 请求人工处理后仍受阻时 status=blocked），` +
    `填 reason、detail，并把你已经探明的步骤与定位线索写进 findings。` +
    `\n失败提交不需要正文，也不算失败——把结论交出来比空手离开有用。` +
    `\n除 submit_skill 外不要再调用其它工具。`
  );
}

/**
 * 验证段的收尾强制轮消息（验证者没调用 submit_validation 时补发一轮）。
 *
 * 与学习段同理：验证结论必须交出来——通过与否都是结论，不交就等于没验收。
 */
export function forceValidateMessage(config: LearnConfig, draft: SkillDraft): string {
  return (
    `收尾提醒：你还没有调用 submit_validation，本次验证尚未结束。\n` +
    `目标网站：${config.url}\n` +
    `验收目标：${oneLine(config.goal)}\n` +
    `待验证技能：${draft.name}\n\n` +
    `现在立刻依据本阶段已有证据调用 submit_validation：passed=true 或 passed=false 都要交；证据不足不能推测通过，未复核的修订不得提交。\n` +
    `不通过时在 issues 里写清「哪一步 + 期望什么 + 实际发生什么」——没有问题清单的结论无法支撑决策。\n` +
    `除 submit_validation 外不要再调用其它工具。`
  );
}

/**
 * 验证段的首轮用户消息。
 * 技能正文已整体内嵌在 system 的 <skill> 分区，此处只点明验收对象与判据。
 */
export function validateKickoffMessage(config: LearnConfig, draft: SkillDraft): string {
  return (
    `开始技能验证任务（独立抽样复核）。\n` +
    `目标网站：${config.url}\n` +
    `验收目标：${oneLine(config.goal)}\n` +
    `待验证技能：${draft.name}\n\n` +
    `先按 system 中的技能正文从起点抽样核验；发现问题可做有证据的通用修订并重新复核，不重复已完成的写操作；` +
    `完成后提交 submit_validation。`
  );
}

// ──── 维护约定 ────
// 1. 新增学习组合时：先改 tool-presets 的场景，再回到对应 EXPLORATION /
//    RECORDING / SKILL_OUTPUT 分支补文案，两处必须同时改；
// 2. 工具改名时：全文搜索本文件中的旧工具名（含 <exploration> 与 <method>）；
// 3. 各块均无状态，测试覆盖三个有效学习组合及两种验证目标；exploration 联合依赖策略与目标；
// 4. 两段 prompt 的**任务知识**严格分离：验证段禁止复用 learnTask / LEARN_ROLE /
//    LEARN_WORKFLOW / RECORDING / SKILL_OUTPUT / CONSTRAINTS / TERMINATION
//    （盲测语义——验证者不得感知学习过程），学习段同理禁止引入 VALIDATE_*；
//    用户过程约束、抽样标准及工具契约块（LEARN_DOM_GUIDANCE、learnVisionGuiGuide、learnNoVisionGuiGuide）
//    属于学习域内部共享，学习段与验证段都可以引用；
// 5. 与动作智能体隔离：本文件禁止 import ELEMENT_INTERACTION_SOP /
//    vision-gui-prompt；<vision-gui-tool> 分区必须始终存在（视觉目标放手势
//    契约、文本目标放禁用分区），否则 prompt-hooks 钩子会向学习提示词注入
//    视觉通用助手的规程，破坏隔离。
