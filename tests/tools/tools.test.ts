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
 *      合并/删除、按字段去重（dedupe）与信封路径提取（extract）、
 *      不可序列化值报错、超限拒绝
 *   7. 实际节点引用与显式快照：分页唯一性、过滤条件、跨页面/frame 生命周期与二次核验
 *   8. 注入荷载真实行为：源码在干净作用域求值（验证序列化自包含）+ jsdom DOM——
 *      buttons/inputs 两模式采集与评分、regex 命中置顶、容器级 xpath 祖先链、
 *      遮挡剔除、非法过滤条件的模式化报错、enhance 点击/填充与遮挡/未命中报错
 *   9. browser_page_exec 数据通道：默认暂存（省略 saveResult 即存、trigger 三态
 *      default/explicit/auto）、超 2000 字符强制暂存（阈值边界 2000/2001）、
 *      前 2000 字符预览封装、readRef 分页读取
 *      （首页/续读/尾页/越界收敛/limit 收敛/无标签页）、参数与模式互斥防御、
 *      捕获/暂存失败的有界降级与告警
 *  10. plan_tool 契约（五动作/failed 必填校验/未知 id 回显/重建提示）+ 计划
 *      状态提醒判定（plan-reminder 纯函数）+ plan-store 幂等水合
 *      （见 ./plan.test.ts）
 *  11. browser_dom_explore：parent/children/siblings/similar 荷载行为、
 *      重复模式两种形态与生成选择器、noPattern、visibleOnly/depth、
 *      宿主分页快照（40/页/STALE 语义/参数防御）（见 ./dom-explore.test.ts）
 *  12. browser_get_page_text：结构化荷载序列化自包含 + jsdom DOM 行为
 *      （标题/表格 rowspan·colspan/列表/代码块/链接/shadow·slot/噪声剔除）、
 *      宿主流程（短文全量、多 frame 组装、超 15k 自动 dataRef 缓存 + ref/page
 *      分页含代理项跨页配对、url 前台打开模式（激活标签页、加载就绪后提取、
 *      标签页保留不关闭）、参数互斥与越界防御）
 *  13. 数据通道治理 + xlsx 数据源统一：dedupe/extract 领域契约与工具动作契约、
 *      xlsx 混排（dataRef 表 + 手写公式表）、数据来源二选一/字段误用/空表/
 *      失效引用的精准报错、openaiSchema 数据源声明（见 ./xlsx-dataref.test.ts）
 *  14. 上传文件体系：会话文件库（注册/分页/隔离/级联删除）、read_file 契约
 *      （信封第 1 页一致性/越界自纠/跨会话拒绝）、信封装配（结构/转义/预算
 *      封顶）、压缩引擎纯函数（GIF 动画判定/头部尺寸/触发矩阵）
 *      （见 ./upload-file.test.ts）
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
  // 同时支持 Promise 风格（data-ref-store 等 await 调用）与回调风格
  // （file-manager 等 chrome.storage 原生回调调用）——回调不触发会永久挂起。
  return {
    async get(
      keys: unknown,
      callback?: (items: Record<string, unknown>) => void,
    ): Promise<Record<string, unknown>> {
      const out: Record<string, unknown> = {};
      if (keys === null || keys === undefined) {
        for (const [k, v] of memory) out[k] = structuredClone(v);
        callback?.(out);
        return out;
      }
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) {
        if (typeof key === 'string' && memory.has(key)) {
          out[key] = structuredClone(memory.get(key));
        }
      }
      callback?.(out);
      return out;
    },
    async set(
      items: Record<string, unknown>,
      callback?: () => void,
    ): Promise<void> {
      for (const [k, v] of Object.entries(items)) memory.set(k, structuredClone(v));
      callback?.();
    },
    async remove(keys: unknown, callback?: () => void): Promise<void> {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) {
        if (typeof key === 'string') memory.delete(key);
      }
      callback?.();
    },
    async clear(callback?: () => void): Promise<void> {
      memory.clear();
      callback?.();
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
}

const tabStub: TabStubState = {
  tabs: [{ id: 1, url: 'https://example.com/', status: 'complete', windowId: 1 }],
  payloadResults: [],
  payloadThrow: null,
};

function resetTabStub(): void {
  tabStub.tabs = [{ id: 1, url: 'https://example.com/', status: 'complete', windowId: 1 }];
  tabStub.payloadResults = [];
  tabStub.payloadThrow = null;
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
    executeScript: async () => {
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
  stub.windows = { getAll: async () => ({ id: 1, state: 'normal' }), getLastFocused: async () => ({ id: 1, type: 'normal' }) };

  (globalThis as Record<string, unknown>).chrome = stub;
  // WXT 自动导入的 browser 别名：部分模块按扩展环境引用，桩等同 chrome
  (globalThis as Record<string, unknown>).browser = stub;
}

installGlobalStubs();

// ==================== 动态加载被测模块 ====================

const { toolRegistry, registerAllTools } = await import('../../tools/index');
const { TOOL_NAMES } = await import('../../common/constants');
const { SCENARIO_PRESETS, CORE_PAGE_TOOL_IDS, CORE_SESSION_TOOL_IDS } = await import('../../utils/tools/tool-presets');
const { categories: catalogCategories } = await import(
  '../../entrypoints/sidepanel/components/tool/tool-definitions'
);
const { dataRefStore } = await import('../../utils/data-ref-store');

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
  // 核心会话工具契约：四个全局工具（interact / 正文 / 计划 / 笔记）全部真实注册——
  // note_tool 升级核心层后，场景清单不再登记 note，此处是「它恒定可用」的唯一测试锚
  for (const id of CORE_SESSION_TOOL_IDS) {
    check(registered.has(id), `核心会话工具 ${id} 已注册`);
  }
  check(CORE_SESSION_TOOL_IDS.includes('plan_tool') && CORE_SESSION_TOOL_IDS.includes('note_tool'),
    'plan_tool 与 note_tool 同为核心层无条件注入');

  // —— 视觉重拍豁免契约（noVisionRecapture 单一事实源）——
  // 豁免 = true 的准入：纯读不碰像素/视口/活动标签页，且不替换 GUI 截图身份。
  // 漏标只是多一次重拍（安全），错标会让模型拿失效截图坐标继续操作（危险），
  // 因此本清单收紧/扩张都必须同步 needsVisionRefresh 语义评审。
  // 注：只读观察已并入 vision_gui 的 action 面——read/zoom 的豁免走
  // gui-contract 的动作级判定（visionGuiRefresh），不经过本字段；
  // 原 vision_read* 独立工具已删除。
  const NO_RECAPTURE_TOOLS = [
    'browser_get_page_text', 'browser_get_page_info', 'browser_get_all_tabs', 'browser_window',
    'browser_observe', 'browser_dom_explore', 'browser_network_capture',
    'plan_tool', 'interact', 'note_tool', 'data_ref_tool', 'load_skill', 'read_skill_file', 'read_file',
  ];
  for (const id of NO_RECAPTURE_TOOLS) {
    check(toolRegistry.getTool(id)?.metadata.noVisionRecapture === true, `纯读工具 ${id} 声明 noVisionRecapture=true`);
  }
  // 必须保守重拍的高危反例：改页面 / 等待变化 / 内部自拍替换截图身份 /
  // 名单特例工具（screenshot 按名字、vision_gui 按 action 由 needsVisionRefresh
  // 单独处理，不依赖字段）；get_page_html 属自定义组合扩展组，未经确认保持缺省保守
  for (const id of ['web_search', 'generic_wait', 'wait_page_load', 'browser_interact', 'browser_navigate',
    'browser_switch_tab', 'browser_page_exec', 'screenshot',
    'vision_gui', 'ocr', 'extract_data', 'ai_locate', 'browser_console', 'file_uploader', 'browser_get_page_html']) {
    check(toolRegistry.getTool(id)?.metadata.noVisionRecapture !== true, `工具 ${id} 保持保守重拍（未豁免）`);
  }
  // 未声明字段的存在性防御：字段缺省（undefined）即为 false 语义
  check(toolRegistry.getTool('browser_interact')?.metadata.noVisionRecapture === undefined || toolRegistry.getTool('browser_interact')?.metadata.noVisionRecapture === false,
    '未声明豁免的工具按缺省 false 处理');
  // 笔记固定分区契约：与 plan 的分工路由 + 独立 XML 标签（三层分工见 note-prompt 文件头）
  const { NOTE_SYSTEM_PROMPT_SECTION } = await import('../../tools/note/note-prompt');
  check(NOTE_SYSTEM_PROMPT_SECTION.includes('note-workspace-guidelines'), '笔记分区使用独立 XML 标签');
  check(NOTE_SYSTEM_PROMPT_SECTION.includes('与 plan_tool 的分工'), '笔记分区含与计划的分工路由');
  check(NOTE_SYSTEM_PROMPT_SECTION.includes('选择口诀'), '笔记分区含无歧义选择口诀');
}

// ==================== 2b. 统一搜索工具 web_search 契约 ====================

