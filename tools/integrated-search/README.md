# 集成搜索工具 (Integrated Search Tools)

## 概述

集成搜索工具模块整合了搜索和结果抓取功能，提供一站式搜索解决方案。用户只需提供关键词，工具会自动完成以下操作：

1. **自动跳转** - 导航到对应平台的搜索页面
2. **等待加载** - 智能等待页面加载完成
3. **结果分析** - 自动提取搜索结果
4. **统一输出** - 以标准JSON格式返回结果

## 支持的平台

| 平台 | 工具名称 | 说明 |
|------|---------|------|
| Bing | `bing_integrated_search` | 微软搜索引擎 |
| 百度 | `baidu_integrated_search` | 中文搜索引擎 |
| Bilibili | `bilibili_integrated_search` | 视频搜索 |
| 知乎 | `zhihu_integrated_search` | 问答社区搜索 |
| GitHub | `github_integrated_search` | 代码仓库搜索 |
| CSDN | `csdn_integrated_search` | 技术文章搜索 |
| 中国大学MOOC | `mooc_integrated_search` | 在线课程搜索 |
| 小红书 | `xiaohongshu_integrated_search` | 生活分享笔记搜索 |
| 知网(CNKI) | `cnki_integrated_search` | 学术文献搜索 |

## 使用方法

### 基本用法

```typescript
// 示例：在Bing上搜索
const result = await bingIntegratedSearch.execute({
  query: "人工智能最新发展"
});
```

### 参数说明

所有集成搜索工具都支持以下参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | 是 | - | 搜索关键词 |
| `formatOutput` | boolean | 否 | true | 是否格式化JSON输出 |
| `waitTime` | number | 否 | 3000 | 页面加载后额外等待时间（毫秒） |

### 返回值格式

所有工具返回统一的JSON格式：

```json
{
  "success": true,
  "message": "成功在 XXX 上搜索 \"关键词\"，找到 N 条结果",
  "data": {
    "searchEngine": "平台名称",
    "query": "搜索关键词",
    "results": [
      {
        // 具体结果字段，根据平台不同而异
      }
    ],
    "count": 10,
    "json": "结果的JSON字符串"
  },
  "content": [
    {
      "type": "text",
      "text": "JSON格式的结果"
    }
  ]
}
```

## 各平台结果字段

### Bing / 百度
```typescript
{
  title: string;        // 标题
  link: string;         // 链接
  description: string;  // 描述
  displayUrl?: string;  // 显示URL (Bing)
  source?: string;      // 来源 (百度)
  time?: string;        // 时间 (百度)
}
```

### Bilibili
```typescript
{
  title: string;        // 视频标题
  link: string;         // 视频链接
  author: string;       // 作者
  uploadDate: string;   // 上传日期
  stats: {
    views: string;      // 播放量
    danmaku: string;    // 弹幕数
    duration: string;   // 时长
  }
}
```

### 知乎
```typescript
{
  title: string;        // 标题
  link: string;         // 链接
  summary: string;      // 摘要
  author: string;       // 作者
  date: string;         // 日期
  stats: {
    likes: string;      // 赞同数
    comments: string;   // 评论数
  }
}
```

### GitHub
```typescript
{
  repoName: string;     // 仓库名称
  link: string;         // 仓库链接
  description: string;  // 描述
  topics: string[];     // 话题标签
  language: string;     // 编程语言
  stars: string;        // 星标数
  lastUpdate: string;   // 最后更新时间
}
```

### CSDN
```typescript
{
  title: string;        // 文章标题
  link: string;         // 文章链接
  summary: string;      // 摘要
  author: string;       // 作者
  date: string;         // 发布日期
  stats: {
    views: string;      // 浏览量
    likes: string;      // 点赞数
    comments: string;   // 评论数
  }
}
```

### 中国大学MOOC
```typescript
{
  title: string;        // 课程名称
  link: string;         // 课程链接
  school: string;       // 学校
  teacher: string;      // 教师
  description: string;  // 课程描述
  stats: {
    participants: string; // 参与人数
    rating: string;       // 评分
  }
}
```

### 小红书
```typescript
{
  title: string;        // 笔记标题
  link: string;         // 笔记链接
  author: string;       // 作者
  description: string;  // 描述
  stats: {
    likes: string;      // 点赞数
    comments: string;   // 评论数
  }
}
```

### 知网(CNKI)
```typescript
{
  title: string;        // 论文标题
  link: string;         // 论文链接
  authors: string[];    // 作者列表
  source: string;       // 来源期刊
  publishDate: string;  // 发表日期
  abstract: string;     // 摘要
  stats: {
    downloads: string;  // 下载量
    citations: string;  // 引用量
  }
}
```

## 使用示例

### 示例 1: 搜索技术文章

```typescript
const result = await csdnIntegratedSearch.execute({
  query: "React Hooks 最佳实践",
  formatOutput: true,
  waitTime: 3000
});

console.log(result.data.results);
```

### 示例 2: 搜索学术论文

```typescript
const result = await cnkiIntegratedSearch.execute({
  query: "深度学习图像识别",
  waitTime: 5000  // 学术网站可能需要更长加载时间
});
```

### 示例 3: 搜索代码仓库

```typescript
const result = await githubIntegratedSearch.execute({
  query: "machine learning python",
  formatOutput: true
});
```

## 注意事项

1. **等待时间调整**：不同平台的加载速度不同，可以根据需要调整 `waitTime` 参数
2. **网络环境**：确保能够访问目标平台
3. **反爬机制**：部分平台可能有反爬虫措施，建议适当控制搜索频率
4. **页面结构变化**：平台可能更新页面结构，导致选择器失效，需要及时更新

## 架构设计

### 基类结构

所有集成搜索工具都继承自 `BaseIntegratedSearchTool`，它提供了：

- 统一的执行流程
- 页面加载等待机制
- 结果格式化方法
- 错误处理机制

### 扩展新平台

要添加新的平台支持，只需：

1. 继承 `BaseIntegratedSearchTool`
2. 实现 `getSearchUrl()` - 返回搜索URL
3. 实现 `getSearchEngine()` - 返回搜索引擎名称
4. 实现 `scrapeResults()` - 实现结果抓取逻辑
5. 定义结果接口

示例：

```typescript
export class NewPlatformIntegratedSearchTool extends BaseIntegratedSearchTool {
  name = 'new_platform_integrated_search';
  
  protected getSearchEngine(): string {
    return '新平台';
  }

  protected getSearchUrl(query: string): string {
    return `https://newplatform.com/search?q=${encodeURIComponent(query)}`;
  }

  protected async scrapeResults(tabId: number): Promise<any[]> {
    // 实现抓取逻辑
  }
}
```

## 版本历史

- **v1.0.0** (2026-01-05)
  - 初始版本
  - 支持10个主流平台
  - 统一的JSON输出格式
  - 智能页面加载等待

## 作者

AgentNexus Team

## 许可

MIT License
