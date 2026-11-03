/**
 * 工具测试模块类型定义
 */

/** 工具参数定义 */
export interface ToolParameter {
  type: string;
  description: string;
  default?: any;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  multiline?: boolean;
  placeholder?: string;
  items?: any;
  properties?: any;
}

/** 工具定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  category: string;
  version: string;
  parameters: Record<string, ToolParameter>;
  required: string[];
}

/** 工具分类 */
export interface ToolCategory {
  id: string;
  name: string;
  icon: string;
  tools: ToolDefinition[];
}

/** 导航测试日志条目 */
export interface NavigationTestLog {
  url: string;
  time: number;
  error?: string;
}

/** 导航测试结果 */
export interface NavigationTestResult {
  total: number;
  success: number;
  failed: number;
  totalTime: number;
  avgTime: number;
  logs: NavigationTestLog[];
}

/** 工具执行结果 */
export interface ExecutionResult {
  isError?: boolean;
  content?: Array<{
    type: string;
    text?: string;
    source?: { type: string };
    [key: string]: any;
  }>;
  success?: boolean;
  error?: string;
  [key: string]: any;
}
