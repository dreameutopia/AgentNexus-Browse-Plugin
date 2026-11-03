/**
 * Bilibili工具集合
 * 包含B站视频字幕提取和视频控制相关的操作工具
 */

import { toolRegistry } from '../registry';
import { BilibiliSubtitleTool } from './bilibili-subtitle-tool';
import { BilibiliJumpTool } from './bilibili-jump-tool';

// 创建Bilibili工具实例
function createBilibiliTools() {
  return [
    new BilibiliSubtitleTool(),
    new BilibiliJumpTool()
  ];
}

// 注册函数
export function registerBilibiliTools() {
  const bilibiliTools = createBilibiliTools();
  bilibiliTools.forEach(tool => {
    toolRegistry.register(tool);
  });
}

export {
  BilibiliSubtitleTool,
  BilibiliJumpTool
};