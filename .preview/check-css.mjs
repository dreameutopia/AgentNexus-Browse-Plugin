// 在真实样式表上跑一遍括号/选择器完整性检查（粗粒度，避免语法打穿）。
import { readFileSync } from 'node:fs';

const css = readFileSync(
  'entrypoints/sidepanel/styles/app.css',
  'utf8'
);
// 去掉注释后再统计花括号
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
let depth = 0;
let line = 1;
let bad = null;
for (const ch of bare) {
  if (ch === '\n') line++;
  if (ch === '{') depth++;
  if (ch === '}') {
    depth--;
    if (depth < 0 && !bad) bad = line;
  }
}
console.log('unbalanced depth at EOF:', depth, bad ? 'first extra } around line ' + bad : '');
const checks = [
  ['.model-select-btn', /\.model-select-btn\s*\{/],
  ['.model-select-name', /\.model-select-name\s*\{/],
  ['.model-select-dropdown', /\.model-select-dropdown\s*\{/],
  ['.model-select-option.active', /\.model-select-option\.active\s*\{/],
];
for (const [name, re] of checks) {
  console.log(name, re.test(bare) ? 'ok' : 'MISSING');
}