{
  const { WebSearchTool, SEARCH_PLATFORM_IDS, SEARCH_PLATFORMS } = await import('../../tools/search');
  const tool = new WebSearchTool();

  // —— 注册与平台面 ——
  check(toolRegistry.getTool('web_search') !== null, 'web_search 已注册');
  eq(SEARCH_PLATFORM_IDS.length, 9, '平台注册表共 9 个平台');
  for (const id of SEARCH_PLATFORM_IDS) {
    const platform = SEARCH_PLATFORMS[id];
    check(
      typeof platform.buildSearchUrl('q') === 'string' && platform.buildSearchUrl('q').includes(encodeURIComponent('q')),
      `平台 ${id}: URL 模板含编码关键词`,
    );
    if (platform.extractor.kind === 'script') {
      check(!!platform.extractor.file && !!platform.extractor.action, `平台 ${id}: script 通道配置完整`);
    } else {
      check(typeof platform.extractor.func === 'function', `平台 ${id}: inline 通道有解析函数`);
    }
  }
  check(
    (tool.openaiSchema.function.parameters?.properties as Record<string, { enum?: string[] }>).website?.enum?.length === 9,
    'schema 的 website 枚举与平台注册表一致',
  );
  check(
    (tool.openaiSchema.function.description ?? '').includes('browser_navigate'),
    '工具描述明确声明自带导航（引用 browser_navigate）',
  );
  check(tool.metadata.noVisionRecapture !== true, 'web_search 未标记 noVisionRecapture（搜索改变页面，视觉循环须重拍）');

  // —— 参数防御（不触导航即返回错误） ——
  const badPlatform = await tool.execute({ website: 'google', query: 'x' });
  check(badPlatform.success === false && /不支持的搜索平台/.test(badPlatform.error ?? '') && (badPlatform.error ?? '').includes('baidu'), '未知平台：报错并列出支持平台', badPlatform.error);
  const badQuery = await tool.execute({ website: 'bing', query: '   ' });
  check(badQuery.success === false && /query 必填/.test(badQuery.error ?? ''), '空白 query：报错');
  const badShape = await tool.execute('not-an-object');
  check(badShape.success === false, '非对象参数：报错');
  const badLength = await tool.execute({ website: 'bing', query: 'x'.repeat(301) });
  check(badLength.success === false && /query 过长/.test(badLength.error ?? ''), '超长 query：报错');

  // —— 行为用例：可控桩替换（导航 + 解析两条通道） ——
  const chromeStub = (globalThis as Record<string, unknown>).chrome as Record<string, unknown>;
  const tabsStub = chromeStub.tabs as Record<string, unknown>;
  const scriptingStub = chromeStub.scripting as Record<string, unknown>;
  const originalTabs = { ...tabsStub };
  const originalExecuteScript = scriptingStub.executeScript;
  const originalSetTimeout = globalThis.setTimeout;
  // 压缩等待节奏：waitTime 归零、加载轮询即时
  const fastTimeout = ((fn: () => void, ms?: number) => originalSetTimeout(fn, Math.min(ms ?? 0, 1))) as typeof setTimeout;
  try {
    let lastCreatedTabId = 0;
    let pageUrl = 'https://www.bing.com/search?q=test';
    let pageStatus = 'complete';
    let inlineResult: unknown[] = [];
    let messageResponse: unknown;
    tabsStub.create = (async (props: { url?: string }) => {
      lastCreatedTabId = 77;
      pageUrl = props.url ?? pageUrl;
      return { id: lastCreatedTabId, url: props.url };
    }) as typeof tabsStub.create;
    tabsStub.update = (async (tabId: number, props: { url?: string }) => {
      pageUrl = props.url ?? pageUrl;
      return { id: tabId, url: pageUrl };
    }) as typeof tabsStub.update;
    tabsStub.get = (async (tabId: number) => {
      if (tabId !== 1 && tabId !== 77) throw new Error('tab gone');
      return { id: tabId, url: pageUrl, status: pageStatus };
    }) as typeof tabsStub.get;
    tabsStub.sendMessage = (async () => messageResponse) as typeof tabsStub.sendMessage;
    scriptingStub.executeScript = (async () => [{ result: inlineResult }]) as typeof scriptingStub.executeScript;
    globalThis.setTimeout = fastTimeout as typeof globalThis.setTimeout;

    // 1) inline 通道（bing）：导航成功 + 解析成功 + 两部分封装
    inlineResult = [{ title: 'A', link: 'https://a', description: 'd' }];
    const ok = await tool.execute({ website: 'bing', query: 'test', waitTime: 0 });
    check(ok.success === true, 'inline: 整体 success');
    const okData = ok.data as { navigation: { success: boolean; url: string; tabId: number }; results: { success: boolean; count: number; markdown?: string } };
    check(okData.navigation.success === true && okData.navigation.url === 'https://www.bing.com/search?q=test' && okData.navigation.tabId === 77, 'inline: navigation 封装含当前网址与 tabId', okData.navigation);
    check(okData.results.success === true && okData.results.count === 1, 'inline: results 含条目计数');
    check(okData.results.markdown === undefined, 'inline: data.results 不含 markdown（单份契约，防引擎序列化双份）');
    const okContent = (ok.content as Array<{ text?: string }>)[0]?.text ?? '';
    check(okContent.includes('| title |') && okContent.includes('https://a'), 'inline: content 携带唯一一份 Markdown 表', okContent.slice(0, 80));
    check(
      !okContent.includes('credibility') && !('credibility' in (okData.results as Record<string, unknown>)),
      'inline: 结果不再带可信度分级列（改由模型按域名自行判断）',
    );
    check(
      !('items' in (okData.results as Record<string, unknown>)),
      'inline: data.results 不重复条目本体（条目只在 content 的表里出现一次）',
    );
    check(
      (tool.openaiSchema.function.description ?? '').includes('域名'),
      '工具描述要求模型按来源域名判断可信度',
    );

    // 2) 解析失败不拖垮导航封装（inline 抛错）
    scriptingStub.executeScript = (async () => { throw new Error('CSP blocked'); }) as typeof scriptingStub.executeScript;
    const parseFail = await tool.execute({ website: 'bing', query: 'test', waitTime: 0 });
    check(parseFail.success === true, '解析失败: 整体仍 success（导航事实不被吞）');
    const parseFailData = parseFail.data as { navigation: { success: boolean }; results: { success: boolean; hint?: string } };
    check(parseFailData.navigation.success === true, '解析失败: navigation 仍成功');
    check(parseFailData.results.success === false && /browser_get_page_text/.test(parseFailData.results.hint ?? ''), '解析失败: 提示自行解析', parseFailData.results.hint);

    // 3) script 通道（zhihu）：注入 + sendMessage 契约
    scriptingStub.executeScript = (async () => undefined) as typeof scriptingStub.executeScript;
    messageResponse = { status: 'success', data: [{ title: 'T', link: 'https://z' }] };
    const scriptOk = await tool.execute({ website: 'zhihu', query: 'test', waitTime: 0 });
    const scriptOkData = scriptOk.data as { results: { success: boolean; count: number } };
    check(scriptOk.success === true && scriptOkData.results.success === true && scriptOkData.results.count === 1, 'script: 通道契约解析成功');
    messageResponse = { status: 'error', message: '页面结构变化' };
    const scriptErr = await tool.execute({ website: 'zhihu', query: 'test', waitTime: 0 });
    const scriptErrData = scriptErr.data as { navigation: { success: boolean }; results: { success: boolean } };
    check(scriptErr.success === true && scriptErrData.navigation.success === true && scriptErrData.results.success === false, 'script: 内容脚本报错时仅 results 失败');

    // 4) 空结果：success + 提示
    messageResponse = { status: 'success', data: [] };
    const empty = await tool.execute({ website: 'csdn', query: 'test', waitTime: 0 });
    const emptyData = empty.data as { results: { success: boolean; count: number; hint?: string } };
    check(emptyData.results.success === true && emptyData.results.count === 0 && /browser_get_page_text/.test(emptyData.results.hint ?? ''), '空结果: success=true 且提示自行确认');

    // 5) 导航硬失败（新标签页创建后即消失）
    tabsStub.create = (async () => ({ id: 88 })) as typeof tabsStub.create;
    const navFail = await tool.execute({ website: 'baidu', query: 'test', waitTime: 0 });
    check(navFail.success === false && /导航失败/.test(navFail.error ?? ''), '导航失败: 整体报错', navFail.error);
    const navFailData = navFail.data as { navigation: { success: boolean } };
    check(navFailData.navigation.success === false, '导航失败: navigation 如实封装');

    // 6) currentTab 模式（newTab=false）复用标签页 1
    tabsStub.create = (async (props: { url?: string }) => { lastCreatedTabId = 77; pageUrl = props.url ?? pageUrl; return { id: 77, url: props.url }; }) as typeof tabsStub.create;
    scriptingStub.executeScript = (async () => [{ result: inlineResult }]) as typeof scriptingStub.executeScript;
    pageUrl = 'https://www.bing.com/search?q=test';
    const currentTab = await tool.execute({ website: 'bing', query: 'test', newTab: false, waitTime: 0 });
    const currentTabData = currentTab.data as { navigation: { tabId: number; newTab: boolean } };
    check(currentTabData.navigation.tabId === 1 && currentTabData.navigation.newTab === false, 'newTab=false: 复用当前标签页', currentTabData.navigation);

    // 7) 加载超时=软失败：navigation.success 仍为 true、status='timeout' 带 note，解析照常进行
    pageStatus = 'loading';
    inlineResult = [{ title: 'B', link: 'https://b' }];
    const slowLoad = await tool.execute({ website: 'bing', query: 'test', waitTime: 0 });
    const slowData = slowLoad.data as { navigation: { success: boolean; status: string; note?: string }; results: { success: boolean; count: number } };
    check(
      slowLoad.success === true && slowData.navigation.success === true && slowData.navigation.status === 'timeout' && !!slowData.navigation.note,
      '加载超时: navigation 软失败如实上报（不判死）',
      slowData.navigation,
    );
    check(slowData.results.success === true && slowData.results.count === 1, '加载超时: 解析照常进行');
    pageStatus = 'complete';
  } finally {
    Object.assign(tabsStub, originalTabs);
    scriptingStub.executeScript = originalExecuteScript;
    globalThis.setTimeout = originalSetTimeout;
  }
}

