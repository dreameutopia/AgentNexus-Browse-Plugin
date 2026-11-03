/**
 * 技能领域单元测试
 *
 * 覆盖：
 *   1. id 保留区间：内置技能 id 形态与确定性；两类生成器（确定性 / 随机）
 *      一律避开保留区间；确定性生成在哈希落进保留区间时加盐让位且仍确定；
 *      占用时追加后缀；随机生成 500 次互不重复（并发保护的下限）。
 *   2. 同名技能：写入不再拒绝重名、id 互不相同、按名查询命中首个注册者、
 *      按 id / 模型标识各自精确命中、编辑可改名到既有同名、导入不重命名。
 *   3. 合成激活轮：assistant(tool_calls) + tool 结果的配对形态、与真实
 *      load_skill 回传逐字同源、多技能单轮、按技能 id 去重、失效/停用跳过、
 *      预授权工具有序去重。
 *   4. 指令装配：优先级约定置顶、环境说明、预授权工具回显、资源文件清单、
 *      超长正文截断与取原文指引、未声明工具的占位文案。
 *   5. 发现清单：已激活技能被排除、条目为「- 模型标识: 描述」、全激活时为 null。
 *   6. 预置技能装配：合成 glob 注入的预置技能经 initStore 走真实装配链路，
 *      id 落在保留区间且由名称确定性派生；与预置同名的自定义技能可写入、
 *      id 不同、按 id / 模型标识各自精确命中、按名解析回落首个注册者。
 *
 * 运行：node tests/skills/run.mjs   （或 npm run test:skills）
 */

import {
  SKILL_BODY_MAX_CHARS,
  SKILL_ID_PATTERN,
  SKILL_ID_RESERVED_PREFIX,
  generateSkillId,
  generateUniqueSkillId,
  isReservedSkillId,
  modelSkillIdOf,
  presetSkillIdFromName,
  skillIdFromName,
} from '@/utils/skills/skill-types';
import {
  buildSkillInstruction,
  skillLoadSuccessMessage,
  skillLoadToolContent,
} from '@/utils/skills/skill-instruction';
import {
  getSkillByName,
  resolveSkill,
  setCustomSkill,
} from '@/utils/skills/skill-store';
import { commitImportCandidates } from '@/utils/skills/skill-import-export';
import { skillEngine } from '@/entrypoints/sidepanel/core/registry/skill-engine';
import { buildSuccessPayload } from '@/common/tool-handler';
import type { SkillRecord } from '@/utils/skills/skill-types';

// ==================== 极简断言 ====================

let passed = 0;
const failures: string[] = [];

function check(cond: boolean, label: string, extra?: unknown): void {
  if (cond) passed++;
  else failures.push(label + (extra !== undefined ? ` => ${JSON.stringify(extra)}` : ''));
}

function eq(actual: unknown, expected: unknown, label: string, extra?: unknown): void {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    extra !== undefined ? extra : { actual, expected },
  );
}

/** 断言写入成功并返回记录（失败时记一条断言并跳过后续依赖它的用例） */
function mustWrite(input: Parameters<typeof setCustomSkill>[0], label: string): SkillRecord {
  const result = setCustomSkill(input);
  if (!result.ok) {
    check(false, `${label}：写入应成功`, result);
    // 构造一个占位记录，避免后续解包崩溃（其断言会自然失败）
    return {
      id: 'placeholder',
      name: 'placeholder',
      description: '',
      allowedTools: [],
      files: {},
      body: '',
      category: 'general',
      tags: [],
      source: 'custom',
      enabled: true,
      updatedAt: 0,
    };
  }
  check(true, `${label}：写入成功`);
  return result.skill;
}

/** 组装合法的 SKILL.md 文件集（frontmatter 必须带 description，否则存储层拒收） */
function mdFiles(name: string, body: string, extraFrontmatter: string[] = []): Record<string, string> {
  return {
    'SKILL.md': ['---', `name: ${name}`, 'description: 单元测试技能描述', ...extraFrontmatter, '---', '', body].join('\n'),
  };
}

// ==================== 1. id 保留区间与生成 ====================

