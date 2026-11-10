# 可扩展工具系统 (Extensible Tools System)

这是一个高度可扩展、标准化的工具系统，专为Chrome扩展设计，支持AI自动调用和管理。

## 🏗️ 系统架构

### 核心组件

```
tools/
├── index.ts                 # 主入口文件，工具注册中心
├── base-tool.ts            # 基础工具抽象类
├── search/                 # 搜索工具类别
│   ├── index.ts            # 注册 web_search / platform_search
│   ├── search-targets.ts   # 搜索目标注册表（引擎 bing/baidu + 站点平台 7 个）
│   ├── search-tool-base.ts # 两个搜索工具共用的执行链路（导航 + 解析）
│   ├── web-search-tool.ts  # 通用网页检索（engine 枚举）
│   └── platform-search-tool.ts # 站点平台检索（platform 枚举）
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

浏览器导航只在**现有窗口**内进行：`browser_navigation({action:"open", url})` 默认新标签页，`newTab:false` 使用当前标签页，同 URL 标签可复用；历史前进后退与加载等待同属该工具（`action` 为 `back` / `forward` / `refresh` / `wait`）。`newWindow` 已从导航及快捷／书签／历史导航接口删除，导航没有新建窗口兜底；没有现成窗口时返回错误，标签创建始终显式绑定现有 windowId。

`generic_wait({waitSeconds})` 接受非负有限秒数，超过 600 自动按 600 秒执行，支持中止；视觉循环在工具完成后另强制间隔 3 秒再自动截图。等待仅表示时间经过，完成状态仍需重新观察。

```typescript
import { toolRegistry } from './tools';

// 获取通用网页搜索工具并执行（engine 枚举：bing / baidu）
const searchTool = toolRegistry.getTool('web_search');
const result = await searchTool.execute({
  engine: 'bing',
  query: 'TypeScript 最佳实践',
  newTab: false
});

// 或者直接通过名称执行
const result2 = await toolRegistry.executeTool('web_search', {
  engine: 'baidu',
  query: 'Vue.js 教程',
  newTab: true
});

// 站点平台检索走另一个工具（platform 枚举）
const result3 = await toolRegistry.executeTool('platform_search', {
  platform: 'zhihu',
  query: 'TypeScript 最佳实践'
});
```

### 获取OpenAI格式的工具定义

```typescript
// 获取所有工具的OpenAI格式定义
const openaiTools = toolRegistry.getOpenAITools();

// 获取特定工具的OpenAI格式定义
const searchSchema = toolRegistry.getTool('web_search')?.openaiSchema;
```

## 🔧 创建新工具

### 1. 选择合适的基类

- `BaseTool`（`tools/base-tool.ts`）: 通用工具基类
- `BaseSearchTool`（`tools/search/search-tool-base.ts`）: 搜索类工具基类——`web_search` 与 `platform_search` 共用同一执行链路（导航 → 等待 → 解析 → Markdown 表），子类只声明差异面
- `BaseNavigationTool`（`tools/base-tool.ts`）: 导航类工具基类

### 2. 实现工具类

搜索类工具只需声明三处差异面（目标集合 / 参数名 / 文案），执行逻辑由基类承担：

```typescript
import { ToolMetadata } from '../registry';
import { BaseSearchTool, type SearchToolSpec } from './search-tool-base';

export class MyCustomSearchTool extends BaseSearchTool {
  name = 'my_custom_search';

  /** 差异面：目标集合与参数口径（枚举取自 search-targets.ts 注册表） */
  protected readonly spec: SearchToolSpec = {
    targets: SEARCH_ENGINE_IDS,   // 或 SEARCH_PLATFORM_IDS
    paramName: 'engine',          // 或 'platform'
    paramLabel: '搜索引擎',
    targetKindLabel: '搜索引擎',
  };

  /** 工具描述主体（能力边界 + 并发禁令 + 结果契约） */
  protected readonly usageDescription = '我的自定义搜索工具……';

  /** 目标参数说明（枚举由注册表派生，此处只补充语义） */
  protected readonly paramDescription = '目标搜索引擎（枚举值，小写）：…';

  metadata: ToolMetadata = {
    name: 'my_custom_search',
    description: '我的自定义搜索工具',
    category: 'search',
    version: '1.0.0',
    author: 'Your Name',
    tags: ['search', 'custom']
  };

  /** Schema 由基类按 spec 组装（枚举不手抄，杜绝与注册表漂移） */
  openaiSchema = this.buildOpenAISchema('my_custom_search');
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
// 两个搜索工具：web_search（通用网页，engine 枚举 bing/baidu）与
// platform_search（站点平台，platform 枚举 zhihu/csdn/github/…）——一次调用
// 都完成导航 + 结果解析。
// 注意：两者都自带页面导航（等同 browser_navigation 的 open action），并发调用会互相争抢
// 活动标签页——多次搜索必须逐个串行执行，禁止 Promise.all 并发。
const searchQuery = 'React Hooks';

for (const engine of ['bing', 'baidu'] as const) {
  const result = await toolRegistry.executeTool('web_search', {
    engine,
    query: searchQuery,
    newTab: false // 串行复用同一标签页，避免标签页堆积
  });
}
```

### 条件执行

```typescript
// 根据当前页面内容决定执行哪个工具
const pageInfo = await toolRegistry.executeTool('page_analyzer', {
  analysisType: 'basic'
});

if (pageInfo.content[0]?.text.includes('github.com')) {
  // 在GitHub页面，执行GitHub站内检索
  await toolRegistry.executeTool('platform_search', {
    platform: 'github',
    query: 'typescript'
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
  const result = await toolRegistry.executeTool('web_search', {
    engine: 'bing',
    query: '测试查询'
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
const result = await toolRegistry.getTool('browser_navigation')?.execute({ action: 'open', url: 'https://example.com' });
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
