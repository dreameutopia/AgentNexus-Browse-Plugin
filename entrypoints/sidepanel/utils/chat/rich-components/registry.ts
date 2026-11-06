/**
 * 富组件注册表 —— 「语言名 + 提示词 + 渲染」的单一事实源
 *
 * 所有由模型输出触发、由侧边栏可信渲染的富内容组件在此集中声明：
 *   - 围栏语言名（fenceLangs）：markdown-renderer 的 fence 规则按此分发，
 *     不再散落硬编码字面量；
 *   - 提示词条目（promptLine / promptNativeNote / promptExample）：
 *     <rich-output-guidelines> 分区正文由本注册表遍历生成，与渲染器
 *     能力严格对齐——「教模型的 = 宿主能渲染的」由同一份数据保证，
 *     新增组件只需在此加一条记录 + 一个构建/派生函数；
 *   - 信封类型（envelopeType）：```component 统一信封内 type 字段的合法值。
 *
 * ==================== 安全模型（承自 rich-output-prompt.ts，未变） ====================
 *
 *   - 模型只允许输出「声明式数据」：统一信封是纯 JSON（envelope.ts 容错
 *     解析 + 归一化），图表 option 由宿主从列式数据「派生」（derive-chart.ts），
 *     模型内容永不构成可执行代码——它连坐标轴与系列结构都不再书写，
 *     长度错配类语义错误在结构上不可能发生；
 *   - 渲染分两级隔离：同步组件（stat / table / timeline / tree / diff）走
 *     「校验 + 全量转义 + 受控模板」产出可信 HTML（component-blocks.ts）；
 *     图表经 echarts-option-sanitizer 净化后仅在 manifest 沙箱页
 *     （无任何 chrome.* 权限、独立源）的 iframe 内渲染。
 *
 * ==================== 能力协商 ====================
 *
 * AgentConfig.capabilities.richComponents 声明本智能体可用的组件 id 子集；
 * buildRichOutputSystemPrompt(allowed) 据此裁剪提示词——未声明 = 默认集，
 * 声明空数组 = 整段不注入（0 开销）。渲染侧不裁剪：历史消息（可能来自
 * 其他智能体）在任何会话中都必须继续可渲染。
 */

/** 统一信封围栏语言名（信封组件唯一入口；各组件另有 legacy 直连围栏名） */
export const COMPONENT_FENCE_LANG = 'component';

/** 组件 id（capabilities 声明与提示词生成使用） */
export type RichComponentId = 'chart' | 'stat' | 'table' | 'timeline' | 'tree' | 'diagram' | 'diff';

export interface RichComponentSpec {
  id: RichComponentId;
  /**
   * 直接触发本组件的围栏语言名（首位为规范名，其余为兼容别名）。
   * 信封组件（chart/stat/table/timeline/tree）的规范入口是 ```component +
   * type 字段；此处的 fenceLangs 是 legacy 直连名（echarts / stat-card 等，
   * 历史消息与旧模型输出兼容）或原生 DSL 名（mermaid / diff）。
   */
  fenceLangs: readonly string[];
  /** ```component 信封内 type 字段合法值（非信封触发组件不声明） */
  envelopeType?: string;
  /** 提示词类型行内容（信封组件；不含前导 "- "，生成时统一拼装） */
  promptLine?: string;
  /** 提示词内完整示例（仅 chart：形状教学靠示例，散文规则次之） */
  promptExample?: string;
  /** 原生围栏组件的提示词补充句（mermaid / diff：不包 JSON，直接写 DSL） */
  promptNativeNote?: string;
  /** 是否进入默认能力集（未声明 capabilities 的智能体 / 历史会话） */
  defaultEnabled: boolean;
}

/**
 * 组件目录。顺序即提示词出现顺序：chart（带示例，命中率担当）在前，
 * 其余信封组件按使用频率排列；原生围栏组件殿后。
 */