{
  const presetId = presetSkillIdFromName('bilibili-video-summary');
  check(presetId.startsWith(SKILL_ID_RESERVED_PREFIX), 'A1 内置 id 落在保留区间', presetId);
  check(SKILL_ID_PATTERN.test(presetId), 'A1 内置 id 符合 id 字符规范', presetId);
  eq(presetSkillIdFromName('bilibili-video-summary'), presetId, 'A1 内置 id 确定性（同名同值）');
  check(presetId !== presetSkillIdFromName('xlsx-creator'), 'A1 不同内置技能 id 不同');
  check(presetId !== presetSkillIdFromName('note-workspace'), 'A1 不同内置技能 id 不同（第二组）');

  // 确定性生成（旧版无 id 记录恢复路径）：大样本下恒不落保留区间、跨调用稳定。
  // （保留区间的让位由 customSkillIdBase 的加盐重哈希负责——它防御的是
  //   「哈希函数 / 长度常量将来改变」这一耦合，而非当前 32 位哈希的必然形态）
  let deterministicReserved = '';
  let deterministicMismatch = '';
  for (let i = 0; i < 300; i++) {
    const name = `probe-${i}`;
    const id = generateSkillId(name);
    if (isReservedSkillId(id) && !deterministicReserved) deterministicReserved = id;
    if (id !== generateSkillId(name) && !deterministicMismatch) {
      deterministicMismatch = `${name} => ${id}`;
    }
    if (i < 50 && id !== skillIdFromName(name) && !deterministicMismatch) {
      deterministicMismatch = `${name} => ${id} (hash ${skillIdFromName(name)})`;
    }
  }
  check(deterministicReserved === '', 'A2 确定性生成 300 次均避开保留区间', deterministicReserved);
  check(deterministicMismatch === '', 'A2 确定性生成跨调用稳定且等于名称哈希', deterministicMismatch);

  // 占用时追加后缀，且后缀形态不落保留区间
  const base = generateSkillId('collision-probe');
  const suffixed = generateSkillId('collision-probe', id => id === base);
  check(suffixed !== base, 'A3 基名被占用时追加后缀', { base, suffixed });
  check(suffixed.startsWith(base), 'A3 后缀基于原基名', suffixed);
  check(!isReservedSkillId(suffixed), 'A3 后缀形态仍避开保留区间', suffixed);

  // 随机生成（新建 / 导入路径）
  const seen = new Set<string>();
  let reservedHit = '';
  let badShape = '';
  for (let i = 0; i < 500; i++) {
    const id = generateUniqueSkillId();
    if (isReservedSkillId(id) && !reservedHit) reservedHit = id;
    if (!SKILL_ID_PATTERN.test(id) && !badShape) badShape = id;
    seen.add(id);
  }
  check(reservedHit === '', 'A4 随机生成 500 次均避开保留区间', reservedHit);
  check(badShape === '', 'A4 随机生成 500 次均符合 id 字符规范', badShape);
  eq(seen.size, 500, 'A4 随机生成 500 次互不重复（并发创建不撞 id）');
  check(
    !isReservedSkillId(generateUniqueSkillId(() => true)),
    'A4 全占用时的兜底路径仍避开保留区间',
  );
}

// ==================== 2. 同名技能 ====================

