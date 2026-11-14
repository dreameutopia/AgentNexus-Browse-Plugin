/**
 * action 驱动工具的参数矩阵与字段校验（browser_navigation / browser_tabs 共享）
 *
 * 合并后的两个统一工具都是「一个工具 + 多个 action」形态，参数校验必须回答
 * 两个问题：① 这个 key 是不是本工具的合法参数；② 它对**当前 action** 是否
 * 适用。两份手写实现必然漂移（错误文案、判定顺序、边界口径），故收敛到本模块：
 *
 *   - checkActionMatrix：整体形态 → action 必填枚举 → 未知参数拒绝 →
 *     张冠李戴参数拒绝，返回**纯错误字符串**由调用方用自己的
 *     createErrorResponse 包装（保留 [toolName] 前缀）；
 *   - read*Field：逐字段类型/取值校验，返回 Field 联合（ok 或 error 字符串），
 *     所有工具共用同一套边界口径（非空串、布尔、有限数、整数数组）。
 *
 * 设计约束：
 *   - 校验只做拒绝与归一，不产生副作用；失败即返回可读错误，绝不静默忽略
 *     （静默失效会让模型以为动作已生效）；
 *   - 所有错误文案必须自带「期望什么、收到什么、怎么改」，可直接回传给模型自纠。
 */

/** 字段校验结果：值可选（字段缺省时不出现），错误时只带可读文案 */
export type Field<T> =
  | { ok: true; value?: T }
  | { ok: false; error: string };

/** action × 参数 矩阵定义（每个 action 允许出现的 key，action 本身恒允许） */
export interface ActionMatrix<T extends string> {
  /** 合法 action 枚举（与 schema enum 同源） */
  actions: readonly T[];
  /** 每个 action 允许出现的参数 key */
  params: Record<T, readonly string[]>;
  /** 未知参数错误的补充提示（如已删除参数的迁移说明） */
  unknownHint?: string;
}

export type MatrixCheck<T extends string> =
  | { ok: false; error: string }
  | {
      ok: true;
      /** 归一化后的 action（已过枚举） */
      action: T;
      /** 原始入参（形状已确认为非空普通对象，且所有 key 均对当前 action 合法） */
      input: Record<string, unknown>;
    };

/**
 * 三段式矩阵校验。判定顺序固定：整体形态 → action 枚举 → 逐 key 的
 * 「未知 / 不适用于本 action」，与实现方的诊断习惯一致，且保证同一个错误
 * 输入永远得到同一条文案（可测试、可分析）。
 */
export function checkActionMatrix<T extends string>(
  rawArgs: unknown,
  matrix: ActionMatrix<T>,
): MatrixCheck<T> {
  // 整体形态防御：非对象（含数组/字符串/数字）按调用方误用拒绝，错误带实际类型
  if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return {
      ok: false,
      error: `参数必须是对象 { action, ... }，实际收到 ${Array.isArray(rawArgs) ? 'array' : typeof rawArgs}`,
    };
  }
  const input = rawArgs as Record<string, unknown>;

  const action = input.action;
  if (typeof action !== 'string' || !(matrix.actions as readonly string[]).includes(action)) {
    return {
      ok: false,
      error: `action 必须是 ${matrix.actions.map(a => `"${a}"`).join('/')} 之一，实际收到 ${JSON.stringify(action ?? null)}`,
    };
  }
  const validAction = action as T;
  const allowedKeys = new Set<string>(['action', ...matrix.params[validAction]]);
  // 全量合法 key：逐 action 累积（在泛型 Record 上用 Object.values 会退化出
  // unknown，显式遍历保持 string 类型精确）
  const allKeys = new Set<string>(['action']);
  for (const knownAction of matrix.actions) {
    for (const key of matrix.params[knownAction]) allKeys.add(key);
  }

  // 未知参数 / 张冠李戴参数：分开报错，文案直接告诉调用方该 action 接受什么
  for (const key of Object.keys(input)) {
    if (!allKeys.has(key)) {
      return {
        ok: false,
        error: `未知参数 "${key}"（本工具只接受 action 与各 action 的专属参数${matrix.unknownHint ? `；${matrix.unknownHint}` : ''}）`,
      };
    }
    if (!allowedKeys.has(key)) {
      return {
        ok: false,
        error: `参数 "${key}" 不适用于 action="${validAction}"（该 action 支持：${matrix.params[validAction].join('/') || '无参数'}；完整参数矩阵见工具说明）`,
      };
    }
  }

  return { ok: true, action: validAction, input };
}

