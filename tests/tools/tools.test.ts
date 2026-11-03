/**
 * 工具领域单元测试
 *
 * 覆盖：
 *   1. 注册契约：全量注册无重名、分类桶与 Map 一致、metadata/名称/Schema 三对齐
 *   2. 场景预设对齐：tool-presets 每个场景的工具 ID 必须真实注册（防下线残留）
 *   3. 测试面板目录对齐：tool-definitions 静态目录里的工具必须真实注册
 *   4. 文档防漂移：TOOL_REGISTRATION_STATUS.md 分类表的名称、数量、总数与注册表一致
 *   5. 命名常量对齐：TOOL_NAMES 每个规范名必须指向已注册工具或内联处理消息
 *   6. 数据暂存区：JSON 校验先于容量淘汰（非法数据不得误删旧批次）、形态分析、
 *      合并/删除、不可序列化值报错、超限拒绝
 *   7. 可交互元素获取工具宿主：分页越界回退、过滤命中统计与提示、缓存命中与
 *      失效、参数类型防御、受限页/空白页拦截、payload 错误透传、
 *      Markdown 反引号转义
 *   8. 注入荷载真实行为：源码在干净作用域求值（验证序列化自包含）+ jsdom DOM——
 *      buttons/inputs 两模式采集与评分、regex 命中置顶、容器级 xpath 祖先链、
 *      遮挡剔除、非法过滤条件的模式化报错、enhance 点击/填充与遮挡/未命中报错
 *   9. browser_page_exec 数据通道：超 2000 字符自动暂存（阈值边界 2000/2001）、
 *      前 2000 字符预览封装、saveResult 显式强制暂存、readRef 分页读取
 *      （首页/续读/尾页/越界收敛/limit 收敛/无标签页）、参数与模式互斥防御、
 *      捕获/暂存失败的有界降级与告警
 *
 * 运行：node tests/tools/run.mjs   （或 npm run test:tools）
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

// ==================== 极简断言 ====================

let passed = 0;
const failures: string[] = [];

function check(cond: boolean, label: string, extra?: unknown): void {
  if (cond) passed++;
  else failures.push(label + (extra !== undefined ? ` => ${JSON.stringify(extra)}` : ''));
}

function eq(actual: unknown, expected: unknown, label: string, extra?: unknown): void {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    extra !== undefined ? extra : { actual, expected },
  );
}

// ==================== 扩展 API 全局桩 ====================
// 必须先于任何应用模块求值安装。ESM 静态 import 会被提升到顶部，
// 因此所有应用模块一律通过下方的动态 import 在桩安装完成后加载。

const memoryLocal = new Map<string, unknown>();
const memorySession = new Map<string, unknown>();

function createStorageArea(memory: Map<string, unknown>) {
  return {
    async get(keys: unknown): Promise<Record<string, unknown>> {
      const out: Record<string, unknown> = {};
      if (keys === null || keys === undefined) {
        for (const [k, v] of memory) out[k] = structuredClone(v);
        return out;
      }
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) {
        if (typeof key === 'string' && memory.has(key)) {
          out[key] = structuredClone(memory.get(key));
        }
      }
      return out;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      for (const [k, v] of Object.entries(items)) memory.set(k, structuredClone(v));
    },
    async remove(keys: unknown): Promise<void> {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) {
        if (typeof key === 'string') memory.delete(key);
      }
    },
    async clear(): Promise<void> {
      memory.clear();
    },
  };
}

/** 可按测试用例覆盖的标签页状态 */
interface TabStubState {
  tabs: Array<{ id?: number; url?: string; status?: string; windowId?: number }>;
  /** chrome.scripting.executeScript 的注入结果（按调用类型自动分流） */
  payloadResults: unknown[];
  /** 注入调用抛出的异常（模拟注入失败） */
  payloadThrow: unknown;
  /** 指纹调用返回值（getPageFingerprint 路径） */
  fingerprintValue: string;
  /** 记录 payload 注入调用次数（缓存命中断言用） */
  payloadCallCount: number;
}

const tabStub: TabStubState = {
  tabs: [{ id: 1, url: 'https://example.com/', status: 'complete', windowId: 1 }],
  payloadResults: [],
  payloadThrow: null,
  fingerprintValue: 'complete|50|800',
  payloadCallCount: 0,
};

function resetTabStub(): void {
  tabStub.tabs = [{ id: 1, url: 'https://example.com/', status: 'complete', windowId: 1 }];
  tabStub.payloadResults = [];
  tabStub.payloadThrow = null;
  tabStub.fingerprintValue = 'complete|50|800';
  tabStub.payloadCallCount = 0;
}

function installGlobalStubs(): void {
  const stub: Record<string, unknown> = {};
  stub.runtime = {
    id: 'agentnexus-test',
    getManifest: () => ({ manifest_version: 3, name: 'test' }),
    onMessage: { addListener: () => undefined },
    onInstalled: { addListener: () => undefined },
    onConnect: { addListener: () => undefined },
    sendMessage: async () => undefined,
  };
  stub.storage = {
    local: createStorageArea(memoryLocal),
    session: createStorageArea(memorySession),
    managed: createStorageArea(new Map()),
    onChanged: { addListener: () => undefined },
  };
  stub.tabs = {
    query: async () => tabStub.tabs.map(t => ({ ...t })),
    get: async (tabId: number) => {
      const found = tabStub.tabs.find(t => t.id === tabId);
      if (!found) throw new Error(`No tab with id: ${tabId}.`);
      return { ...found };
    },
    reload: async () => undefined,
    sendMessage: async () => undefined,
    create: async () => ({ id: 99, url: 'about:blank' }),
    update: async () => ({ id: 1, url: 'https://example.com/' }),
    remove: async () => undefined,
    setZoom: async () => undefined,
  };
  stub.scripting = {
    executeScript: async (options: { args?: unknown[] }) => {
      const args = options?.args ?? [];
      // 指纹调用（getPageFingerprint）：func 无参数；采集调用首参为扫描模式
      if (args.length === 0) {
        return [{ frameId: 0, result: tabStub.fingerprintValue }];
      }
      tabStub.payloadCallCount++;
      if (tabStub.payloadThrow) throw tabStub.payloadThrow;
      return tabStub.payloadResults;
    },
  };
  stub.debugger = undefined;
  stub.downloads = {
    query: async () => [],
    download: async () => 1,
    onChanged: { addListener: () => undefined },
  };
  stub.permissions = { contains: async () => true, request: async () => true };
  stub.windows = { getAll: async () => ({ id: 1, state: 'normal' }) };

  (globalThis as Record<string, unknown>).chrome = stub;
  // WXT 自动导入的 browser 别名：部分模块按扩展环境引用，桩等同 chrome
  (globalThis as Record<string, unknown>).browser = stub;
}

installGlobalStubs();

// ==================== 动态加载被测模块 ====================

