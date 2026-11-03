<template>
  <div v-if="isVisible" class="ai-task-modal-overlay" @click="handleOverlayClick">
    <div class="ai-task-modal" @click.stop>
      <!-- 模态框头部 -->
      <div class="modal-header">
        <h2 class="modal-title">插入 AI 步骤</h2>
        <button class="close-btn" @click="closeModal">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </div>

      <!-- AI类型选择 -->
      <div class="ai-type-section">
        <label class="section-label">AI 类型</label>
        <div class="ai-type-options">
          <label class="radio-option">
            <input 
              type="radio" 
              v-model="selectedAiType" 
              value="text"
              name="aiType"
            >
            <span class="radio-label">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M14,17H7V15H14M17,13H7V11H17M17,9H7V7H17M19,3H5C3.89,3 3,3.89 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C3.89,3 19,3.89 19,3Z"/>
              </svg>
              文本模型
            </span>
          </label>
          <label class="radio-option">
            <input 
              type="radio" 
              v-model="selectedAiType" 
              value="vision"
              name="aiType"
            >
            <span class="radio-label">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M9,3L7.17,5H4A2,2 0 0,0 2,7V19A2,2 0 0,0 4,21H20A2,2 0 0,0 22,19V7A2,2 0 0,0 20,5H16.83L15,3M12,18A5,5 0 0,1 7,13A5,5 0 0,1 12,8A5,5 0 0,1 17,13A5,5 0 0,1 12,18M12,10A3,3 0 0,0 9,13A3,3 0 0,0 12,16A3,3 0 0,0 15,13A3,3 0 0,0 12,10Z"/>
              </svg>
              视觉模型
            </span>
          </label>
        </div>
      </div>

      <!-- AI任务类型选择 -->
      <div class="task-type-section">
        <label class="section-label">AI 任务类型</label>
        <div class="task-type-grid">
          <div 
            v-for="taskType in availableTaskTypes" 
            :key="taskType.id"
            class="task-type-card"
            :class="{ selected: selectedTaskType === taskType.id }"
            @click="selectTaskType(taskType.id)"
          >
            <div class="task-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path :d="taskType.icon"/>
              </svg>
            </div>
            <div class="task-info">
              <h3 class="task-title">{{ taskType.title }}</h3>
              <p class="task-description">{{ taskType.description }}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- 任务配置区域 -->
      <div v-if="selectedTaskType" class="task-config-section">
        <!-- 页面内容处理 -->
        <div v-if="selectedTaskType === 'content_processing'" class="config-content">
          <div class="form-group">
            <label class="form-label">描述你的需求</label>
            <textarea 
              v-model="taskConfig.prompt"
              class="form-textarea"
              placeholder="请总结当前页面的核心观点，要求不超过200字，并以无序列表形式呈现。"
              rows="4"
            ></textarea>
          </div>
          <div class="form-group">
            <label class="form-label">存储结果到变量</label>
            <input 
              v-model="taskConfig.variableName"
              type="text"
              class="form-input"
              placeholder="例如：page_summary"
            >
            <p class="form-hint">这个变量名可以在后续步骤中引用</p>
          </div>
          <div class="preview-section">
            <button class="preview-btn" @click="handlePreviewResult" :disabled="isPreviewLoading">
              <svg v-if="!isPreviewLoading" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17M12,4.5C7,4.5 2.73,7.61 1,12C2.73,16.39 7,19.5 12,19.5C17,19.5 21.27,16.39 23,12C21.27,7.61 17,4.5 12,4.5Z"/>
              </svg>
              <div v-else class="loading-spinner"></div>
              {{ isPreviewLoading ? '预览中...' : '预览结果' }}
            </button>
            <div v-if="previewResult" class="preview-result">
              <h4>预览结果：</h4>
              <div class="preview-content">{{ previewResult }}</div>
            </div>
          </div>
        </div>

        <!-- 智能点击/跳转 -->
        <div v-if="selectedTaskType === 'smart_click'" class="config-content">
          <div class="form-group">
            <label class="form-label">你的目标是什么？</label>
            <textarea 
              v-model="taskConfig.goal"
              class="form-textarea"
              placeholder="点击'下一页'或者加载更多按钮。"
              rows="3"
            ></textarea>
          </div>
          <div class="demo-section">
            <label class="form-label">请示范一个例子</label>
            <p class="demo-hint">在屏幕右上角提示用户自己在页面上点击一个符合描述的元素，作为示例。</p>
            <button class="demo-btn" @click="startDemo" :disabled="isDemoMode">
              {{ isDemoMode ? '请在页面上点击示例元素...' : '开始示范' }}
            </button>
            <div v-if="demoElement" class="demo-result">
              <h4>示例元素：</h4>
              <div class="demo-info">
                <p><strong>元素类型：</strong>{{ demoElement.tagName }}</p>
                <p><strong>文本内容：</strong>{{ demoElement.text }}</p>
                <p><strong>选择器：</strong>{{ demoElement.selector }}</p>
              </div>
            </div>
          </div>
          <div v-if="demoElement" class="ai-understanding">
            <label class="form-label">AI 理解与确认</label>
            <div class="ai-feedback">
              <p>{{ aiUnderstanding }}</p>
            </div>
            <div class="form-group">
              <label class="form-label">修改描述（可选）</label>
              <textarea 
                v-model="taskConfig.refinedGoal"
                class="form-textarea"
                :placeholder="taskConfig.goal"
                rows="2"
              ></textarea>
            </div>
          </div>
        </div>

        <!-- 数据提取 -->
        <div v-if="selectedTaskType === 'data_extraction'" class="config-content">
          <div class="form-group">
            <label class="form-label">请描述需要提取的数据</label>
            <textarea 
              v-model="taskConfig.dataDescription"
              class="form-textarea"
              placeholder="提取页面中所有文章的标题、作者和发布时间"
              rows="3"
            ></textarea>
          </div>
          <div class="form-group">
            <label class="form-label">数据对象属性（可选）</label>
            <div class="attributes-list">
              <div 
                v-for="(attr, index) in taskConfig.attributes" 
                :key="index"
                class="attribute-item"
              >
                <input 
                  v-model="taskConfig.attributes[index]"
                  type="text"
                  class="attribute-input"
                  placeholder="属性名称"
                >
                <button class="remove-attr" @click="removeAttribute(index)">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                  </svg>
                </button>
              </div>
              <button class="add-attr" @click="addAttribute">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/>
                </svg>
                添加属性
              </button>
            </div>
          </div>
          <div class="test-section">
            <button class="test-btn" @click="testExtraction" :disabled="isTestLoading">
              <div v-if="isTestLoading" class="loading-spinner"></div>
              {{ isTestLoading ? '测试中...' : 'AI 提取测试' }}
            </button>
            <div v-if="extractionResult" class="test-result">
              <h4>提取结果：</h4>
              <pre class="result-content">{{ JSON.stringify(extractionResult, null, 2) }}</pre>
              <div class="test-actions">
                <button class="retry-btn" @click="retryExtraction">重新描述</button>
                <button class="accept-btn" @click="acceptExtraction">接受结果</button>
              </div>
            </div>
          </div>
        </div>

        <!-- 条件判断 -->
        <div v-if="selectedTaskType === 'condition_check'" class="config-content">
          <div class="form-group">
            <label class="form-label">描述你的判断条件</label>
            <textarea 
              v-model="taskConfig.condition"
              class="form-textarea"
              placeholder="如果页面上出现'404 Not Found'字样"
              rows="3"
            ></textarea>
          </div>
          <div class="form-group">
            <label class="form-label">如果条件满足，执行什么？(If True, Then...)</label>
            <select v-model="taskConfig.trueAction" class="form-select">
              <option value="">选择动作</option>
              <option value="terminate">终止工作流</option>
              <option value="continue">继续下一步</option>
              <option value="jump">跳转到指定步骤</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">如果条件不满足，执行什么？(Else If False, Then...)</label>
            <select v-model="taskConfig.falseAction" class="form-select">
              <option value="">选择动作</option>
              <option value="terminate">终止工作流</option>
              <option value="continue">继续下一步</option>
              <option value="jump">跳转到指定步骤</option>
            </select>
          </div>
        </div>
      </div>

      <!-- 模态框底部 -->
      <div class="modal-footer">
        <button class="cancel-btn" @click="closeModal">取消</button>
        <button 
          class="confirm-btn" 
          @click="confirmTask"
          :disabled="!canConfirm"
        >
          添加到工作流
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'

