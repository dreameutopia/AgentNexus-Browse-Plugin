/**
 * 工具注册表
 * 独立的注册表模块，避免循环依赖
 */

import { ToolExecutor, ToolResult } from '@/common/tool-handler';
import { OpenAITool } from '@/common/openai-types';

// 工具元数据接口
export interface ToolMetadata {
  plugin?: { key: string; version: string; publisher: string; digest: string };
  name: string;
  description: string;
  category: string;
  version: string;
  author?: string;
  tags?: string[];
  /** 展示名（UI 列表优先展示，无则回退 name） */
  displayName?: string;
  /** 运行该工具所需的扩展权限 */
  permissions?: string[];
  /** 该工具适用的站点域名 */
  supportedSites?: string[];
  /**
   * 执行前是否需要用户批准（人审门）。
   * 声明 true 的工具（破坏性/不可逆操作，如删除用户数据）在会话引擎中
   * 执行前必须经 RunOptions.onToolApproval 获得用户放行；无审批通道时
   * 一律拒绝（安全侧默认）。默认 false = 直接执行。
   */
  requiresApproval?: boolean;
  /**
   * 按参数值条件触发的人审门（action 级审批）。
   * 适用于「单工具多操作」的统一工具：当执行参数的 action 字段命中本列表
   * （如 note_tool 的 delete）时才要求用户批准，其余操作直接执行。
   * requiresApproval: true 与本列表取并集（任一命中即审批）。
   */
  requiresApprovalActions?: string[];
  /**
   * 不可逆操作守卫（参数语义级审批，与上面两级并列的第三级人审门）。
   *
   * 适用于「是否破坏性取决于模型意图」的 click / fill 类工具——它们既不能
   * 整工具审批（每次点击都弹窗会淹没用户），也没有 action 字段可条件判定。
   * 声明后命中任一条件即要求用户批准（缺省拒绝，安全侧）：
   *   (a) 模型按工具说明的统一资金/敏感操作策略传 confirm=true；
   *   (b) 意图字段命中明确资金/凭据/隐私等风险，作为模型漏传的兜底。
   *       不以普通提交/发送或 CSS/XPath 名称触发审批。
   * 判定实现见 tools/confirm-guard.ts。
   */
  requiresConfirm?: boolean;
  /** Restrict semantic confirmation to these actions in a unified tool. */
  requiresConfirmActions?: string[];
  /**
   * 终止型工具：**成功执行**后会话引擎结束本轮运行。
   *
   * 用于「任务提交」类工具（submit_skill / submit_validation）：模型调用它
   * 即宣告当前阶段完成，引擎在本轮工具全部执行完、结果已回传模型后正常
   * 收尾（status='done'），不再发起下一次请求。
   *
   * 关键语义：
   *   - 仅 success 触发；失败回传模型自纠（参数不合法时模型可修正后重交），
   *     绝不因一次提交失败就终止整个运行；
   *   - 工具结果照常进入转录与事件流，UI 与历史可完整回溯「提交了什么」。
   */
  terminal?: boolean;
  /**
   * 零成本状态工具：执行只改会话内状态（计划/笔记/批次台账），不触达页面、
   * 不发起网络请求、耗时恒为毫秒级。
   *
   * 准入语义（**只放宽时长上限，不放宽其它任何约束**）：会话运行时长上限
   * 用来截断「长耗时工作」，不是为了阻止模型记录进度。若这类工具也被
   * 截断，模型会在预算耗尽时**无法把已经完成的步骤标注为 done**——
   * 计划状态因此与真实进度脱节，下一轮只能靠模型凭记忆重建（实测代价：
   * 停机后计划项仍显示 in_progress，与实际完成情况不符）。
   *
   * 因此：运行时长上限到达后，未开始的这类调用**仍放行**；它们不产生
   * 外部副作用、不延长运行（毫秒级），放行不会造成预算失控。
   */
  zeroCostStateTool?: boolean;
  /**
   * 视觉循环重拍豁免（单一事实源，默认 false = 保守重拍）。
   *
   * true 的准入条件（缺一不可，声错比漏标更危险——错标会让模型拿着已失效的
   * 截图坐标继续操作）：
   *   1. 工具执行绝不改变目标页面的像素/视口/滚动位置/活动标签页
   *      （纯读取：页面文本、DOM 结构、标签页/窗口枚举、被动网络观察、
   *        纯数据加工等）；
   *   2. 工具不替换 GUI 截图身份（内部自拍的工具如 ocr/extract_data 会
   *      覆盖当前 screenshotId，必须保持 false 让循环重拍恢复有效凭据）。
   *
   * 视觉循环判定（needsVisionRefresh）：整批工具调用全部为 true（或产出
   * 可复用视口图）时不重拍、不合成多模态续拍消息，行为与文本执行循环一致；
   * 任一调用为 false/未声明（含未知与插件工具）即保守重拍。
   * vision_gui（按 action：手势/mark/read_scroll 重拍，inspect/zoom/check/read
   * 豁免）与 screenshot 的名单例外在该判定内按工具名单独处理，不经过本字段。
   */
  noVisionRecapture?: boolean;
}

