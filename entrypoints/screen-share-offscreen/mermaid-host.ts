/**
 * Mermaid 离屏渲染消息处理
 *
 * 响应 mermaid_renderer 工具的渲染请求（协议见 tools/code/mermaid-protocol.ts）：
 * mermaid 源码 → SVG → PNG dataURL。
 *
 * ==================== 渲染管线与防御点 ====================
 *
 * 1. **库懒加载 + 失败可重试**：mermaid（约 1MB+）只在首个请求到达时动态
 *    import；失败不缓存 rejection，后续请求自动重试。
 * 2. **htmlLabels 全量关闭**：mermaid 默认用 <foreignObject> 承载 HTML 标签，
 *    Chrome 的 SVG→Canvas 光栅化不渲染 foreignObject（产出空白区域），
 *    这是旧实现导出空白的根因之一；全部图表类型关闭后均走纯 SVG <text>。
 * 3. **useMaxWidth 全量关闭**：SVG 输出绝对像素宽高，杜绝 100% 宽度在
 *    离屏环境（无布局视口）下测得 0 的问题。
 * 4. **挂载后测量**：SVG 必须先挂载到 offscreen body 才能 getBBox/
 *    getBoundingClientRect（旧实现在游离节点上测量，恒得 0 后回退硬编码
 *    800×600，导致裁剪）。
 * 5. **画布硬限制守卫**：Chrome Canvas 单边 ≤16384px、总面积约 268MP；
 *    超限图按 SIZE_LIMIT 拒绝而非产出损坏图片；2x 导出倍率在超限时自动降档。
 * 6. **资源全回收**：临时挂载节点、blob URL 在 finally 中清理；mermaid
 *    出错残留的临时测量容器同样防御性移除。
 */

import {
  MermaidOffscreenMsgType,
  MERMAID_EXPORT_SCALE,
  MERMAID_MAX_CANVAS_AREA,
  MERMAID_MAX_CANVAS_EDGE,
  type MermaidRenderRequest,
  type MermaidRenderResponse,
} from '@/tools/code/mermaid-protocol';

/** 渲染序列号（mermaid.render 需要全局唯一 id） */
let renderSeq = 0;

/** SVG 位图解码超时：Image 加载 blob URL 挂起时的兜底 */
const IMAGE_DECODE_TIMEOUT_MS = 15_000;

// ==================== mermaid 懒加载 ====================

type MermaidModule = typeof import('mermaid')['default'];

let mermaidInitPromise: Promise<MermaidModule> | null = null;

function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidInitPromise) {
    mermaidInitPromise = (async () => {
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        htmlLabels: false,
        secure: [...new Set([...(mermaid.mermaidAPI.defaultConfig.secure ?? []), 'htmlLabels'])],
        theme: 'default',
        fontFamily: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
        // PNG 导出关键配置（见文件头「渲染管线与防御点」2/3 条）：
        // htmlLabels 关闭 → 无 foreignObject（Canvas 光栅化兼容）；
        // useMaxWidth 关闭 → SVG 自带绝对像素宽高（离屏环境可测量）
        flowchart: { useMaxWidth: false },
        class: { useMaxWidth: false },
        // state 图类型无 htmlLabels 配置项（mermaid 状态图不走 HTML 标签），只关 useMaxWidth
        state: { useMaxWidth: false },
        sequence: { useMaxWidth: false },
        gantt: { useMaxWidth: false },
        er: { useMaxWidth: false },
        pie: { useMaxWidth: false },
        journey: { useMaxWidth: false },
        mindmap: { useMaxWidth: false },
        timeline: { useMaxWidth: false },
        gitGraph: { useMaxWidth: false },
      });
      return mermaid;
    })();
    // 初始化失败不缓存 rejection：下次请求自动重试
    mermaidInitPromise.catch(() => {
      mermaidInitPromise = null;
    });
  }
  return mermaidInitPromise;
}

