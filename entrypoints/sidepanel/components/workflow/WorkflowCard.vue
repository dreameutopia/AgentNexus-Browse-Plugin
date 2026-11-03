<template>
  <div class="workflow-card">
    <div class="card-header">
      <div class="header-left">
        <div class="title-gradient">工作流管理</div>
      </div>
      <div class="header-right">
        <button class="close-btn" @click="handleClose" title="关闭工作流面板">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </div>
    
    <div class="card-body">
      <!-- 工作流列表 -->
      <div class="workflows-section">
        <div class="section-header">
          <h3 class="section-title">已有工作流</h3>
        </div>
        
        <div class="workflows-list">
          <div v-if="workflows.length === 0" class="empty-state">
            <div class="empty-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z" fill="currentColor" opacity="0.3"/>
              </svg>
            </div>
            <p class="empty-text">暂无工作流</p>
            <p class="empty-subtitle">工作流列表为空</p>
          </div>
          
          <div v-for="workflow in workflows" :key="workflow.id" class="workflow-item">
            <div class="workflow-info">
              <div class="workflow-header">
                <h4 class="workflow-name">{{ workflow.name }}</h4>
                <div class="workflow-meta">
                  <span class="workflow-steps">{{ workflow.steps.length }} 步骤</span>
                  <span class="workflow-date">{{ formatDate(workflow.createdAt) }}</span>
                </div>
              </div>
              <p class="workflow-description">{{ workflow.description }}</p>
            </div>
            
            <div class="workflow-actions">
              <button class="action-btn run-btn" @click="handleRunWorkflow(workflow)" title="运行工作流">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M8,5.14V19.14L19,12.14L8,5.14Z" fill="currentColor"/>
                </svg>
              </button>
              <button class="action-btn edit-btn" @click="handleEditWorkflow(workflow)" title="编辑工作流">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z" fill="currentColor"/>
                </svg>
              </button>
              <button class="action-btn delete-btn" @click="handleDeleteWorkflow(workflow)" title="删除工作流">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z" fill="currentColor"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

interface WorkflowStep {
  type: string;
  selector?: string;
  value?: string;
  description: string;
}

interface Workflow {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  createdAt: string;
  isRecording?: boolean;
}

interface Props {
  workflows: Workflow[];
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'close': [];
  'run-workflow': [workflow: Workflow];
  'delete-workflow': [workflow: Workflow];
  'edit-workflow': [workflow: Workflow];
}>();

const handleClose = () => {
  emit('close');
};

const handleRunWorkflow = (workflow: Workflow) => {
  emit('run-workflow', workflow);
};

const handleDeleteWorkflow = (workflow: Workflow) => {
  if (confirm(`确定要删除工作流"${workflow.name}"吗？`)) {
    emit('delete-workflow', workflow);
  }
};

const handleEditWorkflow = (workflow: Workflow) => {
  emit('edit-workflow', workflow);
};

const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  const now = new Date();
  const diffTime = Math.abs(now.getTime() - date.getTime());
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays === 1) {
    return '今天';
  } else if (diffDays === 2) {
    return '昨天';
  } else if (diffDays <= 7) {
    return `${diffDays - 1}天前`;
  } else {
    return date.toLocaleDateString('zh-CN', {
      month: 'short',
      day: 'numeric'
    });
  }
};
</script>

<style scoped>
.workflow-card {
  position: fixed;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  width: 90%;
  max-width: 400px;
  background: #ffffff;
  border-radius: 16px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
  border: 1px solid #e5e7eb;
  overflow: hidden;
  backdrop-filter: blur(10px);
  transition: all 0.3s ease;
  z-index: 1000;
  color: #333;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  display: flex;
  flex-direction: column;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 24px 24px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.header-left {
  flex: 1;
}

.title-gradient {
  font-size: 18px;
  font-weight: 600;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.close-btn {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
  color: #666;
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.2);
  color: #333;
  transform: scale(1.05);
}

.card-body {
  flex: 1;
  padding: 0 24px 24px;
  overflow-y: auto;
}

.workflows-section {
  margin-top: 20px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: #333;
  margin: 0;
}

.workflows-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.empty-state {
  text-align: center;
  padding: 40px 20px;
  color: #666;
}

.empty-icon {
  margin-bottom: 16px;
  opacity: 0.5;
}

.empty-text {
  font-size: 16px;
  font-weight: 500;
  margin: 0 0 8px;
}

.empty-subtitle {
  font-size: 14px;
  margin: 0;
  opacity: 0.7;
}

.workflow-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 12px;
  transition: all 0.2s ease;
}

.workflow-item:hover {
  background: rgba(255, 255, 255, 0.15);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.workflow-info {
  flex: 1;
  min-width: 0;
}

.workflow-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.workflow-name {
  font-size: 14px;
  font-weight: 600;
  color: #333;
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.workflow-meta {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: #666;
}

.workflow-steps {
  background: rgba(102, 126, 234, 0.1);
  color: #667eea;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
}

.workflow-date {
  opacity: 0.7;
}

.workflow-description {
  font-size: 12px;
  color: #666;
  margin: 0;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.workflow-actions {
  display: flex;
  gap: 8px;
  margin-left: 12px;
}

.action-btn {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
}

.run-btn {
  background: rgba(34, 197, 94, 0.1);
  color: #22c55e;
  border: 1px solid rgba(34, 197, 94, 0.2);
}

.run-btn:hover {
  background: rgba(34, 197, 94, 0.2);
  transform: scale(1.05);
}

.edit-btn {
  background: rgba(59, 130, 246, 0.1);
  color: #3b82f6;
  border: 1px solid rgba(59, 130, 246, 0.2);
}

.edit-btn:hover {
  background: rgba(59, 130, 246, 0.2);
  transform: scale(1.05);
}

.delete-btn {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.2);
}

.delete-btn:hover {
  background: rgba(239, 68, 68, 0.2);
  transform: scale(1.05);
}

/* 滚动条样式 */
.card-body::-webkit-scrollbar {
  width: 6px;
}

.card-body::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
}

.card-body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.3);
  border-radius: 3px;
}

.card-body::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.5);
}
</style>