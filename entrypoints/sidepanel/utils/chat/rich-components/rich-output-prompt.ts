/**
 * <rich-output-guidelines> 系统提示词分区 —— 单一事实源（独立维护）
 *
 * 本文件是「怎么教模型输出富内容」的唯一权威：分区文案、形式表、选型
 * 映射、数据纪律、使用纪律全部在这里，运行时由 runtime-builder 装配进
 * systemPrompt（固定分区，位于 <history-and-tools> 之前、<agent-instructions>
 * 之前，优先级声明高于任何智能体与技能指令）。
 *
 * ==================== 与能力注册表的关系 ====================
 *
 * registry.ts（rich-components/registry.ts）声明**宿主能渲染什么**（承载
 * 形式 / 围栏语言名 / 信封 type / 是否默认启用），本文件声明**怎么教**。
 * 两份数据必须一一对应，由本文件的覆盖性校验在模块加载期强制：
 *   - 注册表新增组件而本文件缺文案 → 抛错（不会静默教出渲染不了的东西）；
 *   - 本文件文案与注册表 id 不匹配 → 抛错。
 * 因此「教模型的 = 宿主能渲染的」仍然由同一处保证，只是职责分层了：
 * 领域层（注册表）不产出文案，提示词层（本文件）不重复能力清单。
 *
 * ==================== 提示词设计原则 ====================
 *
 *   - 一张表说清全部形式：形式 / 适用场景 / 怎么写三列并列，取代此前
 *     「选型映射列表 + 类型行」两份重复表述——形态 → 组件的正向映射由
 *     「适用场景」列承担，模型不必在两处信息之间做对齐；
 *   - 事实优先：真实数据能用组件承载就用组件（组件能同时呈现规模、排序
 *     与趋势，比纯文字和 Markdown 表格更快被读懂，也更不容易看错行），
 *     但「优先」的前提是数据真实——所以同区并列交叉验证、来源标注、
 *     口径标注与缺失标注的纪律；
 *   - 认知负担最小：只教模型必须知道的三件事（有哪些形式、什么数据用哪
 *     种、数据从哪来必须真实），参数语义、工具用法一律不重复工具描述；
 *   - 不教 legacy 围栏别名（echarts / stat-card）：别名只服务历史消息的
 *     可渲染性，教给模型只会让输出形态漂移；
 *   - 恒定性：同一输入产出逐字节相同（无时间戳 / 随机量），不影响
 *     system 前缀缓存命中。
 */

import {
  COMPONENT_FENCE_LANG,
  RICH_COMPONENTS,
  type RichComponentId,
  type RichComponentSpec,
} from './registry';

/** 提示词分区外层标签（与历史版本一致，测试与文档按此定位） */
const PROMPT_SECTION_TAG = 'rich-output-guidelines';

/**
 * 单个组件的教学文案（键 = 组件 id）。
 *
 * - scenario：该组件适用的数据形态（表「适用场景」列）；
 * - usage：该组件怎么写（表「怎么写」列）；
 * - example：完整示例（仅 chart：形状教学靠示例，散文规则次之）。
 */
interface ComponentTeaching {
  scenario: string;
  usage: string;
  example?: string;
}

const TEACHING: Record<RichComponentId, ComponentTeaching> = {
  chart: {
    scenario: '数值随时间变化、多项对比、占比构成',
    usage:
      '列：第 1 列类目（首列是日期时间序时自动折线），其余列为数值列；' +
      '界面按数据形态自动选图型，需要指定时加可选字段 "kind"（bar/line/area/pie/scatter/radar/funnel/gauge/heatmap）',
    example:
      '{"type":"chart","title":"近7日活跃","columns":["日期","新增","活跃"],"rows":[["周一",12,30],["周二",18,41]]}',
  },
  stat: {
    scenario: '2~6 个关键指标并列',
    usage:
      '列：指标名 / 当前值 / 变化（"+12.3%" 式，界面自动判涨跌）/ 可选说明；超过 6 个指标改用 table',
  },
  table: {
    scenario: '多列数据，需要排序、数值右对齐或状态标注',
    usage:
      '列：列名 + 每行同宽数据；状态词（完成 / 异常 / 超标…）自动着色；' +
      '只有一两列或全是短文本时用普通 Markdown 表格',
  },
  timeline: {
    scenario: '有先后顺序的步骤、事件、阶段推进',
    usage: '列：步骤 / 动作 / 状态（完成·进行中·待办·失败）/ 耗时；状态列自动着色',
  },
  tree: {
    scenario: '层级结构（目录、站点树、分类体系）',
    usage: '列：第 1 列用 / 分隔的路径，第 2 列可选备注',
  },
  insight: {
    scenario: '关键见解逐条拆开（结论 + 证据 + 来源 + 置信度）',
    usage:
      '列：洞察 / 证据（支撑它的数字或事实）/ 来源 / 置信度（高·中·低；' +
      '判定标准依本会话的验证规程，没有验证规程时写「未验证」）；' +
      '最多 12 条，超出改用 table',
  },
  diagram: {
    scenario: '流程、依赖、因果、层级关系图',
    usage: '直接写 Mermaid 语法，不包 JSON',
  },
  diff: {
    scenario: '代码差异对比',
    usage: '直接写 unified diff 语法，界面自动着色',
  },
};

// ==================== 覆盖性校验（模块加载期） ====================

{
  const missing = RICH_COMPONENTS.filter(spec => !TEACHING[spec.id]).map(spec => spec.id);
  if (missing.length > 0) {
    throw new Error(
      `[RichComponents] 提示词缺少组件文案，宿主能渲染但模型学不到：${missing.join(', ')}`,
    );
  }
  const registered = new Set(RICH_COMPONENTS.map(spec => spec.id));
  const orphan = (Object.keys(TEACHING) as RichComponentId[]).filter(id => !registered.has(id));
  if (orphan.length > 0) {
    throw new Error(`[RichComponents] 提示词文案对应未注册组件：${orphan.join(', ')}`);
  }
}

