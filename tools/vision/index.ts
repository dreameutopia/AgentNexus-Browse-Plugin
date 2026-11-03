import { toolRegistry } from '../registry';
import { ScreenshotTool } from './screenshot-tool';
import { OCRTool } from './ocr-tool';
import { createGuiTools } from './gui-tools';
import { createVisionReadTools } from './read-tools';
import { createVisionObservationTools } from './observation-tools';
export function registerVisionTools() {
  [new ScreenshotTool(), new OCRTool(), ...createGuiTools(), ...createVisionReadTools(), ...createVisionObservationTools()].forEach(tool => toolRegistry.register(tool));
}
export { ScreenshotTool, OCRTool };
export { GuiTool, createGuiTools } from './gui-tools';
