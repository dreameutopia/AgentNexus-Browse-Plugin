// hover-helper.js
// This script is injected into the page to handle mouse hover simulation

if (window.__HOVER_HELPER_INITIALIZED__) {
  // Already initialized, skip
} else {
  window.__HOVER_HELPER_INITIALIZED__ = true;

  /**
   * 模拟鼠标悬停
   * @param {number} x - X 坐标
   * @param {number} y - Y 坐标
   * @returns {Object} - 操作结果
   */
  function simulateHover(x, y) {
    try {
      // 获取目标坐标的元素
      const element = document.elementFromPoint(x, y);
      
      if (!element) {
        return {
          success: false,
          error: `坐标 (${x}, ${y}) 处未找到元素`
        };
      }

      // 创建鼠标事件配置
      const mouseEventInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: window.screenX + x,
        screenY: window.screenY + y,
        button: 0,
        buttons: 0,
        relatedTarget: null
      };

      // 触发 mouseover 事件
      const mouseoverEvent = new MouseEvent('mouseover', mouseEventInit);
      element.dispatchEvent(mouseoverEvent);

      // 触发 mouseenter 事件（不冒泡）
      const mouseenterEvent = new MouseEvent('mouseenter', {
        ...mouseEventInit,
        bubbles: false
      });
      element.dispatchEvent(mouseenterEvent);

      // 触发 mousemove 事件
      const mousemoveEvent = new MouseEvent('mousemove', mouseEventInit);
      element.dispatchEvent(mousemoveEvent);

      // 同时触发指针事件（现代浏览器）
      const pointeroverEvent = new PointerEvent('pointerover', {
        ...mouseEventInit,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true
      });
      element.dispatchEvent(pointeroverEvent);

      const pointerenterEvent = new PointerEvent('pointerenter', {
        ...mouseEventInit,
        bubbles: false,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true
      });
      element.dispatchEvent(pointerenterEvent);

      return {
        success: true,
        message: `鼠标悬停在坐标 (${x}, ${y}) 成功`,
        coordinates: { x, y },
        hoveredElement: {
          tagName: element.tagName,
          id: element.id,
          className: element.className,
          textContent: element.textContent?.substring(0, 50) || ''
        }
      };

    } catch (error) {
      console.error('Error in simulateHover:', error);
      return {
        success: false,
        error: `鼠标悬停失败: ${error.message}`
      };
    }
  }

  /**
   * 通过选择器模拟鼠标悬停
   * @param {string} selector - CSS 选择器
   * @returns {Object} - 操作结果
   */
  function simulateHoverBySelector(selector) {
    try {
      const element = document.querySelector(selector);
      
      if (!element) {
        return {
          success: false,
          error: `未找到选择器 "${selector}" 对应的元素`
        };
      }

      // 获取元素中心坐标
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;

      // 滚动元素到视图中
      element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });

      // 等待滚动完成后再悬停
      setTimeout(() => {
        const newRect = element.getBoundingClientRect();
        const newX = newRect.left + newRect.width / 2;
        const newY = newRect.top + newRect.height / 2;
        
        simulateHover(newX, newY);
      }, 100);

      return {
        success: true,
        message: `正在悬停到元素 "${selector}"`,
        coordinates: { x, y }
      };

    } catch (error) {
      console.error('Error in simulateHoverBySelector:', error);
      return {
        success: false,
        error: `选择器悬停失败: ${error.message}`
      };
    }
  }

  // 监听来自扩展的消息
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'SIMULATE_HOVER') {
      if (request.selector) {
        sendResponse(simulateHoverBySelector(request.selector));
      } else if (request.coordinates) {
        const { x, y } = request.coordinates;
        sendResponse(simulateHover(x, y));
      } else {
        sendResponse({
          success: false,
          error: '缺少坐标或选择器参数'
        });
      }
      return false; // 同步响应
    } else if (request.action === 'hover_helper_ping') {
      sendResponse({ status: 'pong', initialized: true });
      return false;
    }
    return false;
  });
}
