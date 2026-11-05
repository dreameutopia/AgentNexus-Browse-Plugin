/**
 * 设置弹窗共享表单（渠道与模型 + 高级参数 + 底部保存）
 *
 * 架构：壳（SettingsModal）创建一次并 provide，各分区 inject 后直接读写，
 * 避免多实例状态漂移。取代原 use-api-config-form（单渠道单配置模型），
 * 现以「渠道列表 + 选中渠道草稿 + 应用设置草稿」为核心状态。
 *
 * 职责边界：
 *   - 渠道 CRUD 草稿（内存态；底部「保存」统一持久化到 channelStore / appSettingsStore）
 *   - 模型增删 / 视觉声明 / 阈值 / 启停 / 默认模型标记（草稿内操作）
 *   - 自动拉取模型列表 / 连通性测试（一律使用选中渠道的草稿值，与真实请求同源）
 *   - 保存前双重校验（渠道文档 + 应用设置），失败逐条展示、不写盘
 *   - errorDialog 为弹窗级共享错误子弹窗（模型拉取失败等共用），由壳渲染
 *
 * 关键不变式：
 *   - 保存失败绝不污染已持久化配置（校验全过才写盘；引擎写入带读回校验）；
 *   - 保存成功后注册表自愈 activeModelRef（被删/被禁模型的默认引用自动回落）。
 */

import { computed, ref, watch, type ComputedRef, type InjectionKey, type Ref } from 'vue';
import { t } from '@/utils/i18n';
import {
  driverRegistry,
  type DriverMeta,
  type ProtocolDriver,
} from '../../../utils/stream/driver-registry';
import type { ProviderType } from '../../../utils/stream/types';
import {
  appSettingsStore,
  channelStore,
  modelRegistry,
  modelRefKey,
  channelLabelOf,
  checkChannelLiveness,
  createEmptyChannel,
  createEmptyModel,
  normalizeChannelState,
  normalizeAppSettings,
  validateAppSettings,
  validateChannelState,
  type AppSettings,
  type ChannelConfig,
  type ChannelLiveness,
  type ChannelState,
  type ModelRef,
} from '../../../utils/channels';
import {
  resolveActualRequestUrl,
  fetchModelList,
  ModelListError,
} from '../../../utils/api/provider-endpoint';
// 配置引擎门面（前像读取 / 分区回滚：跨域保存的原子性保障）。
// 直引 engine 模块而非 utils/config 桶文件：桶里还挂着备份/导入导出整套模块，
// 设置表单只需要引擎门面，不该为此把无关模块拉进依赖图。
import { getEngine } from '../../../utils/config/engine';
// 端点活性问题的展示层映射（结构化事实 → 可读文案；与运行期判定同源）
import { livenessIssueText } from '../../../utils/ui/liveness-message';
import { probeConnection } from '../../../utils/stream/probe';
import { ApiRequestError, prettyJson } from '../../../utils/stream/errors';
import { showConfirm } from '../../../composables/use-app-dialog';

// ==================== 共享类型 ====================

/** 连通性测试结果（成功/失败 + 一句话结论 + 完整响应详情） */
export interface TestResult {
  success: boolean;
  message: string;
  detail?: string;
}

/** 弹窗级错误子弹窗状态（完整响应 JSON 展示） */
export interface ErrorDialogState {
  title: string;
  message: string;
  detail?: string;
}

/** 设置分区 id（前五个对外可见；files / system 为迁入的历史功能，导航隐藏） */
export type SettingsSectionId =
  | 'channels'
  | 'advanced'
  | 'asr'
  | 'usage'
  | 'python'
  | 'websites'
  | 'files'
  | 'system';

/** 壳提供给分区的上下文：当前激活分区 + 打开纪元（每次弹窗打开自增，分区据此重新水合） */
export interface SettingsModalContext {
  activeSection: Ref<SettingsSectionId>;
  openEpoch: Ref<number>;
}

export const settingsModalContextKey: InjectionKey<SettingsModalContext> =
  Symbol('settings-modal-context');

// ==================== 表单 API ====================

export interface SettingsFormApi {
  /** 共享错误子弹窗（壳渲染，各分区可写入） */
  errorDialog: Ref<ErrorDialogState | null>;

