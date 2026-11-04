/**
 * interact 工具 ↔ UI 层桥接（上下文无关）
 *
 * 职责：把「工具执行层（tools/，无框架依赖）」与「用户界面层（sidepanel Vue）」
 * 解耦。工具执行时经 getInteractHandler 取得已注册的 UI 处理器，把询问请求
 * 交给 UI 弹窗呈现并等待真实用户答复；UI 层（InteractDialog.vue）在挂载时
 * 经 registerInteractHandler 注册处理器、卸载时注销。
 *
 * 防御性约定：
 *   - 处理器未注册（如工具在 background / notes 等无对话 UI 的上下文被执行）
 *     时 getInteractHandler 返回 null，由工具返回可读错误结果，绝不悬挂等待；
 *   - 处理器抛错/拒绝由工具层捕获并转为失败结果，不影响对话主流程；
 *   - 注册返回注销函数，重复注册以后注册者为准（最后写入者生效）。
 */

/** 单个可选项（模型提供的候选答复） */
export interface InteractOption {
  /** 选项文本（提交给模型的答复原文） */
  label: string;
  /** 选项补充说明（帮助用户理解选项含义，不参与答复） */
  description?: string;
}

/** interact 工具请求（参数已由工具层清洗，字段保证类型与长度合法） */
export interface InteractRequest {
  /** 问题正文 */
  question: string;
  /** 背景说明（为什么要问 / 将要执行什么操作） */
  context?: string;
  /** 候选选项（可能为空 = 开放式提问） */
  options: InteractOption[];
  /** 敏感操作标记（账号密码 / 支付 / 隐私等，UI 以警示样式呈现） */
  sensitive: boolean;
}

/** 未获答复的原因 */
export type InteractUnansweredStatus = 'declined' | 'timeout' | 'dismissed';

/** UI 层对一次询问的最终收敛结果 */
export interface InteractResolution {
  /** true = 用户给出了明确答复；false = 未获答复（见 status） */
  answered: boolean;
  /** 答复文本（answered=true 时必有） */
  answer?: string;
  /** 答复来源：option = 点击选项；custom = 自定义输入 */
  source?: 'option' | 'custom';
  /** 未答复原因（answered=false 时必有） */
  status?: InteractUnansweredStatus;
}

/** UI 处理器：接收询问请求，负责呈现并最终 resolve 收敛结果 */
export type InteractHandler = (request: InteractRequest, context?: { chatId?: string }) => Promise<InteractResolution>;

let handler: InteractHandler | null = null;

/**
 * 注册 UI 处理器（InteractDialog.vue 挂载时调用）。
 * 返回注销函数；重复注册以最后注册者为准（覆盖时告警，便于诊断组件
 * 意外双挂载等接线问题——后注册者接管后，先注册者的注销不再生效）。
 */
export function registerInteractHandler(next: InteractHandler): () => void {
  if (handler !== null && handler !== next) {
    console.warn('[interact-ui-bridge] 已存在 UI 处理器，本次注册将覆盖旧处理器（检查 InteractDialog 是否被重复挂载）');
  }
  handler = next;
  return () => {
    // 只有当前注册者仍是本人时才清空，避免先注销旧句柄误删新注册者
    if (handler === next) handler = null;
  };
}

/** 获取当前 UI 处理器（未注册时返回 null，由调用方决定错误呈现） */
export function getInteractHandler(): InteractHandler | null {
  return handler;
}
