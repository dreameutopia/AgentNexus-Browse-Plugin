/**
 * 代码工具集合
 * 包含代码执行和渲染相关工具
 */

import { toolRegistry } from '../registry';
import { MermaidRendererTool } from './mermaid-renderer';

// 创建代码工具实例
function createCodeTools() {
  return [
    new MermaidRendererTool()
  ];
}

// 注册函数
export function registerCodeTools() {
  const codeTools = createCodeTools();
  codeTools.forEach(tool => {
    toolRegistry.register(tool);
  });
}

export {
  MermaidRendererTool
};