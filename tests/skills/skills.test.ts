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
 *   4. 指令装配：优先级约定置顶、环境说明、预授权工具回显、资源文件清单
 *      （含字数）、正文分页页脚与续读指引、未声明工具的占位文案。
 *   5. 发现清单：已激活技能被排除、条目为「- 模型标识: 描述」、全激活时为 null。
 *   6. 预置技能装配：run.mjs 把仓库 skills/ 的真实文件按 import.meta.glob 键格式
 *      注入，预置技能经 initStore 走真实装配链路——id 落在保留区间且由名称
 *      确定性派生；与预置同名的自定义技能可写入、id 不同、按 id / 模型标识
 *      各自精确命中、按名解析回落首个注册者。
 *   7. 硬编码引用契约：扫描源码里 presetSkillIdFromName('名字') 字面量，
 *      断言每个引用都能命中内置技能且与 frontmatter name 同源（改名漏改
 *      硬编码会让关联静默落空，这条是唯一的守门测试）。
 *   8. 传输层截断豁免：技能指令（按页有界）不得被守卫的 8KB 工具内容上限
 *      砍半，其余工具结果照常截断且计数准确。
 *   9. 分页引擎：确定性（各页拼接还原原文）、CJK / ASCII 预算口径、代理对
 *      安全、页码归一、越界报错、字数（码点）口径、非字符串输入收敛。
 *  10. 读取工具：load_skill 分页参数与越界自纠、read_skill_file 缺省路径 /
 *      白名单 / 分页元信息 / 续读指引 / 脏参数防御。
 *  11. 写入原子性与导入防御：md 直导体量门、快照 / 回滚（含污染快照拒绝）、
 *      第三方（插件）形状退化记录的装配防御。
 *  12. 可用性承载校验：三通道（显式关联 / 映射兜底 / 自定义自适应）统一要求
 *      技能 allowedTools ⊆ 会话工具集——advertised ⊆ 可执行 的不变量源头
 *     （预置技能曾绕过校验导致 TOOL_NOT_ALLOWED 死链的事故回归锚）。
 *  13. 显式目录：归一化规则（去重 / 丢弃非法项）与写入透传。
 *  14. 智能体关联技能解析：输入框「/」卡片可选集合（resolveAgentLinkedSkills）
 *      的三态解析、停用/失效剔除、按 id 去重保序与输入形状防御；并与装配清单
 *      分工对齐（不做承载校验、不做映射兜底——面板答「能选什么」）。
 *
 * 运行：node tests/skills/run.mjs   （或 npm run test:skills）
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import {
  SKILL_ID_PATTERN,
  SKILL_ID_RESERVED_PREFIX,
  SKILL_IMPORT_MAX_FILE_CHARS,
  findDuplicateSkillNames,
  generateSkillId,
  generateUniqueSkillId,
  isReservedSkillId,
  modelSkillIdOf,
  normalizeFolderList,
  presetSkillIdFromName,
  skillIdFromName,
} from '@/utils/skills/skill-types';
import {
  SkillPageOutOfRangeError,
  buildSkillInstruction,
  skillLoadSuccessMessage,
  skillLoadToolContent,
} from '@/utils/skills/skill-instruction';
import {
  SKILL_PAGE_TOKEN_BUDGET,
  countSkillChars,
  normalizeSkillPageParam,
  paginateSkillText,
} from '@/utils/skills/skill-pagination';
import { skillTool } from '@/tools/skill/skill-tool';
import { skillToolCall } from '@/utils/skills/skill-tool-contract';
import { getPyodideEnvState, setSkillScriptsEnabled, updatePyodideEnvState, watchPyodideEnv, withSkillScriptSupport } from '@/utils/pyodide/pyodide-env';
import { PYODIDE_ENV_STORAGE_KEY } from '@/utils/pyodide/pyodide-config';
import {
  getAllSkills,
  getSkillByName,
  resolveSkill,
  rollbackCustomSkills,
  setCustomSkill,
  snapshotCustomSkills,
} from '@/utils/skills/skill-store';
import { commitImportCandidates, exportSkillToZip, importSkillFromMdText, parseSkillZipBytes } from '@/utils/skills/skill-import-export';
import { decodeSkillBytes } from '@/utils/skills/skill-resources';
import { skillEngine } from '@/entrypoints/sidepanel/core/registry/skill-engine';
import { ContextWindowGuard } from '@/entrypoints/sidepanel/utils/ai/context-window-guard';
import type { ChatMessage } from '@/entrypoints/sidepanel/utils/ai/ai-chat-api';
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

  // 后缀用尽（基名 + 63 个后缀全部判占用）→ 时间戳兜底，且兜底同样经 isTaken 确认：
  // 若兜底不查占用，检查次数会停在 64 并直接返回一个可能已被占用的 id
  let takenChecks = 0;
  const fallbackId = generateSkillId('collision-probe', () => ++takenChecks <= 65);
  check(takenChecks > 64, 'A3 兜底取号同样经 isTaken 确认', { takenChecks, fallbackId });
  check(fallbackId.startsWith(base), 'A3 兜底仍基于原基名', fallbackId);
  check(fallbackId.length > base.length + 2, 'A3 后缀用尽后改走时间戳兜底', fallbackId.length);
  check(SKILL_ID_PATTERN.test(fallbackId), 'A3 兜底结果符合 id 字符规范', fallbackId);
  check(!isReservedSkillId(fallbackId), 'A3 兜底结果避开保留区间', fallbackId);

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

  // 展示层消歧：重名集合只含真正重复的名字（卡片 / 胶囊据此补显 id）
  eq([...findDuplicateSkillNames([first, second])], ['twin-skill'], 'B1 重名集合识别出重复项');
  eq(findDuplicateSkillNames([first]).size, 0, 'B1 单条不构成重名');

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
  eq(singleCalls[0]?.function.name, 'skill_tool', 'C1 调用 skill_tool');
  eq(
    JSON.parse(singleCalls[0]?.function.arguments ?? '{}'),
    { action: 'load', skill_name: modelSkillIdOf(active) },
    'C1 入参为模型标识',
  );
  eq(toolMessage.tool_call_id, singleCalls[0]?.id, 'C1 tool 结果与调用 id 配对');
  eq(toolMessage.name, 'skill_tool', 'C1 tool 消息标注工具名');
  eq(single.toolIds, ['plan_tool', 'browser_get_page_text'], 'C1 预授权工具按声明顺序带出');

  // 与真实 load_skill 回传逐字同源（同一 buildSuccessPayload 拼装）
  // primary 是消费方之间的路由约定，模型侧不需要：会话引擎回传前会剥掉它，
  // 合成轮同步剥掉——两条路径才真正逐字同源。
  const payload = buildSkillInstruction(active);
  const { primary: builtPrimary, ...primaryStripped } = buildSuccessPayload(payload, skillLoadSuccessMessage(payload));
  eq(builtPrimary, 'data', 'C2 buildSuccessPayload 声明 data 为正题通道');
  const expectedContent = JSON.stringify({ success: true, ...primaryStripped });
  eq(toolMessage.content, expectedContent, 'C2 合成结果与真实 load_skill 回传逐字相同');
  check(!String(toolMessage.content).includes('primary'), 'C2 模型回传里不含 primary（消费方内部约定）');
  const parsed = JSON.parse(String(toolMessage.content)) as {
    success: boolean;
    content: Array<{ type: string; text: string }>;
    data: Record<string, unknown>;
  };
  eq(parsed.success, true, 'C2 结果标记成功');
  eq(parsed.data.skill, modelSkillIdOf(active), 'C2 data 携带模型标识');
  eq(parsed.data.message, skillLoadSuccessMessage(payload), 'C2 data.message 与真实工具一致');
  // content 不再是 data 的副本：它是载荷的紧凑摘要，完整载荷只在 data 里一份
  // （模型上下文不双份占用——技能正文动辄数千字符，抄两遍是纯浪费）。
  const contentText = String(parsed.content[0]?.text ?? '');
  const dataJson = JSON.stringify(parsed.data, null, 2);
  check(contentText !== dataJson, 'C2 content 是摘要而非 data 的 JSON 副本');
  check(contentText.length * 3 < dataJson.length, 'C2 摘要长度远小于完整载荷（正文不双份占用）');
  eq(
    (String(toolMessage.content).match(/技能预授权工具/g) ?? []).length,
    1,
    'C2 完整技能正文在整条回传里只出现一次',
  );
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
  check(instruction.instruction.includes('- "references/extra.md"'), 'D3 资源清单列出具体路径');
  check(instruction.instruction.includes('（4 字）'), 'D3 资源清单附带字数', instruction.instruction);
  check(instruction.instruction.includes('脚本仅作参考'), 'D2 环境说明区分可用的 Python 脚本和本机命令');
  check(!instruction.truncated, 'D4 正文未超预算时不分页');
  check(instruction.pagination.pageCount === 1, 'D4 单页分页元信息');
  eq(instruction.skill, modelSkillIdOf(rich), 'D4 载荷携带模型标识');

  const bare = mustWrite(
    { name: 'instr-bare', files: mdFiles('instr-bare', '无工具声明的正文') },
    'D1 无工具声明的技能',
  );
  check(
    buildSkillInstruction(bare).instruction.includes('（未声明，沿用会话现有工具）'),
    'D2 未声明工具时给出占位文案',
  );

  // 超长正文：分页注入（默认第 1 页）+ 页脚元信息 + 续读指引。
  // ASCII ≈ 4 字符/token → 20000 字符 ≈ 5000 token → 按 3000 预算切 2 页
  const longBody = 'x'.repeat(20_000);
  const long = mustWrite({ name: 'instr-long', files: mdFiles('instr-long', longBody) }, 'D5 超长正文技能');
  const page1 = buildSkillInstruction(long);
  check(page1.truncated, 'D5 超预算标记分页截断');
  check(page1.pagination.page === 1, 'D5 默认返回第 1 页');
  check(page1.pagination.pageCount === 2, 'D5 总页数按预算切分', page1.pagination);
  check(page1.instruction.includes('第 1/2 页'), 'D5 页脚携带页码');
  check(
    page1.instruction.includes(skillToolCall('load', modelSkillIdOf(long), 2)),
    'D5 页脚携带续读调用',
  );
  check(
    page1.instruction.length < longBody.length,
    'D5 分页后确实变短',
    { before: longBody.length, after: page1.instruction.length },
  );

  const page2 = buildSkillInstruction(long, 2);
  check(page2.pagination.page === 2 && page2.pagination.remainingChars === 0, 'D5 末页剩余为 0', page2.pagination);
  check(page2.instruction.includes(longBody.slice(-50)), 'D5 末页包含正文结尾');
  check(!page2.instruction.includes('page=3'), 'D5 末页不再提示续读');

  let outOfRangeThrown = '';
  try {
    buildSkillInstruction(long, 3);
  } catch (error) {
    outOfRangeThrown = error instanceof SkillPageOutOfRangeError ? 'typed' : `other:${error}`;
  }
  eq(outOfRangeThrown, 'typed', 'D5 越界页码抛出类型化错误');

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

