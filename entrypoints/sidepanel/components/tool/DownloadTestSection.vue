<template>
  <div class="download-test-section">
    <div class="test-header">
      <h3 class="section-title">📥 下载快捷操作</h3>
      <span class="test-description">快速触发测试下载或查看下载状态</span>
    </div>
    <div class="test-controls">
      <button class="btn-test-download" @click="$emit('triggerDownload')">
        ⬇️ 触发测试下载
      </button>
      <button class="btn-refresh-downloads" @click="$emit('refreshDownloads')">
        🔄 刷新下载列表
      </button>
    </div>
    <div v-if="downloadTestInfo" class="download-info">
      <p>{{ downloadTestInfo }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  downloadTestInfo: string;
}>();

defineEmits<{
  triggerDownload: [];
  refreshDownloads: [];
}>();
</script>

<style scoped>
.download-test-section {
  background: white;
  padding: 20px;
  border-radius: 12px;
  margin-bottom: 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  border: 2px solid #10b981;
}

.test-header {
  margin-bottom: 16px;
}

.test-header .section-title {
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 600;
  color: #333;
}

.test-description {
  display: block;
  font-size: 13px;
  color: #666;
  margin-top: 4px;
}

.test-controls {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.btn-test-download {
  flex: 1;
  padding: 12px 20px;
  border: none;
  border-radius: 8px;
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
}

.btn-test-download:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(16, 185, 129, 0.4);
}

.btn-refresh-downloads {
  flex: 1;
  padding: 12px 20px;
  border: none;
  border-radius: 8px;
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
}

.btn-refresh-downloads:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
}

.download-info {
  margin-top: 12px;
  padding: 12px;
  background: #f0fdf4;
  border: 1px solid #86efac;
  border-radius: 8px;
  font-size: 13px;
  color: #166534;
}

.download-info p {
  margin: 0;
}
</style>
