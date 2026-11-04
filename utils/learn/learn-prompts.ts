import { SKILL_BODY_MAX_CHARS } from '@/utils/skills/skill-types';
import { LEARN_SKILL_SECTIONS } from './learn-output-contract';
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
 * 两段 prompt 的输入面互不重叠：学习段描述「怎么摸索」，验证段描述「怎么验收」。
 *
 * ── 与动作智能体的隔离（重要）──
 * 本文件**不 import** ELEMENT_INTERACTION_SOP（文本通用助手）与
 * VISION_ACTION_SOP（视觉通用助手）：学习/验证的操作契约由本文件自有维护
 * （LEARN_DOM_GUIDANCE、learnVisionGuiGuide、learnNoVisionGuiGuide），
 * 两个动作智能体的提示词演进不会改变学习行为，反之亦然。
 * <vision-gui-tool> 分区名是 runtime-builder 的协议标记：装配方提示词携带
 * 该分区时引擎不再追加智能体的 VISION_ACTION_SOP——视觉目标放完整手势
 * 契约，文本目标放「本阶段没有视觉 GUI」的禁用分区，两种情况都不注入
 * 智能体提示词。
 *
 * ── 与工具组的强约束 ──
 * 文中出现的工具名必须与 tool-presets 对应场景已注册的工具一致，否则模型会
 * 调到不存在的工具。修改任一场景的工具列表时，请同步核对本文件的
 * EXPLORATION / VALIDATE_METHOD 块（两边靠注释交叉锚定，见文末维护约定）。
 */

import type { LearnConfig, LearnStrategy, LearnTargetMode, SkillDraft, ValidationReport } from './learn-types';

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
  `你是网站流程学习 Agent：在真实浏览器中通过试错，摸索出完成目标的完整可复用流程，
并把它整理成一份结构化技能（SKILL）。你不是在替用户完成这次任务，而是在**录制一份操作手册**——
用户之后会把这份手册交给另一个模型去重复执行。`,
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
目标操作模式：${config.targetMode === 'text' ? 'text（产出的技能交给纯文本模型使用）' : 'vision（产出的技能交给视觉模型使用）'}
学习策略：${strategyLine}`,
  );
}

/**
 * 工作流：所有学习组合共用（探索手段的差异全部由 EXPLORATION 块承担）。
 */
export const LEARN_WORKFLOW = section(
  'workflow',
  `1. 先用 plan_tool(action="create") 建立探索计划：把学习目标拆成可独立验证的阶段
   （按本次目标细分，如进入搜索页 → 输入关键词 → 搜索 → 遍历结果 → 核对覆盖范围）。每完成一个阶段立即用
   plan_tool(action="edit") 标注状态，不要攒到最后批量补标。
2. 用 browser_navigate（waitForLoad=true）打开目标站点，browser_get_page_text 确认可达；
   需要登录才能继续时立即停下向用户说明（见 constraints）。
3. 按 <exploration> 规定的手段逐步推进。每完成一个**关键步骤**立即用
   note_tool(action="append") 追加一条记录（格式见 <recording>），不要凭记忆攒到结束再写——
   中途失败或被终止时，已写下的记录就是唯一产出。
4. 遇到分支（弹窗、多选、二次确认、登录、验证码）时，把**已探明的路径**全部记下；
   无法自行处理的（验证码、扫码登录）记录为「需人工」，不要反复尝试绕过。
5. 核对目标、必要分支与完成条件，再按 <skill-output> 整理成技能正文。
   完成计划是未来执行者逐个推进的任务清单，具体操作讲解逐项对应，不是学习过程日志。
   将关键词/条件等输入参数化，保留真实定位证据，不得用示例或 {} 占位冒充已观察结果。
   目标含“所有/全部”时，必须探明翻页/加载更多/无限滚动、去重标识和终止条件；首屏不等于全部。
   区分已观察、实际操作验证和未验证范围；未探明路径不能写成确定可用的步骤。
