// 防止脚本被重复注入
if (window.__AUTOMATION_TOOL_INITIALIZED__) {
  // 脚本已存在，不做任何事
} else {
  window.__AUTOMATION_TOOL_INITIALIZED__ = true;

  console.log("自动化工具脚本已注入。");

  // =================================================================
  // 核心抓取逻辑 (从你的脚本中完整移入)
  // =================================================================
  class XiaohongshuScraper {
    async scrapeResults() {
      console.log("▶️ 开始抓取小红书搜索结果...");
      const results = [];
      const baseUrl = window.location.origin;

      try {
        const noteItems = document.querySelectorAll('section.note-item');

        if (noteItems.length === 0) {
          console.warn("⚠️ 在当前页面未找到任何笔记卡片。");
          return []; // 返回空数组表示没有找到，这是一个有效的结果
        }

        console.log(`🔍 找到 ${noteItems.length} 个卡片，正在筛选并解析...`);

        for (const item of noteItems) {
          try {
            const titleElement = item.querySelector('.footer a.title');
            const authorElement = item.querySelector('.author .name');

            if (!titleElement || !authorElement) {
              continue; // 跳过无效卡片，如“相关搜索”
            }
            
            const linkElement = item.querySelector('a.cover');
            const authorLinkElement = item.querySelector('a.author');
            const timeElement = item.querySelector('.time > .time');
            const likesElement = item.querySelector('.like-wrapper .count');

            const title = titleElement?.textContent?.trim() ?? 'N/A';
            const relativeLink = linkElement?.getAttribute('href') ?? '';
            const link = relativeLink ? baseUrl + relativeLink : '';
            const author = authorElement?.textContent?.trim() ?? 'N/A';
            const relativeAuthorLink = authorLinkElement?.getAttribute('href') ?? '';
            const authorLink = relativeAuthorLink ? baseUrl + relativeAuthorLink : '';
            const time = timeElement?.textContent?.trim() ?? 'N/A';
            let likes = likesElement?.textContent?.trim() ?? '0';
            if (likes === '赞') {
              likes = 'N/A';
            }
            
            results.push({ title, link, author, authorLink, time, likes });
          } catch (e) {
            console.error("解析单个笔记时出错，已跳过。", item, e);
          }
        }
        
        console.log(`✅ 解析完成！共提取到 ${results.length} 条有效笔记。`);
        return results;

      } catch (error) {
        console.error("❌ 抓取过程中发生严重错误:", error);
        // 抛出错误，让调用者知道发生了问题
        throw new Error(`抓取失败: ${error.message}`);
      }
    }
  }

  // =================================================================
  // 智能等待函数 (关键步骤！)
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
        reject(new Error(`等待元素 "${selector}" 超时 (${timeout}ms)`));
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
      
      // 这是我们为小红书抓取器定义的新 "Tool"
      if (request.action === 'scrapeXiaohongshuResults') {
        try {
          // 1. 智能等待：先等待笔记卡片列表出现，再执行抓取
          console.log("等待小红书笔记列表加载...");
          await waitForElement('section.note-item');
          console.log("笔记列表已加载，开始执行抓取。");

          // 2. 执行抓取
          const scraper = new XiaohongshuScraper();
          const data = await scraper.scrapeResults();
          
          // 3. 成功响应：将抓取到的数据作为 payload 发送回去
          sendResponse({ status: 'success', data: data });

        } catch (error) {
          console.error("执行抓取操作时出错:", error);
          // 4. 失败响应：发送带有错误信息的消息
          sendResponse({ status: 'error', message: error.message });
        }
        
        // 必须返回 true，以表明我们将异步发送响应
        return; 
      }

      // 在这里可以添加更多的 else if 来扩展其他工具
      // else if (request.action === 'anotherTool') { ... }

    })(); // 立即执行这个 async 函数

    // 同样，必须在这里返回 true
    return true;
  });
}