/**
 * 图表派生：统一信封（列式数据）→ ECharts option
 *
 * 模型不写 option，只写表；本模块替模型做全部图表决策：
 *   - 图型推断：显式 kind 优先（合法时），否则按数据形态推断
 *     （首列时间序 → 折线；占比语义 → 饼图；默认柱状）；
 *   - 结构派生：类目轴与每个系列的数据点同源于同一张表，
 *     「xAxis 与 series 长度错配」这类静默画错图的问题在结构上不可能发生；
 *   - 外观约束：不设置 color / backgroundColor / animation（界面主题负责），
 *     与 legacy ```echarts 直连路径的提示词约束一致。
 *
 * 派生产物仍要过 echarts-option-sanitizer（chart-renderer 调用侧负责）：
 * 本层保证形状正确，净化层保底资源上限——防御纵深不变。
 */

import type { NormalizedEnvelope, RichCell } from './envelope';
import { coerceNumber } from './envelope';

// ==================== 图型 ====================

export type ChartKind = 'bar' | 'line' | 'area' | 'pie' | 'scatter' | 'radar' | 'funnel' | 'gauge' | 'heatmap';

const CHART_KINDS: ReadonlySet<string> = new Set<ChartKind>([
  'bar', 'line', 'area', 'pie', 'scatter', 'radar', 'funnel', 'gauge', 'heatmap',
]);

/** 笛卡尔系图型（共用类目轴 / 数值轴派生路径） */
const CARTESIAN_KINDS: ReadonlySet<string> = new Set(['bar', 'line', 'area']);

// ==================== 时间序与占比推断 ====================

/**
 * 首列是否像时间轴：日期 / 年月日 / 时分 / 周期序数（周几、季度、月份）。
 * 中文与常见英文形态各覆盖一组；阈值 60% 命中 + 行数 ≥ 4 才认（
 * 少量巧合命中不切换图型）。
 */
const TEMPORAL_PATTERNS: readonly RegExp[] = [
  /^\d{4}[-/.]\d{1,2}([-/.]\d{1,2})?$/,      // 2026-01、2026/3/5
  /^\d{1,2}[-/]\d{1,2}$/,                     // 3/5、03-15
  /^\d{1,2}:\d{2}(:\d{2})?$/,                 // 10:00、14:30:00
  /^\d{4}$/,                                   // 2026（年份）
  /^\d{4}\s*年/,                               // 2026年
  /^\d{1,2}\s*月/,                             // 3月、12月
  /^\d{1,2}\s*日$/,                            // 5日
  /^(周|星期)[一二三四五六日天]/,               // 周一、星期三
  /^(mon|tues?|wednes|thurs?|fri|satur|sun)day/i,
  /^(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s*\d{0,2}/i,
  /^q[1-4](季度)?/i,                          // Q1、q3季度
  /^第?\s*[一二三四]季度/,
];

function looksTemporal(value: RichCell): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  return TEMPORAL_PATTERNS.some(pattern => pattern.test(text));
}

/** 次列是否带占比语义（列名含 % / 占比 / 比例 / 百分比 / percent，或 unit 为 %） */
const PERCENT_NAME_PATTERN = /%|占比|比例|百分比|份额|percent/i;

// ==================== 数值工具 ====================

function cellText(value: RichCell): string {
  if (value === null) return '';
  return String(value);
}

/** 序列数值：null 保持 null（ECharts 断点），不静默改 0 */
function seriesValue(value: RichCell): number | null {
  return coerceNumber(value);
}

/** 雷达 / 仪表用：null → 0（这两种图型不支持断点） */
function denseValue(value: RichCell): number {
  return coerceNumber(value) ?? 0;
}

/** 向上取整到 1 / 2 / 5 × 10^n 的「好看」上限（雷达 indicator.max / gauge.max） */
function niceCeiling(maxValue: number): number {
  if (!Number.isFinite(maxValue) || maxValue <= 0) return 10;
  const exponent = Math.floor(Math.log10(maxValue));
  const base = Math.pow(10, exponent);
  for (const factor of [1, 2, 5, 10]) {
    if (maxValue <= factor * base) return factor * base;
  }
  return 10 * base;
}

