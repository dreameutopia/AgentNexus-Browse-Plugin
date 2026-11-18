/**
 * 工具审批原因分类（结构化事实，**不含任何面向用户的文案**）。
 *
 * 为什么要分档：审批弹窗原先对所有命中都用同一句「该操作具有破坏性或不可逆」。
 * 但命中的实际原因差别很大——「要从公网装 xlrd」和「要删除历史记录」对用户
 * 是两件完全不同的事，用同一句话既误导（装依赖并不破坏数据）又稀释（真正在
 * 删数据时用户已经对这句套话脱敏了）。
 *
 * 分层约定（与渠道配置域一致）：本模块只产出**原因码 + 数据**（依赖包名、
 * action 名、命中的字段、插件 key），文案由 i18n 按原因码分档生成。
 * 领域层写死中文句子会让文案无法随语言切换、也无法在 UI 层统一调整。
 *
 * 判定入口见 entrypoints/sidepanel/utils/tools/openai-tools-converter.ts 的
 * classifyApproval（与 requiresApproval 同一份判定，只多返回原因）。
 */

export type ToolApprovalReason =
  /** metadata.requiresApproval === true：工具自声明含破坏性/不可逆操作 */
  | 'tool'
  /** requiresApprovalActions 命中 args.action（如 note_tool 的 delete） */
  | 'action'
  /** 参数语义级：confirm=true，或意图字段命中资金/凭据/隐私等风险 */
  | 'confirm'
  /** 工具自声明的参数级审批（当前仅 python_run 的公开 PyPI 依赖安装） */
  | 'dependency-install'
  /** 插件工具：本会话首次调用待授权（approvalLevel = session，缺省） */
  | 'plugin-session'
  /** 插件工具：每次调用都需批准（approvalLevel = call） */
  | 'plugin-call'
  /** 未分类（审批判定来自注入方、未提供原因时的兜底） */
  | 'unknown';

export interface ToolApprovalReasonInfo {
  reason: ToolApprovalReason;
  /**
   * 原因细节（纯数据，非文案）：
   *   dependency-install → 依赖包名 / wheel 文件名，逗号分隔
   *   action             → 命中的 action 名
   *   confirm            → 命中的敏感字段名（description/text/target）
   *   plugin-*           → 插件 key
   * 缺省表示「有原因但无可展开的细节」，UI 走无细节的降级文案。
   */
  detail?: string;
}

/** 判定结果：是否需要审批 + 命中的原因（两者出自同一次判定，绝不各判各的） */
export interface ToolApprovalVerdict extends ToolApprovalReasonInfo {
  required: boolean;
}
