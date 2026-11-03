import { SemanticCompressor } from './semantic-compressor';
import { toolRegistry } from '../registry';

// 注册工具到全局注册表
export function registerTextCompressionTools() {
  const semanticCompressor = new SemanticCompressor();
  toolRegistry.register(semanticCompressor);
}

// 导出工具类
export { SemanticCompressor };