  // ---- 渠道草稿 ----
  /** 全部渠道草稿（深拷贝；底部保存统一持久化） */
  channels: Ref<ChannelConfig[]>;
  /** 当前编辑的渠道 id */
  selectedChannelId: Ref<string>;
  /** 当前编辑的渠道草稿（null = 无渠道） */
  selectedChannel: ComputedRef<ChannelConfig | null>;

  // ---- 应用设置草稿 ----
  settingsDraft: Ref<AppSettings>;

  /** 校验错误（保存时逐条展示，带渠道前缀） */
  validationErrors: Ref<string[]>;
  /** 保存中状态（底部主按钮 loading） */
  isSaving: Ref<boolean>;

  // ---- 选中渠道的临时操作状态 ----
  modelInput: Ref<string>;
  showApiKey: Ref<boolean>;
  isTesting: Ref<boolean>;
  testResult: Ref<TestResult | null>;
  isFetchingModels: Ref<boolean>;
  fetchedModels: Ref<string[]>;
  selectedFetchedModels: Ref<string[]>;
  modelSearch: Ref<string>;
  showModelPicker: Ref<boolean>;
  showTestPicker: Ref<boolean>;
  testModelName: Ref<string>;

  // ---- 计算属性 ----
  /** 已注册的协议驱动清单（协议选择器数据源） */
  driverList: ProtocolDriver[];
  /** 选中渠道协议的 UI 元数据（占位符/示例；协议未注册时为 null） */
  activeMeta: ComputedRef<DriverMeta | null>;
  /** 选中渠道协议是否要求 API Key */
  channelRequiresApiKey: ComputedRef<boolean>;
  /** 选中渠道草稿的活性（与运行期判定同源；测试/拉取可用性依据） */
  channelLiveness: ComputedRef<ChannelLiveness>;
  /** 可以发起连通性测试 */
  canTest: ComputedRef<boolean>;
  /** 连通性测试按钮的提示（不可用时给出具体原因） */
  testBtnTitle: ComputedRef<string>;
  fetchBtnTitle: ComputedRef<string>;
  modelInputPlaceholder: ComputedRef<string>;
  /** 实际请求地址预览（委托适配器计算，与真实请求同源） */
  actualRequestUrl: ComputedRef<string>;
  filteredFetchedModels: ComputedRef<string[]>;
  allFetchedSelected: ComputedRef<boolean>;
  /** 草稿中的默认模型键（模型行的「设为默认」星标依据） */
  draftActiveModelKey: ComputedRef<string>;

  // ---- 渠道行为 ----
  selectChannel: (channelId: string) => void;
  addChannel: (protocol: ProviderType) => void;
  /** 删除渠道（弹窗确认；仅改草稿，随保存持久化） */
  removeChannel: (channelId: string) => Promise<void>;
  selectProtocol: (protocol: ProviderType) => void;
  /** 渠道启停（草稿） */
  toggleChannelEnabled: (channelId: string) => void;

  // ---- 模型行为 ----
  /** 回车/按钮添加模型（名称重复时给出错误） */
  addModel: (name?: string) => void;
  removeModel: (modelId: string) => void;
  toggleModelVision: (modelId: string) => void;
  toggleModelEnabled: (modelId: string) => void;
  /** 标记草稿默认模型（保存后成为全局生效模型） */
  setDraftActiveModel: (ref: ModelRef) => void;

  // ---- 拉取 / 测试 ----
  handleFetchModels: () => Promise<void>;
  toggleSelectAll: () => void;
  confirmFetchedModels: () => void;
  openTestPicker: () => void;
  confirmTestModel: () => Promise<void>;
  runConnectionTest: (modelName: string) => Promise<void>;

  // ---- 生命周期 ----
  /** 保存渠道草稿 + 应用设置（校验失败逐条展示，不写盘） */
  handleSave: () => Promise<void>;
  /** 从存储重新水合（弹窗每次打开时由壳调用） */
  hydrate: () => Promise<void>;
}

export const settingsFormKey: InjectionKey<SettingsFormApi> = Symbol('settings-form');

// ==================== 工厂 ====================

