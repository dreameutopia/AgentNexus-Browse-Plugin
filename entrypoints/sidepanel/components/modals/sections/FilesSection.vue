<template>
  <div class="file-management">
    <div class="section-header">
      <h3>{{ t('sidepanel.settings.filesTitle') }}</h3>
      <div class="file-stats">
        <span class="stat-item">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"></path>
          </svg>
          {{ t('sidepanel.settings.fileCount', { count: fileStats.totalFiles }) }}
        </span>
        <span class="stat-item">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21,16.5C21,16.88 20.79,17.21 20.47,17.38L12.57,21.82C12.41,21.94 12.21,22 12,22C11.79,22 11.59,21.94 11.43,21.82L3.53,17.38C3.21,17.21 3,16.88 3,16.5V7.5C3,7.12 3.21,6.79 3.53,6.62L11.43,2.18C11.59,2.06 11.79,2 12,2C12.21,2 12.41,2.06 12.57,2.18L20.47,6.62C20.79,6.79 21,7.12 21,7.5V16.5M12,4.15L5.04,7.5L12,10.85L18.96,7.5L12,4.15Z"></path>
          </svg>
          {{ formatFileSize(fileStats.totalSize) }}
        </span>
      </div>
    </div>

    <!-- 搜索框 -->
    <div class="search-section">
      <div class="search-input-wrapper">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="search-icon">
          <circle cx="11" cy="11" r="8"></circle>
          <path d="m21 21-4.35-4.35"></path>
        </svg>
        <input
          v-model="fileSearchQuery"
          type="text"
          :placeholder="t('sidepanel.settings.searchFilesPlaceholder')"
          class="search-input"
        >
        <button v-if="fileSearchQuery" @click="clearSearch" class="clear-search-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    </div>

    <!-- 操作按钮 -->
    <div class="file-actions">
      <button class="action-btn refresh-btn" @click="refreshFileList" :disabled="isLoadingFiles">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ 'spinning': isLoadingFiles }">
          <polyline points="23 4 23 10 17 10"></polyline>
          <polyline points="1 20 1 14 7 14"></polyline>
          <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path>
        </svg>
        {{ t('common.refresh') }}
      </button>
      <button class="action-btn danger-btn" @click="confirmDeleteAllFiles" :disabled="fileList.length === 0">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3,6 5,6 21,6"></polyline>
          <path d="M19,6v14a2,2 0 0,1 -2,2H7a2,2 0 0,1 -2,-2V6m3,0V4a2,2 0 0,1 2,-2h4a2,2 0 0,1 2,2v2"></path>
        </svg>
        {{ t('sidepanel.settings.deleteAllFiles') }}
      </button>
    </div>

    <!-- 文件列表 -->
    <div class="file-list-container">
      <div v-if="isLoadingFiles" class="loading-state">
        <div class="loading-spinner"></div>
        <p>{{ t('sidepanel.settings.loadingFiles') }}</p>
      </div>

      <div v-else-if="displayedFiles.length === 0" class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="empty-icon">
          <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"></path>
        </svg>
        <p>{{ fileSearchQuery ? t('sidepanel.settings.noMatchedFiles') : t('sidepanel.settings.noFiles') }}</p>
      </div>

      <div v-else class="file-list">
        <div
          v-for="file in displayedFiles"
          :key="file.id"
          class="file-item"
        >
          <div class="file-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path :d="getFileIcon(file.type)"></path>
            </svg>
          </div>

          <div class="file-info">
            <div class="file-name" :title="file.name">{{ file.name }}</div>
            <div class="file-meta">
              <span class="file-id">ID: {{ file.id }}</span>
              <span class="file-size">{{ formatFileSize(file.size) }}</span>
              <span class="file-type">{{ file.type || t('sidepanel.settings.unknownType') }}</span>
              <span class="file-date">{{ formatDate(file.createdAt) }}</span>
            </div>
          </div>

          <div class="file-actions-menu">
            <button class="file-action-btn export-btn" @click="downloadFile(file.id)" :title="t('sidepanel.settings.exportFile', { name: file.name })">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7,10 12,15 17,10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
            </button>
            <button class="file-action-btn delete-btn" @click="confirmDeleteFile(file)" :title="t('sidepanel.settings.deleteFile', { name: file.name })">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3,6 5,6 21,6"></polyline>
                <path d="M19,6v14a2,2 0 0,1 -2,2H7a2,2 0 0,1 -2,-2V6m3,0V4a2,2 0 0,1 2,-2h4a2,2 0 0,1 2,2v2"></path>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 文件管理分区（托管文件的查看 / 搜索 / 导出 / 删除）
 * 迁移自原独立 SettingsModal 的 files 标签页；当前导航隐藏（历史功能保留）。
 * 修复说明：原模板导出按钮引用了未定义的 exportFile，此处统一指向 downloadFile。
 */
