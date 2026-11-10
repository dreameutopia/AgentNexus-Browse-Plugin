import {
  buildLearnPrompt,
  buildValidatePrompt,
  forceSubmitMessage,
  forceValidateMessage,
  learnKickoffMessage,
} from '../../utils/learn/learn-prompts';
import { validateLearnSkillBody } from '../../utils/learn/learn-output-contract';
import { validationToolIds } from '../../utils/learn/learn-tool-policy';
import {
  asSkillDraft,
  asValidationReport,
  asLearnFailureReport,
  countTextChars,
  isVisualSkillTool,
  reconcileSkillDraft,
  applyValidationRevision,
  validateLearnConfig,
  LEARN_DESCRIPTION_MAX_CHARS,
  stageRunLimits,
} from '../../utils/learn/learn-validate';
import { CORE_SESSION_TOOL_IDS, getPresetToolIds, getSiteLearnScenario, getSiteValidateScenario } from '../../utils/tools/tool-presets';
import { SubmitSkillTool } from '../../tools/learn/submit-skill-tool';
import { SubmitValidationTool } from '../../tools/learn/submit-validation-tool';
import {
  LEARN_DRAFT_HASH,
  SKILL_MAX_TAGS,
  isHumanBlockedReason,
  learnDraftHash,
  type LearnConfig,
  type LearnFailureReport,
  type SkillDraft,
} from '../../utils/learn/learn-types';
import {
  SKILL_BODY_MAX_CHARS,
  SKILL_NAME_MAX_CHARS,
} from '../../utils/skills/skill-types';