// 工具执行上下文：调用方（会话引擎）随执行注入的会话信息。
// 会话感知工具（如 plan_tool）据此做数据隔离；不感知会话的工具可安全忽略
// （可选参数，不破坏既有工具的 execute(args) 契约）。
export interface ToolExecutionContext {
  agentId?: string;
  loadedSkillIds?: readonly string[];
  toolPolicy?: 'vision-assistant';
  pluginBindings?: Record<string, { digest: string; epoch: number }>;
  pluginApproved?: boolean;
  /** In-process cancellation; never serialize AbortSignal through runtime messages. */
  signal?: AbortSignal;
  /** Opaque GUI request ID for background cancellation. */
  requestId?: string;
  /** 发起本次工具调用的会话 id（数据隔离键） */
  chatId?: string;
  /** Skill IDs authorized by the conversation runtime, never taken from tool arguments. */
  availableSkillIds?: readonly string[];
  /** Set by the conversation engine after a required approval was granted. */
  toolApproved?: boolean;
  /** Report the actual tab once the tool has resolved its page target. */
  onTabTarget?: (tabId: number) => void;
}

export interface ToolSchemaOptions {
  toolPolicy?: 'vision-assistant';
}

// 扩展工具接口
export interface ExtendedTool extends ToolExecutor {
  name: string;
  metadata: ToolMetadata;
  getSchema?(options: ToolSchemaOptions): OpenAITool;
  /** Tool-specific approval condition when the generic action and confirmation rules do not apply. */
  requiresApprovalFor?(args: unknown): boolean;
  openaiSchema: OpenAITool;
  execute(args: any, context?: ToolExecutionContext): Promise<ToolResult>;
  /**
   * 强制终止正在进行的执行（用户中断 / 单工具超时后由工具执行引擎调用）。
   *
   * 语义：把「底层工作真正杀掉」，而不仅仅是让调用方放弃等待。
   * 无此能力时，引擎只能中止信号并立即结算——工具的底层工作仍可能继续
   * （例如页面里注入的脚本、解释器里的死循环），此时工具**必须**在
   * execute 内部主动监听 context.signal 自助收敛。
   *
   * 实现指引：
   *   - 幂等：可能被重复调用，中止后再次调用必须安全无副作用；
   *   - 有界：自身卡死不得拖住引擎的结算（引擎侧另有等待上界）；
   *   - 不得抛错影响引擎结算（引擎会吞掉钩子异常）。
   */
  kill?(args: any, context?: ToolExecutionContext): Promise<void> | void;
}

// 工具注册表
class ToolRegistry {
  private tools = new Map<string, ExtendedTool>();
  private categories = new Map<string, ExtendedTool[]>();