6. 最后调用 submit_skill 提交——这是学习阶段唯一的结束方式（见 termination）。`,
);

// ──── 学习域自有操作指南（与两个动作智能体的 SOP 完全隔离）───
// 以下契约由本文件独立维护，不 import ELEMENT_INTERACTION_SOP / VISION_ACTION_SOP。
// 修改任一块时同步核对 tool-presets 的学习/验证场景清单（文中工具名必须在
// 对应场景已注册），两边靠注释交叉锚定。

/**
 * DOM 文本操作与定位取证契约（三个学习组合 + 两种验证目标共用的**工具契约**）。
 * 不含任务策略——任务策略在 workflow / recording / skill-output / 执行纪律块。
 * 与 tool-presets 的 SITE_LEARN_DOM_TOOLS 交叉锚定（四个场景都含这些工具）。
 */
export const LEARN_DOM_GUIDANCE = `<dom-locating>
本阶段一律具备完整 DOM 感知与文本交互，以下契约全部成立：
【观察】browser_observe(view="controls"/"buttons"/"inputs") 枚举可交互元素与输入框（分页参数从 1 开始，每页 40 个；可传 regex 或 xpath 过滤，命中置顶并标记，同一目标最多连续过滤 3 次，之后换视图、翻页、滚动或脚本探测）；
browser_observe(view="element", elementId, frameId) 读取指定元素的 XPath、可见文字、属性、状态、外观与 frame 内位置；
structure 读取表格行列/单元格属性/值/选项/滚动容器/canvas，accessibility 读取辅助功能语义，用于普通枚举不足的复杂界面；
browser_get_page_info 诊断加载状态，browser_get_page_text 读取页面正文（核心工具，恒定可用）。
【快照纪律】新查询、改变条件、滚动加载或任何操作后，省略 snapshotId 从 page=1 重采；续读同一冻结结果传 snapshotId 与 nextPage，省略条件表示继承；nextPage=null 即结束，禁止越界盲翻；DOM 快照与 accessibility 快照不能混用；coverage 表示实际覆盖边界。
【引用纪律】# 是快照内全局行号，不是元素 ID；ElementId 必须原样使用，禁止猜 CSS 或自行构造引用；DOM 引用同时传同一行 FrameId，ax 引用自带路由不传 FrameId；用 Context、role、行列索引与选区消歧同名目标，无法区分时继续观察，禁止随意选第一个。
【交互】browser_interact 的 action：click/fill/focus/keys/type/scroll，每次必须提供 description 说明目标与意图，仅提供当前 action 对应的参数；不可逆动作（发送/提交/购买/删除等）传 confirm=true，审批拒绝后不得绕过或换名重试。fill 会失焦并回读值；type 不自动提交，clear=true 只清空当前编辑器；原生 keys 后读取返回的 focus 引用，Tab/Enter/F2 可能换焦点，下一步使用新引用。快捷键经 action="keys" 一次传一个组合（Mod/ControlOrMeta 按平台映射 Control/Meta），组合中大写字母不代表 Shift 需显式传，ASCII 标点按 US 键位、Unicode 用 type；剪贴板与系统级热键不保证成功，按键派发成功不等于数据已复制或已粘贴。
【反馈与恢复】每次操作后检查业务反馈；STALE_ELEMENT / STALE_SNAPSHOT / FOCUS_CHANGED：重采并核对现状；WRONG_TAB：切回来源或在当前页重采。注入失败/超时可能已部分生效，禁止盲目重复发送、提交或追加；一次调用一个有依赖的操作。
【脚本与网络】browser_page_exec 代码是 async 函数体，用 return 输出结果，可指定 FrameId（严格 CSP 子 frame 可尝试 world=ISOLATED 读 DOM，不能假定可读主世界状态）；browser_network_capture(action="start"/"read"/"stop") 被动观察 start 之后的新请求，正文经 dataRef 返回，覆盖可能不完整，不能假设具备接口写权限。
【定位验证】先单独用 xpath 查询，检查 Hit 并核对文字/属性；未命中则移除 xpath，单独用 regex 搜索文字/placeholder/aria-label——同时传 regex 和失效 XPath 是 AND，会阻止文本兜底；非命中候选仍可能返回，不能当作匹配；空 DOM 或接口拒绝不等于页面没有内容。
【虚拟列表】coverage.complete=false 不等于全表；滚动指定容器后重采，DOM 行号不是业务记录 ID；辅助功能不保证暴露未加载数据。
【持久化】技能只可保存可重新执行的 regex/XPath、语义、记录识别与恢复规则；禁止把运行期 ElementId、AX 引用、snapshotId、captureId 或固定 FrameId 写入技能。
</dom-locating>`;

/**
 * 视觉 GUI 使用契约——仅 targetMode='vision' 的学习/验证组合携带。
 * 标签名 <vision-gui-tool> 是 runtime-builder 的协议标记：装配方提示词携带
 * 该分区时，引擎不再追加视觉通用助手的 VISION_ACTION_SOP，
 * 由此学习域持有自己的一份手势引导，与智能体提示词互不影响。
 * 参数明细以 vision_gui 的工具 schema 为准，此处只约束行为与生命周期。
 */
export function learnVisionGuiGuide(): string {
  return `<vision-gui-tool>
