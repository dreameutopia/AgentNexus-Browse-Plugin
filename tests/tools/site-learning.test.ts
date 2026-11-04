import { buildLearnPrompt, buildValidatePrompt } from '../../utils/learn/learn-prompts';
import { validateLearnSkillBody } from '../../utils/learn/learn-output-contract';
import {
  asSkillDraft,
  asValidationReport,
  isVisualSkillTool,
  reconcileSkillDraft,
} from '../../utils/learn/learn-validate';
import { getPresetToolIds, getSiteLearnScenario, getSiteValidateScenario } from '../../utils/tools/tool-presets';
import { SubmitSkillTool } from '../../tools/learn/submit-skill-tool';
import type { LearnConfig, SkillDraft } from '../../utils/learn/learn-types';

export async function testSiteLearning(check: (condition: boolean, label: string, detail?: unknown) => void): Promise<void> {
  const base: LearnConfig = { url: 'https://example.com', goal: '根据关键词搜索所有相关商品', targetMode: 'text', strategy: 'text', modelRef: { channelId: 'test', modelId: 'test' }, autoValidate: true };
  for (const config of [base, { ...base, strategy: 'vision' as const }, { ...base, strategy: 'vision' as const, targetMode: 'vision' as const }]) {
    const scenario = getSiteLearnScenario(config);
    const ids = getPresetToolIds(scenario);
    const prompt = buildLearnPrompt(config);
    check(['browser_observe', 'browser_interact', 'browser_page_exec', 'submit_skill', 'note_tool'].every(id => ids.includes(id)), `${scenario} 具备完整文本能力与学习提交`);
    // 视觉 GUI 只属于视觉目标：文本目标无论何种策略都没有 vision_gui / browser_window
    check(ids.includes('vision_gui') === (config.targetMode === 'vision'), `${scenario} vision_gui 仅视觉目标具备`);
    check(ids.includes('browser_window') === (config.targetMode === 'vision'), `${scenario} 窗口管理仅视觉目标具备`);
    if (config.targetMode === 'text') {
      check(!ids.some(id => id.startsWith('vision_') || id === 'ocr'), `${scenario} 文本目标不携带任何 vision_* 手势工具`);
    }
    // 截图能力跟随学习策略（文本目标×视觉策略靠自动截图辅助理解）
    check(ids.includes('screenshot') === (config.strategy === 'vision'), `${scenario} 截图能力跟随学习策略`);
    check(!ids.includes('submit_validation'), `${scenario} 不泄漏验证提交工具`);
    check(new Set(ids).size === ids.length, `${scenario} 工具不重复`);
    check(prompt.includes('view="element"') && prompt.includes('至少两个') && prompt.includes('为什么'), `${scenario} 引导属性取证、双线索与原因`);
    check(prompt.includes('## 完成计划') && prompt.includes('## 具体操作讲解') && prompt.includes('去重'), `${scenario} 要求计划、讲解与完整覆盖`);
    // 学习域 prompt 独立：不得内嵌两个动作智能体的 SOP 分区
    check(!prompt.includes('<text-interaction-sop>') && !prompt.includes('<keyboard-shortcuts>') && !prompt.includes('<recovery-by-error>'), `${scenario} 不内嵌动作智能体 SOP`);
    // <vision-gui-tool> 分区必须存在（协议标记），但内容按目标模式分叉
    check(prompt.includes('<vision-gui-tool>'), `${scenario} 携带 vision-gui-tool 协议分区`);
    if (config.targetMode === 'text') {
      check(!prompt.includes('vision_gui(action') && prompt.includes('本阶段没有视觉 GUI 工具'), `${scenario} 文本目标声明无视觉 GUI 且无手势调用形态`);
      check(prompt.includes('DOM 文本通道'), `${scenario} 文本目标引导走 DOM 取证`);
    } else {
      check(prompt.includes('vision_gui(action="mark"') && prompt.includes('本阶段唯一视觉手势入口是 vision_gui'), `${scenario} 视觉目标携带自有手势契约`);
    }
    if (config.strategy === 'vision' && config.targetMode === 'text') {
      check(prompt.includes('截图只用于帮助你理解屏幕元素') && prompt.includes('截图不能成为执行前提'), `${scenario} 截图仅辅助理解且不得成为执行前提`);
    }
    if (config.targetMode === 'vision') check(prompt.includes('形状/颜色/图标/组件形式'), '视觉目标增加外观线索');
  }
  const body = `## 目标
按关键词搜索商品。
## 前置条件
登录并打开首页，关键词为参数。
## 完成计划
1. 点击搜索入口
2. 输入关键词
## 具体操作讲解
### 1. 点击搜索入口
动作与原因：进入搜索页面以输入条件。目标 XPath=//button[@name='search']，文本=搜索。
操作：先 xpath 搜索，未命中移除 xpath 改文本 regex，核对 Context 后点击。
成功判据：搜索框出现。注意：等待加载，避免广告入口。
### 2. 输入关键词
动作与原因：限定结果范围。XPath=//input[@name='q']，placeholder=搜索商品。
操作：重新枚举并 fill。成功判据：输入值与关键词相同。注意：不直接触发下单。
## 分支与坑点
若需登录交由人工。
## 完成判定
输入值核对通过。
## 边界
该测试只覆盖搜索输入，不代表全部结果采集。`;
  check(validateLearnSkillBody(body).length === 0, '有效计划与讲解通过结构校验');
  check(validateLearnSkillBody(body.replace('### 2.', '### 3.')).length > 0, '编号错位拒绝');
  check(validateLearnSkillBody(body.replace('## 完成计划', '## 工作流')).length > 0, '缺少完成计划拒绝');
  check(validateLearnSkillBody('---\nname: example\n---\n' + body).length > 0, 'frontmatter 拒绝');
  check(validateLearnSkillBody('```markdown\n' + body + '\n```').length > 0, '示例代码块不能冒充技能正文');
  check(validateLearnSkillBody(body + '\n## 目标\n重复').length > 0, '重复标题拒绝');
  const repairedPrompt = buildLearnPrompt(base, { passed: false, issues: ['第 2 步找不到搜索框，需要先展开搜索弹层'] });
  check(repairedPrompt.includes('<previous-validation>') && repairedPrompt.includes('第 2 步找不到搜索框'), '重新学习携带上次盲测问题');
  const args = { name: 'pinduoduo-search-products', description: '根据关键词搜索商品时使用', category: 'search', body, allowedTools: ['browser_observe', 'browser_interact'], mode: 'text', tags: ['视觉模式', '搜索'] };
  const tool = new SubmitSkillTool();
  const valid = await tool.execute(args);
  check(valid.success && !!valid.data?.draft, '提交同时交付名称与正文');
  const draft = valid.data?.draft as SkillDraft;
  check(draft?.tags.includes('文本模式') && !draft?.tags.includes('视觉模式'), '提交去除冲突模式标签');
  for (const [label, patch] of [
    ['缺少任务名', { name: 'pinduoduo' }],
    ['缺少正文结构', { body: '点击搜索' }],
    ['拼错工具不静默剔除', { allowedTools: ['browser_observe', 'browser_intercat'] }],
    ['学习内部工具', { allowedTools: ['browser_observe', 'submit_skill'] }],
    ['文本技能依赖视觉工具', { allowedTools: ['browser_observe', 'vision_gui'] }],
  ] as const) {
    check(!(await tool.execute({ ...args, ...patch })).success, `提交拒绝：${label}`);
  }
  for (const targetMode of ['text', 'vision'] as const) {
    const cfg = { ...base, targetMode };
    const ids = getPresetToolIds(getSiteValidateScenario(targetMode));
    check(ids.includes('browser_observe') && ids.includes('browser_interact') && ids.includes('submit_validation') && !ids.includes('submit_skill'), `${targetMode} 盲测具备文本能力且终止工具隔离`);
    // 验证组的视觉能力同样只按目标模式分叉
    check(ids.includes('vision_gui') === (targetMode === 'vision'), `${targetMode} 验证组 vision_gui 归属正确`);
    check(ids.includes('screenshot') === (targetMode === 'vision'), `${targetMode} 验证组截图归属正确`);
    check(new Set(ids).size === ids.length, `${targetMode} 验证组工具不重复`);
    const prompt = buildValidatePrompt(cfg, { ...draft, mode: targetMode });
    check(prompt.includes('起始页面') && prompt.includes('至少两个线索') && !prompt.includes('siteLearn'), `${targetMode} 盲测从起点验收最终规范，不带学习策略`);
    check(!prompt.includes('<text-interaction-sop>') && !prompt.includes('<keyboard-shortcuts>'), `${targetMode} 盲测不内嵌动作智能体 SOP`);
    if (targetMode === 'text') {
      check(!prompt.includes('vision_gui(action') && prompt.includes('本阶段没有视觉 GUI 工具'), `${targetMode} 盲测声明无视觉 GUI`);
    } else {
      check(prompt.includes('vision_gui(action="mark"') && prompt.includes('本阶段唯一视觉手势入口是 vision_gui'), `${targetMode} 盲测携带自有手势契约`);
    }
  }

  // ── 回执对账与形态守卫（learn-validate 纯函数契约）──
  const visionDraft: SkillDraft = {
    name: 'demo-skill',
    description: '演示技能',
    category: 'general',
    tags: ['搜索', '视觉模式'],
    body: '## 目标\n演示',
    allowedTools: ['browser_observe', 'vision_gui', 'screenshot', 'submit_skill'],
    mode: 'vision',
  };
  const reconciled = reconcileSkillDraft(visionDraft, 'text');
  check(!!reconciled && reconciled.mode === 'text', '对账纠正 mode 与目标模式一致');
  check(!!reconciled && reconciled.tags.includes('文本模式') && !reconciled.tags.includes('视觉模式'), '对账纠正模式标签');
  check(
    !!reconciled &&
      !reconciled.allowedTools.some(isVisualSkillTool) &&
      !reconciled.allowedTools.includes('submit_skill'),
    '对账剥离视觉工具与学习内部工具',
  );
  check(reconcileSkillDraft({ ...visionDraft, allowedTools: ['vision_gui'] }, 'text') === null, '剥离后无可用工具按无产出拒绝');
  const visionOk = reconcileSkillDraft({ ...visionDraft, tags: ['视觉模式'], allowedTools: ['browser_observe', 'vision_gui'] }, 'vision');
  check(
    !!visionOk && visionOk.mode === 'vision' && visionOk.allowedTools.includes('vision_gui'),
    '视觉目标不误伤视觉工具',
  );
  check(asSkillDraft(null) === null && asSkillDraft({ name: 'x' }) === null, '形态守卫拒绝残缺回执');
  check(asSkillDraft(visionDraft)?.name === 'demo-skill', '形态守卫放行完整回执');
  check(asValidationReport({ passed: true, issues: [] })?.passed === true, '验收报告守卫放行合法回执');
  check(asValidationReport({ passed: 'yes', issues: [] }) === null, '验收报告守卫拒绝字符串布尔');
  check(
    isVisualSkillTool('vision_gui') && isVisualSkillTool('screenshot') && isVisualSkillTool('ocr') && !isVisualSkillTool('browser_interact'),
    '视觉工具口径与提交拒绝口径一致',
  );
}