interface TaskConfig {
  // 页面内容处理
  prompt?: string
  variableName?: string
  
  // 智能点击/跳转
  goal?: string
  refinedGoal?: string
  
  // 数据提取
  dataDescription?: string
  attributes: string[]
  
  // 条件判断
  condition?: string
  trueAction?: string
  falseAction?: string
}

interface DemoElement {
  tagName: string
  text: string
  selector: string
}

const props = defineProps<{
  isVisible: boolean
}>()

const emit = defineEmits<{
  close: []
  confirm: [taskType: string, aiType: string, config: TaskConfig]
}>()

// 状态
const selectedAiType = ref('text')
const selectedTaskType = ref('')
const taskConfig = ref<TaskConfig>({ attributes: [] })
const isPreviewLoading = ref(false)
const previewResult = ref('')
const isDemoMode = ref(false)
const demoElement = ref<DemoElement | null>(null)
const aiUnderstanding = ref('')
const isTestLoading = ref(false)
const extractionResult = ref<any>(null)

// 任务类型定义
const taskTypes = [
  {
    id: 'content_processing',
    title: '页面内容处理',
    description: '对当前页面的文本内容进行总结、问答、翻译等',
    icon: 'M14,17H7V15H14M17,13H7V11H17M17,9H7V7H17M19,3H5C3.89,3 3,3.89 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C3.89,3 19,3.89 19,3Z',
    supportedAiTypes: ['text', 'vision']
  },
  {
    id: 'smart_click',
    title: '智能点击/跳转',
    description: '让 AI 根据用户的意图，智能地选择并点击页面上的某个元素',
    icon: 'M12,2A2,2 0 0,1 14,4C14,4.74 13.6,5.39 13,5.73V7H14A7,7 0 0,1 21,14H22A1,1 0 0,1 23,15V18A1,1 0 0,1 22,19H21V20A2,2 0 0,1 19,22H5A2,2 0 0,1 3,20V19H2A1,1 0 0,1 1,18V15A1,1 0 0,1 2,14H3A7,7 0 0,1 10,7H11V5.73C10.4,5.39 10,4.74 10,4A2,2 0 0,1 12,2M7.5,13A2.5,2.5 0 0,0 5,15.5A2.5,2.5 0 0,0 7.5,18A2.5,2.5 0 0,0 10,15.5A2.5,2.5 0 0,0 7.5,13M16.5,13A2.5,2.5 0 0,0 14,15.5A2.5,2.5 0 0,0 16.5,18A2.5,2.5 0 0,0 19,15.5A2.5,2.5 0 0,0 16.5,13Z',
    supportedAiTypes: ['text']
  },
  {
    id: 'data_extraction',
    title: '数据提取',
    description: '从列表页、表格或特定区域中批量提取结构化数据',
    icon: 'M12,3C7.58,3 4,4.79 4,7C4,9.21 7.58,11 12,11C16.42,11 20,9.21 20,7C20,4.79 16.42,3 12,3M4,9V12C4,14.21 7.58,16 12,16C16.42,16 20,14.21 20,12V9C20,11.21 16.42,13 12,13C7.58,13 4,11.21 4,9M4,14V17C4,19.21 7.58,21 12,21C16.42,21 20,19.21 20,17V14C20,16.21 16.42,18 12,18C7.58,18 4,16.21 4,14Z',
    supportedAiTypes: ['text', 'vision']
  },
  {
    id: 'condition_check',
    title: '条件判断',
    description: '根据页面内容或之前 AI 步骤的结果，决定工作流的分支走向',
    icon: 'M12,2L13.09,8.26L22,9L13.09,9.74L12,16L10.91,9.74L2,9L10.91,8.26L12,2M12,21L10.91,14.74L2,14L10.91,13.26L12,7L13.09,13.26L22,14L13.09,14.74L12,21Z',
    supportedAiTypes: ['text', 'vision']
  }
]

