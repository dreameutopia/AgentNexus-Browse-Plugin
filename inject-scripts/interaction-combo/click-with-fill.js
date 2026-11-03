// ====================================================================================
// ==                    自动化工具: 仿真点击与输入模块                    ==
// ====================================================================================
// 版本: 1.0
// 功能: 接收 Bbox 坐标进行点击，并模拟键盘逐字输入文本内容。
// ====================================================================================

// 1. 防止脚本被重复注入
if (window.__CLICK_TYPE_TOOL_INITIALIZED__) {
  console.log("点击输入脚本已存在，无需重复注入。");
} else {
  window.__CLICK_TYPE_TOOL_INITIALIZED__ = true;
  console.log("✅ 自动化工具 [点击与输入] 脚本已成功注入并初始化。");

  // =================================================================
  // 核心功能: 点击并模拟键盘输入
  // =================================================================
  /**
   * 根据 Bbox 定位点击，并模拟键盘逐字输入内容。
   * @param {number[]} bbox - 目标输入框的边界框，格式为 [x, y, width, height]。
   * @param {string} textToType - 要输入的文本内容。
   * @param {object} [options] - 可选的配置对象。
   * @param {number} [options.typingDelay=100] - 每个字符之间的输入延迟（毫秒）。
   */
  async function clickBboxAndTypeText(bbox, textToType, options = {}) {
    const { typingDelay = 100 } = options;
    const [x, y, width, height] = bbox;
    const centerX = x + width / 2;
    const centerY = y + height / 2;
    const targetElement = document.elementFromPoint(centerX, centerY);

    if (!targetElement || (targetElement.tagName !== 'INPUT' && targetElement.tagName !== 'TEXTAREA' && !targetElement.isContentEditable)) {
      throw new Error(`在 Bbox [${bbox.join(', ')}] 的中心点没有找到可输入的元素 (如 INPUT, TEXTAREA)。`);
    }

    console.log(`步骤 1: 成功定位到输入目标:`, targetElement);
    targetElement.focus();
    targetElement.click();
    console.log(`步骤 2: 已点击并聚焦目标元素。`);

    await new Promise(resolve => setTimeout(resolve, 100));

    console.log(`步骤 3: 即将以 ${typingDelay}ms 的间隔输入文本: "${textToType}"`);
    
    for (const char of textToType) {
      targetElement.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true }));
      targetElement.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true, cancelable: true }));
      // 对于 contentEditable 元素，需要用不同的方式插入文本
      if (targetElement.isContentEditable) {
        const textNode = document.createTextNode(char);
        const selection = window.getSelection();
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(textNode);
        range.collapse(false); // 将光标移动到插入内容之后
      } else {
        targetElement.value += char;
      }
      targetElement.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, typingDelay));
    }

    console.log("✅ 文本输入操作完成！");
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
      
      // 指令 2: 点击并输入文本
      if (request.action === 'performClickAndType') {
        try {
          if (!request.bbox || !Array.isArray(request.bbox) || request.bbox.length !== 4) {
            throw new Error("无效或缺失 'bbox' 参数。");
          }
          if (typeof request.text !== 'string') {
            throw new Error("无效或缺失 'text' 参数，必须为字符串。");
          }
          await clickBboxAndTypeText(request.bbox, request.text, request.options);
          sendResponse({ status: 'success' });
        } catch (error) {
          console.error("执行点击输入操作时出错:", error);
          sendResponse({ status: 'error', message: error.message });
        }
        return;
      }
    })();
    
    // 必须返回 true，以表明我们将异步地发送响应
    return true;
  });
}