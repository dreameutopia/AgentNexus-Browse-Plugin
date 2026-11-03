import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

export interface TaskResultParams {
  taskId: string;
  includeDetails?: boolean;
}

export interface TaskResultResponse {
  taskId: string;
  status: 'submitted' | 'processing' | 'completed' | 'failed';
  result?: any;
  error?: string;
  progress?: number;
  startTime?: string;
  endTime?: string;
  executionTime?: number;
  details?: {
    steps?: any[];
    logs?: string[];
    metadata?: any;
  };
}

export class TaskResultTool extends BaseTool {
  name = 'task-result';
  
  metadata: ToolMetadata = {
    name: 'task-result',
    description: '获取AI任务的处理状态和结果，支持查询任务进度、执行结果和详细信息',
    category: 'base',
    version: '1.0.0',
    author: 'Chrome Extension',
    tags: ['ai', 'task', 'result', 'status']
  };
  
  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'task-result',
      description: '获取AI任务的处理状态和结果，支持查询任务进度、执行结果和详细信息',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: '任务ID，由task-submit工具返回'
          },
          includeDetails: {
            type: 'boolean',
            description: '是否包含详细信息（步骤、日志等），默认为false',
            default: false
          }
        },
        required: ['taskId']
      }
    }
  };

  async execute(params: TaskResultParams): Promise<ToolResult> {
    try {
      this.validateArgs(params, ['taskId']);
      
      const { taskId, includeDetails = false } = params;
      
      this.log(`Getting result for task: ${taskId}`);
      
      // 从本地存储获取任务信息
      const taskData = await this.getStoredTask(taskId);
      
      if (!taskData) {
        return this.createErrorResponse(`Task ${taskId} not found`);
      }
      
      // 模拟任务处理逻辑
      const result = await this.processTaskResult(taskData, includeDetails);
      
      this.log(`Task ${taskId} status: ${result.status}`);
      
      return this.createSuccessResponse(result, `Task result retrieved successfully`);
      
    } catch (error) {
      return this.createErrorResponse('Failed to get task result', error);
    }
  }
  
  /**
   * 从本地存储获取任务
   */
  private async getStoredTask(taskId: string): Promise<any | null> {
    try {
      const result = await chrome.storage.local.get(['aiTasks']);
      const tasks = result.aiTasks || [];
      return tasks.find((task: any) => task.id === taskId) || null;
    } catch (error) {
      this.log(`Failed to get stored task: ${error}`, 'warn');
      return null;
    }
  }
  
  /**
   * 更新任务状态到本地存储
   */
  private async updateStoredTask(taskId: string, updates: any): Promise<void> {
    try {
      const result = await chrome.storage.local.get(['aiTasks']);
      const tasks = result.aiTasks || [];
      const taskIndex = tasks.findIndex((task: any) => task.id === taskId);
      
      if (taskIndex !== -1) {
        tasks[taskIndex] = { ...tasks[taskIndex], ...updates };
        await chrome.storage.local.set({ aiTasks: tasks });
      }
    } catch (error) {
      this.log(`Failed to update stored task: ${error}`, 'warn');
    }
  }
  
  /**
   * 处理任务结果
   */
  private async processTaskResult(taskData: any, includeDetails: boolean): Promise<TaskResultResponse> {
    const currentTime = Date.now();
    const createdTime = new Date(taskData.createdAt).getTime();
    const elapsedTime = currentTime - createdTime;
    
    // 模拟任务处理状态
    let status = taskData.status || 'submitted';
    let result: any = null;
    const error: string | undefined = undefined;
    let progress = 0;
    
    // 根据时间模拟任务进度
    if (elapsedTime < 2000) {
      status = 'submitted';
      progress = 0;
    } else if (elapsedTime < 5000) {
      status = 'processing';
      progress = Math.min(90, (elapsedTime - 2000) / 3000 * 90);
    } else {
      status = 'completed';
      progress = 100;
      result = await this.generateMockResult(taskData);
    }
    
    // 更新任务状态
    await this.updateStoredTask(taskData.id, {
      status,
      progress,
      result,
      error,
      lastUpdated: new Date().toISOString()
    });
    
    const response: TaskResultResponse = {
      taskId: taskData.id,
      status: status as any,
      progress,
      startTime: taskData.createdAt,
      executionTime: elapsedTime
    };
    
    if (status === 'completed' && result) {
      response.result = result;
      response.endTime = new Date().toISOString();
    }
    
    if (error) {
      response.error = error;
    }
    
    if (includeDetails) {
      response.details = {
        steps: this.generateMockSteps(taskData),
        logs: this.generateMockLogs(taskData),
        metadata: {
          taskType: taskData.type,
          config: taskData.config,
          context: taskData.context
        }
      };
    }
    
    return response;
  }
  
  /**
   * 生成模拟结果
   */
  private async generateMockResult(taskData: any): Promise<any> {
    const { type, config } = taskData;
    
    switch (type) {
      case 'page_content_processing':
        return {
          processedContent: '这是处理后的页面内容摘要...',
          keyPoints: ['要点1', '要点2', '要点3'],
          wordCount: 1250,
          language: 'zh-CN'
        };
        
      case 'smart_click_navigation':
        return {
          targetFound: true,
          elementSelector: '.target-button',
          actionPerformed: config.smartClick?.actionType || 'click',
          navigationUrl: 'https://example.com/result',
          success: true
        };
        
      case 'data_extraction':
        return {
          extractedData: {
            title: '示例标题',
            price: '¥99.00',
            description: '这是一个示例商品描述',
            availability: '有库存'
          },
          extractionMethod: config.dataExtraction?.extractionMethod || 'text',
          elementsFound: 4,
          confidence: 0.95
        };
        
      case 'conditional_judgment':
        return {
          conditionMet: true,
          conditionValue: '条件检查结果',
          actionTaken: config.conditionalJudgment?.trueAction || '执行默认操作',
          checkMethod: config.conditionalJudgment?.checkMethod || 'text_content',
          confidence: 0.88
        };
        
      default:
        return {
          message: '任务执行完成',
          success: true
        };
    }
  }
  
  /**
   * 生成模拟步骤
   */
  private generateMockSteps(taskData: any): any[] {
    return [
      {
        step: 1,
        action: '初始化任务',
        status: 'completed',
        timestamp: taskData.createdAt,
        duration: 100
      },
      {
        step: 2,
        action: '分析页面内容',
        status: 'completed',
        timestamp: new Date(Date.now() - 3000).toISOString(),
        duration: 2000
      },
      {
        step: 3,
        action: '执行AI处理',
        status: 'completed',
        timestamp: new Date(Date.now() - 1000).toISOString(),
        duration: 2000
      },
      {
        step: 4,
        action: '生成结果',
        status: 'completed',
        timestamp: new Date().toISOString(),
        duration: 500
      }
    ];
  }
  
  /**
   * 生成模拟日志
   */
  private generateMockLogs(taskData: any): string[] {
    return [
      `[${new Date(taskData.createdAt).toISOString()}] Task ${taskData.id} created`,
      `[${new Date(Date.now() - 4000).toISOString()}] Starting ${taskData.type} processing`,
      `[${new Date(Date.now() - 3000).toISOString()}] Page analysis completed`,
      `[${new Date(Date.now() - 1000).toISOString()}] AI processing completed`,
      `[${new Date().toISOString()}] Task completed successfully`
    ];
  }
}

export const taskResultTool = new TaskResultTool();