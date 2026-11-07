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
   * vision_gui / screenshot / vision_read_wait 的动作级例外在该判定内
   * 按工具名单独处理，不经过本字段。
   */
  noVisionRecapture?: boolean;
}

// 工具执行上下文：调用方（会话引擎）随执行注入的会话信息。
// 会话感知工具（如 plan_tool）据此做数据隔离；不感知会话的工具可安全忽略
// （可选参数，不破坏既有工具的 execute(args) 契约）。
export interface ToolExecutionContext {
  pluginBindings?: Record<string, { digest: string; epoch: number }>;
  pluginApproved?: boolean;
  /** In-process cancellation; never serialize AbortSignal through runtime messages. */
  signal?: AbortSignal;
  /** Opaque GUI request ID for background cancellation. */
  requestId?: string;
  /** 发起本次工具调用的会话 id（数据隔离键） */
  chatId?: string;
}

// 扩展工具接口
export interface ExtendedTool extends ToolExecutor {
  name: string;
  metadata: ToolMetadata;
  openaiSchema: OpenAITool;
  execute(args: any, context?: ToolExecutionContext): Promise<ToolResult>;
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
