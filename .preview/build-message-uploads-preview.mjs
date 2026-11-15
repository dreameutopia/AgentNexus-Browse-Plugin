/**
 * 消息内上传文件元素区预览页生成器。
 *
 * 为什么不用手写 HTML：元素样式在 message-uploads.css、文案在 zh-CN 语言包里，
 * 手抄一份必然与源码漂移。这里直接从源码取样式块与真实文案拼出预览页——
 * 预览所见即源码所见。
 *
 * 产物：.preview/message-uploads.html
 * 用法：node .preview/build-message-uploads-preview.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const cssPath = path.join(root, 'entrypoints/sidepanel/components/chat/message-uploads.css');
const localePath = path.join(root, 'utils/i18n/locales/zh-CN.ts');

const css = readFileSync(cssPath, 'utf8');
const locale = readFileSync(localePath, 'utf8');

/** 从语言包取一个文案键（值为单引号字符串） */
function copy(key) {
  const matched = locale.match(new RegExp(`${key}:\\s*'([^']*)'`));
  if (!matched) throw new Error(`语言包缺少键：${key}`);
  return matched[1];
}

/** 占位缩略图：内联 SVG（预览页不依赖任何外部资源） */
const thumb = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">
    <rect width="120" height="120" fill="#e8eaed"/>
    <path d="M18 84 L46 52 L66 74 L80 60 L102 84 Z" fill="#9aa4b2"/>
    <circle cx="42" cy="36" r="9" fill="#c3cad4"/>
  </svg>`,
);

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>上传文件元素区预览</title>
<link rel="stylesheet" href="../entrypoints/sidepanel/styles/global.css">
<link rel="stylesheet" href="../entrypoints/sidepanel/styles/app.css">
<style>
  /* 预览页仅用于视觉核对：复刻侧边栏列宽（380px） */
  body { margin: 0; padding: 24px; background: var(--bg-secondary, #f8fafc); }
  .preview-col { background: var(--bg-primary, #fff); border: 1px solid var(--line-soft, #e4e2de); border-radius: 12px; padding: 12px; width: 380px; }
  .preview-label { font-size: 11px; color: var(--ink-secondary, #787671); margin-bottom: 8px; }
  .preview-bubble { margin-bottom: 10px; padding: 8px 12px; border-radius: 12px; background: var(--surface-soft, #f3f1ed); font-size: 13px; line-height: 1.5; }
${css}
</style>
</head>
<body>
  <div class="preview-col">
    <div class="preview-label">用户消息气泡下方：全部上传文件元素</div>
    <div class="preview-bubble">帮我按照这个简历去投两个 ai agent 应用相关的实习生岗位</div>

    <div class="message-uploads">
      <div class="message-uploads-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M13,9V3.5L18.5,9H13Z" fill="currentColor"/>
        </svg>
        <span>${copy('uploadsLabel').replace('{count}', '4')}</span>
      </div>

      <ul class="message-uploads-list">
        <li class="upload-item">
          <button type="button" class="upload-thumb" title="${copy('imageOpenInBrowser')}">
            <img src="data:image/svg+xml;charset=utf-8,${thumb}" alt="简历照片.png" loading="lazy">
          </button>
          <span class="upload-info">
            <span class="upload-name" title="inputs/简历照片.png">简历照片.png</span>
            <span class="upload-size">248.6 KB</span>
          </span>
        </li>

        <li class="upload-item">
          <span class="upload-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M6 3h8l4 4v14H6z M14 3v5h4 M12 10v7m-3-3 3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
            </svg>
          </span>
          <span class="upload-info">
            <span class="upload-name" title="inputs/岗位说明.pdf">岗位说明.pdf</span>
            <span class="upload-size">1.2 MB</span>
          </span>
          <button type="button" class="upload-action" title="${copy('uploadOpenPreview')}">${copy('uploadOpenPreview')}</button>
        </li>

        <li class="upload-item">
          <span class="upload-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M6 3h8l4 4v14H6z M14 3v5h4 M12 10v7m-3-3 3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
            </svg>
          </span>
          <span class="upload-info">
            <span class="upload-name" title="inputs/投递清单.csv">投递清单.csv</span>
            <span class="upload-size">4.0 KB</span>
          </span>
          <button type="button" class="upload-action" title="${copy('uploadDownload')}">${copy('uploadDownload')}</button>
        </li>

        <li class="upload-item">
          <span class="upload-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M6 3h8l4 4v14H6z M14 3v5h4 M12 10v7m-3-3 3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
            </svg>
          </span>
          <span class="upload-info">
            <span class="upload-name" title="inputs/项目作品集.html">项目作品集.html</span>
            <span class="upload-size">18.7 KB</span>
          </span>
          <button type="button" class="upload-action" title="${copy('uploadOpenPreview')}">${copy('uploadOpenPreview')}</button>
        </li>
      </ul>
    </div>
  </div>
</body>
</html>
`;

const outPath = path.join(root, '.preview/message-uploads.html');
writeFileSync(outPath, html, 'utf8');
console.log(`[build-message-uploads-preview] 已生成 ${path.relative(root, outPath)}`);
