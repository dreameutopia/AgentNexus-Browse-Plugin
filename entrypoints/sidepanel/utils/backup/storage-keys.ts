/**
 * 备份与存储统计共用的存储键清单（单一事实源）
 *
 * 为什么集中在此：备份分区与统计分类必须引用**同一批键名**，分散到各调用点
 * 出现拼写漂移时会表现为「统计缺数 / 备份漏项」且无任何报错——这是本引擎
 * 最需要防御的静默故障。每个键的来源模块在注释中标注；源模块若重命名键，
 * 必须同步此处（两侧各留一句互指注释由源模块负责，本文件是消费侧唯一入口）。
 *
 * 不纳入备份的键（有意为之，防止歧义）：
 * - browserUuid            设备标识，跨机复制会造成身份重复
 * - agentNexusSkillDraft   一次性学习草稿（TTL），随用随删
 * - agentNexusDataRefs     会话级暂存（2h TTL），浏览器退出即失效
 * - __websiteValidated*    网站校验缓存，可再生
 * - pyodide_env_state      Python 运行时状态（依赖可重新下载的 IndexedDB 缓存）
 * - 各配置域 __mirror / __snaps 键：由配置引擎随主键一并读写，统计经
 *   engine.configStorageKeys() 聚合，不在此重复枚举
 */

import type { StorageCategoryId } from './types';

/** chrome.storage.local：自定义技能数组（utils/skills/skill-store） */
export const SKILLS_STORAGE_KEY = 'agentNexusCustomSkills';
/** chrome.storage.local + localStorage：预置技能启停覆盖（utils/skills/skill-store） */
export const SKILL_TOGGLES_STORAGE_KEY = 'agentNexusSkillPresetToggles';
/** chrome.storage.local + localStorage：自定义智能体数组（utils/agents/agent-store） */
export const AGENTS_STORAGE_KEY = 'agentNexusCustomAgents';
/** chrome.storage.local + localStorage：会话任务计划载荷（utils/plan/plan-store） */
export const PLANS_STORAGE_KEY = 'agentNexusSessionPlans';
/** chrome.storage.local：托管文件库（utils/file-manager） */
export const FILES_STORAGE_KEY = 'file_manager_files';
/** chrome.storage.local：AI 用量统计（sidepanel/utils/metrics/usage-metrics-engine） */
export const USAGE_METRICS_STORAGE_KEY = 'ai_usage_metrics_v1';
/** chrome.storage.local：Deep Search 站点开关（sidepanel/composables/use-deep-search-sites） */
export const DEEP_SEARCH_FLAGS_STORAGE_KEY = 'deepSearchSiteFlags';
/** chrome.storage.local：下载拦截开关（entrypoints/background） */
export const INTERCEPTION_STATE_STORAGE_KEY = 'downloadInterceptionState';
/** chrome.storage.local：AI 任务队列（tools/base/task-*） */
export const AI_TASKS_STORAGE_KEY = 'aiTasks';
/** chrome.storage.local：笔记页主题偏好（entrypoints/notes/composables/useTheme，localStorage 同名键） */
export const NOTES_THEME_STORAGE_KEY = 'notes-theme';
/** localStorage：笔记文件夹注册表（entrypoints/notes/utils/folder-registry） */
export const NOTES_FOLDERS_STORAGE_KEY = 'notes-folders';
/** chrome.storage.local：Python 运行时环境状态（utils/pyodide/pyodide-env；仅统计，不备份） */
export const PYODIDE_ENV_STORAGE_KEY = 'pyodide_env_state';
/** chrome.storage.local：设备标识（entrypoints/background/ws/browser-identity；仅统计，不备份） */
export const BROWSER_UUID_STORAGE_KEY = 'browserUuid';
/** chrome.storage.local：会话级暂存（utils/data-ref-store；2h TTL，仅统计，不备份） */
export const DATA_REFS_STORAGE_KEY = 'agentNexusDataRefs';
/** chrome.storage.local：一次性学习草稿（utils/learn/learn-draft-store；TTL，仅统计，不备份） */
export const LEARN_DRAFT_STORAGE_KEY = 'agentNexusSkillDraft';
/** chrome.storage.local：网站校验缓存（entrypoints/background、entrypoints/content；可再生） */
export const WEBSITE_VALIDATED_KEYS: readonly string[] = [
  '__websiteValidated',
  '__websiteValidatedAt',
  '__websiteValidatedUrl',
];

