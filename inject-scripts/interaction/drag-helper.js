/**
 * 拖动辅助脚本
 * 在页面中模拟鼠标拖动操作
 */

(function() {
  'use strict';

  /**
   * 模拟鼠标拖动
   * @param {Object} from 起点坐标 {x, y}
   * @param {Object} to 终点坐标 {x, y}
   * @param {number} duration 拖动持续时间（毫秒）
   * @returns {Promise<void>}
   */
  async function simulateDrag(from, to, duration = 500) {
    // 获取起点元素
    const fromElement = document.elementFromPoint(from.x, from.y);
    if (!fromElement) {
      throw new Error(`在坐标 (${from.x}, ${from.y}) 处未找到元素`);
    }

    // 获取终点元素
    const toElement = document.elementFromPoint(to.x, to.y);
    if (!toElement) {
      throw new Error(`在坐标 (${to.x}, ${to.y}) 处未找到元素`);
    }

    console.log('[DragHelper] 开始拖动:', from, '->', to);

    // 创建鼠标事件选项
    const mouseEventOptions = {
      bubbles: true,
      cancelable: true,
      view: window,
      detail: 1,
      button: 0,
      buttons: 1
    };

    // 1. mousedown 在起点
    const mouseDownEvent = new MouseEvent('mousedown', {
      ...mouseEventOptions,
      clientX: from.x,
      clientY: from.y,
      screenX: from.x,
      screenY: from.y
    });
    fromElement.dispatchEvent(mouseDownEvent);

    // 等待一小段时间
    await new Promise(resolve => setTimeout(resolve, 50));

    // 2. 模拟拖动路径（分段移动）
    const steps = Math.max(5, Math.floor(duration / 50)); // 至少5步
    const deltaX = (to.x - from.x) / steps;
    const deltaY = (to.y - from.y) / steps;

    for (let i = 1; i <= steps; i++) {
      const currentX = from.x + deltaX * i;
      const currentY = from.y + deltaY * i;
      
      const mouseMoveEvent = new MouseEvent('mousemove', {
        ...mouseEventOptions,
        clientX: currentX,
        clientY: currentY,
        screenX: currentX,
        screenY: currentY
      });
      
      const currentElement = document.elementFromPoint(currentX, currentY);
      if (currentElement) {
        currentElement.dispatchEvent(mouseMoveEvent);
      }
      
      // 每步之间的延迟
      await new Promise(resolve => setTimeout(resolve, duration / steps));
    }

    // 3. mouseup 在终点
    const mouseUpEvent = new MouseEvent('mouseup', {
      ...mouseEventOptions,
      clientX: to.x,
      clientY: to.y,
      screenX: to.x,
      screenY: to.y,
      buttons: 0
    });
    toElement.dispatchEvent(mouseUpEvent);

    // 4. 触发 click 事件
    const clickEvent = new MouseEvent('click', {
      ...mouseEventOptions,
      clientX: to.x,
      clientY: to.y,
      screenX: to.x,
      screenY: to.y,
      buttons: 0
    });
    toElement.dispatchEvent(clickEvent);

    console.log('[DragHelper] 拖动完成');
  }

  /**
   * HTML5 拖放 API 实现（备用）
   */
  async function simulateDragWithDragAPI(from, to) {
    const fromElement = document.elementFromPoint(from.x, from.y);
    const toElement = document.elementFromPoint(to.x, to.y);

    if (!fromElement || !toElement) {
      throw new Error('未找到拖动的源元素或目标元素');
    }

    console.log('[DragHelper] 使用 HTML5 Drag API 开始拖动');

    // 创建 dragstart 事件
    const dragStartEvent = new DragEvent('dragstart', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: from.x,
      clientY: from.y,
      dataTransfer: new DataTransfer()
    });
    fromElement.dispatchEvent(dragStartEvent);

    await new Promise(resolve => setTimeout(resolve, 100));

    // 创建 dragover 事件
    const dragOverEvent = new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: to.x,
      clientY: to.y,
      dataTransfer: dragStartEvent.dataTransfer
    });
    toElement.dispatchEvent(dragOverEvent);

    // 创建 drop 事件
    const dropEvent = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: to.x,
      clientY: to.y,
      dataTransfer: dragStartEvent.dataTransfer
    });
    toElement.dispatchEvent(dropEvent);

    // 创建 dragend 事件
    const dragEndEvent = new DragEvent('dragend', {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: to.x,
      clientY: to.y,
      dataTransfer: dragStartEvent.dataTransfer
    });
    fromElement.dispatchEvent(dragEndEvent);

    console.log('[DragHelper] HTML5 Drag API 拖动完成');
  }

  // 监听来自 background 的消息
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'DRAG_ELEMENT') {
      const { from, to, useDragAPI } = request;
      
      console.log('[DragHelper] 收到拖动请求:', from, '->', to);
      
      // 选择拖动方法
      const dragFunction = useDragAPI ? simulateDragWithDragAPI : simulateDrag;
      
      dragFunction(from, to)
        .then(() => {
          sendResponse({ success: true });
        })
        .catch((error) => {
          console.error('[DragHelper] 拖动失败:', error);
          sendResponse({
            success: false,
            error: error.message
          });
        });
      
      return true; // 保持消息通道开放
    }
  });

  console.log('[DragHelper] 拖动辅助脚本已加载');
})();
