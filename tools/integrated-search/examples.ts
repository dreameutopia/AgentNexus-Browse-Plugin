/**
 * 集成搜索工具使用示例
 * 演示如何使用各个平台的集成搜索工具
 */

import {
  BingIntegratedSearchTool,
  BaiduIntegratedSearchTool,
  BilibiliIntegratedSearchTool,
  ZhihuIntegratedSearchTool,
  GitHubIntegratedSearchTool,
  CSDNIntegratedSearchTool,
  MOOCIntegratedSearchTool,
  XiaohongshuIntegratedSearchTool,
  CNKIIntegratedSearchTool
} from './index';

// ============ 示例 1: 基本使用 ============

async function example1_basicUsage() {
  console.log('=== 示例 1: 基本使用 ===');
  
  const bingSearch = new BingIntegratedSearchTool();
  const result = await bingSearch.execute({
    query: '人工智能最新发展'
  });
  
  if (result.success) {
    console.log(`找到 ${result.data.count} 条结果`);
    console.log(result.data.markdown);
  } else {
    console.error('搜索失败:', result.error);
  }
}

// ============ 示例 2: 自定义等待时间 ============

async function example2_customWaitTime() {
  console.log('=== 示例 2: 自定义等待时间 ===');
  
  const cnkiSearch = new CNKIIntegratedSearchTool();
  const result = await cnkiSearch.execute({
    query: '深度学习图像识别',
    waitTime: 5000  // 学术网站可能需要更长的加载时间
  });
  
  if (result.success) {
    console.log(`找到 ${result.data.count} 篇论文`);
    result.data.results.forEach((paper: any, index: number) => {
      console.log(`${index + 1}. ${paper.title}`);
      console.log(`   作者: ${paper.authors.join(', ')}`);
      console.log(`   来源: ${paper.source}`);
    });
  }
}

// ============ 示例 3: 搜索技术文章 ============

async function example3_searchTechArticles() {
  console.log('=== 示例 3: 搜索技术文章 ===');
  
  const csdnSearch = new CSDNIntegratedSearchTool();
  const result = await csdnSearch.execute({
    query: 'React Hooks 最佳实践'
  });
  
  if (result.success && result.data.results) {
    result.data.results.forEach((article: any) => {
      console.log(`标题: ${article.title}`);
      console.log(`作者: ${article.author}`);
      console.log(`浏览量: ${article.stats.views}`);
      console.log(`链接: ${article.link}`);
      console.log('---');
    });
  }
}

// ============ 示例 4: 搜索代码仓库 ============

async function example4_searchRepositories() {
  console.log('=== 示例 4: 搜索代码仓库 ===');
  
  const githubSearch = new GitHubIntegratedSearchTool();
  const result = await githubSearch.execute({
    query: 'machine learning python'
  });
  
  if (result.success && result.data.results) {
    result.data.results.forEach((repo: any) => {
      console.log(`仓库: ${repo.repoName}`);
      console.log(`描述: ${repo.description}`);
      console.log(`语言: ${repo.language}`);
      console.log(`星标: ${repo.stars}`);
      console.log(`话题: ${repo.topics.join(', ')}`);
      console.log('---');
    });
  }
}

// ============ 示例 5: 搜索视频 ============

async function example5_searchVideos() {
  console.log('=== 示例 5: 搜索视频 ===');
  
  const bilibiliSearch = new BilibiliIntegratedSearchTool();
  const result = await bilibiliSearch.execute({
    query: 'TypeScript 教程'
  });
  
  if (result.success && result.data.results) {
    result.data.results.forEach((video: any) => {
      console.log(`标题: ${video.title}`);
      console.log(`作者: ${video.author}`);
      console.log(`播放量: ${video.stats.views}`);
      console.log(`时长: ${video.stats.duration}`);
      console.log(`链接: ${video.link}`);
      console.log('---');
    });
  }
}

// ============ 示例 6: 搜索问答内容 ============