// ==================== 2c. 百度结果解析器（实测 DOM 回归） ====================

{
  // 实测驱动（2026-11 百度 SERP F12 实测）的类名形态回归：稳定前缀_hash 轮换类、
  // mu 直链与桩/伪域名、错位污染归一。以 func.toString() 在干净作用域求值，
  // 等价 chrome.scripting 的序列化注入——同时验证自包含约束（闭包引用在
  // 页面上下文会直接丢失，此处即抛 ReferenceError）。
  const { JSDOM } = await import('jsdom');
  const { SEARCH_PLATFORMS } = await import('../../tools/search/search-platforms');
  type BaiduRow = { title: string; link: string; description: string; source: string; time: string };

  const baiduHtml = `<!DOCTYPE html><body><div id="content_left">
    <div class="c-container" id="1" tpl="jr_quote">
      <h3><a href="http://www.baidu.com/link?url=quoteRedirect">英特尔[INTC]美股实时行情 - FinScope</a></h3>
      <span class="cur-num_TBaK4">56.28</span>
      <span class="cur-range_1Zt06">-4.66</span>
      <span class="cur-ratio_4l3tZ">-7.71%</span>
      <span class="update_6yJgf">收盘</span>
    </div>
    <div class="c-container" id="2" tpl="www_index" mu="https://quote.eastmoney.com/us/INTC.html?Market=NASDAQ">
      <h3><a href="http://www.baidu.com/link?url=wwwRedirect">英特尔(INTC)最新价格_行情_走势图—东方财富网</a></h3>
      <div class="content_MUfFD">东方财富网为您提供英特尔股票行情走势分析</div>
      <span class="source-text_1w-M9">东方财富网</span>
      <span class="prefix-time_650Xx">2天前</span>
    </div>
    <div class="c-container" id="3" tpl="recommend_list" mu="http://28608.recommend_list.baidu.com">
      <h3><a href="/s?wd=recommend">大家还在搜</a></h3>
      <span class="item_3WKCf">英特尔股票</span>
    </div>
    <div class="c-container" id="4" tpl="rel_base_realtime" mu="https://www.baidu.com/s?tn=news&rtt=1&wd=x">
      <h3><a href="http://www.baidu.com/link?url=relRedirect">英特尔股价大跌 最新相关信息</a></h3>
      <span class="cosc-source-text">东方财富网\n前天12:22</span>
    </div>
    <div class="c-container" id="5" tpl="www_index" mu="http://nourl.ubs.baidu.com/nourl">
      <h3><a href="http://www.baidu.com/link?url=stubRedirect">标题五</a></h3>
      <span class="c-color-gray2">12小时前东方财富独家</span>
    </div>
    <div class="c-container" id="6" tpl="www_index" mu="http://28608.recommend_list.baidu.com">
      <h3><a href="/s?wd=relative">标题六</a></h3>
    </div>
    <div class="c-container" id="7" tpl="www_index">
      <h3><a href="http://www.baidu.com/link?url=legacyRedirect">标题七</a></h3>
      <div class="c-abstract">旧版摘要结构仍然需要兼容。</div>
      <span class="c-color-gray2">来源识别不出的时间词</span>
    </div>
  </div></body>`;

  const dom = new JSDOM(baiduHtml, { url: 'https://www.baidu.com/s?wd=test' });
  const savedDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  (globalThis as Record<string, unknown>).document = dom.window.document;
  let rows: BaiduRow[] = [];
  try {
    const extractor = SEARCH_PLATFORMS.baidu.extractor;
    check(extractor.kind === 'inline' && typeof extractor.func === 'function', '百度解析器为 inline 通道且有解析函数');
    if (extractor.kind === 'inline' && extractor.func) {
      try {
        const fn = (0, eval)('(' + extractor.func.toString() + ')') as () => BaiduRow[];
        rows = fn();
        check(true, '百度解析器在干净作用域求值并执行（自包含）');
      } catch (error) {
        check(false, '百度解析器在干净作用域求值并执行（自包含）', error);
      }
    }
  } finally {
    if (savedDoc) Object.defineProperty(globalThis, 'document', savedDoc);
    else delete (globalThis as Record<string, unknown>).document;
  }

  eq(rows.length, 6, '解析出 6 条（「大家还在搜」UI 卡剔除）', rows.map(r => r.title));
  const pick = (needle: string): BaiduRow | undefined => rows.find(r => r.title.includes(needle));

  const quote = pick('FinScope');
  check(
    quote?.description.includes('56.28') === true && quote?.description.includes('-7.71%') === true,
    '行情卡：现价与涨跌幅并入描述',
    quote?.description,
  );
  check(
    quote?.link === 'http://www.baidu.com/link?url=quoteRedirect',
    '行情卡：无 mu → 落回跳转串',
    quote?.link,
  );

  const www = pick('最新价格_行情_走势图');
  check(
    www?.link === 'https://quote.eastmoney.com/us/INTC.html?Market=NASDAQ',
    '网页卡：mu 校验通过 → 真实直链（可信度可按域名判断）',
    www?.link,
  );
  check(www?.description.includes('行情走势分析') === true, '网页卡：哈希轮换类摘要命中', www?.description);
  check(www?.source === '东方财富网' && www?.time === '2天前', '网页卡：来源与时间命中', { source: www?.source, time: www?.time });

  check(!rows.some(r => r.title === '大家还在搜'), 'recommend_list UI 卡剔除');

  const rel = pick('最新相关信息');
  check(
    rel?.link === 'https://www.baidu.com/s?tn=news&rtt=1&wd=x',
    '聚合卡：非桩 mu 保留（可导航的内部聚合页）',
    rel?.link,
  );
  check(rel?.source === '东方财富网' && rel?.time === '前天12:22', '聚合卡：来源与时间同节点 → 拆分归一', rel);

  const stub = pick('标题五');
  check(stub?.link === 'http://www.baidu.com/link?url=stubRedirect', '桩 mu（nourl.ubs）→ 落回跳转串', stub?.link);
  check(stub?.time === '12小时前', '时间错位文本归一为可识别前缀', stub?.time);

  const relHref = pick('标题六');
  check(
    relHref?.link === 'https://www.baidu.com/s?wd=relative',
    '伪域名 mu（recommend_list）→ 落回跳转串且相对 href 解析为绝对地址',
    relHref?.link,
  );

  const legacy = pick('标题七');
  check(legacy?.description.includes('旧版摘要结构') === true, '旧版 c-abstract 摘要兼容', legacy?.description);
  check(legacy?.time === '', '无法识别的时间清空（不回传错位文本）', legacy?.time);
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

// ==================== 7. Element reference / snapshot integration ====================
type AnyRecord = Record<string, any>;
function dataOf(result: { data?: AnyRecord }): AnyRecord { return result.data ?? {}; }
const { testElementInteraction } = await import('./element-interaction.test');
await testElementInteraction(check, eq);

// ==================== 11. browser_dom_explore DOM 关系探索 ====================

const { testDomExplore } = await import('./dom-explore.test');
await testDomExplore(check, eq);
const { testSiteLearning } = await import('./site-learning.test');
await testSiteLearning(check);
const { testTextAutomation } = await import('./text-automation.test');
await testTextAutomation(check, eq);

// ==================== 8. 注入荷载：序列化自包含 + 真实 DOM 行为 ====================

{
  const { JSDOM } = await import('jsdom');
  const { elementScanPayload } = await import('../../tools/automation/shared/element-scan-payload');
  const { domActionPayload } = await import('../../tools/browser/dom-action-payload');

  // —— 模拟 chrome.scripting 的序列化：函数源码只能在「全局作用域」求值执行 ——
  // 若函数体引用了任何模块级标识符（闭包逃逸），这里会直接 ReferenceError。
  const serializedScan = (0, eval)(`(${elementScanPayload.toString()})`) as typeof elementScanPayload;
  const serializedEnhance = (0, eval)(`(${domActionPayload.toString()})`) as typeof domActionPayload;
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
      const cssOf = (id: string) => {
        const el = (envA.doc as any).__agentNexusReferences.resolve(id) as Element;
        return el.id ? '#' + el.id : el.localName;
      };
      const ref = (css: string): string => {
        const node = envA.doc.querySelector(css)!;
        return (envA.doc as any).__agentNexusReferences.register(node);
      };
      eq(buttons.error, undefined, 'buttons 模式无错误');
      // 排序依据评分：a(下载 +50) 与 saveBtn(「保存」命中下载文本启发式 +50) 并列最高，
      // 按文档序稳定排在其后的是 90 分的 loginBtn
      eq(
        buttons.elements.map(e => cssOf(e.elementId)),
        ['a', '#saveBtn', '#loginBtn'],
        'buttons 模式精确采集 3 个可点击元素并按评分排序（输入控件不混入）',
      );
      check(typeof buttons.fingerprint === 'string' && buttons.fingerprint.length > 0, 'payload 携带页面指纹');

      const bySelector = new Map(buttons.elements.map(e => [cssOf(e.elementId), e]));
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
      eq(buttons.elements[0]?.elementId, link?.elementId, '下载链接按评分（+50）置顶');

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
        xp.elements.find(e => cssOf(e.elementId) === '#saveBtn')?.isHit,
        true,
        '容器级 xpath 经祖先链命中子按钮',
      );
      eq(
        xp.elements.find(e => cssOf(e.elementId) === '#saveBtn')?.matchedXpath,
        true,
        '子按钮 matchedXpath=true',
      );
      eq(
        xp.elements.find(e => cssOf(e.elementId) === '#loginBtn')?.matchedXpath,
        false,
        '链外元素 matchedXpath=false',
      );
      eq(cssOf(xp.elements[0]!.elementId), '#saveBtn', 'xpath 命中者置顶');

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
      eq(inputs.elements.length, 3, 'inputs 模式采集 input/select/textarea', inputs.elements.map(e => `${e.type}:${e.elementId}`));
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
        inputs.elements.some(e => cssOf(e.elementId) === '#loginBtn'),
        false,
        '按钮不混入输入元素采集',
      );

      const inputFiltered = serializedScan('inputs', '搜索', '');
      eq(inputFiltered.elements.filter(e => e.isHit).length, 1, 'inputs regex 命中 1 个');
      eq(inputFiltered.elements[0]?.elementId, textField?.elementId, '命中的文本框置顶');

      // —— enhance 荷载正常路径：点击 / 填充文本框 / 按 option 文本填充下拉 ——
      const clickOk = await serializedEnhance('click', ref('#loginBtn'));
      eq(clickOk.success, true, '点击未被遮挡的按钮成功', clickOk);

      const fillOk = await serializedEnhance('fill', ref('input[name="keyword"]'), 'hello world');
      eq(fillOk.success, true, '填充文本框成功', fillOk);
      eq(fillOk.finalValue, 'hello world', '填充值回读一致');

      const fillSelect = await serializedEnhance('fill', ref('#sel'), '选项A');
      eq(fillSelect.success, true, '按 option 文本填充下拉框成功', fillSelect);
      eq(fillSelect.finalValue, 'a', '下拉框选中值为 option 的 value');

      const fillMissing = await serializedEnhance('fill', '#does-not-exist', 'x');
      check(
        typeof fillMissing.error === 'string' && fillMissing.error.includes('STALE_ELEMENT'),
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

      const targetId = (envC.doc as any).__agentNexusReferences.register(envC.doc.getElementById('target'));
      const clickOccluded = await serializedEnhance('click', targetId);
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

  // —— 小结果：默认（省略 saveResult）也暂存，result 为全量 JSON 文本 ——
  setExecResult({ value: { ok: true, n: 1 }, rawJson: '{"ok":true,"n":1}' });
  const small = await execTool.execute({ code: 'return {ok:true,n:1}' });
  check(small.success, '小结果执行成功', small.error);
  const smallData = dataOf(small);
  check(!!smallData.dataRef, '默认（省略 saveResult）小结果也暂存');
  eq(smallData.dataRefTrigger, 'default', '省略参数触发标记为 default');
  eq(smallData.result, '{"ok":true,"n":1}', '小结果全量 JSON 封装进 result');
  eq(smallData.resultTruncated, undefined, '小结果无截断标记');

  // —— 小结果 + 显式 saveResult=false：跳过暂存，结构化值直接返回 ——
  setExecResult({ value: { ok: true, n: 2 }, rawJson: '{"ok":true,"n":2}' });
  const smallNoSave = await execTool.execute({ code: 'return {ok:true,n:2}', saveResult: false });
  check(smallNoSave.success, '显式 false 执行成功', smallNoSave.error);
  const smallNoSaveData = dataOf(smallNoSave);
  eq(smallNoSaveData.dataRef, undefined, 'saveResult=false 且 ≤2000 字符时不暂存');
  eq(smallNoSaveData.result, { ok: true, n: 2 }, '未暂存小结果全量结构化返回');

  // —— 超长结果：默认暂存 + 前 2000 字符预览 ——
  const bigRows = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, name: `商品-${i + 1}`, price: 9.9 + i }));
  const bigJson = JSON.stringify(bigRows);
  check(bigJson.length > 3000, '样本数据显著超过自动暂存阈值', bigJson.length);
  setExecResult({ value: bigRows, rawJson: bigJson });
  const auto = await execTool.execute({ code: 'return rows', label: '第1页' });
  check(auto.success, '超长结果执行成功', auto.error);
  const autoData = dataOf(auto);
  check(!!autoData.dataRef, '超 2000 字符默认暂存');
  eq(autoData.dataRefTrigger, 'default', '省略参数触发标记为 default');
  eq(autoData.resultType, 'json-preview', '暂存模式 resultType 为 json-preview');
  eq(autoData.result, bigJson.slice(0, 2000), 'result 为全量 JSON 前 2000 字符');
  eq((autoData.result as string).length, 2000, '预览恰好 2000 字符');
  eq(autoData.resultTruncated, true, '超长结果带 truncated 标记');
  eq(autoData.totalChars, bigJson.length, 'totalChars 为全量长度');
  eq(autoData.dataRef.label, '第1页', 'label 透传到自动暂存批次');
  eq(autoData.dataRef.rowCount, 150, 'dataRef 行数统计正确');
  check(String(autoData.dataRefGuide).includes('readRef'), '引导文案包含分页读取指引');
  check(String(autoData.dataRefGuide).includes('xlsx_tool'), '引导文案包含导出指引');
  check(String(autoData.dataRefGuide).includes('12 小时'), '引导文案标注有效期');
  check(
    JSON.stringify(autoData).length < 6000,
    '自动暂存响应总载荷有界（不含全量数据）',
    JSON.stringify(autoData).length,
  );
  const refId = String(autoData.dataRef.id);
  const storedEntry = await dataRefStore.get(refId);
  eq(storedEntry?.json, bigJson, '暂存区保存的是全量 JSON');

  // —— 超长结果 + 显式 saveResult=false：仍强制暂存（防截断丢失），trigger=auto ——
  setExecResult({ value: bigRows, rawJson: bigJson });
  const forcedAuto = await execTool.execute({ code: 'return rows', saveResult: false, label: '强制暂存' });
  check(forcedAuto.success, '显式 false 超长结果执行成功', forcedAuto.error);
  const forcedAutoData = dataOf(forcedAuto);
  check(!!forcedAutoData.dataRef, 'saveResult=false 超长结果仍自动暂存');
  eq(forcedAutoData.dataRefTrigger, 'auto', '显式 false 的强制暂存标记为 auto');

  // —— 显式 saveResult=true：小结果也暂存，trigger=explicit ——
  setExecResult({ value: { a: 1 }, rawJson: '{"a":1}' });
  const forced = await execTool.execute({ code: 'return {a:1}', saveResult: true });
  check(forced.success, '显式暂存执行成功', forced.error);
  const forcedData = dataOf(forced);
  check(!!forcedData.dataRef, 'saveResult=true 小结果也暂存');
  eq(forcedData.dataRefTrigger, 'explicit', '显式触发标记为 explicit');
  eq(forcedData.result, '{"a":1}', '小数据全部封装进 result');
  eq(forcedData.resultTruncated, undefined, '小数据无截断标记');

  // —— 返回值疑似错误对象：warnings 浮出提示，但原始结果不被改动 ——
  setExecResult({
    value: { message: 'API rate limit exceeded for 1.2.3.4.', documentation_url: 'https://docs.github.com/rest' },
    rawJson: '{"message":"API rate limit exceeded for 1.2.3.4.","documentation_url":"https://docs.github.com/rest"}',
  });
  const errShape = await execTool.execute({ code: 'return r', saveResult: false });
  check(errShape.success, '疑似错误对象：执行仍成功（只是提示）', errShape.error);
  const errShapeData = dataOf(errShape);
  check(
    Array.isArray(errShapeData.warnings) && String(errShapeData.warnings[0]).includes('疑似错误响应'),
    '疑似错误对象：warnings 携带浮出提示',
    errShapeData.warnings,
  );
  check(
    String(errShapeData.warnings?.[0]).includes('res.ok'),
    '疑似错误对象：提示指出 fetch 未检查 res.ok',
  );
  eq(
    (errShapeData.result as Record<string, unknown>).message,
    'API rate limit exceeded for 1.2.3.4.',
    '疑似错误对象：原始结果字段不被改动',
  );

  // 单字段错误对象（GitHub 限流最小形态）与中文关键词同样命中
  setExecResult({ value: { message: '请求被限流，请稍后再试' }, rawJson: '{"message":"请求被限流，请稍后再试"}' });
  const cnShape = await execTool.execute({ code: 'return e', saveResult: false });
  check(
    Array.isArray(dataOf(cnShape).warnings) && String(dataOf(cnShape).warnings[0]).includes('疑似错误响应'),
    '中文限流错误对象：同样浮出提示',
  );

  // 正常业务数据（含 message 字段但结构丰富、无错误信号）不得误报
  setExecResult({
    value: { message: '加载成功', items: [{ id: 1 }, { id: 2 }], total: 2 },
    rawJson: '{"message":"加载成功","items":[{"id":1},{"id":2}],"total":2}',
  });
  const normalShape = await execTool.execute({ code: 'return d', saveResult: false });
  eq(dataOf(normalShape).warnings, undefined, '正常业务数据（无错误信号）不误报');

  // 键数超过 4 的对象即便含 message 也不判错误形态（保守上限）
  const wideShape = { message: 'ok', a: 1, b: 2, c: 3, d: 4 };
  setExecResult({ value: wideShape, rawJson: JSON.stringify(wideShape) });
  const wideResult = await execTool.execute({ code: 'return w', saveResult: false });
  eq(dataOf(wideResult).warnings, undefined, '键数超限的宽对象不判错误形态');

  // —— 阈值边界（显式 false）：恰好 2000 不暂存、2001 强制暂存 ——
  const atJson = JSON.stringify('x'.repeat(1998)); // 1998 + 2 个引号 = 2000 字符
  eq(atJson.length, 2000, '边界样本恰好 2000 字符');
  setExecResult({ value: 'x'.repeat(1998), rawJson: atJson });
  const atLimit = await execTool.execute({ code: 'x', saveResult: false });
  eq(dataOf(atLimit).dataRef, undefined, 'saveResult=false 且恰好 2000 字符不暂存');
  const overJson = JSON.stringify('x'.repeat(1999)); // 2001 字符
  eq(overJson.length, 2001, '边界样本 2001 字符');
  setExecResult({ value: 'x'.repeat(1999), rawJson: overJson });
  const overLimit = await execTool.execute({ code: 'x', saveResult: false });
  check(!!dataOf(overLimit).dataRef, 'saveResult=false 时 2001 字符仍触发自动暂存');

  // —— 非法 saveResult 类型被拒绝 ——
  setExecResult({ value: { a: 1 }, rawJson: '{"a":1}' });
  const badSave = await execTool.execute({ code: 'return {a:1}', saveResult: 'yes' as unknown as boolean });
  check(!badSave.success && String(badSave.error).includes('saveResult'), '非布尔 saveResult 被拒绝', badSave.error);

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
  eq(dataOf(strayOffset).result, '7', '忽略 stray 参数后正常返回执行结果（默认暂存 → JSON 文本）');
  check(!!dataOf(strayOffset).dataRef, '默认暂存对 stray 参数场景同样生效');
  const noCode = await execTool.execute({});
  check(!noCode.success && String(noCode.error).includes('code'), '缺少 code 时给出可读错误', noCode.error);
  check(String(noCode.error).includes('readRef'), '缺参错误同时引导 readRef 模式', noCode.error);

  // —— 捕获失败（超上限）：输出降级为有界前缀并告警，不阻断执行结果 ——
  const bigValue = Array.from({ length: 80 }, (_, i) => ({ id: i, text: 'x'.repeat(60) }));
  setExecResult({
    value: bigValue,
    rawJsonError: '数据量 9999999 字符超过单次暂存上限 6000000——请在脚本内先筛选字段或限制条数后分批保存',
  });
  const overflow = await execTool.execute({ code: 'return hugeData', saveResult: false });
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

  // —— 默认暂存模式下同样的捕获失败：告警措辞为「数据暂存失败」——
  setExecResult({
    value: bigValue,
    rawJsonError: '数据量 9999999 字符超过单次暂存上限 6000000——请在脚本内先筛选字段或限制条数后分批保存',
  });
  const overflowDefault = await execTool.execute({ code: 'return hugeData' });
  check(
    Array.isArray(dataOf(overflowDefault).warnings) &&
      String((dataOf(overflowDefault).warnings as string[])[0]).includes('数据暂存失败'),
    '默认暂存意图下的捕获失败告警不静默',
    dataOf(overflowDefault).warnings,
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

  // —— 9b. 超时契约（30s 默认 / 300s 上限；描述、校验、引擎三处同源） ——
  {
    const {
      PAGE_EXEC_DEFAULT_TIMEOUT_MS,
      PAGE_EXEC_MAX_TIMEOUT_MS,
      PAGE_EXEC_ENGINE_TIMEOUT_MS,
      PAGE_EXEC_TIMEOUT_SAFETY_MS,
      normalizePageExecTimeout,
      validatePageExecTimeout,
      pageExecEngineTimeout,
    } = await import('../../tools/common/page-exec-timeout');

    eq(PAGE_EXEC_DEFAULT_TIMEOUT_MS, 30_000, '页面求值默认超时 30s');
    eq(PAGE_EXEC_MAX_TIMEOUT_MS, 300_000, '页面求值超时上限 300s');
    eq(
      PAGE_EXEC_ENGINE_TIMEOUT_MS,
      PAGE_EXEC_MAX_TIMEOUT_MS + PAGE_EXEC_TIMEOUT_SAFETY_MS,
      '引擎地板 = 工具上限 + 缓冲',
    );

    // 描述里的默认/上限必须来自契约常量（防三处漂移）
    const schemaDesc = String(execTool.openaiSchema.function.description);
    check(schemaDesc.includes(`默认 ${PAGE_EXEC_DEFAULT_TIMEOUT_MS}ms`), '工具描述含默认超时', schemaDesc.slice(0, 80));
    check(schemaDesc.includes(`上限 ${PAGE_EXEC_MAX_TIMEOUT_MS}ms`), '工具描述含上限超时');
    // 超时≠停止、禁止盲目重放：模型必须知道这两条，否则会重放写操作造成重复提交
    check(schemaDesc.includes('不中断脚本执行'), '工具描述说明超时≠停止', schemaDesc.slice(0, 120));
    check(schemaDesc.includes('禁止直接重放写操作'), '工具描述禁止盲目重放');
    check(schemaDesc.includes('window'), '工具描述说明迟到输出的回收通道');
    const timeoutParamDesc = String(
      (execTool.openaiSchema.function.parameters as { properties?: { timeout?: { description?: string } } })
        .properties?.timeout?.description ?? '',
    );
    check(timeoutParamDesc.includes(String(PAGE_EXEC_DEFAULT_TIMEOUT_MS)), 'timeout 参数描述含默认值');
    check(timeoutParamDesc.includes(String(PAGE_EXEC_MAX_TIMEOUT_MS)), 'timeout 参数描述含上限');

    // 严格校验：越界与非法类型拒绝并给出范围
    eq(validatePageExecTimeout(PAGE_EXEC_MAX_TIMEOUT_MS), null, '上限值本身合法');
    eq(validatePageExecTimeout(PAGE_EXEC_DEFAULT_TIMEOUT_MS), null, '默认值合法');
    check(!!validatePageExecTimeout(300_001), '超上限被拒绝');
    check(!!validatePageExecTimeout(999), '低于下限被拒绝');
    check(!!validatePageExecTimeout('30000'), '字符串 timeout 被拒绝');
    check(!!validatePageExecTimeout(NaN), 'NaN timeout 被拒绝');

    // 归一：合法值原样、越界收敛、非法回落默认
    eq(normalizePageExecTimeout(150_000), 150_000, '合法值原样');
    eq(normalizePageExecTimeout(999), 1_000, '低于下限收敛到下限');
    eq(normalizePageExecTimeout(1_000_000), PAGE_EXEC_MAX_TIMEOUT_MS, '超上限收敛到上限');
    eq(normalizePageExecTimeout(undefined), PAGE_EXEC_DEFAULT_TIMEOUT_MS, '未传回落默认');
    eq(normalizePageExecTimeout('x'), PAGE_EXEC_DEFAULT_TIMEOUT_MS, '非法类型回落默认');

    // 引擎超时：地板恒为 300s+缓冲（应用设置 1 分钟也压不掉），按参数再抬高
    const engineOneMinute = pageExecEngineTimeout({}, 60_000);
    eq(engineOneMinute, PAGE_EXEC_ENGINE_TIMEOUT_MS, '引擎地板不受低应用设置压制');
    const engineThirtyMinutes = pageExecEngineTimeout({}, 30 * 60_000);
    eq(engineThirtyMinutes, 30 * 60_000, '应用设置更高时从设置');
    const engineLongCall = pageExecEngineTimeout({ timeout: PAGE_EXEC_MAX_TIMEOUT_MS }, 60_000);
    eq(engineLongCall, PAGE_EXEC_MAX_TIMEOUT_MS + PAGE_EXEC_TIMEOUT_SAFETY_MS, '按传入 timeout 抬高');
    eq(
      pageExecEngineTimeout({ timeout: '300000' }, 60_000),
      PAGE_EXEC_ENGINE_TIMEOUT_MS,
      '脏 timeout 类型不注入引擎定时器（回落地板）',
    );

    // 工具校验与引擎计算共用同一契约：工具拒 300001，引擎也绝不为它放大
    check(!!validatePageExecTimeout(300_001), '工具层拒绝超上限值');
    check(
      pageExecEngineTimeout({ timeout: 300_001 }, 60_000) <= PAGE_EXEC_ENGINE_TIMEOUT_MS + PAGE_EXEC_TIMEOUT_SAFETY_MS,
      '引擎层对越界 timeout 收敛到契约内',
      pageExecEngineTimeout({ timeout: 300_001 }, 60_000),
    );

    // 工具执行路径：合法 timeout 放行，越界 timeout 在执行前被拒
    setExecResult({ value: 1, rawJson: '1' });
    const okTimeout = await execTool.execute({ code: 'return 1', timeout: PAGE_EXEC_MAX_TIMEOUT_MS });
    check(okTimeout.success, '300s timeout 被工具接受', okTimeout.error);
    const overTimeout = await execTool.execute({ code: 'return 1', timeout: 300_001 });
    check(!overTimeout.success && String(overTimeout.error).includes('300000'), '超上限 timeout 执行前被拒', overTimeout.error);
    const underTimeout = await execTool.execute({ code: 'return 1', timeout: 500 });
    check(!underTimeout.success && String(underTimeout.error).includes('1000'), '低于下限 timeout 执行前被拒', underTimeout.error);
  }

  await dataRefStore.remove('all');
  resetTabStub();
}

