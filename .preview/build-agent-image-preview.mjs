/**
 * 回答内截图卡片 + 看图层遮罩预览页生成器。
 *
 * 为什么不用手写 HTML：卡片样式在 chat-message-list.css、看图层样式在
 * image-viewer.css 里，手抄一份必然与源码漂移。这里直接从源码抽出对应
 * 样式块，再从 zh-CN 语言包取真实文案拼出预览页——预览所见即源码所见。
 *
 * 产物：.preview/agent-image-card.html
 * 用法：node .preview/build-agent-image-preview.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const listCssPath = path.join(root, 'entrypoints/sidepanel/components/chat/chat-message-list.css');
const viewerCssPath = path.join(root, 'entrypoints/sidepanel/components/chat/image-viewer.css');
const localePath = path.join(root, 'utils/i18n/locales/zh-CN.ts');

const listCss = readFileSync(listCssPath, 'utf8');
const viewerCss = readFileSync(viewerCssPath, 'utf8');
const locale = readFileSync(localePath, 'utf8');

/** 从语言包取一个文案键（值为单引号字符串） */
function copy(key) {
  const matched = locale.match(new RegExp(`${key}:\\s*'([^']*)'`));
  if (!matched) throw new Error(`语言包缺少键：${key}`);
  return matched[1];
}

/** 抽 chat-message-list.css 里的截图卡片样式块（按注释分区分界） */
function cardCss() {
  const start = listCss.indexOf('/* ==================== 回答内截图引用');
  if (start < 0) throw new Error('chat-message-list.css 缺少回答内截图引用样式区');
  const end = listCss.indexOf('/* ====================', start + 10);
  return listCss.slice(start, end < 0 ? listCss.length : end);
}

/** 占位截图：内联 SVG（预览页不依赖任何外部资源） */
const placeholder = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540">
    <rect width="960" height="540" fill="#f2f1ee"/>
    <rect x="0" y="0" width="960" height="36" fill="#e4e2de"/>
    <circle cx="22" cy="18" r="6" fill="#c9c6c1"/>
    <circle cx="42" cy="18" r="6" fill="#c9c6c1"/>
    <circle cx="62" cy="18" r="6" fill="#c9c6c1"/>
    <rect x="92" y="9" width="300" height="18" rx="9" fill="#ffffff"/>
    <rect x="40" y="76" width="300" height="24" rx="6" fill="#d8d5d0"/>
    <rect x="40" y="120" width="200" height="14" rx="4" fill="#dedbd6"/>
    <rect x="40" y="152" width="240" height="14" rx="4" fill="#dedbd6"/>
    <rect x="40" y="200" width="360" height="220" rx="8" fill="#ffffff"/>
    <rect x="420" y="200" width="500" height="100" rx="8" fill="#ffffff"/>
    <rect x="420" y="320" width="500" height="100" rx="8" fill="#ffffff"/>
  </svg>`,
);
const src = `data:image/svg+xml;charset=utf-8,${placeholder}`;

const alt = 'agentnexus-assets 存储桶详情页，创建成功';

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>回答内截图卡片与看图层预览</title>
<link rel="stylesheet" href="../entrypoints/sidepanel/styles/global.css">
<link rel="stylesheet" href="../entrypoints/sidepanel/styles/app.css">
<style>
  /* 预览页仅用于视觉核对：复刻侧边栏列宽（380px） */
  body { margin: 0; padding: 24px; background: var(--bg-secondary, #f8fafc); }
  .preview-row { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
  .preview-col { background: var(--bg-primary, #fff); border: 1px solid var(--line-soft, #e4e2de); border-radius: 12px; padding: 12px; }
  .preview-col--narrow { width: 380px; }
  .preview-label { font-size: 11px; color: var(--ink-secondary, #787671); margin-bottom: 8px; }
  /* 预览页专用：真实实现是 fixed 覆盖整个侧边栏，这里收进展示框内便于并排核对 */
  .preview-stage { position: relative; width: 380px; height: 460px; border-radius: 10px; overflow: hidden; border: 1px solid var(--line-soft, #e4e2de); }
  .preview-stage .image-viewer { position: absolute; }
${cardCss()}
${viewerCss}
</style>
</head>
<body>
  <div class="preview-row">
    <div class="preview-col preview-col--narrow">
      <div class="preview-label">回答内截图卡片（底部不再显示短 id）</div>
      <div class="agent-image-card" data-agent-image-id="6zxtjw14" data-agent-image-alt="${alt}" data-agent-image-state="done">
        <div class="agent-image-body">
          <img src="${src}" alt="${alt}" title="${alt}">
        </div>
      </div>
    </div>

    <div class="preview-col preview-col--narrow">
      <div class="preview-label">点击后的看图层遮罩（缩小 / 放大 / 在网页中打开 / 下载）</div>
      <div class="preview-stage">
        <div class="image-viewer" role="dialog">
          <button type="button" class="viewer-close" title="关闭">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
            </svg>
          </button>
          <figure class="viewer-stage">
            <img class="viewer-img" src="${src}" alt="${alt}">
          </figure>
          <div class="viewer-toolbar">
            <button type="button" class="viewer-btn viewer-btn--zoom" title="${copy('imageZoomOut')}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M5,11H19V13H5V11Z" fill="currentColor"/>
              </svg>
              <span>${copy('imageZoomOut')}</span>
            </button>
            <button type="button" class="viewer-btn viewer-btn--zoom" title="${copy('imageZoomIn')}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M11,5H13V11H19V13H13V19H11V13H5V11H11V5Z" fill="currentColor"/>
              </svg>
              <span>${copy('imageZoomIn')}</span>
            </button>
            <button type="button" class="viewer-btn" title="${copy('imageOpenInBrowser')}">${copy('imageOpenInBrowser')}</button>
            <button type="button" class="viewer-btn" title="${copy('imageDownload')}">${copy('imageDownload')}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>
`;

const outPath = path.join(root, '.preview/agent-image-card.html');
writeFileSync(outPath, html, 'utf8');
console.log(`[build-agent-image-preview] 已生成 ${path.relative(root, outPath)}`);
