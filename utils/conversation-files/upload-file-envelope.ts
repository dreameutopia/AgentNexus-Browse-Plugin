/**
 * upload_file 信封装配（纯函数，无 IO）
 *
 * 把本轮新注册的上传文件装配为 <upload_file> XML 信封，拼入发给模型的
 * 本轮用户消息（经 runtime.attachmentPrompt 通道；不落转录——转录只存
 * 摘要标记）。信封结构：
 *
 *   <upload_file>
 *   <file>
 *     <file_id>ab12cd34</file_id>
 *     <file_name>report.xlsx</file_name>
 *     <file_type>xlsx</file_type>
 *     <file_content>{第 1 页正文}</file_content>
 *     <current_page>1</current_page>
 *     <total_page>37</total_page>
 *   </file>
 *   ...
 *   </upload_file>
 *
 * 上下文预算（首轮不被盲目挤爆的关键防线）：
 *   - 信封只内联每个文件的**第 1 页**（≤ FILE_PAGE_TOKEN_BUDGET token），
 *     全文留在会话文件库，模型按需 read_file 分页续读；
 *   - 全部第 1 页的 token 合计超过预算（阈值 × ENVELOPE_PREVIEW_BUDGET_RATIO）
 *     时，从超出者开始不再内联正文，改为省略标记 + 读取指引——元信息
 *     （file_id / 名称 / 总页数）恒保留，模型永远知道「有哪些文件」，
 *     只是首屏不预载全部正文。
 *
 * 确定性：第 1 页正文来自与 read_file 同一实现（skill-pagination），
 * 信封内 <file_content> 与 read_file(file_id, page=1) 逐字一致。
 */

import { estimateTextTokens } from '@/entrypoints/sidepanel/utils/ai/token-estimate';
import { escapeXmlText } from '@/entrypoints/sidepanel/utils/xml-entities';

/** 信封内第 1 页预览合计的 token 预算占上下文阈值的比例（20%） */
export const ENVELOPE_PREVIEW_BUDGET_RATIO = 0.2;

/** 信封单个文件条目的装配入参（正文第 1 页已由调用方现算） */
export interface UploadFileEnvelopeEntry {
  /** 8 位文件短 id（注册产物） */
  id: string;
  /** 原始文件名 */
  name: string;
  /** 小写扩展名（file_type 的值） */
  ext: string;
  /** 提取形态：plain = 纯文本；office = OOXML 解析产物 */
  source: 'plain' | 'office';
  /** 全文总页数 */
  totalPages: number;
  /** 第 1 页正文（与 read_file page=1 同源同文） */
  page1: string;
}

/** 预算耗尽时 file_content 的省略标记（模型可据此直接改调 read_file） */
function omittedContentMarker(entry: UploadFileEnvelopeEntry): string {
  return (
    `[首屏未预载：本轮附件较多，为保护上下文预算未内联此文件正文。` +
    `调用 read_file(file_id="${entry.id}", page=1) 即可读取。]`
  );
}

/**
 * 装配 <upload_file> 信封。
 *
 * @param entries 本轮注册文件（按上传顺序；顺序即信封顺序）
 * @param contextThreshold 当前生效模型的上下文 token 阈值（装配侧传入
 *   runtime 同源的模型级阈值；非法值按 0 处理 = 全部省略正文，只剩元信息）
 * @returns 信封字符串；entries 为空时返回空串（调用方据此跳过拼接）
 */
export function buildUploadFileEnvelope(
  entries: readonly UploadFileEnvelopeEntry[],
  contextThreshold: number,
): string {
  if (entries.length === 0) return '';

  const safeThreshold =
    Number.isFinite(contextThreshold) && contextThreshold > 0 ? contextThreshold : 0;
  let remainingBudget = Math.floor(safeThreshold * ENVELOPE_PREVIEW_BUDGET_RATIO);

  const blocks = entries.map(entry => {
    // 元信息恒内联；正文按剩余预算决定内联或省略标记
    let content: string;
    if (remainingBudget > 0 && entry.page1.trim() !== '') {
      const cost = estimateTextTokens(entry.page1);
      if (cost <= remainingBudget) {
        remainingBudget -= cost;
        content = entry.page1;
      } else {
        // 累计已超预算（含单页即超尽的极端小阈值）：省略正文，保留读取指引
        remainingBudget = 0;
        content = omittedContentMarker(entry);
      }
    } else {
      content = entry.page1.trim() === '' ? '（空文件）' : omittedContentMarker(entry);
    }

    return (
      '<file>\n' +
      `<file_id>${entry.id}</file_id>\n` +
      `<file_name>${escapeXmlText(entry.name)}</file_name>\n` +
      `<file_type>${escapeXmlText(entry.ext || entry.source)}</file_type>\n` +
      `<file_content>\n${content}\n</file_content>\n` +
      '<current_page>1</current_page>\n' +
      `<total_page>${entry.totalPages}</total_page>\n` +
      '</file>'
    );
  });

  return `<upload_file>\n${blocks.join('\n')}\n</upload_file>`;
}