// ==================== 6. 预置技能装配（真实 skills/ 目录）与同名共存 ====================

{
  // 预置技能由 run.mjs 从仓库 skills/ 读入 glob 垫片，走的是 initStore 真实装配链路
  const presets = getAllSkills().filter(skill => skill.source === 'preset');
  check(
    presets.length > 0,
    'F1 至少注册了一个内置技能（skills/ 目录经 initStore 装配）',
    presets.length,
  );
  for (const preset of presets) {
    check(
      isReservedSkillId(preset.id),
      `F1 内置 "${preset.name}" 的 id 落在保留区间`,
      preset.id,
    );
    eq(
      preset.id,
      presetSkillIdFromName(preset.name),
      `F1 内置 "${preset.name}" 的 id 由名称确定性派生`,
    );
    eq(preset.enabled, true, `F1 内置 "${preset.name}" 默认启用`);
    check(
      SKILL_ID_PATTERN.test(preset.id),
      `F1 内置 "${preset.name}" 的 id 符合字符规范`,
      preset.id,
    );
  }

  const preset = presets[0];
  if (preset) {
    // 与预置同名的自定义技能：写入放行、id 不同、互不覆盖（同名是常态）
    const twin = setCustomSkill({
      name: preset.name,
      files: mdFiles(preset.name, '同名自定义正文'),
    });
    check(twin.ok, 'F2 与预置同名的自定义技能可写入', twin);
    if (twin.ok) {
      check(twin.skill.id !== preset.id, 'F2 同名自定义与预置 id 不同', {
        preset: preset.id,
        custom: twin.skill.id,
      });
      check(!isReservedSkillId(twin.skill.id), 'F2 自定义 id 不占保留区间', twin.skill.id);
      eq(resolveSkill(preset.id)?.source, 'preset', 'F2 预置按 id 精确命中');
      eq(
        resolveSkill(twin.skill.id)?.body.trim(),
        '同名自定义正文',
        'F2 自定义按 id 精确命中（不被同名预置吞掉）',
      );
      eq(
        resolveSkill(modelSkillIdOf(twin.skill))?.id,
        twin.skill.id,
        'F2 自定义按模型标识命中（标识含 id，天然无歧义）',
      );
      eq(
        getSkillByName(preset.name)?.source,
        'preset',
        'F2 按名解析回落首个注册者（预置先注册，旧数据兼容语义）',
      );
      // 预置 id 恒不在自定义生成结果里 → 两者永不相撞
      check(generateUniqueSkillId() !== preset.id, 'F2 随机取号不会撞上预置 id');
    }
  }
}

