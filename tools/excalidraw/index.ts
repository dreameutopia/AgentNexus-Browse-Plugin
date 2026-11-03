/**
 * Excalidraw工具集合
 * 包含各种Excalidraw画布相关的操作工具
 */

import { toolRegistry } from '../registry';
import { SetupExcalidrawCanvasTool } from './setup-excalidraw-canvas-tool';
import { DrawOnCanvasTool } from './draw-on-canvas-tool';
import { ExcalidrawTool } from './excalidraw-tool';

// 创建Excalidraw工具实例
function createExcalidrawTools() {
  return [
    new SetupExcalidrawCanvasTool(),
    new DrawOnCanvasTool(),
    new ExcalidrawTool()
  ];
}

// 注册函数
export function registerExcalidrawTools() {
  const excalidrawTools = createExcalidrawTools();
  excalidrawTools.forEach(tool => {
    toolRegistry.register(tool);
  });
}

export {
  SetupExcalidrawCanvasTool,
  DrawOnCanvasTool,
  ExcalidrawTool
};