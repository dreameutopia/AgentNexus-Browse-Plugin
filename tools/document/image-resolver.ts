/**
 * 图片解析器：把 Markdown 里的图片地址解析为可内联的形态
 *
 * ==================== 支持的图片来源 ====================
 *
 * 1. **data URL**：`data:image/png;base64,...` 直嵌（模型手写内联图）。
 * 2. **远程 URL**：`https://…/chart.png`。抓取后转 data URL——
 *    DOCX 侧 docx/html 绝不联网，必须拿到内联数据才有图；
 *    PDF 侧虽可直取远程图，但统一内联可保证两份产物一致且离线可用。
 * 3. **工作区既有图片**：`outputs/report.png`、`inputs/photo.jpg` 等
 *    当前会话工作区里的图片（此前由其它工具产出或用户上传）。
 * 4. **会话图片库**：`agent-image:<8位短id>` 形式引用已存档的截图
 *    （与回答里的 `<agent-image id="…"/>` 短 id 体系一致）。
 * 5. **远程 SVG**：保留 SVG 原文（PDF 内联为矢量）并生成 PNG 兜底
 *    （旧版 Word 只认 PNG）。
 *
 * ==================== 格式归一（Word 只认五种） ====================
 *
 * docx/html 仅支持 PNG / JPEG / GIF / BMP / SVG，其余格式（WebP、AVIF、
 * TIFF、ICO…）会被整张丢弃。因此本模块按**字节魔数**（而不是服务端给的
 * Content-Type，那东西可以撒谎）判定真实格式：
 * - PNG/JPEG/GIF/BMP：原样内联；
 * - SVG：走矢量通道（SVG 原文 + PNG 兜底）；
 * - 其它：经 canvas 栅格化成 PNG（PDF 与 Word 看到同一张图）。
 *
 * ==================== 防御要点 ====================
 *
 * - **绝不 SSRF 到本地**：远程抓取只允许 http/https，且拒绝指向
 *   回环/内网/链路本地地址。除了常见的 `127.0.0.1`/`10.x`/`192.168.x`/
 *   `169.254.x`/`[::1]`，还必须堵住**数字变形写法**——`2130706433`（十进制）、
 *   `0177.0.0.1`（八进制）、`0x7f.0.0.1`（十六进制）、`127.1`（缩写）、
 *   `127.0.0.1.`（尾点）都能绕过朴素的字符串匹配，浏览器却会把它们解析成
 *   127.0.0.1。扩展有 <all_urls> 权限，不做这一步等于把内网暴露给模型驱动的抓取。
 * - **重定向不脱敏**：fetch 默认跟随跳转，落地页可能是内网地址，因此响应回来后
 *   再次校验最终 URL 的主机（DNS 重绑定这类无法在扩展内根治的场景在注释中说明）。
 * - **体积与超时上限**：单图 8MB、整体 24MB、单图超时 15 秒。响应体按流读取
 *   并在超限时立刻中断，坏服务器无法用超大响应撑爆内存。
 * - **MIME 嗅探**：只接受真实字节是图片的响应；非图片按不可用处理。
 * - **永不抛错**：任何失败都返回 null，由调用方降级并记录告警。
 */

import { chatDatabase } from '@/entrypoints/sidepanel/core/context/chat-database';
import { imageStore } from '@/entrypoints/sidepanel/core/images/image-store';
import type { ImageResolver, ResolvedImage } from './markdown-render';
import { rasterizeToPngDataUrl, svgToPngDataUrl } from './svg-raster';

/** 单图体积上限（字节） */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 单次转换的图片总体积上限（字节） */
export const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;
/** 单图抓取超时（毫秒） */
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
/** 会话图片库短 id 引用前缀 */
const AGENT_IMAGE_PREFIX = 'agent-image:';

/** 允许内联的 MIME 前缀 */
const ALLOWED_MIME_PREFIX = 'image/';

/** SVG 的 MIME */
const SVG_MIME = 'image/svg+xml';

/** Word / docx/html 能直接显示的位图格式 */
type RasterFormat = 'png' | 'jpeg' | 'gif' | 'bmp';

/** Word 能显示的全部格式（矢量图单独走 SVG 通道） */
type SupportedFormat = RasterFormat | 'svg';