// ==================== 7. 硬编码内置技能引用契约 ====================
// 智能体预设与工具→技能映射表以 presetSkillIdFromName('名字') 硬编码引用内置技能；
// 一旦某技能的 frontmatter name 改了而硬编码没跟上，引用会静默落空（智能体「关联
// 技能」少一个、工具映射失效，且不报任何错）。这里扫描源码字面量逐个断言其命中。

{
  const sourceFiles: string[] = [];
  const collect = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(abs);
      else if (entry.name.endsWith('.ts')) sourceFiles.push(abs);
    }
  };
  collect(path.resolve('utils'));

  const literalPattern = /presetSkillIdFromName\(\s*'([^']+)'\s*\)/g;
  const refs = new Set<string>();
  for (const file of sourceFiles) {
    for (const match of readFileSync(file, 'utf8').matchAll(literalPattern)) {
      refs.add(match[1]);
    }
  }
  check(refs.size > 0, 'G1 扫描到硬编码的内置技能引用', refs.size);
  for (const name of refs) {
    const resolved = resolveSkill(presetSkillIdFromName(name));
    check(
      resolved?.source === 'preset',
      `G1 硬编码引用 "${name}" 命中内置技能`,
      resolved?.source ?? 'unresolved',
    );
    eq(resolved?.name, name, `G1 引用 "${name}" 与内置技能 frontmatter name 同源`);
  }
}

// ==================== 8. 传输层截断豁免（技能指令必须完整送达） ====================
// 守卫对 tool 内容按 8KB 一刀切，而技能指令按 SKILL_PAGE_TOKEN_BUDGET 分页
// （单页 ≈3000 token ≈ 12000 ASCII 字符）——不豁免就会静默砍半，模型读到残缺指令还以为读全了。

{
  const longText = `# 指令\n${'x'.repeat(20_000)}`; // 明显超过 8KB 传输上限
  const skillMessage: ChatMessage = {
    role: 'tool',
    tool_call_id: 'call-skill',
    name: 'load_skill',
    content: longText,
  };
  const genericMessage: ChatMessage = {
    role: 'tool',
    tool_call_id: 'call-generic',
    name: 'page_extract',
    content: longText,
  };
  const guarded = ContextWindowGuard.protect([skillMessage, genericMessage], 1_000_000);
  const byName = new Map(guarded.messages.map(message => [message.name, message.content]));

  eq(byName.get('load_skill'), longText, 'H1 load_skill 指令不做传输层 8KB 截断');
  const trimmed = String(byName.get('page_extract'));
  check(trimmed.length < longText.length, 'H2 其余工具结果仍按上限截断', trimmed.length);
  check(trimmed.includes('[tool response truncated'), 'H2 截断带可读标记');
  eq(guarded.toolContentsTrimmed, 1, 'H3 截断计数只统计被真正截断的工具');
}

// ==================== 9. 分页引擎 ====================

/** 分页成功断言助手（失败时记一条断言并返回 null，后续用例自然失败） */
function pageOf(text: string, page: number, budget?: number) {
  const result = paginateSkillText(text, page, budget);
  check(result.ok, `I0 分页应成功（page=${page}）`, result);
  return result.ok ? result.page : null;
}

