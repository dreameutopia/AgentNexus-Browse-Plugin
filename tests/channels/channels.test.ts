/**
 * 渠道领域单元测试
 *
 * 覆盖：
 *   1. 存储归一化（脏数据收敛：id 去重、数值钳制、缺省补齐、未知协议保数据）
 *   2. 语义校验（未知协议 / 非法 URL / 缺密钥 / 无模型 / 重名去重报错 / 渠道 id 重复）
 *   3. 驱动注册表（策略查询、未知协议保守侧、重复注册拒绝）
 *   4. 渠道存储（保存往返、校验失败不落盘、深拷贝隔离、加载时钳制）
 *   5. 应用设置存储（部分更新、activeModelRef 三态化、钳制）
 *   6. 模型注册表（可用清单过滤、精确解析原因、回落链、端点钳制、require 可读错误、自愈）
 *
 * 运行：node tests/channels/run.mjs   （或 npm run test:channels）
 */

import {
  channelStore,
  appSettingsStore,
  modelRegistry,
  normalizeAppSettings,
  normalizeChannelState,
  validateAppSettings,
  validateChannelState,
  checkChannelLiveness,
  checkModelLiveness,
  createEmptyChannel,
  createEmptyModel,
  modelRefKey,
  CONTEXT_THRESHOLD_MIN,
  ITERATIONS_MAX,
  FAILED_TOOL_ROUNDS_DEFAULT,
  MAX_ITERATIONS_DEFAULT,
  DEFAULT_SESSION_AGENT_ID,
  TOOL_TIMEOUT_DEFAULT_MINUTES,
  TOOL_TIMEOUT_MAX_MINUTES,
  TOOL_TIMEOUT_MIN_MINUTES,
  type ChannelConfig,
} from '../../entrypoints/sidepanel/utils/channels';
import { driverRegistry } from '../../entrypoints/sidepanel/utils/stream/driver-registry';
import {
  ConfigEngine,
  setEngineForTesting,
  type StorageAreaLike,
} from '../../entrypoints/sidepanel/utils/config';
// 校验文案走 i18n 目录，断言前把语言钉死：
// 默认语言由运行环境探测（Node 21+ 有 navigator.language），
// 不钉死则同一套断言在中文系统与英文系统上结果不同。
import { setLocale } from '../../utils/i18n/core';

// ==================== 极简断言 ====================

let passed = 0;
const failures: string[] = [];

function check(cond: boolean, label: string, extra?: unknown): void {
  if (cond) passed++;
  else failures.push(label + (extra !== undefined ? ` => ${JSON.stringify(extra)}` : ''));
}

function eq(actual: unknown, expected: unknown, label: string): void {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    { actual, expected },
  );
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ==================== 内存存储实现 ====================

class MemoryArea implements StorageAreaLike {
  readonly store = new Map<string, unknown>();

  async get(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (this.store.has(key)) out[key] = structuredClone(this.store.get(key));
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      this.store.set(key, structuredClone(value));
    }
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) this.store.delete(key);
  }

  async getBytesInUse(keys: string[]): Promise<number> {
    let total = 0;
    for (const key of keys) {
      if (this.store.has(key)) total += JSON.stringify(this.store.get(key)).length + key.length;
    }
    return total;
  }
}

/** 换全新引擎 + 全新内存存储（套件间状态彻底隔离） */
function freshEngine(): MemoryArea {
  const area = new MemoryArea();
  setEngineForTesting(new ConfigEngine({ area }));
  return area;
}

/** 合法渠道骨架（openai 单模型，可按 patch 覆盖任意字段） */
function validChannel(patch: Partial<ChannelConfig> = {}): ChannelConfig {
  const base = createEmptyChannel('openai');
  base.name = '官方';
  base.baseUrl = 'https://api.example.com/v1';
  base.apiKey = 'sk-test';
  base.models = [createEmptyModel()];
  base.models[0].name = 'gpt-4o';
  return { ...base, ...patch };
}

// ==================== 测试套件 ====================

