/**
 * 网页剪藏转换层（采集端 → 统一笔记）
 *
 * 采集链路（content.ts）产出的是 Markdown 正文 + 已下载为 base64 的图片数组，
 * 本模块把它转换为统一笔记实体（utils/notes-database 的 CreateNoteInput）：
 * - Markdown → Tiptap 可解析的 HTML（markdown-it，默认关闭原始 HTML 注入）；
 * - 图片占位符 [[IMG:base64(src)|alt]] → <img src="data:..."> 内嵌到正文原位
 *   （与采集端 utils/html-to-markdown.ts 的 makeImageMarker 协议一致）；
 * - 按来源网址自动派生分类（已知站点映射为友好名称，其余取主域名）。
 */

import MarkdownIt from 'markdown-it';
import { CATEGORY_INBOX, type CreateNoteInput } from './notes-database';

/** 采集端产出的页面内容 */
export interface WebCapture {
  title: string;
  url: string;
  favicon?: string;
  /** 采集端 htmlToMarkdown 生成的 Markdown（含 [[IMG:...|alt]] 占位符） */
  markdown: string;
  /** 文本中出现的图片（已由采集端下载为 base64 dataUrl） */
  images: Array<{ src: string; alt?: string; dataUrl?: string }>;
}

// ──── 站点分类 ────

/** 已知站点 → 友好分类名（站点专有名词不随界面语言变化） */
const SITE_CATEGORY_MAP: Array<{ match: RegExp; name: string }> = [
  { match: /(^|\.)zhihu\.com$/, name: '知乎' },
  { match: /(^|\.)github\.com$/, name: 'GitHub' },
  { match: /(^|\.)(xiaohongshu\.com|xhslink\.com)$/, name: '小红书' },
  { match: /(^|\.)bilibili\.com$/, name: 'B站' },
  { match: /(^|\.)csdn\.net$/, name: 'CSDN' },
  { match: /(^|\.)cnki\.net$/, name: '知网' },
  { match: /(^|\.)mooc\.cn$/, name: '中国大学MOOC' },
  { match: /(^|\.)(weixin|weibo)\.qq\.com$/, name: '微信公众号' },
  { match: /(^|\.)weibo\.com$/, name: '微博' },
  { match: /(^|\.)juejin\.cn$/, name: '掘金' },
  { match: /(^|\.)jianshu\.com$/, name: '简书' },
  { match: /(^|\.)douban\.com$/, name: '豆瓣' },
  { match: /(^|\.)wikipedia\.org$/, name: '维基百科' },
  { match: /(^|\.)stackoverflow\.com$/, name: 'Stack Overflow' },
  { match: /(^|\.)medium\.com$/, name: 'Medium' },
];

/**
 * 由来源网址派生分类：
 * - 已知站点映射为友好名称（知乎 / GitHub / B站 …）；
 * - 其余取去掉 www 前缀的主域名（example.com）；
 * - 非法网址回退到「未分类」。
 */
export function deriveSiteCategory(url: string): string {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return CATEGORY_INBOX;
  }

  const hit = SITE_CATEGORY_MAP.find((site) => site.match.test(hostname));
  if (hit) return hit.name;

  return hostname.replace(/^www\./, '') || CATEGORY_INBOX;
}

// ──── Markdown → HTML ────

/** 图片占位符（与采集端 makeImageMarker 协议一致） */
const IMAGE_MARKER_RE = /\[\[IMG:([^\]|]*)(?:\|([^\]]*))?\]\]/g;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 还原占位符中的原始 src。
 * 协议：btoa(encodeURIComponent(src))；btoa 失败的极端情况下占位符里
 * 存的是原始 src，同样按原样匹配。
 */
