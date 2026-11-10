/**
 * 图表布局计算：自然宽度 / 渲染宽度 / 显示缩放
 *
 * ==================== 为什么需要这一层 ====================
 *
 * 图表在沙箱 iframe 里渲染（隔离 ECharts 的 XSS 面）。侧边栏宽度有限，
 * 图表随之变窄时 ECharts 会在**容器宽度**上重新排版——坐标区随之压缩，
 * 类目标签互相重叠时 ECharts 会**自动隐藏**部分标签（interval: 'auto'）。
 * 于是窄侧边栏下会出现「右边几项没标签、看不出全貌」的观感，
 * 导出的图片也继承了这个窄版式（既丢信息、分辨率又低）。
 *
 * 解法是**先按数据的舒适宽度排版，再等比缩小到可用宽度**：
 *   1. 自然宽度（naturalWidth）= 数据量决定的舒适渲染宽度
 *      （类目轴：所有类目标签的宽度之和 + 坐标区留白；饼/漏斗：最长标签 + 外圈余量；
 *        其余图型：固定下限）；
 *   2. 渲染宽度（renderWidth）= max(可用宽度, 自然宽度)
 *      —— 宽侧边栏时按可用宽度排版（不浪费空间），窄侧边栏时按自然宽度排版
 *      （标签一个不落）；
 *   3. 显示缩放（scale）= 可用宽度 / 渲染宽度 ≤ 1
 *      —— 沙箱 iframe 宽 = 渲染宽度，父页用 CSS transform 等比缩小到可用宽度，
 *      坐标轴、标签、数据点全部完整可见。
 *
 * 缩放有下限（CHART_MIN_FIT_SCALE）：缩到看不清反而更差，此时放弃缩放、
 * 按可用宽度排版，交给 ECharts 自行取舍标签（类目极多时的标准行为）。
 *
 * ==================== 与导出链路的同源 ====================
 *
 * 屏幕与导出共用同一套计算：屏幕按 renderWidth 排版后缩小显示，
 * 导出按**同一个 renderWidth** 以更高像素密度栅格化——导出图与屏幕所见
 * 版式完全一致，但每个像素都清晰（不经过缩小）。
 */

/** 图表可视高度（逻辑 px；与 iframe 高度一致） */
export const CHART_VIEW_HEIGHT = 340;

/** 非笛卡尔图（饼/漏斗/仪表/散点/雷达/热力）的默认舒适宽度 */
const DEFAULT_NATURAL_WIDTH = 480;

/** 自然宽度下限（低于此值图表会挤成一团） */
export const CHART_MIN_NATURAL_WIDTH = 360;

/** 自然宽度上限（类目极多时不再无限加宽——再宽也看不清，等比缩小会失真） */
export const CHART_MAX_NATURAL_WIDTH = 1600;

/** 最小显示缩放：低于此值不缩放（缩到看不清反而更差） */
export const CHART_MIN_FIT_SCALE = 0.65;

/** ECharts 类目标签的默认字号（主题默认值：axisLabel.fontSize = 12） */
const AXIS_LABEL_FONT_SIZE = 12;

/** ECharts 默认 grid 左右各留 10%——坐标区只占宽度的 80% */
const GRID_PLOT_RATIO = 0.8;

/** 标签之间的最小间隙（ECharts 的 axisLabel margin 默认 8，留一点余量） */
const AXIS_LABEL_MARGIN = 12;

/**
 * 饼/漏斗标签里「名称之外」那部分的宽度（格式化后的「: 数值 (占比%)」）。
 * 饼图标签形如「404 失效: 10 (10%)」，比名称长一截——按名称算宽度会
 * 让左侧标签溢出画布左缘（表现为「左边被切」）。
 */
const PIE_LABEL_EXTRA = 45;

/** 安全系数：ECharts 的 auto interval 判定比「标签能放下」更保守，留 25% 余量 */
const FIT_SAFETY_FACTOR = 1.25;

/** 文本测量画布（懒创建；用真实字体度量，避免按字数估算偏差过大） */
let measureCanvas: HTMLCanvasElement | null = null;
let measureContext: CanvasRenderingContext2D | null = null;
/** 测量不可用时置位（如 JSDOM / 隐私模式）：不再重试，直接走估算 */
let measureUnavailable = false;

