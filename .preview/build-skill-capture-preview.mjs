/**
 * 技能沉淀提醒卡片预览页生成器。
 *
 * 为什么不用手写 HTML：卡片样式在 SFC 的 <style scoped> 里，手抄一份必然与源码漂移。
 * 这里直接从 SFC 抽出 scoped 样式（去掉 [data-v-xxx] 属性选择器），再从 zh-CN 语言包
 * 取真实文案拼出预览页——预览所见即源码所见。
 *
 * 产物：.preview/skill-capture-card.html
 * 用法：node .preview/build-skill-capture-preview.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sfcPath = path.join(root, 'entrypoints/sidepanel/components/chat/SkillCapturePrompt.vue');
const localePath = path.join(root, 'utils/i18n/locales/zh-CN.ts');

const sfc = readFileSync(sfcPath, 'utf8');
const locale = readFileSync(localePath, 'utf8');

/** 从语言包取一个文案键（值为双引号字符串） */
function copy(key) {
  const matched = locale.match(new RegExp(`${key}:\\s*"([^"]*)"`));
  if (!matched) throw new Error(`语言包缺少键：${key}`);
  return matched[1];
}

/** 抽 scoped 样式块并剥离 scoped 属性选择器（预览页没有 data-v 属性） */
function scopedCss() {
  const block = sfc.match(/<style scoped>([\s\S]*?)<\/style>/);
  if (!block) throw new Error('SkillCapturePrompt.vue 缺少 <style scoped> 块');
  return block[1].replace(/\[data-v-[0-9a-f]+\]/g, '');
}

/** 抽卡片模板片段（<section class="skill-practice-card"> … </section>） */
function cardMarkup() {
  const matched = sfc.match(/<section v-if="visible[^]*?<\/section>/);
  if (!matched) throw new Error('未找到 .skill-practice-card 模板片段');
  return matched[0]
    .replace(/v-if="[^"]*"/, '')
    .replace(/\{\{\s*t\('([^']+)'\)\s*\}\}/g, (_, key) => {
      const short = key.replace('sidepanel.chat.', '');
      return copy(short);
    })
    .replace(/\s+:disabled="disabled"/, '')
    .replace(/\s+@click="open\(messageId\)"/, '')
    .replace(/\s+@click="dismissed = scopeKey"/, '')
    .replace(/\s+@click="openHide"/, '');
}

const styles = scopedCss();
const card = cardMarkup();

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>技能沉淀提醒卡片预览</title>
<link rel="stylesheet" href="../entrypoints/sidepanel/styles/global.css">
<link rel="stylesheet" href="../entrypoints/sidepanel/styles/app.css">
<style>
  /* 预览页仅用于视觉核对：复刻侧边栏列宽（380px）与宽列（560px）两种场景 */
  body { margin: 0; padding: 24px; background: var(--bg-secondary, #f8fafc); }
  .preview-row { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
  .preview-col { background: var(--bg-primary, #fff); border: 1px solid var(--line-soft, #e4e2de); border-radius: 12px; padding: 12px; }
  .preview-col--narrow { width: 380px; }
  .preview-col--wide { width: 560px; }
  .preview-label { font-size: 11px; color: var(--ink-secondary, #787671); margin-bottom: 8px; }
${styles}
</style>
</head>
<body>
  <div class="preview-row">
    <div class="preview-col preview-col--narrow">
      <div class="preview-label">侧边栏列宽 380px</div>
      ${card}
    </div>
    <div class="preview-col preview-col--wide">
      <div class="preview-label">宽列 560px</div>
      ${card}
    </div>
  </div>
</body>
</html>
`;

const outPath = path.join(root, '.preview/skill-capture-card.html');
writeFileSync(outPath, html, 'utf8');
console.log(`[build-skill-capture-preview] 已生成 ${path.relative(root, outPath)}`);
