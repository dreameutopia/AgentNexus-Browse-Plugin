import { toolRegistry } from '../registry';
import { ScreenshotTool } from './screenshot-tool';
import { OCRTool } from './ocr-tool';
import { createGuiTools } from './gui-tools';
export function registerVisionTools() {
  [new ScreenshotTool(), new OCRTool(), ...createGuiTools()].forEach(tool => toolRegistry.register(tool));
}
export { ScreenshotTool, OCRTool };
export { GuiTool, createGuiTools } from './gui-tools';