// ==================== 12. browser_get_page_text：结构化正文 + url + 分页 ====================

{
  const { GetPageTextTool } = await import('../../tools/base/page-info-tool');
  const { structuredPagePayload } = await import('../../tools/browser/structured-page-payload');
  const tool = new GetPageTextTool();

  // —— 12a. 荷载序列化自包含（干净作用域求值，闭包逃逸会在此 ReferenceError）——
  const serializedPayload = (0, eval)(`(${structuredPagePayload.toString()})`) as typeof structuredPagePayload;
  check(typeof serializedPayload === 'function', '结构化荷载序列化后可求值为函数');

  // —— 12b. 荷载真实行为（jsdom DOM）——
  {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM(
      `<!DOCTYPE html><html><body>
        <h1>主标题</h1>
        <p>段落一 <b>加粗</b> 与 <a href="https://example.com/x">链接</a>。</p>
        <div style="display:none">隐藏内容不应出现</div>
        <svg>SVGTEXT</svg>
        <table>
          <caption>价格表</caption>
          <tr><th rowspan="2">项目</th><th colspan="2">规格</th></tr>
          <tr><td>A</td><td>a|b</td></tr>
        </table>
        <ul><li>普通项<ol start="3"><li>嵌套</li></ol></li><li>尾项</li></ul>
        <menu><li>m1</li><li>m2</li></menu>
        <pre><code class="language-ts">const x = 1;</code></pre>
        <blockquote>引用文本</blockquote>
        <button>提交</button><input type="text" placeholder="搜索关键词">
        <img src="data:image/png;base64,AAAA" alt="噪声"><img src="/real.png" alt="图">
        <div data-host><span slot="x">被分发内容</span></div>
        <p>${'A'.repeat(250)}</p>
        <p>${'-'.repeat(80)}</p>
        <p data-noise></p>
        <table><caption>外层表</caption><tr><th>外A</th><th>外B</th></tr><tr><td data-outer-cell>外1<table><tr><td>内1</td></tr></table></td><td>外2</td></tr></table>
        <details open><summary>更多</summary><p>详情内容</p></details>
      </body></html>`,
      { pretendToBeVisual: true, url: 'https://fixture.example/page' },
    );
    const win = dom.window;
    const doc = win.document;
    const host = doc.querySelector('[data-host]') as HTMLElement;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p>影子内容</p><slot name="x"></slot>';
    // 带 shadow 的 h2（规范允许的 shadow 宿主）：宿主标题语义必须套用在 shadow 内容上
    const headingHost = doc.createElement('h2');
    doc.body.appendChild(headingHost);
    headingHost.attachShadow({ mode: 'open' }).innerHTML = '<span>影子标题</span>';
    // 直接经 DOM API 注入的文本不做解析期归一：验证 \r 与 PUA/零宽清洗
    const crlfCode = doc.createElement('pre');
    crlfCode.innerHTML = '<code class="language-py"></code>';
    (crlfCode.firstChild as HTMLElement).textContent = 'a\r\nb\r\nc';
    doc.body.appendChild(crlfCode);
    (doc.querySelector('[data-noise]') as HTMLElement).textContent = 'XY​Z W';

    const GLOBAL_KEYS = ['document', 'window', 'Node', 'Element', 'getComputedStyle'] as const;
    const savedGlobals = GLOBAL_KEYS.map(key => ({
      key,
      had: Object.prototype.hasOwnProperty.call(globalThis, key),
      value: (globalThis as Record<string, unknown>)[key],
    }));
    for (const key of GLOBAL_KEYS) (globalThis as Record<string, unknown>)[key] = (win as unknown as Record<string, unknown>)[key];
    try {
      const payload = serializedPayload();
      const md = payload.markdown;
      check(payload.url === 'https://fixture.example/page' && typeof payload.title === 'string', '荷载返回 frame 元数据');
      check(md.includes('# 主标题'), '标题层级保留');
      check(md.includes('**加粗**') && md.includes('[链接](https://example.com/x)'), '强调与链接目标保留');
      check(!md.includes('隐藏内容'), 'display:none 子树剔除');
      check(!md.includes('SVGTEXT'), 'svg 子树剔除');
      check(md.includes('**价格表**') && md.includes('| 项目 | 规格 |'), '表格 caption 与表头保留');
      check(md.includes('a\\|b'), '单元格竖线转义');
      check(md.includes('| --- | --- | --- |'), '表格分隔行生成');
      check(md.includes('- 普通项') && md.includes('3. 嵌套'), '列表嵌套与有序起始序号保留');
      check(md.includes('```ts\nconst x = 1;\n```'), '代码块语言识别');
      check(md.includes('> 引用文本'), '引用保留');
      check(md.includes('[提交]') && md.includes('[输入框: 搜索关键词]'), '按钮与输入框占位符保留');
      check(!md.includes('base64,AAAA') && !md.includes('![噪声]') && md.includes('/real.png'), 'data: 图片剔除、真实图片保留');
      check(md.includes('影子内容') && md.includes('被分发内容'), 'shadow root 与 slot 分发内容覆盖');
      check(md.includes('## 影子标题'), 'shadow 宿主的标题语义保留在 shadow 内容上');
      check(md.includes('```py\na\nb\nc\n```') && !md.includes('\r'), '代码块内 CRLF 归一为 LF');
      check(md.includes('XYZ W') && !md.includes(String.fromCharCode(0xE000)) && !md.includes(String.fromCharCode(0x2028)), 'PUA 剔除、零宽剔除、行分隔符归一为空格');
      check(md.includes('- m1') && md.includes('- m2'), 'menu 标签按无序列表处理');
      check((md.match(/^\|/gm) ?? []).length === 6 && md.includes('外1内1'), '嵌套表格不污染外层网格（两表各 3 行管线，内层数据并入所在单元格而非独立行）', md.match(/^\|.*$/gm));
      check(md.includes('［长编码串省略］') && !md.includes('A'.repeat(200)), '长编码串折叠');
      check(!md.includes('-'.repeat(60)) && md.includes('-…'), '同字符长连排收敛');
      check(md.includes('**更多**') && md.includes('详情内容'), 'details/summary 保留');
      check(!/\n\n\n/.test(md), '连续空行已收敛');
      check(!/ {3,}/.test(md.replace(/```[\s\S]*?```/g, '')), '围栏外连续空格已收敛');
    } finally {
      for (const item of savedGlobals) {
        if (item.had) (globalThis as Record<string, unknown>)[item.key] = item.value;
        else delete (globalThis as Record<string, unknown>)[item.key];
      }
    }
  }

  // —— 12c. 工具宿主行为（桩替换 executeScript / tabs）——
  const chromeStub = (globalThis as Record<string, unknown>).chrome as Record<string, unknown>;
  const tabsStub = chromeStub.tabs as Record<string, unknown>;
  const scriptingStub = chromeStub.scripting as Record<string, unknown>;
  const originalTabs = { ...tabsStub };
  const originalExecuteScript = scriptingStub.executeScript;
  const frameResult = (markdown: string, extra: Record<string, unknown> = {}) => ({
    frameId: 0,
    result: { markdown, truncated: false, shadowRoots: 0, url: 'https://example.com/', title: '', ...extra },
  });
  try {
    await dataRefStore.remove('all');
    scriptingStub.executeScript = (async () => [frameResult('# 短文\n\n正文段落。')]) as typeof scriptingStub.executeScript;

    // 短文：全量返回，不暂存
    resetTabStub();
    const short = await tool.execute({});
    const shortData = dataOf(short);
    check(short.success === true && shortData.textContent === '# 短文\n\n正文段落。', '短文全量返回');
    eq(shortData.page, 1, '短文页码为 1');
    eq(shortData.totalPages, 1, '短文总页数为 1');
    eq(shortData.totalChars, '# 短文\n\n正文段落。'.length, '短文 totalChars 准确');
    eq(shortData.ref, undefined, '短文不产生缓存引用');
    eq(shortData.hasMore, false, '短文无下一页');
    eq((await dataRefStore.list()).length, 0, '短文不污染暂存区');
    check(Array.isArray(shortData.coverage?.frames) && shortData.coverage.frames.length === 1, 'coverage.frames 保留');
    check(String(shortData.hint ?? '').includes('结构化'), '响应携带结构化说明 hint');

    // 多 frame：主 frame 置首 + FrameId 标头
    resetTabStub();
    scriptingStub.executeScript = (async () => [
      { frameId: 7, result: { markdown: 'iframe 正文', truncated: false, shadowRoots: 0, url: 'https://embed.example/', title: '嵌入' } },
      frameResult('主框架正文', { title: '主页面' }),
    ]) as typeof scriptingStub.executeScript;
    const multi = await tool.execute({});
    const multiData = dataOf(multi);
    check(
      String(multiData.textContent).startsWith('# 主页面') &&
        String(multiData.textContent).includes('[FrameId=0 | https://example.com/]') &&
        String(multiData.textContent).includes('[FrameId=7 | https://embed.example/]') &&
        String(multiData.textContent).indexOf('主框架正文') < String(multiData.textContent).indexOf('iframe 正文'),
      '多 frame：标题 + FrameId 标头 + 主 frame 置首',
      multiData.textContent?.slice(0, 120),
    );

    // 空 frame 不进入正文段：只剩一个有内容的 frame 时不加 FrameId 标头
    resetTabStub();
    scriptingStub.executeScript = (async () => [
      frameResult('唯一有内容的 frame 正文', { title: '页' }),
      { frameId: 3, result: { markdown: '', truncated: false, shadowRoots: 0, url: 'https://empty.example/', title: '' } },
    ]) as typeof scriptingStub.executeScript;
    const withEmpty = await tool.execute({});
    const withEmptyData = dataOf(withEmpty);
    check(
      String(withEmptyData.textContent).startsWith('# 页') && !String(withEmptyData.textContent).includes('[FrameId='),
      '空 frame 不产生标头：唯一内容 frame 直接输出正文',
      withEmptyData.textContent?.slice(0, 80),
    );
    check(withEmptyData.coverage?.frames?.length === 2, 'coverage 仍保留空 frame 记录');

    // 超长：自动缓存 ref + 分页（含代理项边界：页界恰逢增补平面前半）
    resetTabStub();
    const emojiDoc = 'a'.repeat(14999) + '🙂'.repeat(10) + 'b'.repeat(1000);
    scriptingStub.executeScript = (async () => [frameResult(emojiDoc)]) as typeof scriptingStub.executeScript;
    const long1 = await tool.execute({});
    const long1Data = dataOf(long1);
    check(typeof long1Data.ref === 'string' && long1Data.ref.length === 8, '超长正文返回 8 位 ref');
    eq(long1Data.totalPages, 2, '超长正文总页数为 2');
    eq(long1Data.page, 1, '默认返回第 1 页');
    eq(long1Data.hasMore, true, '第 1 页 hasMore=true');
    eq(long1Data.nextPage, 2, 'nextPage=2');
    eq(long1Data.textContent, emojiDoc.slice(0, 14999), '第 1 页在代理项边界回退（不含半个 🙂）');
    check(String(long1Data.refGuide ?? '').includes('page=2'), 'refGuide 给出续读调用');
    eq((await dataRefStore.list()).length, 1, '超长正文已入暂存区');

    // ref 分页续读：不访问页面（executeScript 抛错也不影响）
    scriptingStub.executeScript = (async () => { throw new Error('ref 模式不应注入页面'); }) as typeof scriptingStub.executeScript;
    const long2 = await tool.execute({ ref: long1Data.ref as string, page: 2 });
    const long2Data = dataOf(long2);
    check(long2.success === true && long2Data.source === 'ref', 'ref 模式读取成功且标记 source=ref');
    eq(long2Data.page, 2, 'ref 模式返回指定页');
    eq(long2Data.hasMore, false, '末页 hasMore=false');
    eq(
      (long1Data.textContent as string) + (long2Data.textContent as string),
      emojiDoc,
      '两页拼接无损还原全文（代理项跨页配对）',
    );

    // 直接指定 page>1（现场提取 + 缓存后返回该页）
    resetTabStub();
    scriptingStub.executeScript = (async () => [frameResult(emojiDoc)]) as typeof scriptingStub.executeScript;
    const page2Direct = await tool.execute({ page: 2 });
    check(page2Direct.success === true && dataOf(page2Direct).page === 2, '直接指定页码返回该页');
    eq(dataOf(page2Direct).textContent, emojiDoc.slice(14999), '第 2 页从被回退的代理项前半开始');

    // 参数与模式互斥防御
    const conflicts = [
      [{ ref: 'abcd1234', url: 'https://example.com/' }, /互斥/],
      [{ ref: 'abcd1234', tabId: 1 }, /互斥/],
      [{ url: 'https://example.com/', tabId: 1 }, /互斥/],
      [{ url: 'ftp://example.com/' }, /http\/https/],
      [{ url: ['https://example.com/'] }, /单个 URL/],
      [{ url: 'https://example.com/' + 'a'.repeat(9000) }, /url 过长/],
      [{ ref: 123 }, /字符串/],
      [{ page: 0 }, /≥1/],
      [{ page: 'abc' }, /≥1/],
      [{ tabId: -1 }, /非负整数/],
      [[1, 2], /参数必须是对象/],
      [null, /参数必须是对象/],
      ['x', /参数必须是对象/],
    ] as const;
    for (const [badArgs, pattern] of conflicts) {
      const rejected = await tool.execute(badArgs as never);
      check(rejected.success === false && pattern.test(rejected.error ?? ''), `参数防御：${JSON.stringify(badArgs)}`, rejected.error);
    }

    // 页码越界：现场与缓存两条路径都给出可自纠的范围提示
    resetTabStub();
    scriptingStub.executeScript = (async () => [frameResult('# 短文')]) as typeof scriptingStub.executeScript;
    const outOfRange = await tool.execute({ page: 5 });
    check(outOfRange.success === false && /超出范围/.test(outOfRange.error ?? ''), '现场页码越界报错', outOfRange.error);
    const refOutOfRange = await tool.execute({ ref: long1Data.ref as string, page: 99 });
    check(refOutOfRange.success === false && /超出范围/.test(refOutOfRange.error ?? ''), '缓存页码越界报错', refOutOfRange.error);

    // ref 指向非本工具批次（records 数据）与不存在的引用
    const alien = await dataRefStore.save([{ a: 1 }], '脚本批次');
    if (alien.ok) {
      const wrongKind = await tool.execute({ ref: alien.meta.id });
      check(wrongKind.success === false && /不是 browser_get_page_text 的页面正文批次/.test(wrongKind.error ?? ''), '拒绝读取其它工具的数据批次', wrongKind.error);
    }
    const missingRef = await tool.execute({ ref: 'zzzzzzzz' });
    check(missingRef.success === false && /不存在或已过期/.test(missingRef.error ?? ''), '不存在的 ref 报错', missingRef.error);

    // url 模式：后台建标签页 → 提取 → 关闭
    resetTabStub();
    let createdTabId = 0;
    const removedTabIds: number[] = [];
    let injectedTabId = 0;    let createdActive: boolean | undefined;
    tabsStub.create = (async (props: { url?: string; active?: boolean }) => {
      createdTabId = 99;
      createdActive = props.active;
      return { id: 99, url: props.url, status: 'complete' };
    }) as typeof tabsStub.create;
    tabsStub.get = (async (tabId: number) => ({ id: tabId, url: 'https://target.example/', status: 'complete' })) as typeof tabsStub.get;
    tabsStub.remove = (async (tabId: number) => { removedTabIds.push(tabId); }) as typeof tabsStub.remove;
    scriptingStub.executeScript = (async (options: { target?: { tabId?: number } }) => {
      injectedTabId = options?.target?.tabId ?? 0;
      return [frameResult('# 目标页\n\n内容', { url: 'https://target.example/' })];
    }) as typeof scriptingStub.executeScript;
    const byUrl = await tool.execute({ url: 'https://target.example/' });
    const byUrlData = dataOf(byUrl);
    check(
      byUrl.success === true && createdTabId === 99 && injectedTabId === 99 && createdActive === true,
      'url 模式：前台打开（激活标签页）后提取，标签页保留不关闭',
      { createdTabId, injectedTabId, createdActive, removedTabIds },
    );
    check(
      !removedTabIds.includes(99),
      'url 模式：不得自动关闭用户可见的标签页（人机验证需用户手动完成）',
      { removedTabIds },
    );
    check(String(byUrlData.textContent).includes('# 目标页') && byUrlData.url === 'https://target.example/', 'url 模式正文与元数据正确');

    // url 与当前活动标签页完全同址：直接读当前页，不开重复标签页
    resetTabStub();
    let dedupCreated = 0, dedupInjected = 0;
    tabsStub.create = (async () => { dedupCreated++; return { id: 55, url: 'about:blank' }; }) as typeof tabsStub.create;
    tabsStub.remove = (async () => undefined) as typeof tabsStub.remove;
    scriptingStub.executeScript = (async (options: { target?: { tabId?: number } }) => {
      dedupInjected = options?.target?.tabId ?? 0;
      return [frameResult('# 当前页', { title: '当前页' })];
    }) as typeof scriptingStub.executeScript;
    const dedup = await tool.execute({ url: 'https://example.com/' });
    check(
      dedup.success === true && dedupCreated === 0 && dedupInjected === 1,
      'url 与当前页同址时去重：不开新标签页、直接注入当前标签页',
      { dedupCreated, dedupInjected },
    );

    // 人机验证 / 风控拦截页：必须显式告知模型「需要人工验证」，不得把挑战页
    // 文本当作正文事实静默返回
    resetTabStub();
    tabsStub.create = (async (props: { url?: string }) => ({ id: 77, url: props.url, status: 'complete' })) as typeof tabsStub.create;
    tabsStub.get = (async (tabId: number) => ({ id: tabId, url: 'https://guarded.example/', status: 'complete' })) as typeof tabsStub.get;
    scriptingStub.executeScript = (async () => [
      frameResult('# Just a moment...\n\n正在进行安全验证，请稍候。', { url: 'https://guarded.example/', title: 'Just a moment...' }),
    ]) as typeof scriptingStub.executeScript;
    const challenged = await tool.execute({ url: 'https://guarded.example/' });
    const challengedData = dataOf(challenged);
    check(
      challenged.success === true && challengedData.verificationRequired === true,
      '人机验证页：显式标记 verificationRequired',
      challengedData,
    );
    check(
      Array.isArray(challengedData.warnings) && challengedData.warnings.some((w: string) => /人机验证/.test(w)),
      '人机验证页：warnings 说明需人工验证',
      challengedData.warnings,
    );

    // 误判防线：正常短文里出现「安全验证」「请稍候」等通用措辞**不得**被判成
    // 验证页——把真实内容当验证页丢弃，比漏判更糟
    resetTabStub();
    tabsStub.create = (async (props: { url?: string }) => ({ id: 78, url: props.url, status: 'complete' })) as typeof tabsStub.create;
    tabsStub.get = (async (tabId: number) => ({ id: tabId, url: 'https://normal.example/', status: 'complete' })) as typeof tabsStub.get;
    scriptingStub.executeScript = (async () => [
      frameResult(
        '# 登录安全验证指南\n\n许多站点在登录前会弹出安全验证，请稍候片刻再继续。这是正常说明文。',
        { url: 'https://normal.example/', title: '登录安全验证指南' },
      ),
    ]) as typeof scriptingStub.executeScript;
    const normalPage = await tool.execute({ url: 'https://normal.example/' });
    const normalData = dataOf(normalPage);
    check(
      normalPage.success === true && normalData.verificationRequired === undefined,
      '正常短文含验证类措辞：不得误判为验证页',
      normalData,
    );

    // 复用来的标签页在等待期间被用户关掉：必须放弃复用、转走新建分支，
    // 而不是拿着已消失的 tabId 去注入（只会得到一句无信息量的报错）
    resetTabStub();
    let createdAfterVanish = 0;
    tabsStub.query = (async () => [
      { id: 66, url: 'https://vanish.example/', status: 'complete', windowId: 1 },
    ]) as typeof tabsStub.query;
    tabsStub.update = (async () => undefined) as typeof tabsStub.update;
    tabsStub.get = (async (tabId: number) => {
      if (tabId === 66) throw new Error('tab gone');
      return { id: tabId, url: 'https://vanish.example/', status: 'complete', windowId: 1 };
    }) as typeof tabsStub.get;
    tabsStub.create = (async (props: { url?: string }) => {
      createdAfterVanish++;
      return { id: 79, url: props.url, status: 'complete' };
    }) as typeof tabsStub.create;
    scriptingStub.executeScript = (async (options: { target?: { tabId?: number } }) => {
      if (options?.target?.tabId !== 79) throw new Error('injected into a dead tab');
      return [frameResult('# 新开的页面', { url: 'https://vanish.example/' })];
    }) as typeof scriptingStub.executeScript;
    const afterVanish = await tool.execute({ url: 'https://vanish.example/' });
    check(
      afterVanish.success === true && createdAfterVanish === 1 && String(dataOf(afterVanish).textContent).includes('新开的页面'),
      '复用标签页消失：转走新建分支并从新标签页提取',
      { createdAfterVanish, error: afterVanish.error },
    );
    resetTabStub();
    // 还原注入桩：后续用例（受限页面等）依赖各自的脚本注入行为
    scriptingStub.executeScript = (async () => [frameResult('# 目标页\n\n内容', { url: 'https://target.example/' })]) as typeof scriptingStub.executeScript;
    tabsStub.query = originalTabs.query;

    // 受限页面（chrome://）拒绝注入
    resetTabStub();
    tabStub.tabs = [{ id: 1, url: 'chrome://settings/', status: 'complete', windowId: 1 }];
    const restricted = await tool.execute({});
    check(restricted.success === false && /restricted URL/.test(restricted.error ?? ''), '受限页面拒绝并提示', restricted.error);
  } finally {
    Object.assign(tabsStub, originalTabs);
    scriptingStub.executeScript = originalExecuteScript;
    await dataRefStore.remove('all');
    resetTabStub();
  }
}

