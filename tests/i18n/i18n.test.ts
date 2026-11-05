/**
 * i18n 消息目录体检测试
 *
 * 覆盖三类**静默失败**（编译期不报错、运行时才暴露、且极易被忽略）：
 *
 *   1. 消息语法错误（vue-i18n 编译器不通过）
 *      - 未转义的 '@'：vue-i18n 把它当链接消息前缀，编译抛 SyntaxError；
 *      - 未转义的 '|'：复数分隔符；
 *      - 字面花括号：必须写成 {'{'} / {'}'}。
 *      这些错误只在**用到该条文案时**才抛，且被 utils/i18n 的 t() 兜底
 *      捕获后降级为原文案——控制台一条红字，界面显示未编译的原文，
 *      很容易被当成「本来就长这样」而长期存在。
 *
 *   2. 中英占位符不一致
 *      TS 的 Schema 类型只保证 **key 集合**对齐，不保证 {name} 对齐；
 *      英文漏写一个 {count} 会静默丢信息（渲染出字面量或空缺）。
 *
 *   3. 两份目录的 key 集合不一致（TS 已保证，这里做运行时冗余校验，
 *      防的是「绕过类型直接改目录」的情况）。
 *
 * 编译检查走**真实运行期路径**（vue-i18n 实例的 t()）——与界面渲染同一条
 * 链路，编译器怎么判就怎么判，不依赖编译器的内部错误通道形态。
 *
 * 运行：node tests/i18n/run.mjs   （或 npm run test:i18n）
 */

import { i18n } from '../../utils/i18n';
import zhCN from '../../utils/i18n/locales/zh-CN';
import en from '../../utils/i18n/locales/en';

// ==================== 极简断言 ====================

let passed = 0;
const failures: string[] = [];

function check(cond: boolean, label: string, extra?: unknown): void {
  if (cond) passed++;
  else failures.push(label + (extra !== undefined ? ` => ${JSON.stringify(extra)}` : ''));
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ==================== 目录遍历 ====================

/** 收集目录中全部叶子消息（点路径 → 文案） */
function collectLeaves(
  node: unknown,
  prefix = '',
  out = new Map<string, string>(),
): Map<string, string> {
  if (typeof node === 'string') {
    if (prefix) out.set(prefix, node);
    return out;
  }
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return out;
  for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
    collectLeaves(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

/**
 * 提取文案中的插值占位符名。
 * 形如 {'@'} 的字面量转义不是占位符，必须排除。
 */
function extractPlaceholders(message: string): Set<string> {
  const names = new Set<string>();
  for (const match of message.matchAll(/\{([^{}]*)\}/g)) {
    const raw = match[1];
    // 字面量转义：{'@'} / {'|'} / {'{'} / {'}'}
    if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) continue;
    if (!raw) continue;
    names.add(raw);
  }
  return names;
}

/** 目录 → 叶子消息表 */
function catalogOf(catalog: unknown): Map<string, string> {
  return collectLeaves(catalog);
}

// ==================== 用例 ====================

/**
 * 逐条走真实渲染链路：vue-i18n 实例的 t() 编译并渲染该条文案。
 * 编译器拒绝的消息会在这里抛错——与界面上的失败路径完全一致。
 */
function testMessageCompilation(): void {
  const catalogs: ReadonlyArray<[string, Map<string, string>]> = [
    ['zh-CN', catalogOf(zhCN)],
    ['en', catalogOf(en)],
  ];

  for (const [locale, leaves] of catalogs) {
    i18n.global.locale.value = locale as 'zh-CN' | 'en';
    for (const [path, message] of leaves) {
      let rendered = true;
      let detail = '';
      try {
        i18n.global.t(path);
      } catch (error) {
        rendered = false;
        detail = errText(error);
      }
      check(rendered, `[${locale}] 消息编译失败: ${path}`, detail || message);
    }
  }
  i18n.global.locale.value = 'zh-CN';
}

function testKeyParity(): void {
  const zh = catalogOf(zhCN);
  const enLeaves = catalogOf(en);
  const zhKeys = [...zh.keys()].sort();
  const enKeys = [...enLeaves.keys()].sort();

  const missingInEn = zhKeys.filter(key => !enLeaves.has(key));
  const missingInZh = enKeys.filter(key => !zh.has(key));
  check(missingInEn.length === 0, '英文目录缺少 key', missingInEn);
  check(missingInZh.length === 0, '中文目录缺少 key', missingInZh);
  check(zhKeys.length > 0, '中文目录非空');
  check(zhKeys.length === enKeys.length, '两份目录 key 数量一致', {
    zh: zhKeys.length,
    en: enKeys.length,
  });
}

function testPlaceholderParity(): void {
  const zh = catalogOf(zhCN);
  const enLeaves = catalogOf(en);

  for (const [path, zhMessage] of zh) {
    const enMessage = enLeaves.get(path);
    if (enMessage === undefined) continue; // 缺 key 已由 testKeyParity 报告
    const zhNames = [...extractPlaceholders(zhMessage)].sort();
    const enNames = [...extractPlaceholders(enMessage)].sort();
    check(
      zhNames.join(',') === enNames.join(','),
      `占位符不一致: ${path}`,
      { zh: zhNames, en: enNames },
    );
  }
}

/**
 * 已知危险字符的直检（不依赖编译器的具体行为，给出更直白的定位）。
 * '@' 必须是 {'@'} 转义形态；'|' 同理。
 */
function testUnescapedReservedChars(): void {
  const catalogs: ReadonlyArray<[string, Map<string, string>]> = [
    ['zh-CN', catalogOf(zhCN)],
    ['en', catalogOf(en)],
  ];
  for (const [locale, leaves] of catalogs) {
    for (const [path, message] of leaves) {
      // 去掉所有字面量转义后，剩下的 '@' / '|' 即为未转义的危险字符
      const stripped = message.replace(/\{'[^']*'\}/g, '');
      check(!stripped.includes('@'), `[${locale}] 未转义的 '@': ${path}`, message);
      check(!stripped.includes('|'), `[${locale}] 未转义的 '|': ${path}`, message);
    }
  }
}

// ==================== 运行 ====================

function main(): void {
  const suites: [string, () => void][] = [
    ['消息编译', testMessageCompilation],
    ['key 对齐', testKeyParity],
    ['占位符对齐', testPlaceholderParity],
    ['保留字符直检', testUnescapedReservedChars],
  ];

  for (const [name, run] of suites) {
    const before = failures.length;
    try {
      run();
    } catch (error) {
      failures.push(`[${name}] 抛出异常: ${errText(error)}`);
    }
    const delta = failures.length - before;
    console.log(`${delta === 0 ? '✓' : '✗'} ${name}`);
  }

  console.log(`\n通过 ${passed} 项断言，失败 ${failures.length} 项`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(failures.length ? 1 : 0);
}

main();
