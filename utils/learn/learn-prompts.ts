import { ELEMENT_INTERACTION_SOP } from '@/utils/agents/element-interaction-sop';
import { VISION_ACTION_SOP } from '@/utils/agents/vision-action-sop';
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
 *   buildLearnPrompt = ROLE + TASK + WORKFLOW + EXPLORATION(按 strategy)
 *                    + RECORDING(按 targetMode，含跨维度转译规则)
 *                    + SKILL_OUTPUT(按 targetMode) + CONSTRAINTS + TERMINATION
 *   buildValidatePrompt = VALIDATE_ROLE + 内嵌 SKILL 全文 + VALIDATE_TASK(独立，
 *                       不复用 learnTask——验证者不感知学习策略) + VALIDATE_METHOD(按 targetMode)
 *                       + VALIDATE_TERMINATION
 *
 * 块之间用具名常量导出，便于单测断言「改 A 不影响 B」与文档引用。
 * 两段 prompt 的输入面互不重叠：学习段描述「怎么摸索」，验证段描述「怎么验收」。
 *
 * ── 与工具组的强约束 ──
 * 文中出现的工具名必须与 tool-presets 对应场景已注册的工具一致，否则模型会
 * 调到不存在的工具。修改任一场景的工具列表时，请同步核对本文件的
 * EXPLORATION_* 与 VALIDATE_* 块（两边靠注释交叉锚定，见文末维护约定）。
 */

import type { LearnConfig, LearnStrategy, LearnTargetMode, SkillDraft } from './learn-types';

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
  return section(
    'task',
    `目标网站：${config.url}
学习目标：${oneLine(config.goal)}
目标操作模式：${config.targetMode === 'text' ? 'text（产出的技能交给纯文本模型使用）' : 'vision（产出的技能交给视觉模型使用）'}
学习策略：${config.strategy === 'text' ? 'text（用元素枚举与选择器探索）' : 'vision（用相对坐标截图探索，按需打标）'}`,
  );
}

/**
 * 工作流：所有学习组合共用（探索手段的差异全部由 EXPLORATION 块承担）。
 */
export const LEARN_WORKFLOW = section(
  'workflow',
  `1. 先用 plan_tool(action="create") 建立探索计划：把学习目标拆成可独立验证的阶段
   （到达站点 → 完成主流程 → 处理分支 → 整理成文）。每完成一个阶段立即用
   plan_tool(action="edit") 标注状态，不要攒到最后批量补标。
2. 用 browser_navigate（waitForLoad=true）打开目标站点，browser_get_page_text 确认可达；
   需要登录才能继续时立即停下向用户说明（见 constraints）。
3. 按 <exploration> 规定的手段逐步推进。每完成一个**关键步骤**立即用
   note_tool(action="append") 追加一条记录（格式见 <recording>），不要凭记忆攒到结束再写——
   中途失败或被终止时，已写下的记录就是唯一产出。
4. 遇到分支（弹窗、多选、二次确认、登录、验证码）时，把**已探明的路径**全部记下；
   无法自行处理的（验证码、扫码登录）记录为「需人工」，不要反复尝试绕过。
5. 主流程完整跑通后，按 <skill-output> 把全部记录整理成技能正文。
6. 最后调用 submit_skill 提交——这是学习阶段唯一的结束方式（见 termination）。`,
);

/**
 * 探索手段（按 strategy 分离）。
 * - text   ：工具组 siteLearnText —— 枚举器 + 选择器点击/填充 + 页面脚本
 * - vision ：工具组 siteLearnVision —— 原始截图 + 相对坐标操作 + 按需打标反查
 */
