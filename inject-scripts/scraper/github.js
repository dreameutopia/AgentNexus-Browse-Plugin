// 防止脚本被重复注入
if (window.__AUTOMATION_TOOL_INITIALIZED__) {
  // 脚本已存在，不做任何事
} else {
  window.__AUTOMATION_TOOL_INITIALIZED__ = true;

  console.log("自动化工具脚本已注入。");

  // =================================================================
  // 核心抓取逻辑: GitHub 搜索结果解析器
  // =================================================================
  class GitHubScraper {
    async scrapeResults() {
      console.log("▶️ 开始抓取 GitHub 搜索结果...");
      const results = [];
      const baseUrl = window.location.origin;

      try {
        const resultsList = document.querySelector('[data-testid="results-list"]');
        if (!resultsList) {
          console.warn("⚠️ 未找到结果列表容器 [data-testid=\"results-list\"]。");
          return [];
        }
        
        const resultItems = resultsList.children;
        console.log(`🔍 找到 ${resultItems.length} 个结果项，正在逐条解析...`);

        for (const item of resultItems) {
          try {
            const titleElement = item.querySelector('.search-title a');
            if (!titleElement) continue;

            const descriptionElement = item.querySelector('h3 + div');
            const topicsContainer = descriptionElement.nextElementSibling;
            const metaList = item.querySelector('ul');
            
            const repoName = titleElement?.textContent?.trim() ?? 'N/A';
            const relativeLink = titleElement?.getAttribute('href') ?? '';
            const link = relativeLink ? baseUrl + relativeLink : '';
            const description = descriptionElement?.textContent?.trim() ?? '';
            
            const topics = [];
            if (topicsContainer) {
              const topicElements = topicsContainer.querySelectorAll('a');
              for (const topic of topicElements) {
                topics.push(topic.textContent.trim());
              }
            }

            let language = 'N/A';
            let stars = '0';
            let lastUpdate = 'N/A';

            if (metaList) {
              const metaElements = metaList.querySelectorAll('li');
              metaElements.forEach(li => {
                const text = li.textContent.trim();
                if (li.querySelector('svg.octicon-star')) {
                  stars = text;
                } else if (text.startsWith('Updated')) {
                  lastUpdate = text.replace('Updated', '').trim();
                } else if (li.children.length > 0 && li.children[0].tagName !== 'svg') {
                  // A more robust check for language, avoiding other meta items
                  language = text;
                }
              });
            }

            results.push({
              repoName,
              link,
              description,
              topics,
              language,
              stars,
              lastUpdate
            });
          } catch (e) {
            console.error("解析单个仓库时出错，已跳过。", item, e);
          }
        }
        
        console.log(`✅ GitHub 数据解析完成！共提取到 ${results.length} 条有效仓库信息。`);
        return results;

      } catch (error) {
        console.error("❌ 抓取 GitHub 数据过程中发生严重错误:", error);
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
      
      if (request.action === 'scrapeGitHubResults') {
        try {
          // 智能等待：等待 GitHub 结果列表的关键容器出现
          const keySelector = '[data-testid="results-list"]';
          await waitForElement(keySelector);
          
          const scraper = new GitHubScraper();
          const data = await scraper.scrapeResults();
          
          sendResponse({ status: 'success', data: data });

        } catch (error) {
          console.error("执行 GitHub 抓取操作时出错:", error);
          sendResponse({ status: 'error', message: error.message });
        }
        return;
      }

    })();

    // 必须返回 true，以表明我们将异步地发送响应
    return true;
  });
}