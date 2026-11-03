/**
 * ECharts option 净化器（模型输出 → 沙箱渲染前的纵深防御层）
 *
 * 信任边界说明：即使图表最终在无扩展权限的沙箱 iframe 内渲染（chart-renderer.ts），
 * 本净化器仍是必需的第一道防线——沙箱隔离的是「爆炸半径」，本层负责把
 * 「进沙箱的东西」收敛到最小可用面：
 *
 *   1. JSON-only：JSON.parse 从根上杜绝函数 / 表达式 / 变量（模型内容不构成代码）；
 *   2. 原型污染防御：剥离 __proto__ / constructor / prototype 键——JSON.parse
 *      产生的同名自有键本身无害，但 ECharts 内部 merge 走赋值语义时可能触发
 *      setter 污染原型链；
 *   3. HTML 注入面收敛（belt-and-suspenders，沙箱之外再兜一层）：
 *      ECharts 官方安全指南明确 tooltip.formatter 接受原始 HTML 且拒绝内部消毒，
 *      2026 年仍有 lines 系列 tooltip XSS CVE（CVE-2026-45249）——
 *      formatter / extraCssText 字符串一律 HTML 转义，title.link / title.target 直接剥离；
 *   4. 资源上限：JSON 体积 / 节点总数 / 嵌套深度 / series 数量 / 数据点数量 /
 *      字符串长度全部封顶，杜绝模型输出的巨型 option 造成渲染层资源耗尽。
 *
 * 超限策略：结构性硬伤（非对象 / 深度 / 节点数 / 解析失败）→ 整体拒绝，
 * 由渲染器降级为源码展示；数据规模类软超限（series / data 多出）→ 截断保留
 * 前缀，图表仍可渲染（信息主体不丢）。
 */

import { escapeHtml } from './html-escape';

/** 净化结果：成功携带净化后 JSON 字符串，失败携带可读错误（面向源码降级展示） */
export type EchartsSanitizeResult =
  | { ok: true; json: string }
  | { ok: false; error: string };

// ==================== 资源上限（防御性编程常量） ====================

/** 源码（原始围栏内容）最大字符数 */
const MAX_JSON_CHARS = 100_000;
/** 对象嵌套最大深度 */
const MAX_DEPTH = 16;
/** 整棵 option 树的最大节点数（对象 + 数组 + 叶子总数） */
const MAX_NODES = 20_000;
/** series 数组最大保留项数（超出截断；提示词约束为 4，此处宽限） */
const MAX_SERIES = 8;
/** 单个系列 data 数组最大保留项数 */
const MAX_DATA_POINTS_PER_SERIES = 500;
/** dataset.source 最大保留行数 */
const MAX_DATASET_ROWS = 1_000;
/** 单个字符串值最大长度（超出截断） */
const MAX_STRING_LENGTH = 2_000;

/** 原型污染键：出现即剥离（不区分大小写语境下的标准三件套） */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** 内容可能被 ECharts 以 HTML 注入 DOM 的字符串字段：一律 HTML 转义 */
const HTML_TEXT_KEYS: ReadonlySet<string> = new Set(['formatter', 'extraCssText']);

/** 需要剥离跳转能力的键（仅在这些键所在的已知容器内处理） */
const TITLE_LINK_KEYS: ReadonlySet<string> = new Set(['link', 'target', 'source', 'href']);

/** 控制流用内部异常（不外泄给调用方 API，只取 message） */
class SanitizeError extends Error {}

// ==================== 实现 ====================

/** 值是否为 JSON.parse 产物中的普通对象（排除数组与 null） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 数组类键的保留长度；非受控数组返回 undefined（不截断） */
function arrayCapFor(key: string): number | undefined {
  if (key === 'series') return MAX_SERIES;
  if (key === 'data') return MAX_DATA_POINTS_PER_SERIES;
  if (key === 'source') return MAX_DATASET_ROWS;
  return undefined;
}

/** 截断字符串（超出上限的极端长文本按前缀保留） */
function clampString(value: string): string {
  return value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value;
}

/**
 * 递归净化。contextKey 为「当前值所处的键名」，用于数组截断与字符串消毒决策。
 * 返回重建的干净树（绝不原地修改——JSON.parse 产物虽属本进程，但重建可保证
 * 剥离键后不存在残留引用）。
 */
function walk(value: unknown, depth: number, contextKey: string): unknown {
  if (depth > MAX_DEPTH) {
    throw new SanitizeError(`嵌套深度超过 ${MAX_DEPTH} 层`);
  }
  if (--walkBudget <= 0) {
    throw new SanitizeError(`节点总数超过 ${MAX_NODES}`);
  }

  if (typeof value === 'string') {
    // HTML 能力字段：转义 < > &（& 转义对 ECharts 模板字符串无副作用）
    if (HTML_TEXT_KEYS.has(contextKey)) {
      return clampString(escapeHtml(value));
    }
    return clampString(value);
  }
  if (value === null || typeof value !== 'object') {
    // number / boolean / null 原样放行（ECharts 数据主体）
    return value;
  }

  if (Array.isArray(value)) {
    const cap = arrayCapFor(contextKey);
    const items = cap === undefined ? value : value.slice(0, cap);
    return items.map(item => walk(item, depth + 1, ''));
  }

  // 普通对象：白名单式重建（FORBIDDEN_KEYS 被丢弃）
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    // title.link / title.target：ECharts 唯一的 option 内跳转配置，直接剥离。
    // 注意不能用「全局删 link 键」策略：graph / sankey 的 links 数组以
    // source / target 为节点名键，全局删除会破坏合法图表
    if (contextKey === 'title' && TITLE_LINK_KEYS.has(key)) continue;
    out[key] = walk(child, depth + 1, key);
  }
  return out;
}

/** 每次净化调用的独立节点预算（模块级变量 + 重置，避免把预算塞进递归签名） */
let walkBudget = 0;

/**
 * 净化一段「应为 ECharts option JSON」的围栏源码。
 * 任何结构性失败返回 ok:false + 可读原因（渲染器据此降级为源码展示）。
 */
export function sanitizeEchartsOptionJson(raw: string): EchartsSanitizeResult {
  const text = (raw ?? '').trim();
  if (!text) {
    return { ok: false, error: '图表源码为空' };
  }
  if (text.length > MAX_JSON_CHARS) {
    return { ok: false, error: `源码超过 ${MAX_JSON_CHARS} 字符上限` };
  }

  let option: unknown;
  try {
    option = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `JSON 解析失败：${message}` };
  }
  if (!isPlainObject(option)) {
    return { ok: false, error: '图表 option 必须是单个 JSON 对象' };
  }

  walkBudget = MAX_NODES;
  try {
    const clean = walk(option, 0, '');
    return { ok: true, json: JSON.stringify(clean) };
  } catch (error) {
    const message = error instanceof SanitizeError ? error.message : String(error);
    return { ok: false, error: message };
  }
}
