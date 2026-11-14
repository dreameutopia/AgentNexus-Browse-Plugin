/**
 * 搜索工具共享基类（web_search / platform_search）
 *
 * 三个工具的行为完全同构：一次调用完成「导航到搜索结果页 → 等待加载 →
 * 结构化解析 → Markdown 表」。差异只有三处——目标集合（引擎 vs 站点平台）、
 * 目标参数名（engine vs platform）、面向模型的文案。因此执行链路收敛在本
 * 基类，两个具体工具只声明差异面，避免两处各写一套随时间漂移的导航/解析逻辑。
 *
 * 执行上下文：sidepanel 与 background（service worker）均可运行——导航直接走
 * chrome.tabs（create/update），不经 browser_navigation，规避其上下文限制与
 * 整工具转发；chrome.scripting / chrome.tabs.sendMessage 两上下文同样原生可用。
 *
 * 结果契约（两部分独立封装，解析失败绝不吞掉导航事实）：
 *   data.target     —— 实际检索的目标 id（工具的枚举参数名对应：engine / platform；
 *                      专属工具没有目标参数时，这里记录它固定的站点）；
 *   data.query      —— 归一化后的关键词；
 *   data.searchEngine —— 目标来源标识（Baidu / Bing / Zhihu / Bilibili …）；
 *   data.navigation —— 是否成功导航 + 当前实际网址（重定向后的最终 URL）+ 标签页；
 *   data.results    —— 解析产物（success/count/hint）；条目本体只经 content 的
 *                      Markdown 表承载一份（data 里不再重复，避免模型上下文双份
 *                      回传）；失败时 success=false 并给出提示（页面已就位，模型
 *                      可用 browser_get_page_text 自行读取解析），不影响 navigation
 *                      的封装与整体 success。
 *   content[0].text —— 解析成功时为 Markdown 结果表（唯一一份），否则为状态消息。
 *                      条目本体只在这里承载（data.results 不重复条目），
 *                      因此 primary='content'：正题在 content，data 是事实元数据。
 *   可信度不做机器分级：模型按来源域名自行判断一手源与二手转述（见工具描述）。
 *
 * 中止语义：用户中断 / 会话停止时**尽快收敛**——导航等待、额外等待、内容脚本
 * 响应等待都监听 ToolExecutionContext.signal，中止即返回可读的失败结果
 * （沿用 generic_wait 的约定：返回失败结果而非抛错），不把 30s 的轮询拖满。
 */

import { BaseTool } from '../base-tool';
import type { ToolExecutionContext } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { resultsToMarkdownTable } from '../common/markdown-table';
import {
  SEARCH_TARGETS,
  isSearchTargetId,
  type SearchTargetConfig,
  type SearchTargetId,
} from './search-targets';

/**
 * 中止专用错误：用类标记而不是消息子串（"被中断"）判断中断——
 * 第三方错误文本可能碰巧含同样字样，字符串匹配会把真实解析失败
 * 误判成「用户取消」。消息本身仍是可读的人话，模型与日志直接消费。
 */
class AbortedError extends Error {}

/** query 长度上限（字符）：搜索关键词天然短，超长输入视为脏参数 */
const QUERY_MAX_LENGTH = 300;
/** 导航后等待页面 load 完成的轮询间隔 */
const LOAD_POLL_INTERVAL_MS = 400;
/** 页面加载等待上限（毫秒）：超时不判失败——页面可能仍可解析，如实上报状态 */
const LOAD_TIMEOUT_MS = 30_000;
/** 内容脚本消息响应等待上限（毫秒） */
const SCRIPT_MESSAGE_TIMEOUT_MS = 30_000;
/** waitTime 参数的合法区间 */
const WAIT_TIME_MIN_MS = 0;
const WAIT_TIME_MAX_MS = 10_000;
const WAIT_TIME_DEFAULT_MS = 3_000;

/**
 * 导航结果（恒定封装，解析成败不影响其字段） */
export interface NavigationOutcome {
  success: boolean;
  /**
   * complete：status 到达 complete；timeout：等待超时但标签页存活（页面可能仍可用）；
   * error：导航硬失败（标签页未创建/更新失败/标签页消失）
   */
  status: 'complete' | 'timeout' | 'error';
  /** 当前实际网址（重定向后的最终 URL；无法读取时回退 searchUrl） */
  url: string;
  /** 本工具构造的搜索 URL */
  searchUrl: string;
  tabId: number | null;
  newTab: boolean;
  /** 失败/超时的补充说明（面向模型） */
  note?: string;
}

