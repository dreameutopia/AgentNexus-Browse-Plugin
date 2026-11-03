// B站视频字幕提取注入脚本
// 基于bilibili-subtitle项目的实现逻辑

(function() {
    'use strict';
    
    console.log('🎬 B站字幕提取脚本已注入');
    
    // 检查是否在B站视频页面
    function isBilibiliVideoPage() {
        return location.hostname.includes('bilibili.com') && 
               (location.pathname.startsWith('/video') || location.pathname.startsWith('/list'));
    }
    
    // 时间解析函数
    function parseTime(time) {
        const separator = time.includes(',') ? ',' : '.';
        const parts = time.split(':');
        const ms = parts[parts.length-1].split(separator);
        if (parts.length === 3) {
            return parseInt(parts[0]) * 60 * 60 + parseInt(parts[1]) * 60 + parseInt(ms[0]) + parseInt(ms[1]) / 1000;
        } else {
            return parseInt(parts[0]) * 60 + parseInt(ms[0]) + parseInt(ms[1]) / 1000;
        }
    }
    
    // 时间格式化函数
    function formatTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) {
            return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        } else {
            return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }
    }
    
    // 字幕解析函数
    function parseSubtitleContent(content) {
        const items = [];
        
        // 解析JSON格式的字幕
        try {
            const subtitleData = JSON.parse(content);
            if (subtitleData.body && Array.isArray(subtitleData.body)) {
                subtitleData.body.forEach((item, index) => {
                    items.push({
                        from: item.from,
                        to: item.to,
                        content: item.content,
                        idx: index
                    });
                });
            }
        } catch (e) {
            console.error('字幕解析失败:', e);
        }
        
        return items;
    }
    
    // 转换为SRT格式
    function convertToSRT(items, includeVideoInfo = false, videoTitle = '') {
        let srt = '';
        if (includeVideoInfo && videoTitle) {
            srt += `// 视频标题: ${videoTitle}\n\n`;
        }
        
        items.forEach((item, index) => {
            const startTime = formatSRTTime(item.from);
            const endTime = formatSRTTime(item.to);
            srt += `${index + 1}\n${startTime} --> ${endTime}\n${item.content}\n\n`;
        });
        
        return srt;
    }
    
    // 转换为VTT格式
    function convertToVTT(items, includeVideoInfo = false, videoTitle = '') {
        let vtt = 'WEBVTT\n\n';
        if (includeVideoInfo && videoTitle) {
            vtt += `NOTE 视频标题: ${videoTitle}\n\n`;
        }
        
        items.forEach((item) => {
            const startTime = formatVTTTime(item.from);
            const endTime = formatVTTTime(item.to);
            vtt += `${startTime} --> ${endTime}\n${item.content}\n\n`;
        });
        
        return vtt;
    }
    
    // SRT时间格式化
    function formatSRTTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
    }
    
    // VTT时间格式化
    function formatVTTTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
    }
    
    // 主要的字幕提取函数
    async function extractSubtitles(options = {}) {
        const {
            format = 'json',
            language = 'all',
            includeVideoInfo = false
        } = options;
        
        console.log('🎬 开始提取B站视频字幕...');
        
        // 检查是否在B站视频页面
        if (!isBilibiliVideoPage()) {
            throw new Error('请在B站视频页面运行此脚本');
        }
        
        try {
            // 获取视频ID
            const pathSearchs = {};
            location.search.slice(1).replace(/([^=&]*)=([^=&]*)/g, (matches, a, b) => pathSearchs[a] = b);
            
            let aidOrBvid = pathSearchs.bvid;
            if (!aidOrBvid) {
                let path = location.pathname;
                if (path.endsWith('/')) {
                    path = path.slice(0, -1);
                }
                const paths = path.split('/');
                aidOrBvid = paths[paths.length - 1];
            }
            
            if (!aidOrBvid) {
                throw new Error('无法获取视频ID');
            }
            
            console.log('📹 视频ID:', aidOrBvid);
            
            let aid, cid, title, subtitles;
            
            // 根据视频ID类型获取视频信息
            if (aidOrBvid.toLowerCase().startsWith('av')) {
                // AV号
                aid = parseInt(aidOrBvid.slice(2));
                console.log('🔍 获取AV视频信息...');
                
                const pagelistRes = await fetch(`https://api.bilibili.com/x/player/pagelist?aid=${aid}`, { 
                    credentials: 'include' 
                });
                const pagelistData = await pagelistRes.json();
                
                if (pagelistData.code !== 0) {
                    throw new Error(`获取视频页面列表失败: ${pagelistData.message}`);
                }
                
                const pages = pagelistData.data;
                cid = pages[0].cid;
                title = pages[0].part;
                
            } else {
                // BV号
                console.log('🔍 获取BV视频信息...');
                
                const viewRes = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${aidOrBvid}`, { 
                    credentials: 'include' 
                });
                const viewData = await viewRes.json();
                
                if (viewData.code !== 0) {
                    throw new Error(`获取视频信息失败: ${viewData.message}`);
                }
                
                title = viewData.data.title;
                aid = viewData.data.aid;
                cid = viewData.data.cid;
            }
            
            console.log('📝 视频标题:', title);
            console.log('🆔 AID:', aid, 'CID:', cid);
            
            // 获取字幕信息
            console.log('🔍 获取字幕信息...');
            const playerRes = await fetch(`https://api.bilibili.com/x/player/wbi/v2?aid=${aid}&cid=${cid}`, {
                credentials: 'include',
            });
            const playerData = await playerRes.json();
            
            if (playerData.code !== 0) {
                throw new Error(`获取播放器信息失败: ${playerData.message}`);
            }
            
            subtitles = playerData.data.subtitle.subtitles;
            
            // 过滤掉没有字幕URL的项目
            subtitles = subtitles.filter(item => item.subtitle_url);
            
            if (subtitles.length === 0) {
                throw new Error('该视频没有可用的字幕');
            }
            
            console.log(`📋 找到 ${subtitles.length} 个字幕:`);
            subtitles.forEach((subtitle, index) => {
                console.log(`  ${index + 1}. ${subtitle.lan_doc} (${subtitle.lan})`);
            });
            
            // 下载并解析字幕
            const allSubtitles = [];
            
            for (let i = 0; i < subtitles.length; i++) {
                const subtitle = subtitles[i];
                
                // 如果指定了语言且不是'all'，则过滤
                if (language !== 'all' && subtitle.lan !== language) {
                    continue;
                }
                
                console.log(`📥 下载字幕: ${subtitle.lan_doc}`);
                
                try {
                    const subtitleRes = await fetch(subtitle.subtitle_url);
                    const subtitleContent = await subtitleRes.text();
                    
                    const parsedItems = parseSubtitleContent(subtitleContent);
                    
                    if (parsedItems.length > 0) {
                        const subtitleData = {
                            language: subtitle.lan_doc,
                            languageCode: subtitle.lan,
                            items: parsedItems
                        };
                        
                        // 根据格式转换
                        if (format === 'srt') {
                            subtitleData.content = convertToSRT(parsedItems, includeVideoInfo, title);
                        } else if (format === 'vtt') {
                            subtitleData.content = convertToVTT(parsedItems, includeVideoInfo, title);
                        }
                        
                        allSubtitles.push(subtitleData);
                        console.log(`✅ 成功解析 ${parsedItems.length} 条字幕`);
                    } else {
                        console.warn(`⚠️ 字幕解析失败或为空`);
                    }
                    
                } catch (error) {
                    console.error(`❌ 下载字幕失败:`, error);
                }
            }
            
            if (allSubtitles.length === 0) {
                throw new Error('没有成功解析的字幕');
            }
            
            const result = {
                success: true,
                title,
                aid,
                cid,
                format,
                subtitles: allSubtitles
            };
            
            console.log('✅ 字幕提取完成！');
            return result;
            
        } catch (error) {
            console.error('❌ 脚本执行出错:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    // 监听来自扩展的消息
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'extractSubtitles') {
            console.log('收到字幕提取请求:', request.options);
            
            extractSubtitles(request.options)
                .then(result => {
                    sendResponse(result);
                })
                .catch(error => {
                    sendResponse({
                        success: false,
                        error: error.message
                    });
                });
            
            return true; // 保持消息通道开放
        }
    });
    
    // 暴露到全局作用域供调试使用
    window.BilibiliSubtitleExtractor = {
        extractSubtitles,
        isBilibiliVideoPage
    };
    
})();