export function createSettingsForm(options: { onSaved: () => void }): SettingsFormApi {
  const errorDialog = ref<ErrorDialogState | null>(null);

  const channels = ref<ChannelConfig[]>([]);
  const selectedChannelId = ref('');
  const settingsDraft = ref<AppSettings>(normalizeAppSettings(null));

  const validationErrors = ref<string[]>([]);
  const isSaving = ref(false);

  const modelInput = ref('');
  const showApiKey = ref(false);
  const isTesting = ref(false);
  const testResult = ref<TestResult | null>(null);
  const isFetchingModels = ref(false);
  const fetchedModels = ref<string[]>([]);
  const selectedFetchedModels = ref<string[]>([]);
  const modelSearch = ref('');
  const showModelPicker = ref(false);
  const showTestPicker = ref(false);
  const testModelName = ref('');

  const driverList = driverRegistry.list();

  const selectedChannel = computed<ChannelConfig | null>(
    () => channels.value.find(channel => channel.id === selectedChannelId.value) ?? null,
  );

  const activeMeta = computed<DriverMeta | null>(() => {
    const channel = selectedChannel.value;
    return channel ? driverRegistry.tryGet(channel.protocol)?.meta ?? null : null;
  });

  const channelRequiresApiKey = computed(() => {
    const channel = selectedChannel.value;
    return channel ? driverRegistry.requiresApiKey(channel.protocol) : true;
  });

  /**
   * 选中渠道的草稿活性（与运行期判定同源：checkChannelLiveness）。
   * 端点三要素（地址 / 密钥 / 驱动）任一不合格时测试与拉取都不可用。
   */
  const channelLiveness = computed<ChannelLiveness>(() => {
    const channel = selectedChannel.value;
    return channel ? checkChannelLiveness(channel) : { ok: false, issues: [] };
  });

  const canTest = computed(() => {
    const channel = selectedChannel.value;
    if (!channel) return false;
    if (!channelLiveness.value.ok) return false;
    return channel.models.length > 0 || modelInput.value.trim().length > 0;
  });

  const fetchBtnTitle = computed(() => {
    const channel = selectedChannel.value;
    if (!channel) return t('sidepanel.apiConfig.fillServiceUrlFirst');
    // 端点不合格时给出具体原因（缺地址 / 地址非法 / 缺密钥…），而不是笼统提示
    const issue = channelLiveness.value.issues[0];
    if (!issue) return t('sidepanel.apiConfig.fetchModelsHint');
    return livenessIssueText(issue);
  });

  /**
   * 连通性测试按钮的提示文案。
   * 不可用时给出**具体**原因（缺地址 / 地址非法 / 缺密钥 / 尚无模型），
   * 而不是笼统的「请先填写」——按钮被禁用时，提示就是用户唯一的诊断入口。
   */
  const testBtnTitle = computed(() => {
    const channel = selectedChannel.value;
    if (!channel) return t('sidepanel.apiConfig.testHintFill');
    if (!channelLiveness.value.ok) {
      const issue = channelLiveness.value.issues[0];
      return issue ? livenessIssueText(issue) : t('sidepanel.apiConfig.testHintFill');
    }
    if (!canTest.value) return t('sidepanel.apiConfig.testHintFill');
    return t('sidepanel.apiConfig.testHintSelect');
  });

  const modelInputPlaceholder = computed(() => {
    const meta = activeMeta.value;
    const base = meta ? t(meta.modelPlaceholder) : '';
    return `${base}${t('sidepanel.apiConfig.modelInputHint')}`;
  });

  /** 测试/预览所用模型名：已选测试模型 → 渠道首个模型 → 输入框待添加名 */
  const previewModelName = computed(() => {
    const channel = selectedChannel.value;
    if (testModelName.value && channel?.models.some(m => m.id === testModelName.value)) {
      return channel.models.find(m => m.id === testModelName.value)?.name ?? '';
    }
    return channel?.models[0]?.name ?? modelInput.value.trim();
  });

  const actualRequestUrl = computed(() => {
    const channel = selectedChannel.value;
    if (!channel) return '';
    return resolveActualRequestUrl({
      provider: channel.protocol,
      baseUrl: channel.baseUrl,
      apiKey: channel.apiKey,
      model: previewModelName.value,
    });
  });

  const filteredFetchedModels = computed(() => {
    const keyword = modelSearch.value.trim().toLowerCase();
    if (!keyword) return fetchedModels.value;
    return fetchedModels.value.filter(name => name.toLowerCase().includes(keyword));
  });

  const allFetchedSelected = computed(() => {
    const list = filteredFetchedModels.value;
    return list.length > 0 && list.every(name => selectedFetchedModels.value.includes(name));
  });

  const draftActiveModelKey = computed(() => {
    const ref = settingsDraft.value.activeModelRef;
    return ref ? modelRefKey(ref) : '';
  });

  // ==================== 水合与临时状态 ====================

  /** 清空仅属于本次打开的临时状态 */
  function resetTransientState(): void {
    modelInput.value = '';
    modelSearch.value = '';
    fetchedModels.value = [];
    selectedFetchedModels.value = [];
    showModelPicker.value = false;
    showTestPicker.value = false;
    testModelName.value = '';
    showApiKey.value = false;
    errorDialog.value = null;
    testResult.value = null;
    validationErrors.value = [];
  }

  /** 从存储水合草稿（渠道 + 应用设置），并保证选中项有效 */
  async function hydrate(): Promise<void> {
    // 加载失败不阻断弹窗打开：退化为内存态（首装/存储故障时为默认空态），
    // 绝不让 void hydrate() 变成未处理的 Promise 拒绝
    try {
      await modelRegistry.load();
    } catch (error) {
      console.warn('[SettingsForm] 配置加载失败，按当前内存态水合:', error);
    }
    channels.value = channelStore.getAll();
    settingsDraft.value = appSettingsStore.get();

    const stillExists = channels.value.some(channel => channel.id === selectedChannelId.value);
    if (!stillExists) {
      selectedChannelId.value = channels.value[0]?.id ?? '';
    }
    resetTransientState();
  }

  // 修改关键字段时清除测试结果（测试结论只对当时的端点配置有意义）
  watch(
    () => {
      const channel = selectedChannel.value;
      if (!channel) return '';
      return `${channel.id}|${channel.protocol}|${channel.baseUrl}|${channel.apiKey}`;
    },
    () => {
      testResult.value = null;
    },
  );

  // ==================== 渠道行为 ====================

  function selectChannel(channelId: string): void {
    if (!channels.value.some(channel => channel.id === channelId)) return;
    selectedChannelId.value = channelId;
    modelInput.value = '';
    testResult.value = null;
    validationErrors.value = [];
    showApiKey.value = false;
  }

  function addChannel(protocol: ProviderType): void {
    if (!driverRegistry.has(protocol)) return;
    const channel = createEmptyChannel(protocol);
    channel.name = driverRegistry.get(protocol).meta.label;
    channels.value.push(channel);
    selectChannel(channel.id);
  }

  async function removeChannel(channelId: string): Promise<void> {
    const channel = channels.value.find(item => item.id === channelId);
    if (!channel) return;
    const label = channelLabelOf(channel);
    const confirmed = await showConfirm(
      t('sidepanel.channels.removeChannelConfirm', { name: label }),
      t('sidepanel.channels.removeChannelTitle'),
      'warn',
    );
    if (!confirmed) return;
    channels.value = channels.value.filter(item => item.id !== channelId);
    if (selectedChannelId.value === channelId) {
      selectedChannelId.value = channels.value[0]?.id ?? '';
    }
    testResult.value = null;
    validationErrors.value = [];
  }

  function selectProtocol(protocol: ProviderType): void {
    const channel = selectedChannel.value;
    if (!channel || !driverRegistry.has(protocol) || channel.protocol === protocol) return;
    channel.protocol = protocol;
    testResult.value = null;
  }

  function toggleChannelEnabled(channelId: string): void {
    const channel = channels.value.find(item => item.id === channelId);
    if (!channel) return;
    channel.enabled = !channel.enabled;
  }

  // ==================== 模型行为 ====================

  function addModel(rawName?: string): void {
    const channel = selectedChannel.value;
    if (!channel) return;
    const name = (rawName ?? modelInput.value).trim();
    if (!name) return;
    if (channel.models.some(model => model.name.trim() === name)) {
      validationErrors.value = [t('sidepanel.apiConfig.validateModelDuplicate', { name })];
      return;
    }
    channel.models.push({ ...createEmptyModel(settingsDraft.value.defaultContextThreshold), name });
    if (rawName === undefined) modelInput.value = '';
    testResult.value = null;
    validationErrors.value = [];
  }

  function removeModel(modelId: string): void {
    const channel = selectedChannel.value;
    if (!channel) return;
    if (channel.models.length <= 1) {
      validationErrors.value = [t('sidepanel.apiConfig.keepOneModel')];
      return;
    }
    channel.models = channel.models.filter(model => model.id !== modelId);
    if (testModelName.value === modelId) testModelName.value = '';
    testResult.value = null;
  }

  function toggleModelVision(modelId: string): void {
    const channel = selectedChannel.value;
    const model = channel?.models.find(item => item.id === modelId);
    if (!model) return;
    model.vision = !model.vision;
  }

  function toggleModelEnabled(modelId: string): void {
    const channel = selectedChannel.value;
    const model = channel?.models.find(item => item.id === modelId);
    if (!model) return;
    model.enabled = !model.enabled;
  }

  function setDraftActiveModel(ref: ModelRef): void {
    settingsDraft.value.activeModelRef = { ...ref };
  }

  // ==================== 拉取 / 测试 ====================

  async function handleFetchModels(): Promise<void> {
    const channel = selectedChannel.value;
    if (!channel || isFetchingModels.value) return;
    validationErrors.value = [];

    // 端点活性与运行期判定同源：不合格时给出第一条具体原因
    if (!channelLiveness.value.ok) {
      const issue = channelLiveness.value.issues[0];
      validationErrors.value = [issue ? livenessIssueText(issue) : t('sidepanel.apiConfig.invalidServiceUrl')];
      return;
    }

    isFetchingModels.value = true;
    const fetchingChannelId = channel.id;
    try {
      const models = await fetchModelList({
        provider: channel.protocol,
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
      });
      // 异步间隙防串扰：拉取期间用户已切换渠道时丢弃本次结果——
      // fetchedModels 是弹窗级共享状态，串到别的渠道会把错误的清单并入其模型列表
      if (selectedChannelId.value !== fetchingChannelId) {
        console.warn('[SettingsForm] 拉取模型期间渠道已切换，本次结果作废');
        return;
      }
      fetchedModels.value = models;
      const existing = new Set(channel.models.map(model => model.name.trim()));
      selectedFetchedModels.value = models.filter(name => !existing.has(name));
      modelSearch.value = '';
      showModelPicker.value = true;
    } catch (error) {
      if (error instanceof ModelListError) {
        errorDialog.value = {
          title: t('sidepanel.apiConfig.fetchModelsFailed'),
          message: error.message,
          detail: error.detail,
        };
      } else {
        errorDialog.value = {
          title: t('sidepanel.apiConfig.fetchModelsFailed'),
          message: error instanceof Error ? error.message : String(error),
          detail: (error as { stack?: string })?.stack || String(error),
        };
      }
    } finally {
      isFetchingModels.value = false;
    }
  }

  function toggleSelectAll(): void {
    const visible = filteredFetchedModels.value;
    if (allFetchedSelected.value) {
      const visibleSet = new Set(visible);
      selectedFetchedModels.value = selectedFetchedModels.value.filter(name => !visibleSet.has(name));
      return;
    }
    const merged = [...selectedFetchedModels.value];
    for (const name of visible) {
      if (!merged.includes(name)) merged.push(name);
    }
    selectedFetchedModels.value = merged;
  }

  function confirmFetchedModels(): void {
    const channel = selectedChannel.value;
    if (!channel) return;
    let added = 0;
    for (const name of selectedFetchedModels.value) {
      if (!channel.models.some(model => model.name.trim() === name)) {
        channel.models.push({ ...createEmptyModel(settingsDraft.value.defaultContextThreshold), name });
        added++;
      }
    }
    showModelPicker.value = false;
    testResult.value = null;
    if (!added) {
      validationErrors.value = [t('sidepanel.apiConfig.allSelectedAlready')];
    } else {
      validationErrors.value = [];
    }
  }

  function openTestPicker(): void {
    const channel = selectedChannel.value;
    if (!canTest.value || isTesting.value || !channel) return;
    testResult.value = null;
    // 渠道尚无已入列模型但输入框有待添加名（canTest 允许的场景）：
    // 没有可单选的列表，直接用输入框中的名称发起测试，避免弹出空选择器卡死
    if (channel.models.length === 0) {
      const pending = modelInput.value.trim();
      if (pending) void runConnectionTest(pending);
      return;
    }
    testModelName.value = channel.models[0]?.id ?? '';
    showTestPicker.value = true;
  }

  async function confirmTestModel(): Promise<void> {
    const channel = selectedChannel.value;
    const model = channel?.models.find(item => item.id === testModelName.value);
    showTestPicker.value = false;
    if (!model) return;
    await runConnectionTest(model.name);
  }

  /**
   * 测试 API 连接：复用协议适配器发起最小化非流式探测
   * （与真实对话请求同源，杜绝两套拼接逻辑漂移）。
   */
  async function runConnectionTest(modelName: string): Promise<void> {
    const channel = selectedChannel.value;
    if (!channel || !canTest.value || isTesting.value) return;

    isTesting.value = true;
    testResult.value = null;
    const startTime = Date.now();
    const testingChannelId = channel.id;
    try {
      const result = await probeConnection({
        provider: channel.protocol,
        baseUrl: channel.baseUrl.trim(),
        apiKey: channel.apiKey.trim(),
        model: modelName,
      });
      // 异步间隙防串扰：测试期间用户已切换渠道时丢弃结论（旧渠道的测试
      // 结果挂在新渠道名下会误导配置判断；切换动作本身已清空 testResult）
      if (selectedChannelId.value !== testingChannelId) return;
      testResult.value = {
        success: true,
        message: t('sidepanel.apiConfig.connectSuccess', {
          model: modelName,
          latency: result.latencyMs,
        }),
      };
    } catch (error) {
      if (selectedChannelId.value !== testingChannelId) return;
      testResult.value = mapProbeError(error, Date.now() - startTime);
    } finally {
      isTesting.value = false;
    }
  }

  /** 把探测异常映射为弹窗可展示的结果（一句话结论 + 完整原始响应） */
  function mapProbeError(error: unknown, latency: number): TestResult {
    if (error instanceof ApiRequestError) {
      if (error.isTimeout) {
        return {
          success: false,
          message: t('sidepanel.apiConfig.connectTimeout', { latency }),
          detail: error.rawBody || error.summary,
        };
      }
      if (error.isNetwork) {
        return {
          success: false,
          message: t('sidepanel.apiConfig.networkError'),
          detail: [error.summary, error.rawBody ? prettyJson(error.rawBody) : '']
            .filter(Boolean)
            .join('\n\n'),
        };
      }
      return {
        success: false,
        message: t('sidepanel.apiConfig.requestFailed', { detail: error.toSingleLine() }),
        detail: error.rawBody ? prettyJson(error.rawBody) : error.summary,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message,
      detail: error instanceof Error ? error.stack || message : undefined,
    };
  }

  // ==================== 保存 ====================

  /**
   * 读取某配置域的当前持久化态（前像）。
   * 读失败不阻断保存流程——前像只服务于回滚，没有前像意味着「失败后无法回滚」，
   * 但绝不因为「读不到前像」就拒绝写入（那会让一次存储抖动卡死用户配置）。
   */
  async function readSectionSnapshot(id: 'channels' | 'appSettings'): Promise<unknown | null> {
    try {
      const snapshot = await getEngine().readSection(id);
      return snapshot?.data ?? null;
    } catch (error) {
      console.warn('[SettingsForm] 读取配置前像失败（本次保存失败将无法回滚）:', error);
      return null;
    }
  }

  /**
   * 把某配置域回滚到给定前像。
   * 前像为 null 表示「写入前该域本就没有数据」→ 清空而非写入空对象。
   * 回滚本身失败只记录日志：原始错误已在界面上呈现，此处不叠加第二条噪声。
   */
  async function rollbackSection(id: 'channels' | 'appSettings', before: unknown | null): Promise<void> {
    try {
      if (before === null) {
        await getEngine().clearSection(id);
      } else {
        await getEngine().writeSection(id, before);
      }
    } catch (error) {
      console.error('[SettingsForm] 配置回滚写入失败:', error);
    }
    // 无论回滚写入是否成功，store 的内存态都必须与持久化层重新对齐
    // （回滚写的是持久化层，store 的内存态仍旧是失败前的那份）
    try {
      await channelStore.load();
      await appSettingsStore.load();
    } catch (error) {
      console.error('[SettingsForm] 配置回滚后重新载入失败:', error);
    }
  }

  /**
   * 事务性保存两份配置域（渠道 + 应用设置）。
   *
   * 引擎的写入粒度是「单个域」，跨域没有事务：任一份失败都会留下
   * 「一半新一半旧」的持久化态（渠道改了但设置没改，或反之）——
   * 用户看到的是「保存了但只生效一半」，极难自查。
   *
   * 因此写入前先留一份渠道域的前像，第二份写失败时把渠道回滚，
   * 让「保存」要么整体生效、要么整体不生效。
   * （与备份恢复的「预像 + 回滚」同一套手法，见 utils/backup/engine.ts。）
   */
  async function persistConfig(
    channelState: ChannelState,
    settings: AppSettings,
  ): Promise<{ ok: boolean; errors: string[] }> {
    const channelsBefore = await readSectionSnapshot('channels');
    // 即将尝试写入渠道域（校验失败走下面的 return，届时改回 false）
    let channelsTouched = false;

    try {
      channelsTouched = true;
      const channelResult = await channelStore.save(channelState);
      if (!channelResult.ok) {
        // 校验失败：尚未发生任何写入，无需回滚
        channelsTouched = false;
        return { ok: false, errors: channelResult.errors };
      }

      const settingsResult = await appSettingsStore.save(settings);
      if (!settingsResult.ok) {
        // 应用设置写失败 → 回滚渠道，避免留下半应用状态
        await rollbackSection('channels', channelsBefore);
        return { ok: false, errors: settingsResult.errors };
      }
      return { ok: true, errors: [] };
    } catch (error) {
      // 写入过程抛错（读回校验未过 / 存储不可用 / 配额超限）：
      // 渠道域可能已落盘且内容不可信 → 回滚到前像
      if (channelsTouched) {
        await rollbackSection('channels', channelsBefore);
      }
      const reason = error instanceof Error ? error.message : String(error);
      console.error('[SettingsForm] 配置保存失败:', error);
      return { ok: false, errors: [`${t('sidepanel.apiConfig.saveFailed')}（${reason}）`] };
    }
  }

  async function handleSave(): Promise<void> {
    testResult.value = null;
    validationErrors.value = [];

    // 输入框中未确认的模型名一并入列，避免用户输入丢失；
    // 入列失败（如名称重复）会写入 validationErrors，此时直接中止保存，
    // 让用户看到原因——否则警告会被下面的空错误列表冲掉、输入被静默丢弃
    if (modelInput.value.trim()) addModel();
    if (validationErrors.value.length > 0) return;

    const channelState = normalizeChannelState({ channels: channels.value });
    const settings = normalizeAppSettings(settingsDraft.value);

    // 双重校验（全过才写盘）：任一渠道非法 / 应用设置非法 → 逐条展示
    const errors = [
      ...validateChannelState(channelState),
      ...validateAppSettings(settings),
    ];
    if (errors.length > 0) {
      validationErrors.value = errors;
      return;
    }

    isSaving.value = true;
    try {
      const outcome = await persistConfig(channelState, settings);
      if (!outcome.ok) {
        validationErrors.value = outcome.errors;
        return;
      }
      // 默认模型引用自愈：草稿默认指向的模型若已不可用（跨上下文并发删除等极端时序），
      // 注册表将其回落到首个可用模型，绝不留下悬空引用
      await modelRegistry.healActiveRef();

      channels.value = channelStore.getAll();
      settingsDraft.value = appSettingsStore.get();
      options.onSaved();
    } finally {
      isSaving.value = false;
    }
  }

  return {
    errorDialog,
    channels,
    selectedChannelId,
    selectedChannel,
    settingsDraft,
    validationErrors,
    isSaving,
    modelInput,
    showApiKey,
    isTesting,
    testResult,
    isFetchingModels,
    fetchedModels,
    selectedFetchedModels,
    modelSearch,
    showModelPicker,
    showTestPicker,
    testModelName,
    driverList,
    activeMeta,
    channelRequiresApiKey,
    channelLiveness,
    canTest,
    testBtnTitle,
    fetchBtnTitle,
    modelInputPlaceholder,
    actualRequestUrl,
    filteredFetchedModels,
    allFetchedSelected,
    draftActiveModelKey,
    selectChannel,
    addChannel,
    removeChannel,
    selectProtocol,
    toggleChannelEnabled,
    addModel,
    removeModel,
    toggleModelVision,
    toggleModelEnabled,
    setDraftActiveModel,
    handleFetchModels,
    toggleSelectAll,
    confirmFetchedModels,
    openTestPicker,
    confirmTestModel,
    runConnectionTest,
    handleSave,
    hydrate,
  };
}