async function testNormalize(): Promise<void> {
  // 非对象 / 无 channels 数组 → 空态
  eq(normalizeChannelState(null).channels, [], 'null → 空渠道');
  eq(normalizeChannelState('junk').channels, [], '字符串 → 空渠道');
  eq(normalizeChannelState([1, 2]).channels, [], '数组 → 空渠道');
  eq(normalizeChannelState({ channels: 'nope' }).channels, [], 'channels 非数组 → 空渠道');

  // 脏条目丢弃 + id 去重保序 + 数值钳制 + 缺省补齐
  const normalized = normalizeChannelState({
    channels: [
      null,                                        // 丢弃
      { name: '无 id' },                            // 丢弃（缺 id）
      { id: 'ch1', protocol: 'openai', baseUrl: 'https://a', apiKey: 'k', retryCount: 99, retryInterval: 0, temperature: 9, models: [
        { id: 'm1', name: 'gpt-4o', contextThreshold: 100 },   // 阈值下限钳制
        { id: 'm1', name: '重复 id 被去重' },                    // 丢弃（id 重复）
        { id: 'm2', name: '', contextThreshold: Number.NaN },   // 无名丢弃
        { id: 'm3', name: '  llama3  ', contextThreshold: Number.NaN },
      ] },
      { id: 'ch1', protocol: 'ollama', baseUrl: 'https://dup' }, // 丢弃（渠道 id 重复）
      { id: 'ch2', protocol: 'future-protocol', baseUrl: 'https://b' }, // 未知协议保数据
    ],
  });
  eq(normalized.channels.length, 2, '脏条目与重复 id 收敛后剩 2 个渠道');
  const ch1 = normalized.channels[0];
  // 重试/温度是全局应用设置，渠道不再持有这些字段（历史字段在归一层被丢弃）
  check(!('retryCount' in ch1), '渠道不再持有 retryCount 字段');
  check(!('temperature' in ch1), '渠道不再持有 temperature 字段');
  eq(ch1.enabled, true, 'enabled 缺省为 true');
  eq(ch1.models.length, 2, '模型去重 + 无名丢弃');
  eq(ch1.models[0].contextThreshold, CONTEXT_THRESHOLD_MIN, '阈值越界钳制到下限');
  eq(ch1.models[1].name, 'llama3', '模型名去首尾空白');
  eq(ch1.models[1].vision, false, 'vision 缺省 false');
  eq(normalized.channels[1].protocol, 'future-protocol', '未知协议原样保留（不丢数据）');

  // 应用设置归一化（逐字段钳制 / 脏类型回落 / 引用三态化）
  const dirty = normalizeAppSettings({
    interactTimeoutMinutes: 500,
    activeModelRef: { channelId: ' ', modelId: 'x' }, // 非法引用 → null
    retryCount: 'x',
    temperature: 99,
  });
  eq(dirty.interactTimeoutMinutes, 120, 'interactTimeout 越界钳制');
  eq(dirty.activeModelRef, null, '空 channelId 引用三态化为 null');
  eq(dirty.retryCount, 2, '非数字重试次数回落默认');
  eq(dirty.temperature, 2, '温度越界钳制到上限');
  eq(normalizeAppSettings(null).interactTimeoutMinutes, 20, 'null → 默认设置');

  // 对话轮次上限与连续失败阈值（越界钳制 / 脏类型回落 / 缺省默认；文本与视觉统一）
  const dirtyRounds = normalizeAppSettings({
    maxIterations: ITERATIONS_MAX + 500,
    maxConsecutiveFailedToolRounds: 'x',
  });
  eq(dirtyRounds.maxIterations, ITERATIONS_MAX, 'maxIterations 越界钳制到上限');
  eq(
    dirtyRounds.maxConsecutiveFailedToolRounds,
    FAILED_TOOL_ROUNDS_DEFAULT,
    '非数字失败阈值回落默认值',
  );
  const negativeRounds = normalizeAppSettings({ maxIterations: -3 });
  eq(negativeRounds.maxIterations, 1, 'maxIterations 负值钳制到下限');
  const defaults = normalizeAppSettings(null);
  eq(defaults.maxIterations, MAX_ITERATIONS_DEFAULT, 'null → 默认轮次 30');
  eq(defaults.maxConsecutiveFailedToolRounds, FAILED_TOOL_ROUNDS_DEFAULT, 'null → 默认失败阈值 5');
  eq(defaults.defaultAgentId, DEFAULT_SESSION_AGENT_ID, 'null → 默认智能体 Auto-Action');

  // 单工具最长执行时间（分钟）：越界钳制 / 脏类型回落 / 缺省默认
  const dirtyToolTimeout = normalizeAppSettings({ toolTimeoutMinutes: 9999 });
  eq(
    dirtyToolTimeout.toolTimeoutMinutes,
    TOOL_TIMEOUT_MAX_MINUTES,
    'toolTimeoutMinutes 越界钳制到上限',
  );
  eq(
    normalizeAppSettings({ toolTimeoutMinutes: -5 }).toolTimeoutMinutes,
    TOOL_TIMEOUT_MIN_MINUTES,
    'toolTimeoutMinutes 负值钳制到下限',
  );
  eq(
    normalizeAppSettings({ toolTimeoutMinutes: 'x' }).toolTimeoutMinutes,
    TOOL_TIMEOUT_DEFAULT_MINUTES,
    '非数字 toolTimeoutMinutes 回落默认',
  );
  eq(
    normalizeAppSettings(null).toolTimeoutMinutes,
    TOOL_TIMEOUT_DEFAULT_MINUTES,
    'null → 默认单工具超时 30 分钟',
  );

  // 默认智能体：脏类型 / 空串回落预置默认；合法 id 原样保留
  eq(
    normalizeAppSettings({ defaultAgentId: 123 }).defaultAgentId,
    DEFAULT_SESSION_AGENT_ID,
    '非字符串 defaultAgentId 回落默认',
  );
  eq(
    normalizeAppSettings({ defaultAgentId: '  ' }).defaultAgentId,
    DEFAULT_SESSION_AGENT_ID,
    '空串 defaultAgentId 回落默认',
  );
  eq(
    normalizeAppSettings({ defaultAgentId: 'deep-search' }).defaultAgentId,
    'deep-search',
    '合法 defaultAgentId 原样保留',
  );
}