const { toolRegistry, registerAllTools } = await import('../../tools/index');
const { TOOL_NAMES } = await import('../../common/constants');
const { SCENARIO_PRESETS, CORE_PAGE_TOOL_IDS } = await import('../../utils/tools/tool-presets');
const { categories: catalogCategories } = await import(
  '../../entrypoints/sidepanel/components/tool/tool-definitions'
);
const { dataRefStore } = await import('../../utils/data-ref-store');
const { InteractiveButtonGetterTool } = await import(
  '../../tools/automation/interactive-button-getter'
);
const { InteractiveInputGetterTool } = await import(
  '../../tools/automation/interactive-input-getter'
);

// ==================== 1. 注册契约 ====================

registerAllTools();

{
  const tools = toolRegistry.getAll();
  const stats = toolRegistry.getStats();

  check(tools.length > 0, 'registerAllTools 注册了工具', tools.length);

  // 无重名（Map 键唯一）+ 分类桶引用总数与 Map 一致（防同名工具重复入桶）
  const names = tools.map(t => t.name);
  eq(new Set(names).size, names.length, '注册表无重名工具');
  const bucketTotal = Object.values(stats.categories).reduce((sum, n) => sum + n, 0);
  eq(bucketTotal, tools.length, '分类桶工具数总和 = 注册表工具总数');
  eq(stats.totalTools, tools.length, '统计 totalTools 与实际一致');
  eq(new Set(toolRegistry.getToolIds()).size, tools.length, 'getToolIds 唯一');

  // 重复注册幂等性：同一实例再注册不得改变桶计数
  const before = toolRegistry.getStats().totalTools;
  if (tools.length > 0) {
    toolRegistry.register(tools[0]);
    eq(toolRegistry.getStats().totalTools, before, '同一实例重复注册为幂等操作');
    const bucketAfter = toolRegistry.getStats();
    const totalAfter = Object.values(bucketAfter.categories).reduce((s, n) => s + n, 0);
    eq(totalAfter, tools.length, '重复注册后分类桶不产生重复项');
  }

  for (const tool of tools) {
    const label = `工具 ${tool.name}`;
    check(typeof tool.name === 'string' && tool.name.length > 0, `${label}: name 非空`);
    check(!!tool.metadata, `${label}: metadata 存在`);
    eq(tool.metadata?.name, tool.name, `${label}: metadata.name === name`);
    check(!!tool.metadata?.category, `${label}: metadata.category 非空`);
    check(!!tool.metadata?.version, `${label}: metadata.version 非空`);
    check(!!tool.metadata?.description, `${label}: metadata.description 非空`);

    const schema = tool.openaiSchema;
    check(!!schema && schema.type === 'function', `${label}: openaiSchema.type === 'function'`);
    eq(schema?.function?.name, tool.name, `${label}: schema.function.name === name`);
    check(
      typeof schema?.function?.description === 'string' && schema.function.description.length > 0,
      `${label}: schema 描述非空`,
    );
    eq(schema?.function?.parameters?.type, 'object', `${label}: 参数容器为 object`);
  }

  console.log(
    `[注册表] 共 ${tools.length} 个工具，按 metadata.category 分组：\n` +
      Object.keys(stats.categories)
        .sort((a, b) => a.localeCompare(b))
        .map(cat => {
          const names = toolRegistry
            .getByCategory(cat)
            .map(t => t.name)
            .sort((a, b) => a.localeCompare(b));
          return `  ${cat} (${names.length}): ${names.join(' ')}`;
        })
        .join('\n'),
  );
}

// ==================== 2. 场景预设对齐 ====================

{
  const registered = new Set(toolRegistry.getToolIds());
  for (const [scenario, ids] of Object.entries(SCENARIO_PRESETS)) {
    check(Array.isArray(ids) && ids.length > 0, `场景 ${scenario} 非空`);
    const seen = new Set<string>();
    for (const id of ids as string[]) {
      check(registered.has(id), `场景 ${scenario} 的工具 ${id} 已注册`);
      check(!seen.has(id), `场景 ${scenario} 无重复工具 ${id}`);
      seen.add(id);
    }
  }
  for (const id of CORE_PAGE_TOOL_IDS) {
    check(registered.has(id), `核心页面工具 ${id} 已注册`);
  }
}

// ==================== 3. 测试面板目录对齐 ====================

{
  const registered = new Set(toolRegistry.getToolIds());
  const catalogNames = new Set<string>();
  for (const category of catalogCategories) {
    check(!!category.id && !!category.name, `目录分类 ${category.id ?? '?'} 有 id/name`);
    for (const tool of category.tools) {
      check(
        registered.has(tool.name),
        `目录工具 ${tool.name}（分类 ${category.id}）已注册`,
      );
      check(!catalogNames.has(tool.name), `目录工具 ${tool.name} 未在多个分类中重复登记`);
      catalogNames.add(tool.name);
      if (tool.version !== undefined) {
        check(/^\d+\.\d+\.\d+$/.test(tool.version), `目录工具 ${tool.name} 版本号格式`, tool.version);
      }
    }
  }
}

// ==================== 4. 文档防漂移（TOOL_REGISTRATION_STATUS.md） ====================

