// == Bilibili Search Scraper (Based on your HTML) ==
class BilibiliSearchScraper {
  async scrapeResults() {
    console.log("▶️ 开始抓取 Bilibili 搜索结果...");
    const results = [];

    try {
      // 1. 每个视频卡片都有一个清晰的类名 'bili-video-card'
      const videoCards = document.querySelectorAll('.bili-video-card');

      if (videoCards.length === 0) {
        console.warn("⚠️ 在当前页面未找到任何视频卡片。");
        return [];
      }

      console.log(`🔍 找到 ${videoCards.length} 个视频卡片，正在逐条解析...`);

      for (const card of videoCards) {
        try {
          // --- 通过查找标题来确认这是一个有效的视频卡片，而不是加载中的骨架屏 ---
          const titleElement = card.querySelector('h3.bili-video-card__info--tit');
          if (!titleElement) {
            continue; // 跳过无效卡片
          }

          // --- 定位其他元素 ---
          const linkElement = card.querySelector('a[href*="/video/"]');
          const authorElement = card.querySelector('.bili-video-card__info--author');
          const dateElement = card.querySelector('.bili-video-card__info--date');
          const statsElements = card.querySelectorAll('.bili-video-card__stats--item span');
          const durationElement = card.querySelector('.bili-video-card__stats__duration');
          
          // --- 数据提取 ---
          // 优先使用title属性，因为它通常包含完整的、未省略的标题
          const title = titleElement.getAttribute('title') || titleElement.textContent?.trim() || '';
          
          let link = (linkElement as HTMLAnchorElement)?.href ?? '';
          // B站的链接可能是 //www.bilibili.com/... 的形式，需要补全协议
          if (link.startsWith('//')) {
            link = 'https:' + link;
          }

          const author = authorElement?.textContent?.trim() ?? 'N/A';
          const uploadDate = dateElement?.textContent?.trim().replace('· ', '') ?? 'N/A'; // 移除日期前面的点
          
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
      
      console.log(`✅ 解析完成！共提取到 ${results.length} 条有效视频信息。`);
      return results;

    } catch (error) {
      console.error("❌ 抓取过程中发生严重错误:", error);
      return [];
    }
  }
}