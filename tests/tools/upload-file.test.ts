/**
 * 上传文件体系测试（read_file 工具契约 + 会话文件库 + 信封装配 + 压缩引擎纯函数）
 *
 * 覆盖四块：
 *   1. 会话文件库（file-store）：注册分配 8 位短 id、确定性分页、会话隔离、
 *      按会话级联删除、空正文 / 空 chatId 防御；
 *   2. read_file 契约：分页读取正文与信封第 1 页逐字一致、页眉/尾注、
 *      页码越界回显总页数、未知 id 回显可用清单、跨会话拒绝不泄漏内容、
 *      参数形态防御、无会话上下文拒绝；
 *   3. 信封装配（upload-file-envelope）：空入参、结构完整性（六字段 + 转义）、
 *      预算封顶（超出者省略正文但保留元信息与读取指引）；
 *   4. 压缩引擎纯函数（image-compressor）：GIF 动画判定（单帧/多帧/malformed）、
 *      头部尺寸读取（PNG/GIF/BMP）、整理触发矩阵（超体积 / BMP/ICO / 动画 /
 *      超边长 / 安全直传）。
 *
 * 运行：由 tools.test.ts 末尾动态引入（chrome 全局桩已就位；IndexedDB 由
 * fake-indexeddb 提供）。
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';

import { readFileTool, READ_FILE_TOOL_ID, UPLOAD_FILE_SYSTEM_PROMPT_SECTION } from '../../tools/upload-file/index';
import {
  conversationFileStore,
  FILE_ID_PATTERN,
  FILE_PAGE_TOKEN_BUDGET,
} from '../../utils/conversation-files/file-store';
import {
  buildUploadFileEnvelope,
  ENVELOPE_PREVIEW_BUDGET_RATIO,
  type UploadFileEnvelopeEntry,
} from '../../utils/conversation-files/upload-file-envelope';
import { paginateSkillText } from '../../utils/skills/skill-pagination';
import {
  generateShortId,
  isShortIdConstraintError,
  SHORT_ID_PATTERN,
} from '../../utils/shared/short-id';
import {
  imageNeedsPreparation,
  isAnimatedGif,
  readImageDimensions,
  IMAGE_COMPRESS_TARGET_BYTES,
} from '../../entrypoints/sidepanel/utils/chat/image-compressor';

/** 工具结果正文文本（content 可选；测试断言统一走此取值，兼容 strict 检查） */
const textOf = (r: { content?: Array<{ type: string; text?: string }> }): string =>
  r.content?.[0]?.text ?? '';

// ==================== 1. 会话文件库 ====================

const chatA = 'upload-file-chat-a';
const chatB = 'upload-file-chat-b';

// 构造跨多页的文本：CJK 按 ≈1 token/字计（页预算 3000 token → 每页约 3000 字）
const longText = `${'页'.repeat(9000)}tail-marker`;
const registered = await conversationFileStore.register(
  chatA,
  { name: 'sample.md', ext: 'md', source: 'plain', mimeType: 'text/markdown', sizeBytes: 1024 },
  longText,
);

assert.match(registered.id, FILE_ID_PATTERN, '注册分配 8 位短 id');
assert.ok(registered.id.length === 8, '短 id 恰为 8 位');
assert.ok(registered.totalPages > 1, '跨页文本页数 > 1');
assert.ok(registered.charCount > 0, '码点计数入档');

// 确定性：页数与 skill-pagination 直算一致（信封与工具同源的根基）
const direct = paginateSkillText(longText, 1, FILE_PAGE_TOKEN_BUDGET);
assert.ok(direct.ok && direct.page.pageCount === registered.totalPages, '页数与分页算法一致');

// 空正文 / 空 chatId 防御
await assert.rejects(
  () => conversationFileStore.register(chatA, { name: 'empty.txt', ext: 'txt', source: 'plain', mimeType: '', sizeBytes: 0 }, ''),
  /正文为空/,
);
await assert.rejects(
  () => conversationFileStore.register('', { name: 'x.txt', ext: 'txt', source: 'plain', mimeType: '', sizeBytes: 1 }, 'x'),
  /缺少会话标识/,
);