{
  const docPath = path.join(process.cwd(), 'tools', 'TOOL_REGISTRATION_STATUS.md');
  const doc = readFileSync(docPath, 'utf8');
  const registered = new Set(toolRegistry.getToolIds());
  const registryCategories = Object.keys(toolRegistry.getStats().categories);

  const rowRegex = /^\| ([A-Za-z][\w-]*) \| (\d+) \| (.+?) \|\s*$/gm;
  const docCategories = new Map<string, { count: number; names: string[] }>();
  let match: RegExpExecArray | null;
  while ((match = rowRegex.exec(doc)) !== null) {
    const [, category, countText, cell] = match;
    const names = Array.from(cell.matchAll(/`([^`]+)`/g), m => m[1]);
    docCategories.set(category, { count: Number(countText), names });
  }

  check(docCategories.size > 0, '文档分类表可被解析');

  let docTotal = 0;
  for (const [category, row] of docCategories) {
    eq(row.count, row.names.length, `文档 ${category} 行的数量与名称数一致`);
    docTotal += row.count;
    for (const name of row.names) {
      check(registered.has(name), `文档 ${category} 行的工具 ${name} 已注册`);
    }
  }

  // 分类集合双向一致（注册表新增分类而文档漏登记 = 失败）
  for (const category of registryCategories) {
    check(docCategories.has(category), `注册表分类 ${category} 在文档中有对应行`);
  }
  for (const category of docCategories.keys()) {
    check(registryCategories.includes(category), `文档分类 ${category} 在注册表中真实存在`);
  }

  // 每行数量与注册表该分类实际数量一致
  const stats = toolRegistry.getStats().categories;
  for (const [category, row] of docCategories) {
    if (stats[category] !== undefined) {
      eq(row.count, stats[category], `文档 ${category} 行数量与注册表一致`);
    }
  }

  const headerMatch = doc.match(/共 (\d+) 个/);
  check(!!headerMatch, '文档含工具总数声明');
  if (headerMatch) {
    eq(Number(headerMatch[1]), docTotal, '文档总数声明 = 各分类数量之和');
    eq(docTotal, toolRegistry.getAll().length, '文档总数 = 注册表实际总数');
  }
}

// ==================== 5. TOOL_NAMES 规范名对齐 ====================

{
  const registered = new Set(toolRegistry.getToolIds());
  // browser_refresh / browser_set_zoom 没有注册工具，由 tools-manager-listener 内联处理
  const inlineHandled = new Set(['browser_refresh', 'browser_set_zoom']);
  for (const [key, value] of Object.entries(TOOL_NAMES.BROWSER)) {
    check(
      registered.has(value) || inlineHandled.has(value),
      `TOOL_NAMES.BROWSER.${key}（${value}）指向已注册工具或内联处理消息`,
    );
  }
}

// ==================== 6. 数据暂存区行为 ====================

{
  const MB = 1024 * 1024;

  // 形态分析：对象数组
  const records = await dataRefStore.save(
    [
      { name: '甲', price: 1, tags: ['a'] },
      { name: '乙', price: 2 },
    ],
    '样本',
  );
  check(records.ok, '保存对象数组成功');
  if (records.ok) {
    eq(records.meta.kind, 'records', '对象数组识别为 records');
    eq(records.meta.rowCount, 2, 'records 行数');
    eq(records.meta.fields, ['name', 'price', 'tags'], 'records 字段并集按首见顺序');
    eq(records.meta.label, '样本', '标签透传');
    check(typeof records.meta.preview === 'string' && records.meta.preview.length > 0, 'records 预览存在');
  }

  // 形态分析：二维数组
  const matrix = await dataRefStore.save([[1, 2], [3, 4], [5, 6]]);
  check(matrix.ok, '保存二维数组成功');
  if (matrix.ok) {
    eq(matrix.meta.kind, 'matrix', '二维数组识别为 matrix');
    eq(matrix.meta.rowCount, 3, 'matrix 行数');
    eq(matrix.meta.cols, 2, 'matrix 列数');
  }

  // 非法 JSON：拒绝且不产生任何副作用
  const bad = await dataRefStore.saveJson('{not-json');
  check(!bad.ok, '非法 JSON 被拒绝');
  if (!bad.ok) check(bad.reason.includes('不是合法 JSON'), '非法 JSON 错误可读', bad.reason);

  // 不可序列化值（顶层函数）：如实报错而非静默存 null
  const fn = await dataRefStore.save(() => 1);
  check(!fn.ok, '顶层函数值被拒绝');
  if (!fn.ok) check(fn.reason.includes('没有 JSON 形态'), '函数值错误信息可读', fn.reason);

  // undefined：明确提示
  const undef = await dataRefStore.save(undefined);
  check(!undef.ok, 'undefined 被拒绝');

  // —— 回归守卫：容量淘汰必须发生在 JSON 校验成功之后 ——
  // 先落一条 ~5MB 的有效批次，再提交一条 ~5MB 的非法 JSON：
  // 若先淘汰后校验，旧批次会被这条最终被拒绝的数据误删
  await dataRefStore.remove('all');
  const bigValid = JSON.stringify({ data: 'x'.repeat(5 * MB) });
  const savedBig = await dataRefStore.saveJson(bigValid, '大批次');
  check(savedBig.ok, '5MB 有效批次保存成功');
  const bigInvalid = `{"broken": "${'y'.repeat(5 * MB)}`;
  const rejectedBig = await dataRefStore.saveJson(bigInvalid, '坏批次');
  check(!rejectedBig.ok, '5MB 非法 JSON 被拒绝');
  const listAfter = await dataRefStore.list();
  check(
    listAfter.some(m => m.label === '大批次'),
    '非法大 JSON 不得误删已存批次（淘汰在解析成功之后）',
    listAfter.map(m => m.label),
  );

  // 容量守卫：总容量 8MB，超出时淘汰最旧批次
  const anotherBig = JSON.stringify({ data: 'z'.repeat(5 * MB) });
  const savedAnother = await dataRefStore.saveJson(anotherBig, '新大批次');
  check(savedAnother.ok, '容量守卫下新批次仍能写入');
  const listAfterEvict = await dataRefStore.list();
  check(
    !listAfterEvict.some(m => m.label === '大批次') &&
      listAfterEvict.some(m => m.label === '新大批次'),
    '超容量时按最旧淘汰（旧的大批次被顶掉）',
    listAfterEvict.map(m => m.label),
  );

  // 单条目超限：拒绝
  await dataRefStore.remove('all');
  const tooBig = await dataRefStore.saveJson(`{"d":"${'x'.repeat(8 * MB + 64)}"}`);
  check(!tooBig.ok, '超过单条目上限被拒绝');
  if (!tooBig.ok) check(tooBig.reason.includes('超过暂存上限'), '超限错误可读', tooBig.reason);

  // 合并：records + records 按序拼接
  await dataRefStore.remove('all');
  const b1 = await dataRefStore.save([{ id: 1 }], '页1');
  const b2 = await dataRefStore.save([{ id: 2 }], '页2');
  check(b1.ok && b2.ok, '两批数据保存成功');
  if (b1.ok && b2.ok) {
    const merged = await dataRefStore.merge([b1.meta.id, b2.meta.id], '全部');
    check(merged.ok, '合并成功');
    if (merged.ok) {
      eq(merged.meta.kind, 'records', '合并结果为 records');
      eq(merged.meta.rowCount, 2, '合并行数为两批之和');
    }
    const missing = await dataRefStore.merge(['zzzzzzzz']);
    check(!missing.ok, '合并不存在的引用被拒绝');
    if (!missing.ok) check(missing.reason.includes('不存在或已过期'), '缺失引用错误可读', missing.reason);
  }

  // 形态混用合并被拒绝
  const r1 = await dataRefStore.save([{ a: 1 }]);
  const r2 = await dataRefStore.save([[1, 2]]);
  if (r1.ok && r2.ok) {
    const mixed = await dataRefStore.merge([r1.meta.id, r2.meta.id]);
    check(!mixed.ok, 'records 与 matrix 混合合并被拒绝');
    if (!mixed.ok) check(mixed.reason.includes('形态不一致'), '混合合并错误可读', mixed.reason);
  }

  // 删除：单个 / 全部
  const beforeDelete = (await dataRefStore.list()).length;
  const delAll = await dataRefStore.remove('all');
  eq(delAll, beforeDelete, 'delete all 清空并返回数量');
  eq((await dataRefStore.list()).length, 0, '清空后列表为空');
}

// ==================== 7. 可交互元素获取工具宿主 ====================

type AnyRecord = Record<string, any>;

function makeElements(count: number, overrides: Partial<AnyRecord> = {}): AnyRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'button',
    description: `按钮 ${i + 1}`,
    selector: `#btn-${i + 1}`,
    score: 100 - i,
    matchedRegex: null,
    matchedXpath: null,
    isHit: false,
    ...overrides,
  }));
}

function dataOf(result: { data?: AnyRecord }): AnyRecord {
  return (result.data ?? {}) as AnyRecord;
}

