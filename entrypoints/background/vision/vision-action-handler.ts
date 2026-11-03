import { WebSocketClient } from '../ws/websocket-client';
import { VisionActionExecutor } from './vision-action-executor';
import { MessageType, type WebSocketMessage, type VisionActionPayload } from '../ws/websocket-types';
import { GUI_ACTIONS } from '@/tools/vision/gui-driver';
import { guiFailure, GuiError, bounded } from '@/tools/vision/gui-errors';
interface ScreenshotFileHandler { sendScreenshotFile(dataUrl: string, correlationId: string, fileName: string): Promise<boolean> }
export class VisionActionHandler {
  private executor = new VisionActionExecutor();
  private fileHandler?: ScreenshotFileHandler;
  constructor(private wsClient: WebSocketClient) {}
  setFileHandler(handler: ScreenshotFileHandler) { this.fileHandler = handler; }
  async handleVisionAction(message: WebSocketMessage<VisionActionPayload>): Promise<void> {
    const { correlationId, payload } = message ?? {};
    try {
      if (typeof correlationId !== 'string' || !correlationId || correlationId.length > 256) throw new GuiError('INVALID_ARGUMENT', 'A nonempty correlationId of at most 256 characters is required');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !['screenshot', ...GUI_ACTIONS].includes(payload.action)) throw new GuiError('INVALID_ARGUMENT', 'Unsupported normalized GUI action');
      const unknown = Object.keys(payload).filter(k => k !== 'action' && k !== 'parameters');
      if (unknown.length) throw new GuiError('INVALID_ARGUMENT', 'Unexpected vision payload fields', { fields: unknown });
      const data: any = await this.executor.execute(payload.action, payload.parameters);
      if (data.screenshot && this.fileHandler?.sendScreenshotFile) {
        data.screenshotFileSent = await bounded(this.fileHandler.sendScreenshotFile(data.screenshot, correlationId, 'viewport.png'), 10000, 'Deliver screenshot file');
        if (!data.screenshotFileSent) throw new GuiError('TRANSPORT_ERROR', 'Screenshot file delivery failed', { correlationId });
        delete data.screenshot;
      }
      this.respond(correlationId, { success: true, data: { actionCompleted: true, ...data } });
    } catch (error) {
      const failure = guiFailure(error, { correlationId });
      this.respond(correlationId, { success: false, error: failure.error, data: { actionCompleted: false, ...failure.data } });
    }
  }
  private respond(correlationId: string | undefined, payload: import('../ws/websocket-types').VisionActionResponsePayload): void {
    try {
      if (!this.wsClient.send({ type: MessageType.VISION_ACTION_RESPONSE, correlationId, payload }))
        console.warn('[VisionActionHandler] Response could not be sent', { correlationId });
    } catch (error) { console.error('[VisionActionHandler] Response transport failed', { correlationId, error: error instanceof Error ? error.message : String(error) }); }
  }
}
