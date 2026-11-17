/**
 * Python 依赖契约（单一事实源）
 *
 * ==================== 为什么独立成模块 ====================
 *
 * 「一个包能不能装上」这件事有三个互不相干的判据，此前散落在三处：
 *   1. 工具层（tools/python/python-run-tool.ts）：只知道 requirements 参数，
 *      不知道官方目录里有什么 → 只能在 worker 里跑完才炸；
 *   2. worker 层（utils/pyodide/python-script.ts）：拿得到官方目录，但只用于
 *      「自动加载 import 命中的目录包」，不判定用户显式声明的依赖；
 *   3. runner 层（utils/pyodide/workspace-script-runner.py）：真正装包、
 *      真正报错，但报的是 Python 侧的 ScriptDependencyError。
 *
 * 三处各自判一次，就会有「工具层放行 → worker 装不上 → runner 抛错」的
 * 迟到失败：模型拿到的是一段 Python traceback，而不是「哪个包不在目录、
 * 该传 dependencyMode="pypi" 还是换标准库」的可执行结论。
 *
 * 本模块把判据收敛成一份**纯函数**契约：给定（官方目录名集合、已安装包名集合、
 * 依赖声明列表、解析模式），回答「每个声明能否被满足、不能的话缺什么、
 * 下一步该做什么」。工具层据此**前置判定**（不等 worker 跑完），
 * worker 与 runner 复用同一套包名归一化口径（PEP 503），三处不再各判一次。
 *
 * ==================== 口径 ====================
 *
 * - 包名归一化一律走 PEP 503（`[-_.]+` → `-`、转小写）：官方目录里既有
 *   `python-dateutil` 也有 `astropy_iers_data`（下划线），模型却可能写成
 *   `python_dateutil` / `Astropy_Iers_Data`。不做归一化就会把「同一个包」
 *   判成两个，其中一个被误报为「不在官方目录」。
 * - 「官方目录」= Pyodide 锁文件里 package_type === 'package' 的条目
 *   （utils/pyodide/pyodide-runtime.ts 的 getPackageCatalog 是其 JS 侧实现）。
 * - 「已安装」= 已在解释器内可 import 的包（micropip 复用清单 + 官方目录自动
 *   加载的包）。已安装的包在 catalog 模式下同样满足声明——因为 runner 的
 *   `prepare_dependencies` 对 catalog 模式只做**版本校验**，不做安装。
 * - 版本约束（`>=1.2`）不在本模块判定：需要完整 PEP 440 比较器，交给 runner
 *   的 packaging 库处理。本模块只回答「这个包名在不在可用集合里」。
 *
 * ==================== 为什么不做“自动修正” ====================
 *
 * 本模块是**判定**层，不是**改写**层：它不替模型把 dependencyMode 悄悄改成
 * "pypi"（那会绕过用户审批），也不替模型删掉 requirements（那会静默丢依赖）。
 * 判定结论一律由工具层以可执行指引回传，模型自己决定下一步。
 */

/** 官方目录里可用的包（PEP 503 归一化后） */
export type CatalogPackageNames = ReadonlySet<string>;

/** 已在解释器内可用的包（PEP 503 归一化后） */
export type InstalledPackageNames = ReadonlySet<string>;

/** 依赖解析模式：catalog=官方目录（默认）；pypi=公开 PyPI（需用户审批） */
export type DependencyResolutionMode = 'catalog' | 'pypi';

/**
 * 单条依赖声明的判定结论。
 *
 * status 语义（互斥，覆盖声明的全部可能结局）：
 * - 'satisfied'      声明的包已可用（官方目录内或已安装）——catalog 模式即可满足；
 * - 'needs-pypi'     包不在官方目录、也未安装，但公开 PyPI 有纯 Python wheel
 *                    可装——需 dependencyMode="pypi"（触发用户审批）；
 * - 'unsatisfiable'  包既不在官方目录、也无从安装（含含 C 扩展的包、
 *                    拼写错误的包名）——只能换实现或换标准库。
 */
export type RequirementStatus = 'satisfied' | 'needs-pypi' | 'unsatisfiable';