{
  // —— 基础采集 + 缓存命中 ——
  resetTabStub();
  tabStub.payloadResults = [
    {
      frameId: 0,
      result: {
        elements: makeElements(2),
        fingerprint: tabStub.fingerprintValue,
      },
    },
  ];
  const buttonTool = new InteractiveButtonGetterTool();
  const first = await buttonTool.execute({});
  check(first.success, '按钮采集成功');
  const firstData = dataOf(first);
  eq(firstData.totalElements, 2, '总元素数 = 2');
  eq(firstData.page, 1, '默认第 1 页');
  eq(firstData.cached, false, '首次采集不命中缓存');
  eq(tabStub.payloadCallCount, 1, '首次采集发生了一次注入');

  const second = await buttonTool.execute({});
  const secondData = dataOf(second);
  eq(secondData.cached, true, '指纹一致时命中缓存');
  eq(tabStub.payloadCallCount, 1, '缓存命中不触发新的采集注入');

  // —— 不同过滤条件互不共享缓存 ——
  await buttonTool.execute({ regex: '提交' });
  eq(tabStub.payloadCallCount, 2, '过滤条件变化后重新采集');

  // —— 分页越界回退 + 提示 ——
  const paged = await buttonTool.execute({ page: 99 });
  const pData = dataOf(paged);
  eq(pData.page, 1, '越界页码回退到最后一页');
  eq(pData.totalPages, 1, '2 个元素只有 1 页');
  check(typeof pData.hint === 'string' && pData.hint.includes('超出范围'), '越界给出回退提示', pData.hint);

  // —— 参数类型防御 ——
  const badRegex = await buttonTool.execute({ regex: 123 as unknown as string });
  check(!badRegex.success, '非字符串 regex 被拒绝');
  check(
    typeof badRegex.error === 'string' && badRegex.error.includes('regex 必须是字符串'),
    'regex 类型错误信息可读',
    badRegex.error,
  );
  const badXpath = await buttonTool.execute({ xpath: {} as unknown as string });
  check(!badXpath.success, '非字符串 xpath 被拒绝');
  const badPage = await buttonTool.execute({ page: 'abc' as unknown as number });
  check(badPage.success, '非法 page 回落默认值而不是报错');
  eq(dataOf(badPage).page, 1, '非法 page 归一为 1');
  check(
    typeof dataOf(badPage).hint === 'string' && dataOf(badPage).hint.includes('无法解析'),
    '非法 page 给出可感知提示',
    dataOf(badPage).hint,
  );

  // 参数整体为 null（executeTool 对缺失参数透传 null）：按空参数处理而不是抛异常
  const nullArgs = await buttonTool.execute(null as unknown as { regex?: string });
  check(nullArgs.success, '整体 null 参数按空参数处理');
  eq(dataOf(nullArgs).page, 1, 'null 参数归一到第 1 页');

  // —— 过滤命中统计与提示 ——
  resetTabStub();
  tabStub.tabs = [{ id: 2, url: 'https://filtered.example/', status: 'complete', windowId: 1 }];
  tabStub.payloadResults = [
    {
      frameId: 0,
      result: {
        elements: [
          { ...makeElements(1)[0], isHit: true, matchedRegex: true, matchedXpath: null, description: '登录' },
          ...makeElements(2),
        ],
        fingerprint: tabStub.fingerprintValue,
      },
    },
  ];
  const filteredTool = new InteractiveButtonGetterTool();
  const filtered = await filteredTool.execute({ regex: '登录' });
  const fData = dataOf(filtered);
  eq(fData.filtered, true, '启用过滤后 filtered = true');
  eq(fData.totalHits, 1, '命中数统计正确');
  check(typeof fData.hint === 'string' && fData.hint.includes('命中 1 个'), '命中提示存在', fData.hint);
  check(String(fData.elements).includes('✓ regex'), 'Markdown 中标记命中的 ✓ regex');

  // 零命中提示
  resetTabStub();
  tabStub.tabs = [{ id: 3, url: 'https://nohit.example/', status: 'complete', windowId: 1 }];
  tabStub.payloadResults = [
    { frameId: 0, result: { elements: makeElements(3), fingerprint: tabStub.fingerprintValue } },
  ];
  const noHitTool = new InteractiveButtonGetterTool();
  const noHit = await noHitTool.execute({ regex: '不存在的关键词zzz' });
  const noHitData = dataOf(noHit);
  eq(noHitData.totalHits, 0, '零命中统计');
  check(
    typeof noHitData.hint === 'string' && noHitData.hint.includes('没有任何元素命中过滤条件'),
    '零命中给出放宽条件提示',
    noHitData.hint,
  );
  check(String(noHitData.elements).includes('按钮 1'), '零命中仍返回全部元素');

  // —— Markdown 反引号转义（选择器含 ` 时不得破坏 code span）——
  resetTabStub();
  tabStub.tabs = [{ id: 4, url: 'https://ticks.example/', status: 'complete', windowId: 1 }];
  tabStub.payloadResults = [
    {
      frameId: 0,
      result: {
        elements: [{ ...makeElements(1)[0], selector: 'div[data-x=`y`]' }],
        fingerprint: tabStub.fingerprintValue,
      },
    },
  ];
  const tickTool = new InteractiveButtonGetterTool();
  const tickResult = await tickTool.execute({});
  const tickMarkdown = String(dataOf(tickResult).elements);
  check(
    !tickMarkdown.includes('`y`') && tickMarkdown.includes("div[data-x='y']"),
    '选择器中的反引号被替换，code span 不被破坏',
    tickMarkdown,
  );

  // —— payload 错误透传（非法 regex 的页面内编译错误）——
  resetTabStub();
  tabStub.tabs = [{ id: 5, url: 'https://err.example/', status: 'complete', windowId: 1 }];
  tabStub.payloadResults = [
    {
      frameId: 0,
      result: {
        elements: [],
        fingerprint: tabStub.fingerprintValue,
        error: 'regex 参数不是合法的 JavaScript 正则表达式：Invalid regular expression',
      },
    },
  ];
  const payloadErrTool = new InteractiveButtonGetterTool();
  const payloadErr = await payloadErrTool.execute({ regex: '(' });
  check(!payloadErr.success, 'payload 错误导致失败结果');
  check(
    typeof payloadErr.error === 'string' && payloadErr.error.includes('不是合法的 JavaScript 正则表达式'),
    'payload 错误原文透传',
    payloadErr.error,
  );

  // —— 注入异常 → 带工具名的可读错误 ——
  resetTabStub();
  tabStub.tabs = [{ id: 6, url: 'https://boom.example/', status: 'complete', windowId: 1 }];
  tabStub.payloadThrow = new Error('boom');
  const throwTool = new InteractiveButtonGetterTool();
  const thrown = await throwTool.execute({});
  check(!thrown.success, '注入异常转为失败结果而不是抛出');
  check(
    typeof thrown.error === 'string' && thrown.error.includes('获取可交互按钮元素失败'),
    '按钮工具错误文案带工具指代',
    thrown.error,
  );

  const inputThrowTool = new InteractiveInputGetterTool();
  const inputThrown = await inputThrowTool.execute({});
  check(
    typeof inputThrown.error === 'string' && inputThrown.error.includes('获取可交互输入元素失败'),
    '输入工具错误文案带工具指代',
    inputThrown.error,
  );
  tabStub.payloadThrow = null;

  // —— 未返回结果的 frame：不写缓存（防指纹不一致的死缓存）——
  resetTabStub();
  tabStub.tabs = [{ id: 7, url: 'https://partial.example/', status: 'complete', windowId: 1 }];
  tabStub.payloadResults = [{ frameId: 0, result: undefined }];
  const partialTool = new InteractiveButtonGetterTool();
  const partial1 = await partialTool.execute({});
  const partial2 = await partialTool.execute({});
  eq(dataOf(partial1).cached, false, '残缺采集不命中缓存');
  eq(dataOf(partial2).cached, false, '残缺采集不写入缓存（第二次仍需采集）');
  eq(tabStub.payloadCallCount, 2, '残缺采集每次都重新注入');

  // —— 空白页 / 受限页 / 无标签页拦截 ——
  resetTabStub();
  tabStub.tabs = [{ id: 8, url: 'about:blank', status: 'complete', windowId: 1 }];
  const blankTool = new InteractiveButtonGetterTool();
  const blankResult = await blankTool.execute({});
  check(!blankResult.success && String(blankResult.error).includes('空白页'), '空白页被拦截', blankResult.error);

  tabStub.tabs = [{ id: 9, url: 'chrome://settings/', status: 'complete', windowId: 1 }];
  const restrictedTool = new InteractiveButtonGetterTool();
  const restrictedResult = await restrictedTool.execute({});
  check(
    !restrictedResult.success && String(restrictedResult.error).includes('浏览器默认页'),
    '受限协议页被拦截',
    restrictedResult.error,
  );

  tabStub.tabs = [{ url: 'https://no-id.example/', status: 'complete', windowId: 1 }];
  const noIdTool = new InteractiveButtonGetterTool();
  const noIdResult = await noIdTool.execute({});
  check(!noIdResult.success, '缺少标签页 ID 时返回失败');

  // —— 输入工具基础采集（分页与元素计数共用宿主逻辑）——
  resetTabStub();
  tabStub.payloadResults = [
    {
      frameId: 0,
      result: {
        elements: [
          { type: 'input_text', description: '搜索框', selector: '#q', score: 90, matchedRegex: null, matchedXpath: null, isHit: false },
        ],
        fingerprint: tabStub.fingerprintValue,
      },
    },
  ];
  const inputTool = new InteractiveInputGetterTool();
  const inputResult = await inputTool.execute({});
  check(inputResult.success, '输入元素采集成功');
  const inputData = dataOf(inputResult);
  eq(inputData.totalElements, 1, '输入元素计数');
  check(String(inputData.elements).includes('input_text'), 'Markdown 包含类型列');

  resetTabStub();
}

