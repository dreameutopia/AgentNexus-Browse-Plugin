import assert from 'node:assert/strict';
import { runtimeBuilder } from '@/entrypoints/sidepanel/core/runtime/runtime-builder';
import { modelRegistry } from '@/entrypoints/sidepanel/utils/channels';
import { openaiToolsConverter } from '@/entrypoints/sidepanel/utils/tools/openai-tools-converter';
import { PYODIDE_ENV_STORAGE_KEY } from '@/utils/pyodide/pyodide-config';
import { updatePyodideEnvState } from '@/utils/pyodide/pyodide-env';
import { removeCustomSkill, setCustomSkill } from '@/utils/skills/skill-store';
const savedRequire=modelRegistry.require;
const previous=(await chrome.storage.local.get(PYODIDE_ENV_STORAGE_KEY))[PYODIDE_ENV_STORAGE_KEY];
const skills=await Promise.all(['mode-first','mode-second'].map(name=>setCustomSkill({name,files:{'SKILL.md':`---\nname: ${name}\ndescription: Mode fixture\n---\nRead fixture.`}})));
assert.ok(skills.every(result=>result.ok));
const ids=skills.flatMap(result=>result.ok?[result.skill.id]:[]);
modelRegistry.require=(()=>({contextThreshold:32000})) as unknown as typeof modelRegistry.require;
try {
  const input={chatId:'skill-mode-runtime',userInput:'Run a skill',agentName:null,skillNames:ids,priorRecords:[]};
  await updatePyodideEnvState({status:'idle'});
  const bare=await runtimeBuilder.build(input);
  assert.ok(!bare.toolIds.includes('python_run'));
  for(const id of ['skill_tool','js_run','plan_tool']) assert.equal(bare.toolIds.filter(value=>value===id).length,1);
  for(const id of ['4','5']) assert.ok(bare.availableSkillIds?.includes(id));
  assert.equal(bare.systemPrompt.split('<session-workspace>').length-1,1);
  assert.equal(bare.systemPrompt.split('<skill-lifecycle>').length-1,1);
  assert.equal(bare.activationContext[0]?.tool_calls?.length,2);
  const schema=openaiToolsConverter.getToolsByIds(['skill_tool'],bare)[0];
  assert.deepEqual(schema.function.parameters.properties.action.enum,['load','read','copy','create','edit','delete']);
  await updatePyodideEnvState({status:'ready'});
  const installed=await runtimeBuilder.build({...input,extraToolIds:['python_run']}); assert.ok(installed.toolIds.includes('python_run'));
  assert.deepEqual(openaiToolsConverter.getToolsByIds(['skill_tool'],installed)[0],schema);
  const learning=await runtimeBuilder.build({...input,disableSkillDiscovery:true});
  assert.ok(learning.toolIds.includes('skill_tool')); assert.deepEqual(learning.availableSkillIds,['4','5']); assert.equal(learning.activationContext.length,0);
  const observer=await runtimeBuilder.build({...input,agentName:'视觉助手'});
  assert.ok(observer.toolIds.includes('skill_tool')); assert.ok(observer.availableSkillIds?.includes('4')); assert.ok(observer.availableSkillIds?.includes('5')); assert.ok(!observer.toolIds.includes('python_run'));
} finally {
  modelRegistry.require=savedRequire;
  for(const id of ids) await removeCustomSkill(id);
  if(previous===undefined) await chrome.storage.local.remove(PYODIDE_ENV_STORAGE_KEY); else await chrome.storage.local.set({[PYODIDE_ENV_STORAGE_KEY]:previous});
}
console.log('[skill-runtime] Global tool, guides, prompt, Python-independent schema and observer/learning injection passed.');
