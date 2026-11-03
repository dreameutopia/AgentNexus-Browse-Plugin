/**
 * 文件管理API接口
 * 提供统一的文件管理API，供其他组件和文件使用
 */

import { fileManager, type ManagedFile } from './file-manager'

/**
 * 文件上传选项
 */
export interface FileUploadOptions {
  /** 文件名（可选，如果不提供则使用原文件名） */
  name?: string
  /** 文件类型（可选，如果不提供则自动检测） */
  type?: string
  /** 是否覆盖同名文件 */
  overwrite?: boolean
}

/**
 * 文件查询选项
 */
export interface FileQueryOptions {
  /** 搜索关键词（匹配文件名或ID） */
  search?: string
  /** 文件类型过滤 */
  type?: string
  /** 排序方式 */
  sortBy?: 'name' | 'size' | 'createdAt' | 'updatedAt'
  /** 排序顺序 */
  sortOrder?: 'asc' | 'desc'
  /** 分页：页码（从1开始） */
  page?: number
  /** 分页：每页数量 */
  pageSize?: number
}

/**
 * 文件查询结果
 */
export interface FileQueryResult {
  /** 文件列表 */
  files: Omit<ManagedFile, 'content'>[]
  /** 总数量 */
  total: number
  /** 当前页码 */
  page: number
  /** 每页数量 */
  pageSize: number
  /** 总页数 */
  totalPages: number
}

/**
 * 文件管理API类
 */
export class FileAPI {
  /**
   * 添加文件（从File对象）
   */
  static async addFile(file: File, options: FileUploadOptions = {}): Promise<string> {
    const content = await this.fileToArrayBuffer(file)
    const fileName = options.name || file.name
    const fileType = options.type || file.type
    
    // 检查是否存在同名文件
    if (!options.overwrite) {
      const existingFiles = await fileManager.getAllFiles()
      const existingFile = existingFiles.find(f => f.name === fileName)
      if (existingFile) {
        throw new Error(`文件 "${fileName}" 已存在，请使用不同的文件名或启用覆盖选项`)
      }
    }
    
    return await fileManager.addFile(fileName, content, fileType)
  }
  
  /**
   * 添加文件（从内容）
   */
  static async addFileFromContent(
    name: string, 
    content: string | ArrayBuffer, 
    type: string = 'text/plain'
  ): Promise<string> {
    let buffer: ArrayBuffer
    if (typeof content === 'string') {
      buffer = new TextEncoder().encode(content).buffer
    } else {
      buffer = content
    }
    
    return await fileManager.addFile(name, buffer, type)
  }
  
  /**
   * 获取文件
   */
  static async getFile(id: string): Promise<ManagedFile | null> {
    return await fileManager.getFile(id)
  }
  
  /**
   * 获取文件内容（作为文本）
   */
  static async getFileAsText(id: string): Promise<string | null> {
    const file = await fileManager.getFile(id)
    if (!file) return null
    
    if (typeof file.content === 'string') return file.content
    return new TextDecoder().decode(file.content)
  }
  
  /**
   * 获取文件内容（作为Blob）
   */
  static async getFileAsBlob(id: string): Promise<Blob | null> {
    const file = await fileManager.getFile(id)
    if (!file) return null
    
    return new Blob([file.content], { type: file.type })
  }
  
  /**
   * 查询文件列表
   */
  static async queryFiles(options: FileQueryOptions = {}): Promise<FileQueryResult> {
    const allFiles = await fileManager.getAllFiles()
    let filteredFiles = allFiles.map(file => ({
      id: file.id,
      name: file.name,
      size: file.size,
      type: file.type,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt
    }))
    
    // 搜索过滤
    if (options.search) {
      const query = options.search.toLowerCase()
      filteredFiles = filteredFiles.filter(file => 
        file.name.toLowerCase().includes(query) || 
        file.id.toLowerCase().includes(query)
      )
    }
    
    // 类型过滤
    if (options.type) {
      filteredFiles = filteredFiles.filter(file => 
        file.type.includes(options.type!)
      )
    }
    
    // 排序
    const sortBy = options.sortBy || 'createdAt'
    const sortOrder = options.sortOrder || 'desc'
    filteredFiles.sort((a, b) => {
      let aValue: any = a[sortBy]
      let bValue: any = b[sortBy]
      
      if (sortBy === 'createdAt' || sortBy === 'updatedAt') {
        aValue = aValue.getTime()
        bValue = bValue.getTime()
      }
      
      if (sortOrder === 'asc') {
        return aValue > bValue ? 1 : -1
      } else {
        return aValue < bValue ? 1 : -1
      }
    })
    
    // 分页
    const page = options.page || 1
    const pageSize = options.pageSize || 50
    const startIndex = (page - 1) * pageSize
    const endIndex = startIndex + pageSize
    const paginatedFiles = filteredFiles.slice(startIndex, endIndex)
    
    return {
      files: paginatedFiles,
      total: filteredFiles.length,
      page,
      pageSize,
      totalPages: Math.ceil(filteredFiles.length / pageSize)
    }
  }
  