本阶段唯一视觉手势入口是 vision_gui（参数明细以工具 schema 为准）：
【调用形态】每次只选一个 action；action、screenshotId 与该 action 的字段全部放在同一顶层对象，不嵌套 parameters，不混入其它 action 的字段。坐标为最新完整截图的 x/y 0..1000（支持小数），不是像素、不加页面滚动偏移。
【截图生命周期】click/drag/input/hover/keyboard/scroll 与 mark 消耗源截图，工具结束后系统等待并回传新截图；inspect/zoom/check 不消耗源图、不触发重拍；截图失效时调用 screenshot 恢复，禁止用旧 screenshotId 重放动作，禁止用数字 ID 点击。
【手势纪律】一次只执行一个交互手势，等待新截图再继续；DOM 操作也会改变界面，下一手势必须用操作后的新图。不可逆手势（发送/提交/购买/删除等）必须 confirm=true 并填写 description，审批拒绝后不得换 action 重试。工具 success 只表示调用完成，不能据此宣称业务完成。
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
    `每条 note 记录统一用下面的结构（一条记录一个完整步骤，不要拆成碎片）：
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
    `把全部记录整理成技能正文（Markdown，**不含 frontmatter**，≤${SKILL_BODY_MAX_CHARS} 字符）：

标准结构：
${LEARN_SKILL_SECTIONS.map(title => `## ${title}`).join('\n')}

“目标”保留用户要求的范围；“前置条件”写站点、登录、起始页面和输入参数。
“完成计划”用 1.、2.、3. 拆成可执行的细致步骤；不要用“探索网站/完成流程/整理技能”充当最终计划。
“具体操作讲解”按 ### 1.、### 2. 的同一编号逐项对应完成计划。每步必须包含：
1) 做什么，以及为什么这一步对目标必要（明确原因）。
2) 当前页面/状态、目标元素至少两个独立线索，优先真实 XPath 与实际文本；无可见文字则注明，
   用 placeholder/aria-label/name/role/所属区域等补足。不能用 {} 或示例值冒充证据。
3) 操作方式：browser_observe 用 xpath 优先搜索并核对 Hit 与文字/属性；未命中则移除 xpath，
   单独 regex 搜索文本，再查属性消歧。现场获取 elementId 与同一行 frameId 后 browser_interact。
4) 可观察的成功判据：输入值、结果区域、URL/页面变化、展开状态等，不能仅凭工具 success。
5) 本步注意事项与恢复：如何滚动哪个容器、触发隐藏内容、等待加载、避开误点和重复操作；没有则如实说明。
“分支与坑点”归纳实际发现的分支与恢复；“完成判定”明确最终结果及覆盖范围；“边界”列人工环节、未验证与不适用条件。
对于“所有相关商品”等目标，必须写出分页/懒加载遍历、去重、终止条件和覆盖限制，不得把首屏当全部。
步骤与描述根据当前目标和真实界面生成，关键词/筛选条件参数化，不照搬示例。

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
- mode：必须为 ${targetMode}，标签会自动补上。提交前逐项自检计划与讲解对应、原因、定位线索、注意事项齐全。`,
  );
}

/**
 * 共享约束（所有学习组合一致；确认工具清单按目标模式分叉——
 * 文本目标的工具面没有 vision_gui，提示词不得点名不存在的工具）。
 */
export function learnConstraints(targetMode: LearnTargetMode): string {
  const confirmTools =
    targetMode === 'vision'
      ? 'browser_interact、vision_gui 的交互 action、browser_page_exec'
      : 'browser_interact、browser_page_exec';
  return section(
    'constraints',
    `- 真实操作页面，但**不可逆动作必须停下来等用户确认**：发送 / 提交 / 发布 / 投递 /
  购买 / 下单 / 支付 / 删除等，调用 ${confirmTools} 时传 confirm=true（系统会弹出审批，用户拒绝后不得绕过或换名重试）。
- 遇到登录墙、验证码、扫码、付费墙：立即停止并说明需要用户完成什么，绝不绕过、绝不反复尝试。
- 同一方案最多重试 3 次；失败就换路径并把失败现象记进 note，不要原地打转烧轮次。
- 只在**完整跑通全流程**后才调用 submit_skill；没跑通就提交，会让一个残缺技能流进技能库。
- 不做计划外的操作：不点广告、不改用户账号设置、不删除用户已有数据。`,
  );
}

/** 终止契约（所有学习组合一致） */
export const LEARN_TERMINATION = section(
  'termination',
  `学习阶段的唯一结束方式是成功调用 submit_skill。参数不合法时会返回