// ==================== 8. 注入荷载：序列化自包含 + 真实 DOM 行为 ====================

{
  const { JSDOM } = await import('jsdom');
  const { elementScanPayload } = await import('../../tools/automation/shared/element-scan-payload');
  const { enhanceActionPayload } = await import('../../tools/base/enhance-action-payload');

  // —— 模拟 chrome.scripting 的序列化：函数源码只能在「全局作用域」求值执行 ——
  // 若函数体引用了任何模块级标识符（闭包逃逸），这里会直接 ReferenceError。
  const serializedScan = (0, eval)(`(${elementScanPayload.toString()})`) as typeof elementScanPayload;
  const serializedEnhance = (0, eval)(`(${enhanceActionPayload.toString()})`) as typeof enhanceActionPayload;
  check(typeof serializedScan === 'function', '扫描荷载序列化后可求值为函数');
  check(typeof serializedEnhance === 'function', '操作荷载序列化后可求值为函数');

  // —— 全局环境安装（jsdom 页面全局对象），用后恢复 ——
  const GLOBAL_KEYS = [
    'document', 'window', 'Node', 'Element', 'XPathResult', 'CSS', 'MouseEvent', 'Event', 'getComputedStyle',
  ] as const;
  const savedGlobals = GLOBAL_KEYS.map(key => ({
    key,
    had: Object.prototype.hasOwnProperty.call(globalThis, key),
    value: (globalThis as Record<string, unknown>)[key],
  }));
  const restoreGlobals = (): void => {
    for (const item of savedGlobals) {
      if (item.had) (globalThis as Record<string, unknown>)[item.key] = item.value;
      else delete (globalThis as Record<string, unknown>)[item.key];
    }
  };

  /** 解析 data-rect="x,y,w,h" 为矩形（未标注元素返回零矩形 = 不可见/不命中） */
  function parseRect(el: Element): DOMRect {
    const raw = el.getAttribute('data-rect');
    let left = 0, top = 0, width = 0, height = 0;
    if (raw) {
      const parts = raw.split(',').map(Number);
      if (parts.length === 4 && parts.every(n => Number.isFinite(n))) {
        [left, top, width, height] = parts;
      }
    }
    return {
      left, top, width, height,
      right: left + width, bottom: top + height, x: left, y: top,
      toJSON: () => `${left},${top},${width},${height}`,
    };
  }

  /**
   * 构建一套注入环境：安装全局对象、把布局（getBoundingClientRect/getClientRects）
   * 与命中测试（elementFromPoint）覆写为 data-rect 驱动的可断言实现，
   * 并提供可登记的 document.evaluate 桩（jsdom 不实现 XPath）。
   */
  function installDom(html: string): { doc: Document; xpathStub: Map<string, Element[]>; restore: () => void } {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, {
      pretendToBeVisual: true,
      url: 'https://fixture.example/page',
    });
    const win = dom.window;
    const doc = win.document;

    win.Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      return parseRect(this);
    };
    win.Element.prototype.getClientRects = function (this: Element): DOMRectList {
      const rect = parseRect(this);
      const list = rect.width > 0 && rect.height > 0 ? [rect] : [];
      return list as unknown as DOMRectList;
    };
    // 命中测试：返回包含该点且文档序最靠后的 data-rect 元素（近似「最上层」）
    (doc as unknown as { elementFromPoint(x: number, y: number): Element | null }).elementFromPoint = (x, y) => {
      let hit: Element | null = null;
      for (const el of Array.from(doc.querySelectorAll('[data-rect]'))) {
        const r = parseRect(el);
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) hit = el;
      }
      return hit;
    };
    // xpath 桩：按表达式登记命中节点；未登记的表达式一律抛错，
    // 用于覆盖「非法 XPath → 带模式化示例的可读错误」分支
    const xpathStub = new Map<string, Element[]>();
    (doc as unknown as { evaluate(expr: string): { snapshotLength: number; snapshotItem(i: number): Node | null } }).evaluate = (expr) => {
      const nodes = xpathStub.get(expr);
      if (!nodes) throw new Error(`invalid xpath (test stub): ${expr}`);
      return { snapshotLength: nodes.length, snapshotItem: i => nodes[i] ?? null };
    };

    const g = globalThis as Record<string, unknown>;
    g.document = doc;
    g.window = win;
    g.Node = win.Node;
    g.Element = win.Element;
    g.XPathResult = { ORDERED_NODE_SNAPSHOT_TYPE: 7 };
    // jsdom 可能未实现 CSS.escape（inputs 描述链的 label[for] 选择需要），做兼容兜底
    g.CSS = (win as unknown as { CSS?: { escape?: (s: string) => string } }).CSS && typeof win.CSS.escape === 'function'
      ? win.CSS
      : { escape: (s: string) => s.replace(/([^A-Za-z0-9_-])/g, '\\$1') };
    g.MouseEvent = win.MouseEvent;
    g.Event = win.Event;
    g.getComputedStyle = (el: Element) => win.getComputedStyle(el);

    return {
      doc,
      xpathStub,
      restore: () => {
        restoreGlobals();
        win.close();
      },
    };
  }

  const FIXTURE_BODY = `
    <div id="app">
      <button id="loginBtn" data-rect="10,10,80,30">登录</button>
      <a href="https://example.com/report.pdf" data-rect="10,60,120,30">下载报告</a>
      <div class="toolbar" id="toolbar" data-rect="10,105,300,45"><button id="saveBtn" data-rect="20,115,80,30">保存</button></div>
      <input type="text" name="keyword" placeholder="搜索关键词" data-rect="10,160,150,30">
      <select id="sel" data-rect="10,200,100,30"><option value="a">选项A</option></select>
      <textarea id="memo" data-rect="10,240,150,60"></textarea>
    </div>`;

  try {
    const envA = installDom(FIXTURE_BODY);
    try {
      // —— buttons 模式：采集范围、下载识别、类型判定、评分排序 ——
      const buttons = serializedScan('buttons', '', '');
      eq(buttons.error, undefined, 'buttons 模式无错误');
      // 排序依据评分：a(下载 +50) 与 saveBtn(「保存」命中下载文本启发式 +50) 并列最高，
      // 按文档序稳定排在其后的是 90 分的 loginBtn
      eq(
        buttons.elements.map(e => e.selector),
        ['a', '#saveBtn', '#loginBtn'],
        'buttons 模式精确采集 3 个可点击元素并按评分排序（输入控件不混入）',
      );
      check(typeof buttons.fingerprint === 'string' && buttons.fingerprint.length > 0, 'payload 携带页面指纹');

      const bySelector = new Map(buttons.elements.map(e => [e.selector, e]));
      const login = bySelector.get('#loginBtn');
      check(!!login, '按钮 #loginBtn 被采集');
      eq(login?.type, 'button', '按钮类型判定为 button');
      check(String(login?.description).includes('登录'), '按钮描述取自直接文本', login?.description);
      eq(login?.isDownload, false, '普通按钮不是下载按钮');
      eq(bySelector.get('#saveBtn')?.isDownload, true, '「保存」按钮命中下载文本启发式');

      const link = buttons.elements.find(e => e.type === 'link');
      check(!!link, 'pdf 链接被判定为 link 类型');
      eq(link?.isDownload, true, 'pdf 链接命中下载特征');
      check(String(link?.description).includes('[📥下载]'), '下载按钮带 📥 标记', link?.description);
      eq(buttons.elements[0]?.selector, link?.selector, '下载链接按评分（+50）置顶');

      // —— regex 过滤：命中置顶 + 未命中排后 ——
      const filtered = serializedScan('buttons', '登录|保存', '');
      eq(filtered.elements.filter(e => e.isHit).length, 2, 'regex 命中 2 个按钮');
      eq(filtered.elements[0]?.isHit, true, '命中元素置顶（第 1）');
      eq(filtered.elements[1]?.isHit, true, '命中元素置顶（第 2）');
      eq(filtered.elements[2]?.isHit, false, '未命中元素排在命中之后');
      eq(filtered.elements[0]?.matchedRegex, true, '命中者 matchedRegex=true');
      eq(filtered.elements[0]?.matchedXpath, null, '未启用 xpath 时 matchedXpath=null');

      // —— 容器级 xpath：命中 toolbar 容器，子按钮经祖先链判定命中 ——
      const toolbar = envA.doc.getElementById('toolbar');
      check(!!toolbar, 'fixture 含 toolbar 容器');
      envA.xpathStub.set('//div[@class="toolbar"]//button', toolbar ? [toolbar] : []);
      const xp = serializedScan('buttons', '', '//div[@class="toolbar"]//button');
      eq(xp.error, undefined, '合法 xpath 无错误');
      eq(
        xp.elements.find(e => e.selector === '#saveBtn')?.isHit,
        true,
        '容器级 xpath 经祖先链命中子按钮',
      );
      eq(
        xp.elements.find(e => e.selector === '#saveBtn')?.matchedXpath,
        true,
        '子按钮 matchedXpath=true',
      );
      eq(
        xp.elements.find(e => e.selector === '#loginBtn')?.matchedXpath,
        false,
        '链外元素 matchedXpath=false',
      );
      eq(xp.elements[0]?.selector, '#saveBtn', 'xpath 命中者置顶');

      // —— 非法过滤条件：带模式化示例的可读错误 ——
      const badXpathButtons = serializedScan('buttons', '', 'INVALID_XPATH');
      check(
        typeof badXpathButtons.error === 'string' &&
          badXpathButtons.error.includes('XPath 1.0') &&
          badXpathButtons.error.includes("//button[contains(.,'提交')]"),
        'buttons 模式非法 xpath 报错含专属示例',
        badXpathButtons.error,
      );
      const badXpathInputs = serializedScan('inputs', '', 'INVALID_XPATH');
      check(
        typeof badXpathInputs.error === 'string' &&
          badXpathInputs.error.includes("//input[@name='keyword']"),
        'inputs 模式非法 xpath 报错含专属示例',
        badXpathInputs.error,
      );
      const badRegex = serializedScan('buttons', '(', '');
      check(
        typeof badRegex.error === 'string' && badRegex.error.includes('regex 参数不是合法'),
        '非法 regex 报错可读',
        badRegex.error,
      );

      // —— inputs 模式：采集范围、placeholder 描述、类型判定 ——
      const inputs = serializedScan('inputs', '', '');
      eq(inputs.error, undefined, 'inputs 模式无错误');
      eq(inputs.elements.length, 3, 'inputs 模式采集 input/select/textarea', inputs.elements.map(e => `${e.type}:${e.selector}`));
      const textField = inputs.elements.find(e => e.type === 'input_text');
      check(!!textField, '文本框类型判定为 input_text');
      check(
        String(textField?.description).includes('搜索关键词'),
        '文本框描述取自 placeholder',
        textField?.description,
      );
      eq(inputs.elements.some(e => e.type === 'select'), true, '下拉框被采集（type=select）');
      eq(inputs.elements.some(e => e.type === 'textarea'), true, '多行文本被采集（type=textarea）');
      eq(
        inputs.elements.some(e => e.selector === '#loginBtn'),
        false,
        '按钮不混入输入元素采集',
      );

      const inputFiltered = serializedScan('inputs', '搜索', '');
      eq(inputFiltered.elements.filter(e => e.isHit).length, 1, 'inputs regex 命中 1 个');
      eq(inputFiltered.elements[0]?.selector, textField?.selector, '命中的文本框置顶');

      // —— enhance 荷载正常路径：点击 / 填充文本框 / 按 option 文本填充下拉 ——
      const clickOk = await serializedEnhance('click', '#loginBtn');
      eq(clickOk.success, true, '点击未被遮挡的按钮成功', clickOk);

      const fillOk = await serializedEnhance('fill', 'input[name="keyword"]', 'hello world');
      eq(fillOk.success, true, '填充文本框成功', fillOk);
      eq(fillOk.finalValue, 'hello world', '填充值回读一致');

      const fillSelect = await serializedEnhance('fill', '#sel', '选项A');
      eq(fillSelect.success, true, '按 option 文本填充下拉框成功', fillSelect);
      eq(fillSelect.finalValue, 'a', '下拉框选中值为 option 的 value');

      const fillMissing = await serializedEnhance('fill', '#does-not-exist', 'x');
      check(
        typeof fillMissing.error === 'string' && fillMissing.error.includes('not found'),
        '选择器未命中报错',
        fillMissing.error,
      );
      check(
        typeof fillMissing.error === 'string' && fillMissing.error.includes('FrameId'),
        '未命中提示包含 FrameId 处置指引',
        fillMissing.error,
      );
    } finally {
      envA.restore();
    }

    // —— 遮挡场景：视口内被覆盖的元素在采集与操作两侧都必须被识别 ——
    const envC = installDom(
      `<button id="target" data-rect="10,10,80,30">目标</button>` +
        `<div id="cover" data-rect="10,10,80,30"></div>`,
    );
    try {
      const occluded = serializedScan('buttons', '', '');
      eq(occluded.elements.length, 0, '视口内被遮挡的按钮从采集结果剔除');

      const clickOccluded = await serializedEnhance('click', '#target');
      check(
        clickOccluded.success !== true &&
          typeof clickOccluded.error === 'string' &&
          clickOccluded.error.includes('obscured by <div#cover>'),
        '点击被遮挡元素返回含遮挡者身份的可读错误',
        clickOccluded.error,
      );
    } finally {
      envC.restore();
    }
  } finally {
    restoreGlobals(); // 双保险：无论断言是否抛错，页面全局对象必须清理干净
  }
}

