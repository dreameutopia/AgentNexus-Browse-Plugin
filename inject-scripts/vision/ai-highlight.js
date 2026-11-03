/**
 * AI Element Highlighter - v1.0
 *
 * 专门为AI定位工具设计的元素高亮脚本，支持多种格式的元素标注
 * 包括CSS选择器、XPath、:contains()伪类等
 */
if (window.__AI_ELEMENT_HIGHLIGHTER_INITIALIZED__) {
  // Script already initialized.
} else {
  window.__AI_ELEMENT_HIGHLIGHTER_INITIALIZED__ = true;

  console.log("AI元素高亮工具 (V1.0) 已注入。");

  // =================================================================
  // 高亮管理器
  // =================================================================
  class AIHighlightManager {
    constructor() {
      this.overlayId = 'ai-highlight-overlay';
      this.overlayElement = null;
      this.highlightedElements = new Set();
    }

    /**
     * 根据选择器查找元素
     * @param {string} selector - CSS选择器、XPath或包含:contains()的选择器
     * @returns {Element|null} 找到的元素
     */
    findElement(selector) {
      try {
        // 1. 尝试XPath
        if (selector.startsWith('/') || selector.startsWith('./')) {
          const result = document.evaluate(
            selector,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          );
          return result.singleNodeValue;
        }

        // 2. 处理:has()伪类选择器
        if (selector.includes(':has(')) {
          return this._findElementByHas(selector);
        }

        // 3. 处理:contains()伪类
        if (selector.includes(':contains(')) {
          return this._findElementByContains(selector);
        }

        // 4. 标准CSS选择器
        return document.querySelector(selector);
      } catch (error) {
        console.warn('查找元素失败:', selector, error);
        return null;
      }
    }

    /**
     * 处理包含:has()伪类的选择器
     * @param {string} selector - 包含:has()的选择器
     * @returns {Element|null} 找到的元素
     */
    _findElementByHas(selector) {
      console.log('处理:has()选择器:', selector);
      
      // 解析:has()伪类 - 支持嵌套的:contains()
      const hasMatch = selector.match(/^([^:]+):has\((.+)\)$/i);
      if (!hasMatch) {
        console.warn('无法解析:has()选择器:', selector);
        return null;
      }

      const baseSelector = hasMatch[1];
      const hasContent = hasMatch[2];
      
      console.log('基础选择器:', baseSelector);
      console.log('has内容:', hasContent);

      // 获取所有匹配基础选择器的元素
      let candidates;
      try {
        candidates = document.querySelectorAll(baseSelector);
        console.log('找到候选元素数量:', candidates.length);
      } catch (error) {
        console.warn('基础选择器无效:', baseSelector, error);
        return null;
      }

      // 检查每个候选元素是否包含指定的子元素
      for (const candidate of candidates) {
        console.log('检查候选元素:', candidate);
        
        // 如果has内容包含:contains()，需要特殊处理
        if (hasContent.includes(':contains(')) {
          const element = this._findElementInScope(hasContent, candidate);
          if (element) {
            console.log('找到匹配的元素:', candidate);
            return candidate;
          }
        } else {
          // 标准CSS选择器
          try {
            const childElement = candidate.querySelector(hasContent);
            if (childElement) {
              console.log('找到匹配的元素:', candidate);
              return candidate;
            }
          } catch (error) {
            console.warn('子选择器无效:', hasContent, error);
          }
        }
      }

      console.log('未找到匹配的元素');
      return null;
    }

    /**
     * 在指定范围内查找元素（支持:contains()）
     * @param {string} selector - 选择器
     * @param {Element} scope - 搜索范围
     * @returns {Element|null} 找到的元素
     */
    _findElementInScope(selector, scope) {
      // 处理:contains()伪类
      if (selector.includes(':contains(')) {
        const containsMatch = selector.match(/(.*):(contains\(['"]*([^'"]+)['"]*\))/i);
        if (!containsMatch) {
          return null;
        }

        const baseSelector = containsMatch[1] || '*';
        const searchText = containsMatch[3];
        
        console.log('在范围内查找:', baseSelector, '包含文本:', searchText);

        // 在指定范围内查找
        let elements;
        try {
          elements = baseSelector === '*' 
            ? scope.querySelectorAll('*')
            : scope.querySelectorAll(baseSelector);
        } catch (error) {
          console.warn('范围内选择器无效:', baseSelector, error);
          return null;
        }

        // 查找包含指定文本的元素
        for (const element of elements) {
          const text = element.textContent || element.innerText || '';
          if (text.includes(searchText)) {
            console.log('在范围内找到包含文本的元素:', element);
            return element;
          }
        }
      } else {
        // 标准选择器
        try {
          return scope.querySelector(selector);
        } catch (error) {
          console.warn('范围内标准选择器失败:', selector, error);
        }
      }

      return null;
    }

    /**
     * 处理包含:contains()伪类的选择器
     * @param {string} selector - 包含:contains()的选择器
     * @returns {Element|null} 找到的元素
     */
    _findElementByContains(selector) {
      // 解析:contains()伪类
      const containsMatch = selector.match(/(.*):(contains\(['"]?([^'"]+)['"]?\))/i);
      if (!containsMatch) {
        return null;
      }

      const baseSelector = containsMatch[1] || '*';
      const searchText = containsMatch[3];

      // 获取所有匹配基础选择器的元素
      let elements;
      try {
        elements = baseSelector === '*' 
          ? document.querySelectorAll('*')
          : document.querySelectorAll(baseSelector);
      } catch (error) {
        console.warn('基础选择器无效:', baseSelector, error);
        return null;
      }

      // 查找包含指定文本的元素
      for (const element of elements) {
        const text = element.textContent || element.innerText || '';
        if (text.includes(searchText)) {
          return element;
        }
      }

      return null;
    }

    /**
     * 高亮元素
     * @param {string} selector - 元素选择器
     * @param {Object} options - 高亮选项
     */
    highlightElement(selector, options = {}) {
      const defaultOptions = {
        style: 'pulse', // pulse, solid, dashed
        color: '#ff4444',
        backgroundColor: 'rgba(255, 68, 68, 0.1)',
        label: '🎯 AI定位',
        duration: 5000, // 持续时间(毫秒)
        showLabel: true,
        borderWidth: '2px',
        zIndex: 2147483647
      };

      const config = { ...defaultOptions, ...options };
      
      const element = this.findElement(selector);
      if (!element) {
        console.warn('未找到要高亮的元素:', selector);
        return false;
      }

      console.log('找到元素，开始高亮:', element);

      // 滚动到元素位置
      element.scrollIntoView({ 
        behavior: 'smooth', 
        block: 'center', 
        inline: 'center' 
      });

      // 创建高亮覆盖层
      this._createHighlightOverlay(element, config);

      // 设置自动移除
      if (config.duration > 0) {
        setTimeout(() => {
          this.removeHighlight();
        }, config.duration);
      }

      return true;
    }

    /**
     * 创建高亮覆盖层
     * @param {Element} element - 要高亮的元素
     * @param {Object} config - 配置选项
     */
    _createHighlightOverlay(element, config) {
      // 移除旧的高亮
      this.removeHighlight();

      const rect = element.getBoundingClientRect();
      const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
      const scrollY = window.pageYOffset || document.documentElement.scrollTop;

      // 创建覆盖层容器
      this.overlayElement = document.createElement('div');
      this.overlayElement.id = this.overlayId;
      Object.assign(this.overlayElement.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: config.zIndex.toString()
      });

      // 创建高亮框
      const highlightBox = document.createElement('div');
      Object.assign(highlightBox.style, {
        position: 'absolute',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        border: `${config.borderWidth} ${this._getBorderStyle(config.style)} ${config.color}`,
        backgroundColor: config.backgroundColor,
        borderRadius: '4px',
        boxSizing: 'border-box'
      });

      // 添加动画效果
      if (config.style === 'pulse') {
        highlightBox.style.animation = 'ai-highlight-pulse 1.5s infinite';
      }

      this.overlayElement.appendChild(highlightBox);

      // 创建标签
      if (config.showLabel && config.label) {
        const label = document.createElement('div');
        label.textContent = config.label;
        Object.assign(label.style, {
          position: 'absolute',
          left: `${rect.left}px`,
          top: `${rect.top - 30}px`,
          backgroundColor: config.color,
          color: 'white',
          padding: '4px 8px',
          borderRadius: '4px',
          fontSize: '12px',
          fontWeight: 'bold',
          fontFamily: 'Arial, sans-serif',
          whiteSpace: 'nowrap',
          boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
        });

        // 确保标签不会超出视口
        if (rect.top < 35) {
          label.style.top = `${rect.bottom + 5}px`;
        }
        if (rect.left < 0) {
          label.style.left = '5px';
        }

        this.overlayElement.appendChild(label);
      }

      // 添加CSS动画
      this._injectAnimationCSS();

      // 添加到页面
      document.body.appendChild(this.overlayElement);
      this.highlightedElements.add(element);

      console.log('高亮覆盖层已创建');
    }

    /**
     * 获取边框样式
     * @param {string} style - 样式类型
     * @returns {string} CSS边框样式
     */
    _getBorderStyle(style) {
      switch (style) {
        case 'dashed':
          return 'dashed';
        case 'solid':
        case 'pulse':
        default:
          return 'solid';
      }
    }

    /**
     * 注入动画CSS
     */
    _injectAnimationCSS() {
      const styleId = 'ai-highlight-animations';
      if (document.getElementById(styleId)) {
        return;
      }

      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        @keyframes ai-highlight-pulse {
          0% {
            opacity: 1;
            transform: scale(1);
          }
          50% {
            opacity: 0.7;
            transform: scale(1.02);
          }
          100% {
            opacity: 1;
            transform: scale(1);
          }
        }
      `;
      document.head.appendChild(style);
    }

    /**
     * 移除高亮
     */
    removeHighlight() {
      if (this.overlayElement) {
        this.overlayElement.remove();
        this.overlayElement = null;
        console.log('高亮覆盖层已移除');
      }
      this.highlightedElements.clear();
    }

    /**
     * 批量高亮多个元素
     * @param {Array} selectors - 选择器数组
     * @param {Object} options - 高亮选项
     */
    highlightMultiple(selectors, options = {}) {
      const results = [];
      selectors.forEach((selector, index) => {
        const elementOptions = {
          ...options,
          label: options.label ? `${options.label} ${index + 1}` : `🎯 ${index + 1}`,
          duration: 0 // 批量高亮时不自动移除
        };
        const success = this.highlightElement(selector, elementOptions);
        results.push({ selector, success });
      });
      return results;
    }

    /**
     * 获取当前高亮的元素数量
     * @returns {number} 高亮元素数量
     */
    getHighlightedCount() {
      return this.highlightedElements.size;
    }
  }

  // =================================================================
  // 消息监听器: 插件的命令入口
  // =================================================================
  const highlightManager = new AIHighlightManager();

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
      // 1. PING: 检查脚本是否在线
      if (request.action === 'ping') {
        sendResponse({ status: 'pong', source: 'ai_highlighter_v1' });
        return;
      }

      // 2. 高亮单个元素
      if (request.action === 'highlightElement') {
        try {
          const { selector, options = {} } = request;
          console.log('收到高亮指令:', selector, options);
          
          const success = highlightManager.highlightElement(selector, options);
          sendResponse({ 
            status: success ? 'success' : 'error', 
            message: success ? '元素高亮成功' : '未找到指定元素'
          });
        } catch (error) {
          console.error('高亮元素时出错:', error);
          sendResponse({ status: 'error', message: error.message });
        }
        return;
      }

      // 3. 批量高亮多个元素
      if (request.action === 'highlightMultiple') {
        try {
          const { selectors, options = {} } = request;
          console.log('收到批量高亮指令:', selectors, options);
          
          const results = highlightManager.highlightMultiple(selectors, options);
          sendResponse({ status: 'success', results });
        } catch (error) {
          console.error('批量高亮元素时出错:', error);
          sendResponse({ status: 'error', message: error.message });
        }
        return;
      }

      // 4. 移除高亮
      if (request.action === 'removeHighlight') {
        try {
          highlightManager.removeHighlight();
          sendResponse({ status: 'success', message: '高亮已移除' });
        } catch (error) {
          console.error('移除高亮时出错:', error);
          sendResponse({ status: 'error', message: error.message });
        }
        return;
      }

      // 5. 获取高亮状态
      if (request.action === 'getHighlightStatus') {
        try {
          const count = highlightManager.getHighlightedCount();
          sendResponse({ 
            status: 'success', 
            highlightedCount: count,
            hasHighlight: count > 0
          });
        } catch (error) {
          console.error('获取高亮状态时出错:', error);
          sendResponse({ status: 'error', message: error.message });
        }
        return;
      }

      // 未知动作
      sendResponse({ status: 'error', message: '未知的动作类型' });
    })();

    // 必须返回 true，以表明我们将异步地发送响应
    return true;
  });

  console.log('AI元素高亮工具消息监听器已注册');
}