/** 格式 → 落盘 MIME（DOCX 侧靠字节判定，但 PDF/Word 的 data URL 需要正确 MIME） */
const RASTER_MIME: Record<RasterFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

// ==================== 主机与 IP 判定（SSRF 防线） ====================

/**
 * 解析 IPv4 字面量 → 32 位无符号整数。
 *
 * 支持浏览器同样接受的多种写法（WHATWG URL 规范）：
 * - 四段点分：`127.0.0.1`
 * - 缩写：`127.1` = 127.0.0.1
 * - 单值十进制：`2130706433` = 127.0.0.1
 * - 八进制：`0177.0.0.1`
 * - 十六进制：`0x7f.0.0.1`
 *
 * @returns 解析出的 32 位值；不是合法 IPv4 字面量时返回 null
 */
export function parseIPv4(host: string): number | null {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    const value = parseIPv4Part(part);
    if (value === null) return null;
    values.push(value);
  }
  // 前 n-1 段必须是单字节；最后一段承载剩余位宽
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i] > 255) return null;
  }
  const last = values[values.length - 1];
  if (last >= 256 ** (5 - values.length)) return null;
  let value = last;
  for (let i = 0; i < values.length - 1; i++) {
    value += values[i] * 256 ** (3 - i);
  }
  return value >>> 0;
}

/** 解析 IPv4 的一段（十进制/八进制/十六进制） */
function parseIPv4Part(part: string): number | null {
  let value: number;
  if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
    value = Number.parseInt(part.slice(2), 16);
  } else if (/^0[0-7]+$/.test(part)) {
    value = Number.parseInt(part.slice(1), 8);
  } else if (/^[0-9]+$/.test(part)) {
    value = Number.parseInt(part, 10);
  } else {
    return null;
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 32 位 IP 值是否落在私网/保留/链路本地区间 */
function isPrivateIPv4Value(value: number): boolean {
  const a = (value >>> 24) & 255;
  const b = (value >>> 16) & 255;
  const c = (value >>> 8) & 255;
  if (a === 0 || a === 10 || a === 127) return true; // 本网/私网/回环
  if (a === 172 && b >= 16 && b <= 31) return true; // 私网 172.16/12
  if (a === 192 && b === 168) return true; // 私网 192.168/16
  if (a === 169 && b === 254) return true; // 链路本地（含云元数据 169.254.169.254）
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true; // 组播与保留
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试网段
  if (a === 192 && b === 0 && c === 0) return true; // IETF 协议保留
  if (a === 198 && b === 51 && c === 100) return true; // 文档用网段
  if (a === 203 && b === 0 && c === 113) return true; // 文档用网段
  return false;
}

/**
 * 判定主机是否为内网/回环地址（SSRF 防护）。
 *
 * 字面判定优先：解析失败一律按内网处理（宁可拒绝，不冒风险）。
 *
 * 已知残留风险（扩展内无法根治）：公网域名解析到内网 IP（DNS 重绑定）。
 * 扩展拿不到可靠的 DNS 结果，且没有可用的 DNS API（chrome.dns 仅限
 * ChromeOS）；这里的兜底是「跳转落地页再校验一次 + 抓取超时」，
 * 把暴露窗口压到最小，并在上面的注释里明示，不假装已经解决。
 */
export function isPrivateHost(hostname: string): boolean {
  let host = (hostname ?? '').trim().toLowerCase();
  if (!host) return true;
  // IPv6 字面量：整体拒绝（含 fc00::/7 私有段与 ::1）
  if (host.startsWith('[') || host.includes(':')) return true;
  // 去掉结尾的根点：127.0.0.1. 与 127.0.0.1 等价
  host = host.replace(/\.+$/, '');
  if (!host) return true;
  // localhost 与其常见别名
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  // 数字写法（十进制/八进制/十六进制/缩写）一律按 IPv4 解析
  const numeric = parseIPv4(host);
  if (numeric !== null) return isPrivateIPv4Value(numeric);
  // 常见的云元数据主机名
  if (host === 'metadata.google.internal' || host === 'metadata.goog' || host === 'instance-data') {
    return true;
  }
  // 非 IP 的域名：可能是内网别名，但扩展无法可靠区分内网 DNS，放行给 fetch
  return false;
}

// ==================== 字节工具 ====================

/** 字节 → base64（分块，避免超长参数栈溢出） */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ==================== 图片格式判定 ====================

/**
 * 按字节魔数判定图片格式（不信 Content-Type：它可以撒谎）。
 *
 * @returns 识别出的格式；不是已知图片格式时返回 null
 */
export function detectImageFormat(bytes: Uint8Array): SupportedFormat | 'webp' | 'avif' | null {
  if (bytes.length < 4) return null;
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  // GIF: "GIF8"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'gif';
  // BMP: "BM"
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
  // WebP: "RIFF"...."WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'webp';
  }
  // AVIF/HEIF: ....ftypavif
  if (bytes.length >= 12) {
    const brand = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    if (brand === 'ftyp') {
      const major = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
      if (major.startsWith('avif') || major.startsWith('avis')) return 'avif';
    }
  }
  // SVG: 文本，前若干字节里能找到 <svg
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, SVG_SNIFF_BYTES)).trim();
  if (head.startsWith('<svg') || head.includes('<svg')) return 'svg';
  return null;
}

