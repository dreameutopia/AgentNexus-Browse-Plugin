// 防止脚本被重复注入
if (window.__AUTOMATION_TOOL_INITIALIZED__) {
  // 脚本已存在，不做任何事
} else {
  window.__AUTOMATION_TOOL_INITIALIZED__ = true;

  console.log("自动化工具脚本已注入。");

  // =================================================================
  // 核心抓取逻辑: MediaSniffer (媒体嗅探器)
  // =================================================================
  class MediaSniffer {
    /**
     * 清理并截断文本
     * @param {string} text - 原始文本
     * @returns {string} - 清理后的文本
     */
    _cleanText(text) {
      if (!text) return 'N/A';
      return text.replace(/\s+/g, ' ').trim().substring(0, 300);
    }

    /**
     * 将相对URL转换为绝对URL
     * @param {string} url - 可能的相对URL
     * @returns {string|null} - 绝对URL或null
     */
    _toAbsoluteURL(url) {
      if (!url || url.startsWith('data:') || url.startsWith('blob:')) return null;
      try {
        return new URL(url, window.location.href).href;
      } catch (e) {
        return null;
      }
    }

    /**
     * 智能查找元素附近的描述性文字
     * @param {HTMLElement} element - 媒体元素或其宿主元素
     * @returns {string} - 找到的上下文文字
     */
    _findNearbyText(element) {
      if (!element) return 'N/A';
      
      const figure = element.closest('figure');
      if (figure) {
        const figcaption = figure.querySelector('figcaption');
        if (figcaption) return this._cleanText(figcaption.innerText);
      }

      if (element.parentElement) {
        const ariaLabel = element.parentElement.getAttribute('aria-label');
        if (ariaLabel) return this._cleanText(ariaLabel);
        const title = element.parentElement.title;
        if (title) return this._cleanText(title);
      }

      let current = element.parentElement;
      for (let i = 0; i < 3 && current; i++) {
        const text = current.innerText;
        if (text) {
          const cleaned = this._cleanText(text);
          if (cleaned.length > 10 && cleaned.length < 400) {
            return cleaned;
          }
        }
        current = current.parentElement;
      }
      return 'N/A';
    }

    /**
     * 对数组按URL去重，保留信息最完整的一项
     * @param {Array<Object>} arr - 原始数组
     * @returns {Array<Object>} - 去重后的数组
     */
    _getUniqueByUrl(arr) {
        const urlMap = new Map();
        arr.forEach(item => {
            if (!urlMap.has(item.url)) {
                urlMap.set(item.url, item);
            }
        });
        return Array.from(urlMap.values());
    }

    /**
     * 执行嗅探和信息提取
     * @returns {Promise<Object>} - 包含所有媒体信息的对象
     */
    async sniff() {
      console.log("▶️ 开始嗅探媒体资源...");
      
      const resources = {
        images: [],
        videos: [],
        audios: [],
        backgroundImages: [],
      };

      // 1. 嗅探HTML标签
      document.querySelectorAll('img, video, audio, source, picture source, image').forEach(el => {
        let url;
        const tagName = el.tagName.toLowerCase();

        if (el.srcset) {
          const firstSrc = el.srcset.split(',')[0].trim().split(' ')[0];
          url = this._toAbsoluteURL(firstSrc);
        } else {
          const srcAttr = el.src || (el.href ? el.href.baseVal : null);
          url = this._toAbsoluteURL(srcAttr);
        }

        if (!url) return;
        
        const info = {
          url: url,
          alt: el.alt || 'N/A',
          contextText: this._findNearbyText(el),
          tagName: tagName.toUpperCase(),
          sourceType: 'HTML Tag'
        };

        if (['img', 'image', 'picture source'].includes(tagName)) resources.images.push(info);
        else if (tagName === 'video' || (tagName === 'source' && el.parentElement.tagName.toLowerCase() === 'video')) resources.videos.push(info);
        else if (tagName === 'audio' || (tagName === 'source' && el.parentElement.tagName.toLowerCase() === 'audio')) resources.audios.push(info);
      });

      // 2. 嗅探CSS背景图
      document.querySelectorAll('*').forEach(el => {
        const style = window.getComputedStyle(el, null);
        const bgImage = style.getPropertyValue('background-image');
        const matches = bgImage.match(/url\(['"]?(.*?)['"]?\)/);

        if (matches && matches[1]) {
          const url = this._toAbsoluteURL(matches[1]);
          if (url) {
            resources.backgroundImages.push({
              url: url,
              alt: 'N/A (CSS Background)',
              contextText: this._findNearbyText(el),
              tagName: el.tagName.toUpperCase(),
              sourceType: 'CSS Background'
            });
          }
        }
      });
      
      // 3. 结果去重
      resources.images = this._getUniqueByUrl(resources.images);
      resources.videos = this._getUniqueByUrl(resources.videos);
      resources.audios = this._getUniqueByUrl(resources.audios);
      resources.backgroundImages = this._getUniqueByUrl(resources.backgroundImages);
      
      const totalCount = Object.values(resources).reduce((sum, arr) => sum + arr.length, 0);
      console.log(`✅ 嗅探完成！共提取到 ${totalCount} 条唯一的媒体资源。`);

      return resources;
    }
  }

  // =================================================================
  // 智能等待函数 (从你的模板中移入)
  // =================================================================
  /**
   * 等待指定的选择器出现在DOM中
   * @param {string} selector CSS选择器
   * @param {number} timeout 超时时间 (毫秒)
   * @returns {Promise<Element>} 找到的元素
   */
  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const element = document.querySelector(selector);
      if (element) {
        resolve(element);
        return;
      }

      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (element) {
          observer.disconnect();
          resolve(element);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      setTimeout(() => {
        observer.disconnect();
        // 对于嗅探器，即使超时也resolve，因为页面可能就是没有该元素
        // 但嗅探器仍然可以继续执行以查找其他类型的资源
        resolve(null); 
      }, timeout);
    });
  }

  // =================================================================
  // 消息监听器 (将所有工具集成到这里)
  // =================================================================
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 使用 async 函数，方便使用 await
    (async () => {
      if (request.action === 'ping') {
        sendResponse({ status: 'pong' });
        return; // 同步响应，不需要 return true
      }
      
      // 这是我们为媒体嗅探器定义的新 "Tool"
      if (request.action === 'sniffMediaResources') {
        try {
          // 1. 智能等待：先等待页面有内容出现，再执行抓取
          // 等待img或video标签出现，超时时间设为5秒
          console.log("等待媒体内容加载...");
          await waitForElement('img, video', 5000); 
          console.log("页面内容已初步加载，开始执行嗅探。");

          // 2. 执行抓取
          const sniffer = new MediaSniffer();
          const data = await sniffer.sniff();
          
          // 3. 成功响应：将抓取到的数据作为 payload 发送回去
          sendResponse({ status: 'success', data: data });

        } catch (error) {
          console.error("❌ 执行嗅探操作时出错:", error);
          // 4. 失败响应：发送带有错误信息的消息
          sendResponse({ status: 'error', message: error.message });
        }
        
        // 必须返回 true，以表明我们将异步发送响应
        return; 
      }


    })(); // 立即执行这个 async 函数

    // 同样，必须在这里返回 true
    return true;
  });
}