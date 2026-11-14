/**
 * Mermaid → SVG 渲染（供文档工具嵌入图表）
 *
 * ==================== 为什么复用离屏渲染 ====================
 *
 * 仓库已有两条 mermaid 渲染通道：
 * 1. `mermaid_renderer` 工具 → screen-share-offscreen 离屏页 → 输出 **PNG**
 *    （工具产物是 PNG，存进工作区给用户下载）。
 * 2. sidepanel 的 diagram-renderer → 直接在侧边栏 DOM 里 mermaid.render → SVG
 *    （聊天气泡里的图表）。
 *
 * 文档场景要的是 **SVG**：Word 2019+/LibreOffice 原生支持 SVG（矢量、可缩放），
 * PDF 里内联 SVG 同样是矢量；PNG 兜底则由 image-resolver 统一生成。
 *
 * 离屏通道（mermaid-protocol）只返回 PNG，不返回 SVG 原文；因此这里走
 * **动态 import + 本地 mermaid.render**，与 diagram-renderer 同源，
 * 但在文档工具的调用位置直接渲染 SVG。
 *
 * ==================== 降级策略 ====================
 *
 * 渲染失败（语法错误 / 库加载失败）一律返回 null，由 markdown-render
 * 把该围栏降级为代码块——源码不丢，用户可自行修正后再转换。
 */

/**
 * 画布单边像素上限（与离屏渲染通道的同名常量同值）。
 *
 * 这里刻意**不复用** tools/code/mermaid-protocol 的常量：引用它会让本模块
 * 与 background 共享模块图，Vite 随即把整个文档工具目录提升进 background
 * 主包（连带 docx/katex 等重依赖）。本地定义同一数值即可，切断这条耦合。
 */
const MERMAID_MAX_CANVAS_EDGE = 16_000;

/** mermaid 单例（懒加载；失败不缓存 rejection，下次自动重试） */
type MermaidModule = typeof import('mermaid')['default'];

let mermaidPromise: Promise<MermaidModule> | null = null;

/**
 * 加载并初始化 mermaid。
 * 配置与离屏渲染通道一致：htmlLabels 关闭（<foreignObject> 在部分环境
 * 无法栅格化）、useMaxWidth 关闭（SVG 自带绝对像素尺寸）。
 */
async function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidPromise) {
    mermaidPromise = (async () => {
      const mermaid = (await import('mermaid')).default;
      mermaid.initialize({
        startOnLoad: false,
        // strict：图表文本中的 HTML 标签被转义，防注入
        securityLevel: 'strict',
        htmlLabels: false,
        secure: [...(mermaid.mermaidAPI.defaultConfig.secure ?? []), 'htmlLabels'],
        theme: 'default',
        fontFamily: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
        flowchart: { useMaxWidth: false },
        class: { useMaxWidth: false },
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
    mermaidPromise.catch(() => {
      mermaidPromise = null;
    });
  }
  return mermaidPromise;
}

/** 渲染序列号（mermaid.render 需要全局唯一 id） */
let renderSeq = 0;

/**
 * 把 mermaid 源码渲染为 SVG 原文。
 *
 * @param code mermaid 源码
 * @returns SVG 原文；渲染失败返回 null（调用方降级为代码块）
 */
export async function renderMermaidToSvg(code: string): Promise<string | null> {
  if (typeof code !== 'string' || !code.trim()) return null;
  let mermaid: MermaidModule;
  try {
    mermaid = await loadMermaid();
  } catch {
    return null;
  }

  const id = `an-doc-mermaid-${Date.now()}-${++renderSeq}`;
  try {
    const { svg } = await mermaid.render(id, code);
    if (!svg || !svg.trim()) return null;
    // 尺寸护栏：超大图表在 Word/PDF 里会撑破版面，按上限拒绝
    const width = Number.parseFloat(/width="([\d.]+)/.exec(svg)?.[1] ?? '');
    const height = Number.parseFloat(/height="([\d.]+)/.exec(svg)?.[1] ?? '');
    if (Number.isFinite(width) && width > MERMAID_MAX_CANVAS_EDGE) return null;
    if (Number.isFinite(height) && height > MERMAID_MAX_CANVAS_EDGE) return null;
    return svg;
  } catch (error) {
    // 语法错误等：降级为代码块，源码由调用方保留
    console.warn('[document] mermaid 渲染失败:', error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    // mermaid.render 失败时可能在 body 残留临时测量容器
    cleanupTempNodes(id);
  }
}

/**
 * 清理 mermaid.render 出错时残留在 body 的临时测量容器
 */
function cleanupTempNodes(id: string): void {
  if (typeof document === 'undefined') return;
  document.getElementById(id)?.remove();
  document.getElementById(`d${id}`)?.remove();
}
