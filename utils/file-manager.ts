/**
 * 文件管理引擎
 * 提供文件的持久化存储、管理和操作功能
 * 每个文件都有一个8位唯一字符ID
 */

export interface ManagedFile {
  id: string; // 8位唯一字符ID
  name: string; // 文件名
  content: string | ArrayBuffer; // 文件内容
  type: string; // MIME类型
  size: number; // 文件大小（字节）
  createdAt: number; // 创建时间戳
  updatedAt: number; // 更新时间戳
  metadata?: Record<string, any>; // 额外元数据
}

export interface FileManagerStats {
  totalFiles: number;
  totalSize: number;
  oldestFile?: ManagedFile;
  newestFile?: ManagedFile;
}

/** ArrayBuffer → base64（分块避免超长参数列表） */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** base64 → ArrayBuffer */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** 反序列化导出格式中的 content（兼容旧的纯字符串格式） */
function deserializeFileContent(value: unknown): string | ArrayBuffer | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const wrapped = value as { __t?: unknown; v?: unknown };
    if (wrapped.__t === 'text' && typeof wrapped.v === 'string') return wrapped.v;
    if (wrapped.__t === 'bin' && typeof wrapped.v === 'string') {
      try {
        return base64ToArrayBuffer(wrapped.v);
      } catch {
        return null;
      }
    }
  }
  return null;
}

class FileManagerEngine {
  private static instance: FileManagerEngine;
  private readonly STORAGE_KEY = 'file_manager_files';
  private readonly ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  private files: Map<string, ManagedFile> = new Map();
  private initialized = false;

  private constructor() {}

  static getInstance(): FileManagerEngine {
    if (!FileManagerEngine.instance) {
      FileManagerEngine.instance = new FileManagerEngine();
    }
    return FileManagerEngine.instance;
  }

  /**
   * 初始化文件管理器，从存储中加载文件
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const stored = await this.getFromStorage();
      if (stored) {
        // 将存储的数据转换为Map
        Object.entries(stored).forEach(([id, file]) => {
          this.files.set(id, file as ManagedFile);
        });
      }
      this.initialized = true;
    } catch (error) {
      console.error('Failed to initialize file manager:', error);
      this.initialized = true; // 即使失败也标记为已初始化
    }
  }

  /**
   * 生成8位唯一字符ID
   */
  private generateId(): string {
    let id: string;
    do {
      id = '';
      for (let i = 0; i < 8; i++) {
        id += this.ID_CHARS.charAt(Math.floor(Math.random() * this.ID_CHARS.length));
      }
    } while (this.files.has(id)); // 确保ID唯一
    return id;
  }

  /**
   * 从Chrome存储中获取数据
   */
  private async getFromStorage(): Promise<Record<string, ManagedFile> | null> {
    return new Promise((resolve) => {
      chrome.storage.local.get([this.STORAGE_KEY], (result) => {
        resolve(result[this.STORAGE_KEY] || null);
      });
    });
  }

  /**
   * 保存数据到Chrome存储
   */
  private async saveToStorage(): Promise<void> {
    const data = Object.fromEntries(this.files);
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [this.STORAGE_KEY]: data }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * 添加文件
   */
  async addFile(
    name: string,
    content: string | ArrayBuffer,
    type: string,
    metadata?: Record<string, any>
  ): Promise<string> {
    await this.initialize();

    const id = this.generateId();
    const now = Date.now();
    const size = typeof content === 'string' ? 
      new Blob([content]).size : 
      content.byteLength;

    const file: ManagedFile = {
      id,
      name,
      content,
      type,
      size,
      createdAt: now,
      updatedAt: now,
      metadata
    };

    this.files.set(id, file);
    await this.saveToStorage();
    return id;
  }

  /**
   * 获取文件
   */
  async getFile(id: string): Promise<ManagedFile | null> {
    await this.initialize();
    return this.files.get(id) || null;
  }

  /**
   * 获取所有文件列表（不包含内容，减少内存占用）
   */
  async getFileList(): Promise<Omit<ManagedFile, 'content'>[]> {
    await this.initialize();
    return Array.from(this.files.values()).map(file => ({
      id: file.id,
      name: file.name,
      type: file.type,
      size: file.size,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      metadata: file.metadata
    }));
  }

  /**
   * 获取所有文件列表（getAllFiles 是 getFileList 的别名，
   * FileAPI / 设置页历史代码按这个名字调用）
   */
  async getAllFiles(): Promise<Omit<ManagedFile, 'content'>[]> {
    return this.getFileList();
  }

  /**
   * 更新文件
   */
  async updateFile(
    id: string,
    updates: Partial<Pick<ManagedFile, 'name' | 'content' | 'type' | 'metadata'>>
  ): Promise<boolean> {
    await this.initialize();
    
    const file = this.files.get(id);
    if (!file) return false;

    const updatedFile: ManagedFile = {
      ...file,
      ...updates,
      updatedAt: Date.now()
    };

    // 如果内容更新了，重新计算大小
    if (updates.content !== undefined) {
      updatedFile.size = typeof updates.content === 'string' ? 
        new Blob([updates.content]).size : 
        updates.content.byteLength;
    }

    this.files.set(id, updatedFile);
    await this.saveToStorage();
    return true;
  }