{
  // 还原性：混排 CJK / ASCII / emoji / 换行的文本，各页按序拼接 === 原文
  const mixed =
    '第一段中文内容。\nSecond paragraph with ASCII words.\n😀😀😀 emoji row.\n' +
    '混'.repeat(6000) +
    '\n' +
    'y'.repeat(9000);
  let reassembled = '';
  const first = pageOf(mixed, 1);
  if (first) {
    reassembled += first.content;
    for (let page = 2; page <= first.pageCount; page++) {
      const next = pageOf(mixed, page);
      if (next) reassembled += next.content;
    }
    eq(reassembled, mixed, 'I1 各页拼接还原原文');
    check(first.pageCount > 1, 'I1 混排长文确实被分页', first.pageCount);
    // 字数守恒：totalChars = 各页 currentChars 之和；末页 remainingChars = 0
    let sumChars = 0;
    for (let page = 1; page <= first.pageCount; page++) {
      const p = pageOf(mixed, page);
      if (p) sumChars += p.currentChars;
    }
    eq(sumChars, first.totalChars, 'I1 各页字数之和等于总字数');
  }

  // 字数口径：码点数（emoji 记 1 字，不按 UTF-16 码元计）
  eq(countSkillChars('a😀中'), 3, 'I1 字数为码点数');

  // CJK 预算：3000 汉字 = 3000 token 恰好一页；加 1 字溢出成两页
  const cjkExactly = pageOf('中'.repeat(SKILL_PAGE_TOKEN_BUDGET), 1);
  eq(cjkExactly?.pageCount, 1, 'I2 CJK 恰好预算成一页');
  const cjkOver = pageOf('中'.repeat(SKILL_PAGE_TOKEN_BUDGET + 1), 1);
  eq(cjkOver?.pageCount, 2, 'I2 CJK 超一字切两页');
  eq(cjkOver?.currentChars, SKILL_PAGE_TOKEN_BUDGET, 'I2 第一页恰好装满预算');

  // ASCII 预算：4 字符/token → 12000 恰好一页；12004 切两页
  eq(pageOf('x'.repeat(12_000), 1)?.pageCount, 1, 'I2 ASCII 恰好预算成一页');
  eq(pageOf('x'.repeat(12_004), 1)?.pageCount, 2, 'I2 ASCII 超限切两页');

  // 代理对安全：emoji（2 码元 1 码点 1 token）两页，第一页 UTF-16 长度 = 2×预算
  const emojiText = '😀'.repeat(SKILL_PAGE_TOKEN_BUDGET * 2);
  const emojiPage1 = pageOf(emojiText, 1);
  eq(emojiPage1?.pageCount, 2, 'I3 emoji 按码点计费切两页');
  eq(emojiPage1?.content.length, SKILL_PAGE_TOKEN_BUDGET * 2, 'I3 页边界不拆代理对');
  eq(emojiPage1?.currentChars, SKILL_PAGE_TOKEN_BUDGET, 'I3 emoji 字数按码点计');

  // 确定性：同一文本两次切分结果逐字一致
  const again = pageOf(mixed, 1);
  eq(again?.content, first?.content, 'I4 分页确定性（同文本同页码结果一致）');

  // 空文本：唯一空页（不越界、不抛错）
  const empty = pageOf('', 1);
  eq(empty?.pageCount, 1, 'I5 空文本为唯一空页');
  eq(empty?.content, '', 'I5 空页内容为空串');

  // 越界：返回总页数与总字数（调用方据此给出可自纠报错）
  const outOfRange = paginateSkillText('x'.repeat(12_004), 3);
  eq(outOfRange.ok, false, 'I6 页码越界标记失败');
  if (!outOfRange.ok) {
    eq(outOfRange.pageCount, 2, 'I6 失败载荷携带总页数');
    eq(outOfRange.totalChars, 12_004, 'I6 失败载荷携带总字数');
  }

  // 页码归一：脏参数优雅回落第 1 页
  eq(normalizeSkillPageParam('2'), 2, 'I7 数字字符串归一为数字');
  eq(normalizeSkillPageParam(2.7), 2, 'I7 小数向下取整');
  eq(normalizeSkillPageParam(0), 1, 'I7 零回落第 1 页');
  eq(normalizeSkillPageParam(-5), 1, 'I7 负数回落第 1 页');
  eq(normalizeSkillPageParam('abc'), 1, 'I7 非数字回落第 1 页');
  eq(normalizeSkillPageParam(undefined), 1, 'I7 缺省回落第 1 页');
}

// ==================== 10. 读取工具（load_skill 分页 / read_skill_file 白名单与分页） ====================

