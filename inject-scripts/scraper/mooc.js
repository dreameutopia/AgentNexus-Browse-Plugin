// 防止脚本被重复注入
if (window.__AUTOMATION_TOOL_INITIALIZED__) {
  // 脚本已存在，不做任何事
} else {
  window.__AUTOMATION_TOOL_INITIALIZED__ = true;

  console.log("自动化工具脚本已注入。");

  // =================================================================
  // 核心抓取逻辑: MOOC 搜索结果解析器
  // =================================================================
  class MoocScraper {
    async scrapeResults() {
      console.log("▶️ 开始抓取 MOOC 搜索结果...");
      const results = [];
      const baseUrl = window.location.origin;

      try {
        const courseCards = document.querySelectorAll('._3NYsM');

        if (courseCards.length === 0) {
          console.warn("⚠️ 在当前页面未找到任何课程卡片。");
          return [];
        }

        console.log(`🔍 找到 ${courseCards.length} 个课程，正在逐条解析...`);

        for (const card of courseCards) {
          try {
            const linkElement = card.closest('a');
            
            const titleElement = card.querySelector('._1vfZ-');
            const institutionElement = card.querySelector('a._3vJDG');
            const instructorElements = card.querySelectorAll('._1ONN1 a._3t_C8');
            const descriptionElement = card.querySelector('._3JEMz');
            const statusElement = card.querySelector('.NOdDs');
            const participantsElement = card.querySelector('._CWjg');
            
            const title = titleElement?.textContent?.trim() ?? 'N/A';
            const relativeLink = linkElement?.getAttribute('href') ?? '';
            const link = relativeLink.startsWith('http') ? relativeLink : baseUrl + relativeLink;
            
            const institution = institutionElement?.textContent?.trim() ?? '个人/其他';
            
            const instructors = [];
            if (instructorElements) {
              instructorElements.forEach(inst => {
                instructors.push(inst.textContent.trim());
              });
            }

            const description = descriptionElement?.textContent?.trim() ?? '';
            const status = statusElement?.textContent?.trim() ?? '状态未知';
            const participants = participantsElement?.textContent?.trim() ?? '0人参加';

            results.push({
              title,
              link,
              institution,
              instructors,
              description,
              status,
              participants,
            });

          } catch (e) {
            console.error("解析单个课程时出错，已跳过。", card, e);
          }
        }
        
        console.log(`✅ MOOC 数据解析完成！共提取到 ${results.length} 条课程信息。`);
        return results;

      } catch (error) {
        console.error("❌ 抓取 MOOC 数据过程中发生严重错误:", error);
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
      if (request.action === 'ping') {
        sendResponse({ status: 'pong' });
        return;
      }
      
      if (request.action === 'scrapeMoocResults') {
        try {
          // 智能等待：等待 MOOC 课程卡片元素出现
          const keySelector = '._3NYsM';
          await waitForElement(keySelector);
          
          const scraper = new MoocScraper();
          const data = await scraper.scrapeResults();
          
          sendResponse({ status: 'success', data: data });

        } catch (error) {
          console.error("执行 MOOC 抓取操作时出错:", error);
          sendResponse({ status: 'error', message: error.message });
        }
        return;
      }

    })();

    // 必须返回 true，以表明我们将异步地发送响应
    return true;
  });
}