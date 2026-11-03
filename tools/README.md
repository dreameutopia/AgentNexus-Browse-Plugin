# 可扩展工具系统 (Extensible Tools System)

这是一个高度可扩展、标准化的工具系统，专为Chrome扩展设计，支持AI自动调用和管理。

## 🏗️ 系统架构

### 核心组件

```
tools/
├── index.ts                 # 主入口文件，工具注册中心
├── base-tool.ts            # 基础工具抽象类
├── search/                 # 搜索工具类别
│   ├── index.ts
│   ├── zhihu-search.ts
│   ├── baidu-search.ts
│   ├── bing-search.ts
│   ├── csdn-search.ts
│   ├── github-search.ts
│   └── stackoverflow-search.ts
├── navigation/             # 导航工具类别
│   ├── index.ts
│   ├── quick-navigation.ts
│   ├── bookmark-navigation.ts
│   └── history-navigation.ts
├── automation/             # 自动化工具类别
│   ├── index.ts
│   ├── form-filler.ts
│   ├── page-analyzer.ts
│   └── workflow-automation.ts
└── examples/               # 使用示例
    └── tool-usage-examples.ts
```

### 设计原则

1. **标准化**: 所有工具遵循OpenAI函数调用规范
2. **可扩展**: 基于抽象类的继承体系，易于添加新工具
3. **自动注册**: 工具自动注册到全局注册表
4. **类型安全**: 完整的TypeScript类型定义
5. **错误处理**: 统一的错误处理和响应格式
6. **日志记录**: 内置日志系统便于调试

## 🚀 快速开始

### 使用现有工具

```typescript
import { toolRegistry } from './tools';

// 获取工具并执行
const zhihuTool = toolRegistry.getTool('zhihu_search');
const result = await zhihuTool.execute({
  query: 'TypeScript 最佳实践',
  searchType: 'content',
  newWindow: false
});

// 或者直接通过名称执行
const result2 = await toolRegistry.executeTool('baidu_search', {
  query: 'Vue.js 教程',
  newWindow: true
});
```

### 获取OpenAI格式的工具定义

```typescript
// 获取所有工具的OpenAI格式定义
const openaiTools = toolRegistry.getOpenAITools();

// 获取特定工具的OpenAI格式定义
const zhihuSchema = toolRegistry.getTool('zhihu_search')?.openaiSchema;
```

## 🔧 创建新工具

### 1. 选择合适的基类

- `BaseTool`: 通用工具基类
- `BaseSearchTool`: 搜索类工具基类
- `BaseNavigationTool`: 导航类工具基类

### 2. 实现工具类

```typescript
import { BaseSearchTool } from '../base-tool';
import { ToolMetadata } from '../index';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';

export class MyCustomSearchTool extends BaseSearchTool {
  name = 'my_custom_search';
  
  metadata: ToolMetadata = {
    name: 'my_custom_search',
    description: '我的自定义搜索工具',
    category: 'search',
    version: '1.0.0',
    author: 'Your Name',
    tags: ['search', 'custom']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'my_custom_search',
      description: '在自定义平台上搜索内容',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索查询'
          },
          category: {
            type: 'string',
            enum: ['all', 'articles', 'videos'],
            description: '搜索类别',
            default: 'all'
          }
        },
        required: ['query']
      }
    }
  };

  async execute(args: {
    query: string;
    category?: string;
    newWindow?: boolean;
  }): Promise<ToolResult> {
    try {
      this.validateArgs(args, ['query']);
      
      const { query, category = 'all', newWindow = false } = args;
      const searchUrl = `https://example.com/search?q=${encodeURIComponent(query)}&cat=${category}`;
      
      return await this.navigateToUrl(searchUrl, { newWindow });
      
    } catch (error) {
      return this.createErrorResponse('搜索失败', error);
    }
  }
}
```

### 3. 注册工具

在相应类别的 `index.ts` 文件中添加:

```typescript
import { MyCustomSearchTool } from './my-custom-search';
import { toolRegistry } from '../index';

// 注册工具
toolRegistry.registerTool(new MyCustomSearchTool());

