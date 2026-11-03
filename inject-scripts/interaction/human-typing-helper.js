// human-typing-helper.js
// This script is injected into the page to simulate human-like typing

if (window.__HUMAN_TYPING_HELPER_INITIALIZED__) {
  // Already initialized, skip
} else {
  window.__HUMAN_TYPING_HELPER_INITIALIZED__ = true;

  /**
   * 生成随机延迟时间（模拟人类打字速度）
   * @param {number} baseSpeed - 基础速度（毫秒/字符）
   * @returns {number} 随机延迟时间
   */
  function getRandomDelay(baseSpeed) {
    if (baseSpeed === 0) return 0;
    // 在基础速度的 70% 到 130% 之间随机
    const min = baseSpeed * 0.7;
    const max = baseSpeed * 1.3;
    return Math.random() * (max - min) + min;
  }

  /**
   * 触发输入事件
   * @param {Element} element - 目标元素
   * @param {string} char - 输入的字符
   */
  function triggerInputEvents(element, char) {
    const isContentEditable = element.isContentEditable;
    
    // 触发 beforeinput 事件（现代浏览器）
    const beforeInputEvent = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: char
    });
    element.dispatchEvent(beforeInputEvent);

    // 更新值
    if (isContentEditable) {
      // 对于 contenteditable 元素，使用 execCommand 或直接插入文本
      if (document.execCommand) {
        document.execCommand('insertText', false, char);
      } else {
        // Fallback: 直接修改文本
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          range.deleteContents();
          const textNode = document.createTextNode(char);
          range.insertNode(textNode);
          range.setStartAfter(textNode);
          range.setEndAfter(textNode);
          selection.removeAllRanges();
          selection.addRange(range);
        } else {
          element.textContent += char;
        }
      }
    } else {
      // 对于普通 input 和 textarea
      const start = element.selectionStart || element.value.length;
      const end = element.selectionEnd || element.value.length;
      const value = element.value;
      element.value = value.substring(0, start) + char + value.substring(end);
      element.selectionStart = element.selectionEnd = start + char.length;
    }

    // 触发 input 事件
    const inputEvent = new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      inputType: 'insertText',
      data: char
    });
    element.dispatchEvent(inputEvent);
  }

  /**
   * 触发键盘事件
   * @param {Element} element - 目标元素
   * @param {string} char - 字符
   * @param {string} eventType - 事件类型
   */
  function triggerKeyboardEvent(element, char, eventType) {
    const keyCode = char.charCodeAt(0);
    const key = char;
    
    const event = new KeyboardEvent(eventType, {
      key: key,
      code: `Key${char.toUpperCase()}`,
      keyCode: keyCode,
      which: keyCode,
      charCode: eventType === 'keypress' ? keyCode : 0,
      bubbles: true,
      cancelable: true,
      composed: true
    });
    
    element.dispatchEvent(event);
  }

  /**
   * 模拟人类打字
   * @param {string} text - 要输入的文本
   * @param {Element} targetElement - 目标元素，如果为 null 则使用当前焦点元素
   * @param {number} typingSpeed - 打字速度（毫秒/字符），0表示立即输入
   * @param {boolean} clearBefore - 输入前是否清空
   * @returns {Promise<Object>} - 操作结果
   */
  async function humanTyping(text, targetElement = null, typingSpeed = 100, clearBefore = false) {
    try {
      // 确定目标元素
      let element = targetElement;
      if (!element) {
        element = document.activeElement;
        // 如果当前没有焦点元素或焦点在 body 上，尝试查找可输入的元素
        if (!element || element === document.body) {
          element = document.querySelector('input:not([type=hidden]):not([disabled]), textarea:not([disabled]), [contenteditable=true]');
        }
      }

      if (!element) {
        return {
          success: false,
          error: '未找到可输入的元素，请先点击输入框或提供目标元素'
        };
      }

      // 确保元素可编辑
      const isContentEditable = element.isContentEditable;
      const isInput = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA';
      
      if (!isContentEditable && !isInput) {
        return {
          success: false,
          error: `元素 ${element.tagName} 不可编辑`
        };
      }

      // 聚焦元素
      if (element !== document.activeElement) {
        element.focus();
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // 清空内容（如果需要）
      if (clearBefore) {
        if (isContentEditable) {
          // 全选并删除
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(element);
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand('delete');
        } else {
          element.value = '';
          element.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // 如果速度为0，立即输入所有文本
      if (typingSpeed === 0) {
        if (isContentEditable) {
          if (document.execCommand) {
            document.execCommand('insertText', false, text);
          } else {
            element.textContent += text;
          }
        } else {
          const start = element.selectionStart || element.value.length;
          const end = element.selectionEnd || element.value.length;
          const value = element.value;
          element.value = value.substring(0, start) + text + value.substring(end);
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        
        return {
          success: true,
          message: `立即输入完成，共 ${text.length} 个字符`,
          textLength: text.length,
          targetElement: {
            tagName: element.tagName,
            id: element.id,
            className: element.className,
            type: element.type
          }
        };
      }

      // 逐字符输入
      const typedChars = [];
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        
        // 触发 keydown 事件
        triggerKeyboardEvent(element, char, 'keydown');
        
        // 触发 keypress 事件（已废弃但某些网站可能需要）
        triggerKeyboardEvent(element, char, 'keypress');
        
        // 触发输入事件并更新值
        triggerInputEvents(element, char);
        
        // 触发 keyup 事件
        triggerKeyboardEvent(element, char, 'keyup');
        
        typedChars.push(char);
        
        // 随机延迟（模拟人类打字）
        if (i < text.length - 1) {
          const delay = getRandomDelay(typingSpeed);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }

      // 触发 change 事件
      element.dispatchEvent(new Event('change', { bubbles: true }));
      
      // 轻微失焦再聚焦（某些框架需要这个来触发验证）
      element.blur();
      await new Promise(resolve => setTimeout(resolve, 10));
      element.focus();

      return {
        success: true,
        message: `人类打字模拟完成，共输入 ${text.length} 个字符`,
        textLength: text.length,
        averageSpeed: typingSpeed,
        targetElement: {
          tagName: element.tagName,
          id: element.id,
          className: element.className,
          type: element.type
        }
      };

    } catch (error) {
      console.error('Error in humanTyping:', error);
      return {
        success: false,
        error: `人类打字模拟失败: ${error.message}`
      };
    }
  }

  // 监听来自扩展的消息
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'HUMAN_TYPING') {
      let targetEl = null;
      if (request.selector) {
        targetEl = document.querySelector(request.selector);
        if (!targetEl) {
          sendResponse({
            success: false,
            error: `未找到选择器 "${request.selector}" 对应的元素`
          });
          return true;
        }
      }

      const typingSpeed = request.typingSpeed !== undefined ? request.typingSpeed : 100;
      const clearBefore = request.clearBefore || false;

      humanTyping(request.text, targetEl, typingSpeed, clearBefore)
        .then(sendResponse)
        .catch((error) => {
          console.error('Unexpected error in humanTyping:', error);
          sendResponse({
            success: false,
            error: `意外错误: ${error.message}`
          });
        });
      return true; // 异步响应
    } else if (request.action === 'human_typing_ping') {
      sendResponse({ status: 'pong', initialized: true });
      return false;
    }
    return false;
  });
}
