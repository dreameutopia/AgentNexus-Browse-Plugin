/**
 * 数据引用通道工具注册
 */

import { toolRegistry } from '../registry';
import { dataRefTool } from './data-ref-tool';

export function registerDataTools(): void {
  toolRegistry.register(dataRefTool);
}

export { dataRefTool } from './data-ref-tool';
export { DataRefTool } from './data-ref-tool';