  /** Replace only externally owned entries; validate the entire batch before mutation. */
  replaceExternal(tools: ExtendedTool[]): void {
    const next = new Map([...this.tools].filter(([, tool]) => !tool.metadata.plugin));
    for (const tool of tools) {
      if (!tool.metadata.plugin || !tool.name.startsWith(`${tool.metadata.plugin.key}/`) || next.has(tool.name)) throw new Error(`PLUGIN_REGISTRATION_CONFLICT: ${tool.name}`);
      next.set(tool.name, tool);
    }
    const categories = new Map<string, ExtendedTool[]>();
    for (const tool of next.values()) { const list = categories.get(tool.metadata.category) ?? []; list.push(tool); categories.set(tool.metadata.category, list); }
    this.tools = next; this.categories = categories;
  }

  /**
   * 注册工具
   *
   * 防御性语义：
   * - 同名不同定义拒绝注册，不能通过覆盖让旧引用悄悄指向其它实现；
   * - 同一实例或同类且契约相同的重复注册为幂等操作；
   * - 工具没有 name 属于编程错误，告警后拒绝注册，绝不让 undefined 键进 Map。
   */
  register(tool: ExtendedTool): void {
    if (tool?.metadata?.plugin || tool?.name?.startsWith('ed25519:')) throw new Error('PLUGIN_REGISTRATION_REQUIRES_OWNER_BATCH');
    if (!tool || !tool.name) {
      console.warn(`[ToolRegistry] ⚠️ Attempted to register tool with undefined name:`, tool?.constructor?.name, tool);
      return;
    }

    const existing = this.tools.get(tool.name);
    if (existing) {
      if (existing === tool) {
        // 幂等：同一实例已注册，无需重复入列
        return;
      }
      if (existing.constructor === tool.constructor && JSON.stringify(existing.openaiSchema) === JSON.stringify(tool.openaiSchema) && JSON.stringify(existing.metadata) === JSON.stringify(tool.metadata)) return;
      throw new Error(`TOOL_REGISTRATION_CONFLICT: ${tool.name}`);
    }

    this.tools.set(tool.name, tool);
    
    // 按类别分组
    const category = tool.metadata?.category || 'unknown';
    if (!this.categories.has(category)) {
      this.categories.set(category, []);
    }
    this.categories.get(category)!.push(tool);
    
    console.log(`[ToolRegistry] Registered tool: ${tool.name} (${category})`);
  }

  /**
   * 获取工具
   */
  get(name: string): ExtendedTool | undefined {
    return this.tools.get(name);
  }

  /**
   * 获取工具（别名方法，用于兼容性）
   */
  getTool(name: string): ExtendedTool | undefined {
    return this.get(name);
  }

  /**
   * 获取所有工具
   */
  getAll(): ExtendedTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 按类别获取工具
   */
  getByCategory(category: string): ExtendedTool[] {
    return this.categories.get(category) || [];
  }

  /**
   * 获取所有类别
   */
  getCategories(): string[] {
    return Array.from(this.categories.keys());
  }

  /**
   * 获取所有工具ID
   */
  getToolIds(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * 获取所有工具（别名方法，用于兼容性）
   */
  getAllTools(): ExtendedTool[] {
    return this.getAll();
  }

  /**
   * 获取OpenAI格式的工具定义
   */
  getOpenAITools(): OpenAITool[] {
    return this.getAll().map(tool => tool.openaiSchema);
  }

  /**
   * 执行工具
   */
  async execute(name: string, args: any): Promise<ToolResult> {
    const tool = this.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    return await tool.execute(args);
  }

  /**
   * 执行工具（别名方法，用于兼容性）
   */
  async executeTool(name: string, args: any): Promise<ToolResult> {
    return await this.execute(name, args);
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalTools: number;
    categories: Record<string, number>;
  } {
    const categories: Record<string, number> = {};
    for (const [category, tools] of this.categories) {
      categories[category] = tools.length;
    }
    
    return {
      totalTools: this.tools.size,
      categories
    };
  }
}

// 全局工具注册表实例
export const toolRegistry = new ToolRegistry();
export { ToolRegistry };
