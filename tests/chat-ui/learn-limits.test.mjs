/** Actual budget chooser and phase orchestration, driven with deferred UI answers. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { transform } from 'esbuild';

const file = path.resolve('entrypoints/sidepanel/composables/use-learn-session.ts');
const source = readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const parts = new Map();
const names = ['askDialog', 'answerDialog', 'allowedChoices', 'settleValueFor', 'handleLimitReached', 'runPhase'];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) parts.set(node.name.text, node.getText(ast));
  if (ts.isVariableDeclaration(node) && ['DIALOG_CHOICES', 'DIALOG_SETTLE_VALUE'].includes(node.name.getText(ast)))
    parts.set(node.name.getText(ast), `const ${node.getText(ast)};`);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(parts.size, names.length + 2);
assert.ok(readFileSync('entrypoints/sidepanel/views/App.vue', 'utf8').includes('@answer="learn.answerDialog"'), 'App 不丢失自定义轮次参数');
const { code } = await transform(`
  let aborting=false, terminating=false, runEndedByUser=false, limitAction=null, resolveDialog=null;
  const LEARN_DEFAULT_EXTENSION_ITERATIONS=15;
  const isPositiveSafeInteger=n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=1;
  class LearnRunAbortedError extends Error {}
  const elapsedMs={value:1000}, toolCalls={value:0}, forceSubmitting={value:false};
  const contextUsage={value:null};
  const config={value:{autoValidate:false}}, sessionChatId={value:'test'};
  const draft={value:phase.value==='validating'?{body:'original skill'}:null}, report={value:null}, failure={value:null};
  const limits={maxIterations:60,maxDurationMs:1800000};
  const deps={notify:()=>{},t:key=>key};
  const startTicker=()=>{}, stopTicker=()=>{};
  const transcriptEngine={getEffectiveContext:async()=>({records:[],summary:''})};
  const collectCurrentAttemptContext=async()=>({records:[],summary:''});
  const unexpected=()=>{throw new Error('Unexpected failure path');};
  const handleFatalFailure=unexpected, handleNoDraft=unexpected, handleLearnFailure=unexpected;
  const buildMissingOutcomeFailure=unexpected;
  const cleanupSessionImpl=async()=>{outcome.push('discard'); draft.value=null; phase.value='idle';};
  const proceedToDrafting=async()=>{outcome.push('draft');};
  const handleValidationOutcome=async()=>{outcome.push('validated');};
  const runEngineOnce=async(stage,options)=>{
    limitAction=null;
    forceFlags.push(options.forceSubmit);
    if(!options.forceSubmit) {
      while(await handleLimitReached('max-iterations',limits,stage)) {}
    } else if(stage==='learning') draft.value={body:'skill'};
    else report.value={passed:true,issues:[]};
    return {status:'done'};
  };
  ${[...parts.values()].join('\n')}
  return { limit:handleLimitReached, answer:answerDialog, run:runPhase, limits,
    get action(){return limitAction;}, get forced(){return forceFlags;}, get result(){return outcome;} };
`, { loader: 'ts', target: 'es2022' });
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(stage) {
  const dialog = { value: null }, phase = { value: stage };
  return Object.assign(new Function('dialog', 'phase', 'outcome', 'forceFlags', code)(dialog, phase, [], []), { dialog, phase });
}
for (const stage of ['learning', 'validating']) {
  const h = harness(stage);
  for (const reason of ['max-iterations', 'max-duration', 'tool-failures', 'max-iterations']) {
    const pending = h.limit(reason, h.limits, stage);
    assert.equal(h.dialog.value.phase, stage);
    assert.equal(h.dialog.value.extraIterations, 15);
    assert.equal(h.answer('extend', 0), false);
    assert.equal(h.answer('extend', 1.5), false);
    assert.equal(h.answer('extend', Number.MAX_SAFE_INTEGER + 1), false);
    assert.ok(h.dialog.value, '坏输入不关闭选择弹窗');
    assert.equal(h.answer('extend', 1), true);
    assert.equal(await pending, true);
    assert.equal(h.limits.maxIterations, 1);
    assert.equal(h.action, null, '反复追加预算不会转为总结');
  }
  const pending = h.limit('max-iterations', h.limits, stage);
  h.answer('discard'); await tick();
  assert.equal(h.dialog.value.mode, 'stop', '丢弃需要二次确认');
  h.answer('cancel'); await tick();
  assert.equal(h.dialog.value.mode, 'limitWrapUp', '取消丢弃回到选择，不继续、不总结');
  h.answer('summarize');
  assert.equal(await pending, false);
  assert.equal(h.action, 'summarize');

  const summarize = harness(stage);
  const run = summarize.run(stage);
  await tick(); summarize.answer('summarize'); await run;
  assert.deepEqual(summarize.forced, [false, true], '总结选择切换到真实收尾运行');
  assert.deepEqual(summarize.result, [stage === 'learning' ? 'draft' : 'validated']);

  const discard = harness(stage);
  const stopped = discard.run(stage);
  await tick(); discard.answer('discard'); await tick(); discard.answer('confirm');
  await stopped;
  assert.deepEqual(discard.result, ['discard'], '引擎退出后才清理，避免回调等待自身');
  assert.deepEqual(discard.forced, [false], '确认丢弃后不再补跑总结');
  assert.equal(discard.phase.value, 'idle');
}
console.log('[chat-ui] Independent stage limits, repeated extension, discard confirmation/cancel and explicit summary orchestration passed.');