// 计算属性
const availableTaskTypes = computed(() => {
  return taskTypes.filter(type => 
    type.supportedAiTypes.includes(selectedAiType.value)
  )
})

const canConfirm = computed(() => {
  if (!selectedTaskType.value) return false
  
  switch (selectedTaskType.value) {
    case 'content_processing':
      return taskConfig.value.prompt && taskConfig.value.variableName
    case 'smart_click':
      return taskConfig.value.goal
    case 'data_extraction':
      return taskConfig.value.dataDescription
    case 'condition_check':
      return taskConfig.value.condition && taskConfig.value.trueAction && taskConfig.value.falseAction
    default:
      return false
  }
})

// 监听AI类型变化，重置任务类型选择
watch(selectedAiType, () => {
  selectedTaskType.value = ''
  taskConfig.value = { attributes: [] }
})

// 方法
const closeModal = () => {
  emit('close')
  resetModal()
}

const handleOverlayClick = () => {
  closeModal()
}

const selectTaskType = (taskType: string) => {
  selectedTaskType.value = taskType
  taskConfig.value = { attributes: [] }
  
  // 为数据提取初始化属性数组
  if (taskType === 'data_extraction') {
    taskConfig.value.attributes = ['']
  }
}

const handlePreviewResult = async () => {
  isPreviewLoading.value = true
  try {
    // TODO: 调用AI API进行预览
    await new Promise(resolve => setTimeout(resolve, 2000)) // 模拟API调用
    previewResult.value = '这是预览结果示例...'
  } catch (error) {
    console.error('预览失败:', error)
  } finally {
    isPreviewLoading.value = false
  }
}

