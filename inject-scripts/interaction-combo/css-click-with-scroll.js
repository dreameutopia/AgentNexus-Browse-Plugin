// ====================================================================================
// ==                    自动化工具: CSS选择器点击与滚动模块                    ==
// ====================================================================================
// 版本: 1.0
// 功能: 接收 CSS 选择器定位元素进行点击，并支持滚动一屏或滚动指定高度。
// ====================================================================================

// 1. 防止脚本被重复注入
if (window.__SELECTOR_CLICK_SCROLL_TOOL_INITIALIZED__) {
  console.log("选择器点击滚动脚本已存在，无需重复注入。");
} else {
  window.__SELECTOR_CLICK_SCROLL_TOOL_INITIALIZED__ = true;
  console.log("✅ 自动化工具 [选择器点击与滚动] 脚本已成功注入并初始化。");

  // =================================================================
  // 核心功能: 根据选择器定位、点击并滚动
  // =================================================================
  /**
   * 根据 CSS 选择器定位并模拟点击，然后根据提供的策略执行滚动。
   * @param {string} selector - 目标元素的CSS选择器。
   * @param {object} [options] - 可选的配置对象。
   * @param {boolean} [options.autoScrollNextPage=false] - 是否向下滚动一个屏幕的高度。
   * @param {number} [options.scrollHeight] - 如果 autoScrollNextPage 为 false，则滚动这里指定的像素高度。
   */
  async function performClickAndScrollBySelector(selector, options = {}) {
    const targetElement = document.querySelector(selector);

    if (!targetElement) {
      throw new Error(`未找到与CSS选择器 "${selector}" 匹配的元素。`);
    }

    console.log(`步骤 1: 成功定位到元素:`, targetElement);

    // 优化: 在点击前，先将元素平滑滚动到视窗中央
    console.log("步骤 2: 将元素滚动到视窗中央...");
    targetElement.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    // 等待滚动动画完成
    await new Promise(resolve => setTimeout(resolve, 500));

    targetElement.click();
    console.log(`步骤 3: 已在元素上模拟了点击操作。`);

    // 等待一小段时间，让点击事件可能触发的页面变化生效
    await new Promise(resolve => setTimeout(resolve, 150));

    // 根据策略执行滚动
    if (options.autoScrollNextPage === true) {
      const screenHeight = window.innerHeight;
      console.log(`步骤 4: [滚动模式] 自动向下滚动一屏高度 (${screenHeight}px)。`);
      window.scrollBy({ top: screenHeight, behavior: 'smooth' });
    } else if (typeof options.scrollHeight === 'number' && options.scrollHeight > 0) {
      console.log(`步骤 4: [滚动模式] 向下滚动指定高度 ${options.scrollHeight}px。`);
      window.scrollBy({ top: options.scrollHeight, behavior: 'smooth' });
    } else {
      console.log("步骤 4: [滚动模式] 仅点击，不执行滚动。");
    }

    console.log("✅ 选择器点击滚动操作完成！");
  }

  // =================================================================
  // 消息监听器 (命令入口)
  // =================================================================
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
      // 指令 1: PING - 检查脚本是否在线
      if (request.action === 'ping') {
        console.log("接收到 PING 请求，回复 PONG。");
        sendResponse({ status: 'pong', source: 'selector_click_scroll_tool' });
        return;
      }

      // 指令 2: 通过选择器点击并滚动
      if (request.action === 'performClickAndScrollBySelector') {
        try {
          if (!request.selector || typeof request.selector !== 'string') {
            throw new Error("无效或缺失 'selector' 参数。selector 必须是一个非空字符串。");
          }
          await performClickAndScrollBySelector(request.selector, request.options);
          sendResponse({ status: 'success' });
        } catch (error) {
          console.error("执行选择器点击滚动操作时出错:", error);
          sendResponse({ status: 'error', message: error.message });
        }
        return;
      }
    })();

    // 必须返回 true，以表明我们将异步地发送响应
    return true;
  });
}
