/**
 * 智能体引擎
 *
 * 职责：智能体的查询 / 写入 / 变更通知，以及「智能体 → 工具」的解析。
 * 底层复用 utils/agents/agent-store（共享存储层：预置 + 自定义持久化 +
 * 跨上下文实时同步），本层只做 sidepanel 侧硬化的门面——hub 管理页的写入
 * 会经存储同步触发 onAgentsChange，由本引擎转发给 App 层刷新。
 * 不引入技能概念（技能归 skill-engine，二者在 runtime-builder 汇合）。
 */

import {
  categoryLabelOf,
  getAllAgents,
  getAgentConfig,
  getAgentById,
  groupAgentsByCategory,
  normalizeToolIds,
  setAgentConfig,
  removeAgentConfig,
  isPresetAgent,
  onAgentsChange,
  type AgentCategoryGroup,
  type AgentConfig,
  type AgentWriteResult,
} from '@/utils/agents/agent-store';
import { getPresetToolIds } from '@/utils/tools/tool-presets';

/** 默认（无智能体）系统提示词；与 App.vue 既有文案保持一致 */
export const DEFAULT_AGENT_SYSTEM_PROMPT = `你是一个浏览器自动化助手，名叫AgentNexus，在用户的需求需要时，你可以基于页面信息与用户展开基本的文字对话；其他时候直接回答用户的问题即可
    如果用户需要更复杂的操作，你需要提醒他们在输入框输入@来查看其他智能体的不同能力来选择`;

/**
 * 新会话的默认智能体 ID（用户未显式选择智能体时，首条消息发送前自动选中）。
 * 取文本通用助手（Auto-Action）：其工具集为「元素定位 + 导航 + 点击输入」的通用网页操作组合，
 * 覆盖面最广，作为无选择时的兜底不会像 vision / deep-search 那样带有强场景假设。
 */
export const DEFAULT_SESSION_AGENT_ID = 'Auto-Action';

export interface AgentToolsResolution {
  /** 解析出的智能体（null = 未指定智能体，走默认对话） */
  agent: AgentConfig | null;
  /** 有序去重后的工具 ID */
  toolIds: string[];
  /** 是否为预置智能体 */
  isPreset: boolean;
}

type ChangeListener = () => void;

class AgentEngine {
  private listeners = new Set<ChangeListener>();

  // 存储层变更（本上下文写入或 hub 等其它页面经跨上下文同步写入）→ 引擎转发
  // （store 的持久化已含本地写入通知，引擎 upsert/remove 不再额外 notify，避免双重触发）
  private unsubscribeStore = onAgentsChange(() => this.notify());

  // ──── 查询 ────

  list(): AgentConfig[] {
    return getAllAgents();
  }

  /** 按分类分组的列表（选择器与管理页共用同一套分组与排序规则） */
  listGroupedByCategory(): AgentCategoryGroup[] {
    return groupAgentsByCategory(getAllAgents());
  }

  /**
   * 任意智能体列表 → 分类分组。
   * UI 侧过滤（关键词/会话回显）后仍需复用统一的分组与排序规则，
   * 因此分组能力对「给定列表」开放，而不是只对全量列表开放。
   */
  groupForDisplay(agents: readonly AgentConfig[]): AgentCategoryGroup[] {
    return groupAgentsByCategory(agents);
  }

  get(agentName: string): AgentConfig | null {
    return getAgentConfig(agentName);
  }

  getById(agentId: string): AgentConfig | null {
    return getAgentById(agentId);
  }

  isPreset(agentId: string): boolean {
    return isPresetAgent(agentId);
  }

  /**
   * 按「ID 优先、名称兜底」解析引用到的智能体。
   * 会话元信息同时记录 id 与 name：智能体改名后 id 不变，
   * 优先按 id 让历史会话继续回显正确的智能体，而不是静默退化为无智能体。
   */
  resolveRef(agentId?: string, agentName?: string): AgentConfig | null {
    if (agentId) {
      const byId = this.getById(agentId);
      if (byId) return byId;
    }
    if (agentName) return this.get(agentName);
    return null;
  }

  /**
   * 分类显示名：内置分类经调用方注入的 i18n 函数解析，自定义分类原样展示 id。
   * 封装在门面而非让 UI 直连 utils 层，保持 App 侧只依赖引擎一个入口。
   */
  categoryLabel(categoryId: string, resolveLabel: (labelKey: string) => string): string {
    return categoryLabelOf(categoryId, resolveLabel);
  }

  /**
   * 解析「新会话默认智能体」（用户未选智能体时首条消息自动选中）。
   * 按预置 ID 查找；找不到时回落预置名称再查一次（防御存储键名历史变更）。
   * 两者皆无（极端：预置被移除）返回 null，调用方按「无智能体」降级，不报错。
   */
  getDefaultSessionAgent(): AgentConfig | null {
    const byId = this.getById(DEFAULT_SESSION_AGENT_ID);
    if (byId) return byId;
    const fallback = this.get('文本通用助手');
    if (fallback) {
      console.warn('[AgentEngine] 默认智能体 ID 未命中，已按名称回落解析');
      return fallback;
    }
    console.warn('[AgentEngine] 默认智能体不存在（ID 与名称均未命中），本次以无智能体模式运行');
    return null;
  }

  // ──── 写入（自定义智能体） ────

  /**
   * 写入自定义智能体（重命名经 previousName 在同一变更内原子完成），
   * 返回精确结果（名称占用 / 预置冲突 / 数据不合法等）。
   * 变更通知经存储层广播自动到达，本层不重复 notify（避免双重触发）。
   */
  upsert(config: AgentConfig, options: { previousName?: string } = {}): AgentWriteResult {
    return setAgentConfig(config, options);
  }

  remove(agentName: string): AgentWriteResult {
    return removeAgentConfig(agentName);
  }

  // ──── 变更通知 ────

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.warn('[AgentEngine] 变更监听器执行失败:', error);
      }
    }
  }

  // ──── 解析：智能体 → 工具 + 系统提示词 ────

  /**
   * 解析智能体为运行装配所需的完备结果（单次查找）。
   * 未指定智能体 → chat 场景推荐工具（系统提示词由调用方回落 DEFAULT_AGENT_SYSTEM_PROMPT）；
   * 指定智能体 → 智能体声明的 tools + 配置对象本体（system / vision 由调用方读取）。
   * 工具列表统一经 normalizeToolIds 收敛（去重 + 上限），保证请求侧拿到的永远是干净集合。
   */
  resolve(agentName: string | null): AgentToolsResolution {
    const agent = agentName ? this.get(agentName) : null;
    if (!agent) {
      return {
        agent: null,
        toolIds: normalizeToolIds(getPresetToolIds('chat')),
        isPreset: false,
      };
    }
    return {
      agent,
      toolIds: normalizeToolIds(agent.tools),
      isPreset: isPresetAgent(agent.id),
    };
  }
}

/** 全局单例（sidepanel 内共享同一份内存态） */
export const agentEngine = new AgentEngine();