{
  const first = mustWrite({ name: 'twin-skill', files: mdFiles('twin-skill', '正文一') }, 'B1 首个同名技能');
  const second = mustWrite({ name: 'twin-skill', files: mdFiles('twin-skill', '正文二') }, 'B1 次个同名技能');

  check(first.id !== second.id, 'B1 同名技能 id 互不相同', { a: first.id, b: second.id });
  check(first.body !== second.body, 'B1 两条记录内容各自保留（互不覆盖）');
  eq(getSkillByName('twin-skill')?.id, first.id, 'B1 按名查询命中首个注册者');
  eq(resolveSkill(first.id)?.id, first.id, 'B1 按 id 解析命中首个');
  eq(resolveSkill(second.id)?.id, second.id, 'B1 按 id 解析命中次个');
  eq(resolveSkill(modelSkillIdOf(second))?.id, second.id, 'B1 按模型标识解析命中次个');
  eq(resolveSkill('twin-skill')?.id, first.id, 'B1 按名解析回落首个注册者');

  // 编辑：改名到既有同名同样放行（不存在「与谁冲突」的概念）
  const edited = setCustomSkill({
    id: second.id,
    name: 'twin-skill',
    files: mdFiles('twin-skill', '正文二（已编辑）'),
  });
  check(edited.ok, 'B2 编辑到既有同名仍然成功', edited);
  if (edited.ok) eq(edited.skill.id, second.id, 'B2 编辑沿用原 id');
  check(resolveSkill(second.id)?.body.includes('已编辑') === true, 'B2 编辑结果落库');

  // 导入：同名照常入库，绝不加后缀重命名
  const report = commitImportCandidates([
    { name: 'twin-skill', files: mdFiles('twin-skill', '导入一') },
    { name: 'twin-skill', files: mdFiles('twin-skill', '导入二') },
  ]);
  eq(report.imported.length, 2, 'B3 两条同名导入均入库', report.skipped);
  eq(report.skipped.length, 0, 'B3 同名导入无跳过项');
  eq(report.imported.map(item => item.name), ['twin-skill', 'twin-skill'], 'B3 导入不重命名（无 -2 后缀）');
  eq(
    report.imported.every(item => isReservedSkillId(item.id) === false),
    true,
    'B3 导入生成的 id 不落保留区间',
    report.imported,
  );
}

// ==================== 3. 合成激活轮 ====================

{
  const active = mustWrite(
    { name: 'act-one', files: mdFiles('act-one', '技能一正文', ['allowed-tools: plan_tool browser_get_page_text']) },
    'C1 激活技能',
  );
  const other = mustWrite(
    { name: 'act-two', files: mdFiles('act-two', '技能二正文', ['allowed-tools: plan_tool']) },
    'C1 第二个激活技能',
  );
  const disabled = mustWrite(
    { name: 'act-off', files: mdFiles('act-off', '停用正文'), enabled: false },
    'C1 停用技能',
  );

  // 单技能：一条 assistant(tool_calls) + 一条 tool 结果
  const single = skillEngine.buildActivationRound([active.id]);
  eq(single.messages.length, 2, 'C1 单技能 = 2 条协议消息');
  const [assistant, toolMessage] = single.messages;
  eq(assistant.role, 'assistant', 'C1 首条为 assistant');
  eq(toolMessage.role, 'tool', 'C1 次条为 tool');
  const singleCalls = assistant.tool_calls ?? [];
  eq(singleCalls.length, 1, 'C1 一个 load_skill 调用');
  eq(singleCalls[0]?.function.name, 'load_skill', 'C1 调用 load_skill');
  eq(
    JSON.parse(singleCalls[0]?.function.arguments ?? '{}'),
    { skill_name: modelSkillIdOf(active) },
    'C1 入参为模型标识',
  );
  eq(toolMessage.tool_call_id, singleCalls[0]?.id, 'C1 tool 结果与调用 id 配对');
  eq(toolMessage.name, 'load_skill', 'C1 tool 消息标注工具名');
  eq(single.toolIds, ['plan_tool', 'browser_get_page_text'], 'C1 预授权工具按声明顺序带出');

  // 与真实 load_skill 回传逐字同源（同一 buildSuccessPayload 拼装）
  const payload = buildSkillInstruction(active);
  const expectedContent = JSON.stringify({
    success: true,
    ...buildSuccessPayload(payload, skillLoadSuccessMessage(payload)),
  });
  eq(toolMessage.content, expectedContent, 'C2 合成结果与真实 load_skill 回传逐字相同');
  const parsed = JSON.parse(String(toolMessage.content)) as {
    success: boolean;
    content: Array<{ type: string; text: string }>;
    data: Record<string, unknown>;
  };
  eq(parsed.success, true, 'C2 结果标记成功');
  eq(parsed.data.skill, modelSkillIdOf(active), 'C2 data 携带模型标识');
  eq(parsed.data.message, skillLoadSuccessMessage(payload), 'C2 data.message 与真实工具一致');
  eq(parsed.content[0]?.text, JSON.stringify(parsed.data, null, 2), 'C2 content 文本与 data 同源');
  check(String(parsed.data.instruction).includes('技能一正文'), 'C2 data 携带完整指令');
  check(!String(toolMessage.content).includes('system'), 'C2 结果不夹带 system 相关字段');

  // 多技能：同一条 assistant 消息携带全部调用，其后逐条结果
  const multi = skillEngine.buildActivationRound([
    active.id,
    other.id,
    active.id, // 同一技能的重复引用
    modelSkillIdOf(active), // 同一技能的模型标识形态
    active.name, // 同一技能的名称形态
    disabled.id, // 停用技能应被跳过
    'no-such-skill-id', // 失效应被跳过
  ]);
  eq(multi.messages.length, 1 + 2, 'C3 两个有效技能 = 1 assistant + 2 tool');
  const multiCalls = (multi.messages[0]?.tool_calls ?? []);
  eq(multiCalls.length, 2, 'C3 按技能 id 去重后只剩两个调用');
  eq(new Set(multiCalls.map(call => call.id)).size, 2, 'C3 调用 id 互不相同');
  eq(
    multiCalls.map(call => JSON.parse(call.function.arguments).skill_name),
    [modelSkillIdOf(active), modelSkillIdOf(other)],
    'C3 调用按引用顺序展开且均为模型标识',
  );
  eq(multi.messages.slice(1).map(msg => msg.tool_call_id), multiCalls.map(call => call.id), 'C3 结果与调用一一配对');
  eq(multi.toolIds, ['plan_tool', 'browser_get_page_text'], 'C3 预授权工具跨技能有序去重');

  // 全部失效：不产生任何消息，避免空 assistant 污染上下文
  const none = skillEngine.buildActivationRound(['no-such-skill-id', disabled.id, '']);
  eq(none.messages.length, 0, 'C4 无有效技能时不注入任何消息');
  eq(none.toolIds.length, 0, 'C4 无有效技能时无预授权工具');
}

