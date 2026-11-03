/**
 * 设置分区组件出口
 *
 * 前三个为对外可见分区；files / system 为自原独立 SettingsModal
 * 迁入的历史功能，注册于壳的分区表但导航隐藏（hidden: true）。
 * 智能体管理已迁移至 hub 独立页（entrypoints/hub）；
 * 备份恢复分区亦已迁至 hub（entrypoints/hub/BackupSection.vue）。
 */
export { default as ChannelsSection } from './ChannelsSection.vue';
export { default as AdvancedSection } from './AdvancedSection.vue';
export { default as AsrSection } from './AsrSection.vue';
export { default as UsageSection } from './UsageSection.vue';
export { default as FilesSection } from './FilesSection.vue';
export { default as SystemSection } from './SystemSection.vue';
export { default as PythonSection } from './PythonSection.vue';
export { default as WebsiteSection } from './WebsiteSection.vue';