  /**
   * 删除文件
   */
  static async deleteFile(id: string): Promise<boolean> {
    return await fileManager.deleteFile(id)
  }
  
  /**
   * 批量删除文件
   */
  static async deleteFiles(ids: string[]): Promise<{ success: string[], failed: string[] }> {
    const success: string[] = []
    const failed: string[] = []
    
    for (const id of ids) {
      try {
        const result = await fileManager.deleteFile(id)
        if (result) {
          success.push(id)
        } else {
          failed.push(id)
        }
      } catch (error) {
        failed.push(id)
      }
    }
    
    return { success, failed }
  }
  
  /**
   * 清空所有文件
   */
  static async clearAllFiles(): Promise<void> {
    await fileManager.clearAll()
  }
  
  /**
   * 获取文件统计信息
   */
  static async getStats() {
    return await fileManager.getStats()
  }
  
  /**
   * 下载文件到本地
   */
  static async downloadFile(id: string, filename?: string): Promise<void> {
    const file = await fileManager.getFile(id)
    if (!file) {
      throw new Error('文件不存在')
    }
    
    const blob = new Blob([file.content], { type: file.type || 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename || file.name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }
  
  /**
   * 批量下载文件（打包为ZIP）
   */
  static async downloadFilesAsZip(ids: string[], zipName: string = 'files.zip'): Promise<void> {
    // 注意：这里需要引入JSZip库，暂时提供接口定义
    throw new Error('批量下载功能需要JSZip库支持，请先安装相关依赖')
  }
  
  /**
   * 导出所有文件数据
   */
  static async exportAllFiles(): Promise<string> {
    return await fileManager.exportData()
  }
  
  /**
   * 导入文件数据
   */
  static async importFiles(data: string): Promise<void> {
    await fileManager.importData(data)
  }
  
  /**
   * 检查文件是否存在
   */
  static async fileExists(id: string): Promise<boolean> {
    const file = await fileManager.getFile(id)
    return file !== null
  }
  
  /**
   * 根据文件名查找文件
   */
  static async findFileByName(name: string): Promise<Omit<ManagedFile, 'content'> | null> {
    const files = await fileManager.getAllFiles()
    const file = files.find(f => f.name === name)
    if (!file) return null
    
    return {
      id: file.id,
      name: file.name,
      size: file.size,
      type: file.type,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt
    }
  }
  
  /**
   * 更新文件内容
   */
  static async updateFile(id: string, content: string | ArrayBuffer, type?: string): Promise<boolean> {
    // 先删除旧文件
    const oldFile = await fileManager.getFile(id)
    if (!oldFile) return false
    
    await fileManager.deleteFile(id)
    
    // 添加新文件（使用相同的ID和名称）
    let buffer: ArrayBuffer
    if (typeof content === 'string') {
      buffer = new TextEncoder().encode(content).buffer
    } else {
      buffer = content
    }
    
    const newId = await fileManager.addFile(oldFile.name, buffer, type || oldFile.type)
    return newId === id // 理论上应该生成新的ID，这里只是示例
  }
  
  /**
   * 工具方法：将File对象转换为ArrayBuffer
   */
  private static fileToArrayBuffer(file: File): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(file)
    })
  }
}

// 导出便捷函数
export const fileAPI = FileAPI

// 导出函数别名（避免与file-manager.ts重复）
export const addFile = FileAPI.addFile.bind(FileAPI)
export const addFileFromContent = FileAPI.addFileFromContent.bind(FileAPI)
export const getFile = FileAPI.getFile.bind(FileAPI)
export const getFileAsText = FileAPI.getFileAsText.bind(FileAPI)
export const getFileAsBlob = FileAPI.getFileAsBlob.bind(FileAPI)
export const queryFiles = FileAPI.queryFiles.bind(FileAPI)
export const deleteFile = FileAPI.deleteFile.bind(FileAPI)
export const deleteFiles = FileAPI.deleteFiles.bind(FileAPI)
export const clearAllFiles = FileAPI.clearAllFiles.bind(FileAPI)
export const downloadFile = FileAPI.downloadFile.bind(FileAPI)
export const exportAllFiles = FileAPI.exportAllFiles.bind(FileAPI)
export const importFiles = FileAPI.importFiles.bind(FileAPI)
export const fileExists = FileAPI.fileExists.bind(FileAPI)
export const findFileByName = FileAPI.findFileByName.bind(FileAPI)
export const updateFile = FileAPI.updateFile.bind(FileAPI)