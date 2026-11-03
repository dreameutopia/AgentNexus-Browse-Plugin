// 防止脚本被重复注入
if (window.__AUTOMATION_TOOL_ZHIHU_INITIALIZED__) {
    // 脚本已存在，不做任何事
} else {
    window.__AUTOMATION_TOOL_ZHIHU_INITIALIZED__ = true;

    console.log("自动化工具脚本 (知乎) [V2 Enhanced] 已注入。");

    // =================================================================
    // 核心抓取逻辑: 知乎搜索结果解析器 (增强版)
    // =================================================================
    class ZhihuResultScraper {

        /**
         * 提取单个结果的详细信息
         * @param {Element} item - SearchResult-Card 元素
         * @returns {object | null} - 解析后的数据对象，如果无效则返回 null
         */
        parseItem(item) {
            const contentItem = item.querySelector('.ContentItem');
            if (!contentItem) return null;

            // 1. 提取标题和链接 (核心改进点)
            const { title, link } = this.extractTitleAndLink(item, contentItem);
            if (!title) return null; // 如果最终都找不到标题，则跳过

            // 2. 提取摘要 (增加健壮性)
            // Fallback chain: standard answer/article -> column description -> raw text block
            const summaryElement = contentItem.querySelector(
                'span[itemprop="text"], span[itemprop="articleBody"], .RichContent-inner .RichText, .SearchItem-meta .ztext'
            );
            const summaryText = summaryElement?.textContent?.trim().substring(0, 200) ?? '';
            const summary = summaryText ? `${summaryText}...` : '';

            // 3. 提取作者 (增加健壮性)
            // Fallback chain: standard answer author -> column author
            let author = contentItem.querySelector('span[itemprop="text"] b[data-first-child]')?.textContent?.trim();
            if (!author) {
                author = contentItem.querySelector('.ContentItem-meta .UserLink-link')?.textContent?.trim() ?? 'N/A';
            }
            // 针对热榜回答的特殊作者提取（如果上面没找到）
            if (author === 'N/A' && summaryElement) {
                 const potentialAuthor = summaryElement.querySelector('b');
                 if(potentialAuthor) author = potentialAuthor.textContent?.trim() ?? 'N/A';
            }

            // 4. 提取统计数据
            const actionsContainer = contentItem.querySelector('.ContentItem-actions');
            const likesElement = actionsContainer?.querySelector('.VoteButton');
            const commentsElement = Array.from(actionsContainer?.querySelectorAll('button') ?? []).find(btn => btn.textContent.includes('评论'));
            const dateElement = actionsContainer?.querySelector('.SearchItem-time');

            const likesText = likesElement?.textContent?.trim() ?? '0';
            const commentsText = commentsElement?.textContent?.trim() ?? '0';
            const likes = likesText.match(/[\d,.]+/)?.[0].replace(/,/g, '') ?? '0';
            const comments = commentsText.match(/[\d,.]+/)?.[0].replace(/,/g, '') ?? '0';

            return {
                title,
                link,
                summary,
                author,
                date: dateElement?.textContent?.trim() ?? 'N/A',
                stats: { likes, comments }
            };
        }

        /**
         * 提取标题和链接，兼容标准布局和热榜布局 (HotLanding)
         * @param {Element} cardElement - The .SearchResult-Card element.
         * @param {Element} contentItemElement - The .ContentItem element inside the card.
         * @returns {{title: string|null, link: string|null}}
         */
        extractTitleAndLink(cardElement, contentItemElement) {
            // 策略1：标准布局 (标题在 ContentItem 内部)
            let titleElement = contentItemElement.querySelector('h2.ContentItem-title a');
            if (titleElement) {
                return {
                    title: titleElement.textContent?.trim(),
                    link: titleElement.href
                };
            }

            // 策略2：热榜布局 (HotLanding) (标题在 ContentItem 外部，需要向上查找)
            // 检查卡片是否为热榜中的回答项
            if (cardElement.classList.contains('AnswerItem-hotLanding')) {
                const hotLandingContainer = cardElement.closest('.HotLanding-contentItem');
                const hotTitleElement = hotLandingContainer?.querySelector('.HotLanding-contentItemTitle a, .ContentItem-title a');

                if (hotTitleElement) {
                    const title = hotTitleElement.textContent?.trim();
                    const questionUrl = hotTitleElement.href;
                    const answerId = contentItemElement.getAttribute('name'); // 从回答项获取唯一ID

                    // 尝试构建精确的回答链接: /question/{questionId}/answer/{answerId}
                    if (questionUrl && answerId) {
                        const questionIdMatch = questionUrl.match(/question\/(\d+)/);
                        if (questionIdMatch && questionIdMatch[1]) {
                            return { title, link: `https://www.zhihu.com/question/${questionIdMatch[1]}/answer/${answerId}` };
                        }
                    }
                    // 降级：返回问题链接
                    return { title, link: questionUrl };
                }
            }

            return { title: null, link: null };
        }

        async scrapeResults() {
            console.log("▶️ 开始抓取知乎搜索结果 (V2 Enhanced)...");
            const results = [];

            try {
                // 关键选择器：选取所有结果卡片
                const resultItems = document.querySelectorAll('div.SearchResult-Card');

                if (resultItems.length === 0) {
                    console.warn("⚠️ 在当前页面未找到任何搜索结果卡片。请检查选择器是否仍然有效。");
                    return [];
                }

                console.log(`🔍 找到 ${resultItems.length} 条结果卡片，正在逐条解析和过滤...`);

                for (const item of resultItems) {
                    try {
                        // 筛选掉广告、无效卡片
                        const isAd = item.dataset.zaDetailViewPathIs_ad === 'true';
                        if (isAd) {
                            console.log("🚫 已跳过广告卡片。");
                            continue;
                        }
                        
                        // 使用新的解析方法
                        const parsedData = this.parseItem(item);

                        if (parsedData) {
                            results.push(parsedData);
                        } else {
                           // console.log("ℹ️ 跳过无法解析或不符合规范的卡片。", item);
                        }
                    } catch (e) {
                        console.error("解析单个结果时出错，已跳过。", item, e);
                    }
                }

                console.log(`✅ 知乎数据全部解析完成！共筛选出 ${results.length} 条有效结果。`);
                return results;

            } catch (error) {
                console.error("❌ 抓取知乎数据过程中发生严重错误:", error);
                throw new Error(`抓取失败: ${error.message}`);
            }
        }
    }

    // =================================================================
    // 通用工具函数: 智能等待 (保持不变)
    // =================================================================
    function waitForElement(selector, timeout = 15000) {
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
                const el = document.querySelector(selector);
                if (el) {
                    resolve(el);
                } else {
                    reject(new Error(`等待元素 "${selector}" 超时 (${timeout}ms)`));
                }
            }, timeout);
        });
    }

    // =================================================================
    // 消息监听器: 插件的命令入口 (保持不变)
    // =================================================================
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        (async () => {
            if (request.action === 'ping') {
                sendResponse({ status: 'pong', source: 'zhihu_scraper_v2' });
                return;
            }
            
            if (request.action === 'scrapeZhihuResults') {
                try {
                    // 智能等待：等待知乎结果列表的关键元素出现
                    // .SearchResult-Card 是卡片容器，更适合作为页面加载完成的标志
                    const keySelector = 'div.SearchResult-Card';
                    await waitForElement(keySelector);
                    
                    const scraper = new ZhihuResultScraper();
                    const data = await scraper.scrapeResults();
                    
                    sendResponse({ status: 'success', data: data });

                } catch (error) {
                    console.error("执行知乎抓取操作时出错:", error);
                    sendResponse({ status: 'error', message: error.message });
                }
                return;
            }
        })();

        return true; // 异步响应
    });
}