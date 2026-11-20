/**
 * 系统提示词注入钩子（runtime-builder 的条件注入环节）。
 *
 * 设计目标：把「满足条件就把某段规程注入 systemPrompt」从散落的 if 字符串
 * 比较收拢为可扩展的注册表——新增同类注入只需在此登记一个
 * SystemPromptHook，runtime-builder 的装配循环无需改动。
 *
 * 契约：
 *   - 分区自治（防重）：agentSystem（智能体指令 / 动态装配 override）**自带完整
 *     分区**（开闭标签成对出现）时钩子必须返回 null——「自带分区即自治」是
 *     既有协议（<vision-gui-tool> 分区依赖此语义保持工具能力边界
 *     隔离）。只提及标签名不算自治：一次无心的正文提及不应静默关掉注入，
 *     否则智能体会在没有规程的情况下运行（最隐蔽的一类失效）。
 *   - placement 决定插入锚点：before-agent-instructions 保持「视觉规程先于
 *     文本规程」的顺序不变量，append 追加在全部分区之后；
 *   - 单钩子失败绝不击穿运行时构建：select 包在 try/catch 内，失败跳过并
 *     留可分析日志（注入是增强项，缺失时模型退化为工具 schema 自带引导，
 *     比整轮运行失败更可接受）。
 */
import {
  VISION_GUI_PROMPT,
  VISION_GUI_OBSERVE_PROMPT,
} from '@/utils/agents/vision-gui-prompt';
import { VISION_GUI_TOOL_ID } from '@/tools/vision/gui-contract';
import {
  PYTHON_RUN_TOOL_ID,
  PYTHON_SYSTEM_PROMPT_SECTION,
} from '@/tools/python/python-prompt';
import {
  BROWSER_INPUT_TOOL_ID,
  BROWSER_INPUT_SYSTEM_PROMPT_SECTION,
} from '@/tools/browser/input-contract';
import { toolRegistry } from '@/tools/registry';

export interface PromptHookContext {
  /** 装配完成的智能体指令正文（含 override，用于分区自治检测） */
  agentSystem: string;
  /** 会话工具面 ∪ 预选技能工具 ∪ 可用技能携带的工具 */
  toolIds: readonly string[];
  /** 内置视觉观察者（Vision-Assistant）：注入观察变体而非完整操作面 */
  isVisionGuide: boolean;
}

export type PromptPlacement = 'before-agent-instructions' | 'append';

export interface SystemPromptHook {
  /** 唯一标识（日志与扩展注册用） */
  id: string;
  /** 注入锚点：before-agent-instructions 插到 <agent-instructions> 分区之前 */
  placement: PromptPlacement;
  /** 自带分区的 XML 标签名（不含尖括号）；开闭标签成对出现才视为自治分区 */
  sectionTag: string;
  /** 返回分区正文（string）或 null（不注入） */
  select(context: PromptHookContext): string | null;
}

/** 分区自治判定：正文须携带完整的开闭标签对才算自带规程分区。 */
export function hasSelfContainedSection(text: string, tag: string): boolean {
  return text.includes(`<${tag}>`) && text.includes(`</${tag}>`);
}

/**
 * 视觉规程钩子：工具面包含 vision_gui 即注入 vision-gui-prompt 的对应变体。
 * 工具面口径与技能承载一致（session ∪ 预选技能 ∪ 可用技能携带），
 * 技能可能携带 vision_gui 的场景同样被覆盖。
 */
const visionGuiHook: SystemPromptHook = {
  id: 'vision-gui',
  placement: 'before-agent-instructions',
  sectionTag: 'vision-gui-tool',
  select(context) {
    if (!context.toolIds.includes(VISION_GUI_TOOL_ID)) return null;
    if (hasSelfContainedSection(context.agentSystem, this.sectionTag)) return null;
    return context.isVisionGuide ? VISION_GUI_OBSERVE_PROMPT : VISION_GUI_PROMPT;
  },
};

/**
 * Python 脚本规程钩子：工具面包含 python_run 即注入 <python-scripting> 分区。
 *
 * 为什么走钩子而不是无条件 push：规程必须与工具面**严格一致**——没有
 * python_run 的会话注入了规程，模型会照规程去调用一个拿不到的工具；反过来，
 * 只把规程塞进工具描述也不够（描述会被读到但不生效，实测日志已验证）。
 * 钩子自带三道一致性保障：
 *   1. 工具面口径与最终交付一致（同一份 allowsSessionTool 过滤后的清单）；
 *   2. 分区自治防重（智能体指令自带 <python-scripting> 时不再重复注入）；
 *   3. 注册表仍校验工具真实存在（防构建偏斜下「按规程调用不存在的工具」）。
 */
const pythonScriptingHook: SystemPromptHook = {
  id: 'python-scripting',
  placement: 'before-agent-instructions',
  sectionTag: 'python-scripting',
  select(context) {
    if (!context.toolIds.includes(PYTHON_RUN_TOOL_ID)) return null;
    if (!toolRegistry.get(PYTHON_RUN_TOOL_ID)) return null;
    if (hasSelfContainedSection(context.agentSystem, this.sectionTag)) return null;
    return PYTHON_SYSTEM_PROMPT_SECTION;
  },
};

/**
 * 快捷键与剪贴板规程钩子：工具面包含 browser_input 即注入 <browser-input> 分区。
 *
 * 为什么必须走钩子而不是无条件注入：这条规程的核心是「浏览器级权限气泡不在
 * 页面 DOM 里，任何观察工具都看不到它」——只有确实持有剪贴板通道的会话才需要
 * 知道这件事。没有 browser_input 的会话注入它，只会让模型去找一个不存在的工具。
 *
 * 同时它承载一条**事实**（浏览器 UI 层的弹窗不可观察），这条事实对所有会话
 * 都成立，但它只在「有替代通路」时才有行动价值——因此分区整体随工具面注入。
 */
const browserInputHook: SystemPromptHook = {
  id: 'browser-input',
  placement: 'before-agent-instructions',
  sectionTag: 'browser-input',
  select(context) {
    if (!context.toolIds.includes(BROWSER_INPUT_TOOL_ID)) return null;
    if (!toolRegistry.get(BROWSER_INPUT_TOOL_ID)) return null;
    if (hasSelfContainedSection(context.agentSystem, this.sectionTag)) return null;
    return BROWSER_INPUT_SYSTEM_PROMPT_SECTION;
  },
};

/** 钩子注册表：新增条件注入按此模式追加即可（保持分区自治语义）。 */
export const SYSTEM_PROMPT_HOOKS: readonly SystemPromptHook[] = [
  visionGuiHook,
  pythonScriptingHook,
  browserInputHook,
];

export interface PromptInjection {
  hookId: string;
  placement: PromptPlacement;
  section: string;
}

/** 求值全部钩子；单钩子异常隔离，绝不让提示词装配失败。 */
export function collectPromptInjections(context: PromptHookContext): PromptInjection[] {
  const injections: PromptInjection[] = [];
  for (const hook of SYSTEM_PROMPT_HOOKS) {
    try {
      const section = hook.select(context);
      if (typeof section === 'string' && section.trim())
        injections.push({ hookId: hook.id, placement: hook.placement, section });
    } catch (error) {
      console.warn(`[prompt-hooks] 钩子 "${hook.id}" 求值失败，本次跳过注入：`, error);
    }
  }
  return injections;
}
