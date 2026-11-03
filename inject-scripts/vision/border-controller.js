// border-controller.js
// 这个脚本被注入到页面中，用于控制动态边框特效的显示和隐藏。

if (window.__BORDER_CONTROLLER_INITIALIZED__) {
  // 如果脚本已经初始化过，则跳过，防止重复执行。
} else {
  window.__BORDER_CONTROLLER_INITIALIZED__ = true;

  // 定义一个常量来存储我们特效<style>标签的ID，方便查找和移除。
  const STYLE_ID = 'gemini-breathing-border-style';

  /**
   * 切换页面边框特效。
   * @param {boolean} show - 一个布尔值参数。true表示显示边框，false表示隐藏边框。
   * @returns {{success: boolean, message: string}} - 操作结果。
   */
  function toggleBorderEffect(show) {
    // 首先，尝试在页面中寻找我们之前可能已经创建的样式标签。
    const existingStyleElement = document.getElementById(STYLE_ID);

    if (show) {
      // --- 指令：开启边框 ---

      // 如果样式已经存在，就没必要重复添加了。
      if (existingStyleElement) {
        return { success: true, message: 'Border effect is already enabled.' };
      }

      // 1. 创建一个新的 <style> 元素。
      const styleElement = document.createElement('style');
      styleElement.id = STYLE_ID; // 设置ID，方便我们之后找到它。
      styleElement.type = 'text/css';

      // 2. 定义 "细边框 + 大光晕" 的CSS样式。
      const cssRules = `
        @keyframes halo-border-effect {
            from {
                box-shadow: 0 0 30px 10px rgba(138, 43, 226, 0.6),
                            inset 0 0 25px 8px rgba(173, 112, 255, 0.5);
            }
            to {
                box-shadow: 0 0 60px 20px rgba(173, 112, 255, 0.7),
                            inset 0 0 35px 12px rgba(202, 160, 255, 0.6);
            }
        }

        body::before {
            content: '';
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            border: 2px solid transparent;
            animation: halo-border-effect 2s ease-in-out infinite alternate;
            pointer-events: none;
            z-index: 9999;
            background-image: linear-gradient(to right, #8A2BE2, #DDA0DD),
                              linear-gradient(to bottom, #8A2BE2, #DDA0DD);
            background-repeat: no-repeat;
            background-size: 100% 2px, 2px 100%;
            background-position: 0 0, 100% 0;
            border-image: linear-gradient(45deg, #8A2BE2, #DDA0DD) 1;
        }
      `;

      // 3. 将CSS代码注入到<style>元素中。
      styleElement.innerHTML = cssRules;

      // 4. 将<style>元素添加到网页的<head>部分，使其生效。
      document.head.appendChild(styleElement);

      return { success: true, message: 'Border effect enabled.' };

    } else {
      // --- 指令：关闭边框 ---

      // 如果找到了我们的样式标签，就把它从页面中移除。
      if (existingStyleElement) {
        existingStyleElement.remove();
        return { success: true, message: 'Border effect disabled.' };
      } else {
        return { success: true, message: 'Border effect was not active.' };
      }
    }
  }

  // 监听来自插件其他部分（如 popup.js 或 background.js）的消息。
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    // 检查收到的指令是否是'toggleBorder'
    if (request.action === 'toggleBorder') {
      // 调用核心函数，并传入参数 request.show (true 或 false)
      const result = toggleBorderEffect(request.show);
      sendResponse(result);
      return false; // 同步返回，不需要保持消息通道开启。
    }

    // 添加一个"ping"指令，用于检查内容脚本是否已成功注入并准备就绪。
    if (request.action === 'ping_border_controller') {
      sendResponse({ status: 'pong', initialized: true });
      return false;
    }
  });

  console.log('Border Controller has been successfully injected and is ready.');
}