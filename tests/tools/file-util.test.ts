/**
 * 工作区文件工具体系测试（file_util 契约 + 类型判定 + 解码阶梯 + Office→Markdown）
 *
 * 覆盖六块：
 *   1. 文件类型判定（file-kinds）：已知后缀、无后缀固定名（Dockerfile 等）、
 *      隐藏文件（.gitignore）、图片识别、Office 识别、未知后缀拒绝；
 *   2. 文本解码阶梯（text-decode）：UTF-8 严格、GBK 回退、BOM 识别、
 *      有损兜底；
 *   3. Office→Markdown（office-markdown）：xlsx（多工作表）、docx（段落 +
 *      标题 + 表格）、pptx（幻灯片顺序 + 文本）；
 *   4. file_util 工具契约（真实存储事务）：创建防覆盖、追加、编辑三模式、
 *      删除、文本读取分页（3000 字符/页 + index 越界）、Office 读取返回
 *      Markdown 路径与字数、类型限制、路径与参数防御；
 *   5. 上传文件清单（upload-file-manifest）：表格形态、仅路径+大小、空清单、
 *      信封安全转义（文件名含 | < > 不得破坏表格或提前闭合标签）；
 *   6. 固定提示词分区（file-util-prompt）：关键纪律句在场。
 *
 * 运行：由 tools.test.ts 末尾动态引入（chrome 全局桩已就位；IndexedDB 由
 * fake-indexeddb 提供）。
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';

import { chatDatabase } from '@/entrypoints/sidepanel/core/context/chat-database';
import { fileUtilTool, FILE_UTIL_READ_PAGE_CHARS } from '../../tools/file-util/index';
import { FILE_UTIL_SYSTEM_PROMPT_SECTION } from '../../tools/file-util/file-util-prompt';
import {
  fileExtension,
  isImageFilePath,
  isTextFilePath,
} from '@/utils/upload-files/file-kinds';
import { decodeTextBytes } from '@/utils/upload-files/text-decode';
import { officeToMarkdown, OfficeConversionError } from '@/utils/upload-files/office-markdown';
import {
  buildUploadFileManifest,
  UPLOAD_FILE_TAG,
} from '@/utils/upload-files/upload-file-manifest';

/** 工具结果正文文本 */
const textOf = (r: { content?: Array<{ type: string; text?: string }> }): string =>
  r.content?.[0]?.text ?? '';

// ==================== 1. 文件类型判定 ====================

assert.equal(isTextFilePath('a/b/report.md'), true, '已知文本后缀');
assert.equal(isTextFilePath('a/b/data.csv'), true, 'csv 是文本');
assert.equal(isTextFilePath('a/b/app.ts'), true, '代码文件是文本');
assert.equal(isTextFilePath('Dockerfile'), true, '无后缀固定名（Dockerfile）');
assert.equal(isTextFilePath('scripts/Makefile'), true, '无后缀固定名（Makefile）');
assert.equal(isTextFilePath('LICENSE'), true, '无后缀固定名（LICENSE）');
assert.equal(isTextFilePath('meson.build'), true, '带点号的固定名也命中（不能被后缀判定漏掉）');
assert.equal(isTextFilePath('a/b/CMakeLists.txt'), true, '固定名大小写不敏感');
assert.equal(isTextFilePath('.gitignore'), true, '隐藏文件按点后整段判定');
assert.equal(isTextFilePath('a/b/.editorconfig'), true, '隐藏配置文件');
assert.equal(isTextFilePath('a/b/photo.png'), false, '图片不是文本');
assert.equal(isTextFilePath('a/b/book.pdf'), false, 'PDF 不是文本');
assert.equal(isTextFilePath('a/b/table.xlsx'), false, 'xlsx 不是文本（只读可转）');
assert.equal(isTextFilePath('a/b/blob.bin'), false, '未知后缀不算文本');
assert.equal(isTextFilePath('a/b/data'), false, '无后缀且不在固定名表内不算文本');
assert.equal(isImageFilePath('a/photo.JPG'), true, '图片后缀大小写不敏感');
assert.equal(isImageFilePath('a/doc.pdf'), false, '非图片');
assert.equal(fileExtension('a/b/report.MD'), 'md', '后缀小写归一');
assert.equal(fileExtension('Dockerfile'), '', '无后缀返回空串');

// ==================== 2. 文本解码阶梯 ====================

assert.equal(decodeTextBytes(new TextEncoder().encode('hello')).text, 'hello');
assert.equal(decodeTextBytes(new TextEncoder().encode('hello')).encoding, 'utf-8');
// GBK（中文 Windows 常见）：UTF-8 严格解码失败 → GBK 命中
const gbkBytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]); // “中文”的 GBK 编码
const gbkDecoded = decodeTextBytes(gbkBytes);
assert.equal(gbkDecoded.encoding, 'gbk', '非 UTF-8 字节回退到 GBK');
assert.equal(gbkDecoded.text, '中文', 'GBK 解码内容正确');
// UTF-8 BOM
const bomBytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x62]);
assert.equal(decodeTextBytes(bomBytes).text, 'ab', 'UTF-8 BOM 被剥离');
// UTF-16LE BOM
const utf16Bytes = new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x62, 0x00]);
assert.equal(decodeTextBytes(utf16Bytes).text, 'ab', 'UTF-16LE BOM 识别');

// ==================== 3. Office → Markdown ====================

/** 构造最小 docx（zip 容器 + word/document.xml） */
function buildDocx(documentXml: string): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
    'word/document.xml': strToU8(documentXml),
  });
}