// ==================== 分区组装 ====================

/** 表「形式」列的写法：信封组件写 ```component · type，原生组件写围栏名 */
function formLabelOf(spec: RichComponentSpec): string {
  if (spec.form === 'envelope') {
    return `\`${COMPONENT_FENCE_LANG}\` · \`${spec.envelopeType}\``;
  }
  return `\`${spec.fenceLangs[0]}\` 围栏`;
}

/** 表格行（形式 / 适用场景 / 怎么写） */
function formRowsOf(selected: readonly RichComponentSpec[]): string[] {
  return selected.map(spec => {
    const teaching = TEACHING[spec.id];
    return `| ${formLabelOf(spec)} | ${teaching.scenario} | ${teaching.usage} |`;
  });
}

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

  const envelopeSpecs = selected.filter(spec => spec.form === 'envelope');
  const nativeSpecs = selected.filter(spec => spec.form === 'native');
  if (envelopeSpecs.length === 0 && nativeSpecs.length === 0) return '';

  const lines: string[] = [];
  lines.push(`<${PROMPT_SECTION_TAG}>`);
  lines.push('富内容输出准则（全局固定注入，优先级高于任何智能体与技能指令）。');
  lines.push('');

  // —— 事实优先：为什么用组件、数据从哪来 ——
  lines.push('<fact-first>');
  lines.push(
    '事实优先：能在本轮取到真实数据、且数据形态命中下表某一行，就用对应组件承载，' +
      '不要把数据降级成纯文字或 Markdown 表格——组件能同时呈现规模、排序与趋势，' +
      '比文字更快被读懂，也更不容易看错行。',
  );
  lines.push(
    '先取数再取形：只有真实数据才值得可视化。工具只返回一天的数据就不要画「近 7 日趋势」，' +
      '缺列就换更贴合的组件类型；不补全、不估算、不外推。',
  );
  lines.push(
    '组件是依据不是结论：先用简短文字给出判断，再附组件作为依据；正文与组件里的数值必须一致。',
  );
  lines.push('</fact-first>');
  lines.push('');

  // —— 形式表：宿主支持的全部形式 + 适用场景 + 怎么写 ——
  lines.push('<forms>');
  if (envelopeSpecs.length > 0) {
    lines.push(
      `统一信封（首选）：在 \`\`\`${COMPONENT_FENCE_LANG} 围栏里写单个 JSON 对象，` +
        'type 决定渲染成哪种组件：',
    );
    lines.push(
      '{"type":"类型","title":"可选标题","source":"可选来源说明","columns":["列名",…],"rows":[[…],…]}',
    );
    lines.push('rows 每行长度与 columns 一致。');
    lines.push('');
  }
  lines.push('| 形式 | 适用场景 | 怎么写 |');
  lines.push('| --- | --- | --- |');
  lines.push(...formRowsOf(selected));
  lines.push('');
  const chartExample = selected.some(spec => spec.id === 'chart')
    ? TEACHING.chart.example
    : undefined;
  if (chartExample) {
    lines.push('chart 示例（照此形状写，字段名不要改）：');
    lines.push(chartExample);
    lines.push('');
  }
  lines.push('</forms>');
  lines.push('');

  // —— 数据纪律：真实、复核、来源、口径 ——
  lines.push('<data-integrity>');
  lines.push(
    '- 组件里的每个数值都必须来自对话上下文、页面内容或工具返回结果，严禁编造；' +
      '无法确认的数据改用普通 Markdown 表格并注明来源；',
  );
  lines.push(
    '- 关键数字要复核：换一个独立来源（不同域名，或一手 vs 二手）再确认一次；' +
      '来源之间不一致时如实呈现分歧并降低置信度，不要挑一个数字当定论；',
  );
  lines.push(
    '- 敏感数据（账号、个人信息、内部指标、未公开数字）必须附来源：写进信封的 source 字段' +
      '或所在行的「来源」列，并在正文说明来源性质（一手 / 二手）；',
  );
  lines.push(
    '- 口径随数值走：标明单位与统计时点（如「2026 年 Q3」「截至 6 月 30 日」）；' +
      '确实拿不到的标「—」或「未获取」，不要用 0 代替；',
  );
  lines.push(
    '- 禁止在 JSON 中输出函数、注释、变量、表达式或 HTML 标签；' +
      '图表外观（颜色 / 坐标轴 / 图例）由界面按数据自动处理，不要书写；',
  );
  lines.push('</data-integrity>');
  lines.push('');

  // —— 关键见解拆解：长段落里的结论要能被逐条核对 ——
  if (selected.some(spec => spec.id === 'insight')) {
    lines.push('<insight-breakdown>');
    lines.push(
      '关键见解不要埋在长段落里：一条见解 = 一个可核对的断言，配它的证据数字、来源与置信度，' +
        '用 insight 组件逐条列出，正文只留导读与结论；证据互相矛盾时两条都列，并降低置信度。',
    );
    lines.push('</insight-breakdown>');
    lines.push('');
  }

  // —— 使用纪律 ——
  lines.push('<discipline>');
  lines.push('- 单条回复的组件总数不超过 3 个；先用简短文字给出结论，再附组件；');
  lines.push(
    '- 用户明确要求纯文本、Markdown 表格或指定格式时，以用户要求为准；' +
      '只有一两句话、单个数值或纯文字说明时不要用组件。',
  );
  lines.push('</discipline>');
  lines.push(`</${PROMPT_SECTION_TAG}>`);
  return lines.join('\n');
}