{
  // 正文 20000 ASCII ≈ 5000 token → 2 页；资源文件 16000 → 2 页
  const skillRecord = mustWrite(
    {
      name: 'tool-paged',
      files: {
        'SKILL.md': [
          '---',
          'name: tool-paged',
          'description: 分页工具用例',
          '---',
          '',
          'z'.repeat(20_000),
        ].join('\n'),
        'references/guide.md': 'g'.repeat(16_000),
      },
    },
    'J1 分页工具用例技能',
  );
  const ref = modelSkillIdOf(skillRecord);

  // load_skill：默认第 1 页 + 分页元信息 + 续读指引
  const load1 = await skillTool.execute({ action: 'load', skill_name: ref });
  check(load1.success === true, 'J1 load_skill 成功');
  check(load1.data?.pagination?.pageCount === 2, 'J1 正文两页', load1.data?.pagination);
  check(String(load1.data?.instruction).includes(skillToolCall('load', ref, 2)), 'J1 页脚带续读调用');

  // load_skill：字符串页码归一；越界返回可自纠报错（不抛异常）
  const load2 = await skillTool.execute({ action: 'load', skill_name: ref, page: '2' });
  check(load2.success === true && load2.data?.pagination?.page === 2, 'J2 字符串页码归一');
  const load9 = await skillTool.execute({ action: 'load', skill_name: ref, page: 9 });
  check(load9.success === false, 'J2 越界页码返回失败');
  check(String(load9.error).includes('不存在第 9 页'), 'J2 越界报错携带页码信息', load9.error);

  // read_skill_file：缺省 path 读 SKILL.md（原文，含 frontmatter）
  const readDefault = await skillTool.execute({ action: 'read', skill_name: ref });
  check(readDefault.success === true, 'J3 缺省路径读取成功');
  check(readDefault.data?.path === 'SKILL.md', 'J3 缺省路径为 SKILL.md');
  check(String(readDefault.data?.content).startsWith('---'), 'J3 SKILL.md 原文含 frontmatter');

  // read_skill_file：资源文件分页 + 元信息 + 独立 hint 字段（内容本体不夹页脚）
  const readFile1 = await skillTool.execute({ action: 'read', skill_name: ref, path: 'references/guide.md' });
  check(readFile1.success === true, 'J4 资源文件读取成功');
  check(readFile1.data?.pagination?.pageCount === 2, 'J4 资源文件分页', readFile1.data?.pagination);
  check(readFile1.data?.truncated === true, 'J4 截断标记');
  check(String(readFile1.data?.hint).includes('"page":2'), 'J4 续读指引在 hint 字段');
  eq(readFile1.data?.content, 'g'.repeat(12_000), 'J4 内容本体纯净（第一页恰为预算且不夹页脚）');

  const readFile2 = await skillTool.execute({ action: 'read', skill_name: ref, path: 'references/guide.md', page: 2 });
  check(readFile2.success === true && readFile2.data?.truncated === false, 'J4 末页无截断标记');
  eq(readFile2.data?.content, 'g'.repeat(4_000), 'J4 末页为剩余内容');

  // 白名单：未注册路径拒绝并列出可用文件（精确键匹配天然免疫 ../ 穿越）
  const readMissing = await skillTool.execute({ action: 'read', skill_name: ref, path: '../outside.md' });
  check(readMissing.success === false, 'J5 未注册路径拒绝');
  check(String(readMissing.error).includes('SKILL_INVALID_PATH'), 'J5 遍历路径给出明确报错', readMissing.error);

  const readNoSkill = await skillTool.execute({ action: 'read', skill_name: 'no-such-skill-xyz' });
  check(readNoSkill.success === false, 'J5 不存在的技能报错');

  // 第三方（插件）形状防御：脏参数与脏数据不击穿工具链
  const numericRef = await skillTool.execute({ action: 'read', skill_name: 42 as unknown as string });
  check(numericRef.success === false, 'J5 数字型技能引用安全报错');
  const nullPath = await skillTool.execute({ action: 'read', skill_name: ref, path: null as unknown as string });
  check(nullPath.success === true && nullPath.data?.path === 'SKILL.md', 'J5 null 路径回落 SKILL.md');
}

// ==================== 11. 写入原子性与导入防御 ====================

{
  // md 直导体量门：超限整体跳过（与 zip 单文件口径一致）
  const oversizedMd = [
    '---',
    'name: md-oversize',
    'description: 超限直导用例',
    '---',
    '',
    'y'.repeat(SKILL_IMPORT_MAX_FILE_CHARS + 1),
  ].join('\n');
  const mdReport = importSkillFromMdText(oversizedMd, 'md-oversize');
  eq(mdReport.imported.length, 0, 'K1 超限 md 直导被拒');
  eq(mdReport.skipped[0]?.reason, 'file-too-large', 'K1 跳过原因为 file-too-large');

  // 非字符串 md 输入按「没有可导入的文件」降级（编程错误防御，不抛 TypeError）
  const badMd = importSkillFromMdText(null as unknown as string, 'bad-md');
  eq(badMd.skipped[0]?.reason, 'no-skill-md', 'K1 非字符串 md 输入安全降级');

  // 快照 / 回滚：批量导入落盘失败时内存表可精确恢复到导入前
  const rollbackBase = mustWrite(
    { name: 'rollback-base', files: mdFiles('rollback-base', '底座正文') },
    'K2 快照基线技能',
  );
  const snapshot = snapshotCustomSkills();
  const rollbackExtra = mustWrite(
    { name: 'rollback-extra', files: mdFiles('rollback-extra', '快照后的新增') },
    'K2 快照后新增技能',
  );
  check(resolveSkill(rollbackExtra.id) !== undefined, 'K2 新增技能先落内存表');
  rollbackCustomSkills(snapshot);
  eq(resolveSkill(rollbackExtra.id), undefined, 'K2 回滚移除快照后的新增');
  eq(resolveSkill(rollbackBase.id)?.name, 'rollback-base', 'K2 回滚保留快照前技能');

  // 非法快照：忽略回滚请求且绝不抛出（内存表保持现状）
  rollbackCustomSkills('not-an-array');
  rollbackCustomSkills([{ 完全不是技能: true }]);
  eq(resolveSkill(rollbackBase.id)?.name, 'rollback-base', 'K2 非法快照被忽略');

  // 指令装配对第三方（插件）形态的防御：body / files / allowedTools 全缺失不炸
  const foreign = {
    id: 'ed25519:f1',
    name: 'foreign',
    description: '第三方包的技能',
    category: 'general',
    tags: [],
    source: 'plugin',
    enabled: true,
    updatedAt: 0,
  } as unknown as SkillRecord;
  const foreignInstruction = buildSkillInstruction(foreign);
  check(foreignInstruction.pagination.pageCount === 1 && foreignInstruction.pagination.totalChars === 0, 'K3 退化记录装配为空正文单页', foreignInstruction.pagination);
  check(
    foreignInstruction.instruction.includes('（未声明，沿用会话现有工具）'),
    'K3 allowedTools 缺失走占位文案',
  );

  // 分页对非字符串文本的安全收敛（不抛 TypeError）
  const nonStringPage = paginateSkillText(null as unknown as string, 1);
  check(nonStringPage.ok === true && nonStringPage.page.totalChars === 0, 'K3 非字符串文本收敛为空页');
  eq(countSkillChars(undefined as unknown as string), 0, 'K3 非字符串字数为 0');
}

