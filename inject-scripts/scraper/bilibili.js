// 防止脚本被重复注入
if (window.__AUTOMATION_TOOL_INITIALIZED__) {
  // 脚本已存在，不做任何事
} else {
  window.__AUTOMATION_TOOL_INITIALIZED__ = true;

  console.log("自动化工具脚本已注入。");

  // =================================================================
  // 核心抓取逻辑: Bilibili 搜索结果解析器
  // =================================================================
  class BilibiliSearchScraper {
    async scrapeResults() {
      console.log("▶️ 开始抓取 Bilibili 搜索结果...");
      const results = [];

      try {
        const videoCards = document.querySelectorAll('.bili-video-card');

        if (videoCards.length === 0) {
          console.warn("⚠️ 在当前页面未找到任何视频卡片。");
          return [];
        }

        console.log(`🔍 找到 ${videoCards.length} 个视频卡片，正在逐条解析...`);

        for (const card of videoCards) {
          try {
            const titleElement = card.querySelector('h3.bili-video-card__info--tit');
            if (!titleElement) {
              continue; // 跳过无效卡片 (如加载中的骨架屏)
            }

            const linkElement = card.querySelector('a[href*="/video/"]');
            const authorElement = card.querySelector('.bili-video-card__info--author');
            const dateElement = card.querySelector('.bili-video-card__info--date');
            const statsElements = card.querySelectorAll('.bili-video-card__stats--item span');
            const durationElement = card.querySelector('.bili-video-card__stats__duration');
            
            const title = titleElement.getAttribute('title') || titleElement.textContent.trim();
            
            let link = linkElement?.href ?? '';
            if (link.startsWith('//')) {
              link = 'https:' + link; // 补全协议
            }

            const author = authorElement?.textContent?.trim() ?? 'N/A';
            const uploadDate = dateElement?.textContent?.trim().replace('· ', '') ?? 'N/A';
            
            const views = statsElements[0]?.textContent?.trim() ?? '0';
            const danmaku = statsElements[1]?.textContent?.trim() ?? '0';
            const duration = durationElement?.textContent?.trim() ?? '00:00';

            results.push({
              title,
              link,
              author,
              uploadDate,
              stats: {
                views,
                danmaku,
                duration,
              }
            });

          } catch (e) {
            console.error("解析单个视频卡片时出错，已跳过。", card, e);
          }
        }
        
        console.log(`✅ B站数据解析完成！共提取到 ${results.length} 条有效视频信息。`);
        return results;

      } catch (error) {
        console.error("❌ 抓取B站数据过程中发生严重错误:", error);
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
      
      // 2. Bilibili 抓取工具
      if (request.action === 'scrapeBilibiliResults') {
        try {
          // 智能等待：等待 Bilibili 视频卡片元素出现
          const keySelector = '.bili-video-card';
          await waitForElement(keySelector);
          
          const scraper = new BilibiliSearchScraper();
          const data = await scraper.scrapeResults();
          
          sendResponse({ status: 'success', data: data });

        } catch (error) {
          console.error("执行 Bilibili 抓取操作时出错:", error);
          sendResponse({ status: 'error', message: error.message });
        }
        return;
      }

    })();

    // 必须返回 true，以表明我们将异步地发送响应
    return true;
  });
}