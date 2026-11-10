/**
 * 预览入口：管理中心「会话管理」分区
 *
 * 走生产组件路径（entrypoints/hub/sessions/SessionsSection.vue）+ 真实 CSS
 * （hub.css / sessions-section.css），用于核对：
 *   1. 分区在管理中心壳（左导航卡 + 右内容卡）里的版式 —— 右侧整体不出滚动条，
 *      只有会话列表容器超出时出现滚动条（本分区的核心布局契约）；
 *   2. 常规 / 归档双视图、搜索栏、内容搜索开关、保留策略卡的观感；
 *   3. 会话行的标题 / 预览 / 徽章（执行中、侧边栏打开中、归档、学习）/ 操作钮；
 *   4. 中性黑白灰配色（无任何蓝紫）与玻璃材质一致性。
 *
 * 数据层被 esbuild 桩替换（预览环境无 chrome.* / IndexedDB）：
 *   - 会话数据面全家桶 → 内存态种子数据（含归档会话、执行中会话、正文可搜内容）；
 *   - 运行态查询 / 打开侧边栏 / 删除引擎 → 桩内可控假实现。
 */
import { createApp, h } from 'vue';
import SessionsSection from '../entrypoints/hub/sessions/SessionsSection.vue';
import { setLocale } from '../utils/i18n/core';
import { i18n } from '../utils/i18n';

setLocale('zh-CN');

const root = document.getElementById('section-root');
if (root) {
  createApp({
    render: () => h(SessionsSection, { active: true }),
  })
    .use(i18n)
    .mount(root);
}