// ==================== 4. 指令装配 ====================

{
  const rich = mustWrite(
    {
      name: 'instr-rich',
      files: {
        'SKILL.md': [
          '---',
          'name: instr-rich',
          'description: 指令装配用例',
          'allowed-tools: xlsx_tool',
          '---',
          '',
          '这是正文主体。',
        ].join('\n'),
        'references/extra.md': '补充资料',
      },
    },
    'D1 资源丰富的技能',
  );
  const instruction = buildSkillInstruction(rich);
  check(instruction.instruction.startsWith('优先级约定'), 'D1 优先级约定置顶');
  check(instruction.instruction.includes('# 环境说明'), 'D2 携带环境说明');
  check(instruction.instruction.includes('技能预授权工具：xlsx_tool'), 'D2 回显预授权工具');
  check(instruction.instruction.includes('# 技能资源文件'), 'D3 携带资源文件清单');
  check(instruction.instruction.includes('- references/extra.md'), 'D3 资源清单列出具体路径');
  check(!instruction.truncated, 'D4 正文未超长时不截断');
  eq(instruction.skill, modelSkillIdOf(rich), 'D4 载荷携带模型标识');

  const bare = mustWrite(
    { name: 'instr-bare', files: mdFiles('instr-bare', '无工具声明的正文') },
    'D1 无工具声明的技能',
  );
  check(
    buildSkillInstruction(bare).instruction.includes('（未声明，沿用会话现有工具）'),
    'D2 未声明工具时给出占位文案',
  );

  const longBody = 'x'.repeat(SKILL_BODY_MAX_CHARS + 500);
  const long = mustWrite({ name: 'instr-long', files: mdFiles('instr-long', longBody) }, 'D5 超长正文技能');
  const longInstruction = buildSkillInstruction(long);
  check(longInstruction.truncated, 'D5 超过上限标记截断');
  check(longInstruction.instruction.includes('已截断'), 'D5 附带截断说明');
  check(
    longInstruction.instruction.includes(`read_skill_file(skill_name="${modelSkillIdOf(long)}"`),
    'D5 附带取原文指引',
  );
  check(
    longInstruction.instruction.length < longBody.length,
    'D5 截断后确实变短',
    { before: longBody.length, after: longInstruction.instruction.length },
  );

  // 合成结果必须是合法 JSON，且与 buildSuccessPayload 同源
  const content = skillLoadToolContent(instruction);
  const parsed = JSON.parse(content) as { success: boolean; data: Record<string, unknown> };
  eq(parsed.success, true, 'D6 合成 tool 结果标记成功');
  eq(parsed.data.instruction, instruction.instruction, 'D6 指令原样进入 data');
}

