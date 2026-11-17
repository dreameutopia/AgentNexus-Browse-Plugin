/**
 * python_run 依赖契约前置判定（真实场景回归）
 *
 * 复现真实日志中的三次失败，验证优化后的行为：
 *   ① run 未落库脚本 → PY_FILE_NOT_FOUND（先 create 再 run）
 *   ② requirements 声明官方目录外的包但未给 dependencyMode="pypi"
 *      → PY_DEPENDENCY_UNRESOLVABLE（工具层前置判定，给出具体包名与下一步）
 *   ③ 同一场景补上 dependencyMode="pypi" → 通过审批门，进入执行路径
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { extractContentText } from '@/common/tool-handler';
import { chatDatabase } from '@/entrypoints/sidepanel/core/context/chat-database';
import { PythonRunTool } from '@/tools/python/python-run-tool';
import { FileUtilTool } from '@/tools/file-util/file-util-tool';
import {
  evaluateRequirements,
  normalizePackageName,
  normalizeRequirementName,
  renderRequirementGuidance,
  summarizeRequirements,
} from '@/utils/pyodide/dependency-contract';

const tool = new PythonRunTool();
const files = new FileUtilTool();
const text = (result: { content?: unknown }) => extractContentText(result.content);
const CHAT = 'python-dep-contract-chat';

// ──── 纯函数：包名归一化（PEP 503） ────
assert.equal(normalizePackageName('Python-DateUtil'), 'python-dateutil');
assert.equal(normalizePackageName('et_xmlfile'), 'et-xmlfile');
assert.equal(normalizePackageName('astropy_iers_data'), 'astropy-iers-data');
assert.equal(normalizeRequirementName('pypdf>=5'), 'pypdf');
assert.equal(normalizeRequirementName('requests[security]'), 'requests');
assert.equal(normalizeRequirementName('  pypdf  '), 'pypdf');
assert.equal(normalizeRequirementName('pkg @ https://example.com/pkg.whl'), 'pkg');
assert.equal(normalizeRequirementName(''), '');

// ──── 纯函数：判定结论 ────
const catalog = new Set([normalizePackageName('numpy'), normalizePackageName('pandas')]);
const installed = new Set([normalizePackageName('et_xmlfile')]);

const satisfied = summarizeRequirements(
  evaluateRequirements(['numpy>=1.20'], { catalog, installed, mode: 'catalog' }),
);
assert.equal(satisfied.allSatisfied, true, '官方目录内的包判定为满足');
assert.equal(satisfied.needsPypi.length, 0);

const byInstalled = summarizeRequirements(
  evaluateRequirements(['et-xmlfile'], { catalog, installed, mode: 'catalog' }),
);
assert.equal(byInstalled.allSatisfied, true, '已安装（复用清单）的包判定为满足');

const needsPypi = summarizeRequirements(
  evaluateRequirements(['pypdf'], { catalog, installed, mode: 'catalog' }),
);
assert.equal(needsPypi.allSatisfied, false, '目录外的包判定为需 pypi');
assert.equal(needsPypi.needsPypi.length, 1);
assert.equal(needsPypi.needsPypi[0].packageName, 'pypdf');

const guidance = renderRequirementGuidance(needsPypi);
assert.match(guidance, /pypdf/, '指引点名具体包名');
assert.match(guidance, /dependencyMode="pypi"/, '指引给出具体参数');
assert.match(guidance, /标准库/, '指引给出标准库替代路径');

// 指引必须保留模型写下的原始声明（含版本约束）——指引要求「照抄 requirements」，
// 自己把 pypdf>=5 截成 pypdf 会让模型照抄时丢掉版本约束
const versioned = summarizeRequirements(
  evaluateRequirements(['pypdf>=5', 'pypdf>=5', 'requests[security]>=2'], { catalog, installed, mode: 'catalog' }),
);
const versionedGuidance = renderRequirementGuidance(versioned);
assert.match(versionedGuidance, /"pypdf>=5"/, '指引保留版本约束原文');
assert.match(versionedGuidance, /"requests\[security\]>=2"/, '指引保留 extras 声明原文');
assert.equal(versionedGuidance.split('"pypdf>=5"').length - 1, 1, '重复声明去重，只提示一次');

// 空声明可分析：按 JSON 回显（空串肉眼不可见），并给出正确写法
const blank = summarizeRequirements(evaluateRequirements([''], { catalog, installed, mode: 'catalog' }));
assert.equal(blank.unsatisfiable.length, 1, '空声明归入 unsatisfiable');
assert.match(renderRequirementGuidance(blank), /""/, '空声明按 JSON 回显，肉眼可辨');

const invalid = summarizeRequirements(
  evaluateRequirements(['not a valid requirement!!'], { catalog, installed, mode: 'catalog' }),
);
assert.equal(invalid.unsatisfiable.length, 1, '无法解析的声明归入 unsatisfiable');
assert.match(renderRequirementGuidance(invalid), /PEP 508/, '无法解析时给出正确写法');

// pypi 模式不在本层预判可安装性（含 C 扩展的 wheel 只有 runner 能诊断）
const pypiMode = summarizeRequirements(
  evaluateRequirements(['pypdf'], { catalog, installed, mode: 'pypi' }),
);
assert.equal(pypiMode.allSatisfied, false, 'pypi 模式仍需安装，不视为已满足');

// ──── 端到端：工具层前置判定 ────
await chatDatabase.createSession({
  chatId: CHAT, title: 'dep', createdAt: 1, updatedAt: 1,
  messageCount: 0, lastMessagePreview: '', agentName: '',
});
await files.execute({ action: 'create', path: 'scripts/demo.py', content: 'print(1)\n' }, { chatId: CHAT });

// ① run 未落库脚本 → 存在性错误先行
assert.match(
  text(await tool.execute({ action: 'run', path: 'scripts/absent.py' }, { chatId: CHAT })),
  /PY_FILE_NOT_FOUND/,
  '未落库脚本先报存在性',
);

// ② 目录外的包 + 未给 pypi 模式 → 工具层前置判定（不等 worker 跑完）
const unresolved = text(
  await tool.execute(
    { action: 'run', path: 'scripts/demo.py', requirements: ['pypdf>=5'] },
    { chatId: CHAT },
  ),
);
assert.match(unresolved, /PY_DEPENDENCY_UNRESOLVABLE/, '目录外包在工具层被前置判定');
assert.match(unresolved, /pypdf/, '前置判定点名具体包名');
assert.match(unresolved, /dependencyMode="pypi"/, '前置判定给出具体参数');
assert.match(unresolved, /标准库/, '前置判定给出标准库替代路径');
assert.doesNotMatch(unresolved, /PY_FILE_NOT_FOUND/, '前置判定不与存在性错误混淆');

// ③ 同一场景补上 dependencyMode="pypi" → 进入审批门（不再被目录判定拦下）
const approved = text(
  await tool.execute(
    { action: 'run', path: 'scripts/demo.py', requirements: ['pypdf>=5'], dependencyMode: 'pypi' },
    { chatId: CHAT },
  ),
);
assert.doesNotMatch(approved, /PY_DEPENDENCY_UNRESOLVABLE/, 'pypi 模式不被目录判定拦下');
assert.match(approved, /PY_DEPENDENCY_APPROVAL_REQUIRED/, 'pypi 模式进入审批门');

// ④ preflight 是干跑查询：不得被前置判定拦下（报告依赖状况本身就是它的产物）
const preflight = text(
  await tool.execute(
    { action: 'run', path: 'scripts/demo.py', requirements: ['pypdf>=5'], preflight: true },
    { chatId: CHAT },
  ),
);
assert.doesNotMatch(preflight, /PY_DEPENDENCY_UNRESOLVABLE/, 'preflight 豁免前置判定');

console.log('[python-dep-contract] 归一化、判定结论、指引文案与工具层前置判定全部通过。');
