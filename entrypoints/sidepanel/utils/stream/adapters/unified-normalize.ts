import { trimDanglingSurrogate } from '../../ai/token-estimate';

/**
 * 统一消息回放防御性归一化（协议适配器共用）
 *
 * 历史回放的输入是持久化数据（IndexedDB 记录 → 统一消息），不能假设其完美：
 *   - 工具参数串可能不是合法 JSON（执行层允许「首行 JSON」兜底解析后原始串落库）；
 *   - 工具调用 id 可能不满足目标协议的字符集约束（如 Anthropic 要求 ^[a-zA-Z0-9_-]+$），
 *     某些 OpenAI 兼容网关会返回含其它字符的 id；
 *   - 工具结果 content 可能是非对象 JSON 或纯文本。
 *
 * 本模块的转换永不抛错：任何输入都映射为「协议合法 + 语义可读」的形态，
 * 保证跨协议切换后重放历史请求不会因单条脏数据整轮失败。
 * id 重写必须同步应用到配对双方（tool_use.id / tool_result.tool_use_id），
 * 由调用方在单次请求的转换作用域内持有映射表完成。
 */

/** 工具参数回放预览上限（与 ContextWindowGuard.TOOL_CONTENT_LIMIT 同量级） */
const REPLAY_ARGUMENTS_LIMIT = 8 * 1024;

/** 协议安全 id 的字符集与长度约束（取各协议约束的交集：Anthropic 最严） */
export const SAFE_TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** 工具调用 id 的协议安全长度上限 */
const SAFE_TOOL_ID_MAX_LENGTH = 128;

/**
 * 把工具参数字符串归一化为协议所需的 JSON 对象（用于回放 assistant.tool_calls）。
 * 防御阶梯：
 *   1. 合法 JSON 对象 → 原样返回；
 *   2. 合法 JSON 但非对象（数组/数字/字符串等）→ 包一层 { _value }；
 *   3. 解析失败 → { _malformedArguments: 截断原文 }（保留诊断信息，绝不抛错）。
 */
export function parseReplayArguments(raw: string | null | undefined): Record<string, unknown> {
  const text = (raw ?? '').trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { _value: parsed };
  } catch {
    const preview =
      text.length > REPLAY_ARGUMENTS_LIMIT ? `${trimDanglingSurrogate(text, REPLAY_ARGUMENTS_LIMIT)}…` : text;
    return { _malformedArguments: preview };
  }
}

/**
 * 工具参数的 strict 化（回放/入史共用阶梯）：
 *   - 完整合法 JSON **对象** → 原串返回（字节不变，保住前缀缓存与历史前缀守卫的逐字比对）；
 *   - 完整解析失败但首行是合法 JSON 对象（模型在 JSON 后追加多余文本的已知形态）
 *     → 用首行解析结果重新序列化，值与执行侧 parseToolArguments 的宽容解析完全一致；
 *   - 其余（无法解析 / 非对象 JSON / 空串）→ null，交调用方决定兜底形态。
 *
 * 为什么需要它：执行侧为让工具照常运行采用「首行 JSON」宽容解析，但历史里
 * 保存的是**原始脏串**；OpenAI 系协议以字符串原样回放 function.arguments，
 * 对该字段做 strict JSON 校验的网关（实测 Xiaomi MiMo 等）会把整个请求按
 * 400 "Invalid request parameters" 拒收——工具明明执行成功，下一轮请求才炸。
 */
export function strictToolArguments(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return text;
    return null;
  } catch {
    const firstLine = text.split('\n')[0].trim();
    try {
      const parsed: unknown = JSON.parse(firstLine);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return JSON.stringify(parsed);
    } catch { /* 两级均失败：返回 null 交调用方兜底 */ }
    return null;
  }
}

/**
 * 工具参数的线上形态（OpenAI 系 string-form 协议发送侧最后一道归一）：
 * 恒返回**可被 strict JSON 解析器接受的字符串**，绝不抛错。阶梯：
 *   1. strictToolArguments 可救 → 其结果（合法对象 JSON，合法原文保持字节不变）；
 *   2. 空串/缺省 → '{}'（部分严格网关对空串按非法 JSON 拒收）；
 *   3. 合法 JSON 但非对象（数字/数组等）→ 原样返回（网关可解析，语义由服务端裁量）；
 *   4. 无可救药 → { _malformedArguments: 截断原文 }（与 parseReplayArguments 兜底同口径，
 *      保 tool_call 配对完整、原文可读、整轮请求可继续发送）。
 */
export function normalizeWireToolArguments(raw: string | null | undefined): string {
  const strict = strictToolArguments(raw);
  if (strict !== null) return strict;
  const text = (raw ?? '').trim();
  if (!text) return '{}';
  // 合法 JSON 但非对象：保持可解析原样上网（改写反而破坏字节稳定性）
  try { JSON.parse(text); return text; } catch { /* 落到首行/兜底 */ }
  const firstLine = text.split('\n')[0].trim();
  try { JSON.parse(firstLine); return firstLine; } catch { /* 落到兜底 */ }
  return JSON.stringify({ _malformedArguments: trimDanglingSurrogate(text, REPLAY_ARGUMENTS_LIMIT) });
}

/**
 * 把工具结果 content 归一化为 JSON 对象（用于 Gemini functionResponse.response 等要求对象形态的协议）。
 * 防御阶梯：合法 JSON 对象原样；合法 JSON 非对象包 { result }；解析失败包 { result: 原文 }。
 */
export function parseReplayToolResponse(content: unknown): Record<string, unknown> {
  if (typeof content !== 'string') {
    if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
      return content as Record<string, unknown>;
    }
    return { result: content };
  }
  const text = content.trim();
  if (!text) return { result: '' };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { result: parsed };
  } catch {
    return { result: text };
  }
}

/**
 * 生成满足协议字符集约束的工具调用 id（用于回放时重写不合法 id）。
 * seed 提供确定性兜底（如消息下标），保证同一次转换内可复现。
 */
export function sanitizeReplayToolId(raw: string | null | undefined, seed: string): string {
  const cleaned = (raw ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const base =
    cleaned && SAFE_TOOL_ID_PATTERN.test(cleaned) ? cleaned : `call_replay_${seed}`;
  return base.length > SAFE_TOOL_ID_MAX_LENGTH ? base.slice(0, SAFE_TOOL_ID_MAX_LENGTH) : base;
}
