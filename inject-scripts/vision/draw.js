/**
 * AI Agent Page Segmenter - v11 (Final)
 *
 * This is the definitive, complete, and robust version of the page segmentation script,
 * designed for use in a browser extension. It incorporates a powerful segmentation
 * algorithm, robust asynchronous iframe handling, unique XPath generation, and a
 * stateless action execution API.
 */
if (window.__AI_PAGE_SEGMENTER_INITIALIZED__) {
  // Script already initialized.
} else {
  window.__AI_PAGE_SEGMENTER_INITIALIZED__ = true;

  console.log("AI页面分割工具 (V11 - 最终版) 已注入。");

  // =================================================================
  // 视觉模块: 覆盖层管理器
  // =================================================================
  class OverlayManager {
    constructor() {
      this.overlayId = 'ai-agent-overlay-v11-final';
      this.overlayElement = null;
    }

    _getRandomColor() {
      const hue = Math.floor(Math.random() * 360);
      return `hsl(${hue}, 95%, 50%)`;
    }

    draw(elements) {
      this.cleanup();
      this.overlayElement = document.createElement('div');
      this.overlayElement.id = this.overlayId;
      Object.assign(this.overlayElement.style, {
        position: 'fixed', top: '0', left: '0',
        zIndex: '2147483647', pointerEvents: 'none',
      });

      elements.forEach(item => {
        const color = this._getRandomColor();
        const box = document.createElement('div');
        Object.assign(box.style, {
          position: 'absolute',
          left: `${item.rect.left}px`, top: `${item.rect.top}px`,
          width: `${item.rect.width}px`, height: `${item.rect.height}px`,
          outline: `1.5px solid ${color}`,
          outlineOffset: '-1.5px',
          backgroundColor: 'rgba(0, 123, 255, 0.05)',
          boxSizing: 'border-box',
        });

        const label = document.createElement('div');
        label.innerText = item.id;
        Object.assign(label.style, {
          position: 'absolute',
          left: `${item.rect.left}px`, top: `${item.rect.top}px`,
          transform: 'translateY(-100%)',
          backgroundColor: color, color: 'white',
          padding: '1px 4px', fontSize: '12px', fontWeight: 'bold',
          borderRadius: '3px', fontFamily: `'helvetica neue', helvetica, arial, sans-serif`,
        });
        
        this.overlayElement.appendChild(box);
        this.overlayElement.appendChild(label);
      });
      document.body.appendChild(this.overlayElement);
    }

    cleanup() {
      const existingOverlay = document.getElementById(this.overlayId);
      if (existingOverlay) {
        existingOverlay.remove();
        console.log("🖼️ 覆盖层已清理。");
      }
    }
  }

  // =================================================================
  // 核心逻辑: 页面分割器
  // =================================================================
  class PageSegmenter {
    _waitForFrameLoad(frame) {
      return new Promise((resolve, reject) => {
        if (frame.contentDocument && frame.contentDocument.readyState === 'complete') {
          return resolve(true);
        }
        const timeout = setTimeout(() => reject(new Error("Iframe load timed out")), 5000);
        frame.addEventListener('load', () => { clearTimeout(timeout); resolve(true); }, { once: true });
      });
    }

    _segmentElement(element, elementsList) {
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      if (element.nodeType !== Node.ELEMENT_NODE || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || rect.width < 5 || rect.height < 5) return;
      
      const atomicTags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'VIDEO', 'IFRAME'];
      if (atomicTags.includes(element.tagName) || element.hasAttribute('onclick')) {
        elementsList.push({ element, rect: DOMRect.fromRect(rect) });
        return; 
      }
      
      const visibleChildren = Array.from(element.children).filter(c => {
        const childStyle = window.getComputedStyle(c);
        return c.nodeType === Node.ELEMENT_NODE && childStyle.display !== 'none' && childStyle.visibility !== 'hidden' && c.getBoundingClientRect().width > 0;
      });
      
      if (visibleChildren.length === 0) {
        if ((element.innerText || '').trim().length > 0 || ['IMG', 'SVG'].includes(element.tagName)) {
          elementsList.push({ element, rect: DOMRect.fromRect(rect) });
        }
      } else {
        visibleChildren.forEach(child => this._segmentElement(child, elementsList));
      }
    }
    
    _generateXPath(element) {
      if (element.id) {
        return `//*[@id="${element.id}"]`;
      }
      if (!element.parentElement) { // Robustness for root elements
        return `/${element.tagName.toLowerCase()}`;
      }
      if (element === document.body) {
        return '/html/body';
      }

      let siblingIndex = 1;
      let sibling = element.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === element.tagName) {
          siblingIndex++;
        }
        sibling = sibling.previousElementSibling;
      }

      const parentPath = this._generateXPath(element.parentElement);
      return `${parentPath}/${element.tagName.toLowerCase()}[${siblingIndex}]`;
    }
    
    async segmentPage() {
      let allElements = [];
      const queue = [{ win: window, offsetX: 0, offsetY: 0 }];
      const processedWindows = new Set();

      while (queue.length > 0) {
        const docInfo = queue.shift();
        const { win, offsetX, offsetY } = docInfo;

        if (processedWindows.has(win)) continue;
        processedWindows.add(win);

        try {
          const doc = win.document;
          let elementsInDoc = [];
          this._segmentElement(doc.body, elementsInDoc);
          
          elementsInDoc.forEach(el => {
            el.rect.x += offsetX; el.rect.y += offsetY;
            el.rect.left += offsetX; el.rect.right += offsetX;
            el.rect.top += offsetY; el.rect.bottom += offsetY;
          });
          allElements.push(...elementsInDoc);

          const frames = doc.querySelectorAll('iframe');
          for (const frame of frames) {
            try {
              if (!frame.contentWindow || !frame.contentDocument) continue;
              const frameRect = frame.getBoundingClientRect();
              if (frameRect.width < 10 || frameRect.height < 10) continue;
              await this._waitForFrameLoad(frame);
              queue.push({ win: frame.contentWindow, offsetX: offsetX + frameRect.left, offsetY: offsetY + frameRect.top });
            } catch (e) { console.warn('跳过有问题的Iframe:', frame, e.message); }
          }
        } catch (e) { console.warn('无法处理某个文档/窗口:', e.message); }
      }

      allElements.sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left));
      
      return allElements.map((el, index) => ({
        id: index + 1,
        rect: { x: el.rect.x, y: el.rect.y, width: el.rect.width, height: el.rect.height },
        text: (el.element.innerText || el.element.value || '').trim().substring(0, 100),
        tagName: el.element.tagName.toLowerCase(),
        xpath: this._generateXPath(el.element)
      }));
    }
  }

  // =================================================================
  // 消息监听器: 插件的命令入口
  // =================================================================
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
      const segmenter = new PageSegmenter();
      const overlay = new OverlayManager();

      // 1. PING: 检查脚本是否在线
      if (request.action === 'ping') {
        sendResponse({ status: 'pong', source: 'page_segmenter_v11' });
        return;
      }
      
      // 2. 分割页面并渲染
      if (request.action === 'segmentPage') {
        try {
          console.log("▶️ 收到'segmentPage'指令，开始执行...");
          const data = await segmenter.segmentPage();
          overlay.draw(data);
          console.log(`✅ 页面分割完成！共找到 ${data.length} 个元素。`);
          sendResponse({ status: 'success', data: data });
        } catch (error) {
          console.error("❌ 执行'segmentPage'时出错:", error);
          sendResponse({ status: 'error', message: error.message });
        }
        return;
      }
      
      // 3. 清理渲染
      if (request.action === 'cleanupOverlay') {
          try {
              overlay.cleanup();
              sendResponse({ status: 'success' });
          } catch(error) {
              console.error("❌ 执行'cleanupOverlay'时出错:", error);
              sendResponse({ status: 'error', message: error.message });
          }
          return;
      }

      // 4. 根据XPath执行操作
      if (request.action === 'executeActionByXPath') {
        try {
          const { xpath, actionType, text } = request;
          console.log(`▶️ 收到'executeActionByXPath'指令: ${actionType} on ${xpath}`);
          
          const targetElement = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;

          if (!targetElement) { throw new Error(`无法通过XPath找到元素: ${xpath}`); }

          if (actionType === 'click') {
            targetElement.click();
          } else if (actionType === 'type') {
            targetElement.value = text;
          }
          // 可在此处扩展更多 actionType

          console.log(`✅ XPath操作成功！`);
          sendResponse({ status: 'success' });
        } catch (error) {
          console.error("❌ 执行XPath操作时出错:", error);
          sendResponse({ status: 'error', message: error.message });
        }
        return;
      }

    })();

    // 必须返回 true，以表明我们将异步地发送响应
    return true;
  });
}