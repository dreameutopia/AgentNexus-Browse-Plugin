/**
 * document_tool 端到端契约测试
 *
 * 覆盖真实链路（走工作区 IndexedDB 与产物落盘）：
 *   1. create → edit → convert(docx) → delete 的完整流程；
 *   2. 产物真的落到 outputs/ 并带 workspace-file 标记；
 *   3. 非法输入与不存在文件给出可操作错误（模型能自纠）；
 *   4. 非 .md 路径被拒绝（文档工具只管 Markdown 源文件）。
 *
 * PDF 的 CDP 打印在 background 上下文执行（Node 环境无 chrome.debugger），
 * 该路径由扩展内运行时验证，此处只覆盖「HTML 模板 + 通道降级」的可测部分。
 */

import { chatDatabase } from '../../entrypoints/sidepanel/core/context/chat-database';
import { DocumentTool } from '../../tools/document/document-tool';

// ==================== 本文件自带的迷你断言 ====================

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(condition: boolean, message: string, detail?: unknown): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(`${message}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

function includes(haystack: string, needle: string, message: string): void {
  check(haystack.includes(needle), message, { needle, sample: haystack.slice(0, 200) });
}

/** 断言严格相等 */
function eq(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, message, { actual, expected });
}

/** 取工具结果里的文本内容（ToolResult.content 是多形态联合） */
function resultText(result: { content?: unknown }): string {
  const content = result.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => (item && typeof item === 'object' && 'text' in item ? String((item as { text?: unknown }).text ?? '') : ''))
    .join('\n');
}

const chatId = 'document-tool-e2e-contract';
await chatDatabase.createSession({
  chatId,
  title: chatId,
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
  lastMessagePreview: '',
  agentName: '',
  agentAvatar: '',
} as never);

const tool = new DocumentTool();
const context = { chatId };

// ==================== 1. create → edit → convert → delete ====================

{
  const created = await tool.execute(
    {
      action: 'create',
      path: 'docs/report.md',
      content: [
        '# 端到端报告',
        '',
        '## 结论',
        '',
        '一切正常。',
        '',
        '| 项 | 值 |',
        '| --- | --- |',
        '| a | 1 |',
      ].join('\n'),
    },
    context,
  );
  check(created.success, 'create 成功');
  includes(resultText(created), 'docs/report.md', 'create 回显路径');
  includes(resultText(created), 'convert', 'create 回显提示下一步转换');
}

{
  const edited = await tool.execute(
    { action: 'edit', path: 'docs/report.md', find: '一切正常。', replace: '端到端验证通过。' },
    context,
  );
  check(edited.success, 'edit 成功');
  includes(resultText(edited), '唯一命中替换 1 处', 'edit 回显替换次数');
}

{
  const converted = await tool.execute(
    { action: 'convert', path: 'docs/report.md', format: 'docx', title: '端到端报告' },
    context,
  );
  check(converted.success, 'convert(docx) 成功');
  const text = resultText(converted);
  includes(text, 'Word（.docx）', 'convert 回显产物类型');
  includes(text, 'outputs/', 'convert 回显产物路径');

  const data = converted.data as { files?: { path: string; marker: string }[] } | undefined;
  check(Array.isArray(data?.files) && data.files.length === 1, 'convert 产出 1 个文件');
  const file = data?.files?.[0];
  check(!!file && file.path.startsWith('outputs/'), '产物落在 outputs/ 目录', file?.path);
  check(!!file && file.path.endsWith('.docx'), '产物后缀为 .docx', file?.path);
  check(!!file && file.marker.includes('workspace-file'), '产物带 workspace-file 标记');
  includes(text, file?.marker ?? '', 'convert 文本回显 workspace-file 标记');
}

{
  const deleted = await tool.execute({ action: 'delete', path: 'docs/report.md' }, context);
  check(deleted.success, 'delete 成功');
  includes(resultText(deleted), 'docs/report.md', 'delete 回显路径');
}

// ==================== 2. 图片解析三通道 ====================

{
  // 通道一：工作区既有图片（相对路径）——先写入一张 PNG 到 outputs/，
  // 再在 Markdown 里以相对路径引用，验证它被内联进 DOCX 而非丢失。
  const { saveWorkspaceOutput } = await import('../../utils/python-workspace/store');
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const pngBytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
  await saveWorkspaceOutput(
    chatId,
    'outputs/pic.png',
    new Blob([pngBytes.buffer as ArrayBuffer], { type: 'image/png' }),
  );

  await tool.execute(
    {
      action: 'create',
      path: 'docs/with-image.md',
      content: ['# 带图', '', '![工作区图](outputs/pic.png)'].join('\n'),
    },
    context,
  );
  const converted = await tool.execute(
    { action: 'convert', path: 'docs/with-image.md', format: 'docx' },
    context,
  );
  check(converted.success, '含工作区图片的文档转换成功', resultText(converted));

  const { readWorkspaceOutput } = await import('../../utils/python-workspace/store');
  const data = converted.data as { files?: { path: string }[] } | undefined;
  const blob = await readWorkspaceOutput(chatId, data?.files?.[0]?.path ?? '');
  check(!!blob && blob.size > 0, '含图 DOCX 产物非空');

  if (blob) {
    const { unzipSync, strFromU8 } = await import('fflate');
    const xml = strFromU8(unzipSync(new Uint8Array(await blob.arrayBuffer()))['word/document.xml']);
    includes(xml, 'blip', 'DOCX 含内联图片位图');
  }

  await tool.execute({ action: 'delete', path: 'docs/with-image.md' }, context);
}

// ==================== 3. 编辑模式与指纹 ====================

{
  // 三种编辑模式与工作区引擎一致：content 全量重写 / find+replace / edits 批量替换
  const created = await tool.execute(
    { action: 'create', path: 'docs/modes.md', content: ['# 标题', '', '甲', '', '乙', '', '丙'].join('\n') },
    context,
  );
  check(created.success, 'create（编辑模式用）成功');
  const createdData = created.data as { sha256?: string } | undefined;
  check(typeof createdData?.sha256 === 'string' && createdData.sha256.length === 64, 'create 回传 sha256 指纹');

  // 模式一：find + replace
  const replaced = await tool.execute(
    { action: 'edit', path: 'docs/modes.md', find: '甲', replace: '甲改' },
    context,
  );
  check(replaced.success, 'find+replace 编辑成功');

  // 模式二：edits 批量替换（任一失败则整次不保存）
  const batch = await tool.execute(
    {
      action: 'edit',
      path: 'docs/modes.md',
      edits: [
        { find: '乙', replace: '乙改' },
        { find: '丙', replace: '丙改' },
      ],
    },
    context,
  );
  check(batch.success, 'edits 批量替换成功');
  includes(resultText(batch), '替换 2 处', '批量替换回显替换次数');

  // 模式三：content 全量重写
  const rewritten = await tool.execute(
    { action: 'edit', path: 'docs/modes.md', content: '# 全新内容' },
    context,
  );
  check(rewritten.success, 'content 全量重写成功');
  includes(resultText(rewritten), '已整体重写', '全量重写回显模式');

  // expectedHash：与当前文件不符时必须拒绝保存
  const staleHash = 'a'.repeat(64);
  const conflicted = await tool.execute(
    { action: 'edit', path: 'docs/modes.md', content: '# 冲突写入', expectedHash: staleHash },
    context,
  );
  check(!conflicted.success, 'expectedHash 不匹配时拒绝保存');
  includes(resultText(conflicted), 'DOCUMENT_EDIT_CONFLICT', '冲突错误码可识别');

  // 三种模式互斥
  const exclusive = await tool.execute(
    { action: 'edit', path: 'docs/modes.md', content: '# a', edits: [{ find: 'a', replace: 'b' }] },
    context,
  );
  check(!exclusive.success, 'content 与 edits 互斥被拒');

  await tool.execute({ action: 'delete', path: 'docs/modes.md' }, context);
}

// ==================== 4. 产物命名 ====================

{
  await tool.execute(
    { action: 'create', path: 'docs/naming.md', content: '# 命名测试' },
    context,
  );
  const converted = await tool.execute(
    { action: 'convert', path: 'docs/naming.md', format: 'docx', filename: '季度报告.docx' },
    context,
  );
  check(converted.success, '带 filename 的转换成功', resultText(converted));
  const data = converted.data as { files?: { path: string }[] } | undefined;
  const artifactPath = data?.files?.[0]?.path ?? '';
  // 已有 .docx 后缀不应叠加出畸形名（早先会得到「季度报告..docx」）
  eq(artifactPath, 'outputs/季度报告.docx', '产物文件名后缀正确');
  await tool.execute({ action: 'delete', path: 'docs/naming.md' }, context);
}

// ==================== 5. 同名产物不覆盖 ====================

{
  // 契约：产物一律落在当前会话工作区的 outputs/ 下；同名时不覆盖既有文件，
  // 而是自动改名为 name(1).docx、name(2).docx…
  await tool.execute(
    { action: 'create', path: 'docs/dup-artifact.md', content: '# 重复导出' },
    context,
  );
  const first = await tool.execute(
    { action: 'convert', path: 'docs/dup-artifact.md', format: 'docx', filename: '重复导出' },
    context,
  );
  check(first.success, '首次导出成功', resultText(first));
  const firstData = first.data as { files?: { path: string; marker: string }[] } | undefined;
  eq(firstData?.files?.[0]?.path, 'outputs/重复导出.docx', '首次导出用原名');
  includes(resultText(first), 'outputs/重复导出.docx', '回执给出产物在 outputs/ 下的路径');

  const second = await tool.execute(
    { action: 'convert', path: 'docs/dup-artifact.md', format: 'docx', filename: '重复导出' },
    context,
  );
  check(second.success, '再次导出成功', resultText(second));
  const secondData = second.data as { files?: { path: string; marker: string }[] } | undefined;
  eq(secondData?.files?.[0]?.path, 'outputs/重复导出(1).docx', '再次导出自动加序号（不覆盖）');
  includes(resultText(second), 'outputs/重复导出(1).docx', '回执给出改名后的产物路径');

  const { readWorkspaceOutput } = await import('../../utils/python-workspace/store');
  const original = await readWorkspaceOutput(chatId, 'outputs/重复导出.docx');
  check(!!original && original.size > 0, '既有产物未被覆盖且仍可读');
  const renamed = await readWorkspaceOutput(chatId, 'outputs/重复导出(1).docx');
  check(!!renamed && renamed.size > 0, '改名后的产物可读');

  await tool.execute({ action: 'delete', path: 'docs/dup-artifact.md' }, context);
}

// ==================== 6. 非法输入与失败路径 ====================
{
  const missing = await tool.execute(
    { action: 'convert', path: 'docs/report.md', format: 'docx' },
    context,
  );
  check(!missing.success, 'convert 已删除文件失败');
  includes(resultText(missing), '不存在', '不存在文件的错误可操作');
}

{
  const wrongExt = await tool.execute(
    { action: 'convert', path: 'docs/report.txt', format: 'docx' },
    context,
  );
  check(!wrongExt.success, 'convert 非 .md 路径被拒绝');
  includes(resultText(wrongExt), '.md', '非 .md 的原因指明后缀要求');
}

{
  const badFormat = await tool.execute(
    { action: 'convert', path: 'docs/report.md', format: 'pdfx' },
    context,
  );
  check(!badFormat.success, 'convert 非法 format 被拒绝');
  includes(resultText(badFormat), 'format', '非法 format 的原因指明字段');
}

{
  // 非 .md 的 create 同样被拒（文档工具只管 Markdown 源文件）
  const wrongExtCreate = await tool.execute(
    { action: 'create', path: 'docs/a.txt', content: 'x' },
    context,
  );
  check(!wrongExtCreate.success, 'create 非 .md 路径被拒绝');
}

{
  // 重复 create：已存在文件应拒绝（防误覆盖）
  await tool.execute({ action: 'create', path: 'docs/dup.md', content: '# a' }, context);
  const again = await tool.execute({ action: 'create', path: 'docs/dup.md', content: '# b' }, context);
  check(!again.success, '重复 create 被拒绝（防误覆盖）');
  includes(resultText(again), '已存在', '重复 create 的原因指明文件已存在');
  await tool.execute({ action: 'delete', path: 'docs/dup.md' }, context);
}

// ==================== 汇总 ====================

console.log(`[document-e2e] 通过 ${passed} 项，失败 ${failed} 项`);
if (failed) {
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  throw new Error('document-e2e 断言失败');
}