// 会话隔离（存储层兜底：他 会话的 id 也返回 null，正文不泄漏）
const chatBFile = await conversationFileStore.register(
  chatB,
  { name: 'other.md', ext: 'md', source: 'plain', mimeType: '', sizeBytes: 8 },
  '另一个会话的文件',
);
assert.equal(await conversationFileStore.readPage(chatA, 'zzzzzzzz', 1), null, '未知 id 返回 null');
assert.equal(
  await conversationFileStore.readPage(chatA, chatBFile.id, 1),
  null,
  '跨会话 id 在存储层即返回 null',
);
const listedA = await conversationFileStore.listByChat(chatA);
assert.equal(listedA.length, 1, '会话 A 只见自己的文件');
assert.equal(listedA[0].id, registered.id);

// 级联删除
const deleted = await conversationFileStore.deleteByChat(chatA);
assert.equal(deleted, 1, '按会话删除计数');
assert.equal(await conversationFileStore.get(registered.id), null, '删除后不可读');

// ==================== 2. read_file 契约 ====================

// 重注册（上一段已删）供工具契约测试使用
const file = await conversationFileStore.register(
  chatA,
  { name: 'report<data>.md', ext: 'md', source: 'office', mimeType: 'text/markdown', sizeBytes: 4096 },
  longText,
);

// 第 1 页：与信封预览逐字一致 + 页眉 + 未完提示
const r1 = await readFileTool.execute({ file_id: file.id }, { chatId: chatA });
assert.equal(r1.success, true, '读取第 1 页成功');
const page1 = paginateSkillText(longText, 1, FILE_PAGE_TOKEN_BUDGET);
assert.ok(page1.ok);
assert.ok(textOf(r1).includes(page1.page.content), '正文为分页算法的第 1 页');
assert.ok(textOf(r1).includes(`第 1/${file.totalPages} 页`), '页眉含页码与总页数');
assert.ok(textOf(r1).includes('下一页 page=2'), '未完页含续读指引');
assert.equal((r1.data as Record<string, unknown>).remainingChars, page1.page.remainingChars, 'data 含剩余字数');

// 最后一页：尾注为已到最后一页
const rLast = await readFileTool.execute({ file_id: file.id, page: file.totalPages }, { chatId: chatA });
assert.equal(rLast.success, true);
assert.ok(textOf(rLast).includes('已到最后一页'), '尾页尾注');

// 页码越界：回显总页数（自纠路径）
const rOver = await readFileTool.execute({ file_id: file.id, page: file.totalPages + 5 }, { chatId: chatA });
assert.equal(rOver.success, false);
assert.ok((rOver.error ?? '').includes(`共 ${file.totalPages} 页`), '越界错误回显总页数');

// 未知 id：回显当前会话可用清单（chatA 现有 file + 无 chatBFile）
const rUnknown = await readFileTool.execute({ file_id: 'aaaaaaaa' }, { chatId: chatA });
assert.equal(rUnknown.success, false);
assert.ok((rUnknown.error ?? '').includes(file.id), '未知 id 错误回显可用清单');

// 跨会话：拒绝且不泄漏正文
const rCross = await readFileTool.execute({ file_id: chatBFile.id }, { chatId: chatA });
assert.equal(rCross.success, false);
assert.ok((rCross.error ?? '').includes('跨会话'), '跨会话 id 明确拒绝');
assert.ok(!(rCross.error ?? '').includes('另一个会话的文件'), '错误不泄漏他 会话文件内容');

// file_id 形态防御（大小写归一 + 非法形态）
const rBad = await readFileTool.execute({ file_id: 'not-an-id!' }, { chatId: chatA });
assert.equal(rBad.success, false);
assert.ok((rBad.error ?? '').includes('8 位短 id'), '非法 file_id 给可读错误');

// 无会话上下文：拒绝（文件按会话隔离，无兜底）
const rNoChat = await readFileTool.execute({ file_id: file.id }, {});
assert.equal(rNoChat.success, false);
assert.ok((rNoChat.error ?? '').includes('会话上下文缺失'), '无 chatId 拒绝');