// ==================== 12. 可用性承载校验（三通道统一：advertised ⊆ 可执行） ====================
// 事故根因回归锚：预置技能经映射兜底曾绕过承载校验，web-research-report 携带的
// note_tool 在多个智能体下「目录可见但执行被拒」（TOOL_NOT_ALLOWED）。三通道
// （显式关联 / 映射兜底 / 自定义自适应）统一要求 allowedTools ⊆ 会话工具集。

{
  const { computeAvailableSkills } = await import('../../utils/skills/skill-availability');
  const { presetSkillIdFromName } = await import('../../utils/skills/skill-types');
  const idsOf = (skills: { id: string }[]) => skills.map(skill => skill.id);

  // deepSearch 同构工具面（核心 + 场景 + 动态 web_search）：web-research-report
  // 全部工具可承载 → 映射兜底通道放行
  const DEEP_SEARCH_TOOLSET = [
    ...['interact', 'browser_get_page_text', 'plan_tool', 'note_tool'],
    'browser_navigation', 'browser_get_page_info',
    'browser_observe', 'browser_interact',
    'browser_dom_explore', 'browser_page_exec', 'web_search',
  ];
  const deepList = idsOf(computeAvailableSkills(undefined, DEEP_SEARCH_TOOLSET));
  check(
    deepList.includes(presetSkillIdFromName('web-research-report')),
    'L1 工具面完整时映射兜底放行 web-research-report',
    deepList,
  );

  // automation 同构工具面（含 web_search）：调研技能的全部工具均可承载 →
  // 映射兜底放行（已下线的网页抓取工具不再把技能挡在清单外）
  const AUTOMATION_TOOLSET = [
    ...['interact', 'browser_get_page_text', 'plan_tool', 'note_tool'],
    'browser_observe', 'browser_interact', 'browser_dom_explore', 'browser_navigation',
    'browser_get_page_info', 'browser_tabs', 'web_search', 'generic_wait',
    'browser_page_exec',
  ];
  const autoList = idsOf(computeAvailableSkills(undefined, AUTOMATION_TOOLSET));
  check(
    autoList.includes(presetSkillIdFromName('web-research-report')),
    'L2 工具面完整时通用助手同样可见调研技能（已下线工具不得再当挡板）',
    autoList,
  );

  // 承载校验本体：工具面缺任一必需工具（此处缺 web_search）→ 技能整项挡在
  // 清单外——缺任一工具即不得进入发现清单（曾经的死链根因）
  const PARTIAL_TOOLSET = AUTOMATION_TOOLSET.filter(id => id !== 'web_search');
  const partialList = idsOf(computeAvailableSkills(undefined, PARTIAL_TOOLSET));
  check(
    !partialList.includes(presetSkillIdFromName('web-research-report')),
    'L3 缺任一承载工具的技能不得进清单（曾经的死链根因）',
    partialList,
  );

  // 显式关联通道同样过承载校验：关联了承载不了的技能 → 从发现清单剔除
  // （发送时预选不受此限，走 activation 另行注入——见 skill-availability 文件头）
  const explicitList = idsOf(computeAvailableSkills(
    [presetSkillIdFromName('web-research-report')],
    PARTIAL_TOOLSET,
  ));
  check(
    !explicitList.includes(presetSkillIdFromName('web-research-report')),
    'L3b 显式关联的技能承载不了时同样剔除',
    explicitList,
  );

  // 自定义技能自适应通道：allowedTools 全部在场 → 可用；缺一 → 不可用
  const carried = mustWrite({
    name: 'availability-carried',
    files: mdFiles('availability-carried', '正文', ['allowed-tools: browser_observe web_search']),
  }, 'L4 写入可承载自定义技能');
  const notCarried = mustWrite({
    name: 'availability-not-carried',
    files: mdFiles('availability-not-carried', '正文', ['allowed-tools: browser_observe vision_gui']),
  }, 'L4 写入不可承载自定义技能');
  const customList = idsOf(computeAvailableSkills(undefined, AUTOMATION_TOOLSET));
  check(customList.includes(carried.id), 'L4 自定义技能全部工具在场时可用');
  check(!customList.includes(notCarried.id), 'L4 自定义技能缺工具时不可用');

  // note-workspace 已删除：技能面收敛为 3 个预置，且没有任何技能再映射自 note_tool
  const presets = getAllSkills().filter(skill => skill.source === 'preset');
  eq(presets.length, 3, 'L5 预置技能收敛为 3 个（note-workspace 并入 note-prompt 后移除）');
  check(
    presets.every(skill => skill.name !== 'note-workspace'),
    'L5 note-workspace 不再作为技能存在（通用规范由固定分区承载）',
  );
}