// ==================== 工具函数 ====================

/** 从未知错误中提取可读文本（截断，供响应 detail 字段） */
function extractErrorDetail(error: unknown, maxLength = 600): string {
  let text: string;
  if (error instanceof Error && error.message) {
    text = error.message;
  } else if (typeof error === 'string') {
    text = error;
  } else {
    try {
      text = JSON.stringify(error) ?? String(error);
    } catch {
      text = String(error);
    }
  }
  return text.slice(0, maxLength);
}

/** 解析 SVG 元素上的像素数值属性（如 width="812.5"），非法/百分比返回 null */
function parsePixelAttribute(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

/** 清理 mermaid.render 出错时可能残留在 body 的临时测量容器 */
function cleanupMermaidTempNodes(id: string): void {
  document.getElementById(id)?.remove();
  document.getElementById(`d${id}`)?.remove();
}

/** 加载位图（blob URL → HTMLImageElement），带解码超时守卫 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => {
      img.src = '';
      reject(new Error(`SVG 位图解码超时（${IMAGE_DECODE_TIMEOUT_MS / 1000} 秒）`));
    }, IMAGE_DECODE_TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error('SVG 位图解码失败（SVG 内容含无法光栅化的元素）'));
    };
    img.src = url;
  });
}

// ==================== 渲染管线 ====================

/**
 * 计算导出尺寸与倍率：
 * 1. 优先取 SVG 自带像素宽高（useMaxWidth:false 保证存在）；
 * 2. 缺失时回退挂载后的 BBox / 布局矩形测量；
 * 3. 应用画布硬限制（单边 & 总面积），必要时自动降档倍率。
 */
function resolveExportSize(svgEl: SVGSVGElement): { width: number; height: number; scale: number } {
  let width = parsePixelAttribute(svgEl.getAttribute('width'));
  let height = parsePixelAttribute(svgEl.getAttribute('height'));

  if (width === null || height === null) {
    // 挂载后的真实几何测量（SVG 已在文档流中，见 renderToPng）
    const box = svgEl.getBoundingClientRect();
    const bbox = svgEl.getBBox();
    width = width ?? Math.ceil(box.width || bbox.width + Math.abs(bbox.x) * 2);
    height = height ?? Math.ceil(box.height || bbox.height + Math.abs(bbox.y) * 2);
  }

  // 下限守卫：异常测量结果至少 1px，避免 0 尺寸 canvas
  width = Math.max(1, Math.ceil(width));
  height = Math.max(1, Math.ceil(height));

  if (width > MERMAID_MAX_CANVAS_EDGE || height > MERMAID_MAX_CANVAS_EDGE) {
    throw Object.assign(
      new Error(
        `图表尺寸 ${width}×${height}px 超出画布单边上限 ${MERMAID_MAX_CANVAS_EDGE}px，` +
          '请精简图表（拆分节点/缩短标签）后重试',
      ),
      { code: 'SIZE_LIMIT' as const },
    );
  }

  // 2x 高清导出；总面积超限则自动降档至 1x，仍超限则拒绝
  let scale = MERMAID_EXPORT_SCALE;
  if (width * height * scale * scale > MERMAID_MAX_CANVAS_AREA) scale = 1;
  if (width * height * scale * scale > MERMAID_MAX_CANVAS_AREA) {
    throw Object.assign(
      new Error(
        `图表面积 ${width}×${height}px 超出画布总面积上限（约 2.56 亿像素），请精简图表后重试`,
      ),
      { code: 'SIZE_LIMIT' as const },
    );
  }

  return { width, height, scale };
}

/** 端到端渲染：源码 → SVG → 挂载测量 → PNG dataURL（成功/失败均以响应联合类型返回） */
async function renderToPng(code: string): Promise<MermaidRenderResponse> {
  const startedAt = Date.now();
  const mermaid = await loadMermaid();

  // ── 1. 源码 → SVG ──
  const id = `an-offscreen-mermaid-${Date.now()}-${++renderSeq}`;
  let svg = '';
  try {
    ({ svg } = await mermaid.render(id, code));
  } catch (error) {
    return {
      ok: false,
      code: 'PARSE_ERROR',
      message: 'Mermaid 源码语法解析失败，请检查图表语法',
      detail: extractErrorDetail(error),
    };
  } finally {
    cleanupMermaidTempNodes(id);
  }
  if (!svg || !svg.trim()) {
    return { ok: false, code: 'EMPTY_SVG', message: 'Mermaid 渲染返回了空 SVG' };
  }

  // ── 2. 挂载测量（必须先入文档流，否则几何 API 返回 0）──
  const holder = document.createElement('div');
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;visibility:hidden;pointer-events:none;';
  holder.innerHTML = svg;
  document.body.appendChild(holder);

  let blobUrl: string | null = null;
  try {
    const svgEl = holder.querySelector('svg');
    if (!svgEl) {
      return { ok: false, code: 'EMPTY_SVG', message: '渲染产物中未找到 <svg> 元素' };
    }

    let size: { width: number; height: number; scale: number };
    try {
      size = resolveExportSize(svgEl);
    } catch (error) {
      const detail = extractErrorDetail(error);
      return error instanceof Error && (error as Error & { code?: string }).code === 'SIZE_LIMIT'
        ? { ok: false, code: 'SIZE_LIMIT', message: error.message, detail }
        : { ok: false, code: 'INTERNAL_ERROR', message: '图表尺寸测量失败', detail };
    }

    // 序列化前写入绝对像素尺寸，保证位图光栅化按目标分辨率执行
    svgEl.setAttribute('width', String(size.width));
    svgEl.setAttribute('height', String(size.height));
    svgEl.style.maxWidth = 'none';

    // ── 3. SVG → 位图 → PNG ──
    const xml = new XMLSerializer().serializeToString(svgEl);
    blobUrl = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
    const img = await loadImage(blobUrl);

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(size.width * size.scale);
    canvas.height = Math.round(size.height * size.scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { ok: false, code: 'CONVERT_ERROR', message: 'Canvas 2D 上下文不可用' };
    }

    // 白底填充：SVG 透明背景直接转 PNG 会得到透明图，暗色查看器下不可读
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL('image/png');
    if (!dataUrl.startsWith('data:image/png')) {
      return { ok: false, code: 'CONVERT_ERROR', message: 'PNG 编码失败（画布可能被污染）' };
    }

    return {
      ok: true,
      dataUrl,
      width: canvas.width,
      height: canvas.height,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    // 位图解码 / 序列化等未预期失败
    return {
      ok: false,
      code: 'CONVERT_ERROR',
      message: error instanceof DOMException && error.name === 'SecurityError'
        ? '图表包含浏览器无法导出为 PNG 的内容，请改用纯文本标签或内置图形'
        : 'SVG → PNG 转换失败',
      detail: extractErrorDetail(error),
    };
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    holder.remove();
  }
}

// ==================== 消息入口 ====================

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const request = msg as Partial<MermaidRenderRequest> | undefined;
  if (request?.type !== MermaidOffscreenMsgType.RENDER) return false;

  if (typeof request.code !== 'string' || !request.code.trim()) {
    sendResponse({ ok: false, code: 'PARSE_ERROR', message: 'Mermaid 源码为空' });
    return false;
  }

  void renderToPng(request.code)
    .then(sendResponse)
    .catch((error: unknown) => {
      // renderToPng 内部已结构化捕获一切预期错误，这里是最终防线
      console.error('[MermaidOffscreen] 未预期渲染异常:', error);
      sendResponse({
        ok: false,
        code: 'INTERNAL_ERROR',
        message: '离屏渲染发生未预期异常',
        detail: extractErrorDetail(error),
      });
    });
  return true; // 异步 sendResponse
});
