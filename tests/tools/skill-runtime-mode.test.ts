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
  // Python 规程分区必须与工具面一致：没有 python_run 时不得注入
  // （否则模型会按规程去调用一个本轮拿不到的工具）
  assert.equal(bare.systemPrompt.split('<python-scripting>').length-1,0,'无 python_run 时不注入 Python 规程分区');
  assert.equal(bare.activationContext[0]?.tool_calls?.length,2);
  const schema=openaiToolsConverter.getToolsByIds(['skill_tool'],bare)[0];
  assert.deepEqual(schema.function.parameters.properties.action.enum,['load','read','copy','create','edit','delete']);
  await updatePyodideEnvState({status:'ready'});
  const installed=await runtimeBuilder.build({...input,extraToolIds:['python_run']}); assert.ok(installed.toolIds.includes('python_run'));
  // 工具面含 python_run 时必须注入 Python 规程分区（决策协议进系统提示词，
  // 而非只塞进工具描述——描述会被读到但不生效）
  assert.equal(installed.systemPrompt.split('<python-scripting>').length-1,1,'有 python_run 时注入 Python 规程分区');
  assert.match(installed.systemPrompt,/file_util\(action="create"[\s\S]*python_run\(action="run"/,'规程写明先用 file_util 产出脚本再运行');
  assert.match(installed.systemPrompt,/dependencyMode="pypi"/,'规程点明依赖解析参数');
  assert.deepEqual(openaiToolsConverter.getToolsByIds(['skill_tool'],installed)[0],schema);
  const learning=await runtimeBuilder.build({...input,skillNames:[]});
  assert.ok(learning.toolIds.includes('skill_tool')); assert.deepEqual(learning.availableSkillIds,['4','5']); assert.equal(learning.activationContext.length,0);
  const observer=await runtimeBuilder.build({...input,agentName:'视觉助手'});
  assert.ok(observer.toolIds.includes('skill_tool'));
  // 视觉助手没有 js_run：skill-create / skill-edit 的 allowed-tools 无法满足，
  // 按 advertised ⊆ executable 不变量不得进入技能清单
  assert.ok(!observer.availableSkillIds?.includes('4'));
  assert.ok(!observer.availableSkillIds?.includes('5'));
  assert.ok(!observer.toolIds.includes('python_run'));
  // 显式预选的技能不受「工具是否齐全」过滤：技能照样加载，越界工具在交付面
  // 裁剪，并以 <capability-boundary> 告知模型按真实能力调整执行方式。
  const visionLimited=await setCustomSkill({name:'mode-vision-limited',allowedTools:['browser_interact','interact'],files:{'SKILL.md':'---\nname: mode-vision-limited\ndescription: Vision limited fixture\n---\nRead fixture.'}});
  assert.ok(visionLimited.ok);
  const visionSkillId=visionLimited.ok?visionLimited.skill.id:'';
  try {
    const limited=await runtimeBuilder.build({...input,agentName:'视觉助手',skillNames:[visionSkillId]});
    assert.ok(limited.activationContext.length > 0,'显式预选技能不得因部分工具不可用被丢弃');
    assert.ok(!limited.toolIds.includes('browser_interact'),'越界工具仍由交付面裁剪');
    assert.ok(limited.systemPrompt.includes('<capability-boundary>'),'能力裁剪需告知模型');
  } finally {
    if(visionSkillId) await removeCustomSkill(visionSkillId);
  }
} finally {
  modelRegistry.require=savedRequire;
  for(const id of ids) await removeCustomSkill(id);
  if(previous===undefined) await chrome.storage.local.remove(PYODIDE_ENV_STORAGE_KEY); else await chrome.storage.local.set({[PYODIDE_ENV_STORAGE_KEY]:previous});
}
console.log('[skill-runtime] Global tool, guides, prompt, Python-independent schema and observer/learning injection passed.');