import { inject, ref, watch } from 'vue';
import { t } from '@/utils/i18n';
import { fileManager, type ManagedFile } from '@/utils/file-manager';
import { settingsModalContextKey, type SettingsModalContext } from '../composables/use-settings-form';

const { activeSection, openEpoch } = inject(settingsModalContextKey) as SettingsModalContext;

// 文件管理相关响应式数据
const fileList = ref<Omit<ManagedFile, 'content'>[]>([])
const fileStats = ref({ totalFiles: 0, totalSize: 0 })
const fileSearchQuery = ref('')
const displayedFiles = ref<Omit<ManagedFile, 'content'>[]>([])
const isLoadingFiles = ref(false)

// 文件管理相关方法
const loadFileList = async () => {
  isLoadingFiles.value = true
  try {
    const files = await fileManager.getAllFiles()
    fileList.value = files.map(file => ({
      id: file.id,
      name: file.name,
      size: file.size,
      type: file.type,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt
    }))

    const stats = await fileManager.getStats()
    fileStats.value = stats

    updateDisplayedFiles()
  } catch (error) {
    console.error('加载文件列表失败:', error)
  } finally {
    isLoadingFiles.value = false
  }
}

const updateDisplayedFiles = () => {
  if (!fileSearchQuery.value.trim()) {
    displayedFiles.value = fileList.value
  } else {
    const query = fileSearchQuery.value.toLowerCase()
    displayedFiles.value = fileList.value.filter(file =>
      file.name.toLowerCase().includes(query) ||
      file.id.toLowerCase().includes(query)
    )
  }
}

