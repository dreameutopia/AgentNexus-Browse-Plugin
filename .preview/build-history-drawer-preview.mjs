/**
 * 历史会话抽屉预览页生成器（标签编辑 / 重命名视觉回归）。
 *
 * 为什么不用手写 HTML：样式在 chat-history-drawer.css、图标在组件模板、
 * 文案在语言包——任何一处手抄都会与源码漂移。这里全部从源码抽取：
 *   - 样式：chat-history-drawer.css 全文（组件 <style scoped> 只 @import 它）
 *   - 设计 token：styles/app.css 的 .app-container 自定义属性块
 *   - 图标：ChatHistoryDrawer.vue 模板里的 <svg>（按 data-tag-edit / rename 上下文定位）
 *   - 文案：utils/i18n/locales/zh-CN.ts 的真实键值
 * 标记结构镜像 ChatHistoryDrawer.vue 的类名（结构契约由
 * tests/chat-ui/history-drawer-tags.test.mjs 在真实组件上锁死）。
 *
 * 产物：.preview/history-drawer.html
 * 用法：node .preview/build-history-drawer-preview.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const cssPath = path.join(root, 'entrypoints/sidepanel/components/chat/chat-history-drawer.css');
const appCssPath = path.join(root, 'entrypoints/sidepanel/styles/app.css');
const sfcPath = path.join(root, 'entrypoints/sidepanel/components/chat/ChatHistoryDrawer.vue');
const localePath = path.join(root, 'utils/i18n/locales/zh-CN.ts');

const css = readFileSync(cssPath, 'utf8');
const appCss = readFileSync(appCssPath, 'utf8');
const sfc = readFileSync(sfcPath, 'utf8');
const locale = readFileSync(localePath, 'utf8');

/** 从语言包取一个文案键（zh-CN.ts 用单引号字符串） */
function copy(key) {
  const matched = locale.match(new RegExp(`${key}:\\s*['"]([^'"]*)['"]`));
  if (!matched) throw new Error(`语言包缺少键：${key}`);
  return matched[1];
}

/** 抽 .app-container 规则里的设计 token（--xxx: value; 声明） */
function designTokens() {
  const block = appCss.match(/\.app-container\s*\{([\s\S]*?)\}/);
  if (!block) throw new Error('app.css 缺少 .app-container 规则');
  const tokens = [...block[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => `  ${m[1]}: ${m[2]};`);
  if (!tokens.length) throw new Error('.app-container 内没有自定义属性');
  return tokens.join('\n');
}

/** 按定位锚点抽取组件模板里的一个 <svg>…</svg>（保证图标与源码同源） */
function svgNear(anchor, after = true) {
  const at = sfc.indexOf(anchor);
  if (at === -1) throw new Error(`模板中找不到锚点：${anchor}`);
  const scope = after ? sfc.slice(at, at + 900) : sfc.slice(Math.max(0, at - 900), at);
  const matched = scope.match(/<svg[\s\S]*?<\/svg>/);
  if (!matched) throw new Error(`锚点后未找到 svg：${anchor}`);
  return matched[0];
}

const svgTagEdit = svgNear('data-tag-edit');
const svgRename = svgNear('renameSession');
const svgDelete = svgNear("common.delete')");
const svgConfirm = svgNear('rename-confirm');
const svgCancel = svgNear('rename-cancel');
const svgAdd = svgNear('history-tag-editor-add');
const svgRemove = svgNear('history-tag-remove');
const svgClose = svgNear('history-close-btn');
const svgNew = svgNear('history-new-btn');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>历史会话抽屉 · 标签编辑 / 重命名预览</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0;
    background: #e9e7e2;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    color: #292824;
    padding: 24px;
  }
  h1 { font-size: 15px; margin: 0 0 4px; }
  .hint { font-size: 12px; color: #787671; margin: 0 0 18px; }
  .stage {
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
    align-items: flex-start;
  }
  .panel {
    background: #ffffff;
    border: 1px solid #e4e2de;
    border-radius: 12px;
    padding: 14px;
    width: 360px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.06);
  }
  .panel h2 {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.05em;
    color: #9b9790;
    margin: 0 0 10px;
    text-transform: uppercase;
  }
  /* ── 设计 token（抽自 styles/app.css 的 .app-container） ── */
  .app-tokens {
${designTokens()}
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    color: var(--ink-primary);
  }
  /* ── 组件样式（chat-history-drawer.css 全文，与线上同源） ── */