function measureTextWidth(text: string): number | null {
  if (typeof document === 'undefined' || measureUnavailable) return null;
  try {
    if (!measureCanvas) {
      measureCanvas = document.createElement('canvas');
      measureContext = measureCanvas.getContext('2d');
    }
    if (!measureContext) {
      measureUnavailable = true;
      return null;
    }
    measureContext.font = `${AXIS_LABEL_FONT_SIZE}px sans-serif`;
    const width = measureContext.measureText(text).width;
    if (!Number.isFinite(width) || width <= 0) {
      measureUnavailable = true;
      return null;
    }
    return width;
  } catch {
    // 无 canvas 上下文：退回估算，且不再重试
    measureContext = null;
    measureUnavailable = true;
    return null;
  }
}

/**
 * 文本像素宽度。
 *
 * 优先用**真实字体度量**（canvas measureText，与 ECharts 的类目标签同一字号/
 * 字体族）；无 DOM 上下文时退回按字数估算。
 */
function textWidth(text: string): number {
  const measured = measureTextWidth(text);
  if (measured !== null) return Math.min(measured, 240);
  let width = 8;
  for (const ch of text) {
    width += /[⺀-鿿＀-￯]/.test(ch) ? 13 : 7.5;
  }
  return Math.min(width, 160);
}

function clampNatural(width: number): number {
  return Math.min(CHART_MAX_NATURAL_WIDTH, Math.max(CHART_MIN_NATURAL_WIDTH, Math.round(width)));
}

/** 从 option 里取出类目轴的类目文本（笛卡尔图） */
function readCategories(option: Record<string, unknown>): string[] | null {
  const xAxis = option.xAxis as { data?: unknown } | undefined;
  if (!xAxis || !Array.isArray(xAxis.data) || xAxis.data.length === 0) return null;
  return xAxis.data.map(item => (item === null || item === undefined ? '' : String(item)));
}

/** 从 option 里取出饼/漏斗的数据项名称（标签在外圈，名字越长越需要余量） */
function readItemNames(option: Record<string, unknown>): string[] {
  const names: string[] = [];
  const series = option.series;
  if (!Array.isArray(series)) return names;
  for (const item of series) {
    const data = (item as { data?: unknown })?.data;
    if (!Array.isArray(data)) continue;
    for (const point of data) {
      const name = (point as { name?: unknown })?.name;
      if (typeof name === 'string' && name) names.push(name);
    }
  }
  return names;
}

/** 从 option 里取出系列名（legend 默认由系列名生成，是最常见的「右侧被切」来源） */
function readSeriesNames(option: Record<string, unknown>): string[] {
  const series = option.series;
  if (!Array.isArray(series)) return [];
  const names: string[] = [];
  for (const item of series) {
    const name = (item as { name?: unknown })?.name;
    if (typeof name === 'string' && name) names.push(name);
  }
  return names;
}

/** legend 一行排布的宽度：每个条目 = 名称 + 图标 + 间距 */
function legendWidth(option: Record<string, unknown>): number {
  const names = readSeriesNames(option);
  if (names.length === 0) return 0;
  let total = 24; // 左右留白
  for (const name of names) total += textWidth(name) + 30; // 30 = 图标 + 条目间距
  return total;
}

/**
 * 由数据推导图表的**自然宽度**（舒适渲染宽度）。
 *
 * 该值只描述「数据本身需要多宽才不丢信息」，与当前容器宽度无关——
 * 因此同一个图表在宽窄侧边栏里的自然宽度一致，缩放比例才是变量。
 *
 * 类目轴的算法（经实测标定，见下）：
 *   ECharts 的 grid 默认左右各留 10%，坐标区只占 80% 宽度；类目标签按
 *   **统一间隔**显示（间隔由最宽的那个标签决定），标签放不下时整轴降为
 *   「隔一个显示一个」。要让 N 个标签全部出现，坐标区需要
 *   `N × (最宽标签 + 间隙)`，换算成容器宽度即除以 0.8，再留安全余量。
 *   实测标定（12px 字号）：
 *     12 个「下周一」类标签 → 800px 才全显示；
 *     7 个「周一」        → 300px 全显示；
 *     4 个「2026-01-05」 → 500px 全显示。
 *
 * 另取两类需求的最大值：
 *   - legend：一行放下的系列名总宽（ECharts 默认 legend 不换行，放不下就右侧被切）；
 *   - 饼/漏斗的数据项名称：标签在外圈，名字越长越需要余量。
 */
