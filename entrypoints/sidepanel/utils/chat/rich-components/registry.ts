/**
 * 富组件能力注册表 —— 「宿主能渲染什么」的单一事实源
 *
 * 本模块只声明**能力**（承载形式 / 围栏语言名 / 信封 type / 是否默认启用），
 * 不产出任何提示词文案——「怎么教模型」由 rich-output-prompt.ts 承担。
 * 领域层不产出文案是本项目的分层约定（渠道配置域同一原则）：能力边界由
 * 这里定死，教学话术由提示词文件定死，两侧由提示词文件的覆盖性校验强制
 * 一一对齐——新增组件 = 本文件加一条能力记录 + 渲染侧一个构建/派生函数
 * + 提示词文件补一段教学文案，缺一即模块加载即报错（不会静默教出宿主
 * 渲染不了的东西）。
 *
 * ==================== 安全模型（承自原 rich-output-prompt.ts，未变） ====================
 *
 *   - 模型只允许输出「声明式数据」：统一信封是纯 JSON（envelope.ts 容错
 *     解析 + 归一化），图表 option 由宿主从列式数据「派生」（derive-chart.ts），
 *     模型内容永不构成可执行代码——它连坐标轴与系列结构都不再书写，
 *     长度错配类语义错误在结构上不可能发生；
 *   - 渲染分两级隔离：同步组件（stat / table / timeline / tree / insight）
 *     走「校验 + 全量转义 + 受控模板」产出可信 HTML（component-blocks.ts）；
 *     图表经 echarts-option-sanitizer 净化后仅在 manifest 沙箱页
 *     （无任何 chrome.* 权限、独立源）的 iframe 内渲染。
 *
 * ==================== 能力协商 ====================
 *
 * AgentConfig.capabilities.richComponents 声明本智能体可用的组件 id 子集；
 * buildRichOutputSystemPrompt(allowed)（rich-output-prompt.ts）据此裁剪
 * 提示词——未声明 = 默认集，声明空数组 = 整段不注入（0 开销）。渲染侧不
 * 裁剪：历史消息（可能来自其他智能体）在任何会话中都必须继续可渲染。
 */

/** 统一信封围栏语言名（信封组件唯一入口；各组件另有 legacy 直连围栏名） */
export const COMPONENT_FENCE_LANG = 'component';

/** 组件 id（capabilities 声明与提示词生成使用） */
export type RichComponentId =
  | 'chart'
  | 'stat'
  | 'table'
  | 'timeline'
  | 'tree'
  | 'insight'
  | 'diagram'
  | 'diff';

/**
 * 组件的**承载形式**——决定模型怎么写、渲染器怎么收：
 *   - envelope：统一信封（```component + type 字段），列式数据；
 *   - native：原生 DSL 围栏（模型直接写该语法，不包 JSON）。
 */
export type RichComponentForm = 'envelope' | 'native';

export interface RichComponentSpec {
  id: RichComponentId;
  /** 承载形式（envelope / native） */
  form: RichComponentForm;
  /**
   * 直接触发本组件的围栏语言名（首位为规范名，其余为兼容别名）。
   * 信封组件（chart/stat/table/timeline/tree/insight）的规范入口是
   * ```component + type 字段；此处的 fenceLangs 是 legacy 直连名
   * （echarts / stat-card 等，历史消息与旧模型输出兼容）或原生 DSL 名
   * （mermaid / diff）。
   *
   * legacy 直连名**不进提示词**：模型只学规范形式，多教别名只会增加
   * 认知负担并让输出形态漂移——别名存在的唯一理由是让历史消息继续可渲染。
   */
  fenceLangs: readonly string[];
  /** ```component 信封内 type 字段合法值（非信封组件不声明） */
  envelopeType?: string;
  /** 是否进入默认能力集（未声明 capabilities 的智能体 / 历史会话） */
  defaultEnabled: boolean;
}

/**
 * 组件目录。顺序即提示词出现顺序：chart（命中率担当）在前，其余信封
 * 组件按使用频率排列；原生围栏组件殿后。
 */
export const RICH_COMPONENTS: readonly RichComponentSpec[] = [
  {
    id: 'chart',
    form: 'envelope',
    fenceLangs: ['echarts', 'chart'],
    envelopeType: 'chart',
    defaultEnabled: true,
  },
  {
    id: 'stat',
    form: 'envelope',
    fenceLangs: ['stat-card', 'stats'],
    envelopeType: 'stat',
    defaultEnabled: true,
  },
  {
    id: 'table',
    form: 'envelope',
    fenceLangs: [],
    envelopeType: 'table',
    defaultEnabled: true,
  },
  {
    id: 'timeline',
    form: 'envelope',
    fenceLangs: [],
    envelopeType: 'timeline',
    defaultEnabled: true,
  },
  {
    id: 'tree',
    form: 'envelope',
    fenceLangs: [],
    envelopeType: 'tree',
    defaultEnabled: true,
  },
  {
    id: 'insight',
    form: 'envelope',
    fenceLangs: [],
    envelopeType: 'insight',
    defaultEnabled: true,
  },
  {
    id: 'diagram',
    form: 'native',
    fenceLangs: ['mermaid', 'plantuml', 'puml'],
    defaultEnabled: true,
  },
  {
    id: 'diff',
    form: 'native',
    fenceLangs: ['diff'],
    defaultEnabled: true,
  },
];

// ==================== 查询（模块加载期构建一次，注册表为编译期常量） ====================

/** 围栏语言名 → 组件（含 legacy 直连名与原生 DSL 名；'component' 信封另行处理） */
const FENCE_LANG_INDEX: ReadonlyMap<string, RichComponentSpec> = (() => {
  const map = new Map<string, RichComponentSpec>();
  for (const spec of RICH_COMPONENTS) {
    for (const lang of spec.fenceLangs) {
      const existing = map.get(lang);
      if (existing && existing !== spec) {
        throw new Error(`[RichComponents] 围栏语言名 "${lang}" 被多个组件声明（${existing.id} / ${spec.id}）`);
      }
      map.set(lang, spec);
    }
  }
  if (map.has(COMPONENT_FENCE_LANG)) {
    throw new Error(`[RichComponents] "${COMPONENT_FENCE_LANG}" 是统一信封保留名，不得作为直连围栏语言名`);
  }
  return map;
})();

export function findRichComponentByFenceLang(lang: string): RichComponentSpec | undefined {
  return FENCE_LANG_INDEX.get(lang);
}

/** 信封内 type 字段合法值集合 */
export const ENVELOPE_COMPONENT_TYPES: ReadonlySet<string> = new Set(
  RICH_COMPONENTS.filter(spec => spec.envelopeType !== undefined).map(spec => spec.envelopeType as string),
);
