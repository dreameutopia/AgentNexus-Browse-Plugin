// click-by-rect-helper.js
// 这个脚本被注入到页面中，专门处理基于矩形坐标的点击操作。

// 1. --- 初始化检查 ---
// 使用一个全局变量作为标记，防止脚本被重复注入和执行。
if (window.__CLICK_BY_RECT_HELPER_INITIALIZED__) {
  // 脚本已经初始化，直接跳过。
} else {
  window.__CLICK_BY_RECT_HELPER_INITIALIZED__ = true;

  /**
   * @description 根据传入的矩形坐标，计算并点击其中心点。
   * @param {number[]} rect - 一个包含四个数字的数组 [x1, y1, x2, y2]，
   * 分别代表矩形左上角和右下角的x, y坐标（相对于视口）。
   * @param {boolean} doubleClick - 是否执行双击操作，默认false
   * @returns {Promise<Object>} - 一个包含点击操作结果的对象。
   */
  async function clickByRect(rect, doubleClick = false) {
    try {
      // 2. --- 输入参数校验 ---
      if (!Array.isArray(rect) || rect.length !== 4 || rect.some(isNaN)) {
        return { error: `Invalid rectangle format. Expected [x1, y1, x2, y2], but got ${JSON.stringify(rect)}` };
      }

      const [x1, y1, x2, y2] = rect;

      // 3. --- 计算中心点 ---
      const centerX = (x1 + x2) / 2;
      const centerY = (y1 + y2) / 2;

      // 4. --- 定位并点击元素 ---
      // 使用 document.elementFromPoint 获取在指定坐标下最顶层的元素。
      const element = document.elementFromPoint(centerX, centerY);

      if (!element) {
        return { error: `No element found at the center coordinates (${centerX}, ${centerY})` };
      }

      // 为了确保点击的可靠性，我们创建鼠标事件并派发它。
      // 这种方式比 element.click() 更能模拟真实用户行为，且更能穿透一些覆盖层。
      const mouseEventOptions = {
        view: window,
        bubbles: true,
        cancelable: true,
        clientX: centerX,
        clientY: centerY,
        button: 0,
        buttons: 1
      };

      if (doubleClick) {
        // 执行双击：先执行第一次点击
        element.dispatchEvent(new MouseEvent('mousedown', mouseEventOptions));
        await new Promise(resolve => setTimeout(resolve, 50));
        element.dispatchEvent(new MouseEvent('mouseup', { ...mouseEventOptions, buttons: 0 }));
        element.dispatchEvent(new MouseEvent('click', { ...mouseEventOptions, buttons: 0 }));
        
        // 短暂延迟
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // 执行第二次点击
        element.dispatchEvent(new MouseEvent('mousedown', mouseEventOptions));
        await new Promise(resolve => setTimeout(resolve, 50));
        element.dispatchEvent(new MouseEvent('mouseup', { ...mouseEventOptions, buttons: 0 }));
        element.dispatchEvent(new MouseEvent('click', { ...mouseEventOptions, buttons: 0 }));
        element.dispatchEvent(new MouseEvent('dblclick', { ...mouseEventOptions, buttons: 0 }));
      } else {
        // 单击
        element.dispatchEvent(new MouseEvent('click', {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX: centerX,
          clientY: centerY,
        }));
      }
      
      // 5. --- 返回成功的响应 ---
      // 返回丰富的信息，便于插件侧进行调试和记录。
      const elementRect = element.getBoundingClientRect();
      return {
        success: true,
        message: `Element ${doubleClick ? 'double-' : ''}clicked successfully at center point (${centerX.toFixed(2)}, ${centerY.toFixed(2)}).`,
        elementInfo: {
          tagName: element.tagName,
          text: element.textContent?.trim().substring(0, 150) || '',
          rect: { 
            x: elementRect.x, 
            y: elementRect.y, 
            width: elementRect.width, 
            height: elementRect.height 
          },
        }
      };

    } catch (error) {
      // 捕获意外错误。
      return { error: `An unexpected error occurred during the click operation: ${error.message}` };
    }
  }

  // 6. --- 监听来自插件的通信 ---
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    // 检查 action 是否是我们约定的指令
    if (request.action === 'clickByRect') {
      const rect = request.rect || request.coordinates;
      if (!rect) {
        sendResponse({
          error: '缺少 rect 参数（期望 [x1, y1, x2, y2]）'
        });
        return true;
      }

      clickByRect(rect, request.doubleClick || false)
        .then(sendResponse) // 将 clickByRect 函数的结果异步发送回去
        .catch((error) => {
          sendResponse({
            error: `Unexpected promise error: ${error.message}`,
          });
        });
      
      // 返回 true 是必须的，它告诉 Chrome 扩展API：
      // “我将会异步地调用 sendResponse，请保持消息通道开启”。
      return true; 
    }
    
    // （可选）可以像示例一样，添加一个 "ping" 指令来检查脚本是否已成功注入。
    if (request.action === 'ping_click_by_rect') {
      sendResponse({ status: 'pong', version: '1.0' });
      return false; // 同步返回，不需要保持通道开启。
    }
  });
}