export function chartNaturalWidth(option: Record<string, unknown> | null | undefined): number {
  if (!option || typeof option !== 'object') return clampNatural(DEFAULT_NATURAL_WIDTH);

  let needed = 0;

  const categories = readCategories(option);
  if (categories && categories.length > 0) {
    // 统一间隔：按最宽的标签算（N 个标签各占这么宽）
    let widest = 0;
    for (const category of categories) widest = Math.max(widest, textWidth(category));
    const perCategory = widest + AXIS_LABEL_MARGIN;
    const plotNeeded = categories.length * perCategory;
    needed = Math.max(needed, (plotNeeded / GRID_PLOT_RATIO) * FIT_SAFETY_FACTOR);
  }

  needed = Math.max(needed, legendWidth(option));

  const names = readItemNames(option);
  if (names.length > 0) {
    let longest = 0;
    for (const name of names) longest = Math.max(longest, textWidth(name));
    // 饼/漏斗的标签排在圆（漏斗）两侧：半径由高度决定（ECharts 默认半径 75%），
    // 左右各要放下一个标签宽度 → 需要的宽度 = 2 × (半径 + 标签宽 + 间隙)。
    // 标签宽按**格式化后**的长度算：饼图标签是「名称: 数值 (占比%)」，
    // 比名称长一截（名称外的部分约 PIE_LABEL_EXTRA px）。
    const labelWidth = longest + PIE_LABEL_EXTRA;
    const radius = 0.375 * CHART_VIEW_HEIGHT;
    needed = Math.max(needed, 2 * (radius + labelWidth + 20));
  }

  return clampNatural(needed || DEFAULT_NATURAL_WIDTH);
}

export interface ChartLayout {
  /** 沙箱 iframe 的逻辑宽度（图表按此宽度排版） */
  renderWidth: number;
  /** 父页显示缩放（≤ 1；1 = 不缩放） */
  scale: number;
  /** 自然宽度（诊断用） */
  naturalWidth: number;
  /** 缩放后的可见宽度（= renderWidth × scale） */
  paintedWidth: number;
  /** 缩放后的可见高度 */
  paintedHeight: number;
  /** 是否需要横向滚动（缩到最小可读比例仍不够宽时） */
  scrollable: boolean;
}

/** 解析净化后的 option JSON（非对象 / 非法 JSON → null） */
export function parseChartOption(optionJson: string | null | undefined): Record<string, unknown> | null {
  if (!optionJson) return null;
  try {
    const parsed: unknown = JSON.parse(optionJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 计算渲染宽度与显示缩放。
 *
 * @param availableWidth 图表块的可用宽度（容器宽度）
 * @param naturalWidth 图表的自然宽度（chartNaturalWidth 的产物）
 *
 * 两种呈现方式，按「信息不丢 + 可读」排序：
 *   1. 等比缩小（首选）：整体缩到可用宽度——坐标轴、标签、数据点一个不少，
 *      只是变小。缩放比例低于最小可读比例时放弃这一步；
 *   2. 横向滚动（兜底）：保持原始尺寸（文字清晰、标签完整），由可见框
 *      横向滚动查看其余部分。
 *
 * 两种方式都**不截断内容**——这是本模块存在的唯一理由。
 */
export function computeChartLayout(
  availableWidth: number,
  naturalWidth: number,
): ChartLayout {
  const available = Math.max(1, Math.round(availableWidth));
  const natural = Math.max(1, Math.round(naturalWidth));

  const renderWidth = Math.max(available, natural);
  const rawScale = available / renderWidth;

  // 缩到看不清就不缩：保持原始尺寸，剩余部分横向滚动查看
  const scaled = rawScale >= CHART_MIN_FIT_SCALE;
  const scale = scaled ? rawScale : 1;

  return {
    renderWidth,
    scale,
    naturalWidth: natural,
    paintedWidth: Math.round(renderWidth * scale),
    paintedHeight: Math.round(CHART_VIEW_HEIGHT * scale),
    scrollable: !scaled,
  };
}
