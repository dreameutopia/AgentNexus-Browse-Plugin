import { toolRegistry } from '../registry';
import { jsRunTool } from './js-run-tool';
export function registerJavaScriptTools(): void { toolRegistry.register(jsRunTool); }
export { JsRunTool, jsRunTool } from './js-run-tool';
export { JS_RUN_TOOL_ID } from './js-contract';