// ==================== 9. browser_page_exec 数据通道（自动暂存 / 2000 字符预览 / readRef 分页） ====================

{
  const { PageExecTool } = await import('../../tools/browser/page-exec-tool');
  const execTool = new PageExecTool();

  /** 直接构造注入返回（chrome.scripting 桩按 payloadResults 原样返回） */
  const setExecResult = (result: Record<string, unknown>): void => {
    resetTabStub();
    tabStub.payloadResults = [{ frameId: 0, result: { success: true, ...result } }];
  };

  await dataRefStore.remove('all');

  // —— 小结果：不暂存、全量结构化返回 ——
  setExecResult({ value: { ok: true, n: 1 }, rawJson: '{"ok":true,"n":1}' });
  const small = await execTool.execute({ code: 'return {ok:true,n:1}' });
  check(small.success, '小结果执行成功', small.error);
  const smallData = dataOf(small);
  eq(smallData.dataRef, undefined, '≤2000 字符且未显式 saveResult 时不暂存');
  eq(smallData.result, { ok: true, n: 1 }, '小结果全量结构化返回');
  eq(smallData.resultTruncated, undefined, '小结果无截断标记');

  // —— 超长结果：自动暂存 + 前 2000 字符预览 ——
  const bigRows = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, name: `商品-${i + 1}`, price: 9.9 + i }));
  const bigJson = JSON.stringify(bigRows);
  check(bigJson.length > 3000, '样本数据显著超过自动暂存阈值', bigJson.length);
  setExecResult({ value: bigRows, rawJson: bigJson });
  const auto = await execTool.execute({ code: 'return rows', label: '第1页' });
  check(auto.success, '超长结果执行成功', auto.error);
  const autoData = dataOf(auto);
  check(!!autoData.dataRef, '超 2000 字符自动暂存（未显式 saveResult）');
  eq(autoData.dataRefTrigger, 'auto', '自动触发标记为 auto');
  eq(autoData.resultType, 'json-preview', '暂存模式 resultType 为 json-preview');
  eq(autoData.result, bigJson.slice(0, 2000), 'result 为全量 JSON 前 2000 字符');
  eq((autoData.result as string).length, 2000, '预览恰好 2000 字符');
  eq(autoData.resultTruncated, true, '超长结果带 truncated 标记');
  eq(autoData.totalChars, bigJson.length, 'totalChars 为全量长度');
  eq(autoData.dataRef.label, '第1页', 'label 透传到自动暂存批次');
  eq(autoData.dataRef.rowCount, 150, 'dataRef 行数统计正确');
  check(String(autoData.dataRefGuide).includes('readRef'), '引导文案包含分页读取指引');
  check(String(autoData.dataRefGuide).includes('xlsx_tool'), '引导文案包含导出指引');
  check(
    JSON.stringify(autoData).length < 6000,
    '自动暂存响应总载荷有界（不含全量数据）',
    JSON.stringify(autoData).length,
  );
  const refId = String(autoData.dataRef.id);
  const storedEntry = await dataRefStore.get(refId);
  eq(storedEntry?.json, bigJson, '暂存区保存的是全量 JSON');

  // —— 显式 saveResult：小结果也强制暂存，全部封装进 result ——
  setExecResult({ value: { a: 1 }, rawJson: '{"a":1}' });
  const forced = await execTool.execute({ code: 'return {a:1}', saveResult: true });
  check(forced.success, '显式暂存执行成功', forced.error);
  const forcedData = dataOf(forced);
  check(!!forcedData.dataRef, 'saveResult=true 小结果也暂存');
  eq(forcedData.dataRefTrigger, 'explicit', '显式触发标记为 explicit');
  eq(forcedData.result, '{"a":1}', '小数据全部封装进 result');
  eq(forcedData.resultTruncated, undefined, '小数据无截断标记');

  // —— 阈值边界：恰好 2000 不暂存、2001 自动暂存 ——
  const atJson = JSON.stringify('x'.repeat(1998)); // 1998 + 2 个引号 = 2000 字符
  eq(atJson.length, 2000, '边界样本恰好 2000 字符');
  setExecResult({ value: 'x'.repeat(1998), rawJson: atJson });
  const atLimit = await execTool.execute({ code: 'x' });
  eq(dataOf(atLimit).dataRef, undefined, '恰好 2000 字符不自动暂存');
  const overJson = JSON.stringify('x'.repeat(1999)); // 2001 字符
  eq(overJson.length, 2001, '边界样本 2001 字符');
  setExecResult({ value: 'x'.repeat(1999), rawJson: overJson });
  const overLimit = await execTool.execute({ code: 'x' });
  check(!!dataOf(overLimit).dataRef, '2001 字符触发自动暂存');

  // —— readRef 分页读取：首页 / 续读 / 尾页 / 越界收敛 / limit 收敛 ——
  resetTabStub();
  const page1 = await execTool.execute({ readRef: refId });
  check(page1.success, 'readRef 首页读取成功', page1.error);
  const page1Data = dataOf(page1);
  eq(page1Data.offset, 0, '默认从 0 开始');
  eq(page1Data.limit, 2000, '默认页大小 2000');
  eq(page1Data.content, bigJson.slice(0, 2000), '首页内容为前 2000 字符');
  eq(page1Data.totalChars, bigJson.length, '读取响应携带 totalChars');
  eq(page1Data.hasMore, true, '首页还有后续');
  eq(page1Data.nextOffset, 2000, 'nextOffset 指向下一页起点');

  const page2 = await execTool.execute({ readRef: refId, offset: page1Data.nextOffset as number, limit: 500 });
  check(page2.success, '第二页读取成功', page2.error);
  const page2Data = dataOf(page2);
  eq(page2Data.content, bigJson.slice(2000, 2500), '第二页内容正确');
  eq(page2Data.nextOffset, 2500, 'nextOffset 随分页推进');

  const tailOffset = bigJson.length - 10;
  const tail = await execTool.execute({ readRef: refId, offset: tailOffset });
  check(tail.success, '尾页读取成功', tail.error);
  const tailData = dataOf(tail);
  eq(tailData.content, bigJson.slice(tailOffset), '尾页返回剩余 10 字符');
  eq(tailData.hasMore, false, '末页 hasMore=false');

  const past = await execTool.execute({ readRef: refId, offset: bigJson.length + 500 });
  check(past.success, '越界 offset 不报错', past.error);
  const pastData = dataOf(past);
  eq(pastData.content, '', '越界返回空页');
  eq(pastData.hasMore, false, '越界 hasMore=false');
  check(String(pastData.note).includes('末尾'), '越界给出收敛说明', pastData.note);

  const wide = await execTool.execute({ readRef: refId, limit: 5000 });
  check(wide.success, '超限 limit 不报错', wide.error);
  const wideData = dataOf(wide);
  eq((wideData.content as string).length, 2000, 'limit 超上限收敛到 2000');
  check(String(wideData.note).includes('上限'), 'limit 收敛给出说明', wideData.note);

  // —— 分页读取不依赖标签页（无激活标签也能读暂存数据）——
  tabStub.tabs = [];
  const noTab = await execTool.execute({ readRef: refId });
  check(noTab.success, 'readRef 模式不依赖标签页', noTab.error);
  resetTabStub();

  // —— 读取参数防御 ——
  const badOffset = await execTool.execute({ readRef: refId, offset: -1 });
  check(!badOffset.success && String(badOffset.error).includes('offset'), '负 offset 被拒绝', badOffset.error);
  const badOffsetType = await execTool.execute({ readRef: refId, offset: 'abc' as unknown as number });
  check(!badOffsetType.success && String(badOffsetType.error).includes('offset'), '非数字 offset 被拒绝', badOffsetType.error);
  const badLimit = await execTool.execute({ readRef: refId, limit: 0 });
  check(!badLimit.success && String(badLimit.error).includes('limit'), 'limit=0 被拒绝', badLimit.error);
  const badRefType = await execTool.execute({ readRef: 123 as unknown as string });
  check(!badRefType.success && String(badRefType.error).includes('readRef'), '非字符串 readRef 被拒绝', badRefType.error);
  const missingRef = await execTool.execute({ readRef: 'zzzzzzzz' });
  check(!missingRef.success && String(missingRef.error).includes('不存在或已过期'), '失效引用报错可读', missingRef.error);

  // —— 模式互斥与缺参防御 ——
  const conflict = await execTool.execute({ code: '1+1', readRef: refId });
  check(!conflict.success && String(conflict.error).includes('互斥'), 'code 与 readRef 互斥', conflict.error);
  // 执行模式下携带 offset/limit（面板默认值回填场景）：宽容忽略、不阻断执行
  setExecResult({ value: 7, rawJson: '7' });
  const strayOffset = await execTool.execute({ code: '1+1', offset: 0, limit: 2000 });
  check(strayOffset.success, '执行模式下 offset/limit 被忽略而非报错', strayOffset.error);
  eq(dataOf(strayOffset).result, 7, '忽略 stray 参数后正常返回执行结果');
  const noCode = await execTool.execute({});
  check(!noCode.success && String(noCode.error).includes('code'), '缺少 code 时给出可读错误', noCode.error);
  check(String(noCode.error).includes('readRef'), '缺参错误同时引导 readRef 模式', noCode.error);

  // —— 捕获失败（超上限）：输出降级为有界前缀并告警，不阻断执行结果 ——
  const bigValue = Array.from({ length: 80 }, (_, i) => ({ id: i, text: 'x'.repeat(60) }));
  setExecResult({
    value: bigValue,
    rawJsonError: '数据量 9999999 字符超过单次暂存上限 6000000——请在脚本内先筛选字段或限制条数后分批保存',
  });
  const overflow = await execTool.execute({ code: 'return hugeData' });
  check(overflow.success, '捕获失败不阻断执行结果', overflow.error);
  const overflowData = dataOf(overflow);
  eq(overflowData.dataRef, undefined, '捕获失败不产生 dataRef');
  check(
    typeof overflowData.result === 'string' && (overflowData.result as string).length <= 2000,
    '超限输出降级为 ≤2000 字符前缀',
    typeof overflowData.result === 'string' ? (overflowData.result as string).length : typeof overflowData.result,
  );
  eq(overflowData.resultTruncated, true, '降级输出带截断标记');
  check(
    Array.isArray(overflowData.warnings) && String((overflowData.warnings as string[])[0]).includes('自动暂存'),
    '给出无法自动暂存告警',
    overflowData.warnings,
  );

  // —— 显式暂存失败：告警但不影响执行结果返回 ——
  setExecResult({ value: { a: 1 }, rawJsonError: '返回值无法序列化为 JSON：Converting circular structure to JSON' });
  const saveFail = await execTool.execute({ code: 'circular()', saveResult: true });
  check(saveFail.success, '显式暂存失败仍返回执行结果', saveFail.error);
  const saveFailData = dataOf(saveFail);
  eq(saveFailData.dataRef, undefined, '暂存失败不产生 dataRef');
  check(
    Array.isArray(saveFailData.warnings) && String((saveFailData.warnings as string[])[0]).includes('暂存失败'),
    '显式暂存失败带告警',
    saveFailData.warnings,
  );
  eq(saveFailData.result, { a: 1 }, '小结果仍结构化返回');

  await dataRefStore.remove('all');
  resetTabStub();
}

// ==================== 汇总 ====================

console.log(`\n[tools] 通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