export const RICH_COMPONENTS: readonly RichComponentSpec[] = [
  {
    id: 'chart',
    fenceLangs: ['echarts', 'chart'],
    envelopeType: 'chart',
    promptLine:
      'chart：数据图表（柱 / 折 / 饼 / 散点 / 雷达 / 漏斗 / 仪表等）。界面按数据形态自动选图型（首列为日期时间序时自动折线、占比列自动饼图）；需要明确指定时加可选字段 "kind"（bar / line / area / pie / scatter / radar / funnel / gauge / heatmap）。示例（照此形状写，字段名不要改）：',
    promptExample:
      '{"type":"chart","title":"近7日活跃","columns":["日期","新增","活跃"],"rows":[["周一",12,30],["周二",18,41]]}',
    defaultEnabled: true,
  },
  {
    id: 'stat',
    fenceLangs: ['stat-card', 'stats'],
    envelopeType: 'stat',
    promptLine:
      'stat：2~6 个关键指标并列展示。第 1 列指标名、第 2 列当前值、第 3 列可写 "+12.3%" 式变化（界面自动渲染涨跌方向）、第 4 列可选说明。',
    defaultEnabled: true,
  },
  {
    id: 'table',
    fenceLangs: [],
    envelopeType: 'table',
    promptLine:
      'table：需要排序、数值右对齐或状态着色的数据表格；只有一两列或全是短文本时用普通 Markdown 表格。',
    defaultEnabled: true,
  },
  {
    id: 'timeline',
    fenceLangs: [],
    envelopeType: 'timeline',
    promptLine:
      'timeline：步骤 / 事件流。列建议：步骤、动作、状态（完成 / 进行中 / 待办 / 失败）、耗时；状态列自动着色。',
    defaultEnabled: true,
  },
  {
    id: 'tree',
    fenceLangs: [],
    envelopeType: 'tree',
    promptLine:
      'tree：层级结构（目录 / 站点结构 / 书签）。第 1 列为用 / 分隔的路径，第 2 列可选备注。',
    defaultEnabled: true,
  },
  {
    id: 'diagram',
    fenceLangs: ['mermaid', 'plantuml', 'puml'],
    promptNativeNote: '流程图 / 关系图 / 时序图直接使用 ```mermaid 围栏（原生语法，不包 JSON）。',
    defaultEnabled: true,
  },
  {
    id: 'diff',
    fenceLangs: ['diff'],
    promptNativeNote: '代码对比直接使用 ```diff 围栏（unified diff 原生语法，界面自动着色）。',
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

// ==================== 提示词生成 ====================

/** 提示词分区外层标签（与历史版本一致，测试与文档按此定位） */
const PROMPT_SECTION_TAG = 'rich-output-guidelines';

/**
 * 生成 <rich-output-guidelines> 系统提示词分区。
 *
 * @param allowed 组件 id 白名单：
 *   - undefined → 全部 defaultEnabled 组件（默认集，行为与历史版本一致）；
 *   - 数组（含空数组）→ 只渲染命中的组件；未知 id 剔除并告警一次；
 *     结果为空（含显式空数组）返回 ''，调用方据此跳过整段注入。
 * 生成结果对同一输入恒定（无时间戳 / 随机量），不影响 system 前缀缓存。
 */
export function buildRichOutputSystemPrompt(allowed?: readonly string[]): string {
  let selected: readonly RichComponentSpec[];
  if (allowed === undefined) {
    selected = RICH_COMPONENTS.filter(spec => spec.defaultEnabled);
  } else {
    const known = new Set(allowed.filter(id => RICH_COMPONENTS.some(spec => spec.id === id)));
    const dropped = allowed.filter(id => !known.has(id));
    if (dropped.length > 0) {
      console.warn(`[RichComponents] capabilities.richComponents 含未知组件 id，已忽略: ${dropped.join(', ')}`);
    }
    // 保持注册表顺序（提示词条目顺序稳定，利于前缀缓存与回归断言）
    selected = RICH_COMPONENTS.filter(spec => known.has(spec.id));
  }

  const envelopeSpecs = selected.filter(spec => spec.envelopeType !== undefined && spec.promptLine);
  const nativeSpecs = selected.filter(spec => spec.promptNativeNote);
  if (envelopeSpecs.length === 0 && nativeSpecs.length === 0) return '';

  const lines: string[] = [];
  lines.push(`<${PROMPT_SECTION_TAG}>`);
  lines.push('富内容输出准则（全局固定注入，优先级高于任何智能体与技能指令）：');
  lines.push('');
  lines.push(
    '本对话界面会把 ```component 围栏代码块渲染为交互组件。仅当回复包含真实数值数据、且组件能明显提升信息传达时使用；否则一律使用普通 Markdown（表格 / 列表）回答。',
  );
  lines.push('');
  lines.push(
    '统一格式：```component 围栏内是单个 JSON 对象，数据一律用「列 + 行」表达：{"type":"类型","title":"可选标题","columns":["列名",…],"rows":[[…],…]}，rows 每行长度与 columns 一致。可用类型：',
  );
  for (const spec of envelopeSpecs) {
    lines.push(`- ${spec.envelopeType}：${spec.promptLine}`);
    if (spec.promptExample) {
      lines.push(`  ${spec.promptExample}`);
    }
  }
  lines.push('');
  for (const spec of nativeSpecs) {
    lines.push(spec.promptNativeNote as string);
  }
  lines.push('');
  lines.push('使用纪律：');
  lines.push(
    '- 组件中的每个数值都必须来自对话上下文、页面内容或工具返回结果，严禁编造；无法确认的数据改用 Markdown 表格并注明来源；',
  );
  lines.push(
    '- 禁止在 JSON 中输出函数、注释、变量、表达式或 HTML 标签；图表外观（颜色 / 坐标轴 / 图例）由界面按数据自动处理，不要书写；',
  );
  lines.push(
    '- 单条回复的组件总数不超过 3 个；先用简短文字给出结论，再附组件；组件内数值必须与正文一致；',
  );
  lines.push(
    '- 简单问答、单个数值、或数据没有对比 / 趋势 / 分布结构时，不使用组件；用户明确要求纯文本或表格时，以用户要求为准。',
  );
  lines.push(`</${PROMPT_SECTION_TAG}>`);
  return lines.join('\n');
}