// ==================== 2c. 成功响应载荷单份契约（buildSuccessPayload） ====================

{
  const { buildSuccessPayload } = await import('../../common/tool-handler');
  const big = '正文内容'.repeat(2_000); // 约 8000 字符，模拟页面正文
  const payload = buildSuccessPayload({ textContent: big, totalChars: big.length, ok: true }, '已提取正文');
  const contentText = (payload.content[0]?.text ?? '');
  // content 是摘要、不是 data 的副本——同一份载荷在模型上下文里只出现一次
  check(contentText !== JSON.stringify(payload.data, null, 2), 'content 不是 data 的 JSON 副本');
  check(payload.data.textContent === big, 'data 承载完整载荷（信息不丢）');
  check(
    !contentText.includes(big.slice(0, 500)),
    'content 不复制正文（正文只在 data 里）',
    contentText.slice(0, 120),
  );
  check(contentText.includes('已提取正文'), 'content 保留一句话结论（message）');
  check(
    contentText.includes('textContent') && contentText.includes('totalChars'),
    'content 给出字段名清单，模型知道去 data 翻哪个键',
    contentText,
  );
  // 小载荷不必附字段清单（否则摘要只是等量复制）
  const small = buildSuccessPayload({ ok: true }, '完成');
  eq((small.content[0]?.text ?? ''), '完成', '小载荷的 content 就是 message');

  // 防御：载荷含循环引用时摘要降级为纯 message，绝不让「算摘要」把整次
  // 工具调用带崩（载荷本身仍原样在 data 里）
  const cyclic: Record<string, unknown> = { note: '循环引用载荷' };
  cyclic.self = cyclic;
  let cyclicPayload: ReturnType<typeof buildSuccessPayload> | null = null;
  try {
    cyclicPayload = buildSuccessPayload(cyclic, '带循环引用');
  } catch (error) {
    check(false, '循环引用载荷：buildSuccessPayload 不得抛错', String(error));
  }
  if (cyclicPayload) {
    eq((cyclicPayload.content[0]?.text ?? ''), '带循环引用', '循环引用载荷：摘要降级为纯 message');
    eq((cyclicPayload.data as Record<string, unknown>).note, '循环引用载荷', '循环引用载荷：data 原样承载');
  }
}