  /**
   * 删除文件
   */
  async deleteFile(id: string): Promise<boolean> {
    await this.initialize();
    
    const deleted = this.files.delete(id);
    if (deleted) {
      await this.saveToStorage();
    }
    return deleted;
  }

  /**
   * 删除所有文件
   */
  async deleteAllFiles(): Promise<void> {
    await this.initialize();
    this.files.clear();
    await this.saveToStorage();
  }

  /**
   * 清空所有文件（clearAll 是 deleteAllFiles 的别名，
   * FileAPI / 设置页历史代码按这个名字调用）
   */
  async clearAll(): Promise<void> {
    await this.deleteAllFiles();
  }

  /**
   * 导出全部文件为 JSON 字符串
   * ArrayBuffer 内容会 base64 编码，保证 JSON 序列化不丢数据
   */
  async exportData(): Promise<string> {
    await this.initialize();
    const files = Array.from(this.files.values()).map((file) => ({
      ...file,
      content: typeof file.content === 'string'
        ? { __t: 'text', v: file.content }
        : { __t: 'bin', v: arrayBufferToBase64(file.content) }
    }));
    return JSON.stringify({ version: 1, exportedAt: Date.now(), files }, null, 2);
  }

  /**
   * 导入 exportData 产出的 JSON 字符串（同 id 覆盖）
   */
  async importData(data: string): Promise<void> {
    await this.initialize();
    const parsed = JSON.parse(data) as { files?: unknown[] } | unknown[];
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.files) ? parsed.files : []);
    const now = Date.now();

    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const file = raw as Partial<ManagedFile> & { content?: unknown };
      if (typeof file.id !== 'string' || typeof file.name !== 'string') continue;

      const content = deserializeFileContent(file.content);
      if (content === null) continue;

      this.files.set(file.id, {
        id: file.id,
        name: file.name,
        content,
        type: typeof file.type === 'string' ? file.type : 'application/octet-stream',
        size: typeof content === 'string' ? new Blob([content]).size : content.byteLength,
        createdAt: typeof file.createdAt === 'number' ? file.createdAt : now,
        updatedAt: typeof file.updatedAt === 'number' ? file.updatedAt : now,
        metadata: file.metadata
      });
    }

    await this.saveToStorage();
  }

  /**
   * 获取文件管理器统计信息
   */
  async getStats(): Promise<FileManagerStats> {
    await this.initialize();
    
    const files = Array.from(this.files.values());
    const totalFiles = files.length;
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    
    let oldestFile: ManagedFile | undefined;
    let newestFile: ManagedFile | undefined;
    
    if (files.length > 0) {
      oldestFile = files.reduce((oldest, file) => 
        file.createdAt < oldest.createdAt ? file : oldest
      );
      newestFile = files.reduce((newest, file) => 
        file.createdAt > newest.createdAt ? file : newest
      );
    }

    return {
      totalFiles,
      totalSize,
      oldestFile,
      newestFile
    };
  }

  /**
   * 导出文件到本地下载
   */
  async exportFile(id: string): Promise<boolean> {
    const file = await this.getFile(id);
    if (!file) return false;

    try {
      let blob: Blob;
      if (typeof file.content === 'string') {
        blob = new Blob([file.content], { type: file.type });
      } else {
        blob = new Blob([file.content], { type: file.type });
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      return true;
    } catch (error) {
      console.error('Failed to export file:', error);
      return false;
    }
  }

  /**
   * 检查文件是否存在
   */
  async hasFile(id: string): Promise<boolean> {
    await this.initialize();
    return this.files.has(id);
  }

  /**
   * 根据名称搜索文件
   */
  async searchFiles(query: string): Promise<Omit<ManagedFile, 'content'>[]> {
    const fileList = await this.getFileList();
    const lowerQuery = query.toLowerCase();
    
    return fileList.filter(file => 
      file.name.toLowerCase().includes(lowerQuery) ||
      file.type.toLowerCase().includes(lowerQuery) ||
      (file.metadata && JSON.stringify(file.metadata).toLowerCase().includes(lowerQuery))
    );
  }
}

// 导出文件管理器实例
export const fileManager = FileManagerEngine.getInstance();

// 导出便捷函数（与file-api.ts中的函数名称相同但实现不同）
export const addFileToManager = (name: string, content: string | ArrayBuffer, type: string, metadata?: Record<string, any>) => 
  fileManager.addFile(name, content, type, metadata);

export const getFileFromManager = (id: string) => fileManager.getFile(id);

export const getFileList = () => fileManager.getFileList();

export const updateFileInManager = (id: string, updates: Partial<Pick<ManagedFile, 'name' | 'content' | 'type' | 'metadata'>>) => 
  fileManager.updateFile(id, updates);

export const deleteFileFromManager = (id: string) => fileManager.deleteFile(id);

export const deleteAllFiles = () => fileManager.deleteAllFiles();

export const getFileStats = () => fileManager.getStats();

export const exportFile = (id: string) => fileManager.exportFile(id);

export const hasFile = (id: string) => fileManager.hasFile(id);

export const searchFiles = (query: string) => fileManager.searchFiles(query);