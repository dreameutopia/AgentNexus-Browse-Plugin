import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

/**
 * 文件上传工具
 */
export class FileUploaderTool extends BaseTool {
  name = 'file_uploader';

  private static readonly detachDelayMs = 10_000;
  private static readonly attachedTabs = new Set<number>();
  private static readonly detachTimers = new Map<number, number>();
  
  metadata: ToolMetadata = {
    name: 'file_uploader',
    description: '智能文件上传工具，支持标准 Input 及复杂的自定义上传组件',
    category: 'automation',
    version: '2.0.0',
    author: 'AgentNexus',
    tags: ['automation', 'upload', 'file', 'input', 'cdp']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'file_uploader',
      description: '上传文件到网页。自动处理隐藏的文件输入框和自定义上传按钮。',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: '目标元素选择器（优先使用 file_upload_getter 返回的 targetSelector）'
          },
          filePath: {
            type: 'string',
            description: '要上传的文件的完整路径（Windows格式，如：C:\\Users\\user\\file.pdf）'
          },
          frameId: {
            type: 'number',
            description: '元素所在的frame ID，默认为0（主frame）',
            default: 0
          }
        },
        required: ['selector', 'filePath']
      }
    }
  };

  /**
   * 读取文件并转换为 base64
   */
  private async readFileAsBase64(filePath: string): Promise<{ success: boolean; data?: string; mimeType?: string; error?: string }> {
    try {
      // 使用 fetch API 读取本地文件（通过 file:// 协议）
      // 注意：这需要扩展有相应的权限
      const fileUrl = filePath.startsWith('file://') ? filePath : `file:///${filePath.replace(/\\/g, '/')}`;
      
      this.log(`尝试读取文件: ${fileUrl}`);
      
      // Chrome 扩展环境中，我们需要通过其他方式处理
      // 这里返回文件路径，让注入脚本直接使用
      return {
        success: true,
        data: filePath,
        mimeType: this.getMimeType(filePath)
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * 根据文件扩展名获取 MIME 类型
   */
  private getMimeType(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      'pdf': 'application/pdf',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xls': 'application/vnd.ms-excel',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'txt': 'text/plain',
      'zip': 'application/zip',
      'rar': 'application/x-rar-compressed'
    };
    return mimeTypes[ext || ''] || 'application/octet-stream';
  }

  async execute(args: { selector: string; filePath: string; frameId?: number }): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const { selector, filePath, frameId = 0 } = args;

      if (!selector || !filePath) {
        return this.createErrorResponse('Missing required parameters: selector and filePath');
      }

      this.log(`开始上传文件操作 (v2.0)...`);
      this.log(`选择器: ${selector}`);
      this.log(`文件路径: ${filePath}`);
      this.log(`Frame ID: ${frameId}`);

      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0] || !tabs[0].id) {
        return this.createErrorResponse('No active tab with ID found');
      }
      const tabId = tabs[0].id;

      // 1. 从后端获取文件数据
      this.log('从后端请求文件数据...');
      let fileData: ArrayBuffer;
      let fileName: string;
      
      try {
        // 动态导入 backgroundWebSocket
        const { backgroundWebSocket } = await import('@/entrypoints/background/ws/websocket-background');
        
        // 检查 WebSocket 是否连接
        if (!backgroundWebSocket.isConnected()) {
          return this.createErrorResponse(
            'WebSocket 未连接到后端。请确保后端服务已启动且浏览器已自动连接。无法从后端获取文件: ' + filePath
          );
        }
        
        // 请求后端发送文件
        const result = await backgroundWebSocket.requestFileFromBackend(filePath, 30000);
        fileData = result.data;
        fileName = result.fileName;
        this.log(`成功从后端获取文件: ${fileName}, 大小: ${fileData.byteLength} 字节`);
      } catch (error) {
        return this.createErrorResponse(
          `从后端获取文件失败: ${error instanceof Error ? error.message : String(error)}`,
          error
        );
      }

      // 2. 使用从后端获取的文件数据进行上传
      this.log('使用文件数据进行上传...');

      await this.ensureDebuggerAttached(tabId);

      await chrome.debugger.sendCommand({ tabId }, 'DOM.enable');
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');

      const { root } = await chrome.debugger.sendCommand(
        { tabId },
        'DOM.getDocument',
        { depth: -1, pierce: true }
      ) as any;

      const targetNodeId = await this.findTargetInputNodeId(tabId, root.nodeId, selector, frameId);

      // 方案1：优先使用 CDP setFileInputFiles（最可靠）
      if (targetNodeId) {
        this.log(`尝试使用 CDP setFileInputFiles 上传，nodeId=${targetNodeId}...`);
        const cdpResult = await this.uploadViaCDP(tabId, targetNodeId, fileData, fileName, filePath);
        if (cdpResult.success) {
          const duration = Date.now() - startTime;
          this.log(`CDP 上传成功，耗时: ${duration}ms`);
          return this.createSuccessResponse(
            {
              selector,
              filePath,
              frameId,
              inputNodeId: targetNodeId,
              method: 'cdp'
            },
            `Successfully uploaded file via CDP for selector ${selector}`
          );
        }
        this.log(`CDP 上传失败: ${cdpResult.error}，尝试 DataTransfer 方式...`);
      }

      // 方案2：DataTransfer 方式上传（从后端获取的文件数据）
      const uploadResult = await this.uploadFileDataToElement(
        tabId,
        selector,
        fileData,
        fileName,
        targetNodeId
      );
      
      if (!uploadResult.success) {
        return this.createErrorResponse(
          `文件上传失败: ${uploadResult.error || 'unknown error'}. selector=${selector}`
        );
      }

      const duration = Date.now() - startTime;
      this.log(`上传完成，耗时: ${duration}ms`);

      return this.createSuccessResponse(
        {
          selector,
          filePath,
          frameId,
          inputNodeId: targetNodeId || null
        },
        `Successfully uploaded file for selector ${selector}`
      );

    } catch (error) {
      const duration = Date.now() - startTime;
      this.log(`上传失败，耗时: ${duration}ms`, 'error');
      return this.createErrorResponse('文件上传失败', error);
    } finally {
      try {
        if (typeof (chrome as any)?.debugger !== 'undefined') {
          this.scheduleDebuggerDetach();
        }
      } catch {
        // 清理阶段不因调度分离失败而掩盖上传结果
      }
    }
  }

  private async ensureDebuggerAttached(tabId: number): Promise<void> {
    const existingTimer = FileUploaderTool.detachTimers.get(tabId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      FileUploaderTool.detachTimers.delete(tabId);
    }

    if (FileUploaderTool.attachedTabs.has(tabId)) return;

    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      FileUploaderTool.attachedTabs.add(tabId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('Another debugger is already attached') || message.includes('Already attached')) {
        FileUploaderTool.attachedTabs.add(tabId);
        return;
      }
      throw error;
    }
  }

  private scheduleDebuggerDetach(): void {
    chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      const tabId = tabs[0]?.id;
      if (!tabId) return;

      const existingTimer = FileUploaderTool.detachTimers.get(tabId);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(async () => {
        try {
          await chrome.debugger.detach({ tabId });
        } catch {
          // 目标可能已自行分离/关闭，重复 detach 报错可安全忽略
        }
        FileUploaderTool.attachedTabs.delete(tabId);
        FileUploaderTool.detachTimers.delete(tabId);
      }, FileUploaderTool.detachDelayMs) as unknown as number;

      FileUploaderTool.detachTimers.set(tabId, timer);
    }).catch(() => {});
  }

  /**
   * 使用 CDP 方式上传文件（最可靠）
   * 通过 IO.read 和 DOM.setFileInputFiles 直接设置文件
   */
  private async uploadViaCDP(
    tabId: number,
    nodeId: number,
    fileData: ArrayBuffer,
    fileName: string,
    originalFilePath: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 1. 获取 backendNodeId
      const nodeInfo = await chrome.debugger.sendCommand(
        { tabId },
        'DOM.describeNode',
        { nodeId }
      ) as any;
      
      const backendNodeId = nodeInfo?.node?.backendNodeId;
      if (!backendNodeId) {
        return { success: false, error: 'cannot get backendNodeId' };
      }

      // 2. 验证是否是 file input
      const nodeName = nodeInfo?.node?.nodeName?.toUpperCase();
      const attrs = nodeInfo?.node?.attributes || [];
      let isFileInput = nodeName === 'INPUT';
      for (let i = 0; i < attrs.length; i += 2) {
        if (attrs[i] === 'type' && attrs[i + 1] === 'file') {
          isFileInput = true;
          break;
        }
      }
      
      if (!isFileInput) {
        return { success: false, error: 'target is not a file input' };
      }

      // 3. 使用 CDP setFileInputFiles - 直接用原始文件路径
      // 这是最可靠的方式，CDP 会直接读取本地文件
      try {
        await chrome.debugger.sendCommand(
          { tabId },
          'DOM.setFileInputFiles',
          {
            files: [originalFilePath],
            backendNodeId
          }
        );
        
        // 4. 触发事件确保框架响应
        await this.dispatchUploadEvents(tabId, nodeId);
        
        return { success: true };
      } catch (cdpError) {
        // CDP 直接读取文件失败，可能是权限问题
        this.log(`CDP setFileInputFiles 失败: ${cdpError}，尝试通过 Blob URL 方式...`);
        
        // 5. 备选方案：通过页面注入文件数据
        return await this.uploadViaPageInjection(tabId, nodeId, fileData, fileName);
      }
    } catch (error) {
      return { 
        success: false, 
        error: `CDP upload error: ${error instanceof Error ? error.message : String(error)}` 
      };
    }
  }

  /**
   * 通过页面注入方式上传文件
   */
  private async uploadViaPageInjection(
    tabId: number,
    nodeId: number,
    fileData: ArrayBuffer,
    fileName: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 获取元素的 objectId
      const resolveResult = await chrome.debugger.sendCommand(
        { tabId },
        'DOM.resolveNode',
        { nodeId }
      ) as any;
      
      const objectId = resolveResult?.object?.objectId;
      if (!objectId) {
        return { success: false, error: 'cannot resolve node to objectId' };
      }

      // 将 ArrayBuffer 转换为 Base64
      const base64Data = this.arrayBufferToBase64(fileData);
      const mimeType = this.getMimeType(fileName);

      // 在页面上下文中设置文件
      const result = await chrome.debugger.sendCommand(
        { tabId },
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: `function(base64Data, fileName, mimeType) {
            try {
              // 解码 Base64
              const byteCharacters = atob(base64Data);
              const byteNumbers = new Array(byteCharacters.length);
              for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
              }
              const byteArray = new Uint8Array(byteNumbers);
              const blob = new Blob([byteArray], { type: mimeType });
              const file = new File([blob], fileName, { type: mimeType, lastModified: Date.now() });
              
              // 创建 DataTransfer 并设置文件
              const dataTransfer = new DataTransfer();
              dataTransfer.items.add(file);
              this.files = dataTransfer.files;
              
              // 触发完整的事件序列
              const events = [
                new FocusEvent('focus', { bubbles: true }),
                new Event('input', { bubbles: true, cancelable: true }),
                new Event('change', { bubbles: true, cancelable: true }),
                new FocusEvent('blur', { bubbles: true })
              ];
              
              events.forEach(event => {
                try { this.dispatchEvent(event); } catch(e) {}
              });
              
              // React 兼容性处理
              try {
                // 方法1: _valueTracker
                if (this._valueTracker) {
                  this._valueTracker.setValue('');
                }
                
                // 方法2: 模拟原生 setter
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                if (nativeInputValueSetter) {
                  nativeInputValueSetter.call(this, this.value || '');
                }
                
                // 方法3: 触发 React 合成事件
                const reactEvent = new Event('input', { bubbles: true });
                Object.defineProperty(reactEvent, 'target', { value: this, writable: false });
                this.dispatchEvent(reactEvent);
              } catch(e) {}
              
              // Vue 兼容性处理
              try {
                const vueEvent = new CustomEvent('change', { bubbles: true, detail: { files: this.files } });
                this.dispatchEvent(vueEvent);
              } catch(e) {}
              
              return { success: true, filesCount: this.files.length };
            } catch (err) {
              return { success: false, error: err.message || String(err) };
            }
          }`,
          arguments: [
            { value: base64Data },
            { value: fileName },
            { value: mimeType }
          ],
          returnByValue: true
        }
      ) as any;

      const value = result?.result?.value;
      if (value?.success) {
        return { success: true };
      }
      return { success: false, error: value?.error || 'page injection failed' };
    } catch (error) {
      return { 
        success: false, 
        error: `page injection error: ${error instanceof Error ? error.message : String(error)}` 
      };
    }
  }

  private async findTargetInputNodeId(tabId: number, rootNodeId: number, selector: string, frameId: number): Promise<number | null> {
    const query = async (contextNodeId: number, sel: string) => {
      try {
        const res = await chrome.debugger.sendCommand(
          { tabId },
          'DOM.querySelector',
          { nodeId: contextNodeId, selector: sel }
        ) as any;
        return res.nodeId || 0;
      } catch {
        return 0;
      }
    };

    const describe = async (nid: number) => {
      try {
        return await chrome.debugger.sendCommand(
          { tabId },
          'DOM.describeNode',
          { nodeId: nid }
        ) as any;
      } catch {
        return null;
      }
    };

    const nodeId = await query(rootNodeId, selector);
    if (nodeId) {
      const nodeDesc = await describe(nodeId);
      if (nodeDesc?.node?.nodeName === 'INPUT') {
        const attrs = nodeDesc.node.attributes || [];
        for (let i = 0; i < attrs.length; i += 2) {
          if (attrs[i] === 'type' && attrs[i + 1] === 'file') return nodeId;
        }
      }

      const childInputId = await query(nodeId, 'input[type="file"]');
      if (childInputId) return childInputId;
    }

    // 通过 Runtime.evaluate 执行智能解析（含 Shadow DOM）
    const selectorLiteral = JSON.stringify(selector);
    const resolveResult = await chrome.debugger.sendCommand(
      { tabId },
      'Runtime.evaluate',
      {
        expression: `(function() {
          const queryDeep = (root, sel) => {
            const results = Array.from(root.querySelectorAll(sel));
            const walker = document.createTreeWalker(
              root,
              NodeFilter.SHOW_ELEMENT,
              { acceptNode: node => node && node.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP }
            );
            let n = walker.nextNode();
            while (n) {
              if (n.shadowRoot) {
                results.push(...queryDeep(n.shadowRoot, sel));
              }
              n = walker.nextNode();
            }
            return results;
          };

          const selector = ${selectorLiteral};
          let el = document.querySelector(selector);
          if (!el) {
            const deepMatches = queryDeep(document, selector);
            el = deepMatches[0] || null;
          }
          if (!el) return null;

          const isFileInput = (node) => node && node.tagName === 'INPUT' && node.type === 'file';
          if (isFileInput(el)) return el;

          // label 关联
          const label = el.tagName === 'LABEL' ? el : el.closest('label');
          if (label) {
            if (label.htmlFor) {
              const linked = document.getElementById(label.htmlFor);
              if (isFileInput(linked)) return linked;
            }
            const nested = label.querySelector('input[type="file"]');
            if (nested) return nested;
          }

          // 子元素
          const childInput = el.querySelector('input[type="file"]');
          if (childInput) return childInput;

          // 兄弟节点
          let sib = el.previousElementSibling;
          while (sib) {
            if (isFileInput(sib)) return sib;
            sib = sib.previousElementSibling;
          }
          sib = el.nextElementSibling;
          while (sib) {
            if (isFileInput(sib)) return sib;
            sib = sib.nextElementSibling;
          }

          // 父级容器
          const parent = el.parentElement;
          if (parent) {
            const parentInput = parent.querySelector('input[type="file"]');
            if (parentInput) return parentInput;
          }

          // 诱导创建：点击后短等待
          try {
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          } catch (e) {}

          return new Promise(resolve => {
            setTimeout(() => {
              const created = document.querySelector('input[type="file"]');
              resolve(created || null);
            }, 200);
          });
        })()`,
        awaitPromise: true
      }
    ) as any;

    const resolvedObjectId = resolveResult?.result?.objectId;
    if (resolvedObjectId) {
      const requestNodeResult = await chrome.debugger.sendCommand(
        { tabId },
        'DOM.requestNode',
        { objectId: resolvedObjectId }
      ) as any;
      if (requestNodeResult?.nodeId) return requestNodeResult.nodeId;
    }

    // 兜底：选取页面中最“可用”的 file input
    const bestInputResult = await chrome.debugger.sendCommand(
      { tabId },
      'Runtime.evaluate',
      {
        expression: `(function() {
          const queryDeep = (root, sel) => {
            const results = Array.from(root.querySelectorAll(sel));
            const walker = document.createTreeWalker(
              root,
              NodeFilter.SHOW_ELEMENT,
              { acceptNode: node => node && node.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP }
            );
            let n = walker.nextNode();
            while (n) {
              if (n.shadowRoot) {
                results.push(...queryDeep(n.shadowRoot, sel));
              }
              n = walker.nextNode();
            }
            return results;
          };

          const isVisible = (el) => {
            if (!el || !document.body || !document.body.contains(el)) return false;
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.1) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 1 && rect.height > 1;
          };

          const inViewport = (el) => {
            const rect = el.getBoundingClientRect();
            return rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0;
          };

          const inputs = queryDeep(document, 'input[type="file"]');
          let best = null;
          let bestScore = -Infinity;
          for (const el of inputs) {
            const rect = el.getBoundingClientRect();
            const area = Math.max(0, rect.width) * Math.max(0, rect.height);
            let score = area;
            if (isVisible(el)) score += 10000;
            if (inViewport(el)) score += 20000;
            if (el.hasAttribute('multiple')) score += 500;
            if (score > bestScore) {
              bestScore = score;
              best = el;
            }
          }
          return best || null;
        })()`,
        awaitPromise: true
      }
    ) as any;

    const bestObjectId = bestInputResult?.result?.objectId;
    if (bestObjectId) {
      const requestNodeResult = await chrome.debugger.sendCommand(
        { tabId },
        'DOM.requestNode',
        { objectId: bestObjectId }
      ) as any;
      if (requestNodeResult?.nodeId) return requestNodeResult.nodeId;
    }

    return null;
  }

  private async dispatchUploadEvents(tabId: number, nodeId: number): Promise<void> {
    const resolveObj = await chrome.debugger.sendCommand(
      { tabId },
      'DOM.resolveNode',
      { nodeId }
    ) as any;
    const objectId = resolveObj?.object?.objectId;
    if (!objectId) return;

    await chrome.debugger.sendCommand(
      { tabId },
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function() {
          const element = this;
          try {
            element.dispatchEvent(new Event('focus', { bubbles: true }));
          } catch (e) {}

          const events = ['click', 'input', 'change', 'blur'];
          events.forEach(type => {
            const event = new Event(type, { bubbles: true, cancelable: true });
            element.dispatchEvent(event);
          });

          try {
            const tracker = element._valueTracker;
            if (tracker) {
              tracker.setValue(element.value);
            }
          } catch (e) {}
        }`
      }
    );
  }

  private async tryDropUpload(tabId: number, selector: string, filePath: string): Promise<{ success: boolean; error?: string }> {
    const selectorLiteral = JSON.stringify(selector);
    const filePathLiteral = JSON.stringify(filePath);
    const result = await chrome.debugger.sendCommand(
      { tabId },
      'Runtime.evaluate',
      {
        expression: `(async function() {
          const queryDeep = (root, sel) => {
            const results = Array.from(root.querySelectorAll(sel));
            const walker = document.createTreeWalker(
              root,
              NodeFilter.SHOW_ELEMENT,
              { acceptNode: node => node && node.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP }
            );
            let n = walker.nextNode();
            while (n) {
              if (n.shadowRoot) {
                results.push(...queryDeep(n.shadowRoot, sel));
              }
              n = walker.nextNode();
            }
            return results;
          };

          const selector = ${selectorLiteral};
          const filePath = ${filePathLiteral};
          let el = document.querySelector(selector);
          if (!el) {
            const deepMatches = queryDeep(document, selector);
            el = deepMatches[0] || null;
          }
          if (!el) return { success: false, error: 'target element not found' };

          const toFileUrl = (path) => {
            if (path.startsWith('file://')) return path;
            return 'file:///' + path.replace(/\\/g, '/');
          };

          let blob;
          try {
            const res = await fetch(toFileUrl(filePath));
            blob = await res.blob();
          } catch (e) {
            return { success: false, error: 'failed to read file via file:// in page context' };
          }

          const filename = filePath.split(/[\\/]/).pop() || 'upload.bin';
          const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(file);

          const fire = (type) => {
            const event = new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer
            });
            el.dispatchEvent(event);
          };

          fire('dragenter');
          fire('dragover');
          fire('drop');
          fire('dragleave');

          return { success: true };
        })()`,
        awaitPromise: true
      }
    ) as any;

    const value = result?.result?.value;
    if (value?.success) return { success: true };
    return { success: false, error: value?.error || 'drop upload failed' };
  }

  /**
   * 使用文件数据上传到元素（支持 input 和 dropzone）
   */
  private async uploadFileDataToElement(
    tabId: number,
    selector: string,
    fileData: ArrayBuffer,
    fileName: string,
    targetNodeId: number | null
  ): Promise<{ success: boolean; error?: string }> {
    const selectorLiteral = JSON.stringify(selector);
    const fileNameLiteral = JSON.stringify(fileName);
    
    // 将 ArrayBuffer 转换为 Base64
    const base64Data = this.arrayBufferToBase64(fileData);
    const base64Literal = JSON.stringify(base64Data);
    const mimeType = this.getMimeType(fileName);
    const mimeTypeLiteral = JSON.stringify(mimeType);
    
    const result = await chrome.debugger.sendCommand(
      { tabId },
      'Runtime.evaluate',
      {
        expression: `(async function() {
          try {
            const queryDeep = (root, sel) => {
              const results = Array.from(root.querySelectorAll(sel));
              const walker = document.createTreeWalker(
                root,
                NodeFilter.SHOW_ELEMENT,
                { acceptNode: node => node && node.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP }
              );
              let n = walker.nextNode();
              while (n) {
                if (n.shadowRoot) {
                  results.push(...queryDeep(n.shadowRoot, sel));
                }
                n = walker.nextNode();
              }
              return results;
            };

            const selector = ${selectorLiteral};
            const fileName = ${fileNameLiteral};
            const base64Data = ${base64Literal};
            const mimeType = ${mimeTypeLiteral};
            
            let el = document.querySelector(selector);
            if (!el) {
              const deepMatches = queryDeep(document, selector);
              el = deepMatches[0] || null;
            }
            if (!el) return { success: false, error: 'target element not found: ' + selector };

            // 将 Base64 转换为 Blob
            const byteCharacters = atob(base64Data);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
              byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: mimeType });
            const file = new File([blob], fileName, { type: mimeType });
            
            // 智能查找 input[type=file]
            const isFileInput = (node) => node && node.tagName === 'INPUT' && node.type === 'file';
            let targetInput = isFileInput(el) ? el : null;
            
            // 1. 子元素查找
            if (!targetInput) {
              targetInput = el.querySelector('input[type="file"]');
            }
            
            // 2. label 关联查找
            if (!targetInput) {
              const label = el.tagName === 'LABEL' ? el : el.closest('label');
              if (label) {
                if (label.htmlFor) {
                  const linked = document.getElementById(label.htmlFor);
                  if (isFileInput(linked)) targetInput = linked;
                }
                if (!targetInput) {
                  const nested = label.querySelector('input[type="file"]');
                  if (nested) targetInput = nested;
                }
              }
            }
            
            // 3. 兄弟元素查找
            if (!targetInput) {
              let sib = el.previousElementSibling;
              while (sib && !targetInput) {
                if (isFileInput(sib)) targetInput = sib;
                else {
                  const nested = sib.querySelector('input[type="file"]');
                  if (nested) targetInput = nested;
                }
                sib = sib.previousElementSibling;
              }
              sib = el.nextElementSibling;
              while (sib && !targetInput) {
                if (isFileInput(sib)) targetInput = sib;
                else {
                  const nested = sib.querySelector('input[type="file"]');
                  if (nested) targetInput = nested;
                }
                sib = sib.nextElementSibling;
              }
            }
            
            // 4. 父元素容器查找
            if (!targetInput) {
              let parent = el.parentElement;
              let depth = 0;
              while (parent && !targetInput && depth < 5) {
                const parentInput = parent.querySelector('input[type="file"]');
                if (parentInput) targetInput = parentInput;
                parent = parent.parentElement;
                depth++;
              }
            }
            
            // 5. 点击尝试触发动态创建的 input
            if (!targetInput) {
              try {
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                await new Promise(r => setTimeout(r, 300));
                // 再次查找
                targetInput = document.querySelector('input[type="file"]:not([data-upload-used])');
                if (targetInput) {
                  targetInput.setAttribute('data-upload-used', 'true');
                }
              } catch(e) {}
            }
            
            // 6. 全局兜底：找页面中最佳的 file input
            if (!targetInput) {
              const allInputs = queryDeep(document, 'input[type="file"]');
              const isVisible = (node) => {
                if (!node || !document.body.contains(node)) return false;
                const style = getComputedStyle(node);
                if (style.display === 'none' || style.visibility === 'hidden') return false;
                return true;
              };
              const inViewport = (node) => {
                const rect = node.getBoundingClientRect();
                return rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0;
              };
              let bestInput = null;
              let bestScore = -Infinity;
              for (const inp of allInputs) {
                let score = 0;
                if (isVisible(inp)) score += 100;
                if (inViewport(inp)) score += 200;
                const rect = inp.getBoundingClientRect();
                score += Math.min(rect.width * rect.height, 50000) / 1000;
                if (score > bestScore) {
                  bestScore = score;
                  bestInput = inp;
                }
              }
              if (bestInput) targetInput = bestInput;
            }
            
            if (targetInput) {
              // 直接设置 input 的 files
              const dataTransfer = new DataTransfer();
              dataTransfer.items.add(file);
              targetInput.files = dataTransfer.files;
              
              // 触发事件
              ['focus', 'input', 'change', 'blur'].forEach(eventType => {
                const event = new Event(eventType, { bubbles: true, cancelable: true });
                targetInput.dispatchEvent(event);
              });
              
              // InputEvent for React/Vue
              try {
                const inputEvent = new InputEvent('input', { bubbles: true, cancelable: true });
                targetInput.dispatchEvent(inputEvent);
              } catch(e) {}
              
              // React hack
              try {
                const tracker = targetInput._valueTracker;
                if (tracker) {
                  tracker.setValue('');
                }
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                if (nativeInputValueSetter) {
                  nativeInputValueSetter.call(targetInput, targetInput.value);
                }
              } catch(e) {}
              
              return { success: true, method: 'input', inputTag: targetInput.tagName };
            }
            
            // 如果没有找到 input，尝试拖拽方式
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            
            const fire = (type) => {
              const event = new DragEvent(type, {
                bubbles: true,
                cancelable: true,
                dataTransfer
              });
              el.dispatchEvent(event);
            };
            
            fire('dragenter');
            fire('dragover');
            fire('drop');
            fire('dragleave');
            
            return { success: true, method: 'drag' };
          } catch (err) {
            return { success: false, error: 'script error: ' + (err && err.message || String(err)) };
          }
        })()`,
        awaitPromise: true,
        returnByValue: true
      }
    ) as any;

    // 检查执行结果
    if (result?.exceptionDetails) {
      return { 
        success: false, 
        error: `runtime exception: ${result.exceptionDetails.text || result.exceptionDetails.exception?.description || 'unknown'}` 
      };
    }

    const value = result?.result?.value;
    if (value?.success) {
      this.log(`上传成功，方式: ${value.method || 'unknown'}`);
      return { success: true };
    }
    return { success: false, error: value?.error || 'upload failed (no result returned)' };
  }

  /**
   * 将 ArrayBuffer 转换为 Base64
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}

// 导出工具实例
export const fileUploaderTool = new FileUploaderTool();