/** SVG 嗅探窗口（前若干字节内必须能看到 <svg） */
const SVG_SNIFF_BYTES = 4096;

// ==================== 解析上下文 ====================

/**
 * 图片解析上下文
 */
export interface ImageResolverContext {
  /** 会话 id（读取工作区图片用） */
  chatId: string;
  /** 中止信号 */
  signal?: AbortSignal;
}

/**
 * 创建图片解析器。
 *
 * @param context 会话上下文（chatId 用于工作区图片与图片库）
 */
export function createImageResolver(context: ImageResolverContext): ImageResolver {
  const { chatId, signal } = context;
  /** 已消耗的总体积（字节） */
  let totalBytes = 0;
  /** 工作区快照（懒加载，多张图片共享一次读取） */
  let workspacePromise: Promise<Map<string, Blob>> | null = null;

  /** 记账：超出总体积上限返回 false */
  const account = (size: number): boolean => {
    if (size > MAX_IMAGE_BYTES) return false;
    totalBytes += size;
    return totalBytes <= MAX_TOTAL_IMAGE_BYTES;
  };

  const loadWorkspace = (): Promise<Map<string, Blob>> => {
    if (!workspacePromise) {
      workspacePromise = chatDatabase
        .readWorkspace(chatId, signal)
        .then((snapshot) => {
          const map = new Map<string, Blob>();
          for (const entry of snapshot?.entries ?? []) {
            if (entry.blob) map.set(entry.path, entry.blob);
          }
          return map;
        })
        .catch(() => new Map<string, Blob>());
    }
    return workspacePromise;
  };

  /**
   * 把已解码的字节变成可内联的形态：矢量走 SVG 通道，位图走 data URL，
   * Word 认不出的格式栅格化成 PNG。
   */
  const toResolved = async (src: string, bytes: Uint8Array, declaredMime: string): Promise<ResolvedImage | null> => {
    const format = detectImageFormat(bytes);
    if (!format) return null;

    if (format === 'svg') {
      const svg = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      if (!svg.trim()) return null;
      if (!account(bytes.byteLength)) return null;
      return { src, svg, pngDataUrl: (await svgToPngDataUrl(svg)) ?? undefined };
    }

    if (format === 'png' || format === 'jpeg' || format === 'gif' || format === 'bmp') {
      if (!account(bytes.byteLength)) return null;
      return { src, dataUrl: `data:${RASTER_MIME[format]};base64,${bytesToBase64(bytes)}` };
    }

    // WebP / AVIF 等：Word 不认，栅格化成 PNG（PDF 与 Word 保持一致）
    if (!account(bytes.byteLength)) return null;
    const sourceMime = declaredMime?.split(';')[0]?.trim() || `image/${format}`;
    const png = await rasterizeToPngDataUrl(bytes, sourceMime);
    if (!png) return null;
    return { src, dataUrl: png };
  };

  /**
   * 图片解析器实例。
   *
   * 用具名常量而非对象字面量的直接返回，是为了让「会话图片库 → data URL」
   * 这条回环路径可以安全地自我调用（resolver.resolve），不依赖调用方的
   * this 绑定（方法被解构传递时 this 会丢失）。
   */
  const resolver: ImageResolver = {
    async resolve(src: string): Promise<ResolvedImage | null> {
      const trimmed = src.trim();
      if (!trimmed) return null;

      // 1. data URL：直嵌
      if (trimmed.startsWith('data:')) {
        const comma = trimmed.indexOf(',');
        if (comma < 0) return null;
        const header = trimmed.slice(5, comma).toLowerCase();
        if (!header.startsWith(ALLOWED_MIME_PREFIX)) return null;
        if (trimmed.length > MAX_IMAGE_BYTES * 2) return null; // base64 膨胀
        const payload = trimmed.slice(comma + 1);
        const isBase64 = /;base64/i.test(header);
        let bytes: Uint8Array;
        try {
          const binary = isBase64 ? atob(payload) : decodeURIComponent(payload);
          bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        } catch {
          return null;
        }
        if (!bytes.byteLength) return null;
        return toResolved(src, bytes, header);
      }

      // 2. 会话图片库短 id
      if (trimmed.startsWith(AGENT_IMAGE_PREFIX)) {
        const shortId = trimmed.slice(AGENT_IMAGE_PREFIX.length).trim();
        if (!shortId) return null;
        const dataUrl = await imageStore.getDataUrlByShortId(shortId).catch(() => null);
        if (!dataUrl) return null;
        // 图片库里存的是 data URL，回到第 1 条通道处理，保证格式归一一致
        return resolver.resolve(dataUrl);
      }

      // 3. 工作区既有图片（相对路径）
      if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
        const workspace = await loadWorkspace();
        const blob = workspace.get(trimmed);
        if (!blob) return null;
        if (blob.size > MAX_IMAGE_BYTES) return null;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const mime = blob.type || '';
        if (mime && !mime.toLowerCase().startsWith(ALLOWED_MIME_PREFIX)) return null;
        return toResolved(src, bytes, mime);
      }

      // 4. 远程 URL
      if (!/^https?:\/\//i.test(trimmed)) return null;
      let url: URL;
      try {
        url = new URL(trimmed);
      } catch {
        return null;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      if (isPrivateHost(url.hostname)) return null;

      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), IMAGE_FETCH_TIMEOUT_MS);
      try {
        const requestSignal = combineSignals(signal, timeoutController.signal);
        const response = await fetch(url.toString(), {
          signal: requestSignal,
          credentials: 'omit',
          redirect: 'follow',
          cache: 'no-store',
        });
        if (!response.ok) return null;
        // 重定向落地页同样要过 SSRF 判定（fetch 会自动跟随跳转）
        if (response.url) {
          let finalUrl: URL | null = null;
          try {
            finalUrl = new URL(response.url);
          } catch {
            finalUrl = null;
          }
          if (!finalUrl || isPrivateHost(finalUrl.hostname)) return null;
        }
        const contentType = response.headers.get('content-type');
        if (contentType && !contentType.toLowerCase().startsWith(ALLOWED_MIME_PREFIX)) return null;
        // 先读 Content-Length 快速拒绝超大响应
        const declared = Number(response.headers.get('content-length') ?? '0');
        if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null;
        const bytes = await readBodyWithLimit(response, MAX_IMAGE_BYTES);
        if (!bytes || !bytes.byteLength) return null;
        return toResolved(src, bytes, contentType ?? '');
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };

  return resolver;
}

/**
 * 合并中止信号（外部取消 + 抓取超时）。
 *
 * 环境不支持 AbortSignal.any 时退化为「仅超时信号」——超时是最后一道防线，
 * 外部取消会因超时提前中止而丢失，但不会造成挂起。
 */
function combineSignals(external: AbortSignal | undefined, timeout: AbortSignal): AbortSignal {
  if (!external) return timeout;
  if (external.aborted) return external;
  if (typeof AbortSignal.any === 'function') {
    try {
      return AbortSignal.any([external, timeout]);
    } catch {
      // 落到下面的降级分支
    }
  }
  return timeout;
}

/**
 * 按流读取响应体，超过上限立刻中断。
 *
 * arrayBuffer() 会一次性把整个响应读进内存——恶意/异常服务器可以借此撑爆
 * 扩展进程。这里逐块累加并在越界时取消读取。
 */
async function readBodyWithLimit(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) return null;
    return new Uint8Array(buffer);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 释放失败不影响结果
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
