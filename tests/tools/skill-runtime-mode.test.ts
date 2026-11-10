import assert from 'node:assert/strict';
import { extractContentText } from '@/common/tool-handler';
import { runtimeBuilder } from '@/entrypoints/sidepanel/core/runtime/runtime-builder';
import { modelRegistry } from '@/entrypoints/sidepanel/utils/channels';
import { openaiToolsConverter } from '@/entrypoints/sidepanel/utils/tools/openai-tools-converter';
import { PYODIDE_ENV_STORAGE_KEY } from '@/utils/pyodide/pyodide-config';
import { setSkillScriptsEnabled, updatePyodideEnvState } from '@/utils/pyodide/pyodide-env';
import { removeCustomSkill, setCustomSkill } from '@/utils/skills/skill-store';
import { skillTool } from '@/tools/skill/skill-tool';
import { PythonRunTool } from '@/tools/python/python-run-tool';

const savedRequire = modelRegistry.require;
const previous = (await chrome.storage.local.get(PYODIDE_ENV_STORAGE_KEY))[PYODIDE_ENV_STORAGE_KEY];
const skills = ['mode-first', 'mode-second'].map(name => setCustomSkill({
  name, files: { 'SKILL.md': `---\nname: ${name}\ndescription: Mode fixture\n---\nRead the fixture.` },
}));
assert.ok(skills.every(skill => skill.ok));
const skillNames = skills.flatMap(result => result.ok ? [result.skill.id] : []);
modelRegistry.require = (() => ({ contextThreshold: 32000 })) as unknown as typeof modelRegistry.require;

try {
  const input = {
    chatId: 'skill-mode-runtime', userInput: 'Run a skill', agentName: null,
    skillNames, priorRecords: [], extraToolIds: ['python_run', 'copy_skill_files', 'load_skill'],
  };
  await updatePyodideEnvState({ status: 'idle' });
  await assert.rejects(setSkillScriptsEnabled(true), /not ready/);
  const uninstalled = await runtimeBuilder.build(input);
  assert.equal(uninstalled.skillMode, 'text');
  assert.ok(!uninstalled.toolIds.includes('python_run'));
  assert.equal(uninstalled.toolIds.filter(id => id === 'skill_tool').length, 1);
  assert.deepEqual(uninstalled.availableSkillIds?.filter(id => skillNames.includes(id)), skillNames);
  assert.equal(uninstalled.activationContext[0]?.tool_calls?.length, 2);
  assert.match(uninstalled.systemPrompt, /技能文本模式/);
  assert.doesNotMatch(uninstalled.systemPrompt, /技能工作区模式|copy_skill_files|load_skill/);

  await updatePyodideEnvState({ status: 'ready' });
  const installed = await runtimeBuilder.build(input);
  assert.ok(installed.toolIds.includes('python_run'));
  const basic = openaiToolsConverter.getToolsByIds(['skill_tool', 'python_run'], installed);
  assert.deepEqual(basic[0].function.parameters.properties.action.enum, ['load', 'read']);
  assert.deepEqual(Object.keys(basic[1].function.parameters.properties), ['code', 'timeoutSeconds']);
  const python = new PythonRunTool();
  assert.match(extractContentText((await python.execute({ scriptPath: 'scripts/test.py' }, installed)).content), /PY_SKILL_SCRIPTS_DISABLED/);

  await setSkillScriptsEnabled(true);
  const enabled = await runtimeBuilder.build(input);
  const full = openaiToolsConverter.getToolsByIds(['skill_tool', 'python_run'], enabled);
  assert.equal(enabled.skillMode, 'workspace');
  assert.deepEqual(full[0].function.parameters.properties.action.enum, ['load', 'read', 'copy']);
  assert.ok(full[1].function.parameters.properties.scriptPath);
  assert.match(enabled.systemPrompt, /技能工作区模式/);
  assert.doesNotMatch(enabled.systemPrompt, /技能文本模式/);
  assert.deepEqual(enabled.skillResourceIds, skillNames);
  assert.ok(enabled.activationContext.slice(1).every(message => /会话提供 python_run/.test(String(message.content))));

  const learning = await runtimeBuilder.build({ ...input, disableSkillDiscovery: true });
  assert.equal(learning.skillMode, 'text');
  assert.equal(learning.activationContext.length, 0);
  assert.ok(!learning.toolIds.includes('skill_tool'));
  assert.match(learning.systemPrompt, /不提供既有技能/);
  const observer = await runtimeBuilder.build({ ...input, agentName: '视觉助手' });
  assert.equal(observer.skillMode, 'text');
  assert.ok(!observer.toolIds.includes('python_run'));

  await setSkillScriptsEnabled(false);
  assert.match(extractContentText((await python.execute({ scriptPath: 'scripts/test.py' }, enabled)).content), /PY_SKILL_SCRIPTS_DISABLED/);
  assert.match((await skillTool.execute({ action: 'copy', skill_name: skillNames[0], paths: ['.'] }, enabled)).error ?? '',
    /SKILL_WORKSPACE_UNAVAILABLE/);
} finally {
  modelRegistry.require = savedRequire;
  for (const id of skillNames) removeCustomSkill(id);
  if (previous === undefined) await chrome.storage.local.remove(PYODIDE_ENV_STORAGE_KEY);
  else await chrome.storage.local.set({ [PYODIDE_ENV_STORAGE_KEY]: previous });
}
console.log('[skill-runtime-mode] Live setting, runtime schemas and prompts, multi-skill activation, observer and learning policies, stale execution denial passed.');
