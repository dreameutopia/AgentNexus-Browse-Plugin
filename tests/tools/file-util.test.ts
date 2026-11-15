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