async function testValidate(): Promise<void> {
  // 合法渠道零错误
  eq(validateChannelState({ channels: [validChannel()] }), [], '合法渠道无校验错误');

  // 各失败模式（错误前缀带渠道名）
  const bad = normalizeChannelState({
    channels: [{
      id: 'ch_bad', name: '坏渠道', protocol: 'nope-protocol',
      baseUrl: 'not a url', apiKey: '',
      retryCount: 5, retryInterval: 5, temperature: 1,
      models: [{ id: 'm1', name: 'm' }],
    }],
  });
  const badErrors = validateChannelState(bad);
  check(badErrors.some(e => e.includes('不支持的协议')), '未知协议被拦截', badErrors);
  check(badErrors.some(e => e.includes('地址格式不正确')), '非法 URL 被拦截', badErrors);
  check(badErrors.every(e => e.startsWith('[坏渠道]')), '错误带渠道名前缀', badErrors);

  // Ollama 免密钥；无模型被拦截；重名只报一次
  const noModels = validChannel({ protocol: 'ollama', apiKey: '', models: [] });
  check(
    validateChannelState({ channels: [noModels] }).some(e => e.includes('至少需要配置一个模型')),
    '空模型渠道被拦截',
  );
  const dup = validChannel({
    models: [{ ...createEmptyModel(), name: 'gpt-4o' }, { ...createEmptyModel(), name: 'gpt-4o' }],
  });
  const dupErrors = validateChannelState({ channels: [dup] }).filter(e => e.includes('重复'));
  eq(dupErrors.length, 1, '重名模型只报一条错误');

  // 渠道 id 重复（两个条目共享同一 id）
  const sameId = validChannel();
  const dupId = validateChannelState({ channels: [sameId, { ...sameId }] });
  check(dupId.some(e => e.includes('重复的渠道标识')), '渠道 id 重复被拦截', dupId);

  // 应用设置校验（归一化后恒合法；这里直接喂未归一化的越界值验证校验器本身）
  const settingsErrors = validateAppSettings({
    interactTimeoutMinutes: 0,
    maxIterations: 0,
    defaultAgentId: '',
    maxConsecutiveFailedToolRounds: 999,
    toolTimeoutMinutes: 999,
    retryCount: 99,
    retryInterval: 0,
    temperature: 9,
    defaultContextThreshold: 1,
    activeModelRef: null,
  });
  check(settingsErrors.length >= 9, '应用设置越界逐项报错', settingsErrors);
  check(
    settingsErrors.some(e => e.includes('对话轮次上限')),
    'maxIterations 越界被拦截',
    settingsErrors,
  );
  check(
    settingsErrors.some(e => e.includes('默认智能体')),
    'defaultAgentId 空值被拦截',
    settingsErrors,
  );
  check(
    settingsErrors.some(e => e.includes('连续工具失败停止阈值')),
    'maxConsecutiveFailedToolRounds 越界被拦截',
    settingsErrors,
  );
  check(
    settingsErrors.some(e => e.includes('重试次数')),
    'retryCount 越界被拦截',
    settingsErrors,
  );
  check(
    settingsErrors.some(e => e.includes('重试间隔')),
    'retryInterval 越界被拦截',
    settingsErrors,
  );
  check(
    settingsErrors.some(e => e.includes('温度')),
    'temperature 越界被拦截',
    settingsErrors,
  );

  // 归一化后的设置必须零错误（保存路径 = 归一化 + 校验，两层必须自洽）
  eq(validateAppSettings(normalizeAppSettings(null)), [], '默认设置零校验错误');
}