const startDemo = () => {
  isDemoMode.value = true
  // TODO: 实现页面元素选择逻辑
  // 这里需要与content script通信，让用户在页面上选择元素
}

const addAttribute = () => {
  if (!taskConfig.value.attributes) {
    taskConfig.value.attributes = []
  }
  taskConfig.value.attributes.push('')
}

const removeAttribute = (index: number) => {
  if (taskConfig.value.attributes) {
    taskConfig.value.attributes.splice(index, 1)
  }
}

const testExtraction = async () => {
  isTestLoading.value = true
  try {
    // TODO: 调用AI API进行数据提取测试
    await new Promise(resolve => setTimeout(resolve, 3000)) // 模拟API调用
    extractionResult.value = {
      items: [
        { title: '示例文章1', author: '作者1', date: '2024-01-01' },
        { title: '示例文章2', author: '作者2', date: '2024-01-02' }
      ]
    }
  } catch (error) {
    console.error('提取测试失败:', error)
  } finally {
    isTestLoading.value = false
  }
}

const retryExtraction = () => {
  extractionResult.value = null
  // 回到第一步，让用户重新描述
}

const acceptExtraction = () => {
  // 接受提取结果，继续下一步
}

const confirmTask = () => {
  emit('confirm', selectedTaskType.value, selectedAiType.value, taskConfig.value)
  closeModal()
}

const resetModal = () => {
  selectedAiType.value = 'text'
  selectedTaskType.value = ''
  taskConfig.value = { attributes: [] }
  isPreviewLoading.value = false
  previewResult.value = ''
  isDemoMode.value = false
  demoElement.value = null
  aiUnderstanding.value = ''
  isTestLoading.value = false
  extractionResult.value = null
}
</script>

<style scoped>
.ai-task-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  z-index: 10001;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.ai-task-modal {
  background: white;
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
  max-width: 800px;
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 24px 24px 0;
  border-bottom: 1px solid #e5e7eb;
  margin-bottom: 24px;
}

.modal-title {
  font-size: 20px;
  font-weight: 600;
  color: #111827;
  margin: 0;
}

.close-btn {
  background: none;
  border: none;
  color: #6b7280;
  cursor: pointer;
  padding: 8px;
  border-radius: 6px;
  transition: all 0.2s;
}

.close-btn:hover {
  background: #f3f4f6;
  color: #374151;
}

.ai-type-section,
.task-type-section,
.task-config-section {
  padding: 0 24px 24px;
}

.section-label {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: #374151;
  margin-bottom: 12px;
}

.ai-type-options {
  display: flex;
  gap: 16px;
}

.radio-option {
  display: flex;
  align-items: center;
  cursor: pointer;
}

.radio-option input[type="radio"] {
  margin-right: 8px;
}

.radio-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  color: #374151;
}

.task-type-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
}

.task-type-card {
  border: 2px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  gap: 12px;
}