async function example6_searchQA() {
  console.log('=== 示例 6: 搜索问答内容 ===');
  
  const zhihuSearch = new ZhihuIntegratedSearchTool();
  const result = await zhihuSearch.execute({
    query: '如何学习编程'
  });
  
  if (result.success && result.data.results) {
    result.data.results.forEach((item: any) => {
      console.log(`标题: ${item.title}`);
      console.log(`作者: ${item.author}`);
      console.log(`摘要: ${item.summary.substring(0, 100)}...`);
      console.log(`赞同: ${item.stats.likes}`);
      console.log(`评论: ${item.stats.comments}`);
      console.log('---');
    });
  }
}

// ============ 示例 7: 搜索在线课程 ============

async function example7_searchCourses() {
  console.log('=== 示例 7: 搜索在线课程 ===');
  
  const moocSearch = new MOOCIntegratedSearchTool();
  const result = await moocSearch.execute({
    query: '数据结构与算法'
  });
  
  if (result.success && result.data.results) {
    result.data.results.forEach((course: any) => {
      console.log(`课程: ${course.title}`);
      console.log(`学校: ${course.school}`);
      console.log(`教师: ${course.teacher}`);
      console.log(`参与人数: ${course.stats.participants}`);
      console.log(`评分: ${course.stats.rating}`);
      console.log('---');
    });
  }
}

// ============ 示例 8: 批量搜索多个平台 ============

async function example8_multiPlatformSearch() {
  console.log('=== 示例 8: 批量搜索多个平台 ===');
  
  const query = 'Vue.js 入门';
  
  const platforms = [
    { name: 'Bing', tool: new BingIntegratedSearchTool() },
    { name: 'CSDN', tool: new CSDNIntegratedSearchTool() },
    { name: 'Bilibili', tool: new BilibiliIntegratedSearchTool() }
  ];
  
  for (const platform of platforms) {
    console.log(`\n正在搜索 ${platform.name}...`);
    const result = await platform.tool.execute({ query });
    
    if (result.success) {
      console.log(`${platform.name}: 找到 ${result.data.count} 条结果`);
      if (result.data.results.length > 0) {
        console.log(`首条结果: ${result.data.results[0].title}`);
      }
    }
    
    // 添加延迟避免请求过快
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

// ============ 示例 9: 错误处理 ============

async function example9_errorHandling() {
  console.log('=== 示例 9: 错误处理 ===');
  
  const baiduSearch = new BaiduIntegratedSearchTool();
  
  try {
    const result = await baiduSearch.execute({
      query: 'Node.js 性能优化'
    });
    
    if (result.success) {
      console.log('搜索成功');
      console.log(`找到 ${result.data.count} 条结果`);
    } else {
      console.error('搜索失败:', result.message);
      if (result.error) {
        console.error('错误详情:', result.error);
      }
    }
  } catch (error) {
    console.error('发生异常:', error);
  }
}

// ============ 示例 10: Markdown输出 ============

async function example10_outputFormatting() {
  console.log('=== 示例 10: Markdown输出 ===');
  
  const xiaohongshuSearch = new XiaohongshuIntegratedSearchTool();
  
  const result = await xiaohongshuSearch.execute({ query: '旅游攻略' });
  console.log('Markdown表格输出:', result.data.markdown);
}

// ============ 运行所有示例 ============

async function runAllExamples() {
  // 注意：在实际使用中，不建议一次运行所有示例
  // 这里仅作演示用途
  
  // await example1_basicUsage();
  // await example2_customWaitTime();
  // await example3_searchTechArticles();
  // await example4_searchRepositories();
  // await example5_searchVideos();
  // await example6_searchQA();
  // await example7_searchCourses();
  // await example8_multiPlatformSearch();
  // await example9_errorHandling();
  // await example10_outputFormatting();
}

// 导出示例函数
export {
  example1_basicUsage,
  example2_customWaitTime,
  example3_searchTechArticles,
  example4_searchRepositories,
  example5_searchVideos,
  example6_searchQA,
  example7_searchCourses,
  example8_multiPlatformSearch,
  example9_errorHandling,
  example10_outputFormatting,
  runAllExamples
};