function decodeImageSrc(encoded: string): string {
  const normalized = encoded.replace(/\s+/g, '');
  let decoded: string | null = null;
  try {
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    decoded = atob(padded);
  } catch {
    try {
      decoded = atob(normalized);
    } catch {
      decoded = null;
    }
  }
  if (decoded === null) return encoded;

  // 仅当解码结果确为百分号编码形态时还原（encodeURIComponent 输出字符集）；
  // 结果本身是普通 URL 说明存的就是原始 src
  const looksPercentEncoded =
    /%[0-9A-Fa-f]{2}/.test(decoded) && /^[A-Za-z0-9\-_.!~*'()%]+$/.test(decoded);
  if (looksPercentEncoded) {
    try {
      return decodeURIComponent(decoded);
    } catch {
      // 百分号序列非法：按原样使用
    }
  }
  return decoded;
}

/** 按代码围栏切分，只对围栏外片段应用变换（防止正文替换污染代码块） */
function processOutsideFences(text: string, mapSegment: (segment: string) => string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  const buffer: string[] = [];
  let openFence: { char: string; length: number } | null = null;

  const flushBuffer = () => {
    if (!buffer.length) return;
    result.push(mapSegment(buffer.join('\n')));
    buffer.length = 0;
  };

  for (const line of lines) {
    const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
    if (match) {
      const marker = match[1];
      const char = marker[0];
      const rest = match[2];
      if (!openFence) {
        flushBuffer();
        openFence = { char, length: marker.length };
        result.push(line);
        continue;
      }
      // 闭合同长或更长围栏（信息串只允许出现在开启行，与 CommonMark 一致）
      if (char === openFence.char && marker.length >= openFence.length && !rest.trim()) {
        openFence = null;
        result.push(line);
        continue;
      }
    }
    if (openFence) {
      result.push(line);
    } else {
      buffer.push(line);
    }
  }
  flushBuffer();

  return result.join('\n');
}

/** 兜底修复未闭合的代码围栏（采集残页可能缺结尾围栏） */
function repairUnbalancedFences(text: string): string {
  let openFence: { char: string; length: number } | null = null;

  for (const line of text.split('\n')) {
    const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) continue;
    const marker = match[1];
    const char = marker[0];
    const rest = match[2];
    if (!openFence) {
      openFence = { char, length: marker.length };
    } else if (char === openFence.char && marker.length >= openFence.length && !rest.trim()) {
      openFence = null;
    }
  }

  return openFence ? `${text}\n${openFence.char.repeat(openFence.length)}` : text;
}

const md = new MarkdownIt({
  html: false, // 不解析原始 HTML，内容全部转义，杜绝注入
  linkify: true,
  typographer: false,
  breaks: false,
});

/**
 * 采集 Markdown → Tiptap HTML 正文。
 * 图片占位符先替换为独立 token（避免进入 Markdown 解析），
 * 渲染完成后替换为内嵌 <img>（优先使用已下载的 base64 dataUrl）。
 */
export function captureMarkdownToHtml(markdown: string, images: WebCapture['images']): string {
  if (!markdown?.trim()) return '';

  // 建立「编码 key → 图片数据」映射（key 与 makeImageMarker 编码协议一致）
  const imageMap = new Map<string, { src: string; alt?: string; dataUrl?: string }>();
  for (const img of images || []) {
    const keys = new Set<string>([img.src]);
    try {
      keys.add(btoa(encodeURIComponent(img.src)));
    } catch {
      // btoa 失败：仅按原始 src 匹配
    }
    for (const key of keys) {
      imageMap.set(key, { src: img.src, alt: img.alt, dataUrl: img.dataUrl });
    }
  }

  const tokens: string[] = [];
  const prepared = processOutsideFences(markdown, (segment) =>
    segment.replace(IMAGE_MARKER_RE, (match, encoded: string, alt: string) => {
      const key = encoded.trim();
      const imageData = imageMap.get(key);
      const src = imageData?.dataUrl || decodeImageSrc(key);
      if (!src || src.startsWith('data:image/svg')) return '';
      const token = `AGENTNEXUSIMG${tokens.length}TOKEN`;
      const altAttr = escapeHtml((alt || imageData?.alt || '').trim());
      tokens.push(`<img src="${escapeHtml(src)}"${altAttr ? ` alt="${altAttr}"` : ''}>`);
      return `\n\n${token}\n\n`;
    }),
  );

  let html: string;
  try {
    html = md.render(repairUnbalancedFences(prepared));
  } catch (error) {
    console.error('[WebClip] Markdown 渲染失败，跳过正文:', error);
    return '';
  }

  // 恢复图片节点：优先替换段落包裹的 token，再处理行内残留
  tokens.forEach((tokenHtml, index) => {
    const token = `AGENTNEXUSIMG${index}TOKEN`;
    html = html.replace(`<p>${token}</p>`, () => tokenHtml);
    html = html.split(token).join(tokenHtml);
  });

  return html.trim();
}

// ──── 采集结果 → 统一笔记 ────

/**
 * 把采集端产出的页面内容转换为统一笔记实体输入。
 * 分类按来源站点自动派生；剪藏默认不带标签（可在笔记页补充）。
 */
export function webCaptureToNoteInput(capture: WebCapture): CreateNoteInput {
  return {
    kind: 'webpage',
    title: capture.title?.trim() || capture.url || '未命名页面',
    content: captureMarkdownToHtml(capture.markdown, capture.images),
    category: deriveSiteCategory(capture.url),
    tags: [],
    source: {
      url: capture.url,
      ...(capture.favicon ? { favicon: capture.favicon } : {}),
    },
  };
}
