/**
 * 工具审批弹窗的文案分档（原因码 → i18n key）。
 *
 * 单一事实源：App.vue 的弹窗与 .preview 预览页共用本模块，预览稿因此
 * 不会与线上漂移（预览页手抄一份文案，改了 locales 就会两边不一致）。
 *
 * 分档规则见 tools/approval-reason.ts（原因码）与 zh-CN.ts（文案）。
 * 本模块只做「选 key + 装参数」，不生成任何句子。
 */
import type { MessageKey } from '@/utils/i18n/core';
import type { ToolApprovalReason } from '@/tools/approval-reason';

export interface ToolApprovalCopy {
  /** 弹窗标题 */
  title: MessageKey;
  /** 正文（引用 {name} / {args}，多数还引用 {detail}） */
  message: MessageKey;
  /**
   * reasonDetail 缺失时的正文。
   * 凡引用 {detail} 的文案**必须**给这一档——interpolate 对缺失参数原样保留
   * 占位符，漏配会把字面「{detail}」直接渲染给用户。
   */
  messageWithoutDetail: MessageKey;
}

export const TOOL_APPROVAL_COPY: Record<ToolApprovalReason, ToolApprovalCopy> = {
  'dependency-install': {
    title: 'sidepanel.chat.toolApprovalTitleInstall',
    message: 'sidepanel.chat.toolApprovalMessageInstall',
    messageWithoutDetail: 'sidepanel.chat.toolApprovalMessageInstallNoDeps',
  },
  action: {
    title: 'sidepanel.chat.toolApprovalTitleAction',
    message: 'sidepanel.chat.toolApprovalMessageAction',
    // action 级审批的 detail 恒有（判定就建立在 action 字段上）；
    // 万一缺失退回通用文案，宁可笼统也不渲染字面 {detail}
    messageWithoutDetail: 'sidepanel.chat.toolApprovalMessage',
  },
  confirm: {
    title: 'sidepanel.chat.toolApprovalTitleConfirm',
    message: 'sidepanel.chat.toolApprovalMessageConfirm',
    messageWithoutDetail: 'sidepanel.chat.toolApprovalMessageConfirmNoDetail',
  },
  'plugin-session': {
    title: 'sidepanel.chat.toolApprovalTitlePlugin',
    message: 'sidepanel.chat.toolApprovalMessagePluginSession',
    messageWithoutDetail: 'sidepanel.chat.toolApprovalMessage',
  },
  'plugin-call': {
    title: 'sidepanel.chat.toolApprovalTitlePlugin',
    message: 'sidepanel.chat.toolApprovalMessagePluginCall',
    messageWithoutDetail: 'sidepanel.chat.toolApprovalMessage',
  },
  tool: {
    title: 'sidepanel.chat.toolApprovalTitle',
    message: 'sidepanel.chat.toolApprovalMessageTool',
    messageWithoutDetail: 'sidepanel.chat.toolApprovalMessageTool',
  },
  unknown: {
    title: 'sidepanel.chat.toolApprovalTitle',
    message: 'sidepanel.chat.toolApprovalMessage',
    messageWithoutDetail: 'sidepanel.chat.toolApprovalMessage',
  },
};

/** 审批请求中与文案有关的字段（ToolApprovalRequest 的文案子集） */
export interface ToolApprovalCopyInput {
  name: string;
  argumentsPreview: string;
  reason?: ToolApprovalReason;
  reasonDetail?: string;
}

export interface ToolApprovalCopySelection {
  titleKey: MessageKey;
  messageKey: MessageKey;
  params: Record<string, string>;
}

/**
 * 按审批请求选出标题 / 正文 key 与插值参数。
 *
 * 未知或缺省原因一律落回通用档：文案变笼统是安全方向，说错原因会让用户
 * 在「装依赖」时以为要删数据，或反过来对真删数据的提示麻木。
 */
export function selectToolApprovalCopy(request: ToolApprovalCopyInput): ToolApprovalCopySelection {
  const detail = (request.reasonDetail ?? '').trim();
  const copy = TOOL_APPROVAL_COPY[request.reason ?? 'unknown'] ?? TOOL_APPROVAL_COPY.unknown;
  return {
    titleKey: copy.title,
    messageKey: detail ? copy.message : copy.messageWithoutDetail,
    params: { name: request.name, args: request.argumentsPreview, detail },
  };
}
