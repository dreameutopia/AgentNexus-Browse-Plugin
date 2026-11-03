import { ref, reactive } from 'vue'

export interface ToastMessage {
  id: string
  message: string
  type: 'success' | 'error' | 'warning' | 'info'
  duration?: number
}

const messages = ref<ToastMessage[]>([])

let messageId = 0

const generateId = () => {
  return `toast_${++messageId}_${Date.now()}`
}

export const useMessage = () => {
  const showMessage = (message: string, type: ToastMessage['type'] = 'info', duration = 3000) => {
    const id = generateId()
    const toast: ToastMessage = {
      id,
      message,
      type,
      duration
    }
    
    messages.value.push(toast)
    
    // 自动移除消息
    if (duration > 0) {
      setTimeout(() => {
        removeMessage(id)
      }, duration)
    }
    
    return id
  }
  
  const removeMessage = (id: string) => {
    const index = messages.value.findIndex(msg => msg.id === id)
    if (index > -1) {
      messages.value.splice(index, 1)
    }
  }
  
  const success = (message: string, duration?: number) => {
    return showMessage(message, 'success', duration)
  }
  
  const error = (message: string, duration?: number) => {
    return showMessage(message, 'error', duration)
  }
  
  const warning = (message: string, duration?: number) => {
    return showMessage(message, 'warning', duration)
  }
  
  const info = (message: string, duration?: number) => {
    return showMessage(message, 'info', duration)
  }
  
  const clear = () => {
    messages.value = []
  }
  
  return {
    messages,
    showMessage,
    removeMessage,
    success,
    error,
    warning,
    info,
    clear
  }
}

// 全局消息实例
export const message = useMessage()