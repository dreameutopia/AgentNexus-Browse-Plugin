# 可扩展工具系统 (Extensible Tools System)

这是一个高度可扩展、标准化的工具系统，专为Chrome扩展设计，支持AI自动调用和管理。

## 🏗️ 系统架构

### 核心组件

```
tools/
├── index.ts                 # 主入口文件，工具注册中心
├── base-tool.ts            # 基础工具抽象类
├── search/                 # 搜索工具类别
│   ├── index.ts            # 注册 web_search / platform_search / bilibili_search
│   ├── search-targets.ts   # 搜索目标注册表（引擎 + 站点平台 + 专属目标）
│   ├── search-tool-base.ts # 三个搜索工具共用的执行链路（导航 + 解析）
│   ├── web-search-tool.ts  # 通用网页检索（engine 枚举）
│   ├── platform-search-tool.ts # 通用站点平台检索（platform 枚举）
│   └── bilibili-search-tool.ts # Bilibili 站内视频检索（目标固定）
├── browser/                 # 浏览器工具类别（导航 / 标签页 / 页面读取 / 交互 / 下载与资源）
│   ├── navigation.ts        # 统一导航（open/refresh/back/forward/wait）
│   ├── tab-management.ts    # 统一标签页与窗口（list/switch/close/create/windows）
│   ├── history-bookmarks.ts # 历史与书签统一入口（九 action）
│   ├── downloads.ts         # 浏览器下载管理器（七 action）
│   ├── resources.ts         # 页面资源与下载捕获（八 action）
│   └── page-info-tool.ts    # 结构化正文 / 页面源码 / 页面元信息
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

浏览器导航只在**现有窗口**内进行：`browser_navigation({action:"open", url})` 默认新标签页，`newTab:false` 使用当前标签页，同 URL 标签可复用；历史前进后退与加载等待同属该工具（`action` 为 `back` / `forward` / `refresh` / `wait`）。`newWindow` 已从导航接口删除，导航没有新建窗口兜底；没有现成窗口时返回错误，标签创建始终显式绑定现有 windowId。

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

// 站点平台检索走另一个工具（platform 枚举：知乎 / GitHub / CSDN / MOOC / 小红书 / 知网）
const result3 = await toolRegistry.executeTool('platform_search', {
  platform: 'zhihu',
  query: 'TypeScript 最佳实践'
});

// Bilibili 站内视频检索是专属工具：目标固定，schema 里没有目标参数
const result4 = await toolRegistry.executeTool('bilibili_search', {
  query: 'TypeScript 教程',
  waitTime: 5000
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
- `BaseSearchTool`（`tools/search/search-tool-base.ts`）: 搜索类工具基类——`web_search` / `platform_search` / `bilibili_search` 共用同一执行链路（导航 → 等待 → 解析 → Markdown 表），子类只声明差异面
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

### 历史与书签工具 (History & Bookmark Tools)

浏览历史与书签已合并为单一工具 `browser_history_bookmarks`（九 action）：

- **search**: 检索历史与书签（source=history/bookmark/both，同 URL 合并；支持时间窗与排序）
- **open**: 打开某条历史或书签（url 或 id，复用 browser_navigation 的导航语义）
- **create / update / delete**: 书签的增、改（含移动到别的文件夹）、删
- **clear**: 清理浏览历史（不可逆，需用户批准；必须显式给时间窗或 all=true）
- **recent / top**: 最近访问的页面、最常访问站点榜
- **folders**: 书签文件夹结构（配合 update 的 parentId 移动书签）

### 下载与资源工具 (Downloads & Resources)

所有可交付文件统一先保存在当前会话工作区 `outputs/`，返回 `WorkspaceArtifact`（`path/name/marker`，可附 `sizeBytes/mime`），通过 `<workspace-file path="outputs/..." />` 渲染下载卡片。工作区不依赖 Python，按 chatId 隔离、按需创建并随会话备份/删除。全局规范唯一来源是 `utils/python-workspace/workspace-prompt.ts`，由 runtime-builder 无条件注入。新文件生产者必须使用 `saveWorkspaceOutput`，不得绕过它写入全局文件库；Python 的事务提交继续由运行时管理。

资源来源库、会话产物和浏览器下载队列各有用途：

- **browser_resources**（八 action）：页面资源与下载捕获
  - `sniff` / `list` / `download`：嗅探当前页可下载资源、按 id 获取并保存到当前会话 outputs/
  - `fetch`：按 URL 获取文件到当前会话 outputs/（无需先嗅探；受网络访问权限与工作区配额限制）
  - `intercept` / `captured` / `export`：下载拦截开关、扩展私有副本库、副本复制到当前会话 outputs/
  - `status`：拦截器与副本库总体状态
- 默认由用户点击文件卡片下载。`xlsx_tool(autoDownload=true)` 和 `browser_resources(openAfterDownload=true)` 可额外发起浏览器下载；额外下载失败保留工作区产物并返回警告。历史 `[file:ID|文件名]` 仅保留读取兼容，不迁移无会话归属的旧文件。
- **browser_downloads**（七 action）：浏览器下载管理器（chrome.downloads）
  - `list` 查询历史与进行中任务；`cancel` / `pause` / `resume` 控制下载
  - `erase` 清除历史记录（不动磁盘文件）；`show` 定位文件；`open` 打开文件
- **browser_get_page_html**：页面 HTML 源码或可见纯文本（format 真正生效、含 iframe、带长度上限）

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
// 三个搜索工具：web_search（通用网页，engine 枚举 bing/baidu）、
// platform_search（站点平台，platform 枚举 zhihu/csdn/github/…）与
// bilibili_search（B 站视频检索，目标固定）——一次调用都完成导航 + 结果解析。
// 注意：三者都自带页面导航（等同 browser_navigation 的 open action），并发调用会互相争抢
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
  // 其他页面，导航到GitHub（直接给地址即可，无需查表）
  await toolRegistry.executeTool('browser_navigation', {
    action: 'open',
    url: 'https://github.com'
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

会话 JavaScript 统一使用全局默认 `js_run`：先 create 保存 `scripts/*.js`，再 run 传相对路径与 JSON `args`（脚本通过 `$args` 读取）。文本编辑与 Python 共用引擎，支持精确/显式缩进匹配、原子 `edits` 及可选 SHA-256 冲突检查。原内联页面执行工具实现保持不变，仅供 backend；两个脚本入口均不出现在智能体工具组中。
