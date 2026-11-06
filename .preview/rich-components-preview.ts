/**
 * 预览入口：统一信封富组件全家福（真实渲染器 → 浏览器预览页）
 *
 * 走生产代码路径（markdownRenderer.renderMessage → 信封解析 → 派生 → 构建），
 * 预览页只提供容器与真实样式表。图表用项目自带 echarts 直接渲染派生
 * option（模拟沙箱页行为——沙箱本体只是 setOption 的隔离宿主），
 * 证明「列式数据 → 宿主派生」链路的最终视觉效果。
 */
import * as echarts from 'echarts';
import { markdownRenderer } from '../entrypoints/sidepanel/utils/chat/markdown-renderer';
import { parseRichEnvelope, deriveChartOption } from '../entrypoints/sidepanel/utils/chat/rich-components';
import { sanitizeEchartsOptionJson } from '../entrypoints/sidepanel/utils/chat/echarts-option-sanitizer';
import { setLocale } from '../utils/i18n/core';

setLocale('zh-CN');

interface PreviewCase {
  label: string;
  /** 完整消息 Markdown（围栏 + 前后正文，模拟真实模型输出） */
  markdown: string;
  /** 是否用 echarts 渲染信封 chart 的派生 option（模拟沙箱） */
  liveChart?: boolean;
}

const CASES: PreviewCase[] = [
  {
    label: '信封 chart：时间序列 → 自动折线',
    markdown:
      '近 7 日学习时长呈上升趋势，周末明显放量：\n\n```component\n{"type":"chart","title":"近7日学习时长（分钟）","columns":["日期","学习","复习"],"rows":[["周一",35,12],["周二",50,8],["周三",20,25],["周四",64,18],["周五",45,30],["周六",90,42],["周日",75,20]]}\n```\n',
    liveChart: true,
  },
  {
    label: '信封 chart：占比语义 → 自动饼图',
    markdown:
      '```component\n{"type":"chart","title":"本次爬取链接状态分布","columns":["状态","占比"],"rows":[["200 正常",70],["301 跳转",15],["404 失效",10],["超时",5]]}\n```\n',
    liveChart: true,
  },
  {
    label: '信封 chart：显式 radar（宿主转置派生）',
    markdown:
      '```component\n{"type":"chart","kind":"radar","title":"两套技能方案能力对比","columns":["维度","方案A","方案B"],"rows":[["稳定性",8,6],["速度",6,9],["上下文效率",9,5],["弱模型友好",8,7],["扩展性",7,8]]}\n```\n',
    liveChart: true,
  },
  {
    label: '信封 stat：涨跌方向由 +/- 前缀驱动',
    markdown:
      '本周学习小结如下：\n\n```component\n{"type":"stat","title":"本周学习总结","columns":["指标","当前值","环比","说明"],"rows":[["连续打卡","6 天","+1 天","最长纪录 12 天"],["新增词汇","214 个","+12.3%","复习掌握 58 个"],["学习时长","5.4 小时","-8.2%","日均 46 分钟"],["正确率","87.5%","+2.1pt","近 7 日均值"]]}\n```\n',
  },
  {
    label: '信封 table：数值右对齐 + 状态着色',
    markdown:
      '```component\n{"type":"table","title":"本次性能审计 TOP 页面","columns":["页面","LCP(ms)","CLS","请求数","状态"],"rows":[["首页",1240,0.02,43,"良好"],["商品详情",2300,0.11,67,"需优化"],["购物车",980,0.01,28,"良好"],["结算页",4100,0.35,92,"超标"]]}\n```\n',
  },
  {
    label: '信封 timeline：状态列自动着色',
    markdown:
      '任务执行过程：\n\n```component\n{"type":"timeline","title":"本次任务执行过程","columns":["步骤","动作","状态","耗时"],"rows":[["1","打开目标页面并等待加载","完成","2.1s"],["2","提取商品列表 48 项","完成","0.8s"],["3","逐项进入详情页采集价格","进行中","31s"],["4","汇总去重并导出 XLSX","待办","—"]]}\n```\n',
  },
  {
    label: '信封 tree：路径 → 缩进结构树',
    markdown:
      '```component\n{"type":"tree","title":"导出的书签结构","columns":["路径","备注"],"rows":[["工作/",""],["工作/文档/","周报与纪要"],["工作/文档/2026-Q3.md",""],["工具/",""],["工具/AI 服务/",""],["工具/AI 服务/Claude.md",""],["工具/AI 服务/OpenAI.md",""],["娱乐/",""]]}\n```\n',
  },
  {
    label: 'diff 原生围栏：行级着色 + 统计徽标',
    markdown:
      '顺手调整了净化器上限：\n\n```diff\n--- a/echarts-option-sanitizer.ts\n+++ b/echarts-option-sanitizer.ts\n@@ -34,7 +34,7 @@\n-const MAX_SERIES = 4;\n+const MAX_SERIES = 8;\n const MAX_DATA_POINTS_PER_SERIES = 500;\n+const MAX_DATASET_ROWS = 1_000;\n```\n',
  },
  {
    label: 'legacy ```echarts 直连：历史消息继续渲染（骨架态）',
    markdown:
      '```echarts\n{"title":{"text":"旧版直连图表"},"xAxis":{"type":"category","data":["a","b","c"]},"series":[{"type":"bar","data":[3,5,8]}]}\n```\n',
  },
  {
    label: '失败降级：非法信封 → 源码代码块（信息不丢）',
    markdown: '```component\n{"type":"chart", 这里不是合法 JSON\n```',
  },
];

function mount(): void {
  const root = document.getElementById('cases');
  if (!root) return;

  for (const testCase of CASES) {
    const stage = document.createElement('section');
    stage.className = 'stage';
    const caption = document.createElement('h3');
    caption.textContent = testCase.label;
    stage.appendChild(caption);

    const body = document.createElement('div');
    body.className = 'message-body';
    body.innerHTML = markdownRenderer.renderMessage(testCase.markdown);
    stage.appendChild(body);
    root.appendChild(stage);

    // 模拟沙箱页：把信封 chart 的派生 option 用 echarts 直接渲染进骨架
    if (testCase.liveChart) {
      const block = body.querySelector<HTMLElement>('.chart-block[data-chart-input="envelope"]');
      const source = block?.querySelector('.chart-source code')?.textContent ?? '';
      const parsed = parseRichEnvelope(source);
      if (parsed.ok) {
        const derived = deriveChartOption(parsed.envelope);
        if (derived.ok) {
          const sanitized = sanitizeEchartsOptionJson(JSON.stringify(derived.option));
          if (sanitized.ok) {
            const chartBody = block?.querySelector<HTMLElement>('.chart-body');
            if (chartBody && block) {
              chartBody.innerHTML = '';
              chartBody.style.height = '300px';
              const instance = echarts.init(chartBody);
              instance.setOption(JSON.parse(sanitized.json));
              block.dataset.chartState = 'done';
            }
          }
        }
      }
    }
  }
}

mount();