/** 解析结果（失败时仅提示，不拖垮导航封装） */
export interface ParseOutcome {
  success: boolean;
  count: number;
  items: unknown[];
  markdown?: string;
  /** 失败原因 / 空结果提示（面向模型） */
  hint?: string;
}

/**
 * 具体搜索工具的差异面（基类据此调整参数校验与文案）
 */
export interface SearchToolSpec {
  /** 目标集合（引擎 / 站点平台 / 专属目标） */
  targets: readonly SearchTargetId[];
  /**
   * 固定目标（专属工具）：声明后 schema **不含**目标参数——调用方只能传
   * query 等通用参数，目标由工具自己决定（专属工具只服务一个站点，
   * 让模型再选一次目标没有意义）。
   *
   * 防御：调用方若仍传了目标参数，必须与固定目标一致，否则明确报错——
   * 静默忽略会让「模型以为在搜 A、实际搜了 B」这类偏差无从察觉。
   */
  fixedTarget?: SearchTargetId;
  /** 目标参数名：engine（通用搜索引擎）/ platform（站点平台） */
  paramName: 'engine' | 'platform';
  /** 目标参数的中文名（引擎 / 站点平台） */
  paramLabel: string;
  /** 目标集合的中文总称（搜索引擎 / 站点平台） */
  targetKindLabel: string;
}

export abstract class BaseSearchTool extends BaseTool {
  /** 差异面（子类声明） */
  protected abstract readonly spec: SearchToolSpec;
  /** 工具描述主体（子类撰写：能力边界 + 并发禁令 + 结果契约） */
  protected abstract readonly usageDescription: string;
  /**
   * 目标参数选择指引（仅在 schema 含目标参数时有意义；专属工具可省略）。
   * 枚举清单由基类按注册表生成，此处只写「怎么选」。
   */
  protected readonly paramDescription?: string;

  /**
   * 目标的展示名（注册表缺失时回落 id）。
   *
   * 防御：schema 在**类初始化期**组装（模块加载即执行），此处若因配置疏漏
   * 让 undefined 渗进 `.label`，崩的将是整个扩展的加载过程——远比一次调用
   * 失败严重。回落成 id 只影响文案可读性，不会拖垮启动。
   */
  private targetLabel(id: SearchTargetId): string {
    const target = SEARCH_TARGETS[id] as SearchTargetConfig | undefined;
    return target?.label ?? id;
  }