/** 布尔字段（缺省放行，出现即必须是布尔） */
export function readBooleanField(input: Record<string, unknown>, key: string): Field<boolean> {
  const value = input[key];
  if (value === undefined) return { ok: true };
  if (typeof value !== 'boolean') return { ok: false, error: `${key} 必须是布尔值` };
  return { ok: true, value };
}

/** 非空字符串字段（归一为首尾去空白后的值） */
export function readNonEmptyStringField(input: Record<string, unknown>, key: string): Field<string> {
  const value = input[key];
  if (value === undefined) return { ok: true };
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: `${key} 必须是非空字符串` };
  }
  return { ok: true, value: value.trim() };
}

export interface NumberFieldRules {
  /** 下界（默认 -Infinity） */
  min?: number;
  /** 上界（默认 +Infinity） */
  max?: number;
  /** 是否要求整数 */
  integer?: boolean;
  /** 错误文案补充（如单位与替代方案指引） */
  hint?: string;
}

/**
 * 数字字段。默认要求有限数（NaN / Infinity 一律拒绝——typeof NaN === 'number'
 * 但序列化后会变成 null，必须在此挡下）。
 */
export function readNumberField(
  input: Record<string, unknown>,
  key: string,
  rules: NumberFieldRules = {},
): Field<number> {
  const value = input[key];
  if (value === undefined) return { ok: true };
  const { min = -Infinity, max = Infinity, integer = false, hint } = rules;
  const numeric = typeof value === 'number' && Number.isFinite(value);
  const inRange = numeric && value >= min && value <= max;
  const isInt = !integer || (numeric && Number.isInteger(value));
  if (!numeric || !inRange || !isInt) {
    const expected = [
      integer ? '整数' : '有限数字',
      min !== -Infinity && max !== Infinity ? `${min}~${max}` : min !== -Infinity ? `≥${min}` : max !== Infinity ? `≤${max}` : '',
      hint ? `（${hint}）` : '',
    ].filter(Boolean).join(' ');
    return { ok: false, error: `${key} 必须是 ${expected}，实际收到 ${JSON.stringify(value)}` };
  }
  return { ok: true, value };
}

/**
 * 字符串数组字段（去重保序：重复项只保留首个）。
 * 供「批量 id 列表」「扩展名列表」这类参数使用。
 */
export function readStringArrayField(
  input: Record<string, unknown>,
  key: string,
  rules: { min?: number; emptyError?: string } = {},
): Field<string[]> {
  const value = input[key];
  if (value === undefined) return { ok: true };
  const { min = 1, emptyError } = rules;
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: emptyError ?? `${key} 必须是非空数组` };
  }
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      return { ok: false, error: `${key} 的元素必须全部是非空字符串，收到 ${JSON.stringify(item)}` };
    }
  }
  return { ok: true, value: [...new Set(value as string[])] };
}

/**
 * 整数数组字段（去重保序：重复 id 只保留首个——批量关闭重复 id 会让
 * 底层 API 对同一目标二次操作）。
 */
export function readIntArrayField(
  input: Record<string, unknown>,
  key: string,
  rules: { min?: number; emptyError?: string } = {},
): Field<number[]> {
  const value = input[key];
  if (value === undefined) return { ok: true };
  const { min = 0, emptyError } = rules;
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: emptyError ?? `${key} 必须是非空数组` };
  }
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item) || !Number.isInteger(item) || item < min) {
      return { ok: false, error: `${key} 的元素必须全部是 ≥${min} 的整数，收到 ${JSON.stringify(item)}` };
    }
  }
  return { ok: true, value: [...new Set(value as number[])] };
}
