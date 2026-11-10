/**
 * 预览入口：管理中心「使用监控」+「Python 环境」两个分区
 *
 * 走生产组件路径（entrypoints/hub/usage/UsageSection.vue 与
 * entrypoints/hub/python/PythonSection.vue）+ 真实 CSS（hub.css /
 * usage-section.css / python-section.css），用于核对：
 *   1. 两个分区在管理中心壳（左导航卡 + 右内容卡）里的版式与留白；
 *   2. 指标卡 / 筛选栏 / 占比条 / 明细行的中性黑白灰观感（无任何蓝紫）；
 *   3. Python 分区的运行时详情四宫格、包芯片、确认条与测试运行台。
 *
 * 数据层被 esbuild 桩替换（预览环境无 chrome.* / 无 Pyodide 运行时）：
 *   - usage-metrics-engine → 固定快照（模拟若干模型 / 渠道 / 请求 / 失败）；
 *   - pyodide 系列 → 模拟已就绪环境、目录与安装结果；
 *   - driver-registry → 仅保留展示名（避免把协议适配器整包拉进预览）。
 */
import { createApp, h } from 'vue';
import UsageSection from '../entrypoints/hub/usage/UsageSection.vue';
import PythonSection from '../entrypoints/hub/python/PythonSection.vue';
import { setLocale } from '../utils/i18n/core';
import { i18n } from '../utils/i18n';

setLocale('zh-CN');

const usageRoot = document.getElementById('section-root');
const pythonRoot = document.getElementById('section-root');

// 一次只渲染一个分区（与真实管理中心的 v-show 互斥展示一致：
// 两个分区叠在同一滚动容器里会各自溢出并互相覆盖）
const section = new URLSearchParams(window.location.search).get('section') ?? 'usage';

if (usageRoot && section === 'usage') {
  createApp({
    render: () => h(UsageSection),
  }).use(i18n).mount(usageRoot);
}

if (pythonRoot && section === 'python') {
  createApp({
    render: () => h(PythonSection, { active: true }),
  }).use(i18n).mount(pythonRoot);
}