// 非对象 arguments：收敛为可读错误（不抛出击穿执行链）
const rBadArgs = await readFileTool.execute(['array'] as unknown, { chatId: chatA });
assert.equal(rBadArgs.success, false);
assert.ok((rBadArgs.error ?? '').includes('JSON 对象'), '数组 arguments 给可读错误');

// 工具 ID 与分区契约
assert.equal(READ_FILE_TOOL_ID, 'read_file');
assert.ok(UPLOAD_FILE_SYSTEM_PROMPT_SECTION.includes('uploaded-file-guidelines'), '分区使用独立 XML 标签');
assert.ok(UPLOAD_FILE_SYSTEM_PROMPT_SECTION.includes('禁止'), '分区含读取纪律硬约束');
assert.ok(readFileTool.metadata.noVisionRecapture === true, '纯读工具声明 noVisionRecapture');

// ==================== 3. 信封装配 ====================

const entry = (over: Partial<UploadFileEnvelopeEntry> = {}): UploadFileEnvelopeEntry => ({
  id: 'abcd1234',
  name: 'notes.txt',
  ext: 'txt',
  source: 'plain',
  totalPages: 7,
  page1: '第一页正文内容',
  ...over,
});

assert.equal(buildUploadFileEnvelope([], 256 * 1024), '', '空入参返回空串');

// 结构完整性：六字段 + 名称转义
const envelope = buildUploadFileEnvelope([entry({ name: 'a<b>&"c".txt' })], 256 * 1024);
assert.ok(envelope.startsWith('<upload_file>\n<file>\n'), '信封外壳与文件块');
assert.ok(envelope.includes('<file_id>abcd1234</file_id>'), 'file_id 字段');
assert.ok(envelope.includes('<file_name>a&lt;b&gt;&amp;&quot;c&quot;.txt</file_name>'), 'file_name XML 转义');
assert.ok(envelope.includes('<file_type>txt</file_type>'), 'file_type 字段');
assert.ok(envelope.includes('<file_content>\n第一页正文内容\n</file_content>'), 'file_content 内联第 1 页');
assert.ok(envelope.includes('<current_page>1</current_page>'), 'current_page 字段');
assert.ok(envelope.includes('<total_page>7</total_page>'), 'total_page 字段');

// 预算封顶：小阈值下首个文件即超 → 省略标记 + 读取指引；元信息保留
const tinyEnvelope = buildUploadFileEnvelope([entry()], 1); // 预算 = floor(0.2) = 0
assert.ok(tinyEnvelope.includes('read_file(file_id="abcd1234", page=1)'), '预算耗尽给读取指引');
assert.ok(tinyEnvelope.includes('<file_name>'), '预算耗尽仍保留元信息');

// 多文件：预算只够第一个时，后续文件省略、首个完整内联
const twoFiles = buildUploadFileEnvelope(
  [entry({ id: 'aaaa0001', page1: 'x'.repeat(100) }), entry({ id: 'bbbb0002', page1: 'y'.repeat(100) })],
  // 让预算恰好 ≥ 第一页（100 拉丁字符 ≈ 25 token）且 < 两页合计：阈值 200 → 预算 40
  200,
);
assert.ok(twoFiles.includes('x'.repeat(100)), '首个文件第 1 页完整内联');
assert.ok(!twoFiles.includes('y'.repeat(100)), '超预算文件不内联正文');
assert.ok(twoFiles.includes('<file_id>bbbb0002</file_id>'), '超预算文件元信息保留');
assert.ok(ENVELOPE_PREVIEW_BUDGET_RATIO === 0.2, '预览预算比例常量');

// ==================== 4. 压缩引擎纯函数 ====================

// 共享短 id 生成器（图片库 / 文件库共用唯一实现）
assert.match(generateShortId(), SHORT_ID_PATTERN, '生成的短 id 符合 8 位形态');
const idSet = new Set(Array.from({ length: 200 }, () => generateShortId()));
assert.equal(idSet.size, 200, '200 次生成无重复（随机性健全性）');
assert.equal(isShortIdConstraintError({ name: 'ConstraintError' }), true, '识别 DOMException ConstraintError');
assert.equal(isShortIdConstraintError(new Error('...ConstraintError...')), true, '按消息识别约束冲突');
assert.equal(isShortIdConstraintError(new Error('QuotaExceededError')), false, '其它错误不误判');
assert.equal(isShortIdConstraintError(null), false, '空值安全返回 false');

