import { toolRegistry } from '../registry';
import { ScreenshotTool } from './screenshot-tool';
import { OCRTool } from './ocr-tool';
import { VisionGuiTool } from './gui-tool';
// 只读观察（read/read_scroll）已并入 vision_gui 的 action 面，不再单独注册工具。
export function registerVisionTools() {
  [new ScreenshotTool(), new OCRTool(), new VisionGuiTool()].forEach(tool => toolRegistry.register(tool));
}
export { ScreenshotTool, OCRTool };
export { VisionGuiTool } from './gui-tool';
