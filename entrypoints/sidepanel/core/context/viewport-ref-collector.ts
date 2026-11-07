/**
 * 历史视口截图引用提取（模型可见上下文的唯一截图保障 · 数据侧）
 *
 * 职责：从历史记录中取出「模型可见上下文里已存在的视口截图」的内容哈希，
 * 供运行期判重（见 viewport-image-dedup）使用。
 *
 * 口径与理由：
 *   - **视口全景截图**参与判重——它们的像素证据可互换，重复附图只多耗 token；
 *   - **用户上传图片**不参与——用户素材语义独立（即使内容恰好相同，
 *     也可能正是用户要模型看的素材，误去重会丢掉用户意图）；
 *   - **区域放大图**不参与——局部证据与全景不同，恒不复用。
 *
 * 识别方式（按可靠性从高到低）：
 *   1. 用户记录：上传子集（uploadImageRefs）之外的引用 = 引擎注入的视口截图。
 *      旧记录无该字段时，退回「协议引用形态」判定（见 protocolImageRefs）——
 *      用户上传图同样进协议引用，故无法区分，此时按「保守不判重」处理：
 *      宁可多附一张图，也不误删用户素材。
 *   2. 助手记录：imageRefs 全部来自 vision 循环的自动截图（用户上传不进
 *      助手记录），全部计入。
 *
 * 该模块只做纯数据提取，不触碰浏览器与模型。
 */

import type { ChatMessageRecord } from '../types';
import { normalizeImageRefs } from '../images/image-store';

/**
 * 提取历史记录中的视口截图引用（去重保序）。
 *
 * @param records 历史记录（任意顺序）
 * @returns 视口截图的内容哈希列表（ImageRef）
 */
export function collectPriorViewportRefs(records: readonly ChatMessageRecord[]): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const add = (ref: string | undefined) => {
    if (!ref || seen.has(ref)) return;
    seen.add(ref);
    refs.push(ref);
  };
  for (const record of records) {
    if (record.role === 'assistant') {
      // 助手记录的引用全部是 vision 自动截图（视口全景 + 区域放大图）。
      // 区域图一并计入是安全的：判重集合的语义是「模型上下文里已持有的
      // 像素证据」，命中即意味着模型已见过完全相同的字节——即便那是区域
      // 裁剪，也说明同像素的视口全景不必重复附图。反向（新区域图撞上
      // 旧视口图）由判重器的 kind 闸门拦下（区域图恒不参与去重）。
      for (const ref of normalizeImageRefs(record.imageRefs)) add(ref);
      continue;
    }
    // 用户记录：上传子集之外的是引擎注入的视口截图
    const uploads = record.uploadImageRefs;
    if (uploads === undefined) {
      // 旧记录无上传子集字段：无法区分用户上传与引擎注入的视口截图。
      // 保守处理——不计入（判重宁缺勿滥：多附一张图只是多耗 token，
      // 误去重会让模型丢掉用户明确提供的素材）。
      continue;
    }
    const uploadSet = new Set(normalizeImageRefs(uploads));
    for (const ref of normalizeImageRefs(record.imageRefs)) {
      if (!uploadSet.has(ref)) add(ref);
    }
  }
  return refs;
}