  /**
   * 组装 OpenAI Schema：结构共用（目标参数 + query + newTab + waitTime），
   * 描述与枚举文案由子类注入——枚举值一律取自注册表 id 数组，杜绝手抄漂移。
   *
   * 专属工具（spec.fixedTarget）：schema **不含**目标参数——目标由工具固定，
   * 模型只需给关键词；required 也相应只有 query。
   *
   * 防御：子类字段初始化顺序若把 openaiSchema 写在 spec 之前，本方法会读到
   * 未初始化的 spec——这里显式抛出可读错误，而不是让 undefined 渗进 schema。
   */
  protected buildOpenAISchema(name: string): OpenAITool {
    const spec = this.spec;
    // 运行时防御走 unknown 快照：Array.isArray 直接作用在声明类型上会把
    // readonly SearchTargetId[] 窄化成 any[]，污染后续所有类型推断
    const rawTargets: unknown = spec ? spec.targets : undefined;
    if (!spec || !Array.isArray(rawTargets) || rawTargets.length === 0) {
      throw new Error(`搜索工具 ${name} 的目标集合未声明或为空（spec 配置缺陷）`);
    }
    const { paramName, paramLabel, targets, targetKindLabel, fixedTarget } = spec;
    const properties: Record<string, unknown> = {};
    if (!fixedTarget) {
      properties[paramName] = {
        type: 'string',
        enum: [...targets],
        // 枚举清单由注册表派生（防手抄漂移），选择指引由子类补充——
        // 两者拼接，缺一不可：清单告诉模型「有哪些」，指引告诉它「怎么选」
        description:
          `目标${paramLabel}（枚举值，小写）：` +
          targets.map(id => `${id}=${this.targetLabel(id)}`).join('、') +
          `（${targetKindLabel}共 ${targets.length} 个）。` +
          (this.paramDescription ?? ''),
      };
    }
    properties.query = {
      type: 'string',
      description: '搜索关键词（必填，去除首尾空白，最长 300 字符）',
    };
    properties.newTab = {
      type: 'boolean',
      description:
        '是否在新标签页打开搜索结果（默认 true）。连续多轮搜索可传 false 直接复用当前标签页，避免标签页堆积',
    };
    properties.waitTime = {
      type: 'integer',
      description: `页面加载完成后的额外等待毫秒数（0-${WAIT_TIME_MAX_MS}，默认 ${WAIT_TIME_DEFAULT_MS}）：动态内容较多的站点可适当调大以保证结果渲染`,
    };
    return {
      type: 'function',
      function: {
        name,
        description: this.usageDescription,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties,
          required: fixedTarget ? ['query'] : [paramName, 'query'],
        },
      },
    };
  }

  async execute(rawArgs: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
    const spec = this.spec;
    // 运行时防御走 unknown 快照：Array.isArray 直接作用在声明类型上会把
    // readonly SearchTargetId[] 窄化成 any[]，污染后续所有类型推断
    const rawTargets: unknown = spec ? spec.targets : undefined;
    if (!spec || !Array.isArray(rawTargets) || rawTargets.length === 0) {
      return this.createErrorResponse('搜索目标集合未配置（工具配置缺陷，无法执行）');
    }
    const { paramName, paramLabel, targets, targetKindLabel, fixedTarget } = spec;
    const signal = context?.signal;

    // ── 参数防御：形态校验先于一切副作用 ──
    const args =
      rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : null;
    if (!args) {
      return this.createErrorResponse(`参数必须是 JSON 对象（${paramName} / query 必填）`);
    }
    // ── 目标解析 ──
    // 专属工具：目标固定；调用方若仍传了目标参数，必须与固定目标一致
    // （静默忽略会让「模型以为在搜 A、实际搜了 B」的偏差无从察觉）。
    let targetId: SearchTargetId;
    if (fixedTarget) {
      const provided =
        typeof args[paramName] === 'string'
          ? (args[paramName] as string).trim().toLowerCase()
          : '';
      if (provided && provided !== fixedTarget) {
        return this.createErrorResponse(
          `${this.name} 只支持 ${fixedTarget}，不接受 ${paramName}=${JSON.stringify(provided)}`,
        );
      }
      targetId = fixedTarget;
    } else {
      const raw =
        typeof args[paramName] === 'string'
          ? (args[paramName] as string).trim().toLowerCase()
          : '';
      // 目标 id 既要在注册表内，也要属于本工具的类别（引擎工具不接站点平台）
      if (!isSearchTargetId(raw) || !targets.includes(raw)) {
        return this.createErrorResponse(
          `不支持的${targetKindLabel}：${JSON.stringify(args[paramName] ?? '')}。${this.name} 仅支持 ${targets.join(' / ')}，请从 ${paramName} 的枚举值中选择`,
        );
      }
      targetId = raw;
    }
    // 防御：目标必须已登记在注册表（专属工具写错 fixedTarget 时给出可读的配置
    // 错误，而不是让 undefined 渗进后续字段访问）
    const target = SEARCH_TARGETS[targetId] as SearchTargetConfig | undefined;
    if (!target) {
      return this.createErrorResponse(`搜索目标 "${targetId}" 未在注册表中登记（工具配置缺陷）`);
    }
    if (typeof args.query !== 'string' || !args.query.trim()) {
      return this.createErrorResponse(`query 必填且为非空字符串（${target.label}）`);
    }
    const query = args.query.trim();
    if (query.length > QUERY_MAX_LENGTH) {
      return this.createErrorResponse(`query 过长（${query.length} 字符，上限 ${QUERY_MAX_LENGTH}），请精简关键词`);
    }
    const newTab = args.newTab !== false;
    const waitTimeRaw = Number(args.waitTime);
    const waitTime = Number.isFinite(waitTimeRaw)
      ? Math.min(Math.max(Math.floor(waitTimeRaw), WAIT_TIME_MIN_MS), WAIT_TIME_MAX_MS)
      : WAIT_TIME_DEFAULT_MS;

    // 调用前已被中断：不再发起导航（避免留下无意义的搜索标签页）
    if (signal?.aborted) {
      return this.createErrorResponse('搜索已取消（调用前已被中断）');
    }

    this.log(`在 ${target.label} 搜索 "${query}"（newTab=${newTab}，waitTime=${waitTime}ms）`);
    const searchUrl = target.buildSearchUrl(encodeURIComponent(query));

    // ── 导航（结果独立封装，解析成败不影响它） ──
    const navigation = await this.navigate(searchUrl, newTab, context);
    if (!navigation.success) {
      // 中止优先于失败分类：导航途中被中断不是「站点不可达」；
      // stage 优先取导航自带的精确原因（创建/查找/跳转/加载各不相同）
      if (signal?.aborted) {
        return this.abortedResult(
          paramName,
          targetId,
          query,
          target,
          navigation,
          navigation.note ?? '导航等待期间被中断',
        );
      }
      this.log(`导航失败: ${navigation.note ?? '未知原因'}`, 'error');
      const reason = navigation.note ?? '未知原因';
      return {
        success: false,
        error: `[${this.name}] 导航失败：${reason}`,
        data: {
          [paramName]: targetId,
          query,
          searchEngine: target.engine,
          navigation,
          // 结果字段同成功路径同形（消费方读 data.results.count 不会在失败时拿到 undefined）
          results: { success: false, count: 0, hint: `导航失败：${reason}` },
        },
        content: [
          {
            type: 'text',
            text: `导航失败：${reason}。可检查网络与站点可达性后重试，或改用 browser_navigation(action="open") 手动打开 ${searchUrl}`,
          },
        ],
        // 失败说明（可读原因）在 content，data 只是事实元数据——正题在 content，
        // 外部调用方据此既拿到导航元数据也拿到失败原因
        primary: 'content',
      };
    }

    // ── 额外等待（动态渲染站点的解析前提；可被用户中断） ──
    if (waitTime > 0) {
      const settled = await this.sleep(waitTime, signal);
      if (!settled) {
        return this.abortedResult(paramName, targetId, query, target, navigation, '等待结果渲染期间被中断');
      }
    }

    // ── 解析（失败只提示，不拖垮整体结果） ──
    const parse = await this.parseResults(target, navigation, signal);
    if (parse.aborted) {
      return this.abortedResult(paramName, targetId, query, target, navigation, '解析结果页期间被中断');
    }
    const message = parse.outcome.success
      ? parse.outcome.count > 0
        ? `已在${target.label}完成搜索「${query}」：导航成功（${navigation.url}），解析出 ${parse.outcome.count} ${target.itemNoun}`
        : `已在${target.label}完成搜索「${query}」：导航成功（${navigation.url}），未解析到结果条目（${parse.outcome.hint ?? '页面可能无匹配或结构变化'}）`
      : `已在${target.label}完成搜索「${query}」：导航成功（${navigation.url}），但结果解析失败（${parse.outcome.hint ?? '未知原因'}）——页面已就位，可用 browser_get_page_text 读取当前页自行解析`;

    this.log(message);
    // Markdown 表（条目本体）与结构化条目只保留一份：表经 content 承载，
    // data.results 只留计数与提示——引擎会把整个结果连同 content 序列化回传
    // 模型，两处各放一份条目即双份冗余。
    const { markdown: _markdown, items: _items, ...results } = parse.outcome;
    return {
      success: true,
      message,
      data: {
        [paramName]: targetId,
        query,
        searchEngine: target.engine,
        navigation,
        results,
      },
      content: [{ type: 'text', text: _markdown ?? message }],
      // 结果条目只经 content 的 Markdown 表承载（data 里不重复）——正题在 content，
      // data 只是事实元数据。外部调用方据此拿到「元数据 + 条目表」，不丢条目。
      primary: 'content',
    };
  }

  /** 中止时的失败结果（导航事实保留，原因可读） */
  private abortedResult(
    paramName: 'engine' | 'platform',
    targetId: SearchTargetId,
    query: string,
    target: SearchTargetConfig,
    navigation: NavigationOutcome,
    stage: string,
  ): ToolResult {
    const reason = `搜索已取消（${stage}）`;
    this.log(reason, 'warn');
    return {
      success: false,
      error: `[${this.name}] ${reason}`,
      data: {
        [paramName]: targetId,
        query,
        searchEngine: target.engine,
        navigation,
        results: { success: false, count: 0, hint: reason },
      },
      content: [{ type: 'text', text: `${reason}。若仍需结果，可重新发起一次搜索。` }],
      primary: 'content',
    };
  }

  /**
   * 导航到搜索结果页并等待加载。
   * 直接走 chrome.tabs（MV3 Promise 风格，sidepanel / background 双上下文原生
   * 可用），不经 browser_navigation——本工具即是导航的语义承载方，无需二次转发。
   */
  private async navigate(
    searchUrl: string,
    newTab: boolean,
    context?: ToolExecutionContext,
  ): Promise<NavigationOutcome> {
    const base = { searchUrl, newTab };
    const signal = context?.signal;
    try {
      let tabId: number;
      if (newTab) {
        const created = await this.withAbort(
          chrome.tabs.create({ url: searchUrl, active: true }),
          signal,
          '创建搜索标签页期间被中断',
        );
        if (!created?.id) throw new Error('新标签页创建失败（未返回 tabId）');
        tabId = created.id;
      } else {
        // lastFocusedWindow 而非 currentWindow：background service worker 没有
        // 「当前窗口」概念，currentWindow 在该上下文会查空；lastFocusedWindow
        // 在 sidepanel 与 background 双上下文都指向用户正在看的窗口
        const [active] = await this.withAbort(
          chrome.tabs.query({ active: true, lastFocusedWindow: true }),
          signal,
          '查找当前标签页期间被中断',
        );
        if (!active?.id) throw new Error('未找到可导航的当前标签页（没有活动窗口？）');
        await this.withAbort(
          chrome.tabs.update(active.id, { url: searchUrl }),
          signal,
          '跳转当前标签页期间被中断',
        );
        tabId = active.id;
      }

      // 标签页已确定：回报给宿主（页面高亮/引用锚点据此指向真实标签页）
      context?.onTabTarget?.(tabId);

      const status = await this.waitForLoad(tabId, signal);
      if (status.aborted) {
        return { success: false, status: 'error', url: searchUrl, tabId, note: '加载等待期间被中断', ...base };
      }
      const currentUrl = await this.readTabUrl(tabId);
      return {
        success: true,
        status: status.timedOut ? 'timeout' : 'complete',
        url: currentUrl ?? searchUrl,
        tabId,
        ...base,
        ...(status.timedOut
          ? { note: `页面 ${LOAD_TIMEOUT_MS / 1000}s 内未到达 complete（可能仍在加载）` }
          : {}),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { success: false, status: 'error', url: searchUrl, tabId: null, note: reason, ...base };
    }
  }

  /**
   * 轮询标签页 load 状态；标签页消失视为失败，超时视为软失败（不判导航失败）。
   * 中止时立即收敛（aborted=true），不把 30s 轮询拖满。
   */
  private async waitForLoad(
    tabId: number,
    signal?: AbortSignal,
  ): Promise<{ timedOut: boolean; aborted: boolean }> {
    // 以轮询次数而非墙钟为上限：对系统时钟跳变免疫，且行为可被测试精确驱动
    const maxPolls = Math.ceil(LOAD_TIMEOUT_MS / LOAD_POLL_INTERVAL_MS);
    for (let poll = 0; poll < maxPolls; poll++) {
      if (signal?.aborted) return { timedOut: false, aborted: true };
      // Promise 风格：标签页不存在时 reject，消息即失败原因
      let tab: chrome.tabs.Tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        throw new Error(`标签页 ${tabId} 已不存在或不可读（可能被关闭）`);
      }
      if (!tab) throw new Error(`标签页 ${tabId} 已不存在（可能被关闭）`);
      if (tab.status === 'complete') return { timedOut: false, aborted: false };
      const settled = await this.sleep(LOAD_POLL_INTERVAL_MS, signal);
      if (!settled) return { timedOut: false, aborted: true };
    }
    return { timedOut: true, aborted: false };
  }

  /** 读取标签页当前 URL（重定向后的最终地址；读不到回退 null） */
  private async readTabUrl(tabId: number): Promise<string | null> {
    try {
      const tab = await chrome.tabs.get(tabId);
      return tab?.url || tab?.pendingUrl || null;
    } catch {
      return null;
    }
  }

  /**
   * 按目标解析当前搜索结果页。两类通道（配置见 search-targets.ts）：
   *   inline —— chrome.scripting.executeScript 注入自包含函数；
   *   script —— 注入静态内容脚本 + sendMessage 触发（契约 status/data|message）。
   * 任何异常都收敛为 ParseOutcome（success=false + 提示），绝不向上抛。
   */
  private async parseResults(
    target: SearchTargetConfig,
    navigation: NavigationOutcome,
    signal?: AbortSignal,
  ): Promise<{ outcome: ParseOutcome; aborted: boolean }> {
    const tabId = navigation.tabId;
    if (tabId === null) {
      return {
        outcome: { success: false, count: 0, items: [], hint: '导航未返回有效标签页，无法解析' },
        aborted: false,
      };
    }
    try {
      const items = await this.runExtractor(target, tabId, signal);
      if (signal?.aborted) {
        return { outcome: { success: false, count: 0, items: [], hint: '解析期间被中断' }, aborted: true };
      }
      if (!Array.isArray(items)) {
        return {
          outcome: {
            success: false,
            count: 0,
            items: [],
            hint: `解析器返回了非数组结果（${typeof items}），页面结构可能已变化`,
          },
          aborted: false,
        };
      }
      if (items.length === 0) {
        return {
          outcome: {
            success: true,
            count: 0,
            items: [],
            hint: `未解析到${target.itemNoun}：可能无匹配结果、遇到登录墙/验证码或页面结构变化；页面已就位，可用 browser_get_page_text 读取当前页确认`,
          },
          aborted: false,
        };
      }
      // 结果条目只经 Markdown 表承载一份：content 给模型直接可读的表，
      // data.results 不再重复条目本体（引擎会把整个结果序列化回传模型，
      // 两处各放一份即双份冗余）——条目字段与顺序由表头完整表达。
      return {
        outcome: {
          success: true,
          count: items.length,
          items,
          markdown: resultsToMarkdownTable(items),
        },
        aborted: false,
      };
    } catch (error) {
      // 类标记判定中断（不猜消息文本），其余一律收敛为可读的解析失败提示
      if (error instanceof AbortedError) {
        return { outcome: { success: false, count: 0, items: [], hint: error.message }, aborted: true };
      }
      const reason = error instanceof Error ? error.message : String(error);
      return {
        outcome: {
          success: false,
          count: 0,
          items: [],
          hint: `${reason}。若标签页仍在，可用 browser_get_page_text 读取当前页自行解析（若已被关闭则重新调用本工具）`,
        },
        aborted: false,
      };
    }
  }

  /** 执行目标解析通道，返回原始条目载荷（形态判定由 parseResults 收敛；异常上抛由 parseResults 捕获） */
  private async runExtractor(
    target: SearchTargetConfig,
    tabId: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const { extractor } = target;
    if (extractor.kind === 'inline') {
      if (typeof extractor.func !== 'function') {
        throw new Error(`目标 ${target.id} 的 inline 解析函数缺失（配置缺陷）`);
      }
      const injection = await this.withAbort(
        chrome.scripting.executeScript({ target: { tabId }, func: extractor.func }),
        signal,
        '注入解析函数期间被中断',
      );
      // 形态判定统一交给 parseResults（非数组 → 可读的解析失败提示）
      return injection?.[0]?.result;
    }

    const file = extractor.file;
    const action = extractor.action;
    if (typeof file !== 'string' || typeof action !== 'string') {
      throw new Error(`目标 ${target.id} 的 script 解析配置缺失（file/action）`);
    }
    await this.injectScriptFile(tabId, file, signal);
    if (extractor.initDelayMs && extractor.initDelayMs > 0) {
      const settled = await this.sleep(extractor.initDelayMs, signal);
      if (!settled) throw new AbortedError('等待内容脚本初始化期间被中断');
    }
    const response = await this.sendScraperMessage(tabId, action, signal);
    if (response.status === 'error') {
      throw new Error(`内容脚本解析失败：${response.message ?? '未知错误'}`);
    }
    if (response.status !== 'success' || !Array.isArray(response.data)) {
      throw new Error(`内容脚本返回无效响应（status=${String(response.status)}，data 应为条目数组）`);
    }
    return response.data;
  }


  /** 注入静态内容脚本（重复注入由浏览器按文件幂等处理；Promise 风格） */
  private async injectScriptFile(
    tabId: number,
    file: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.withAbort(
        chrome.scripting.executeScript({ target: { tabId }, files: [file] }),
        signal,
        '注入内容脚本期间被中断',
      );
    } catch (error) {
      // 中止类错误必须保类透传：包装成普通 Error 会丢失中断语义
      if (error instanceof AbortedError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`内容脚本注入失败（${file}）：${reason}`);
    }
  }

  /**
   * 向内容脚本发解析指令并等待响应
   * （契约 {status:'success',data}|{status:'error',message}）。
   *
   * 三种终止路径都收敛为一次结算：响应到达 / 超时 / 被中断——
   * 中断与超时的原因各自可读，不留下悬挂的监听器，也不产生未处理的拒绝。
   */
  private async sendScraperMessage(
    tabId: number,
    action: string,
    signal?: AbortSignal,
  ): Promise<{ status: string; data?: unknown[]; message?: string }> {
    const outcome = await new Promise<
      { ok: true; value: unknown } | { ok: false; aborted: boolean; reason: string }
    >(resolve => {
      let settled = false;
      // 保持 let：signal 已 aborted 时 onAbort→cleanup 会在 timer 初始化之前
      // 执行，改为 const 会触发 TDZ（cleanup 闭包读取 timer 时它尚未初始化）。
      // eslint-disable-next-line prefer-const
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const settle = (result: { ok: true; value: unknown } | { ok: false; aborted: boolean; reason: string }): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onAbort = (): void =>
        settle({
          ok: false,
          aborted: true,
          reason: `等待内容脚本响应期间被中断（action=${action}）`,
        });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(
        () =>
          settle({
            ok: false,
            aborted: false,
            reason: `等待内容脚本响应超时（${SCRIPT_MESSAGE_TIMEOUT_MS / 1000}s，action=${action}）`,
          }),
        SCRIPT_MESSAGE_TIMEOUT_MS,
      );
      // 两个分支都挂上：消息通道失败不会变成未处理的拒绝
      chrome.tabs.sendMessage(tabId, { action }).then(
        value => settle({ ok: true, value }),
        error =>
          settle({
            ok: false,
            aborted: false,
            reason: `消息通道失败：${error instanceof Error ? error.message : String(error)}（页面可能未加载完成或未注入成功）`,
          }),
      );
    });

    if (!outcome.ok) {
      // 中断语义按结构字段区分，不靠消息子串匹配
      if (outcome.aborted) throw new AbortedError(outcome.reason);
      throw new Error(outcome.reason);
    }
    const response = outcome.value;
    if (!response || typeof response !== 'object') {
      throw new Error('内容脚本未响应或响应非对象（可能未注入成功）');
    }
    return response as { status: string; data?: unknown[]; message?: string };
  }

  /**
   * 可中止的等待：resolve(true) = 等满，resolve(false) = 等待期间被中断。
   * 监听器在结算时移除，不泄漏到已结束的 signal 上。
   */
  private sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      // 保持 let：signal 已 aborted 时 finish(false) 会在 timer 初始化之前执行，
      // 改为 const 会触发 TDZ（finish 闭包读取 timer 时它尚未初始化）。
      // eslint-disable-next-line prefer-const
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (done: boolean): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        resolve(done);
      };
      const cancel = (): void => finish(false);
      if (signal?.aborted) {
        finish(false);
        return;
      }
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => finish(true), ms);
    });
  }

  /**
   * 让任意 promise 可被中止打断：中断时抛出可读错误（不改动原 promise 的结算，
   * 只是提前放弃等待；原 promise 的拒绝由内部处理，不产生未处理的拒绝）。
   */
  private withAbort<T>(
    work: Promise<T>,
    signal: AbortSignal | undefined,
    message: string,
  ): Promise<T> {
    if (!signal) return work;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        reject(new AbortedError(message));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        value => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        error => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }
}
