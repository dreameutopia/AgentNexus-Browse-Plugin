/**
 * 网站学习 UI 组件出口
 *
 * 四个组件分工：
 *   SiteLearnModal    配置面板（打开学习的唯一入口）
 *   LearnDialog       六态确认弹窗（开始 / 终止 / 收尾 / 验证失败 / 失败 / 无产出）
 *   LearnStatusBar    运行状态条（替换输入区，含终止按钮）
 *   LearnHintPopover  学习策略问号解释卡（就地展开，不产生横向溢出）
 *   LearnModelPicker  学习模型自定义选择卡片（常驻卡片 + 就地展开列表）
 *   LearnDegradedNotice 草稿暂存失败降级说明（非阻断，收尾/验证阶段）
 */
export { default as SiteLearnModal } from './SiteLearnModal.vue';
export { default as LearnDialog } from './LearnDialog.vue';
export { default as LearnStatusBar } from './LearnStatusBar.vue';
export { default as LearnHintPopover } from './LearnHintPopover.vue';
export { default as LearnModelPicker } from './LearnModelPicker.vue';
export { default as LearnDegradedNotice } from './LearnDegradedNotice.vue';
export { default as LearnRecoveryDismissDialog } from './LearnRecoveryDismissDialog.vue';
