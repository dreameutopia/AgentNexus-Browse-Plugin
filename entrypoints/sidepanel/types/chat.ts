/**
 * 统一聊天消息类型定义
 * 从 App.vue 和 vision-chat.ts 中提取的公共类型
 */

import type { ChatMessage } from '../utils/ai/ai-chat-api';
import type { PageQuote } from '../utils/chat/page-quote';

/**
 * 工具调用 UI 状态
 */
export interface ToolCallUI {
  id: string;
  name: string;
  status: 'pending' | 'success' | 'error';
  result?: any;
  error?: string;
  expanded?: boolean;
  executionTime?: number;
  /** 原始参数 JSON（会话引擎写入；用于从历史记录重建 AI 协议上下文，UI 可忽略） */
  arguments?: string;
}

/**
 * 上下文压缩片段状态（type='compaction' 片段的载荷）。
 *
 * 渲染语义与工具调用行同一设计语言：pending（旋转图标）/ success（对勾 +
 * 「{from} → {to} token」+ 可展开摘要全文）/ error（叉 + 行内错误摘要 +
 * 可展开详情）。片段随 record.parts 持久化，历史会话重载后同样呈现。
 * 状态由引擎（运行中压缩）与发送前压缩的落库结果共同写入，UI 侧经
 * compaction 事件镜像同一份数据（compaction-part 纯函数是唯一实现）。
 */
export interface CompactionPartState {
  status: 'pending' | 'success' | 'error';
  /** 触发路径：pre-run（发送前）/ runtime（运行中 90% 触发） */
  trigger?: 'pre-run' | 'runtime';
  /** 被压缩原文的 token 估算量（start 时已知；done 时以压缩器实测覆盖） */
  originalTokens?: number;
  /** 摘要的 token 估算量（仅 success） */
  summaryTokens?: number;
  /** 压缩产出的摘要全文（<summary> XML；展开详情用，仅 success） */
  summary?: string;
  /** 失败原因（仅 error） */
  error?: string;
  /** 压缩耗时（毫秒；结算时写入） */
  durationMs?: number;
  /** 用户展开/收起意图（与 ToolCallUI.expanded 同语义） */
  expanded?: boolean;
}

/**
 * 消息片段 - 按顺序存储文字、工具调用、推理与截屏图片
 *
 * 片段流即时间线：vision 自动截图以 type='image' 片段按**截屏发生顺序**
 * 插入流中（首截图位于消息最前、每轮工具后的重截图紧跟其轮次），
 * 渲染层据此把截图内联为可折叠「查看屏幕」容器，而不是统一堆在消息尾部。
 */
export interface MessagePart {
  type: 'text' | 'tool' | 'image' | 'reasoning' | 'notice' | 'compaction';
  content?: string;
  toolCall?: ToolCallUI;
  /** 仅用于 compaction 类型：压缩进度状态（见 CompactionPartState） */
  compaction?: CompactionPartState;
  /** 仅用于 image 类型：图片内容哈希（本体在独立图片库，片段只持引用） */
  imageRef?: string;
  /** 仅用于 reasoning 类型：是否处于收起状态 */
  collapsed?: boolean;
  /**
   * 仅用于 reasoning 类型：用户是否手动切换过展开/收起。
   * 流式期间新内容（正文/工具调用）到达会自动收起推理片段，但用户
   * 显式展开过的片段不应被强制收起——此标记是「用户意图优先于
   * 自动收起约定」的判定依据
   */
  userToggled?: boolean;
}

/**
 * 带原始索引的消息片段（渲染层使用）。
 * 过滤（<think> 剥离、空片段剔除）会使数组下标与 message.parts 脱钩，
 * 折叠/展开等回传事件必须携带原始索引才能正确定位片段。
 */
export interface IndexedMessagePart {
  /** 原始 message.parts 下标（事件回传定位用） */
  index: number;
  part: MessagePart;
}

/**
 * 模型消息反馈（赞/踩）。
 * 与 ChatMessageRecord.feedback 同形：UI 侧乐观上屏，转录引擎字段级落库，
 * 重载会话时经 recordToUiMessage 还原——点赞状态跨会话/跨重启持久。
 */
export type MessageFeedback = 'up' | 'down';

/**
 * 扩展聊天消息类型
 */
export interface ExtendedChatMessage extends ChatMessage {
  id?: string;
  timestamp?: number;
  parts?: MessagePart[];
  toolCalls?: ToolCallUI[];
  isThinking?: boolean;
  isIgnore?: boolean;
  reasoning_content?: string;
  /**
   * 本轮实际执行时长（毫秒；终态由会话引擎 usage.durationMs 写入记录，
   * 此处为 UI 侧映射）。历史记录缺失该字段（旧版本 / 无 usage）时为
   * undefined，渲染层据此隐藏耗时展示；直播中恒为 undefined（时长未定稿）。
   */
  durationMs?: number;
  /** 用户对本条模型消息的反馈（赞/踩；缺省 = 未反馈） */
  feedback?: MessageFeedback;
  /**
   * 关联图片（内容哈希引用；本体在独立图片库 core/images，此处只存引用）。
   * 语义按角色区分：
   *   - user：本轮上传的图片；
   *   - assistant：vision 循环的自动截图（挂接到该条大模型消息）。
   * 渲染层据此展示可折叠图片区（默认收起，可查看 / 放大 / 下载）。
   */
  imageRefs?: string[];
  /**
   * 本条用户消息携带的网页引用（用户在页面选中文本并确认引用）。
   * 用户气泡据此渲染引用块（原文 + 来源页面）；缺省 = 无引用。
   */
  pageQuote?: PageQuote;
  /** 仅用于向后兼容的 reasoning_content 收起状态 */
  _reasoningContentCollapsed?: boolean;
  /**
   * 系统提示（循环守卫停止、输入超限等）：UI 据此以独立的
   * 系统信息条容器渲染（与工具调用行同风格），不混入正文气泡样式
   */
  isSystemNotice?: boolean;
}