// 导出工具类
export { MyCustomSearchTool };
```

## 📚 工具类别详解

### 搜索工具 (Search Tools)

专门用于在各种平台上执行搜索操作:

- **ZhihuSearchTool**: 知乎搜索，支持学术、内容、用户、话题搜索
- **BaiduSearchTool**: 百度搜索
- **BingSearchTool**: Bing搜索
- **CSDNSearchTool**: CSDN技术文章搜索
- **GitHubSearchTool**: GitHub代码仓库搜索
- **StackOverflowSearchTool**: Stack Overflow编程问题搜索

### 导航工具 (Navigation Tools)

用于页面导航和快速访问:

- **QuickNavigationTool**: 快速导航到常用网站
- **BookmarkNavigationTool**: 搜索并导航到书签
- **HistoryNavigationTool**: 搜索并导航到浏览历史

### 自动化工具 (Automation Tools)

用于复杂的页面自动化操作:

- **FormFillerTool**: 智能表单填充
- **PageAnalyzerTool**: 页面内容分析
- **WorkflowAutomationTool**: 多步骤工作流自动化

## 🔍 高级功能

### 工作流自动化

```typescript
const workflowResult = await toolRegistry.executeTool('workflow_automation', {
  workflowName: '复杂搜索流程',
  steps: [
    {
      type: 'navigate',
      description: '导航到搜索页面',
      params: { url: 'https://example.com' }
    },
    {
      type: 'fill',
      description: '填写搜索框',
      params: { selector: 'input[name="q"]', value: '搜索内容' }
    },
    {
      type: 'click',
      description: '点击搜索按钮',
      params: { selector: 'button[type="submit"]' }
    },
    {
      type: 'screenshot',
      description: '截取结果页面',
      params: { name: 'search-results' }
    }
  ],
  delayBetweenSteps: 1000
});
```

### 批量操作

```typescript
// 在多个平台同时搜索
const searchQuery = 'React Hooks';
const searchTools = ['zhihu_search', 'baidu_search', 'bing_search'];

const results = await Promise.all(
  searchTools.map(toolName => 
    toolRegistry.executeTool(toolName, {
      query: searchQuery,
      newWindow: true
    })
  )
);
```

### 条件执行

```typescript
// 根据当前页面内容决定执行哪个工具
const pageInfo = await toolRegistry.executeTool('page_analyzer', {
  analysisType: 'basic'
});

if (pageInfo.content[0]?.text.includes('github.com')) {
  // 在GitHub页面，执行GitHub相关操作
  await toolRegistry.executeTool('github_search', {
    query: 'typescript',
    searchType: 'repositories'
  });
} else {
  // 其他页面，导航到GitHub
  await toolRegistry.executeTool('quick_navigation', {
    site: 'github'
  });
}
```

## 🛠️ 开发指南

### 最佳实践

1. **命名规范**: 使用 `snake_case` 命名工具
2. **参数验证**: 始终验证必需参数
3. **错误处理**: 使用统一的错误响应格式
4. **文档注释**: 为所有公共方法添加JSDoc注释
5. **类型安全**: 定义完整的TypeScript接口

### 测试

```typescript
// 测试工具执行
import { toolRegistry } from './tools';

async function testTool() {
  const result = await toolRegistry.executeTool('zhihu_search', {
    query: '测试查询',
    searchType: 'content'
  });
  
  console.log('执行结果:', result);
  console.log('是否成功:', !result.isError);
}
```

### 调试

工具系统内置了日志功能:

```typescript
// 在工具类中使用日志
this.log('开始执行搜索', 'info');
this.log('搜索完成', 'success');
this.log('发生错误', 'error');
```

## 🔌 集成指南

### 与AI系统集成

```typescript
// 获取所有工具的OpenAI格式定义
const tools = toolRegistry.getOpenAITools();

// 发送给AI API
const aiRequest = {
  model: 'gpt-4',
  messages: [...],
  tools: tools,
  tool_choice: 'auto'
};
```

### 与现有系统集成

```typescript
// 直接使用 toolRegistry 调用工具
import { toolRegistry } from './tools';

// 执行工具
const result = await toolRegistry.getTool('browser_navigate')?.execute({ url: 'https://example.com' });
```

## 📈 性能优化

1. **懒加载**: 工具类只在需要时实例化
2. **缓存**: 工具注册表使用Map进行快速查找
3. **批量操作**: 支持批量执行多个工具
4. **异步执行**: 所有工具操作都是异步的

## 🔒 安全考虑

1. **参数验证**: 所有输入参数都经过验证
2. **URL安全**: 导航URL经过编码处理
3. **错误隔离**: 单个工具错误不会影响整个系统
4. **权限控制**: 可以根据需要添加权限检查

## 🚀 未来扩展

1. **插件系统**: 支持动态加载外部工具插件
2. **配置管理**: 支持工具配置的持久化存储
3. **性能监控**: 添加工具执行性能监控
4. **版本管理**: 支持工具版本控制和升级
5. **国际化**: 支持多语言工具描述

## 📝 贡献指南

1. Fork 项目
2. 创建功能分支
3. 实现新工具或改进现有工具
4. 添加测试和文档
5. 提交 Pull Request

## 📄 许可证

MIT License - 详见 LICENSE 文件