// ==================== 2d. 对外载荷投影（projectToolPayload / primary 通道） ====================
// 外部调用方与工具面板共用同一口径：哪条通道是正题由生产者声明，
// 消费方只取一份——同一份事实不在外部响应里出现两次，也不丢信息。

{
  const { projectToolPayload, primaryChannelOf, extractContentText, buildSuccessPayload } =
    await import('../../common/tool-handler');

  // ① 默认（正题在 data）：返回 data，且不再重复 content 里的摘要
  const viaPayload = buildSuccessPayload({ textContent: '正文' }, '已读取');
  eq(primaryChannelOf(viaPayload), 'data', 'buildSuccessPayload 声明 data 为正题');
  const projectionData = projectToolPayload({ success: true, ...viaPayload });
  eq(projectionData.kind, 'payload', '默认结果可投影');
  if (projectionData.kind === 'payload') {
    eq(projectionData.value.textContent, '正文', '默认投影返回 data');
    check(!JSON.stringify(projectionData.value).includes('完整载荷见 data'), '投影不带 content 摘要（不双份）');
  }

  // ② 正题在 content（如 web_search 结果表）：返回「元数据 + 正文」，两边不丢
  const searchLike = {
    success: true,
    primary: 'content' as const,
    content: [{ type: 'text' as const, text: '| title |\n| --- |\n| a |' }],
    data: { navigation: { success: true }, results: { count: 1 } },
  };
  eq(primaryChannelOf(searchLike), 'content', 'primary 显式声明 content');
  const projectionContent = projectToolPayload(searchLike);
  eq(projectionContent.kind, 'payload', 'content 正题结果可投影');
  if (projectionContent.kind === 'payload') {
    eq(projectionContent.value.text, '| title |\n| --- |\n| a |', '投影保留正文');
    eq((projectionContent.value.results as { count?: number })?.count, 1, '投影保留事实元数据');
  }

  // ③ 历史形态（content 里放的是 data 的 JSON 副本）：按原样返回，老客户端不变
  const legacy = {
    success: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ a: 1 }, null, 2) }],
  };
  const projectionLegacy = projectToolPayload(legacy);
  eq(projectionLegacy.kind, 'payload', '历史形态可投影');
  if (projectionLegacy.kind === 'payload') {
    eq(projectionLegacy.value.a, 1, '历史形态按原样返回解析结果');
  }

  // ④ 正题在 content、data 只有元数据：可读原因在正文，元数据一并保留
  //    （note/plan 的失败形态；会话引擎另按 success=false 保证 error 字段在场）
  const structuredFailure = projectToolPayload({
    success: false,
    isError: true,
    error: '原因：X',
    data: { errorKind: '参数错误' },
    primary: 'content' as const,
    content: [{ type: 'text' as const, text: '失败原因与处置建议' }],
  });
  eq(structuredFailure.kind, 'payload', '有 data 的失败结果同样可投影');
  if (structuredFailure.kind === 'payload') {
    eq(structuredFailure.value.errorKind, '参数错误', '失败结果保留错误元数据');
    eq(structuredFailure.value.text, '失败原因与处置建议', '失败结果保留可读正文');
  }

  // ⑤ 两者皆无的错误结果：抛出可读错误，而不是吞成空对象
  const bareError = projectToolPayload({ success: false, isError: true, error: '彻底失败' });
  eq(bareError.kind, 'error', '无载荷的错误结果应抛出');
  if (bareError.kind === 'error') eq(bareError.error, '彻底失败', '错误信息可读');

  // ⑥ 空结果：不抛错，返回空载荷
  const empty = projectToolPayload({ success: true });
  eq(empty.kind, 'payload', '空结果不抛错');

  // ⑦ extractContentText：只取文本块、跳过图片等非文本块，非数组输入不炸
  eq(extractContentText(undefined), '', '缺失 content 返回空串');
  eq(extractContentText(null as unknown as undefined), '', 'null content 返回空串');
  eq(extractContentText('not-an-array' as unknown as undefined), '', '非数组 content 返回空串');
  eq(
    extractContentText([
      { type: 'text', text: '第一段' },
      { type: 'image', source: { type: 'base64' } } as never,
      { type: 'text', text: '第二段' },
      { type: 'text', text: 123 as unknown as string },
    ]),
    '第一段\n第二段',
    '只拼接文本块并跳过非法文本',
  );
}

// ==================== 汇总 ====================
await import('./wait-navigation.test');
await import('./vision-gui.test');
await import('./confirmation.test');
await import('./vision-assistant.test');
await import('./prompt-cache.test');
await import('./agent-i18n.test');
await import('./agent-image.test');
await import('./plan.test');
await import('./vision-context-e2e.test');
await import('./vision-capability-guard.test');
await import('./xlsx-dataref.test');
await import('./upload-file.test');
await import('./tool-execution-engine.test');
await import('./tool-execution-contract.test');
await import('./protocol-continuity.test');


console.log(`\n[tools] 通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
