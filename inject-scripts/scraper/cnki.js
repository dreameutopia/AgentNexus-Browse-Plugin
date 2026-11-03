// 防止脚本被重复注入
if (window.__AUTOMATION_TOOL_INITIALIZED__) {
  // 脚本已存在，不做任何事
} else {
  window.__AUTOMATION_TOOL_INITIALIZED__ = true;

  console.log("自动化工具脚本已注入。");

  // =================================================================
  // 核心抓取逻辑: 知网 (CNKI) 结果解析器
  // =================================================================
  class CNKIResultScraper {
    async scrapeResults() {
      console.log("▶️ 开始抓取知网搜索结果...");
      const results = [];

      try {
        const resultRows = document.querySelectorAll('table.result-table-list > tbody > tr');

        if (resultRows.length === 0) {
          console.warn("⚠️ 在当前页面未找到任何结果表格行。");
          return []; // 返回空数组是有效结果
        }

        console.log(`🔍 找到 ${resultRows.length} 条结果，正在逐条解析...`);

        for (const row of resultRows) {
          try {
            const titleElement = row.querySelector('td.name a.fz14');
            const authorsElement = row.querySelector('td.author');
            const sourceElement = row.querySelector('td.source');
            const dateElement = row.querySelector('td.date');
            const databaseElement = row.querySelector('td.data');
            const quoteElement = row.querySelector('td.quote');
            const downloadElement = row.querySelector('td.download a.downloadCnt');

            const title = titleElement?.textContent?.trim() ?? 'N/A';
            const link = titleElement?.href ?? '';
            
            const authorsText = authorsElement?.textContent?.trim() ?? '';
            const authors = authorsText ? authorsText.split(';').filter(name => name.trim()) : [];
            
            const source = sourceElement?.textContent?.trim() ?? 'N/A';
            const year = dateElement?.textContent?.trim() ?? 'N/A';
            const database = databaseElement?.textContent?.trim() ?? 'N/A';
            
            const quoteCount = parseInt(quoteElement?.textContent?.trim() || '0', 10);
            const downloadCount = parseInt(downloadElement?.textContent?.trim() || '0', 10);

            results.push({
              title,
              link,
              authors,
              source,
              year,
              database,
              quoteCount,
              downloadCount,
            });
          } catch (e) {
            console.error("解析单条文献时出错，已跳过。", row, e);
          }
        }
        
        console.log(`✅ 知网数据全部解析完成！共 ${results.length} 条。`);
        return results;

      } catch (error) {
        console.error("❌ 抓取知网数据过程中发生严重错误:", error);
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
  function waitForElement(selector, timeout = 15000) { // 延长超时以适应学术网站
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
    // 使用 async IIFE (立即执行的异步函数) 来方便地使用 await
    (async () => {
      // 1. PING 工具: 用于检查脚本是否成功注入并正在运行
      if (request.action === 'ping') {
        sendResponse({ status: 'pong' });
        return;
      }
      
      // 2. 知网抓取工具
      if (request.action === 'scrapeCNKIResults') {
        try {
          // 智能等待：先等待结果列表出现，再执行抓取
          // 我们从 CNKIResultScraper 的逻辑中得知关键元素是 'table.result-table-list > tbody > tr'
          await waitForElement('table.result-table-list > tbody > tr');
          
          // 执行抓取
          const scraper = new CNKIResultScraper();
          const data = await scraper.scrapeResults();
          
          // 成功响应：将抓取到的数据作为 payload 发送回去
          sendResponse({ status: 'success', data: data });

        } catch (error) {
          console.error("执行知网抓取操作时出错:", error);
          // 失败响应：发送带有错误信息的消息
          sendResponse({ status: 'error', message: error.message });
        }
        return; // 结束当前任务
      }

      // 3. 未来可以轻松在这里扩展其他工具
      // if (request.action === 'scrapeSomeOtherSite') { ... }

    })();

    // 必须返回 true，以表明我们将异步地发送响应
    return true;
  });
}