import { bounded, GuiError } from './gui-errors';
import { finiteRange, type Viewport } from './coordinates';

/** Serialized into the extension's isolated world. No debugger and no DOM writes.
 * A document reference in isolated-world state distinguishes same-URL reloads.
 */
export function observationViewportPayload(candidate: string) {
  const scope = globalThis as typeof globalThis & {
    __agentNexusObservedDocument?: { document: Document; id: string };
  };
  if (scope.__agentNexusObservedDocument?.document !== document)
    scope.__agentNexusObservedDocument = { document, id: candidate };
  return { documentId: scope.__agentNexusObservedDocument.id,
    width: innerWidth, height: innerHeight, devicePixelRatio,
    pageX: scrollX, pageY: scrollY, scale: visualViewport?.scale ?? 1,
    offsetX: visualViewport?.offsetLeft ?? 0, offsetY: visualViewport?.offsetTop ?? 0,
    contentWidth: visualViewport?.width ?? innerWidth, contentHeight: visualViewport?.height ?? innerHeight,
    zoom: 1 };
}

export async function observationViewport(tabId: number): Promise<{ viewport: Viewport; documentId: string }> {
  const rows = await bounded(chrome.scripting.executeScript({ target: { tabId, frameIds: [0] },
    world: 'ISOLATED', func: observationViewportPayload, args: [crypto.randomUUID()] }), 3000, 'Read observation viewport');
  const value = rows[0]?.result;
  if (!value || typeof value.documentId !== 'string' || !value.documentId)
    throw new GuiError('TARGET_UNAVAILABLE', 'Observation document unavailable');
  finiteRange(value.width, 'viewport width', 1, 32768); finiteRange(value.height, 'viewport height', 1, 32768);
  finiteRange(value.devicePixelRatio, 'devicePixelRatio', 0.1, 16);
  finiteRange(value.pageX, 'scrollX', -1e9, 1e9); finiteRange(value.pageY, 'scrollY', -1e9, 1e9);
  if (Math.abs(value.scale - 1) > 0.001 || value.offsetX || value.offsetY)
    throw new GuiError('GEOMETRY_CHANGED', 'Reset pinch zoom before visual observation');
  const { documentId, offsetX: _x, offsetY: _y, ...viewport } = value;
  return { documentId, viewport };
}