/** 单条依赖声明的判定结果 */
export interface RequirementVerdict {
  /** 原始声明文本（回传给模型时用，保持与模型写法一致） */
  readonly declaration: string;
  /** PEP 503 归一化后的包名（空串表示声明本身无法解析） */
  readonly packageName: string;
  /** 判定结论 */
  readonly status: RequirementStatus;
  /** 无法解析声明的原因（status === 'unsatisfiable' 且包名为空时给出） */
  readonly reason?: string;
}

/**
 * 从 PEP 508 声明文本中取出包名。
 *
 * 只做**够用**的解析：取声明的名字部分——到版本约束（`>=`、`<`、`==`）、
 * extras（`[...]`）、environment marker（`;`）、直接 URL（`@`）之前为止。
 *
 * 合法性判定比「截一段前缀」严格：PEP 508 的名字部分只能由字母数字、
 * 连字符、下划线、点组成，且**不得含空格**。因此 `not a valid requirement!!`
 * 这类自由文本必须判为「无法解析」（返回空串），而不是截出 `not` 当成包名
 * ——截前缀会把明显的笔误变成一个看似合法的包名，模型据此以为要装 `not`，
 * 反而更难自纠。
 *
 * 刻意不实现完整 PEP 508：完整解析需要 packaging 库（Python 侧才有），
 * 而本模块要能在浏览器工具层同步使用。解析不出来时返回空串——调用方据此
 * 走「无法解析 → 交给 runner 判定」的路径，绝不猜。
 *
 * @param declaration 依赖声明文本，如 `pypdf>=5`、`requests[security]`
 * @returns PEP 503 归一化后的包名；无法解析时返回空串
 */
