import { toolRegistry } from '../registry';
import { ScreenshotTool } from './screenshot-tool';
import { OCRTool } from './ocr-tool';
import { VisionGuiTool } from './gui-tool';
import { createVisionReadTools } from './read-tools';
export function registerVisionTools() {
  [new ScreenshotTool(), new OCRTool(), new VisionGuiTool(), ...createVisionReadTools()].forEach(tool => toolRegistry.register(tool));
}
export { ScreenshotTool, OCRTool };
export { VisionGuiTool } from './gui-tool';