// ==================== 图型解析 ====================

function resolveKind(env: NormalizedEnvelope): ChartKind {
  if (env.kind && CHART_KINDS.has(env.kind)) return env.kind as ChartKind;

  // 占比语义（unit 或次列列名）且两列 → 饼图
  if (env.columns.length === 2) {
    const percentish =
      env.unit === '%' ||
      PERCENT_NAME_PATTERN.test(env.columns[1]) ||
      PERCENT_NAME_PATTERN.test(env.title);
    if (percentish) return 'pie';
  }

  // 首列时间序且行数足够 → 折线
  const nonNullFirst = env.rows.map(row => row[0]).filter(cell => cell !== null);
  if (nonNullFirst.length >= 4) {
    const hits = nonNullFirst.filter(looksTemporal).length;
    if (hits / nonNullFirst.length >= 0.6) return 'line';
  }

  return 'bar';
}

// ==================== 派生实现 ====================

export type DeriveChartResult =
  | { ok: true; option: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * 信封 → ECharts option。结构性不满足（列数不足 / 数值不可解析）返回
 * ok:false（渲染侧降级源码视图），不做「猜一个图」的兜底。
 */
export function deriveChartOption(env: NormalizedEnvelope): DeriveChartResult {
  if (env.columns.length < 2) {
    return { ok: false, error: '图表至少需要 2 列（1 列类目 + 1 列数值）' };
  }

  const kind = resolveKind(env);
  const title = env.title ? { text: env.title } : undefined;

  if (CARTESIAN_KINDS.has(kind)) {
    // 空列名兜底（图例 / tooltip 引用系列名，不允许空串）
    const seriesNames = env.columns.slice(1).map((name, index) => name || `系列${index + 1}`);
    const seriesType = kind === 'area' ? 'line' : kind;
    return {
      ok: true,
      option: {
        ...(title ? { title } : {}),
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'category', data: env.rows.map(row => cellText(row[0])) },
        yAxis: { type: 'value', ...(env.unit ? { name: env.unit } : {}) },
        series: seriesNames.map((name, colIndex) => ({
          name,
          type: seriesType,
          ...(kind === 'area' ? { areaStyle: {} } : {}),
          data: env.rows.map(row => seriesValue(row[colIndex + 1])),
        })),
      },
    };
  }

  if (kind === 'pie') {
    return {
      ok: true,
      option: {
        ...(title ? { title } : {}),
        tooltip: { trigger: 'item' },
        series: [
          {
            type: 'pie',
            radius: '62%',
            label: { formatter: '{b}: {c} ({d}%)' },
            data: env.rows
              .map(row => ({ name: cellText(row[0]), value: denseValue(row[1]) }))
              .filter(item => item.name !== ''),
          },
        ],
      },
    };
  }

  if (kind === 'scatter') {
    // 三列及以上：末列（第 3 列）作为分组维度 → 多系列
    const hasGroup = env.columns.length >= 3;
    if (!hasGroup) {
      return {
        ok: true,
        option: {
          ...(title ? { title } : {}),
          tooltip: { trigger: 'item' },
          xAxis: { type: 'value', ...(env.unit ? { name: env.unit } : {}) },
          yAxis: { type: 'value' },
          series: [
            {
              name: env.columns[1],
              type: 'scatter',
              data: env.rows
                .map(row => [seriesValue(row[0]), seriesValue(row[1])])
                .filter(pair => pair[0] !== null && pair[1] !== null),
            },
          ],
        },
      };
    }
    const groups = new Map<string, Array<[number | null, number | null]>>();
    for (const row of env.rows) {
      const groupName = cellText(row[2]) || env.columns[2];
      const pair: [number | null, number | null] = [seriesValue(row[0]), seriesValue(row[1])];
      if (pair[0] === null || pair[1] === null) continue;
      const bucket = groups.get(groupName);
      if (bucket) bucket.push(pair);
      else groups.set(groupName, [pair]);
    }
    return {
      ok: true,
      option: {
        ...(title ? { title } : {}),
        tooltip: { trigger: 'item' },
        xAxis: { type: 'value', ...(env.unit ? { name: env.unit } : {}) },
        yAxis: { type: 'value' },
        series: [...groups.entries()].map(([name, data]) => ({ name, type: 'scatter', data })),
      },
    };
  }

  if (kind === 'radar') {
    // 转置派生：行 = 维度（indicator），其余每列 = 一个对照实体（series）。
    // 空名行在构建 indicator 与 series 值之前统一剔除——两侧必须同源同长
    const radarRows = env.rows.filter(row => cellText(row[0]) !== '');
    if (radarRows.length === 0) {
      return { ok: false, error: '雷达图所有行的首列（维度名）为空' };
    }
    let maxVal = 0;
    for (const row of radarRows) {
      for (let col = 1; col < env.columns.length; col++) {
        maxVal = Math.max(maxVal, denseValue(row[col]));
      }
    }
    const indicatorMax = niceCeiling(maxVal);
    return {
      ok: true,
      option: {
        ...(title ? { title } : {}),
        tooltip: { trigger: 'item' },
        radar: {
          indicator: radarRows.map(row => ({ name: cellText(row[0]), max: indicatorMax })),
        },
        series: env.columns.slice(1).map((name, colIndex) => ({
          name: name || `系列${colIndex + 1}`,
          type: 'radar',
          data: [
            {
              name: name || `系列${colIndex + 1}`,
              value: radarRows.map(row => denseValue(row[colIndex + 1])),
            },
          ],
        })),
      },
    };
  }

  if (kind === 'funnel') {
    return {
      ok: true,
      option: {
        ...(title ? { title } : {}),
        tooltip: { trigger: 'item' },
        series: [
          {
            type: 'funnel',
            label: { formatter: '{b}: {c}' },
            data: env.rows
              .map(row => ({ name: cellText(row[0]), value: denseValue(row[1]) }))
              .filter(item => item.name !== ''),
          },
        ],
      },
    };
  }

  if (kind === 'gauge') {
    const value = seriesValue(env.rows[0]?.[1]);
    if (value === null) {
      return { ok: false, error: '仪表盘数值列无法解析为数字' };
    }
    const max = value <= 100 ? 100 : niceCeiling(value * 1.2);
    return {
      ok: true,
      option: {
        ...(title ? { title } : {}),
        series: [
          {
            type: 'gauge',
            max,
            data: [{ value, name: cellText(env.rows[0]?.[0]) || env.columns[1] }],
          },
        ],
      },
    };
  }

  // heatmap：至少 3 列（x / y / 值）
  if (env.columns.length < 3) {
    return { ok: false, error: '热力图至少需要 3 列（x、y、数值）' };
  }
  const xCategories: string[] = [];
  const yCategories: string[] = [];
  const heatData: Array<[number, number, number]> = [];
  for (const row of env.rows) {
    const x = cellText(row[0]);
    const y = cellText(row[1]);
    const v = seriesValue(row[2]);
    if (!x || !y || v === null) continue;
    let xi = xCategories.indexOf(x);
    if (xi === -1) {
      xCategories.push(x);
      xi = xCategories.length - 1;
    }
    let yi = yCategories.indexOf(y);
    if (yi === -1) {
      yCategories.push(y);
      yi = yCategories.length - 1;
    }
    heatData.push([xi, yi, v]);
  }
  if (heatData.length === 0) {
    return { ok: false, error: '热力图数据行全部不可解析（x / y / 数值缺位）' };
  }
  const values = heatData.map(item => item[2]);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  return {
    ok: true,
    option: {
      ...(title ? { title } : {}),
      tooltip: { trigger: 'item' },
      grid: { left: 64, right: 16, top: 32, bottom: 56 },
      xAxis: { type: 'category', data: xCategories },
      yAxis: { type: 'category', data: yCategories },
      visualMap: {
        min: minVal,
        max: maxVal === minVal ? minVal + 1 : maxVal,
        calculable: false,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
      },
      series: [{ type: 'heatmap', data: heatData, label: { show: false } }],
    },
  };
}