export function normalizeRequirementName(declaration: string): string {
  const text = declaration.trim();
  if (!text) return '';
  // 直接 URL / VCS 引用（`name @ url`）：包名仍可取，但这类声明本工具层
  // 无法判定可安装性，交由 runner 报错（runner 对 URL 声明有专门诊断）。
  const atIndex = text.indexOf('@');
  const head = atIndex === -1 ? text : text.slice(0, atIndex);
  // 名字部分：到 extras / 版本约束 / marker 为止（空白也是分隔符：
  // `pypdf >= 5` 是合法写法，不能因空格判为非法声明）
  const nameMatch = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(head);
  if (!nameMatch) return '';
  const namePart = nameMatch[0];
  // 名字之后若还有残余内容，必须是合法的 PEP 508 续写：版本约束、extras、
  // environment marker 三者之一。否则整条声明是自由文本（如
  // `not a valid requirement!!`）——截出 `not` 反而会把它伪装成一个看似
  // 合法的包名，让模型误以为要装 `not`，比直接判为非法更难自纠。
  const rest = head.slice(namePart.length).trim();
  if (rest && !/^[[(]/.test(rest) && !/^[<>=!~]/.test(rest) && !/^;/.test(rest)) {
    return '';
  }
  return normalizePackageName(namePart);
}

/**
 * PEP 503 包名归一化：转小写，`[-_.]+` 折叠为单个 `-`。
 *
 * 官方目录与模型声明两侧都走这一个函数——归一化口径不一致会把同一个包
 * 判成两个（其中一个被误报「不在官方目录」）。
 */
export function normalizePackageName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * 判定一批依赖声明能否被满足。
 *
 * @param declarations 模型传入的 requirements 列表（原始文本）
 * @param options    可用包集合与解析模式
 * @returns 每条声明一条结论，顺序与输入一致
 */
export function evaluateRequirements(
  declarations: readonly string[],
  options: {
    /** 官方目录内的包名（PEP 503 归一化后） */
    readonly catalog: CatalogPackageNames;
    /** 已安装可用的包名（PEP 503 归一化后） */
    readonly installed: InstalledPackageNames;
    /** 当前解析模式 */
    readonly mode: DependencyResolutionMode;
  },
): RequirementVerdict[] {
  return declarations.map((declaration) => {
    const packageName = normalizeRequirementName(declaration);
    if (!packageName) {
      return {
        declaration,
        packageName: '',
        status: 'unsatisfiable',
        reason:
          '依赖声明无法解析（只接受 PEP 508 包名 + 版本约束，如 "pypdf>=5"；' +
          '不接受 URL、索引地址或 VCS 引用）',
      };
    }
    if (options.mode === 'pypi') {
      // pypi 模式由 runner 的 micropip 实际解析，本层不预判可安装性
      // （含 C 扩展的 wheel 装不上，只有 runner 能给出准确诊断）。
      return { declaration, packageName, status: 'needs-pypi' };
    }
    if (options.catalog.has(packageName) || options.installed.has(packageName)) {
      return { declaration, packageName, status: 'satisfied' };
    }
    return { declaration, packageName, status: 'needs-pypi' };
  });
}

/** 判定结论的汇总视图 */
export interface RequirementSummary {
  /** 全部声明都已满足 */
  readonly allSatisfied: boolean;
  /** 需要 pypi 解析才能满足的声明（catalog 模式下即「装不上的包」） */
  readonly needsPypi: readonly RequirementVerdict[];
  /** 连 pypi 路径都走不通的声明（声明本身无法解析） */
  readonly unsatisfiable: readonly RequirementVerdict[];
  /** 已满足的声明 */
  readonly satisfied: readonly RequirementVerdict[];
}

/** 汇总判定结论 */
export function summarizeRequirements(
  verdicts: readonly RequirementVerdict[],
): RequirementSummary {
  const satisfied: RequirementVerdict[] = [];
  const needsPypi: RequirementVerdict[] = [];
  const unsatisfiable: RequirementVerdict[] = [];
  for (const verdict of verdicts) {
    if (verdict.status === 'satisfied') satisfied.push(verdict);
    else if (verdict.status === 'needs-pypi') needsPypi.push(verdict);
    else unsatisfiable.push(verdict);
  }
  return {
    allSatisfied: satisfied.length === verdicts.length,
    needsPypi,
    unsatisfiable,
    satisfied,
  };
}

/**
 * 把判定结论渲染成模型可直接照做的下一步指引。
 *
 * 措辞原则：
 *   - **说出具体声明 + 具体参数**，不给「请检查依赖」这类无动作指引；
 *   - 回显**模型写下的原始声明**（含版本约束），不是截短的包名——指引要求
 *     「保留 requirements」，自己却把 `pypdf>=5` 写成 `pypdf`，模型照抄就会
 *     丢掉版本约束；
 *   - 声明去重：同一声明出现多次只提示一次；
 *   - 三条路径按「改动量从小到大」排列，让模型优先选代价最低的。
 */
export function renderRequirementGuidance(summary: RequirementSummary): string {
  if (summary.allSatisfied) return '';
  const unique = (items: readonly RequirementVerdict[]): string[] =>
    [...new Set(items.map((item) => item.declaration))];
  const quoted = (items: readonly string[]): string =>
    `[${items.map((text) => JSON.stringify(text)).join(', ')}]`;
  const lines: string[] = ['[依赖契约判定]'];
  if (summary.satisfied.length) {
    lines.push(
      `已在官方目录或已安装，无需声明：${unique(summary.satisfied).join('、')}` +
      '（脚本里直接 import 即可——官方目录内按 import 自动加载，已安装的直接可用）',
    );
  }
  if (summary.needsPypi.length) {
    const declarations = unique(summary.needsPypi);
    lines.push(
      `不在官方目录内，需从公开 PyPI 安装：${declarations.join('、')} —— ` +
      `requirements=${quoted(declarations)} 并同时传 dependencyMode="pypi"` +
      '（会请求用户审批；仅纯 Python wheel 可装，含 C 扩展的包只能改用官方目录内的版本或自备兼容 .whl 走 wheels 参数）',
    );
  }
  for (const item of summary.unsatisfiable) {
    lines.push(
      `无法解析的依赖声明：${JSON.stringify(item.declaration)}` +
      (item.reason ? `（${item.reason}）` : '') +
      ' —— 改用 PEP 508 写法：包名 + 可选版本约束（如 "pypdf>=5"）',
    );
  }
  lines.push(
    '装不上的包不要反复重试同一条命令：换官方目录内的包、换标准库（csv/json/xml/zipfile）等价实现，或改用专用工具产出交付物。',
  );
  return lines.join('\n');
}
