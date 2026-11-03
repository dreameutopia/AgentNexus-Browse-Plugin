/**
 * 右键点击辅助脚本
 * 在页面中模拟右键点击（上下文菜单）操作
 */

(function() {
  'use strict';

  /**
   * 模拟右键点击
   * @param {Object} coordinates 坐标 {x, y}
   * @param {boolean} doubleClick 是否执行双击右键（较少见）
   * @returns {Promise<Object>}
   */
  async function simulateRightClick(coordinates, doubleClick = false) {
    const { x, y } = coordinates;
    
    // 获取目标元素
    const element = document.elementFromPoint(x, y);
    if (!element) {
      return { 
        success: false,
        error: `在坐标 (${x}, ${y}) 处未找到元素` 
      };
    }

    console.log('[RightClickHelper] 右键点击元素:', element);

    try {
      // 创建鼠标事件选项
      const mouseEventOptions = {
        bubbles: true,
        cancelable: true,
        view: window,
        detail: 1,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        button: 2,  // 右键
        buttons: 2  // 右键按下
      };

      // 1. 触发 mousedown 事件（右键）
      const mouseDownEvent = new MouseEvent('mousedown', mouseEventOptions);
      element.dispatchEvent(mouseDownEvent);

      // 短暂延迟
      await new Promise(resolve => setTimeout(resolve, 50));

      // 2. 触发 contextmenu 事件（这是右键的核心事件）
      const contextMenuEvent = new MouseEvent('contextmenu', {
        ...mouseEventOptions,
        button: 2,
        buttons: 0  // 鼠标按钮已释放
      });
      element.dispatchEvent(contextMenuEvent);

      // 3. 触发 mouseup 事件（右键）
      const mouseUpEvent = new MouseEvent('mouseup', {
        ...mouseEventOptions,
        buttons: 0  // 鼠标按钮已释放
      });
      element.dispatchEvent(mouseUpEvent);

      // 如果是双击右键（罕见情况）
      if (doubleClick) {
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // 再次执行相同流程
        element.dispatchEvent(new MouseEvent('mousedown', mouseEventOptions));
        await new Promise(resolve => setTimeout(resolve, 50));
        element.dispatchEvent(new MouseEvent('contextmenu', { ...mouseEventOptions, buttons: 0 }));
        element.dispatchEvent(new MouseEvent('mouseup', { ...mouseEventOptions, buttons: 0 }));
      }

      return {
        success: true,
        message: `右键点击${doubleClick ? '（双击）' : ''}成功`,
        elementInfo: {
          tagName: element.tagName,
          text: element.textContent?.trim().substring(0, 100) || '',
          className: element.className,
          id: element.id
        }
      };

    } catch (error) {
      console.error('[RightClickHelper] 右键点击失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // 监听来自 background 的消息
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'RIGHT_CLICK_ELEMENT') {
      const { coordinates, doubleClick } = request;
      
      console.log('[RightClickHelper] 收到右键点击请求:', coordinates);
      
      simulateRightClick(coordinates, doubleClick)
        .then((result) => {
          sendResponse(result);
        })
        .catch((error) => {
          sendResponse({
            success: false,
            error: error.message
          });
        });
      
      return true; // 保持消息通道开放
    }
  });

  console.log('[RightClickHelper] 右键点击辅助脚本已加载');
})();
