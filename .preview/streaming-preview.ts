/**
 * 预览入口：流式增量冻结渲染（真实 MarkdownText 宿主 + 模拟 token 流）
 *
 * 走生产代码路径（MarkdownText 稳定区/尾部宿主 + stable-boundary 探测 +
 * markdown-renderer fence 分发）。图表挂载用 MutationObserver 模拟
 * ChatMessageList 的扫描器 + 沙箱行为（echarts 直接渲染派生 option），
 * 证明三件事：
 *   1. 组件围栏在直播流中闭合的瞬间即被挂载（不等流结束）；
 *   2. 后续 token 只重写活动尾部，已挂载图表不被销毁；
 *   3. 流结束终排冻结全部内容，组件原样保留。
 */
import { createApp, h, reactive } from 'vue';
import MarkdownText from '../entrypoints/sidepanel/components/chat/MarkdownText.vue';
import { parseRichEnvelope, deriveChartOption } from '../entrypoints/sidepanel/utils/chat/rich-components';
import { sanitizeEchartsOptionJson } from '../entrypoints/sidepanel/utils/chat/echarts-option-sanitizer';
import { installChartRenderer } from '../entrypoints/sidepanel/utils/chat/chart-renderer';
import { setLocale } from '../utils/i18n/core';
import * as echarts from 'echarts';

setLocale('zh-CN');
installChartRenderer();

const CHART = '```component\n{"type":"chart","title":"近7日活跃","columns":["日期","新增","活跃"],"rows":[["周一",12,30],["周二",18,41],["周三",9,22],["周四",25,36],["周五",31,44],["周六",40,52]]}\n```';

const state = reactive({ content: '', streaming: true });

const mountPoint = document.getElementById('stream-host');
if (mountPoint) {
  const app = createApp({
    render: () => h(MarkdownText, { content: state.content, streaming: state.streaming }),
  });
  app.mount(mountPoint);

  // 模拟 ChatMessageList 的扫描器：冻结段里出现图表骨架 → 派生 + echarts 挂载
  // （沙箱页在生产中承担此步；预览环境无 chrome.runtime，用同源 echarts 直渲染）
  const observer = new MutationObserver(() => {
    for (const block of mountPoint.querySelectorAll<HTMLElement>(
      '.chart-block[data-chart-state="pending"]',
    )) {
      if (!block.closest('[data-md-stable]')) continue;
      const source = block.querySelector('.chart-source code')?.textContent ?? '';
      const parsed = parseRichEnvelope(source);
      if (!parsed.ok) continue;
      const derived = deriveChartOption(parsed.envelope);
      if (!derived.ok) continue;
      const sanitized = sanitizeEchartsOptionJson(JSON.stringify(derived.option));
      if (!sanitized.ok) continue;
      const body = block.querySelector<HTMLElement>('.chart-body');
      if (!body) continue;
      body.innerHTML = '';
      body.style.height = '300px';
      echarts.init(body).setOption(JSON.parse(sanitized.json));
      block.dataset.chartState = 'done';
    }
  });
  observer.observe(mountPoint, { childList: true, subtree: true });

  // 模拟 token 流：结论 → 图表围栏逐字输出 → 闭合（挂载！）→ 尾部继续 → 结束
  const TOKENS = [
    '本周活跃数据如下，周三因接口故障出现回落：\n\n',
    '```compo', 'nent\n{"type":"chart",', '"title":"近7日活跃",', '"columns":["日期","新增","活跃"],',
    '"rows":[["周一",12,30],', '["周二",18,41],', '["周三",9,22],', '["周四",25,36],',
    '["周五",31,44],', '["周六",40,52]]}', '\n```', '\n\n',
    '从趋势看周六达到峰值，', '环比上周提升 18%。', '接下来分析回落原因……',
  ];

  let index = 0;
  const feed = (): void => {
    console.log('[stream-preview] feed', index, 'len=', state.content.length);
    if (index >= TOKENS.length) {
      state.streaming = false; // 终排：尾部冻结为最后一段
      console.log('[stream-preview] stream finalized');
      return;
    }
    state.content += TOKENS[index++];
    setTimeout(feed, 160);
  };
  setTimeout(feed, 200);
} else {
  console.log('[stream-preview] mount point missing');
}