// ==================== 13. 显式目录（空目录）承载与归一化 ====================
//
// 技能包按文件组织，空目录若不单独记录就会在保存后消失——故记录上有一等字段
// `folders`。这里锁两条契约：归一化规则（去重 / 丢弃非法项）与写入透传。

eq(
  normalizeFolderList(['a/b', 'a\\b', './c', 'x/', 'y/../z', '', '/abs', 'd//e']),
  ['a/b', 'c', 'x'],
  '13.1 显式目录归一化：反斜杠 / 前缀 / 尾斜杠归一，重复与非法项丢弃',
);

{
  const record = mustWrite({
    name: 'folder-skill',
    description: '含空目录的技能',
    files: mdFiles('folder-skill', '正文'),
    folders: ['references', 'assets/img', 'references', 'bad/../path', ''],
  }, '13.2 写入含显式目录的技能');
  eq(record.folders, ['references', 'assets/img'], '13.3 显式目录随记录入库并已归一化');
  const reread = getAllSkills().find(skill => skill.id === record.id);
  eq(reread?.folders, ['references', 'assets/img'], '13.4 显式目录可从技能表读回（空目录不丢）');
}

// ==================== 14. 智能体关联技能解析（输入框「/」卡片可选集合） ====================
//
// 输入框技能卡片的可选范围收敛为「当前智能体在 hub 编辑页显式关联的启用技能」。
// 这里锁定 resolveAgentLinkedSkills 的解析契约：三态解析（id / 模型标识 / 名称）、
// 停用与失效引用剔除、按 id 去重保序、输入形状防御；并与 computeAvailableSkills
// 的分工对齐——不做承载校验、不做映射兜底（面板回答「能选什么」，装配回答「注入什么」，
// 预选技能经合成 load_skill 轮注入，工具由激活轮并入可执行集）。

{
  const { resolveAgentLinkedSkills, computeAvailableSkills } = await import('../../utils/skills/skill-availability');
  const { presetSkillIdFromName } = await import('../../utils/skills/skill-types');
  const { setSkillEnabled } = await import('../../utils/skills/skill-store');

  const alpha = mustWrite({ name: 'linked-alpha', files: mdFiles('linked-alpha', '正文') }, 'M1 写入关联技能 alpha');
  const beta = mustWrite({ name: 'linked-beta', files: mdFiles('linked-beta', '正文') }, 'M1 写入关联技能 beta');
  const off = mustWrite({ name: 'linked-off', files: mdFiles('linked-off', '正文') }, 'M1 写入将被停用的技能');
  const heavy = mustWrite({
    name: 'linked-heavy-carrier',
    files: mdFiles('linked-heavy-carrier', '正文', ['allowed-tools: vision_gui browser_execute_js']),
  }, 'M1 写入重承载技能');

  check(setSkillEnabled(off.id, false), 'M2 停用 off 技能成功');

  // 未声明关联 / 空数组 → 空可选集（面板据此呈现「先选智能体 / 去关联」引导）
  eq(resolveAgentLinkedSkills(undefined).map(s => s.id), [], 'M2 未声明关联 → 空集');
  eq(resolveAgentLinkedSkills([]).map(s => s.id), [], 'M2 空关联数组 → 空集');

  // 三态引用混排：id / 名称 / 模型标识各自命中；停用与失效引用剔除；
  // 同一技能的多形态引用按 id 去重；声明顺序保持（beta 在前）
  const mixedRefs = [beta.id, 'linked-alpha', modelSkillIdOf(heavy), off.id, 'no-such-ref', modelSkillIdOf(beta), '', '   '];
  eq(
    resolveAgentLinkedSkills(mixedRefs).map(s => s.id),
    [beta.id, alpha.id, heavy.id],
    'M3 三态解析混排：保序、去重、停用/失效/空白引用剔除',
  );

  // 分工契约 1——不做承载校验：heavy 的 allowedTools 不在任何工具集里，
  // 装配清单会剔除它（第 12 节 L3 同型），面板可选集必须原样放行
  eq(resolveAgentLinkedSkills([heavy.id]).map(s => s.id), [heavy.id], 'M4 面板可选集不做承载校验');
  check(
    !computeAvailableSkills([heavy.id], []).some(s => s.id === heavy.id),
    'M4 对照：装配清单按承载校验剔除同一技能',
  );

  // 分工契约 2——不做映射兜底：工具面命中映射的预置技能只在装配清单出现，
  // 未被显式关联就不会进入面板可选集（「技能与智能体绑定选择」的口径源头）
  const DEEP_SEARCH_TOOLSET = [
    'interact', 'browser_get_page_text', 'plan_tool', 'note_tool',
    'browser_navigation', 'browser_get_page_info',
    'browser_observe', 'browser_interact',
    'browser_dom_explore', 'browser_page_exec', 'web_search',
  ];
  check(
    computeAvailableSkills(undefined, DEEP_SEARCH_TOOLSET).some(s => s.id === presetSkillIdFromName('web-research-report')),
    'M5 对照：装配清单经映射兜底包含 web-research-report',
  );
  check(
    !resolveAgentLinkedSkills(undefined).some(s => s.id === presetSkillIdFromName('web-research-report')),
    'M5 面板可选集无映射兜底：未被显式关联即不可选',
  );
}

