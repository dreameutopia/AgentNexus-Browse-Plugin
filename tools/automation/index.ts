/**
 * 自动化工具注册
 */

import { toolRegistry } from '../index';
import { FileUploadGetterTool } from './file-upload-getter';
import { FileUploaderTool } from './file-uploader';
import { aiLocateTool } from './ai-locate-tool';
import { aiActionTool } from './ai-action-tool';
import { extractDataTool } from './extract-data-tool';
import { formFillerTool } from './form-filler';
import { restrictedUrlCheckerTool } from './restricted-url-checker';
import { xiaozhiConfigTool } from './xiaozhi-config-tool';

/**
 * 注册自动化工具
 */
export function registerAutomationTools() {
  // 注册文件上传框获取工具
  toolRegistry.register(new FileUploadGetterTool());
  
  // 注册文件上传工具
  toolRegistry.register(new FileUploaderTool());
  
  // 注册AI定位工具
  toolRegistry.register(aiLocateTool);
  
  // 注册AI操作工具
  toolRegistry.register(aiActionTool);
  
  // 注册数据提取工具
  toolRegistry.register(extractDataTool);
  
  // 注册表单填充工具
  toolRegistry.register(formFillerTool);
  
  // 注册受限URL检查工具
  toolRegistry.register(restrictedUrlCheckerTool);
  
  // 注册小智配置工具
  toolRegistry.register(xiaozhiConfigTool);
}

// 导出工具类
export { FileUploadGetterTool } from './file-upload-getter';
export { xiaozhiConfigTool, XiaozhiConfigTool } from './xiaozhi-config-tool';
export { FileUploaderTool } from './file-uploader';
export { restrictedUrlCheckerTool, RestrictedUrlCheckerTool } from './restricted-url-checker';