${css}
  /* 预览页专用：把抽屉铺进固定面板（不改组件样式） */
  .preview-drawer {
    position: static;
    width: auto;
    max-width: none;
    border-radius: 10px;
    box-shadow: none;
    border: 1px solid var(--line-soft, #e4e2de);
    min-height: 200px;
  }
  .preview-drawer .history-drawer-body { padding: 0; overflow: visible; }
  .preview-drawer .history-item { cursor: default; }
  /* 悬停态操作按钮在预览里常显，便于查看图标 */
  .preview-drawer .history-item-ops { opacity: 1; }
</style>
</head>
<body>
<h1>历史会话抽屉 · 标签编辑 / 重命名</h1>
<p class="hint">样式抽取自 chat-history-drawer.css；图标与文案抽取自 ChatHistoryDrawer.vue / zh-CN.ts。悬停行可见操作按钮。</p>

<div class="stage app-tokens">

  <!-- 1. 常态列表：标签 chip 行 + 智能体徽标 + 操作按钮（含纯标签图标） -->
  <section class="panel">
    <h2>常态列表（标签 chip + 操作按钮）</h2>
    <div class="history-drawer preview-drawer">
      <div class="history-drawer-body">
        <div class="history-list">
          <div class="history-item active">
            <div class="history-item-title-row">
              <span class="history-item-title">帮我按照这个简历去投两个 ai agent 应用</span>
              <span class="history-item-time">25 分钟前</span>
            </div>
            <div class="history-item-tags">
              <span class="history-tag" title="工作">工作</span>
              <span class="history-tag history-tag--system">学习</span>
            </div>
            <div class="history-item-preview">点击投递后进入了字节跳动登录页（手机号+验证码）…</div>
            <div class="history-item-meta">
              <span class="history-badge agent">文本通用助手</span>
              <span class="history-item-count">4 条消息</span>
              <span class="history-item-ops">
                <button class="item-op" aria-label="${copy('tagsEdit')}">${svgTagEdit}</button>
                <button class="item-op" aria-label="${copy('renameSession')}">${svgRename}</button>
                <button class="item-op danger" aria-label="${copy('delete')}">${svgDelete}</button>
              </span>
            </div>
          </div>
          <div class="history-item">
            <div class="history-item-title-row">
              <span class="history-item-title">帮我分析一下数据吧</span>
              <span class="history-item-time">刚刚</span>
            </div>
            <div class="history-item-preview">我先读取简历内容，了解你的背景，然后再去寻找…</div>
            <div class="history-item-meta">
              <span class="history-badge agent">文本通用助手</span>
              <span class="history-item-count">2 条消息</span>
              <span class="history-item-ops">
                <button class="item-op" aria-label="${copy('tagsEdit')}">${svgTagEdit}</button>
                <button class="item-op" aria-label="${copy('renameSession')}">${svgRename}</button>
                <button class="item-op danger" aria-label="${copy('delete')}">${svgDelete}</button>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- 2. 行内重命名：输入框 + 确认/取消（本次改造重点） -->
  <section class="panel">
    <h2>行内重命名（输入框 + 确认/取消）</h2>
    <div class="history-drawer preview-drawer">
      <div class="history-drawer-body">
        <div class="history-list">
          <div class="history-item">
            <div class="history-rename">
              <input value="帮我分析一下数据吧" placeholder="${copy('historyDrawer')}" />
              <button class="rename-confirm" aria-label="${copy('confirm')}">${svgConfirm}</button>
              <button class="rename-cancel" aria-label="${copy('cancel')}">${svgCancel}</button>
            </div>
          </div>
          <div class="history-item">
            <div class="history-rename">
              <input value="" placeholder="帮我按照这个简历去投两个 ai agent 应用" />
              <button class="rename-confirm" aria-label="${copy('confirm')}">${svgConfirm}</button>
              <button class="rename-cancel" aria-label="${copy('cancel')}">${svgCancel}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- 3. 标签编辑器：chip 草稿 + 输入添加 + 保存/取消 -->
  <section class="panel">
    <h2>标签编辑器（草稿 + 添加 + 保存）</h2>
    <div class="history-drawer preview-drawer">
      <div class="history-drawer-body">
        <div class="history-list">
          <div class="history-item active">
            <div class="history-item-title-row">
              <span class="history-item-title">帮我按照这个简历去投两个 ai agent 应用</span>
              <span class="history-item-time">25 分钟前</span>
            </div>
            <div class="history-item-tags">
              <span class="history-tag">工作</span>
            </div>
            <div class="history-item-preview">点击投递后进入了字节跳动登录页（手机号+验证码）…</div>
            <div class="history-item-meta">
              <span class="history-badge agent">文本通用助手</span>
              <span class="history-item-count">4 条消息</span>
              <span class="history-item-ops">
                <button class="item-op" aria-label="${copy('tagsEdit')}">${svgTagEdit}</button>
                <button class="item-op" aria-label="${copy('renameSession')}">${svgRename}</button>
                <button class="item-op danger" aria-label="${copy('delete')}">${svgDelete}</button>
              </span>
            </div>
            <div class="history-tag-editor">
              <div class="history-tag-editor-head">
                <span class="history-tag-editor-title">${copy('tagsTitle')}</span>
                <span class="history-tag-editor-count">2/8</span>
              </div>
              <div class="history-tag-editor-chips">
                <span class="history-tag">工作
                  <button class="history-tag-remove" aria-label="${copy('tagsRemove')}">${svgRemove}</button>
                </span>
                <span class="history-tag history-tag--system">学习
                  <button class="history-tag-remove" aria-label="${copy('tagsRemove')}">${svgRemove}</button>
                </span>
              </div>
              <div class="history-tag-editor-input-row">
                <input class="history-tag-editor-input" placeholder="${copy('tagsPlaceholder')}" />
                <button class="history-tag-editor-add" aria-label="${copy('tagsAdd')}">${svgAdd}</button>
              </div>
              <div class="history-tag-editor-actions">
                <button class="history-tag-editor-btn">${copy('tagsCancel')}</button>
                <button class="history-tag-editor-btn primary">${copy('tagsSave')}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- 4. 抽屉头部（关闭 / 新会话按钮） -->
  <section class="panel">
    <h2>抽屉头部</h2>
    <div class="history-drawer preview-drawer">
      <div class="history-drawer-header">
        <h3>${copy('historyDrawer')}</h3>
        <div class="history-drawer-actions">
          <button class="history-new-btn">${svgNew} ${copy('newChat')}</button>
          <button class="history-close-btn" aria-label="${copy('close')}">${svgClose}</button>
        </div>
      </div>
      <div class="history-drawer-body">
        <div class="history-empty">${copy('historyEmpty')}</div>
      </div>
    </div>
  </section>

</div>
</body>
</html>
`;

const out = path.join(root, '.preview/history-drawer.html');
writeFileSync(out, html, 'utf8');
console.log(`written: ${out}`);