const docxMarkdown = await officeToMarkdown(
  buildDocx(`<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章</w:t></w:r></w:p>
  <w:p><w:r><w:t>正文段落</w:t></w:r></w:p>
  <w:tbl>
    <w:tr><w:tc><w:p><w:r><w:t>列 A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>列 B</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>值 1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>值 2</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>
</w:body></w:document>`),
  'docx',
);
assert.match(docxMarkdown, /# 第一章/, 'docx 标题层级保留');
assert.match(docxMarkdown, /正文段落/, 'docx 段落文本保留');
assert.match(docxMarkdown, /\| 列 A \| 列 B \|/, 'docx 表格转 Markdown 表格');
assert.match(docxMarkdown, /\| 值 1 \| 值 2 \|/, 'docx 表格数据行保留');

// 嵌套表格：内层表格压平进所在单元格，外层表格结构不被踩踏
const nestedDocx = await officeToMarkdown(
  buildDocx(`<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:tbl>
    <w:tr>
      <w:tc><w:p><w:r><w:t>外层左</w:t></w:r></w:p></w:tc>
      <w:tc>
        <w:p><w:r><w:t>外层右</w:t></w:r></w:p>
        <w:tbl>
          <w:tr><w:tc><w:p><w:r><w:t>内层一</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>内层二</w:t></w:r></w:p></w:tc></w:tr>
        </w:tbl>
      </w:tc>
    </w:tr>
    <w:tr>
      <w:tc><w:p><w:r><w:t>下左</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>下右</w:t></w:r></w:p></w:tc>
    </w:tr>
  </w:tbl>
</w:body></w:document>`),
  'docx',
);
assert.match(nestedDocx, /\| 外层左 \| 外层右/, '嵌套表格场景外层首行完整');
assert.match(nestedDocx, /内层一/, '内层表格文本保留');
assert.match(nestedDocx, /\| 下左 \| 下右 \|/, '外层次行不被内层表格踩踏');

/** 构造最小 pptx（zip 容器 + 两张幻灯片 + presentation 顺序映射） */
function buildPptx(): Uint8Array {
  const slide = (text: string): string =>
    `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  return zipSync({
    'ppt/presentation.xml': strToU8(`<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>`),
    'ppt/_rels/presentation.xml.rels': strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>`),
    'ppt/slides/slide1.xml': strToU8(slide('第一页内容')),
    'ppt/slides/slide2.xml': strToU8(slide('第二页内容')),
  });
}

