/**
 * 用户选中网页元素 → 模型上下文 XML
 *
 * 与 `<page_quote>` / `<upload_file>` 并列，统一由 composeUserMessageBody 注入。
 * 设计口径：
 *   - selector 为捕获时二次校验过的唯一选择器，frame_id 用于在 iframe 场景下定位；
 *   - description 为可读元素描述，note 为用户补充备注（可选）；
 *   - 仅注入定位与理解所需信息，不注入截图二进制。
 */

import { escapeXmlText } from '../xml-entities';
import {
  CAPTURED_ELEMENT_LIMIT,
  CAPTURED_ELEMENT_NOTE_MAX_CHARS,
  type CapturedElement,
  type CapturedElementKind,
} from '@/utils/element-capture/types';

const SELECTOR_MAX_CHARS = 2000;
const DESCRIPTION_MAX_CHARS = 500;
const PAGE_URL_MAX_CHARS = 2000;

const KNOWN_KINDS: ReadonlySet<string> = new Set<CapturedElementKind>([
  'text-input',
  'textarea',
  'password',
  'number',
  'email',
  'search',
  'tel',
  'url',
  'date',
  'time',
  'datetime',
  'color',
  'range',
  'file',
  'checkbox',
  'radio',
  'select',
  'button',
  'link',
  'image',
  'video',
  'audio',
  'table',
  'list',
  'form',
  'iframe',
  'canvas',
  'svg',
  'code',
  'heading',
  'paragraph',
  'container',
  'switch',
  'label',
  'other',
]);

function asTrimmedString(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

/** 归一化捕获元素列表（持久化 / 恢复草稿 / 模型注入共用同一实现） */
export function normalizeCapturedElements(value: unknown): CapturedElement[] {
  if (!Array.isArray(value)) return [];
  const result: CapturedElement[] = [];
  const seen = new Set<string>();

  for (const raw of value) {
    if (result.length >= CAPTURED_ELEMENT_LIMIT) break;
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<CapturedElement>;

    const selector = asTrimmedString(item.selector, SELECTOR_MAX_CHARS);
    if (!selector) continue;

    const shadowHosts = Array.isArray(item.shadowHosts)
      ? item.shadowHosts
          .filter((host): host is string => typeof host === 'string' && host.trim().length > 0)
          .slice(0, 20)
      : undefined;

    const frameId =
      typeof item.frameId === 'number' && Number.isFinite(item.frameId) && item.frameId >= 0
        ? Math.floor(item.frameId)
        : 0;

    const key = `${frameId}|${(shadowHosts || []).join('>')}|${selector}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const kind: CapturedElementKind = KNOWN_KINDS.has(String(item.kind))
      ? (item.kind as CapturedElementKind)
      : 'other';

    result.push({
      id: asTrimmedString(item.id, 120) || `element-${result.length + 1}`,
      selector,
      xpath: asTrimmedString(item.xpath, SELECTOR_MAX_CHARS) || undefined,
      shadowHosts: shadowHosts?.length ? shadowHosts : undefined,
      frameId,
      kind,
      tagName: asTrimmedString(item.tagName, 64) || 'element',
      description: asTrimmedString(item.description, DESCRIPTION_MAX_CHARS) || selector,
      note: asTrimmedString(item.note, CAPTURED_ELEMENT_NOTE_MAX_CHARS) || undefined,
      screenshotRef:
        typeof item.screenshotRef === 'string' && /^[0-9a-f]{32,64}$/.test(item.screenshotRef)
          ? item.screenshotRef
          : undefined,
      pageUrl: asTrimmedString(item.pageUrl, PAGE_URL_MAX_CHARS) || undefined,
      pageTitle: asTrimmedString(item.pageTitle, 200) || undefined,
      capturedAt:
        typeof item.capturedAt === 'number' && Number.isFinite(item.capturedAt)
          ? item.capturedAt
          : Date.now(),
    });
  }

  return result;
}

/** 收集捕获元素截图引用（用于消息图片引用索引 / 会话删除回收） */
export function capturedElementImageRefs(elements: readonly CapturedElement[]): string[] {
  const refs: string[] = [];
  for (const element of elements) {
    if (!element.screenshotRef) continue;
    if (refs.includes(element.screenshotRef)) continue;
    refs.push(element.screenshotRef);
  }
  return refs;
}

/** 生成注入用户消息的 `<selected_elements>` 信封；无元素时返回空串 */
export function buildSelectedElementsEnvelope(elements: readonly CapturedElement[]): string {
  const normalized = normalizeCapturedElements(elements);
  if (normalized.length === 0) return '';

  const lines: string[] = [
    `<selected_elements count="${normalized.length}" note="用户在网页中手动选取的元素；selector 为唯一选择器，frame_id 为标签页内 frame 标识。任务语义：用户指令中的「这个/这里面/这些」等指代无法仅凭文本唯一确定时，对照本信封理解所指对象；选取的元素也可能是用户为本轮划定的任务范围。本信封是范围信号而非范围裁决——用户指令的范围与本信封或技能流程的默认范围不一致、或范围仍不明确时，先向用户确认再执行，不得自行选定一种理解带猜执行。">`,
  ];

  normalized.forEach((element, index) => {
    const attrs: string[] = [
      `index="${index + 1}"`,
      `tag="${escapeXmlText(element.tagName)}"`,
      `type="${escapeXmlText(element.kind)}"`,
      `frame_id="${element.frameId}"`,
      `selector="${escapeXmlText(element.selector)}"`,
    ];
    if (element.xpath) attrs.push(`xpath="${escapeXmlText(element.xpath)}"`);
    if (element.shadowHosts?.length) {
      attrs.push(`shadow_hosts="${escapeXmlText(element.shadowHosts.join(' > '))}"`);
    }
    if (element.pageUrl) attrs.push(`page_url="${escapeXmlText(element.pageUrl)}"`);

    lines.push(`  <element ${attrs.join(' ')}>`);
    lines.push(`    <description>${escapeXmlText(element.description)}</description>`);
    if (element.note) {
      lines.push(`    <note>${escapeXmlText(element.note)}</note>`);
    }
    if (element.pageTitle) {
      lines.push(`    <page_title>${escapeXmlText(element.pageTitle)}</page_title>`);
    }
    lines.push('  </element>');
  });

  lines.push('</selected_elements>');
  return lines.join('\n');
}