const downloadFile = async (fileId: string) => {
  try {
    const file = await fileManager.getFile(fileId)
    if (!file) {
      alert(t('sidepanel.settings.fileNotExist'))
      return
    }

    // 创建下载链接
    const blob = new Blob([file.content], { type: file.type || 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = file.name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch (error) {
    console.error('下载文件失败:', error)
    alert(t('sidepanel.settings.exportFailed'))
  }
}

const deleteFile = async (fileId: string) => {
  if (!confirm(t('sidepanel.settings.confirmDeleteFile'))) {
    return
  }

  try {
    await fileManager.deleteFile(fileId)
    await loadFileList()
  } catch (error) {
    console.error('删除文件失败:', error)
    alert(t('sidepanel.settings.deleteFailed'))
  }
}

const deleteAllFiles = async () => {
  if (!confirm(t('sidepanel.settings.confirmDeleteAllFiles'))) {
    return
  }

  try {
    await fileManager.clearAll()
    await loadFileList()
  } catch (error) {
    console.error('删除所有文件失败:', error)
    alert(t('sidepanel.settings.deleteAllFailed'))
  }
}

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

const formatDate = (date: number | Date): string => {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(typeof date === 'number' ? new Date(date) : date)
}

// 清空搜索框（模板 clear-search 按钮）
const clearSearch = () => {
  fileSearchQuery.value = ''
  updateDisplayedFiles()
}

// 刷新文件列表（模板刷新按钮）
const refreshFileList = async () => {
  await loadFileList()
}

// 清空全部文件（模板批量删除按钮，deleteAllFiles 内部自带二次确认）
const confirmDeleteAllFiles = async () => {
  await deleteAllFiles()
}

// 删除单个文件（模板逐项删除按钮，deleteFile 内部自带二次确认）
const confirmDeleteFile = async (file: Omit<ManagedFile, 'content'>) => {
  await deleteFile(file.id)
}

// 文件类型 → 列表项图标路径（单字符串多子路径，配合 SVG 的 fill="none" 描边渲染）
const DEFAULT_FILE_ICON = 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6'
const getFileIcon = (type: string): string => {
  if (!type) return DEFAULT_FILE_ICON
  if (type.startsWith('image/')) {
    return 'M4 4h16v16H4z M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M4 17l5-5 4 4 3-3 4 4'
  }
  if (type.startsWith('audio/')) {
    return 'M9 18V5l12-2v13 M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'
  }
  if (type.startsWith('video/')) {
    return 'M23 7l-7 5 7 5V7z M1 5h15v14H1z'
  }
  if (/javascript|json|xml|html|css|typescript|script/.test(type)) {
    return 'M16 18l6-6-6-6 M8 6l-6 6 6 6'
  }
  if (type.startsWith('text/') || /markdown|csv/.test(type)) {
    return 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h6'
  }
  return DEFAULT_FILE_ICON
}

// 监听搜索查询变化
watch(fileSearchQuery, updateDisplayedFiles)

// 切到文件管理分区 / 弹窗重新打开时加载文件列表
watch(activeSection, section => {
  if (section === 'files') void loadFileList()
})
watch(openEpoch, () => {
  if (activeSection.value === 'files') void loadFileList()
}, { immediate: true })
</script>

<style scoped>
.file-management {
  max-height: 500px;
  overflow-y: auto;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
}

.section-header h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #1f2937;
}

.file-stats {
  display: flex;
  gap: 16px;
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  color: #6b7280;
}

.search-section {
  margin: 24px 0;
}

.search-input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 12px;
  color: #9ca3af;
  z-index: 1;
}

.search-input {
  width: 100%;
  padding: 12px 16px 12px 40px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font-size: 14px;
  transition: border-color 0.2s;
}

.search-input:focus {
  outline: none;
  border-color: #667eea;
  box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
}

.clear-search-btn {
  position: absolute;
  right: 12px;
  background: none;
  border: none;
  color: #9ca3af;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: color 0.2s;
}

.clear-search-btn:hover {
  color: #6b7280;
}

.file-actions {
  display: flex;
  gap: 12px;
  margin-bottom: 24px;
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  background: white;
  color: #374151;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.2s;
}

.action-btn:hover:not(:disabled) {
  background: #f9fafb;
  border-color: #9ca3af;
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.refresh-btn svg.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.danger-btn {
  border-color: #fca5a5;
  color: #dc2626;
}

.danger-btn:hover:not(:disabled) {
  background: #fef2f2;
  border-color: #f87171;
}

.file-list-container {
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  background: white;
  min-height: 200px;
}

.loading-state, .empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  color: #6b7280;
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid #f3f4f6;
  border-top: 3px solid #667eea;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 16px;
}

.empty-icon {
  color: #d1d5db;
  margin-bottom: 16px;
}

.file-list {
  padding: 16px;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  border: 1px solid #f3f4f6;
  border-radius: 8px;
  margin-bottom: 12px;
  transition: all 0.2s;
}

.file-item:hover {
  background: #f8fafc;
  border-color: #e5e7eb;
}

.file-item:last-child {
  margin-bottom: 0;
}

.file-icon {
  flex-shrink: 0;
  color: #667eea;
}

.file-info {
  flex: 1;
  min-width: 0;
}

.file-name {
  font-size: 14px;
  font-weight: 500;
  color: #1f2937;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: #6b7280;
  flex-wrap: wrap;
}

.file-actions-menu {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.file-action-btn {
  padding: 6px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.export-btn {
  background: #f0f9ff;
  color: #0369a1;
}

.export-btn:hover {
  background: #e0f2fe;
}

.delete-btn {
  background: #fef2f2;
  color: #dc2626;
}

.delete-btn:hover {
  background: #fee2e2;
}
</style>
