import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ScreenshotTool } from './screenshot-tool';

// OCR工具参数接口
interface OCRParams {
  autoScreenshot?: boolean; // 是否自动截图
  imageBase64?: string; // base64格式的图片数据
  language?: string; // OCR识别语言，默认为'eng+chi_sim'
}

/**
 * OCR文字识别工具
 * 支持自动截图或直接输入base64图片进行文字识别
 */
export class OCRTool extends BaseTool {
  name = 'ocr';
  
  metadata: ToolMetadata = {
    name: 'ocr',
    description: 'OCR文字识别工具，支持自动截图或输入base64图片进行文字识别',
    category: 'vision',
    version: '1.0.0',
    author: 'Chrome Extension',
    tags: ['ocr', 'text-recognition', 'vision', 'tesseract']
  };
  
  parameters: { type: 'object'; properties: Record<string, any>; required?: string[] } = {
    type: 'object',
    properties: {
      autoScreenshot: {
        type: 'boolean',
        description: '是否自动截图进行OCR识别',
        default: false
      },
      imageBase64: {
        type: 'string',
        description: 'base64格式的图片数据（如果autoScreenshot为true，此参数可为空）'
      },
      language: {
        type: 'string',
        description: 'OCR识别语言代码，支持eng（英文）、chi_sim（简体中文）等',
        default: 'eng+chi_sim'
      }
    },
    required: []
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'ocr',
      description: 'OCR文字识别工具，支持自动截图或输入base64图片进行文字识别',
      parameters: this.parameters
    }
  };

  async execute(parameters: OCRParams): Promise<ToolResult> {
    try {
      let imageBase64 = parameters.imageBase64 as unknown as string | Record<string, any> | undefined;
      
      // 如果需要自动截图
      if (parameters.autoScreenshot) {
        const screenshotTool = new ScreenshotTool();
        const screenshotResult = await screenshotTool.execute({
          format: 'png',
          quality: 100
        });
        
        if (!screenshotResult.success || !screenshotResult.data) {
          return {
            success: false,
            error: '自动截图失败: ' + (screenshotResult.error || '未知错误')
          };
        }
        
        // screenshot-tool 返回的数据通常为 { screenshot: string, width, height }
        const data = screenshotResult.data as any;
        imageBase64 = typeof data === 'string' ? data : (data?.screenshot || data?.imageBase64 || data?.dataUrl || undefined);

        if (!imageBase64 || typeof imageBase64 !== 'string') {
          return {
            success: false,
            error: '自动截图成功但未返回有效的图片数据'
          };
        }
      }
      
      // 兼容处理：若外部传入的不是字符串，尝试从常见字段中提取
      if (imageBase64 && typeof imageBase64 !== 'string') {
        const obj = imageBase64 as any;
        imageBase64 = obj?.screenshot || obj?.imageBase64 || obj?.dataUrl || obj?.url || undefined;
      }
      
      // 检查是否有图片数据
      if (!imageBase64 || typeof imageBase64 !== 'string') {
        return {
          success: false,
          error: '请提供图片数据或启用自动截图功能'
        };
      }
      
      // 移除base64前缀（如果存在）
      const base64Data = imageBase64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
      
      // 执行OCR识别
      const ocrResult = await this.performOCR(base64Data, parameters.language || 'eng+chi_sim');
      
      return {
        success: true,
        data: {
          text: ocrResult.text,
          confidence: ocrResult.confidence,
          language: parameters.language || 'eng+chi_sim',
          imageSize: {
            width: ocrResult.width,
            height: ocrResult.height
          }
        }
      };
      
    } catch (error) {
      return {
        success: false,
        error: `OCR识别失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  
  /**
   * 执行OCR识别
   */
  private async performOCR(base64Data: string, language: string): Promise<{
    text: string;
    confidence: number;
    width: number;
    height: number;
  }> {
    return new Promise((resolve, reject) => {
      try {
        // 动态导入Tesseract.js（v7 API：createWorker 返回 Promise<Worker>，
        // 语言/模型在创建时传入，Worker 自带 load/recognize/terminate）
        import('tesseract.js')
          .then(async ({ createWorker }) => {
            const worker = await createWorker(language, undefined, {
              logger: (m) => console.log('[OCR]', m)
            });
            try {
              // 将base64转换为图片
              const imageData = `data:image/png;base64,${base64Data}`;
              const { data } = await worker.recognize(imageData);
              // Page 类型未声明 width/height（不同版本实现不一致），保留运行时字段并兕底为 0
              const page = data as { text: string; confidence: number; width?: number; height?: number };
              resolve({
                text: page.text.trim(),
                confidence: page.confidence,
                width: page.width || 0,
                height: page.height || 0
              });
            } finally {
              await worker.terminate();
            }
          })
          .catch((error) => {
            reject(new Error(`无法加载Tesseract.js库: ${error instanceof Error ? error.message : String(error)}`));
          });
      } catch (error) {
        reject(error);
      }
    });
  }
}