/** 构造 GIF 字节（header + LSD(flags 无 GCT) + N 个图像块 + trailer） */
function gifBytes(imageBlocks: number): Uint8Array {
  const bytes: number[] = [];
  for (const ch of 'GIF89a') bytes.push(ch.charCodeAt(0));
  bytes.push(4, 0, 4, 0, 0x70, 0, 0); // LSD 7 字节，flags=0x70（无全局颜色表）
  for (let i = 0; i < imageBlocks; i++) {
    bytes.push(0x2c); // Image Separator
    bytes.push(0, 0, 0, 0, 1, 0, 1, 0); // left/top/w/h
    bytes.push(0x00); // packed：无局部颜色表
    bytes.push(0x08); // LZW min code size
    bytes.push(0x02, 0xaa, 0xbb, 0x00); // 子块（2 字节数据）+ 终结符
  }
  bytes.push(0x3b); // Trailer
  return new Uint8Array(bytes);
}

assert.equal(isAnimatedGif(gifBytes(1)), false, '单帧 GIF 判定为静态');
assert.equal(isAnimatedGif(gifBytes(2)), true, '双帧 GIF 判定为动画');
assert.equal(isAnimatedGif(new Uint8Array([1, 2, 3])), false, '非 GIF 字节安全返回 false');

// PNG 尺寸：8 签名 + 4 长度 + 'IHDR' + w/h 各 4 字节大端
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  const dv = new DataView(bytes.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return bytes;
}

const dims = readImageDimensions(pngBytes(1920, 1080), 'png');
assert.deepEqual(dims, { width: 1920, height: 1080 }, 'PNG IHDR 尺寸读取');

// GIF 尺寸（LSD 像素宽高小端）
const gifDims = readImageDimensions(gifBytes(1), 'gif');
assert.deepEqual(gifDims, { width: 4, height: 4 }, 'GIF LSD 尺寸读取');

// BMP 尺寸（'BM' + DIB 宽高小端 @18/22）
const bmp = new Uint8Array(26);
bmp.set([0x42, 0x4d], 0);
const bdv = new DataView(bmp.buffer);
bdv.setUint32(18, 800, true);
bdv.setUint32(22, 600, true);
assert.deepEqual(readImageDimensions(bmp, 'bmp'), { width: 800, height: 600 }, 'BMP DIB 尺寸读取');
assert.equal(readImageDimensions(pngBytes(1, 1), 'jpg'), null, '扩展名与字节不符返回 null');

// 整理触发矩阵
assert.equal(imageNeedsPreparation('png', IMAGE_COMPRESS_TARGET_BYTES, { width: 100, height: 100 }, false), false, '小 PNG 直传');
assert.equal(imageNeedsPreparation('png', IMAGE_COMPRESS_TARGET_BYTES + 1, { width: 100, height: 100 }, false), true, '超 2MB 压缩');
assert.equal(imageNeedsPreparation('bmp', 1024, { width: 16, height: 16 }, false), true, 'BMP 需转码');
assert.equal(imageNeedsPreparation('ico', 1024, { width: 16, height: 16 }, false), true, 'ICO 需转码');
assert.equal(imageNeedsPreparation('gif', 1024, { width: 100, height: 100 }, true), true, '动画 GIF 需转静态');
assert.equal(imageNeedsPreparation('gif', 1024, { width: 100, height: 100 }, false), false, '静态 GIF 直传');
assert.equal(imageNeedsPreparation('png', 1024, { width: 8000, height: 100 }, false), true, '超边长需降采样');
assert.equal(imageNeedsPreparation('png', 1024, null, false), false, '尺寸未知时不触发尺寸分支');

// 清理（不影响后续其它测试）
await conversationFileStore.deleteByChat(chatA);
await conversationFileStore.deleteByChat(chatB);