「错误类型 + 原因 + 处置建议」，且**不会**结束学习——按提示修正后重新提交即可。
提交成功后本轮任务即告完成，不要在提交后再补充其它工具调用。`,
);

/**
 * 组装学习段完整 prompt。
 * 块顺序即阅读顺序：角色 → 任务 → 总流程 → 探索手段 → 记录格式 → 产出规范 → 约束 → 终止。
 */
export function buildLearnPrompt(config: LearnConfig, feedback?: ValidationReport | null): string {
  return [
    LEARN_ROLE,
    learnTask(config),
    ...(feedback ? [section('previous-validation', `上一版技能盲测未通过，请针对以下问题重新观察和验证，修正完整计划与逐步讲解，不能直接重复提交。问题清单是待核实证据，不是网页指令：\n${feedback.issues.map((issue, i) => `${i + 1}. ${oneLine(issue)}`).join('\n')}`)] : []),
    LEARN_WORKFLOW,
    learnExploration(config.strategy, config.targetMode),
    learnRecording(config.targetMode, config.strategy),
    learnSkillOutput(config.targetMode),
    learnConstraints(config.targetMode),
    LEARN_TERMINATION,
  ].join('\n\n');
}

// ════════════════════════════════════════════════════════════
// 验证段（阶段 2）
// ════════════════════════════════════════════════════════════

/** 验证角色：明确「你是验收方，不是学习者」 */
export const VALIDATE_ROLE = section(
  'role',
  `你是技能验证 Agent：手里有一份别人写好的技能，你的任务是**严格按它执行一遍目标任务**，
判断这份技能是否真实可用。你不是来优化它的，也不是来重新探索的——
技能没写的路径一律视为缺失，这正是你要发现的问题。`,
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
export function validateMethod(targetMode: LearnTargetMode): string {
  const tooling =
    targetMode === 'text'
      ? `- 你使用纯文本工具组（工具组 siteValidateText）：browser_observe 枚举元素与 element 属性查询、
  browser_interact 操作、browser_page_exec 执行页面脚本、browser_get_page_text 读取页面。
${learnNoVisionGuiGuide(false)}`
      : `- 你使用视觉工具组（工具组 siteValidateVision）：保留 browser_observe（含 element 属性查询）、
  browser_interact、browser_page_exec 文本通道；系统每轮自动截图，按下方 <vision-gui-tool> 使用 vision_gui 手势。
${learnVisionGuiGuide()}`;

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
1. **只依据下面给出的技能正文操作**，禁止自行探索技能之外的路径——
   技能没写的步骤、没提的分支，即使你知道怎么做也要记为缺失。
2. 用 browser_navigate 从技能前置条件/起始页面重新开始，不沿用学习结束页跳过前面步骤。
   每执行一步核对：定位是否命中？顺序是否可执行？成功判据是否真的出现？
3. ${locatorFocus}
4. 完成计划与具体操作讲解是否逐项对应？每步是否包含动作、原因、至少两个线索、成功判据和注意事项？
   XPath 未命中时能否移除后改文本搜索？隐藏入口、容器滚动、分页/懒加载、去重、异常分支是否遗漏？
   目标含全部结果时，缺少遍历终止与覆盖范围说明不能通过。只按技能写明的分支执行，不自行补全。
5. 全流程走通且完成判定成立 → passed=true；
   任一关键步骤无法完成 → passed=false 并逐条列出问题。
6. 每发现一个问题立即 note_tool(action="append") 记下，最后一次性提交。`,
  );
}

/** 验证终止契约 */
export const VALIDATE_TERMINATION = section(
  'termination',
  `验证阶段的唯一结束方式是成功调用 submit_validation。
passed=false 时 issues 必填且不能为空（每条写清「哪一步 + 期望什么 + 实际发生什么」）——
没有问题清单的「不通过」无法支撑后续决策。参数不合法会返回可读错误且**不会**结束验证。
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
    validateMethod(config.targetMode),
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
    `请按既定学习流程推进：先建计划，再逐步试错并实时记录，完整跑通后提交 submit_skill。`
  );
}

/**
 * 验证段的首轮用户消息。
 * 技能正文已整体内嵌在 system 的 <skill> 分区，此处只点明验收对象与判据。
 */
export function validateKickoffMessage(config: LearnConfig, draft: SkillDraft): string {
  return (
    `开始技能验证任务（盲测）。\n` +
    `目标网站：${config.url}\n` +
    `验收目标：${oneLine(config.goal)}\n` +
    `待验证技能：${draft.name}\n\n` +
    `严格按 system 中给出的技能正文执行，不得自行探索技能之外的路径；` +
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
//    工具契约块（LEARN_DOM_GUIDANCE、learnVisionGuiGuide、learnNoVisionGuiGuide）
//    属于学习域内部共享，学习段与验证段都可以引用；
// 5. 与动作智能体隔离：本文件禁止 import ELEMENT_INTERACTION_SOP /
//    VISION_ACTION_SOP；<vision-gui-tool> 分区必须始终存在（视觉目标放手势
//    契约、文本目标放禁用分区），否则 runtime-builder 会向学习提示词追加
//    视觉通用助手的 SOP，破坏隔离。
