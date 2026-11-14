import assert from 'node:assert/strict';
import { zipSync, strToU8, unzipSync } from 'fflate';
import { allocateSkillIdentity, BUILTIN_SKILL_IDS, isSkillId, isBuiltinSkillId } from '@/utils/skills/skill-identity';
import { getAllSkills, getSkillById, setCustomSkill, removeCustomSkill, setSkillEnabled, restoreCustomSkillsFromStorage, flushSkillStoreWrites } from '@/utils/skills/skill-store';
import { composeSkillDocument } from '@/utils/skills/skill-authoring';
import { buildSkillInstruction } from '@/utils/skills/skill-instruction';
import { paginateSkillText, countSkillChars } from '@/utils/skills/skill-pagination';
import { importSkillFromMdText, parseSkillZipBytes, commitImportCandidates, exportSkillToZip } from '@/utils/skills/skill-import-export';
import { skillEngine } from '@/entrypoints/sidepanel/core/registry/skill-engine';
import { skillTool } from '@/tools/skill/skill-tool';
import { saveWorkspace } from '@/utils/python-workspace/store';
import { chatDatabase } from '@/entrypoints/sidepanel/core/context/chat-database';
import { registerInteractHandler } from '@/tools/interact/interact-ui-bridge';
import { linkedSkillIds } from '@/utils/agents/agent-skill-links';
import { skillCaptureState } from '@/entrypoints/sidepanel/utils/chat/skill-capture';
import type { ExtendedChatMessage } from '@/entrypoints/sidepanel/types/chat';
import type { PluginSnapshot } from '@/utils/plugins/contracts';
import { reconcilePluginSkills, pendingPluginSkillUpdates, approvePluginSkillUpdate } from '@/utils/plugins/managed-skills';
let passed = 0;
async function test(name: string, action: () => unknown) { await action(); console.log(`PASS ${++passed}: ${name}`); }
const document = (name: string, body = 'Reusable workflow', description = 'Use for fixture operations at https://example.com/reports') => composeSkillDocument({ name, description }, body);
const write = async (name: string, body?: string) => { const result = await setCustomSkill({ name, files: { 'SKILL.md': document(name, body) } }); assert.ok(result.ok, JSON.stringify(result)); return result.skill; };
const chatId = 'skill-authoring-test';
await chatDatabase.createSession({chatId,title:'Skills',createdAt:1,updatedAt:1,messageCount:0,lastMessagePreview:'',agentName:'default',skillNames:[]});
const ctx = { chatId, agentId: 'default-agent-id', loadedSkillIds: ['4','5'] };
const call = (args: unknown, context = ctx) => skillTool.execute(args, context);
await test('built-ins use a protected explicit numeric mapping; guides always discoverable', async () => {
  for (const [name,id] of Object.entries(BUILTIN_SKILL_IDS)) { assert.equal(getSkillById(id)?.name,name); assert.ok(isBuiltinSkillId(id)); }
  assert.deepEqual(skillEngine.resolveAvailableSkills(null, []).filter(s=>['4','5'].includes(s.id)).map(s=>s.id),['4','5']);
  assert.equal(await setSkillEnabled('4',false),false);
  assert.equal(getSkillById('skill-create'),undefined);
  for (const invalid of ['01','-1','1001.0','9007199254740992',1001]) assert.equal(isSkillId(invalid),false);
});
await test('transaction allocator survives concurrent custom/plugin allocations without reuse', async () => {
  const ids = await Promise.all(Array.from({length:80},(_,i)=>allocateSkillIdentity('concurrent:'+i)));
  assert.equal(new Set(ids).size,80); assert.ok(ids.every(id=>Number(id)>=1001));
  assert.equal(await allocateSkillIdentity('concurrent:0'),ids[0]);
  assert.notEqual(await allocateSkillIdentity('another',ids[0]),ids[0]);
  assert.equal(await allocateSkillIdentity('preferred','2000'),'2000');
  assert.ok(Number(await allocateSkillIdentity('after-preferred'))>2000);
});
await test('same names coexist, ID-only resolution, async imports and version conflicts', async () => {
  const a=await write('same-name'), b=await write('same-name','Other');
  assert.notEqual(a.id,b.id); assert.equal(getSkillById('same-name'),undefined); assert.equal(getSkillById('same-name-'+a.id),undefined);
  const imported=await importSkillFromMdText(document('same-name'),'same-name'); assert.equal(imported.imported.length,1); assert.notEqual(imported.imported[0].id,a.id);
  const conflict=await setCustomSkill({id:a.id,name:a.name,files:a.files,expectedUpdatedAt:a.updatedAt-1}); assert.deepEqual(conflict,{ok:false,reason:'conflict'});
  assert.equal((await setCustomSkill({id:'4',name:'bad',files:{'SKILL.md':document('bad')}})).ok,false); assert.equal(await removeCustomSkill('4'),false);
});
await test('load activation and discovery carry only numeric IDs; pagination reconstructs original', async () => {
  const skill=await write('activation-fixture','A'.repeat(7000)+'中文😀'.repeat(1500));
  const activation=skillEngine.buildActivationRound([skill.id,skill.id,'activation-fixture']);
  assert.equal(activation.messages.length,2); assert.deepEqual(JSON.parse(activation.messages[0].tool_calls![0].function.arguments),{action:'load',skill_id:skill.id});
  const instruction=buildSkillInstruction(skill); assert.equal(instruction.skill,skill.id); assert.match(instruction.instruction,/skill_id/);
  assert.match(skillEngine.buildDiscoverySection([skill],[])!,new RegExp('- '+skill.id+':'));
  assert.equal(skillEngine.buildDiscoverySection([skill],[skill.id]),null);
  const text=skill.body, pages=[]; let page=1;
  for (;;) { const result=paginateSkillText(text,page++); assert.ok(result.ok); pages.push(result.page.content); if (page>result.page.pageCount) break; }
  assert.equal(pages.join(''),text); assert.equal(countSkillChars('中文😀'),3);
  const response=await call({action:'load',skill_id:skill.id}); assert.ok(response.success); assert.equal(response.data?.skill,skill.id);
  assert.equal((await call({action:'load',skill_name:skill.name})).success,false);
});
await test('create requires loaded guide; workspace files are copied byte-for-byte and linked to actual agent', async () => {
  await saveWorkspace(chatId,undefined,[{path:'scripts/report.js',blob:new Blob(['export const run = (args) => args;'])},{path:'template.bin',blob:new Blob([Uint8Array.of(0,255,10)])}]);
  const args={action:'create',name:'example-report-export',description:'Export reports at https://example.com/reports',content:'Use resources/report.js with dynamic arguments. Copy resources/template.bin before use.',files:['scripts/report.js','template.bin']};
  assert.equal((await call(args,{...ctx,loadedSkillIds:[]})).success,false);
  const result=await call(args); assert.ok(result.success,JSON.stringify(result));
  const skill=getSkillById(result.data!.skill_id as string)!; assert.ok(Number(skill.id)>=1001); assert.ok(linkedSkillIds(ctx.agentId).includes(skill.id));
  assert.equal(skill.files['resources/report.js'],'export const run = (args) => args;'); assert.equal(skill.resourceBytes!['resources/template.bin'],'AP8K');
  assert.equal(skill.files['SKILL.md'].includes('resources/template.bin'),true);
});
const editable=await write('example-edit','Steps:\n  if (ready) {\n    perform();\n  }\nDone.');
await test('edit supports indentation-aware atomic replacement and empty metadata preserves values', async () => {
  const result=await call({action:'edit',skill_id:editable.id,name:'',description:'',find:'if (ready) {\n  perform();\n}',replace:'if (ready) {\n  perform(args);\n}',matchMode:'indentation',expected_updated_at:editable.updatedAt});
  assert.ok(result.success,JSON.stringify(result)); const current=getSkillById(editable.id)!; assert.equal(current.description,editable.description); assert.match(current.body,/    perform\(args\);/);
  const before=structuredClone(current);
  const invalid=await call({action:'edit',skill_id:editable.id,edits:[{find:'Done.',replace:'Finished.'},{find:'missing',replace:'bad'}]}); assert.equal(invalid.success,false); assert.deepEqual(getSkillById(editable.id),before);
  assert.equal((await call({action:'edit',skill_id:editable.id,content:'new',find:'Done.',replace:'bad'})).success,false);
  assert.equal((await call({action:'edit',skill_id:editable.id,replaceAll:true})).success,false);
  assert.equal((await call({action:'edit',skill_id:editable.id,expected_updated_at:-1})).success,false);
});
await test('resource additions/replacements/removals commit together and protect paths', async () => {
  assert.ok((await call({action:'edit',skill_id:editable.id,files:['scripts/report.js']})).success);
  const current=getSkillById(editable.id)!;
  assert.equal((await call({action:'edit',skill_id:editable.id,files:['scripts/report.js']})).success,false);
  assert.equal((await call({action:'edit',skill_id:editable.id,remove_files:['resources/report.js'],files:[{path:'../escape',destination:'resources/a'}]})).success,false);
  assert.deepEqual(getSkillById(editable.id),current);
  assert.ok((await call({action:'edit',skill_id:editable.id,remove_files:['resources/report.js'],files:[{path:'scripts/report.js',destination:'resources/combined.js'}]})).success);
  assert.equal(getSkillById(editable.id)!.files['resources/report.js'],undefined);
  for (const path of ['SKILL.md','../escape','/absolute']) assert.equal((await call({action:'edit',skill_id:editable.id,remove_files:[path]})).success,false);
});
await test('copy works without Python, moves collisions to numeric ID folder and preserves prior copies', async () => {
  const first=await call({action:'copy',skill_id:editable.id,paths:['resources']}); assert.ok(first.success,JSON.stringify(first));
  assert.equal(first.data?.workspacePath,'.');
  const second=await call({action:'copy',skill_id:editable.id,paths:['resources']}); assert.equal(second.data?.workspacePath,editable.id);
  const third=await call({action:'copy',skill_id:editable.id,paths:['resources']}); assert.equal(third.data?.workspacePath,editable.id+'/copy-2');
  const snapshot=await chatDatabase.readWorkspace(chatId); assert.ok(snapshot?.entries.some(e=>e.path===editable.id+'/resources/combined.js'));
  assert.equal((await call({action:'copy',skill_id:editable.id,paths:['../escape']})).success,false);
});
await test('delete preserves on rejection/no UI and confirms exact target with optimistic concurrency', async () => {
  const target=await write('delete-fixture');
  assert.equal((await call({action:'delete',skill_id:target.id})).data?.deleted,false);
  let off=registerInteractHandler(async()=>({answered:false,status:'declined'}));
  assert.equal((await call({action:'delete',skill_id:target.id})).data?.deleted,false); off(); assert.ok(getSkillById(target.id));
  off=registerInteractHandler(async request=>({answered:true,answer:request.options[0].label,source:'option'}));
  assert.equal((await call({action:'delete',skill_id:target.id,expected_updated_at:target.updatedAt-1})).data?.deleted,false);
  assert.equal((await call({action:'delete',skill_id:target.id})).data?.deleted,true); off();
  assert.equal(getSkillById(target.id),undefined); assert.equal((await call({action:'delete',skill_id:target.id})).data?.reason,'not-found');
  assert.equal((await call({action:'delete',skill_id:'4'})).success,false);
});
await test('ZIP import/export preserves binary, BOM, empty directories and rejects traversal', async () => {
  const archive=zipSync({'zip-fixture/SKILL.md':strToU8(document('zip-fixture')),'zip-fixture/resources/data.bin':Uint8Array.of(0,255),'zip-fixture/resources/text.md':strToU8('\uFEFFhello\r\n'),'zip-fixture/empty/':new Uint8Array(),'zip-fixture/../escape.js':strToU8('bad')});
  const parsed=parseSkillZipBytes(archive), report=await commitImportCandidates(parsed.candidates); assert.equal(report.imported.length,1);
  const skill=getSkillById(report.imported[0].id)!, exported=unzipSync(exportSkillToZip(skill).bytes);
  assert.deepEqual([...exported['zip-fixture/resources/data.bin']],[0,255]); assert.ok(exported['zip-fixture/empty/']); assert.equal(skill.files['resources/text.md'],'\uFEFFhello\r\n'); assert.ok(!Object.keys(skill.files).some(path=>path.includes('..')));
});
await test('plugin Skills are local, upstream changes are staged, approval checks reviewed local version', async () => {
  const ref='ed25519:fixture/plugin/skills/export',pkg={key:'fixture-package',enabled:true,blocked:false,quarantined:false,manifest:{version:'1.0.0',displayName:'Fixture'},skills:[{ref,name:'example-plugin-export',description:'Export at https://example.com',allowedTools:[],body:'Use version one.',files:{},tags:[],category:'general'}]};
  const snapshot={generation:1,packages:[pkg]} as unknown as PluginSnapshot;
  await reconcilePluginSkills(snapshot); const id=await allocateSkillIdentity('plugin:'+ref),local=getSkillById(id)!; assert.equal(local.source,'custom'); assert.equal(local.origin?.ref,ref); assert.equal((await pendingPluginSkillUpdates()).length,0);
  await setCustomSkill({id,name:local.name,files:{'SKILL.md':document(local.name,'User edits')}});
  pkg.manifest.version='2.0.0'; pkg.skills[0].body='Use version two.'; await reconcilePluginSkills(snapshot);
  let pending=(await pendingPluginSkillUpdates())[0]; assert.equal(getSkillById(id)?.body.trim(),'User edits'); assert.equal(pending.id,id); assert.match(pending.incomingContent,/version two/);
  await setCustomSkill({id,name:local.name,files:{'SKILL.md':document(local.name,'Another local edit')}});
  await assert.rejects(approvePluginSkillUpdate(ref,pending.pending!.digest,pending.localUpdatedAt),/审阅/);
  pending=(await pendingPluginSkillUpdates())[0]; await approvePluginSkillUpdate(ref,pending.pending!.digest,pending.localUpdatedAt); assert.equal(getSkillById(id)?.body.trim(),'Use version two.'); assert.equal((await pendingPluginSkillUpdates()).length,0);
  pkg.skills.push({...pkg.skills[0],ref:ref+'-new',name:'example-plugin-new'}); await reconcilePluginSkills(snapshot); pending=(await pendingPluginSkillUpdates())[0]; assert.equal(getSkillById(pending.id),undefined); assert.equal(pending.localUpdatedAt,null);
  await approvePluginSkillUpdate(pending.ref,pending.pending!.digest,null); assert.ok(getSkillById(pending.id));
});
await test('capture thresholds count rounds, deduplicate messages, wait for completion and reset on user input', () => {
  const user={id:'u',role:'user',content:'task'},ai={id:'a',role:'assistant',content:'done',toolRounds:20,completionStatus:'done'};
  const state=(items: unknown[],running=false)=>skillCaptureState(items as ExtendedChatMessage[],running);
  assert.equal(state([user,ai]).eligible,false); ai.toolRounds=21; assert.equal(state([user,ai]).eligible,true); assert.equal(state([user,ai],true).eligible,false);
  assert.equal(state([user,{...ai,completionStatus:'stopped'}]).eligible,false); assert.equal(state([user,ai,ai]).taskRounds,21);
  assert.equal(state([user,ai,{...user,id:'u2'}]).eligible,false);
  assert.equal(state([user,{...ai,toolRounds:40}, {...user,id:'u2'},{...ai,id:'b',toolRounds:0}]).eligible,false);
  assert.equal(state([user,{...ai,toolRounds:41}, {...user,id:'u2'},{...ai,id:'b',toolRounds:0}]).eligible,true);
});
await test('failed writes report failure and keep authoritative version', async () => {
  const skill=await write('storage-fixture'), saved=chrome.storage.local.set;
  chrome.storage.local.set=(async()=>{throw new Error('quota fixture');}) as typeof saved;
  try { const result=await setCustomSkill({id:skill.id,name:skill.name,files:{'SKILL.md':document(skill.name,'should not commit')}}); assert.equal(result.ok,false); assert.equal(getSkillById(skill.id)?.body,skill.body); await assert.rejects(removeCustomSkill(skill.id),/SKILL_STORAGE_ERROR.*quota fixture/); assert.ok(getSkillById(skill.id)); }
  finally { chrome.storage.local.set=saved; await flushSkillStoreWrites(); }
});
await test('restoring the current storage format preserves version and rejects obsolete identities', async () => {
  const current=await write('restore-version');
  const stored=(await chrome.storage.local.get('agentNexusCustomSkills')).agentNexusCustomSkills;
  await chrome.storage.local.set({agentNexusCustomSkills:[...stored,{id:'old-random-id',name:'discarded-format',files:{'SKILL.md':document('discarded-format')},source:'custom',enabled:true,updatedAt:1}],agentNexusSkillsRevision:crypto.randomUUID()});
  await restoreCustomSkillsFromStorage(true);
  assert.equal(getSkillById(current.id)?.updatedAt,current.updatedAt);
  assert.equal(getSkillById('old-random-id'),undefined);
  assert.ok(!getAllSkills().some(skill=>skill.name==='discarded-format'));
  const edited=await setCustomSkill({id:current.id,name:current.name,files:current.files,expectedUpdatedAt:current.updatedAt});
  assert.ok(edited.ok,JSON.stringify(edited));
});
await test('failed creation never leaves an orphan Skill or agent link; metadata survives a fresh revision', async () => {
  const count=getAllSkills().length, links=linkedSkillIds(ctx.agentId), setter=chrome.storage.local.set;
  chrome.storage.local.set=(async()=>{throw new Error('atomic-create-fixture');}) as typeof setter;
  try {
    const result=await call({action:'create',name:'atomic-create',description:'Use at https://example.com',content:'Reusable steps'});
    assert.equal(result.success,false); assert.equal(getAllSkills().length,count); assert.deepEqual(linkedSkillIds(ctx.agentId),links);
  } finally { chrome.storage.local.set=setter; }
  const original=await write('metadata-restore');
  const changed=await setCustomSkill({id:original.id,name:original.name,files:original.files,description:'Updated metadata',allowedTools:[]});
  assert.ok(changed.ok,JSON.stringify(changed));
  assert.match(changed.skill.files['SKILL.md'],/description: "Updated metadata"/);
  await chrome.storage.local.set({agentNexusSkillsRevision:crypto.randomUUID()});
  await restoreCustomSkillsFromStorage(true);
  assert.equal(getSkillById(original.id)?.description,'Updated metadata');
  const marker=await setCustomSkill({id:original.id,name:original.name,files:{'SKILL.md':getSkillById(original.id)!.files['SKILL.md'].replace('name:', 'x-learning-marker: keep\nname:')}});
  assert.ok(marker.ok);
  assert.ok((await call({action:'edit',skill_id:original.id,description:'Another description'})).success);
  assert.match(getSkillById(original.id)!.files['SKILL.md'],/x-learning-marker: keep/);
  assert.equal((await call({action:'edit',skill_id:original.id,content:''})).success,false);
  assert.equal((await call({action:'edit',skill_id:original.id,content:null})).success,false);
  assert.equal((await call({action:'load',skill_id:'4'},{...ctx,chatId:'deleted-conversation'})).success,false);
});
await test('store rejects unsafe resource paths and authoring rejects malformed metadata', async () => {
  for (const path of ['../escape','/absolute','resources/__proto__/x']) assert.equal((await setCustomSkill({name:'unsafe',files:{'SKILL.md':document('unsafe'),[path]:'bad'}})).ok,false);
  for (const args of [{name:[]},{description:42},{content:42}]) assert.equal((await call({action:'edit',skill_id:editable.id,...args})).success,false);
  assert.equal((await call({action:'create',name:'without-agent',description:'fixture',content:'fixture'},{...ctx,agentId:''})).success,false);
});
await test('long valid resource paths round-trip through ZIP and conflicting directories are rejected', async () => {
  const name='example-long-resource-export-workflow', path=['resources','a'.repeat(250),'b'.repeat(250),'c'.repeat(250),'d'.repeat(240)].join('/');
  const result=await setCustomSkill({name,files:{'SKILL.md':document(name),[path]:'preserved'}});
  assert.ok(result.ok,JSON.stringify(result));
  const parsed=parseSkillZipBytes(exportSkillToZip(result.skill).bytes);
  assert.equal(parsed.candidates[0]?.files[path],'preserved');
  assert.throws(()=>exportSkillToZip({name,files:{}}),/without SKILL.md/);
  assert.equal((await setCustomSkill({id:result.skill.id,name,files:result.skill.files,folders:[path+'/child']})).ok,false);
});
await test('corrupt plugin bookkeeping fails closed without breaking the Skill catalog', async () => {
  const key='agentNexusManagedPluginSkills', current=(await chrome.storage.local.get(key))[key];
  await chrome.storage.local.set({[key]:{...current,corrupt:null,bad:{id:'4',ref:'bad'},broken:{id:'100000',ref:'broken',name:'broken',pluginKey:'plugin',pluginName:'Plugin',version:'1',acceptedDigest:'old',pending:{digest:'hash',version:'2',input:{id:'4'}}}}});
  const pending=await pendingPluginSkillUpdates();assert.ok(!pending.some(item=>['bad','broken'].includes(item.ref)));assert.equal(getSkillById('4')?.name,'skill-create');
});
await restoreCustomSkillsFromStorage(true);
console.log(`[skills] ${passed} scenario groups passed, ${getAllSkills().length} managed Skills.`);