.task-type-card:hover {
  border-color: #d1d5db;
  background: #f9fafb;
}

.task-type-card.selected {
  border-color: #3b82f6;
  background: #eff6ff;
}

.task-icon {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  background: #f3f4f6;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #6b7280;
}

.task-type-card.selected .task-icon {
  background: #3b82f6;
  color: white;
}

.task-info {
  flex: 1;
}

.task-title {
  font-size: 16px;
  font-weight: 600;
  color: #111827;
  margin: 0 0 4px 0;
}

.task-description {
  font-size: 14px;
  color: #6b7280;
  margin: 0;
  line-height: 1.4;
}

.config-content {
  border-top: 1px solid #e5e7eb;
  padding-top: 24px;
}

.form-group {
  margin-bottom: 20px;
}

.form-label {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: #374151;
  margin-bottom: 8px;
}

.form-input,
.form-textarea,
.form-select {
  width: 100%;
  padding: 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 14px;
  transition: border-color 0.2s;
}

.form-input:focus,
.form-textarea:focus,
.form-select:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

.form-hint {
  font-size: 12px;
  color: #6b7280;
  margin-top: 4px;
}

.preview-section,
.demo-section,
.test-section {
  margin-top: 20px;
  padding: 16px;
  background: #f9fafb;
  border-radius: 8px;
}

.preview-btn,
.demo-btn,
.test-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: #3b82f6;
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
}

.preview-btn:hover,
.demo-btn:hover,
.test-btn:hover {
  background: #2563eb;
}

.preview-btn:disabled,
.demo-btn:disabled,
.test-btn:disabled {
  background: #9ca3af;
  cursor: not-allowed;
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid transparent;
  border-top: 2px solid currentColor;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.preview-result,
.demo-result,
.test-result {
  margin-top: 16px;
  padding: 12px;
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
}

.preview-content,
.result-content {
  font-size: 14px;
  color: #374151;
  white-space: pre-wrap;
  background: #f9fafb;
  padding: 12px;
  border-radius: 4px;
  margin-top: 8px;
}

.demo-hint {
  font-size: 12px;
  color: #6b7280;
  margin-bottom: 12px;
}

.demo-info p {
  margin: 4px 0;
  font-size: 12px;
}

.ai-feedback {
  padding: 12px;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 6px;
  margin-bottom: 16px;
}

.attributes-list {
  space-y: 8px;
}

.attribute-item {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.attribute-input {
  flex: 1;
}

.remove-attr {
  background: #fef2f2;
  color: #dc2626;
  border: 1px solid #fecaca;
  border-radius: 4px;
  padding: 8px;
  cursor: pointer;
}

.add-attr {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: #f3f4f6;
  color: #374151;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}

.add-attr:hover {
  background: #e5e7eb;
}

.test-actions {
  display: flex;
  gap: 12px;
  margin-top: 12px;
}

.retry-btn,
.accept-btn {
  padding: 8px 16px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}

.retry-btn {
  background: white;
  color: #374151;
}

.retry-btn:hover {
  background: #f9fafb;
}

.accept-btn {
  background: #10b981;
  color: white;
  border-color: #10b981;
}

.accept-btn:hover {
  background: #059669;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 24px;
  border-top: 1px solid #e5e7eb;
}

.cancel-btn,
.confirm-btn {
  padding: 10px 20px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.cancel-btn {
  background: white;
  color: #374151;
  border: 1px solid #d1d5db;
}

.cancel-btn:hover {
  background: #f9fafb;
}

.confirm-btn {
  background: #3b82f6;
  color: white;
  border: 1px solid #3b82f6;
}

.confirm-btn:hover {
  background: #2563eb;
}

.confirm-btn:disabled {
  background: #9ca3af;
  border-color: #9ca3af;
  cursor: not-allowed;
}

/* 滚动条样式 */
.ai-task-modal::-webkit-scrollbar {
  width: 6px;
}

.ai-task-modal::-webkit-scrollbar-track {
  background: #f1f5f9;
}

.ai-task-modal::-webkit-scrollbar-thumb {
  background: #cbd5e1;
  border-radius: 3px;
}

.ai-task-modal::-webkit-scrollbar-thumb:hover {
  background: #94a3b8;
}
</style>