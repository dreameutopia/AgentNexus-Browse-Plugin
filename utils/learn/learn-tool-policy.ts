/** Validation reproduces the declared execution environment, not the learner's toolbox. */
import { CORE_SESSION_TOOL_IDS } from '@/utils/tools/tool-presets';
import { isVisualSkillTool } from './learn-validate';
import type { SkillDraft } from './learn-types';

export function validationToolIds(draft: SkillDraft): string[] {
  const internal = new Set(['submit_skill', 'submit_validation', 'load_skill', 'read_skill_file']);
  return [...new Set([
    ...CORE_SESSION_TOOL_IDS,
    // Registry filtering belongs to runtime-builder. Do not accidentally exclude
    // a legitimate declared dependency merely because it is outside a preset.
    ...draft.allowedTools.filter(id => !internal.has(id) && !(draft.mode === 'text' && isVisualSkillTool(id))),
    // note_tool 随 CORE_SESSION_TOOL_IDS 注入（验证段记录卡点），不再重复登记
    'submit_validation',
    // Automatic screenshots are stage infrastructure, not an undeclared action path.
    ...(draft.mode === 'vision' ? ['screenshot'] : []),
  ])];
}
