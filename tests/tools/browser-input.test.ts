/**
 * browser_input 契约与行为测试。
 *
 * 覆盖本工具承担的核心契约（每一条都对应一次真实任务复盘中暴露的问题）：
 *   1. Schema：action 面与参数矩阵（text/path 二选一、asTsv/clear 的作用范围）；
 *   2. 参数校验：错误必须在**触碰浏览器与工作区之前**被拒，且错误码可定位；
 *   3. 剪贴板载荷组装：CSV → TSV 的转换是"表格整表粘贴"成立的前提；
 *   4. 审批门：读剪贴板属敏感读取，必须走 action 级人审门；
 *   5. 默认注入：browser_input 必须出现在会话核心工具面里（无条件在场）。
 */
import { browserInputTool } from '../../tools/browser/input-tool';
import { BROWSER_INPUT_TOOL_ID } from '../../tools/browser/input-contract';
import { parseCsv } from '../../utils/python-workspace/tabular';
import { CORE_SESSION_TOOL_IDS } from '../../utils/tools/tool-presets';
import { toolRegistry } from '../../tools/registry';

export async function testBrowserInput(
  check: (c: boolean, label: string, detail?: unknown) => void,
  eq: (a: unknown, b: unknown, label: string) => void,
) {
  const schema = browserInputTool.openaiSchema.function.parameters;
  const actionEnum = (schema.properties as any).action.enum as string[];

  // ── 1. Schema 契约 ────────────────────────────────────────────────
  eq(
    actionEnum.slice().sort(),
    ['clipboard_paste', 'clipboard_read', 'clipboard_write', 'keys', 'type'].sort(),
    'browser_input 的 action 面完整且可枚举',
  );
  check(
    (schema.required ?? []).includes('action') &&
      (schema.required ?? []).includes('description'),
    'action 与 description 为必填',
  );
  check(
    schema.additionalProperties === false,
    '拒绝未声明参数（防止跨 action 误传）',
  );
  const anyOf = (schema as any).anyOf as Array<{ properties: any; required?: string[] }>;
  const keysBranch = anyOf.find((b) => b.properties.action.enum[0] === 'keys');
  const typeBranch = anyOf.find((b) => b.properties.action.enum[0] === 'type');
  const writeBranch = anyOf.find((b) => b.properties.action.enum[0] === 'clipboard_write');
  const readBranch = anyOf.find((b) => b.properties.action.enum[0] === 'clipboard_read');
  check(!!keysBranch?.required?.includes('keys'), 'keys action 必带 keys');
  check(!!typeBranch?.required?.includes('text'), 'type action 必带 text');
  check(
    !writeBranch?.required?.includes('text') &&
      !writeBranch?.required?.includes('path'),
    'clipboard_write 的内容来源由 text/path 二选一表达（不强制其一）',
  );
  check(
    !readBranch?.required?.includes('text') &&
      !readBranch?.required?.includes('path'),
    'clipboard_read 不接受内容参数',
  );

  // ── 2. 默认注入与审批门 ───────────────────────────────────────────
  check(
    CORE_SESSION_TOOL_IDS.includes(BROWSER_INPUT_TOOL_ID),
    'browser_input 是会话无条件注入的核心工具',
  );
  check(
    !!toolRegistry.getTool(BROWSER_INPUT_TOOL_ID),
    'browser_input 在注册表中真实存在（提示词与工具面同源）',
  );
  eq(
    browserInputTool.metadata.requiresApprovalActions,
    ['clipboard_read'],
    '读剪贴板走 action 级人审门（可能取到用户复制的凭据）',
  );
  check(
    /clipboard/.test(browserInputTool.openaiSchema.function.description ?? ''),
    '工具描述显式说明剪贴板通道不经过页面 origin（与实现一致）',
  );
  check(
    /权限气泡/.test(browserInputTool.openaiSchema.function.description ?? ''),
    '工具描述点明浏览器级权限气泡不可观察这一关键事实',
  );

  // ── 3. CSV → TSV 转换（表格整表粘贴的前提） ───────────────────────
  const csv = '统计日期,商品ID,商品名称\n2026/11/16,990041250747,儒意美白保湿香氛\n';
  const table = parseCsv(csv);
  eq(table.headers, ['统计日期', '商品ID', '商品名称'], 'CSV 表头解析正确');
  const tsv = [table.headers.join('\t'), ...table.rows.map((row) => row.join('\t'))].join('\n');
  eq(
    tsv.split('\n')[1].split('\t').length,
    3,
    'TSV 行按制表符分列（粘贴进表格即按列展开）',
  );
  eq(
    tsv.split('\n')[0],
    '统计日期\t商品ID\t商品名称',
    'TSV 表头同样按制表符分隔',
  );

  // ── 4. 参数校验：错误在触碰浏览器前被拒 ───────────────────────────
  const savedChrome = globalThis.chrome;
  let browserTouched = false;
  try {
    globalThis.chrome = new Proxy(savedChrome ?? {}, {
      get(target, prop) {
        if (prop === 'tabs' || prop === 'scripting' || prop === 'debugger') {
          browserTouched = true;
        }
        return (target as any)[prop];
      },
    }) as any;
    const invalidCases: Array<[Record<string, unknown>, string]> = [
      [{ action: 'clipboard_write', description: 'x' }, '缺内容来源'],
      [
        { action: 'clipboard_write', description: 'x', text: 'a', path: 'b.csv' },
        'text 与 path 同时给出',
      ],
      [{ action: 'clipboard_read', description: 'x', text: 'a' }, '读动作不接受内容'],
      [{ action: 'keys', description: 'x' }, 'keys 缺 keys'],
      [{ action: 'type', description: 'x' }, 'type 缺 text'],
      [{ action: 'type', description: 'x', text: 'a', path: 'b.csv' }, 'type 不接受 path'],
      [{ action: 'unknown', description: 'x' }, '未知 action'],
      [{ action: 'keys', description: 'x', keys: ['a'], text: 'b' }, 'keys 不接受 text'],
    ];
    for (const [args, label] of invalidCases) {
      browserTouched = false;
      const result = await browserInputTool.execute(args as any);
      check(
        result.success === false,
        `非法参数被拒：${label}`,
      );
      check(
        result.data?.errorKind === 'INVALID_ARGUMENT',
        `非法参数归类为 INVALID_ARGUMENT：${label}`,
      );
      check(
        !browserTouched,
        `非法参数不触碰浏览器（不制造页面副作用）：${label}`,
      );
    }
    // 缺 description 同样被拒（每次调用必须说明意图）
    browserTouched = false;
    const noDescription = await browserInputTool.execute({
      action: 'clipboard_read',
    } as any);
    check(
      noDescription.success === false &&
        noDescription.data?.errorKind === 'INVALID_ARGUMENT',
      '缺 description 被拒',
    );
    check(!browserTouched, '缺 description 不触碰浏览器');
  } finally {
    globalThis.chrome = savedChrome;
  }
}
