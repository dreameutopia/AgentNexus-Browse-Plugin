import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import { message } from '../chat/message'
import { API_CONFIG } from '../../config/api-config'

// API响应数据格式
export interface ApiResponse<T = any> {
  code: number
  message: string
  data?: T
}

// 创建axios实例
const createAxiosInstance = (): AxiosInstance => {
  const instance = axios.create({
    baseURL: API_CONFIG.baseUrl,
    timeout: API_CONFIG.timeout,
    headers: {
      'Content-Type': 'application/json'
    }
  })

  // 请求拦截器
  instance.interceptors.request.use(
    (config) => {
      return config
    },
    (error) => {
      return Promise.reject(error)
    }
  )

  // 响应拦截器
  instance.interceptors.response.use(
    (response: AxiosResponse<ApiResponse>) => {
      const { data } = response
      
      // 检查业务状态码
      if (data && typeof data === 'object' && 'code' in data) {
        if (data.code !== 200) {
          // 业务失败，显示错误消息
          const errorMsg = data.message || '请求失败'
          message.error(errorMsg)
          return Promise.reject(new Error(errorMsg))
        }
      }
      
      return response
    },
    (error) => {
      // HTTP状态码错误处理
      let errorMessage = '未知错误，请求失败'
      
      if (error.response) {
        // 服务器响应了错误状态码
        const { status, data } = error.response
        
        switch (status) {
          case 400:
            errorMessage = '请求参数错误'
            break
          case 401:
            errorMessage = '未授权，请重新登录'
            break
          case 403:
            errorMessage = '拒绝访问'
            break
          case 404:
            errorMessage = '请求的资源不存在'
            break
          case 500:
            errorMessage = '服务器内部错误'
            break
          default:
            errorMessage = data?.message || `请求失败 (${status})`
        }
      } else if (error.request) {
        // 请求已发出但没有收到响应
        errorMessage = '网络连接失败，请检查网络'
      } else {
        // 其他错误
        errorMessage = error.message || '未知错误，请求失败'
      }
      
      // 显示错误消息
      message.error(errorMessage)
      
      return Promise.reject(error)
    }
  )

  return instance
}

// 创建请求实例
const request = createAxiosInstance()

// 封装常用的请求方法
export const http = {
  get: <T = any>(url: string, config?: AxiosRequestConfig): Promise<ApiResponse<T>> => {
    return request.get(url, config).then(res => res.data)
  },
  
  post: <T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<ApiResponse<T>> => {
    return request.post(url, data, config).then(res => res.data)
  },
  
  put: <T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<ApiResponse<T>> => {
    return request.put(url, data, config).then(res => res.data)
  },
  
  delete: <T = any>(url: string, config?: AxiosRequestConfig): Promise<ApiResponse<T>> => {
    return request.delete(url, config).then(res => res.data)
  },
  
  patch: <T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<ApiResponse<T>> => {
    return request.patch(url, data, config).then(res => res.data)
  }
}

export default request