// ==================== Skill resource compatibility ====================
{
  const md = mdFiles('zip-resources', 'Use the supplied resource.')['SKILL.md'];
  const binary = Uint8Array.of(0, 255, 10);
  const text = '\uFEFF# Asset with BOM\r\n';
  const archive = zipSync({
    'zip-resources/SKILL.md': strToU8(md),
    'zip-resources/assets/report.xlsx': binary,
    'zip-resources/assets/literal space .txt': strToU8(text),
    'zip-resources/.env.example': strToU8('REPORT_FORMAT=text'),
    'zip-resources/empty/': new Uint8Array(),
    'zip-resources/../escape.py': strToU8('raise Exception()'),
    'C:/escape.py': strToU8('raise Exception()'),
  });
  const parsed = parseSkillZipBytes(archive);
  eq(parsed.droppedFiles, [], 'ZIP keeps binary resources');
  const [candidate] = parsed.candidates;
  eq(candidate.files['assets/literal space .txt'], text, 'BOM, CRLF and literal file name round trip');
  eq(candidate.folders, ['empty'], 'ZIP preserves explicit empty folders');
  eq(candidate.files['.env.example'], 'REPORT_FORMAT=text', 'Dotfile remains available as a resource');
  const committed = commitImportCandidates(parsed.candidates);
  const skill = resolveSkill(committed.imported[0].id)!;
  eq([...decodeSkillBytes(skill.resourceBytes!['assets/report.xlsx'])], [...binary], 'Binary bytes are stored');
  const edited = setCustomSkill({ id: skill.id, name: skill.name, files: { ...skill.files } });
  check(edited.ok && edited.skill.resourceBytes?.['assets/report.xlsx'] === skill.resourceBytes?.['assets/report.xlsx'],
    'Text-only edits preserve binary resources');
  const exported = unzipSync(exportSkillToZip(skill).bytes);
  eq([...exported['zip-resources/assets/report.xlsx']], [...binary], 'ZIP export preserves binary bytes');
  check(Object.hasOwn(exported, 'zip-resources/empty/'), 'ZIP export preserves empty folder');
  check(!Object.keys(exported).some(name => name.includes('escape.py')), 'ZIP traversal paths never enter the skill');
  const chromeBefore = globalThis.chrome;
  const changes = new Set<(changes: Record<string, { newValue?: unknown }>, area: string) => void>();
  let stored: Record<string, unknown> = { [PYODIDE_ENV_STORAGE_KEY]: { status: 'ready' } };
  globalThis.chrome = { storage: {
    local: {
      get: async () => stored,
      set: async (next: Record<string, unknown>) => {
        stored = next;
        changes.forEach(listener => listener({ [PYODIDE_ENV_STORAGE_KEY]: { newValue: stored[PYODIDE_ENV_STORAGE_KEY] } }, 'local'));
      },
    },
    onChanged: {
      addListener: (listener: typeof changes extends Set<infer T> ? T : never) => changes.add(listener),
      removeListener: (listener: typeof changes extends Set<infer T> ? T : never) => changes.delete(listener),
    },
  } } as unknown as typeof chrome;
  try {
    eq((await getPyodideEnvState()).skillScriptsEnabled, false, 'Legacy ready state defaults to off');
    eq(skillTool.openaiSchema.function.parameters.properties.action.enum, ['load', 'read'], 'Default schema offers text actions');
    eq(skillTool.getSchema({ skillMode: 'workspace' }).function.parameters.properties.action.enum,
      ['load', 'read', 'copy'], 'Workspace schema offers copy as well');
    await setSkillScriptsEnabled(true);
    const text = await skillTool.execute({ action: 'load', skill_name: skill.id }, { skillMode: 'text' });
    check(!String(text.data?.instruction).includes('action="copy"'), 'Text mode activation omits copy guidance');
    const workspace = await skillTool.execute({ action: 'load', skill_name: skill.id }, {
      skillMode: 'workspace', skillResourceIds: [skill.id],
    });
    check(String(workspace.data?.instruction).includes('action="copy"') && String(workspace.data?.instruction).includes('report.xlsx'),
      'Workspace activation includes binary resources and copy guidance');
    const result = await skillTool.execute({ action: 'copy', skill_name: skill.id, paths: ['.'] }, {
      chatId: 'chat_a', skillMode: 'workspace', availableSkillIds: [skill.id], skillResourceIds: ['unrelated-skill'],
    });
    check(result.error?.includes('SKILL_NOT_AVAILABLE') === true, 'A chat cannot copy a skill outside its authorized workspace set');
    const simulatedCopy = withSkillScriptSupport(undefined, signal => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve(signal.aborted), { once: true });
      void updatePyodideEnvState({ status: 'idle' });
    }));
    eq(await simulatedCopy, true, 'Removing the runtime cancels an in-flight copy');
    const reinstalled = await updatePyodideEnvState({ status: 'ready' });
    eq(reinstalled.skillScriptsEnabled, false, 'Reinstalling cannot re-enable script support');
    const stale = await skillTool.execute({ action: 'copy', skill_name: skill.id, paths: ['.'] }, {
      chatId: 'chat_a', skillMode: 'workspace', availableSkillIds: [skill.id], skillResourceIds: [skill.id],
    });
    check(stale.error?.includes('SKILL_WORKSPACE_UNAVAILABLE') === true, 'An earlier workspace session cannot copy after revocation');
    let missingStateIsDisabled = false;
    const unwatch = watchPyodideEnv(state => { missingStateIsDisabled = !state.skillScriptsEnabled; });
    changes.forEach(listener => listener({ [PYODIDE_ENV_STORAGE_KEY]: {} }, 'local'));
    unwatch();
    check(missingStateIsDisabled, 'Removing the storage entry publishes a disabled state');
  } finally {
    globalThis.chrome = chromeBefore;
  }
}

// ==================== 汇总 ====================

console.log(`\n[skills] 通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  × ${f}`);
  process.exit(1);
}
