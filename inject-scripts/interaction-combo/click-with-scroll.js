// ====================================================================================
// ==                   自动化工具: 仿真点击与滚动模块                   ==
// ====================================================================================
// 版本: 1.0
// 功能: 接收 Bbox 坐标进行点击，并支持滚动一屏或滚动指定高度。
// ====================================================================================

// 1. 防止脚本被重复注入
if (window.__CLICK_SCROLL_TOOL_INITIALIZED__) {
  console.log("点击滚动脚本已存在，无需重复注入。");
} else {
  window.__CLICK_SCROLL_TOOL_INITIALIZED__ = true;
  console.log("✅ 自动化工具 [点击与滚动] 脚本已成功注入并初始化。");

  // =================================================================
  // 核心功能: 点击并根据策略滚动
  // =================================================================
  /**
   * 根据 Bbox 定位并模拟点击，然后根据提供的策略执行滚动。
   * @param {number[]} bbox - 目标区域的边界框，格式为 [x, y, width, height]。
   * @param {object} [options] - 可选的配置对象。
   * @param {boolean} [options.autoScrollNextPage=false] - 是否向下滚动一个屏幕的高度。
   * @param {number} [options.scrollHeight] - 如果 autoScrollNextPage 为 false，则滚动这里指定的像素高度。
   */
  async function performClickAndScroll(bbox, options = {}) {
    const [x, y, width, height] = bbox;
    const centerX = x + width / 2;
    const centerY = y + height / 2;
    const targetElement = document.elementFromPoint(centerX, centerY);

    if (!targetElement) {
      throw new Error(`在 Bbox [${bbox.join(', ')}] 的中心点没有找到任何元素。`);
    }
    
    console.log(`步骤 1: 成功定位到元素:`, targetElement);
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: centerX, clientY: centerY });
    targetElement.dispatchEvent(clickEvent);
    console.log(`步骤 2: 已在元素中心点 (${centerX}, ${centerY}) 模拟了点击。`);

    // 等待一小段时间，让点击事件生效
    await new Promise(resolve => setTimeout(resolve, 100));

    // 根据策略执行滚动
    if (options.autoScrollNextPage === true) {
      const screenHeight = window.innerHeight;
      console.log(`步骤 3: [滚动模式] 自动向下滚动一屏高度 (${screenHeight}px)。`);
      window.scrollBy({ top: screenHeight, behavior: 'smooth' });
    } else if (typeof options.scrollHeight === 'number' && options.scrollHeight > 0) {
      console.log(`步骤 3: [滚动模式] 向下滚动指定高度 ${options.scrollHeight}px。`);
      window.scrollBy({ top: options.scrollHeight, behavior: 'smooth' });
    } else {
      console.log("步骤 3: [滚动模式] 仅点击，不执行滚动。");
    }
    
    console.log("✅ 点击滚动操作完成！");
  }

  // =================================================================
  // 消息监听器 (命令入口)
  // =================================================================
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
      // 指令 1: PING - 检查脚本是否在线
      if (request.action === 'ping') {
        console.log("接收到 PING 请求，回复 PONG。");
        sendResponse({ status: 'pong' });
        return;
      }
      
      // 指令 2: 点击并滚动
      if (request.action === 'performClickAndScroll') {
        try {
          if (!request.bbox || !Array.isArray(request.bbox) || request.bbox.length !== 4) {
            throw new Error("无效或缺失 'bbox' 参数。bbox 必须是一个包含4个数字的数组。");
          }
          await performClickAndScroll(request.bbox, request.options);
          sendResponse({ status: 'success' });
        } catch (error) {
          console.error("执行点击滚动操作时出错:", error);
          sendResponse({ status: 'error', message: error.message });
        }
        return;
      }
    })();

    // 必须返回 true，以表明我们将异步地发送响应
    return true;
  });
}