/** 备份 misc 分区携带的 chrome.storage.local 键（统计 misc 分类同源复用） */
export const MISC_CHROME_KEYS: readonly string[] = [
  DEEP_SEARCH_FLAGS_STORAGE_KEY,
  INTERCEPTION_STATE_STORAGE_KEY,
  AI_TASKS_STORAGE_KEY,
];

/** 备份 misc 分区携带的 localStorage 键 */
export const MISC_LOCAL_KEYS: readonly string[] = [NOTES_THEME_STORAGE_KEY];

/**
 * 技能 / 智能体的 localStorage 同步缓存键（与 chrome 键同名）。
 * 恢复时双写：chrome 为权威源，localStorage 为同步读缓存——只写一侧会在
 * 「chrome 被清但 localStorage 尚存」的恢复路径上留下新旧不一致。
 */
export const LOCAL_MIRROR_KEYS: readonly string[] = [
  SKILLS_STORAGE_KEY,
  SKILL_TOGGLES_STORAGE_KEY,
  AGENTS_STORAGE_KEY,
  PLANS_STORAGE_KEY,
];

// ==================== 统计分类映射（键 → 占用分类） ====================

/**
 * chrome.storage.local 键 → 存储占用分类。
 *
 * 用途：统计引擎按这张表把每个键的字节归到对应分类；**表外的键一律归入
 * `other`（其他）**，绝不丢弃——「丢弃」正是统计缺数的典型形态（用户看到的
 * 合计小于浏览器实际占用，却没有任何提示）。
 *
 * 键名必须与源模块一致（见本文件顶部的注释约定）；源模块改名时这里必须同步。
 * 配置域的主键/镜像/快照由 config/engine 的 configStorageKeys() 提供
 * （同样归入 config 分类），避免在此重复枚举三层冗余键。
 */
export const CHROME_KEY_CATEGORY: Readonly<Record<string, StorageCategoryId>> = {
  // —— 技能 ——
  [SKILLS_STORAGE_KEY]: 'skills',
  [SKILL_TOGGLES_STORAGE_KEY]: 'skills',
  // —— 智能体 ——
  [AGENTS_STORAGE_KEY]: 'agents',
  // —— 会话计划 ——
  [PLANS_STORAGE_KEY]: 'plans',
  // —— 托管文件 ——
  [FILES_STORAGE_KEY]: 'files',
  // —— 用量统计 ——
  [USAGE_METRICS_STORAGE_KEY]: 'metrics',
  // —— 杂项 ——
  [DEEP_SEARCH_FLAGS_STORAGE_KEY]: 'misc',
  [INTERCEPTION_STATE_STORAGE_KEY]: 'misc',
  [AI_TASKS_STORAGE_KEY]: 'misc',
  // —— Python 环境 ——
  [PYODIDE_ENV_STORAGE_KEY]: 'python',
  // —— 其余（体积小、可再生或不备份，但必须计入合计） ——
  [BROWSER_UUID_STORAGE_KEY]: 'other',
  [DATA_REFS_STORAGE_KEY]: 'other',
  [LEARN_DRAFT_STORAGE_KEY]: 'other',
  ...Object.fromEntries(WEBSITE_VALIDATED_KEYS.map(key => [key, 'other'] as const)),
};

/** localStorage 键 → 存储占用分类（表外归 other） */
export const LOCAL_KEY_CATEGORY: Readonly<Record<string, StorageCategoryId>> = {
  [SKILLS_STORAGE_KEY]: 'skills',
  [SKILL_TOGGLES_STORAGE_KEY]: 'skills',
  [AGENTS_STORAGE_KEY]: 'agents',
  [PLANS_STORAGE_KEY]: 'plans',
  [NOTES_THEME_STORAGE_KEY]: 'misc',
  [NOTES_FOLDERS_STORAGE_KEY]: 'notes',
  // 配置引擎的 localStorage 遗留镜像（systemSettings）
  systemSettings: 'config',
};

/** 分类 id（存储占用报告的固定分类集；定义在 types.ts，此处转出便于同源引用） */
export type { StorageCategoryId } from './types';

/** 分类 id → chrome.storage.local / localStorage 键（供统计引擎按分类聚合） */
export function keysOfCategory(category: StorageCategoryId): { chrome: string[]; local: string[] } {
  const chrome = Object.keys(CHROME_KEY_CATEGORY).filter(
    key => CHROME_KEY_CATEGORY[key] === category,
  );
  const local = Object.keys(LOCAL_KEY_CATEGORY).filter(
    key => LOCAL_KEY_CATEGORY[key] === category,
  );
  return { chrome, local };
}
