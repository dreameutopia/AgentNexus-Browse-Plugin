<template>
  <div class="model-cache-management">
    <div class="cache-stats" v-if="cacheStats">
      <div class="stats-header">
        <h3 class="stats-title">Cache Statistics</h3>
        <button class="refresh-button" @click="$emit('refresh')" :disabled="isLoading">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>
        </button>
      </div>
      
      <div class="stats-grid">
        <div class="stat-item">
          <span class="stat-label">Total Size:</span>
          <span class="stat-value">{{ cacheStats.totalSizeMB.toFixed(2) }} MB</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">Entries:</span>
          <span class="stat-value">{{ cacheStats.entryCount }}</span>
        </div>
      </div>

      <div class="cache-actions">
        <button 
          class="action-button cleanup" 
          @click="$emit('cleanup')" 
          :disabled="isLoading"
        >
          Cleanup Expired
        </button>
        <button 
          class="action-button clear" 
          @click="$emit('clear')" 
          :disabled="isLoading"
        >
          Clear All
        </button>
      </div>
    </div>
    
    <div v-else class="no-stats">
      <p>No cache statistics available</p>
    </div>
  </div>
</template>

<script setup lang="ts">
interface CacheStats {
  totalSize: number;
  totalSizeMB: number;
  entryCount: number;
  entries: Array<{
    url: string;
    size: number;
    sizeMB: number;
    timestamp: number;
    age: string;
    expired: boolean;
  }>;
}

interface Props {
  cacheStats: CacheStats | null;
  isLoading?: boolean;
}

interface Emits {
  refresh: [];
  cleanup: [];
  clear: [];
}

defineProps<Props>();
defineEmits<Emits>();
</script>

<style scoped>
.model-cache-management {
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 16px;
  margin: 16px 0;
}

.stats-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.stats-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #1f2937;
}

.refresh-button {
  background: none;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  padding: 4px 8px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.refresh-button:hover:not(:disabled) {
  background: #f3f4f6;
}

.refresh-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 16px;
}

.stat-item {
  display: flex;
  justify-content: space-between;
  padding: 8px;
  background: #f8fafc;
  border-radius: 4px;
}

.stat-label {
  color: #64748b;
  font-size: 14px;
}

.stat-value {
  color: #1f2937;
  font-weight: 500;
  font-size: 14px;
}

.cache-actions {
  display: flex;
  gap: 8px;
}

.action-button {
  flex: 1;
  padding: 8px 16px;
  border: 1px solid transparent;
  border-radius: 6px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.action-button.cleanup {
  background: #f59e0b;
  color: white;
}

.action-button.cleanup:hover:not(:disabled) {
  background: #d97706;
}

.action-button.clear {
  background: #dc2626;
  color: white;
}

.action-button.clear:hover:not(:disabled) {
  background: #b91c1c;
}

.action-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.no-stats {
  text-align: center;
  color: #64748b;
  padding: 20px;
}

.no-stats p {
  margin: 0;
}
</style>