// ==================== 5. 发现清单 ====================

{
  const listed = mustWrite({ name: 'disc-listed', files: mdFiles('disc-listed', '未激活正文') }, 'E1 清单技能');
  const activated = mustWrite({ name: 'disc-activated', files: mdFiles('disc-activated', '已激活正文') }, 'E1 已激活技能');

  const discovery = skillEngine.buildDiscoverySection([listed, activated], [activated.id]);
  check(discovery !== null, 'E1 存在未激活技能时清单非空');
  check(String(discovery).includes(`<available-skills>`), 'E1 清单带分区标签');
  check(String(discovery).includes(`- ${modelSkillIdOf(listed)}: `), 'E1 未激活技能在清单中');
  check(!String(discovery).includes(modelSkillIdOf(activated)), 'E2 已激活技能被排除出清单');
  eq(
    skillEngine.buildDiscoverySection([activated], [activated.id]),
    null,
    'E3 全部已激活时清单为 null',
  );
}

// ==================== 6. 预置技能装配（合成 glob）与同名共存 ====================

{
  // 预置技能由 run.mjs 的 import.meta.glob 垫片注入，走的是 initStore 真实装配链路
  const preset = getSkillByName('test-preset-skill');
  check(preset?.source === 'preset', 'F1 预置技能经 initStore 注册', preset?.source);
  if (preset) {
    check(isReservedSkillId(preset.id), 'F1 预置 id 落在保留区间', preset.id);
    eq(preset.id, presetSkillIdFromName('test-preset-skill'), 'F1 预置 id 由名称确定性派生');
    eq(preset.enabled, true, 'F1 预置技能默认启用');
    eq(preset.body.includes('预置技能正文'), true, 'F1 预置正文解析正确');

    // 与预置同名的自定义技能：写入放行、id 不同、互不覆盖（同名是常态）
    const twin = setCustomSkill({
      name: 'test-preset-skill',
      files: mdFiles('test-preset-skill', '同名自定义正文'),
    });
    check(twin.ok, 'F2 与预置同名的自定义技能可写入', twin);
    if (twin.ok) {
      check(twin.skill.id !== preset.id, 'F2 同名自定义与预置 id 不同', {
        preset: preset.id,
        custom: twin.skill.id,
      });
      check(!isReservedSkillId(twin.skill.id), 'F2 自定义 id 不占保留区间', twin.skill.id);
      eq(resolveSkill(preset.id)?.source, 'preset', 'F2 预置按 id 精确命中');
      eq(resolveSkill(twin.skill.id)?.body.trim(), '同名自定义正文', 'F2 自定义按 id 精确命中（不被同名预置吞掉）');
      eq(
        resolveSkill(modelSkillIdOf(twin.skill))?.id,
        twin.skill.id,
        'F2 自定义按模型标识命中（标识含 id，天然无歧义）',
      );
      eq(
        getSkillByName('test-preset-skill')?.source,
        'preset',
        'F2 按名解析回落首个注册者（预置先注册，旧数据兼容语义）',
      );
      // 预置 id 恒不在自定义生成结果里 → 两者永不相撞
      check(generateUniqueSkillId() !== preset.id, 'F2 随机取号不会撞上预置 id');
    }
  }
}

// ==================== 汇总 ====================

console.log(`\n[skills] 通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  × ${f}`);
  process.exit(1);
}