export function learnExploration(strategy: LearnStrategy): string {
  if (strategy === 'text') {
    return section(
      'exploration',
      `${ELEMENT_INTERACTION_SOP}
本阶段用元素枚举与节点引用定位（工具组 siteLearnText）：
- 读页面：browser_get_page_text（当前页正文）、browser_get_page_info（诊断加载状态）。
- 找元素：browser_observe(view="inputs"/"buttons")（分页参数从 1 开始，
  每页 40 个；可传 regex 或 xpath 过滤直接定位目标，命中会置顶标记，
  同一目标最多连续过滤 3 次，之后翻页枚举）。
- 操作：browser_interact(action="fill"/"click")，使用同一行的 elementId 与 frameId；键盘与焦点操作遵循统一交互 SOP。
- 复杂 / 自定义组件定位困难时：browser_page_exec 写探测脚本读取页面结构或 JS 状态。
- 系统不会自动截图，你只能依据元素的 ElementId、Context 与文字描述判断位置——
  因此每一步都要把定位信息记全（见 <recording>）。`,
    );
  }
  return section(
    'exploration',
    `本阶段用相对坐标 GUI 定位（工具组 siteLearnVision）：
- 自动截图包含 screenshotId；坐标为整张可见截图的 x/y 0..1000，不是像素。
- vision_click(point,button,count)、vision_input(point,text)、vision_drag(from,to)、vision_scroll(direction,percent,point?)、vision_hover、vision_keyboard 均携带最新 screenshotId。
- 一次只执行一个交互手势，等待新截图再继续。只读检查/放大不消耗原截图。禁止使用数字 ID 点击。
- 需要选择器时先 vision_mark，下一张截图会有数字框，再 vision_inspect(screenshotId,id) 读取 CSS/XPath/属性/frameId。
- 坐标不固化为长期技能：记录元素语义、相对区域和重新定位策略；跨 frame/shadow 保留作用域。
${VISION_ACTION_SOP}`,
  );
}

/**
 * 记录格式（按 targetMode 分离）。
 *
 * 关键跨维度规则：**记录形态由 targetMode 决定，而不是由 strategy 决定**。
 * - target=text  且 strategy=vision：必须用 vision_inspect 反查后再记录
 *   （否则产出的技能只有「看图第 3 个标签」这种文本模型用不了的信息）；
 * - target=vision 且 strategy=text ：视觉信息无法凭空产生，只记录已能拿到的
 *   选择器与文字，并在技能中说明可用截图自行定位，不臆造位置描述。
 */
