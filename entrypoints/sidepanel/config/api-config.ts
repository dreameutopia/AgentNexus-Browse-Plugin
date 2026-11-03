// API配置
export const API_CONFIG = {
  // 基础URL
  baseUrl: 'http://localhost:52725',
  
  // 请求超时时间
  timeout: 1000000,
  
  // API版本
  version: 'v1',
  
  // API端点
  endpoints: {
    // 用户相关
    user: {
      profile: '/api/v1/user',
      updateProfile: '/api/v1/user'
    }
  }
}

// 获取完整的API URL
export const getApiUrl = (endpoint: string): string => {
  return `${API_CONFIG.baseUrl}${endpoint}`
}

// 导出配置供其他模块使用
export default API_CONFIG