async function testDriverRegistry(): Promise<void> {
  check(driverRegistry.has('openai') && driverRegistry.has('ollama'), '内置驱动已注册');
  eq(driverRegistry.requiresApiKey('ollama'), false, 'Ollama 免密钥');
  eq(driverRegistry.requiresApiKey('openai'), true, 'OpenAI 需密钥');
  eq(driverRegistry.requiresApiKey('nonexistent' as never), true, '未知协议按需密钥保守处理');
  check(driverRegistry.tryGet('nonexistent' as never) === null, '未知协议 tryGet 返回 null');
  try {
    driverRegistry.get('nonexistent' as never);
    check(false, '未知协议 get 应抛错');
  } catch (error) {
    check(errText(error).includes('未注册的协议驱动'), '未知协议 get 抛可读错误', errText(error));
  }
  try {
    driverRegistry.register(driverRegistry.get('openai'));
    check(false, '重复注册应抛错');
  } catch (error) {
    check(errText(error).includes('重复注册'), '重复注册被拒绝', errText(error));
  }
}

async function testStoresAndRegistry(): Promise<void> {
  freshEngine();

  // ── 渠道存储：保存往返 + 深拷贝隔离 ──
  const saveResult = await channelStore.save({ channels: [validChannel()] });
  check(saveResult.ok, '合法渠道保存成功', saveResult);
  await channelStore.load();
  eq(channelStore.getAll().length, 1, '保存后可读回 1 个渠道');
  const snapshot = channelStore.getAll();
  snapshot[0].name = 'HACKED';
  snapshot[0].models.push({ ...createEmptyModel(), name: 'injected' });
  eq(channelStore.get(snapshot[0].id)?.name, '官方', '深拷贝隔离：外部篡改不污染内存态');
  eq(channelStore.get(snapshot[0].id)?.models.length, 1, '深拷贝隔离：注入模型不可见');

  // ── 渠道存储：校验失败以值返回且不落盘 ──
  const invalidSave = await channelStore.save({
    channels: [validChannel({ protocol: 'nope-protocol' as never })],
  });
  check(!invalidSave.ok && invalidSave.errors.length > 0, '非法渠道保存返回错误结果');
  eq(channelStore.getAll()[0].name, '官方', '校验失败不改动内存态');

  // ── 加载时钳制：绕过 store 直接写脏文档（模拟外部/备份写入） ──
  const area = new MemoryArea();
  const engine = new ConfigEngine({ area });
  setEngineForTesting(engine);
  await engine.writeSection('channels', {
    channels: [{
      id: 'ch_dirty', name: '脏', protocol: 'openai', baseUrl: 'https://x.example/v1', apiKey: 'k',
      retryCount: 99, retryInterval: 0, temperature: 9,
      models: [{ id: 'm1', name: 'gpt-4o', contextThreshold: 100 }],
    }],
  });
  await channelStore.load();
  const dirtyLoaded = channelStore.get('ch_dirty');
  check(!!dirtyLoaded, '外部写入的渠道可加载');
  check(
    dirtyLoaded !== null && !('retryCount' in dirtyLoaded),
    '历史 retryCount 字段在加载归一时被丢弃（重试已是全局设置）',
  );
  eq(dirtyLoaded?.models[0].contextThreshold, CONTEXT_THRESHOLD_MIN, '加载时钳制阈值');

  // ── 应用设置存储：部分更新 + 钳制 + 引用三态 ──
  const settingsResult = await appSettingsStore.save({
    activeModelRef: { channelId: 'ch_dirty', modelId: 'm1' },
    interactTimeoutMinutes: 500,
  });
  check(settingsResult.ok, '应用设置保存成功');
  eq(appSettingsStore.get().interactTimeoutMinutes, 120, '保存路径同样钳制越界值');
  eq(modelRefKey(appSettingsStore.getActiveModelRef()!), 'ch_dirty/m1', 'activeModelRef 写入成功');
  const cleared = await appSettingsStore.save({ activeModelRef: { channelId: ' ', modelId: '' } as never });
  check(cleared.ok, '非法形状引用保存不报错');
  eq(appSettingsStore.getActiveModelRef(), null, '非法形状引用被三态化为 null');

  // ── 注册表：可用清单过滤（含非法渠道的夹具经引擎直写，模拟外部/备份
  //    绕过 store 校验的落盘——加载路径的归一化必须兜住它们） ──
  await engine.writeSection('channels', {
    channels: [
      validChannel({ id: 'ch_ok', models: [
        { ...createEmptyModel(), id: 'm_ok', name: 'gpt-4o', vision: true },
        { ...createEmptyModel(), id: 'm_off', name: 'gpt-4o-mini', enabled: false },
      ] }),
      validChannel({ id: 'ch_disabled', enabled: false, models: [{ ...createEmptyModel(), id: 'm2', name: 'x' }] }),
      validChannel({ id: 'ch_badurl', baseUrl: 'bad-url', models: [{ ...createEmptyModel(), id: 'm3', name: 'y' }] }),
      validChannel({ id: 'ch_nokey', apiKey: '', models: [{ ...createEmptyModel(), id: 'm4', name: 'z' }] }),
    ],
  });
  await channelStore.load();
  const options = [...modelRegistry.options];
  eq(options.map(o => o.key), ['ch_ok/m_ok'], '清单只含唯一可用模型');
  eq(options[0].vision, true, '视觉声明透传');
  check(modelRegistry.configured, 'configured 为 true');
  eq(modelRegistry.blockerIssue, null, '已配置时 blockerIssue 为 null');

  // ── 注册表：精确解析原因 ──
  const missingChannel = modelRegistry.resolveExact({ channelId: 'nope', modelId: 'm' });
  check(!missingChannel.ok && missingChannel.reason === 'channel-missing', '渠道缺失原因', missingChannel);
  const disabledChannel = modelRegistry.resolveExact({ channelId: 'ch_disabled', modelId: 'm2' });
  check(!disabledChannel.ok && disabledChannel.reason === 'channel-disabled', '渠道禁用原因', disabledChannel);
  const badUrl = modelRegistry.resolveExact({ channelId: 'ch_badurl', modelId: 'm3' });
  check(!badUrl.ok && badUrl.reason === 'endpoint-invalid', '非法 URL 原因', badUrl);
  const noKey = modelRegistry.resolveExact({ channelId: 'ch_nokey', modelId: 'm4' });
  check(!noKey.ok && noKey.reason === 'endpoint-invalid', '缺密钥原因', noKey);
  const disabledModel = modelRegistry.resolveExact({ channelId: 'ch_ok', modelId: 'm_off' });
  check(!disabledModel.ok && disabledModel.reason === 'model-disabled', '模型禁用原因', disabledModel);

  // ── 注册表：回落链（首选失效 → 全局默认 → 首个可用） ──
  await appSettingsStore.save({ activeModelRef: { channelId: 'ch_ok', modelId: 'm_ok' } });
  const fallback = modelRegistry.resolveExact({ channelId: 'nope', modelId: 'x' });
  const resolved = modelRegistry.resolve({ channelId: 'nope', modelId: 'x' });
  check(fallback.ok === false, '精确解析不回落');
  check(resolved.ok, '回落链解析成功', resolved);
  if (resolved.ok) {
    eq(resolved.endpoint.ref, { channelId: 'ch_ok', modelId: 'm_ok' }, '回落到全局默认引用');
    eq(resolved.fallbackReason, 'channel-missing', '回落携带首选失效原因');
    eq(resolved.endpoint.model, 'gpt-4o', '端点模型名正确');
    eq(resolved.endpoint.retryIntervalMs, 2000, '默认重试间隔换算为毫秒');
    eq(resolved.endpoint.contextThreshold, 262144, '默认上下文阈值');
  }

  // ── 注册表：require 抛可读错误 ──
  await channelStore.save({ channels: [] });
  try {
    modelRegistry.require(null);
    check(false, '无可用模型时 require 应抛错');
  } catch (error) {
    check(errText(error).includes('尚无可用模型'), 'require 错误可读且含处置指引', errText(error));
  }

  // ── 自愈：悬空引用 → 首个可用；全不可用 → 清空 ──
  await channelStore.save({ channels: [validChannel({ id: 'ch_back', models: [{ ...createEmptyModel(), id: 'm_back', name: 'gpt-4o' }] })] });
  await appSettingsStore.save({ activeModelRef: { channelId: 'ghost', modelId: 'ghost' } });
  const healed = await modelRegistry.healActiveRef();
  eq(healed, true, '悬空引用触发自愈');
  eq(modelRefKey(appSettingsStore.getActiveModelRef()!), 'ch_back/m_back', '自愈指向首个可用模型');
  const healAgain = await modelRegistry.healActiveRef();
  eq(healAgain, false, '引用有效时自愈为 no-op');
  await channelStore.save({ channels: [] });
  const healedEmpty = await modelRegistry.healActiveRef();
  eq(healedEmpty, true, '全部不可用时再次自愈');
  eq(appSettingsStore.getActiveModelRef(), null, '无可用模型时默认引用清空');

  // 死循环回归：引用已为空且无可用模型时，自愈必须**不再写盘**。
  // 写入会触发变更通知 → 再次自愈 → 再写入……（无限自触发，锁死事件循环）
  const healNoop = await modelRegistry.healActiveRef();
  eq(healNoop, false, '引用已为空且无可用模型时自愈为 no-op（不写盘）');
  eq(appSettingsStore.getActiveModelRef(), null, '自愈 no-op 后默认引用仍为空');

  // ── 注册表：blockerIssue 给出「未配置」的具体原因（结构化事实，UI 自行翻译） ──
  // 空配置 → 明确指向「未添加渠道」
  await channelStore.save({ channels: [] });
  eq(modelRegistry.configured, false, '空渠道时 configured 为 false');
  eq(modelRegistry.blockerIssue?.code, 'no-channels', '空配置时 blockerIssue 指向「未添加渠道」');

  // 渠道存在但端点不完整 → blockerIssue 指向具体不合格项（缺密钥）
  // 缺密钥的渠道**过不了保存期校验**，因此经引擎直写落盘（模拟外部写入 /
  // 备份导入这类绕过校验的路径），再由 store 载入观察活性判定
  await engine.writeSection('channels', {
    channels: [validChannel({ id: 'ch_nohint', apiKey: '', models: [{ ...createEmptyModel(), id: 'm_nohint', name: 'gpt-4o' }] })],
  });
  await channelStore.load();
  eq(modelRegistry.blockerIssue?.code, 'key-missing', '缺密钥时 blockerIssue 指向缺密钥');
  eq(modelRegistry.blockerIssue?.channelLabel, '官方', 'blockerIssue 携带渠道展示名');

  // 渠道被禁用 → blockerIssue 指向禁用
  await channelStore.save({
    channels: [validChannel({ id: 'ch_off', enabled: false, models: [{ ...createEmptyModel(), id: 'm_off2', name: 'gpt-4o' }] })],
  });
  eq(modelRegistry.blockerIssue?.code, 'channel-disabled', '渠道禁用时 blockerIssue 指向禁用');

  // ── 判定层：checkChannelLiveness / checkModelLiveness 单元 ──
  const liveChannel = validChannel({ id: 'ch_live', models: [{ ...createEmptyModel(), id: 'm_live', name: 'gpt-4o' }] });
  const liveResult = checkChannelLiveness(liveChannel);
  eq(liveResult.ok, true, '合法渠道活性通过');
  eq(liveResult.issues.length, 0, '合法渠道无问题');

  const badUrlChannel = validChannel({ id: 'ch_badurl2', baseUrl: 'not-a-url' });
  const badUrlResult = checkChannelLiveness(badUrlChannel);
  eq(badUrlResult.ok, false, '非法 URL 渠道不可用');
  check(
    badUrlResult.issues.some(issue => issue.code === 'url-invalid'),
    '非法 URL 返回 url-invalid 代码',
    badUrlResult.issues,
  );

  const noKeyChannel = validChannel({ id: 'ch_nokey2', apiKey: '' });
  const noKeyResult = checkChannelLiveness(noKeyChannel);
  check(
    noKeyResult.issues.some(issue => issue.code === 'key-missing'),
    '缺密钥返回 key-missing 代码',
    noKeyResult.issues,
  );

  const disabledModelConfig = { ...createEmptyModel(), id: 'm_dis', name: 'gpt-4o', enabled: false };
  const modelResult = checkModelLiveness(liveChannel, disabledModelConfig, liveResult);
  eq(modelResult.ok, false, '禁用模型不可用');
  check(
    modelResult.issues.some(issue => issue.code === 'model-disabled'),
    '禁用模型返回 model-disabled 代码',
    modelResult.issues,
  );

  // 渠道不可用时模型判定透传渠道问题（不单独评估模型维度）
  const passthrough = checkModelLiveness(badUrlChannel, liveChannel.models[0], badUrlResult);
  eq(passthrough.ok, false, '渠道不可用时模型判定透传渠道问题');
  check(
    passthrough.issues.some(issue => issue.code === 'url-invalid'),
    '透传的问题保留渠道侧原因',
    passthrough.issues,
  );

  // ── 注册表：配置变更后状态自动重算（响应式） ──
  await channelStore.save({ channels: [validChannel({ id: 'ch_auto', models: [{ ...createEmptyModel(), id: 'm_auto', name: 'gpt-4o' }] })] });
  eq(modelRegistry.configured, true, '保存后 configured 自动为 true');
  eq(modelRegistry.options.length, 1, '保存后 options 自动更新');
}

// ==================== 运行 ====================

async function main(): Promise<void> {
  // 语言钉死为默认语言：校验文案走 i18n 目录，断言内容依赖具体语言
  setLocale('zh-CN');

  const suites: [string, () => Promise<void>][] = [
    ['存储归一化', testNormalize],
    ['语义校验', testValidate],
    ['驱动注册表', testDriverRegistry],
    ['存储与注册表联动', testStoresAndRegistry],
  ];

  for (const [name, run] of suites) {
    const before = failures.length;
    try {
      await run();
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

void main();