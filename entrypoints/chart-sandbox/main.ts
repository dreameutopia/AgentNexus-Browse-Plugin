/**
 * 图表沙箱页脚本（chart-sandbox.html）
 *
 * 本页面经 manifest "sandbox.pages" 声明（见 wxt.config.ts），由 Chrome 以
 * 独立源加载：无法访问任何 chrome.* 扩展 API、无法访问扩展存储与侧边栏
 * DOM——ECharts（含其历史上的 tooltip HTML 注入类 CVE）的影响半径被
 * 限制在本页面内。页面 CSP 由 manifest content_security_policy.sandbox 指定。
 *
 * 与父页（sidepanel / chart-renderer.ts）的消息协议（postMessage）：
 *   父 → 沙箱：{ source: 'an-chart-parent', type: 'render',  id, optionJson }
 *             { source: 'an-chart-parent', type: 'resize' }
 *             { source: 'an-chart-parent', type: 'dispose' }
 *   沙箱 → 父：{ source: 'an-chart-sandbox', type: 'ready' }
 *             { source: 'an-chart-sandbox', type: 'rendered', id }
 *             { source: 'an-chart-sandbox', type: 'error', id, message }
 *
 * 防御要点：
 *   - 消息先验 source 白名单 + 字段类型校验，未知消息一律忽略；
 *   - optionJson 再次 JSON.parse（父页净化结果的独立复核），
 *     非对象直接报错，绝不 eval / Function 构造；
 *   - 每页单实例：重复 render 复用同一 ECharts 实例（notMerge 全量替换），
 *     dispose 后可重建；
 *   - 任何异常都以 'error' 消息回传父页（父页降级为源码展示），
 *     绝不让异常中断消息循环。
 */

import * as echarts from 'echarts';

type EChartsInstance = ReturnType<typeof echarts.init>;
type EChartsOption = Parameters<EChartsInstance['setOption']>[0];

const PARENT_SOURCE = 'an-chart-parent';
const SANDBOX_SOURCE = 'an-chart-sandbox';

let chart: EChartsInstance | null = null;

/** 向父页发送协议消息（payload 非敏感——净化后的图表 JSON 与状态） */
function post(type: string, payload: Record<string, unknown> = {}): void {
  try {
    window.parent.postMessage({ source: SANDBOX_SOURCE, type, ...payload }, '*');
  } catch (error) {
    console.warn('[ChartSandbox] postMessage 发送失败:', error);
  }
}

/** 渲染请求处理：复核 JSON → 初始化/复用实例 → setOption → 回报状态 */
function handleRender(id: unknown, optionJson: unknown): void {
  const requestId = typeof id === 'string' ? id : '';
  try {
    if (!requestId || typeof optionJson !== 'string' || !optionJson) {
      throw new Error('渲染协议消息缺少必要字段');
    }
    const option: unknown = JSON.parse(optionJson);
    if (typeof option !== 'object' || option === null || Array.isArray(option)) {
      throw new Error('图表 option 必须是 JSON 对象');
    }
    if (!chart) {
      const root = document.getElementById('chart-root');
      if (!root) {
        throw new Error('图表容器节点缺失');
      }
      chart = echarts.init(root);
    }
    chart.clear();
    chart.setOption(option as EChartsOption, { notMerge: true });
    post('rendered', { id: requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[ChartSandbox] 图表渲染失败:', message);
    post('error', { id: requestId, message });
  }
}

/** 释放 ECharts 实例（父页移除图表块前的礼貌收尾；iframe 卸载时浏览器兜底回收） */
function handleDispose(): void {
  try {
    chart?.dispose();
  } catch (error) {
    console.warn('[ChartSandbox] dispose 异常:', error);
  }
  chart = null;
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { source?: unknown; type?: unknown } | null;
  if (!data || data.source !== PARENT_SOURCE || typeof data.type !== 'string') return;
  const payload = data as { id?: unknown; optionJson?: unknown };
  switch (data.type) {
    case 'render':
      handleRender(payload.id, payload.optionJson);
      break;
    case 'resize':
      try {
        chart?.resize();
      } catch (error) {
        console.warn('[ChartSandbox] resize 异常:', error);
      }
      break;
    case 'dispose':
      handleDispose();
      break;
    default:
      break;
  }
});

// 就绪信号：父页据此把「待渲染 option」下发（时序上父页监听器先于 iframe 建立就绪）
post('ready');