const pptxMarkdown = await officeToMarkdown(buildPptx(), 'pptx');
assert.match(pptxMarkdown, /## 幻灯片 1/, 'pptx 幻灯片分节');
assert.match(pptxMarkdown, /第一页内容/, 'pptx 文本保留');
assert.match(pptxMarkdown, /第二页内容/, 'pptx 文本保留');
// sldIdLst 顺序是 rId2（slide2）在前、rId1（slide1）在后——放映顺序 ≠ 文件名顺序。
// 回归锚点：<p:sldId id="256" r:id="rId2"> 的无前缀 id 是幻灯片标识、
// r:id 才是关系引用；按 localName 误取 id 会查不到关系映射、退化成文件名排序。
assert.ok(
  pptxMarkdown.indexOf('第二页内容') < pptxMarkdown.indexOf('第一页内容'),
  'pptx 按 presentation 关系顺序（rId2 在前）而非文件名顺序',
);

// pptx 表格：单元格文本必须收集（历史缺陷：cellLines 恒空 → 表格整体静默丢失）
const pptxTableMarkdown = await officeToMarkdown(
  zipSync({
    'ppt/presentation.xml': strToU8(`<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`),
    'ppt/_rels/presentation.xml.rels': strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>`),
    'ppt/slides/slide1.xml': strToU8(`<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
  <p:graphicFrame><a:graphic><a:graphicData>
    <a:tbl>
      <a:tr><a:tc><a:txBody><a:p><a:r><a:t>表头甲</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>表头乙</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
      <a:tr><a:tc><a:txBody><a:p><a:r><a:t>数据 1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>数据 2</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
    </a:tbl>
  </a:graphicData></a:graphic></p:graphicFrame>
</p:spTree></p:cSld></p:sld>`),
  }),
  'pptx',
);
assert.match(pptxTableMarkdown, /\| 表头甲 \| 表头乙 \|/, 'pptx 表格表头保留');
assert.match(pptxTableMarkdown, /\| 数据 1 \| 数据 2 \|/, 'pptx 表格数据行保留');

// 损坏的 zip → 精确错误
await assert.rejects(
  async () => officeToMarkdown(new Uint8Array([1, 2, 3, 4]), 'docx'),
  (error: unknown) => error instanceof OfficeConversionError,
  '损坏包抛 OfficeConversionError',
);

// ==================== 4. file_util 工具契约 ====================

const CHAT = 'file-util-chat';
await chatDatabase.createSession({
  chatId: CHAT, title: 'file util', createdAt: 1, updatedAt: 1,
  messageCount: 0, lastMessagePreview: '', agentName: '',
});

const context = { chatId: CHAT };

// 参数与上下文防御
assert.match(
  textOf(await fileUtilTool.execute(null, context)),
  /错误类型: (参数错误|INVALID_PATH)/,
  '缺参数被拒（落到路径校验）',
);
assert.match(
  textOf(await fileUtilTool.execute({ action: 'read', path: 'a.txt' }, {})),
  /错误类型: 会话上下文缺失/,
  '无会话上下文拒绝',
);
assert.match(
  textOf(await fileUtilTool.execute({ action: 'destroy', path: 'a.txt' }, context)),
  /错误类型: 参数错误/,
  '未知 action 被拒',
);
assert.match(
  textOf(await fileUtilTool.execute({ path: 'a.txt' }, context)),
  /错误类型: 参数错误/,
  '缺 action 显式拒绝（不静默默认 read）',
);
assert.match(
  textOf(await fileUtilTool.execute({ action: 'create', path: 'a.txt', content: 'x', typo: 1 }, context)),
  /未知参数[:：]\s*typo/,
  '未知键精确报错',
);
assert.match(
  textOf(await fileUtilTool.execute({ action: 'read', path: 'a.txt', content: 'x' }, context)),
  /不属于 action="read"/,
  '跨 action 串参被拒（read 不收 content）',
);
assert.match(
  textOf(await fileUtilTool.execute({ action: 'delete', path: 'a.txt', find: 'x', replace: 'y' }, context)),
  /不属于 action="delete"/,
  '跨 action 串参被拒（delete 不收 find/replace）',
);
for (const badIndex of [0, -1, 1.5, 'abc']) {
  assert.match(
    textOf(await fileUtilTool.execute({ action: 'read', path: 'a.txt', index: badIndex }, context)),
    /错误类型: 参数错误/,
    `非法 index 被拒：${JSON.stringify(badIndex)}`,
  );
}

// 创建 + 同名同后缀防覆盖
const created = await fileUtilTool.execute(
  { action: 'create', path: 'content/notes.md', content: '# 标题\n正文内容\n' },
  context,
);
assert.equal(created.success, true, textOf(created));
assert.match(textOf(created), /已创建 content\/notes\.md/);
const duplicate = await fileUtilTool.execute(
  { action: 'create', path: 'content/notes.md', content: 'x' },
  context,
);
assert.equal(duplicate.success, false);
assert.match(textOf(duplicate), /错误类型: FILE_EXISTS/, '同名同后缀拒绝覆盖');

// 类型限制：非文本文件不可写
const binaryWrite = await fileUtilTool.execute(
  { action: 'create', path: 'inputs/book.pdf', content: 'x' },
  context,
);
assert.equal(binaryWrite.success, false);
assert.match(textOf(binaryWrite), /错误类型: 不支持的文件类型/, '非文本文件拒绝写入');
const binaryDelete = await fileUtilTool.execute({ action: 'delete', path: 'inputs/book.pdf' }, context);
assert.equal(binaryDelete.success, false);
assert.match(textOf(binaryDelete), /错误类型: 不支持的文件类型/, '非文本文件拒绝删除');

// 追加
const appended = await fileUtilTool.execute(
  { action: 'append', path: 'content/notes.md', content: '追加行\n' },
  context,
);
assert.equal(appended.success, true, textOf(appended));
let snapshot = await chatDatabase.readWorkspace(CHAT);
assert.equal(
  await snapshot!.entries.find(entry => entry.path === 'content/notes.md')!.blob!.text(),
  '# 标题\n正文内容\n追加行\n',
  '追加内容落在文件末尾',
);

// 追加到不存在的文件 → 明确报错
const appendMissing = await fileUtilTool.execute(
  { action: 'append', path: 'content/missing.md', content: 'x' },
  context,
);
assert.equal(appendMissing.success, false);
assert.match(textOf(appendMissing), /错误类型: FILE_NOT_FOUND/, '追加前提是文件已存在');

// 编辑：find/replace + 唯一命中
const edited = await fileUtilTool.execute(
  { action: 'edit', path: 'content/notes.md', find: '正文内容', replace: '新正文' },
  context,
);
assert.equal(edited.success, true, textOf(edited));
snapshot = await chatDatabase.readWorkspace(CHAT);
assert.match(await snapshot!.entries.find(entry => entry.path === 'content/notes.md')!.blob!.text(), /新正文/);

// 编辑：expectedHash 冲突保护
const staleHash = await fileUtilTool.execute(
  { action: 'edit', path: 'content/notes.md', content: 'x', expectedHash: 'a'.repeat(64) },
  context,
);
assert.equal(staleHash.success, false);
assert.match(textOf(staleHash), /错误类型: EDIT_CONFLICT/, 'expectedHash 不匹配拒绝保存');

// 读取：默认第 1 页、分页 3000 字符
const longText = '字'.repeat(FILE_UTIL_READ_PAGE_CHARS + 500);
await fileUtilTool.execute({ action: 'create', path: 'content/long.txt', content: longText }, context);
const page1 = await fileUtilTool.execute({ action: 'read', path: 'content/long.txt' }, context);
assert.equal(page1.success, true, textOf(page1));
assert.equal(page1.data.index, 1, '默认第 1 页');
assert.equal(page1.data.pageCount, 2, '两页');
assert.equal(page1.data.currentChars, FILE_UTIL_READ_PAGE_CHARS, '单页 3000 字符');
assert.equal(page1.data.nextIndex, 2, '回填下一页页码');
const page2 = await fileUtilTool.execute({ action: 'read', path: 'content/long.txt', index: 2 }, context);
assert.equal(page2.data.currentChars, 500, '末页余量');
assert.equal(page2.data.hasMore, false, '末页无后续');

// 分页边界不拆代理对（严格网关 400 防线）：emoji 正好压在 3000 边界上
const surrogateText = 'a'.repeat(FILE_UTIL_READ_PAGE_CHARS - 1) + '😀' + 'b'.repeat(10);
await fileUtilTool.execute({ action: 'create', path: 'content/surrogate.txt', content: surrogateText }, context);
const surrogatePage1 = await fileUtilTool.execute({ action: 'read', path: 'content/surrogate.txt' }, context);
assert.equal(surrogatePage1.success, true, textOf(surrogatePage1));
assert.equal(
  surrogatePage1.data.currentChars,
  FILE_UTIL_READ_PAGE_CHARS - 1,
  '边界拆开代理对时页末收缩一位，不得输出孤立高位代理',
);
const surrogatePage2 = await fileUtilTool.execute({ action: 'read', path: 'content/surrogate.txt', index: 2 }, context);
assert.equal(surrogatePage2.success, true, textOf(surrogatePage2));
assert.equal(surrogatePage2.data.currentChars, 12, '下一页从完整代理对起笔（emoji 占 2 个 UTF-16 单元 + 10 个 b）');

// 空文件读取：显式标注，不出现「第 1/1 页（0 页）」自相矛盾
await fileUtilTool.execute({ action: 'create', path: 'content/empty.txt', content: '' }, context);
const emptyRead = await fileUtilTool.execute({ action: 'read', path: 'content/empty.txt' }, context);
assert.equal(emptyRead.success, true, textOf(emptyRead));
assert.match(textOf(emptyRead), /空文件/, '空文件显式标注');

// 页码越界
const outOfRange = await fileUtilTool.execute({ action: 'read', path: 'content/long.txt', index: 99 }, context);
assert.equal(outOfRange.success, false);
assert.match(textOf(outOfRange), /错误类型: 页码越界/, '页码越界报错并回显总页数');
assert.match(textOf(outOfRange), /2 页/, '越界信息回显总页数');

// 读取不支持的后缀
const unsupported = await fileUtilTool.execute({ action: 'read', path: 'inputs/book.pdf' }, context);
assert.equal(unsupported.success, false);
assert.match(textOf(unsupported), /错误类型: 不支持的文件类型/, '不支持后缀精准报错');
assert.match(textOf(unsupported), /可读取/, '错误信息给出可读取范围');

// Office 读取：返回 Markdown 路径 + 字数（不内联正文）
// 二进制 docx 直接经存储植入（create 的写入门只放行文本文件，此处不走它）
const docxBytes = buildDocx(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCKMARKERTEXT</w:t></w:r></w:p></w:body></w:document>`);
await chatDatabase.updateWorkspace(CHAT, current => {
  const entries = current?.entries ?? [];
  const next = entries.filter(entry => entry.path !== 'inputs/note.docx');
  next.push({
    path: 'inputs/note.docx',
    blob: new Blob([docxBytes.buffer as ArrayBuffer]),
    mode: 0o644,
    mtime: Date.now(),
  });
  return { snapshot: { revision: crypto.randomUUID(), entries: next }, result: undefined };
});
const officeRead = await fileUtilTool.execute({ action: 'read', path: 'inputs/note.docx' }, context);
assert.equal(officeRead.success, true, textOf(officeRead));
assert.match(String(officeRead.data.markdownPath), /^content\/note-[0-9a-f]{8}\.md$/, '派生 Markdown 路径确定');
assert.ok(Number(officeRead.data.chars) > 0, '返回字符数');
assert.ok(!textOf(officeRead).includes('DOCKMARKERTEXT'), 'Office 读取不内联正文');
// 再读派生 Markdown → 拿到正文
const derivedRead = await fileUtilTool.execute(
  { action: 'read', path: String(officeRead.data.markdownPath) },
  context,
);
assert.equal(derivedRead.success, true, textOf(derivedRead));
assert.match(textOf(derivedRead), /DOCKMARKERTEXT/, '派生 Markdown 可按页读取');

// 删除
const deleted = await fileUtilTool.execute({ action: 'delete', path: 'content/notes.md' }, context);
assert.equal(deleted.success, true, textOf(deleted));
snapshot = await chatDatabase.readWorkspace(CHAT);
assert.equal(
  snapshot!.entries.some(entry => entry.path === 'content/notes.md'),
  false,
  '删除后条目消失',
);

// ==================== 4b. list / search / grep / copy ====================

const readText = async (path: string, index = 1): Promise<string> => {
  const result = await fileUtilTool.execute({ action: 'read', path, index }, context);
  assert.equal(result.success, true, textOf(result));
  const raw = textOf(result);
  const separator = raw.indexOf('\n\n');
  if (separator < 0) return '';
  const footer = raw.indexOf('\n\n[', separator + 2);
  return raw.slice(separator + 2, footer < 0 ? undefined : footer);
};

// ── list：直接子项、目录优先、分页、缺失/文件当目录的可执行报错 ──
await fileUtilTool.execute({ action: 'create', path: 'tree/root.txt', content: 'alpha here\n' }, context);
await fileUtilTool.execute({ action: 'create', path: 'tree/a/one.txt', content: 'nothing\n' }, context);
await fileUtilTool.execute({ action: 'create', path: 'tree/a/two.md', content: '# alpha\n' }, context);
await fileUtilTool.execute({ action: 'create', path: 'tree/b/three.txt', content: 'alpha again\n' }, context);

const treeList = await fileUtilTool.execute({ action: 'list', path: 'tree' }, context);
assert.equal(treeList.success, true, textOf(treeList));
assert.deepEqual(
  treeList.data.entries.map((entry: { path: string }) => entry.path),
  ['tree/a', 'tree/b', 'tree/root.txt'],
  'list 只列直接子项，目录在前、文件在后',
);
assert.equal(treeList.data.total, 3);
assert.equal(treeList.data.hasMore, false);

const rootList = await fileUtilTool.execute({ action: 'list' }, context);
assert.equal(rootList.success, true, textOf(rootList));
assert.ok(rootList.data.entries.some((entry: { path: string }) => entry.path === 'tree'), 'list 省略 path 即根目录');

const pagedList = await fileUtilTool.execute({ action: 'list', path: 'tree', offset: 1, limit: 1 }, context);
assert.deepEqual(pagedList.data.entries.map((entry: { path: string }) => entry.path), ['tree/b']);
assert.equal(pagedList.data.hasMore, true, 'list 分页 hasMore');
assert.equal(pagedList.data.nextOffset, 2);

const listOverLimit = await fileUtilTool.execute({ action: 'list', limit: 201 }, context);
assert.equal(listOverLimit.success, false);
assert.match(textOf(listOverLimit), /最多 200/, 'list 单页上限 200');

const listMissing = await fileUtilTool.execute({ action: 'list', path: 'tree/nope' }, context);
assert.equal(listMissing.success, false);
assert.match(textOf(listMissing), /DIR_NOT_FOUND/, '缺失目录显式报错');
assert.match(textOf(listMissing), /根目录/, '缺失目录给出下一步');

const listFile = await fileUtilTool.execute({ action: 'list', path: 'tree/root.txt' }, context);
assert.equal(listFile.success, false);
assert.match(textOf(listFile), /NOT_A_DIRECTORY/, '文件当目录被拒');
assert.match(textOf(listFile), /file_util\(action="read"/, '文件路径给出 read 指引');

// ── search：递归路径正则、目录也参与、分页上限 30 ──
const mdSearch = await fileUtilTool.execute({ action: 'search', path: 'tree', pattern: '\\.md$' }, context);
assert.equal(mdSearch.success, true, textOf(mdSearch));
assert.deepEqual(mdSearch.data.entries.map((entry: { path: string }) => entry.path), ['tree/a/two.md'], 'search 递归匹配完整相对路径');

const dirSearch = await fileUtilTool.execute({ action: 'search', pattern: '^tree/b' }, context);
assert.deepEqual(
  dirSearch.data.entries.map((entry: { path: string; kind: string }) => `${entry.kind}:${entry.path}`),
  ['directory:tree/b', 'file:tree/b/three.txt'],
  'search 命中目录与文件，目录在前',
);
assert.equal(dirSearch.data.hasMore, false);

const pagedSearch = await fileUtilTool.execute({ action: 'search', path: 'tree', pattern: '.', offset: 1, limit: 1 }, context);
assert.equal(pagedSearch.data.total >= 5, true);
assert.equal(pagedSearch.data.hasMore, true, 'search 分页 hasMore');

const badRegex = await fileUtilTool.execute({ action: 'search', pattern: '(' }, context);
assert.equal(badRegex.success, false);
assert.match(textOf(badRegex), /不是合法正则/, '非法正则显式报错');

const tooManySearch = await fileUtilTool.execute({ action: 'search', pattern: 'x', limit: 31 }, context);
assert.equal(tooManySearch.success, false, 'search 单页上限 30（超限显式拒绝）');
assert.match(textOf(tooManySearch), /最多 30/, 'search 上限错误回显阈值');

// ── grep：指定文件列表、行号/页码、跳过非文本、分页 ──
await fileUtilTool.execute(
  { action: 'create', path: 'content/grep-lines.txt', content: 'zero\nalpha one\nbeta\nalpha two\n' },
  context,
);
const grep = await fileUtilTool.execute(
  {
    action: 'grep',
    files: ['content/grep-lines.txt', 'tree/root.txt', 'tree/a/one.txt'],
    pattern: 'alpha',
  },
  context,
);
assert.equal(grep.success, true, textOf(grep));
assert.equal(grep.data.total, 3, 'grep 命中行数（每行一条）');
assert.deepEqual(
  grep.data.matches.map((match: { path: string; line: number }) => `${match.path}:${match.line}`),
  ['content/grep-lines.txt:2', 'content/grep-lines.txt:4', 'tree/root.txt:1'],
  'grep 返回路径与行号',
);
assert.equal(grep.data.matches[0].index, 1, 'grep 返回可续读页码');
assert.equal(grep.data.matches[0].text, 'alpha one', 'grep 返回整行内容');
assert.equal(grep.data.matches[0].matchCount, 1);

const pagedGrep = await fileUtilTool.execute(
  { action: 'grep', files: ['content/grep-lines.txt'], pattern: 'alpha', offset: 1, limit: 1 },
  context,
);
assert.equal(pagedGrep.data.matches.length, 1);
assert.equal(pagedGrep.data.matches[0].line, 4);
assert.equal(pagedGrep.data.hasMore, false);

// 页码换算：命中行落在第 2 页（3000 字符/页）
await fileUtilTool.execute(
  { action: 'create', path: 'content/grep-page.txt', content: 'x'.repeat(3000) + '\nNEEDLE\n' },
  context,
);
const pageGrep = await fileUtilTool.execute(
  { action: 'grep', files: ['content/grep-page.txt'], pattern: 'NEEDLE' },
  context,
);
assert.equal(pageGrep.data.matches[0].index, 2, '命中行页码与 read 的 3000 字符分页一致');
assert.equal((await readText('content/grep-page.txt', 2)).trim(), 'NEEDLE');

// 跳过非文本 / 不存在：逐文件隔离并回报原因
await chatDatabase.updateWorkspace(CHAT, current => ({
  snapshot: {
    revision: crypto.randomUUID(),
    entries: [
      ...(current?.entries ?? []).filter(entry => entry.path !== 'inputs/pic.png'),
      { path: 'inputs/pic.png', blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), mode: 0o644, mtime: Date.now() },
    ],
  },
  result: undefined,
}));
const skippedGrep = await fileUtilTool.execute(
  { action: 'grep', files: ['inputs/pic.png', 'content/missing.txt', 'content/grep-lines.txt'], pattern: 'alpha' },
  context,
);
assert.equal(skippedGrep.success, true, textOf(skippedGrep));
assert.equal(skippedGrep.data.skipped.length, 2, '非文本与不存在文件被跳过');
assert.match(JSON.stringify(skippedGrep.data.skipped), /不是文本文件/, '跳过原因指明非文本');
assert.match(JSON.stringify(skippedGrep.data.skipped), /不存在/, '跳过原因指明不存在');

const emptyGrep = await fileUtilTool.execute({ action: 'grep', files: [], pattern: 'x' }, context);
assert.equal(emptyGrep.success, false, 'grep 空文件列表被拒');
const badGrepRegex = await fileUtilTool.execute({ action: 'grep', files: ['content/grep-lines.txt'], pattern: '[' }, context);
assert.equal(badGrepRegex.success, false, 'grep 非法正则被拒');

// ── copy：任意类型、后缀一致、父目录存在、不覆盖 ──
// 前文已删除 content/notes.md，这里重建一个稳定的复制源；outputs/ 首次写入由 create 自动建目录
await fileUtilTool.execute({ action: 'create', path: 'content/notes.md', content: '# 标题\n正文内容\n' }, context);
await fileUtilTool.execute({ action: 'create', path: 'outputs/seed.txt', content: 'seed\n' }, context);
const copiedText = await fileUtilTool.execute(
  { action: 'copy', path: 'content/notes.md', target: 'outputs/notes-copy.md' },
  context,
);
assert.equal(copiedText.success, true, textOf(copiedText));
assert.equal(copiedText.data.file.marker, '<workspace-file path="outputs/notes-copy.md" />', 'outputs 副本带交付物标记');
assert.equal(await readText('outputs/notes-copy.md'), await readText('content/notes.md'), '文本副本内容逐字节一致');

const copiedBinary = await fileUtilTool.execute(
  { action: 'copy', path: 'inputs/pic.png', target: 'outputs/pic-copy.png' },
  context,
);
assert.equal(copiedBinary.success, true, textOf(copiedBinary));
assert.equal(copiedBinary.data.bytes, 4, '二进制副本保留字节数（类型不受限）');

const copyWrongExt = await fileUtilTool.execute(
  { action: 'copy', path: 'content/notes.md', target: 'outputs/notes-copy.txt' },
  context,
);
assert.equal(copyWrongExt.success, false);
assert.match(textOf(copyWrongExt), /后缀必须与源文件完全一致/, '副本后缀必须一致');

const copyUpperExt = await fileUtilTool.execute(
  { action: 'copy', path: 'content/notes.md', target: 'outputs/NOTES-COPY.MD' },
  context,
);
assert.equal(copyUpperExt.success, true, '后缀大小写不敏感');

const copySame = await fileUtilTool.execute(
  { action: 'copy', path: 'content/notes.md', target: 'content/notes.md' },
  context,
);
assert.equal(copySame.success, false, 'source 与 target 相同被拒');

const copyAgain = await fileUtilTool.execute(
  { action: 'copy', path: 'content/notes.md', target: 'outputs/notes-copy.md' },
  context,
);
assert.equal(copyAgain.success, false);
assert.match(textOf(copyAgain), /FILE_EXISTS/, '副本目标已存在被拒（不覆盖）');

const copyMissingParent = await fileUtilTool.execute(
  { action: 'copy', path: 'content/notes.md', target: 'outputs/nested/notes-copy.md' },
  context,
);
assert.equal(copyMissingParent.success, false);
assert.match(textOf(copyMissingParent), /父目录不存在/, '副本父目录不存在显式报错');

const copyIntoResults = await fileUtilTool.execute(
  { action: 'copy', path: 'content/notes.md', target: 'results/notes-copy.md' },
  context,
);
assert.equal(copyIntoResults.success, false);
assert.match(textOf(copyIntoResults), /results\//, 'results/ 不接受副本写入');

const copyMissingSource = await fileUtilTool.execute(
  { action: 'copy', path: 'content/missing.md', target: 'outputs/missing.md' },
  context,
);
assert.equal(copyMissingSource.success, false);
assert.match(textOf(copyMissingSource), /FILE_NOT_FOUND/, '副本源文件不存在被拒');

// 无后缀文件：副本也必须无后缀（保留固定名语义）
await fileUtilTool.execute({ action: 'create', path: 'content/Dockerfile', content: 'FROM scratch\n' }, context);
const copyNoExt = await fileUtilTool.execute(
  { action: 'copy', path: 'content/Dockerfile', target: 'content/Dockerfile copy' },
  context,
);
assert.equal(copyNoExt.success, true, textOf(copyNoExt));

// ── 保留目录：写操作拒绝，盘点/读取放行（回归：曾误拦 list/read） ──
const writeReservedDir = await fileUtilTool.execute({ action: 'create', path: 'content', content: 'x' }, context);
assert.equal(writeReservedDir.success, false, '保留目录不能作为文件创建目标');
assert.match(textOf(writeReservedDir), /保留目录/, '保留目录写入给出明确原因');
const listReservedDir = await fileUtilTool.execute({ action: 'list', path: 'content' }, context);
assert.equal(listReservedDir.success, true, textOf(listReservedDir));
assert.ok(Array.isArray(listReservedDir.data.entries), '保留目录可正常盘点');
const deleteReservedDir = await fileUtilTool.execute({ action: 'delete', path: 'content' }, context);
assert.equal(deleteReservedDir.success, false, '目录本身不能删除');
assert.match(textOf(deleteReservedDir), /目录/, '删除目录给出目录原因');

// ── 根路径 "." / 空白 path / 非对象参数（防御） ──
const rootDotList = await fileUtilTool.execute({ action: 'list', path: '.' }, context);
assert.equal(rootDotList.success, true, textOf(rootDotList));
assert.ok(rootDotList.data.total > 0, 'list path="." 列出根目录');
const rootDotSearch = await fileUtilTool.execute({ action: 'search', path: '.', pattern: 'tree/' }, context);
assert.equal(rootDotSearch.success, true, textOf(rootDotSearch));
assert.ok(rootDotSearch.data.total > 0, 'search path="." 从根目录递归匹配');
const dotRead = await fileUtilTool.execute({ action: 'read', path: '.' }, context);
assert.equal(dotRead.success, false, 'read 不接受 "." 作为文件路径');
assert.match(textOf(dotRead), /仅用于 list\/search/, '点路径给出明确原因');
const blankPath = await fileUtilTool.execute({ action: 'list', path: '   ' }, context);
assert.equal(blankPath.success, false, '空白 path 不能静默当作根目录');
assert.match(textOf(blankPath), /非空的工作区相对路径/, '空白 path 显式报错');
const arrayArgs = await fileUtilTool.execute([{ action: 'list' }] as unknown, context);
assert.equal(arrayArgs.success, false, '数组参数被拒绝');
assert.match(textOf(arrayArgs), /JSON 对象/, '非对象参数结构化报错');

// ── grep 防御：链接/目录逐文件跳过、文件数上限、零长度正则、超长行不拆代理对 ──
await chatDatabase.updateWorkspace(CHAT, current => ({
  snapshot: {
    revision: crypto.randomUUID(),
    entries: [
      ...(current?.entries ?? []).filter(entry => entry.path !== 'content/grep-link.txt'),
      { path: 'content/grep-link.txt', blob: null, link: 'content/grep-lines.txt', mode: 0o644, mtime: Date.now() },
    ],
  },
  result: undefined,
}));
const linkGrep = await fileUtilTool.execute(
  { action: 'grep', files: ['content/grep-link.txt', 'tree/a', 'content/grep-lines.txt'], pattern: 'alpha' },
  context,
);
assert.equal(linkGrep.success, true, textOf(linkGrep));
assert.equal(linkGrep.data.skipped.length, 2, '链接与目录都被逐文件跳过');
assert.match(JSON.stringify(linkGrep.data.skipped), /符号链接/, '链接跳过原因准确（不被误报为不存在）');
assert.match(JSON.stringify(linkGrep.data.skipped), /是目录/, '目录跳过原因准确');

const tooManyGrepFiles = await fileUtilTool.execute(
  { action: 'grep', files: Array.from({ length: 51 }, (_, i) => `content/f${i}.txt`), pattern: 'x' },
  context,
);
assert.equal(tooManyGrepFiles.success, false, 'grep 文件数超限被拒');
assert.match(textOf(tooManyGrepFiles), /超过上限 50/, 'grep 文件数上限回显阈值');

const zeroWidthGrep = await fileUtilTool.execute(
  { action: 'grep', files: ['content/grep-lines.txt'], pattern: '^' },
  context,
);
assert.equal(zeroWidthGrep.success, true, textOf(zeroWidthGrep));
assert.equal(zeroWidthGrep.data.matches[0].matchCount, 1, '零长度正则按行计一次（不死循环虚增）');

await fileUtilTool.execute(
  { action: 'create', path: 'content/grep-long.txt', content: 'A'.repeat(399) + '😀' + 'B'.repeat(30) + '\n' },
  context,
);
const clippedGrep = await fileUtilTool.execute(
  { action: 'grep', files: ['content/grep-long.txt'], pattern: 'A' },
  context,
);
const clippedText = String(clippedGrep.data.matches[0].text);
assert.equal(clippedText.length, 400, '超长行截断到 400 字符（含省略号）');
assert.equal(clippedText.endsWith('…'), true, '截断行以省略号结尾');
assert.equal(/[\uD800-\uDFFF]/u.test(clippedText), false, '截断不得产生孤立代理项（严格网关 400 防线）');

// ── Office 转换产物跟随源字节：源被替换后必须重新生成，不能读到陈旧 Markdown ──
const docxA = buildDocx(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>VERSION_A</w:t></w:r></w:p></w:body></w:document>`);
const docxB = buildDocx(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>VERSION_B</w:t></w:r></w:p></w:body></w:document>`);
const seedDocx = async (bytes: Uint8Array): Promise<void> => {
  await chatDatabase.updateWorkspace(CHAT, current => ({
    snapshot: {
      revision: crypto.randomUUID(),
      entries: [
        ...(current?.entries ?? []).filter(entry => entry.path !== 'inputs/version.docx'),
        { path: 'inputs/version.docx', blob: new Blob([bytes.buffer as ArrayBuffer]), mode: 0o644, mtime: Date.now() },
      ],
    },
    result: undefined,
  }));
};
await seedDocx(docxA);
const firstOffice = await fileUtilTool.execute({ action: 'read', path: 'inputs/version.docx' }, context);
assert.equal(firstOffice.success, true, textOf(firstOffice));
await seedDocx(docxB);
const secondOffice = await fileUtilTool.execute({ action: 'read', path: 'inputs/version.docx' }, context);
assert.equal(secondOffice.success, true, textOf(secondOffice));
assert.notEqual(secondOffice.data.markdownPath, firstOffice.data.markdownPath, '源字节变化后生成新的 Markdown 产物');
assert.match(
  await readText(String(secondOffice.data.markdownPath)),
  /VERSION_B/,
  '新产物内容来自最新源字节',
);

// ── 会话缺失统一映射为 CONTEXT（读类通道与写类通道同口径） ──
for (const args of [
  { action: 'read', path: 'content/notes.md' },
  { action: 'list' },
  { action: 'grep', files: ['content/notes.md'], pattern: 'x' },
]) {
  const missing = await fileUtilTool.execute(args, { chatId: 'no-such-chat' });
  assert.equal(missing.success, false, `会话缺失被拒: ${args.action}`);
  assert.equal(missing.data.errorKind, 'CONTEXT', `会话缺失归类 CONTEXT: ${args.action}`);
}

// ==================== 4c. 缩进敏感编辑（Python 脚本全场景） ====================

const PY_SCRIPT = [
  'import os',
  '',
  'def build(items):',
  '    result = []',
  '    for item in items:',
  '        if item:',
  '            result.append(item.strip())',
  '    return result',
  '',
  'class Runner:',
  '    def run(self):',
  '        value = 1',
  '        return value',
  '',
].join('\n');
await fileUtilTool.execute({ action: 'create', path: 'scripts/deep.py', content: PY_SCRIPT }, context);

// 1) 单行精确替换：缩进与上下文保持不变
const singleLine = await fileUtilTool.execute(
  { action: 'edit', path: 'scripts/deep.py', find: '        if item:', replace: '        if item is not None:' },
  context,
);
assert.equal(singleLine.success, true, textOf(singleLine));
let py = await readText('scripts/deep.py');
assert.match(py, /^        if item is not None:$/m, '单行替换保留 8 空格缩进');
assert.equal(py.split('\n').length, PY_SCRIPT.split('\n').length, '单行替换不改变行数');
assert.match(py, /^    for item in items:$/m, '相邻行缩进未被改写');
assert.match(py, /^class Runner:$/m, '后续类定义未被破坏');

// 2) 多行精确替换：函数签名与函数体一起替换
const multiLine = await fileUtilTool.execute(
  {
    action: 'edit',
    path: 'scripts/deep.py',
    find: 'def build(items):\n    result = []\n',
    replace: 'def build(items, *, strict=False):\n    result = []\n',
  },
  context,
);
assert.equal(multiLine.success, true, textOf(multiLine));
py = await readText('scripts/deep.py');
assert.match(py, /^def build\(items, \*, strict=False\):$/m, '多行替换命中函数签名');
assert.match(py, /^    result = \[\]$/m, '多行替换保留 4 空格函数体');

// 3) indentation 模式：find 用相对缩进，目标缩进由命中块决定
const indentationEdit = await fileUtilTool.execute(
  {
    action: 'edit',
    path: 'scripts/deep.py',
    find: 'def run(self):\n    value = 1\n    return value\n',
    replace: 'def run(self):\n    value = 2\n    return value * 2\n',
    matchMode: 'indentation',
  },
  context,
);
assert.equal(indentationEdit.success, true, textOf(indentationEdit));
py = await readText('scripts/deep.py');
assert.match(py, /^    def run\(self\):$/m, 'indentation 模式保留方法定义的 4 空格缩进');
assert.match(py, /^        value = 2$/m, 'indentation 模式为方法体补上 8 空格缩进');
assert.match(py, /^        return value \* 2$/m, '多行替换每一行都按基准缩进对齐');
assert.doesNotMatch(py, /^ {4}value = 2$/m, '不会把方法体误缩进到 4 空格（语法破坏）');

// 4) 制表符 + CRLF：indentation 模式保留原换行与 tab
await fileUtilTool.execute(
  { action: 'create', path: 'config/indent.yaml', content: 'root:\r\n\tsection:\r\n\t\tvalue: old\r\n\t\tother: stay\r\n' },
  context,
);
const tabEdit = await fileUtilTool.execute(
  {
    action: 'edit',
    path: 'config/indent.yaml',
    find: 'section:\n\tvalue: old',
    replace: 'section:\n\tvalue: new',
    matchMode: 'indentation',
  },
  context,
);
assert.equal(tabEdit.success, true, textOf(tabEdit));
assert.equal(
  await readText('config/indent.yaml'),
  'root:\r\n\tsection:\r\n\t\tvalue: new\r\n\t\tother: stay\r\n',
  'CRLF 与 tab 缩进原样保留',
);

// 5) replaceAll：仅替换缩进匹配的全部出现
await fileUtilTool.execute(
  { action: 'create', path: 'scripts/repeat.py', content: 'def f():\n    value = 1\n    value = 1\n' },
  context,
);
const repeated = await fileUtilTool.execute(
  { action: 'edit', path: 'scripts/repeat.py', find: '    value = 1', replace: '    value = 2', replaceAll: true },
  context,
);
assert.equal(repeated.success, true, textOf(repeated));
assert.equal(repeated.data.replaced, 2, 'replaceAll 命中两处缩进行');
assert.equal(await readText('scripts/repeat.py'), 'def f():\n    value = 2\n    value = 2\n');

// 6) 批量 edits 原子性：任一失败整次不保存
const beforeBatch = await readText('scripts/repeat.py');
const atomic = await fileUtilTool.execute(
  {
    action: 'edit',
    path: 'scripts/repeat.py',
    edits: [
      { find: '    value = 2', replace: '    value = 3' },
      { find: 'missing-anchor', replace: 'x' },
    ],
  },
  context,
);
assert.equal(atomic.success, false, '批量编辑任一失败即拒绝');
assert.equal(await readText('scripts/repeat.py'), beforeBatch, '失败后文件保持原样（原子回滚）');

// 7) expectedHash 冲突：文件已变化时拒绝写入
const stale = await fileUtilTool.execute({ action: 'read', path: 'scripts/repeat.py' }, context);
await fileUtilTool.execute(
  { action: 'edit', path: 'scripts/repeat.py', find: '    value = 2', replace: '    value = 4', replaceAll: true },
  context,
);
const conflicted = await fileUtilTool.execute(
  { action: 'edit', path: 'scripts/repeat.py', content: 'def f():\n    pass\n', expectedHash: stale.data.sha256 },
  context,
);
assert.equal(conflicted.success, false, 'expectedHash 不匹配拒绝覆盖并发编辑');
assert.match(textOf(conflicted), /EXPECTED_HASH|已变化|冲突/, '冲突错误原因可识别');

// 8) 替换文本按字面处理：$& / $1 / 反斜杠不触发二次解释
const literal = await fileUtilTool.execute(
  { action: 'edit', path: 'scripts/repeat.py', find: '    value = 4', replace: '    value = $&$1\\\\n', replaceAll: true },
  context,
);
assert.equal(literal.success, true, textOf(literal));
assert.equal(
  await readText('scripts/repeat.py'),
  'def f():\n    value = $&$1\\\\n\n    value = $&$1\\\\n\n',
  '$ 与反斜杠按字面写入',
);

// 9) 替换后的 Python 缩进结构仍合法（逐行检查：非空行不得出现非法缩进跳变）
const finalPy = await readText('scripts/deep.py');
let previousIndent = 0;
for (const line of finalPy.split('\n')) {
  if (!line.trim()) continue;
  const indent = line.length - line.trimStart().length;
  assert.equal(indent % 4, 0, `缩进必须是 4 的倍数：${JSON.stringify(line)}`);
  assert.ok(
    indent <= previousIndent + 4 || /^(else|elif|except|finally)\b/.test(line.trim()),
    `缩进跳变不得超过一级：${JSON.stringify(line)}`,
  );
  previousIndent = indent;
}
assert.match(finalPy, /^class Runner:$/m);
assert.match(finalPy, /^        return value \* 2$/m);

// ==================== 5. 上传文件清单 ====================

assert.equal(buildUploadFileManifest([]), '', '空清单不产出信封');
const manifest = buildUploadFileManifest([
  { path: 'inputs/简历.pdf', name: '简历.pdf', sizeBytes: 245678, ext: 'pdf' },
  { path: 'inputs/notes.txt', name: 'notes.txt', sizeBytes: 12, ext: 'txt' },
]);
assert.match(manifest, new RegExp(`<${UPLOAD_FILE_TAG}>`), '清单使用 upload_file 标签');
assert.match(manifest, /\| 路径 \| 大小（字节） \|/, '清单为表格形态');
assert.match(manifest, /\| inputs\/简历\.pdf \| 245678 \|/, '每行一个文件（路径 + 大小）');
assert.ok(!manifest.includes('12) |'), '清单不夹带正文');
assert.equal((manifest.match(/\|/g) ?? []).length, 12, '仅表头 + 分隔行 + 两行数据（每行 3 个竖线）');

// 信封安全：文件名允许含 | < >——不转义会破坏表格、甚至提前闭合 <upload_file> 标签
const trickyManifest = buildUploadFileManifest([
  { path: 'inputs/</upload_file>x|y.txt', name: '</upload_file>x|y.txt', sizeBytes: 7, ext: 'txt' },
]);
assert.ok(!trickyManifest.includes('</upload_file>x'), '文件名里的标签边界被转义，信封不可被文件名提前闭合');
assert.match(trickyManifest, /&lt;\/upload_file&gt;x\\\|y\.txt/, '尖括号转义为实体、竖线转义为 \\|');
assert.equal(
  (trickyManifest.match(/^\|/gm) ?? []).length,
  3,
  '转义后仍是表头 + 分隔行 + 一行数据的完整表格',
);

// ==================== 6. 固定提示词分区 ====================

assert.match(FILE_UTIL_SYSTEM_PROMPT_SECTION, /<workspace-file-guidelines>/, '分区使用独立 XML 标签');
assert.match(FILE_UTIL_SYSTEM_PROMPT_SECTION, /3000/, '分区声明分页字符数');
assert.match(FILE_UTIL_SYSTEM_PROMPT_SECTION, /禁止/, '分区含读取纪律硬约束');
assert.match(FILE_UTIL_SYSTEM_PROMPT_SECTION, /原始文件数据/, '分区声明数据边界');
assert.match(FILE_UTIL_SYSTEM_PROMPT_SECTION, /<upload_file>/, '分区指向上传文件清单');
assert.match(FILE_UTIL_SYSTEM_PROMPT_SECTION, /copy/, '分区声明任意类型副本能力');
assert.match(FILE_UTIL_SYSTEM_PROMPT_SECTION, /grep/, '分区声明内容正则搜索能力');
assert.match(FILE_UTIL_SYSTEM_PROMPT_SECTION, /search/, '分区声明路径递归搜索能力');
assert.match(FILE_UTIL_SYSTEM_PROMPT_SECTION, /list/, '分区声明目录盘点能力');
assert.match(FILE_UTIL_SYSTEM_PROMPT_SECTION, /仅限文本文件|仅支持文本文件|文本文件/, '分区声明文本写边界');

// 工具描述必须与实现一致：显式声明文本写 / Office 读 / copy 豁免
const schemaText = JSON.stringify(fileUtilTool.openaiSchema);
assert.match(schemaText, /只能创建\/编辑\/删除\*\*文本文件\*\*/, 'schema 明确文本写边界');
assert.match(schemaText, /xlsx\/docx\/pptx/, 'schema 明确 Office 读取范围');
assert.match(schemaText, /复制任意类型文件/, 'schema 明确 copy 不受类型限制');
assert.match(schemaText, /results\//, 'schema 说明 results/ 目录约束');