export function learnRecording(targetMode: LearnTargetMode, strategy: LearnStrategy): string {
  const translationNote =
    targetMode === 'text' && strategy === 'vision'
      ? `\n⚠️ 你是用视觉探索的，但产出要给纯文本模型用：每定位到一个关键元素，必须调用
   vision_mark 后调用 vision_inspect(screenshotId,id) 反查出 CSS 选择器与 xpath 后再记录，屏幕位置只能作为补充信息。`
      : targetMode === 'vision' && strategy === 'text'
        ? `\n⚠️ 你是用枚举探索的，产出要给视觉模型用：如实记录已拿到的选择器与元素文字即可，
   **不要臆造**「在页面中部偏右」这类你并未观察到的位置描述；视觉模型会自行看图定位。`
        : '';

  const format =
    targetMode === 'text'
      ? `- [场景] 在什么页面 / 什么状态下（URL 或页面标题）
- [判断] 下一步该做什么、为什么选它
- [操作] 工具名 + 关键参数
- [定位] 可重新执行的 regex / XPath + 元素文字、所属区域与 frame 识别方式。每次执行现场调用 getter 获取 elementId/frameId；禁止把 ElementId、snapshotId 或固定 frameId 存入技能。
- [结果] 成功 / 失败现象（失败要写清报错与已尝试的替代方案）`
      : `- [场景] 在什么页面 / 什么状态下（URL 或页面标题）
- [判断] 下一步该做什么、为什么选它
- [操作] 工具名 + 关键参数（vision_* 传最新 screenshotId 和相对坐标）
- [定位] 目标相对区域 + 重新定位策略（上/中/下、左/中/右）+ 元素可见文字 + 兜底选择器
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
      ? `- **定位信息以可重采的形态书写**：regex / XPath + 元素可见文字与上下文；CSS 仅作结构参考，不可直接传 enhance_*
  （placeholder、label、按钮文案）。优先写稳定锚点（#id、[data-*]、name 属性），
  避免把易变的 :nth-of-type 序号当唯一依据——序号一变技能就失效。
  不要写「看图第 N 个标签」「页面中部」这类只有视觉模型才用得上的描述。`
      : `- **定位信息以视觉模型可用的形态书写**：元素在界面中的位置区域（上/中/下、
  左/中/右）+ 可见文字 + 截图标签 id 的使用方式；同时附上选择器作为兜底，
  便于视觉失败时降级。位置描述要以「打开页面后肉眼可见的布局」为参照。`;

  return section(
    'skill-output',
    `把全部记录整理成技能正文（Markdown，**不含 frontmatter**，≤15000 字符）：

标准结构：
## 目标          一句话说明这个技能完成什么
## 前置条件      登录态、所需权限、依赖页面等
## 工作流        编号步骤；每步写明「做什么 + 用什么工具 + 怎么定位元素 + 成功判据」
## 分支与坑点    弹窗、多选、异常态、容易点错的地方，以及踩过的坑
## 完成判定      怎么算成功（看到什么文案 / 进入什么页面）
## 边界          不适用的情况、需要人工介入的环节

${locatorRule}

同时按字段要求填写提交参数：
- name：全小写 kebab-case 英文，由站点域名 + 核心动作提炼（如 boss-zhipin-apply）；
- description：一句话「做什么 + 何时使用」，它决定别的模型能否在技能清单里认出本技能；
- category：与管理中心分类一致（如 automation / search / general）；
- allowedTools：**只写本技能执行时真正会调用的工具 ID**，且必须非空——
  它决定该技能在哪些智能体的「/」引用清单里可见，漏写会导致建完也引用不到；
- mode：原样传本次学习的目标操作模式（text / vision），标签会自动补上。`,
  );
}

/** 共享约束（所有学习组合一致） */
export const LEARN_CONSTRAINTS = section(
  'constraints',
  `- 真实操作页面，但**不可逆动作必须停下来等用户确认**：发送 / 提交 / 发布 / 投递 /
  购买 / 下单 / 支付 / 删除等，调用 browser_interact、vision_click、vision_input、vision_drag、vision_keyboard、
  browser_page_exec 时传 confirm=true（系统会弹出审批，用户拒绝后不得绕过或换名重试）。
- 遇到登录墙、验证码、扫码、付费墙：立即停止并说明需要用户完成什么，绝不绕过、绝不反复尝试。
- 同一方案最多重试 3 次；失败就换路径并把失败现象记进 note，不要原地打转烧轮次。
- 只在**完整跑通全流程**后才调用 submit_skill；没跑通就提交，会让一个残缺技能流进技能库。
- 不做计划外的操作：不点广告、不改用户账号设置、不删除用户已有数据。`,
);

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
export function buildLearnPrompt(config: LearnConfig): string {
  return [
    LEARN_ROLE,
    learnTask(config),
    LEARN_WORKFLOW,
    learnExploration(config.strategy),
    learnRecording(config.targetMode, config.strategy),
    learnSkillOutput(config.targetMode),
    LEARN_CONSTRAINTS,
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

/** 验证方法（按 targetMode 分离：与产出该技能的执行智能体同构） */
export function validateMethod(targetMode: LearnTargetMode): string {
  const tooling =
    targetMode === 'text'
      ? `${ELEMENT_INTERACTION_SOP}
- 你使用纯文本工具组（工具组 siteValidateText）：browser_observe 枚举元素、browser_interact 操作、
  browser_page_exec 执行页面脚本、browser_get_page_text 读取页面。`
      : `- 你使用视觉工具组（工具组 siteValidateVision）：系统每轮自动截图，vision_mark 按需请求数字标签，
  用 vision_* 相对坐标工具操作，vision_mark + vision_inspect 反查选择器，
  browser_get_page_text 读取页面文本作为补充。
${VISION_ACTION_SOP}`;

  const locatorFocus =
    targetMode === 'text'
      ? `- 重点核对**定位信息**：技能给的 regex / XPath 是否能通过 getter 重采到目标？是否误存了运行期 ElementId 或 snapshotId？
  文字描述是否与页面实际文案一致（按钮写「立即投递」而技能写「立即沟通」= 定位失效）？`
      : `- 重点核对**位置与标签描述**：技能给的位置区域 / 可见文字能否让你快速锁定元素？
  描述与实际界面对不上的（说在右上角实际在底部）= 定位失效。`;

  return section(
    'method',
    `${tooling}

执行纪律：
1. **只依据下面给出的技能正文操作**，禁止自行探索技能之外的路径——
   技能没写的步骤、没提的分支，即使你知道怎么做也要记为缺失。
2. 每执行一步就核对：定位是否命中？顺序是否可执行？成功判据是否真的出现？
3. ${locatorFocus}
4. 分支覆盖：技能是否处理了弹窗、多选、二次确认、异常态？遗漏的记为问题。
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
// 3. 各块均无状态、可独立单测：断言「strategy 变化只影响 exploration」
//    「targetMode 变化只影响 recording / skill-output / method」；
// 4. 两段 prompt 严格分离：验证段禁止复用 learnTask / LEARN_* 任何块
//    （盲测语义——验证者不得感知学习过程），学习段同理禁止引入 VALIDATE_*。