export async function testSiteLearning(check: (condition: boolean, label: string, detail?: unknown) => void): Promise<void> {
  check(CORE_SESSION_TOOL_IDS.includes('interact'), '学习与验证由运行时核心层注入 interact，无需在各预设重复声明');
  const base: LearnConfig = { url: 'https://example.com', goal: '根据关键词搜索所有相关商品', additionalDescription: '先按颜色选择规格\n已处理商品跳过', targetMode: 'text', strategy: 'text', modelRef: { channelId: 'test', modelId: 'test' }, autoValidate: true };
  const candidates = [{ key: 'test', ref: base.modelRef, label: 'test', channelName: 'test', canAcceptImages: true }];
  const configured = validateLearnConfig({ ...base, additionalDescription: `  ${base.additionalDescription}  ` }, candidates);
  check(configured.ok && configured.config.additionalDescription === base.additionalDescription, '配置保留多行额外描述并清理首尾空白');
  check(validateLearnConfig({ ...base, additionalDescription: undefined }, candidates).ok, '旧配置不含额外描述仍可用');
  check(validateLearnConfig({ ...base, additionalDescription: '' }, candidates).ok, '额外描述可留空');
  const independent = validateLearnConfig({ ...base, learningLimits: { maxIterations: 3, maxDurationMinutes: 2 }, validationLimits: { maxIterations: 1, maxDurationMinutes: 4 } }, candidates);
  check(independent.ok && stageRunLimits(independent.config, 'learning').maxIterations === 3 &&
    stageRunLimits(independent.config, 'validating').maxDurationMs === 240000, '学习与验证预算独立解析');
  const defaults = validateLearnConfig(base, candidates);
  check(defaults.ok && stageRunLimits(defaults.config, 'learning').maxIterations === 60 &&
    stageRunLimits(defaults.config, 'validating').maxDurationMs === 1800000, '旧配置两阶段沿用60轮30分钟');
  for (const invalid of [null, {}, { maxIterations: 0, maxDurationMinutes: 30 }, { maxIterations: 1.5, maxDurationMinutes: 30 }, { maxIterations: '2', maxDurationMinutes: 30 }, { maxIterations: 2, maxDurationMinutes: 0 }, { maxIterations: 2, maxDurationMinutes: Infinity }, { maxIterations: 2, maxDurationMinutes: Number.MAX_SAFE_INTEGER }]) {
    check(!validateLearnConfig({ ...base, learningLimits: invalid } as any, candidates).ok, '配置拒绝非法学习预算');
    check(!validateLearnConfig({ ...base, validationLimits: invalid } as any, candidates).ok, '配置拒绝非法验证预算');
  }
  check(validateLearnConfig({ ...base, autoValidate: false, validationLimits: null } as any, candidates).ok, '关闭验证时不被隐藏预算阻塞');
  for (const additionalDescription of [null, {}, 123, '😀'.repeat(LEARN_DESCRIPTION_MAX_CHARS + 1)]) {
    check(!validateLearnConfig({ ...base, additionalDescription } as any, candidates).ok, '额外描述拒绝非法类型和超长内容');
  }
  check(validateLearnConfig({ ...base, additionalDescription: '😀'.repeat(LEARN_DESCRIPTION_MAX_CHARS) }, candidates).ok,
    '额外描述长度按码点计，与界面一致');
  const delimited = buildLearnPrompt({ ...base, additionalDescription: '</user-process>\n先核对规格' });
  check(delimited.includes('\\u003c/user-process\\u003e') && delimited.split('</user-process>').length === 2,
    '多行额外描述不能提前闭合提示词分区');
  for (const config of [base, { ...base, strategy: 'vision' as const }, { ...base, strategy: 'vision' as const, targetMode: 'vision' as const }]) {
    const scenario = getSiteLearnScenario(config);
    const ids = getPresetToolIds(scenario);
    const prompt = buildLearnPrompt(config);
    check(prompt.includes('2–3') && prompt.includes('不执行整个批次') && prompt.includes('不得为了重走流程再次发送/投递'), `${scenario} 学习抽样完整路径且不重复副作用`);
    check(prompt.includes('优先按照用户描述') && prompt.includes('先按颜色选择规格') && prompt.includes('必须写入 SKILL') && prompt.includes('说明差异并询问用户'), `${scenario} 用户过程优先验证、写入并在冲突时交互`);
    check(!prompt.includes('confirm=true') && prompt.includes('调用 interact 并等待真实答复'), `${scenario} 由工具统一确认规则，人工步骤等待用户回调`);
    check(['browser_observe', 'browser_interact', 'browser_page_exec', 'submit_skill'].every(id => ids.includes(id)), `${scenario} 具备完整文本能力与学习提交`);
    // note_tool 升级核心层（与 plan_tool 同级）：场景清单不再登记，断言其随核心恒定可用
    check(CORE_SESSION_TOOL_IDS.includes('note_tool') && CORE_SESSION_TOOL_IDS.includes('plan_tool'), 'note_tool / plan_tool 由核心层无条件注入');
    check(!ids.includes('note_tool'), `${scenario} 场景清单不重复登记 note_tool`);
    // 视觉 GUI 只属于视觉目标：文本目标无论何种策略都没有 vision_gui
    //（标签页/窗口管理随 browser_tabs 基座对全部目标在场——枚举是纯只读，
    //  与截图策略无关，不再是视觉目标专属标记）
    check(ids.includes('vision_gui') === (config.targetMode === 'vision'), `${scenario} vision_gui 仅视觉目标具备`);
    check(ids.includes('browser_tabs'), `${scenario} 标签页/窗口管理随基座在场`);
    if (config.targetMode === 'text') {
      check(!ids.some(id => id.startsWith('vision_') || id === 'ocr'), `${scenario} 文本目标不携带任何 vision_* 手势工具`);
    }
    // 截图能力跟随学习策略（文本目标×视觉策略靠自动截图辅助理解）
    check(ids.includes('screenshot') === (config.strategy === 'vision'), `${scenario} 截图能力跟随学习策略`);
    check(!ids.includes('submit_validation'), `${scenario} 不泄漏验证提交工具`);
    check(new Set(ids).size === ids.length, `${scenario} 工具不重复`);
    check(prompt.includes('读取节点详情') && prompt.includes('至少两个') && prompt.includes('为什么'), `${scenario} 引导属性取证、双线索与原因`);
    check(prompt.includes('参数以工具说明为准') && !prompt.includes('DOM 引用同时传同一行 FrameId'), `${scenario} 调用契约归工具维护，不泛化 FrameId 要求`);
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
    // 交付物定位：本次会话要的是「探索并总结完成目标所需的全部详细步骤与注意事项」，
    // 不是替用户把目标做成——角色块、工作流、产出规范三处共同强化
    check(
      prompt.includes('探索并总结') && prompt.includes('替用户把这件事做成了'),
      `${scenario} 明确交付物是探索总结而非完成目标`,
    );
    check(
      prompt.includes('本次任务：探索并总结') && prompt.includes('不是替用户执行这个目标'),
      `${scenario} 任务块声明本次是探索总结而非执行目标`,
    );
    check(
      prompt.includes('主路径已有结果回执后再补关键差异') && prompt.includes('不先滚完整个列表') && prompt.includes('回头核对'),
      `${scenario} 先闭环、再差异复核，不用全量加载代替可复用性证据`,
    );
    check(prompt.includes('给陌生执行者看的操作手册'), `${scenario} 产出规范把正文定义为可复现的操作手册`);
    // 终态分化：成功与失败都是终态，且失败不必交正文
    check(
      prompt.includes('status=success') && prompt.includes('status=failed') && prompt.includes('status=blocked'),
      `${scenario} 终止契约区分成功/失败/被阻断三种终态`,
    );
    check(prompt.includes('不许空手离开') && prompt.includes('不许硬凑成功'), `${scenario} 终止契约要求失败也必须提交`);
    // 自主解决阶梯
    check(prompt.includes('<self-rescue>') && prompt.includes('先自救，再考虑失败'), `${scenario} 给出自主解决的升级阶梯`);
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
  const repairedPrompt = buildLearnPrompt(base, { kind: 'validation', report: { passed: false, issues: ['第 2 步找不到搜索框，需要先展开搜索弹层'] } });
  check(repairedPrompt.includes('<previous-validation>') && repairedPrompt.includes('第 2 步找不到搜索框'), '重新学习携带上次盲测问题');
  // 失败反馈走独立分区：与盲测问题清单分开，模型不会拿「技能写错了」的
  // 心智模型去改一份根本不存在的技能
  const failurePrompt = buildLearnPrompt(base, {
    kind: 'failure',
    report: {
      reason: 'login-required',
      detail: '第 3 步进入详情页时跳回登录页',
      findings: ['搜索入口 XPath=//input[@name="q"]', '结果列表每页 40 条'],
      suggestion: '先完成登录再重跑',
    },
  });
  check(failurePrompt.includes('<previous-failure>') && failurePrompt.includes('第 3 步进入详情页时跳回登录页'), '重新学习携带上次失败卡点');
  check(failurePrompt.includes('搜索入口 XPath=//input[@name="q"]'), '重新学习携带上次已探明的知识');
  check(!failurePrompt.includes('<previous-validation>'), '失败反馈与盲测反馈分区分离');
  const args = { status: 'success', name: 'pinduoduo-search-products', description: '根据关键词搜索商品时使用', category: 'search', body, allowedTools: ['browser_observe', 'browser_interact'], mode: 'text', tags: ['视觉模式', '搜索'] };
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
    ['缺少终态声明', { status: undefined }],
  ] as const) {
    check(!(await tool.execute({ ...args, ...patch })).success, `提交拒绝：${label}`);
  }

  // ── 失败终态：不必交正文也能收尾，失败同样有产出 ──
  const failureResult = await tool.execute({
    status: 'failed',
    reason: 'login-required',
    detail: '第 3 步进入详情页时跳回登录页',
    findings: ['搜索入口 XPath=//input[@name="q"]'],
    suggestion: '先完成登录再重跑',
  });
  check(failureResult.success && !!failureResult.data?.failure, '失败提交成功即终止并交付失败报告');
  const failure = failureResult.data?.failure as LearnFailureReport;
  check(failure?.reason === 'login-required' && failure?.detail.includes('跳回登录页'), '失败报告保留原因分类与卡点详情');
  check(failure?.findings.length === 1 && failure?.suggestion?.includes('登录') === true, '失败报告保留已探明的知识与建议');
  check(!(await tool.execute({ status: 'failed', reason: '不存在的分类', detail: 'x' })).success, '失败提交拒绝未知原因分类');
  check(!(await tool.execute({ status: 'failed', reason: 'timeout', detail: '   ' })).success, '失败提交拒绝空卡点详情');
  check(
    (await tool.execute({ status: 'blocked', reason: 'captcha', detail: '搜索时弹出滑块验证' })).success,
    '被外部条件阻断同样是一等终态',
  );
  for (const targetMode of ['text', 'vision'] as const) {
    const cfg = { ...base, targetMode };
    const ids = getPresetToolIds(getSiteValidateScenario(targetMode));
    check(ids.includes('browser_observe') && ids.includes('browser_interact') && ids.includes('submit_validation') && !ids.includes('submit_skill'), `${targetMode} 盲测具备文本能力且终止工具隔离`);
    // 验证组的视觉能力同样只按目标模式分叉
    check(ids.includes('vision_gui') === (targetMode === 'vision'), `${targetMode} 验证组 vision_gui 归属正确`);
    check(ids.includes('screenshot') === (targetMode === 'vision'), `${targetMode} 验证组截图归属正确`);
    check(new Set(ids).size === ids.length, `${targetMode} 验证组工具不重复`);
    const prompt = buildValidatePrompt(cfg, { ...draft, mode: targetMode, allowedTools: [...draft.allowedTools, ...(targetMode === 'vision' ? ['vision_gui'] : [])] });
    check(prompt.includes('2–3') && prompt.includes('有界诊断和修订') && prompt.includes('submit_validation.revision') && prompt.includes('不能为盲测重复发送/投递'), `${targetMode} 验证以通用抽样修订代替整批执行`);
    check(!prompt.includes('你不是来优化它的') && !prompt.includes('禁止自行探索技能之外的路径'), `${targetMode} 去除禁止修订的旧指令`);
    check(!prompt.includes('confirm=true') && prompt.includes('先调用 interact，等待答复'), `${targetMode} 验证支持人工处理后继续核验`);
    check(prompt.includes('起始页面') && prompt.includes('至少两个线索') && !prompt.includes('siteLearn'), `${targetMode} 盲测从起点验收最终规范，不带学习策略`);
    check(prompt.includes('注意事项与恢复路径'), `${targetMode} 盲测核对注意事项与恢复路径是否写全`);
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
  const evidence = ['不同样本重新定位，业务回执与目标对应；未制造异常分支'];
  check(asValidationReport({ passed: true, issues: [], evidence })?.passed === true, '验收报告守卫放行有证据的合法回执');
  check(asValidationReport({ passed: 'yes', issues: [] }) === null, '验收报告守卫拒绝字符串布尔');
  check(
    isVisualSkillTool('vision_gui') && isVisualSkillTool('screenshot') && isVisualSkillTool('ocr') && !isVisualSkillTool('browser_interact'),
    '视觉工具口径与提交拒绝口径一致',
  );

  // ── 失败报告守卫与强制收尾轮 ──
  check(
    asLearnFailureReport({ reason: 'login-required', detail: '跳回登录页', findings: [] })?.reason === 'login-required',
    '失败报告守卫放行合法回执',
  );
  check(asLearnFailureReport({ reason: 'unknown-code', detail: 'x', findings: [] }) === null, '失败报告守卫拒绝未知原因分类');
  check(asLearnFailureReport({ reason: 'timeout', detail: '  ', findings: [] }) === null, '失败报告守卫拒绝空卡点详情');
  check(asLearnFailureReport({ reason: 'timeout', detail: 'x' }) === null, '失败报告守卫拒绝缺 findings 字段');

  const forced = forceSubmitMessage(base);
  check(
    forced.includes('submit_skill') && forced.includes('status=failed') && forced.includes('不需要正文'),
    '强制收尾轮给出成功/失败两条路并免除失败时的正文义务',
  );
  check(learnKickoffMessage(base).includes('status=failed'), '首轮消息即声明失败也必须提交');
  const forcedValidate = forceValidateMessage(base, draft);
  check(
    forcedValidate.includes('submit_validation') && forcedValidate.includes('passed=true'),
    '验证段强制收尾轮要求交出结论',
  );

  // ── 防御性边界：长度、数量与形态的上限必须在守卫层就拦下 ──
  check(countTextChars('abc') === 3 && countTextChars('😀') === 1, '字数按码点计（emoji 记 1 字）');
  check(
    asSkillDraft({ ...visionDraft, body: 'x'.repeat(SKILL_BODY_MAX_CHARS + 1) }) === null,
    '形态守卫拒绝超长正文（不把超限内容写进跨页存储）',
  );
  check(
    asSkillDraft({ ...visionDraft, name: 'a'.repeat(SKILL_NAME_MAX_CHARS + 1) }) === null,
    '形态守卫拒绝超长技能名',
  );
  check(
    asSkillDraft({ ...visionDraft, tags: Array.from({ length: SKILL_MAX_TAGS + 1 }, () => 't') }) === null,
    '形态守卫拒绝超量标签',
  );
  check(
    asSkillDraft({ ...visionDraft, summary: 123 as unknown as string }) === null,
    '形态守卫拒绝非字符串摘要',
  );
  check(
    reconcileSkillDraft({ ...visionDraft, tags: Array.from({ length: 10 }, (_, i) => `t${i}`), mode: 'text' }, 'text')
      ?.tags.length === SKILL_MAX_TAGS,
    '对账把超量标签截到上限',
  );
  check(
    isHumanBlockedReason('login-required') && isHumanBlockedReason('captcha') && isHumanBlockedReason('permission-denied')
      && !isHumanBlockedReason('flow-broken') && !isHumanBlockedReason('other'),
    '「必须由人完成」的原因分类口径正确',
  );

  // ── 草稿深链必须每次不同（否则 hub 已在同一 hash 时不会重新消费）──
  const hashA = learnDraftHash();
  const hashB = learnDraftHash();
  check(hashA.startsWith(`${LEARN_DRAFT_HASH}?`) && hashB.startsWith(`${LEARN_DRAFT_HASH}?`), '草稿深链带一次性 nonce');
  check(hashA !== hashB, '草稿深链每次交付都不同（保证 hashchange 触发）');

  // ── 验收结论：通过时不强制 issues（纯仪式要求会让模型多踩一个空数组）──
  const validationTool = new SubmitValidationTool();
  const passedNoIssues = await validationTool.execute({ passed: true, evidence });
  check(passedNoIssues.success && (passedNoIssues.data?.report as { passed: boolean })?.passed === true, '验收通过时可省略 issues');
  const failedNoIssues = await validationTool.execute({ passed: false });
  check(!failedNoIssues.success, '验收不通过时必须给出问题清单');
  const failedWithIssues = await validationTool.execute({ passed: false, issues: ['第 2 步定位失败'] });
  check(failedWithIssues.success, '验收不通过且清单齐备时正常提交');
  const revision = { body: body.replace('按关键词搜索商品。', '按输入关键词搜索商品，默认使用文本搜索。'), summary: '补充通用搜索规则', evidence: ['两种关键词均能重新定位搜索框并回读输入值'] };
  const revisedResult = await validationTool.execute({ passed: true, revision });
  const revisedReport = asValidationReport(revisedResult.data?.report);
  check(revisedResult.success && !!revisedReport?.revision, '验证提交可交付经复核的完整修订');
  const revisedDraft = revisedReport ? applyValidationRevision(draft, revisedReport) : null;
  check(revisedDraft?.body === revision.body && draft.body === body && revisedDraft.name === draft.name && revisedDraft.allowedTools === draft.allowedTools,
    '修订仅替换正文，不变更原草稿、技能身份或工具权限');
  check(applyValidationRevision(draft, { passed: true, issues: [], evidence }) === draft, '未修订时保留原草稿');
  check(!(await validationTool.execute({ passed: true })).success, '无复核证据不能通过');
  check(!(await validationTool.execute({ passed: true, evidence, issues: ['选择器错误，靠额外脚本绕过'] })).success, '不能带未解决问题通过');
  check(asValidationReport({ passed: true, issues: ['仍有错误'], evidence }) === null, '编排守卫也拒绝带问题通过');
  check(asValidationReport({ passed: true, issues: [] }) === null, '编排守卫拒绝缺少证据的通过回执');
  const suggested = await validationTool.execute({ passed: true, evidence, suggestions: ['可选缩短文案'] });
  check(suggested.success && suggested.data?.report.suggestions[0] === '可选缩短文案', '纯建议与未解决问题分开保留');
  for (const patch of [{ issues: [''] }, { evidence: [''] }, { evidence: [123] }, { suggestions: null }, { issues: [123] }]) {
    check(!(await validationTool.execute({ passed: true, evidence, ...patch })).success, '不静默丢弃非法问题或证据');
  }
  const validationIds = validationToolIds(draft);
  check(validationIds.includes('browser_observe') && validationIds.includes('submit_validation') && validationIds.includes('interact'), '验证保留声明工具和必要阶段基础能力');
  check(!validationIds.includes('browser_page_exec') && !validationIds.includes('browser_tabs') && !validationIds.includes('browser_get_page_html'), '未声明的诊断工具不能掩盖依赖缺漏');
  check(!validationToolIds({ ...draft, mode: 'text', allowedTools: ['vision_gui', 'submit_skill'] }).includes('vision_gui'), '验证边界不被错误模式扩大');
  check(validationToolIds({ ...draft, allowedTools: ['browser_get_page_html', 'data_ref_tool'] }).includes('browser_get_page_html'), '合法声明依赖不因不在预设中被静默剥离，注册表仍由runtime校验');
  for (const patch of [
    { passed: false, issues: ['尚未复核'] },
    { revision: { ...revision, evidence: [] } },
    { revision: { ...revision, evidence: [''] } },
    { revision: { ...revision, body: '只有半段说明' } },
    { revision: { ...revision, body: 'x'.repeat(SKILL_BODY_MAX_CHARS + 1) } },
    { revision: { ...revision, body: `${body}\nanx:11:abc123:2` } },
    { revision: { ...revision, allowedTools: ['vision_gui'] } },
    { revision: null },
  ]) {
    const submitted = await validationTool.execute({ passed: true, revision, ...patch });
    check(!submitted.success, '未通过、无证据、残缺、超长或越权修订不结束验证');
  }
  check(asValidationReport({ passed: true, issues: [], revision: { body: '坏正文' } }) === null, '守卫不静默丢弃坏修订并误认原文通过');
  check(asValidationReport({ passed: true, issues: [], revision, evidence: null }) === null, '显式非法证据不能被修订证据兜底掩盖');
  check(asValidationReport({ passed: false, issues: [], revision }) === null, '守卫拒绝不通过的修订回执');
}
