import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

export interface TaskSubmitParams {
  taskType: 'page_content_processing' | 'smart_click_navigation' | 'data_extraction' | 'conditional_judgment';
  taskConfig: {
    // 页面内容处理配置
    contentProcessing?: {
      action: 'summarize' | 'extract_key_info' | 'translate' | 'analyze';
      targetLanguage?: string;
      extractFields?: string[];
    };
    // 智能点击/跳转配置
    smartClick?: {
      targetDescription: string;
      actionType: 'click' | 'navigate' | 'hover';
      waitAfterAction?: number;
    };
    // 数据提取配置
    dataExtraction?: {
      targetData: string;
      extractionMethod: 'text' | 'attribute' | 'structure';
      selectors?: string[];
      attributes?: string[];
    };
    // 条件判断配置
    conditionalJudgment?: {
      condition: string;
      trueAction?: string;
      falseAction?: string;
      checkMethod: 'text_content' | 'element_exists' | 'url_pattern';
    };
  };
  context?: {
    currentUrl?: string;
    pageTitle?: string;
    userInput?: string;
    previousSteps?: any[];
  };
}

export interface TaskSubmitResponse {
  taskId: string;
  status: 'submitted' | 'processing' | 'completed' | 'failed';
  estimatedTime?: number;
  message: string;
}

export class TaskSubmitTool extends BaseTool {
  name = 'task-submit';
  
  metadata: ToolMetadata = {
    name: 'task-submit',
    description: '提交AI任务到后端处理，支持页面内容处理、智能点击、数据提取和条件判断等任务类型',
    category: 'base',
    version: '1.0.0',
    author: 'Chrome Extension',
    tags: ['ai', 'task', 'submit', 'processing']
  };
  
  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'task-submit',
      description: '提交AI任务到后端处理，支持页面内容处理、智能点击、数据提取和条件判断等任务类型',
      parameters: {
        type: 'object',
        properties: {
          taskType: {
            type: 'string',
            enum: ['page_content_processing', 'smart_click_navigation', 'data_extraction', 'conditional_judgment'],
            description: '任务类型：页面内容处理、智能点击/跳转、数据提取、条件判断'
          },
          taskConfig: {
            type: 'object',
            description: '任务配置，根据不同任务类型包含不同的配置项',
            properties: {
              contentProcessing: {
                type: 'object',
                properties: {
                  action: {
                    type: 'string',
                    enum: ['summarize', 'extract_key_info', 'translate', 'analyze'],
                    description: '内容处理动作'
                  },
                  targetLanguage: {
                    type: 'string',
                    description: '目标语言（翻译时使用）'
                  },
                  extractFields: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '要提取的字段列表'
                  }
                }
              },
              smartClick: {
                type: 'object',
                properties: {
                  targetDescription: {
                    type: 'string',
                    description: '目标元素的描述'
                  },
                  actionType: {
                    type: 'string',
                    enum: ['click', 'navigate', 'hover'],
                    description: '操作类型'
                  },
                  waitAfterAction: {
                    type: 'number',
                    description: '操作后等待时间（毫秒）'
                  }
                }
              },
              dataExtraction: {
                type: 'object',
                properties: {
                  targetData: {
                    type: 'string',
                    description: '要提取的数据描述'
                  },
                  extractionMethod: {
                    type: 'string',
                    enum: ['text', 'attribute', 'structure'],
                    description: '提取方法'
                  },
                  selectors: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'CSS选择器列表'
                  },
                  attributes: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '要提取的属性列表'
                  }
                }
              },
              conditionalJudgment: {
                type: 'object',
                properties: {
                  condition: {
                    type: 'string',
                    description: '判断条件'
                  },
                  trueAction: {
                    type: 'string',
                    description: '条件为真时的操作'
                  },
                  falseAction: {
                    type: 'string',
                    description: '条件为假时的操作'
                  },
                  checkMethod: {
                    type: 'string',
                    enum: ['text_content', 'element_exists', 'url_pattern'],
                    description: '检查方法'
                  }
                }
              }
            }
          },
          context: {
            type: 'object',
            description: '任务上下文信息',
            properties: {
              currentUrl: {
                type: 'string',
                description: '当前页面URL'
              },
              pageTitle: {
                type: 'string',
                description: '当前页面标题'
              },
              userInput: {
                type: 'string',
                description: '用户输入'
              },
              previousSteps: {
                type: 'array',
                description: '之前的步骤'
              }
            }
          }
        },
        required: ['taskType', 'taskConfig']
      }
    }
  };

  async execute(params: TaskSubmitParams): Promise<ToolResult> {
    try {
      this.validateArgs(params, ['taskType', 'taskConfig']);
      
      const { taskType, taskConfig, context } = params;
      
      this.log(`Submitting ${taskType} task`);
      
      // 获取当前页面信息作为上下文
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const currentTab = tabs[0];
      
      const taskData = {
        id: this.generateTaskId(),
        type: taskType,
        config: taskConfig,
        context: {
          ...context,
          currentUrl: currentTab?.url || context?.currentUrl,
          pageTitle: currentTab?.title || context?.pageTitle,
          timestamp: Date.now(),
          userAgent: navigator.userAgent
        },
        status: 'submitted' as const,
        createdAt: new Date().toISOString()
      };
      
      // 模拟提交到后端处理队列
      // 在实际实现中，这里应该调用后端API
      const response: TaskSubmitResponse = {
        taskId: taskData.id,
        status: 'submitted',
        estimatedTime: this.getEstimatedTime(taskType),
        message: `Task ${taskData.id} submitted successfully`
      };
      
      // 将任务存储到本地存储中，供后续查询
      await this.storeTask(taskData);
      
      this.log(`Task ${response.taskId} submitted successfully`);
      
      return this.createSuccessResponse({
        taskId: response.taskId,
        status: response.status,
        estimatedTime: response.estimatedTime,
        taskType,
        config: taskConfig
      }, response.message);
      
    } catch (error) {
      return this.createErrorResponse('Failed to submit task', error);
    }
  }
  
  /**
   * 生成任务ID
   */
  private generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * 获取预估处理时间（秒）
   */
  private getEstimatedTime(taskType: string): number {
    const timeMap = {
      'page_content_processing': 10,
      'smart_click_navigation': 5,
      'data_extraction': 15,
      'conditional_judgment': 8
    };
    return timeMap[taskType as keyof typeof timeMap] || 10;
  }
  
  /**
   * 存储任务到本地存储
   */
  private async storeTask(taskData: any): Promise<void> {
    try {
      const result = await chrome.storage.local.get(['aiTasks']);
      const tasks = result.aiTasks || [];
      tasks.push(taskData);
      
      // 只保留最近100个任务
      if (tasks.length > 100) {
        tasks.splice(0, tasks.length - 100);
      }
      
      await chrome.storage.local.set({ aiTasks: tasks });
    } catch (error) {
      this.log(`Failed to store task: ${error}`, 'warn');
    }
  }
}

export const taskSubmitTool = new TaskSubmitTool();