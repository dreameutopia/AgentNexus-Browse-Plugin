// 防止脚本被重复注入
if (window.__AUTOMATION_TOOL_INITIALIZED__) {
  // 脚本已存在，不做任何事
} else {
  window.__AUTOMATION_TOOL_INITIALIZED__ = true;

  console.log("自动化工具脚本已注入。");

  // =================================================================
  // 核心抓取逻辑: CSDN 搜索结果解析器
  // =================================================================
  class CSDNResultScraper {
    async scrapeResults() {
      console.log("▶️ 开始抓取 CSDN 搜索结果...");
      const results = [];

      try {
        // 关键选择器：有效过滤广告、课程推荐等无关项目
        const resultItems = document.querySelectorAll('div.list-item div.so-items-normal');

        if (resultItems.length === 0) {
          console.warn("⚠️ 在当前页面未找到任何有效文章结果。");
          return [];
        }

        console.log(`🔍 找到 ${resultItems.length} 条文章结果，正在逐条解析...`);

        for (const item of resultItems) {
          try {
            const titleElement = item.querySelector('h3.title a.block-title');
            const summaryElement = item.querySelector('p.row2');
            const authorElement = item.querySelector('.btm-rt a.user span.name-text');
            const dateElement = item.querySelector('.btm-rt span.time');
            const viewsElement = item.querySelector('.btm-view .num');
            const likesElement = item.querySelector('.btm-dig .num');
            const commentsElement = item.querySelector('.btm-comment .num');

            const title = titleElement?.textContent?.trim() ?? 'N/A';
            const link = titleElement?.href ?? '';
            const summary = summaryElement?.textContent?.trim() ?? '';
            const author = authorElement?.textContent?.trim() ?? 'N/A';
            const date = dateElement?.textContent?.trim() ?? 'N/A';
            
            const views = viewsElement?.textContent?.trim() ?? '0';
            const likes = likesElement?.textContent?.trim() ?? '0';
            const comments = commentsElement?.textContent?.trim() ?? '0';
            
            results.push({
              title,
              link,
              summary,
              author,
              date,
              stats: {
                views,
                likes,
                comments
              }
            });
          } catch (e) {
            console.error("解析单篇文章时出错，已跳过。", item, e);
          }
        }
        
        console.log(`✅ CSDN 数据全部解析完成！共 ${results.length} 条。`);
        return results;

      } catch (error) {
        console.error("❌ 抓取 CSDN 数据过程中发生严重错误:", error);
        throw new Error(`抓取失败: ${error.message}`);
      }
    }
  }

  // =================================================================
  // 通用工具函数: 智能等待
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

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`等待元素 "${selector}" 超时 (${timeout}ms)`));
      }, timeout);
    });
  }

  // =================================================================
  // 消息监听器: 插件的命令入口
  // =================================================================
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
      // 1. PING 工具: 用于检查脚本是否在线
      if (request.action === 'ping') {
        sendResponse({ status: 'pong' });
        return;
      }
      
      // 2. CSDN 抓取工具
      if (request.action === 'scrapeCSDNResults') {
        try {
          // 智能等待：等待 CSDN 结果列表的关键元素出现
          const keySelector = 'div.list-item div.so-items-normal';
          await waitForElement(keySelector);
          
          const scraper = new CSDNResultScraper();
          const data = await scraper.scrapeResults();
          
          sendResponse({ status: 'success', data: data });

        } catch (error) {
          console.error("执行 CSDN 抓取操作时出错:", error);
          sendResponse({ status: 'error', message: error.message });
        }
        return;
      }

    })();

    // 必须返回 true，以表明我们将异步地发送响应
    return true;
  });
}