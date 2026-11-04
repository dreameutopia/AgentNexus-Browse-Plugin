/**
 * 智能体展示文案（随界面语言切换）
 *
 * 侧边栏与 hub 管理页都要渲染智能体的名称/描述/标签，故放在两者共用的 common/。
 * 领域层（utils/agents）保持纯逻辑、不感知 vue：这里只做「当前语言 → 文案」的粘合，
 * 语言状态仍由 utils/i18n 的 useLocale 提供（响应式，随语言切换自动重算）。
 *
 * 用法：
 *   const { displayOf } = useAgentDisplay();
 *   displayOf(agent).name / .description / .tags
 */
import { useLocale } from '@/utils/i18n';
import { agentDisplayOf, type AgentConfig } from '@/utils/agents/agent-store';

export function useAgentDisplay() {
  const { locale } = useLocale();
  return {
    /**
     * 智能体在当前语言下的展示文案。
     * 预置智能体按语言取 display 覆盖；自定义智能体没有覆盖，返回其自填文案。
     */
    displayOf: (agent: AgentConfig) => agentDisplayOf(agent, locale.value),
    /** 智能体在当前语言下的展示名称（标签栏胶囊、会话徽标等只需名称处用） */
    displayNameOf: (agent: AgentConfig) => agentDisplayOf(agent, locale.value).name,
  };
}
