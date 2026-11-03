import { GuiError } from './gui-errors';
/** One public contract: full screenshot-relative x/y, inclusive 0..1000. */
export interface RelativePoint { x: number; y: number }
export interface Viewport {
  /** Full CSS viewport INCLUDING scrollbar gutters; matches the uncropped screenshot. */
  width: number; height: number; pageX: number; pageY: number; scale: number;
  devicePixelRatio?: number; contentWidth?: number; contentHeight?: number; zoom?: number;
}
export function finiteRange(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new GuiError('INVALID_ARGUMENT', `${name} must be a finite number in [${min}, ${max}]`, { field: name, min, max });
  return value;
}
export function relativePoint(value: unknown): RelativePoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GuiError('INVALID_ARGUMENT', 'point requires {x,y}');
  if (Object.keys(value).some(k => k !== 'x' && k !== 'y')) throw new GuiError('INVALID_ARGUMENT', 'point accepts only x and y');
  const p = value as RelativePoint;
  return { x: finiteRange(p.x, 'x', 0, 1000), y: finiteRange(p.y, 'y', 0, 1000) };
}
export function toViewport(value: unknown, viewport: Viewport): RelativePoint {
  const p = relativePoint(value);
  finiteRange(viewport.width, 'viewport width', 1, 100000);
  finiteRange(viewport.height, 'viewport height', 1, 100000);
  // 1000 denotes the far edge; move inside the last CSS pixel for hit testing.
  return { x: Math.min(viewport.width - 0.5, p.x * viewport.width / 1000),
    y: Math.min(viewport.height - 0.5, p.y * viewport.height / 1000) };
}
/** Smooth acceleration/deceleration, small perpendicular curve, exact endpoints. */
export function motionPath(from: RelativePoint, to: RelativePoint, steps: number, bend = 0): RelativePoint[] {
  if (!Number.isInteger(steps) || steps < 1 || steps > 1000 || !Number.isFinite(bend)) throw new GuiError('INVALID_ARGUMENT', 'Invalid motion path parameters');
  return Array.from({ length: steps }, (_, i) => {
    const t = (i + 1) / steps, s = t * t * (3 - 2 * t);
    const curve = Math.sin(Math.PI * t) * bend;
    const dx = to.x - from.x, dy = to.y - from.y, length = Math.hypot(dx, dy) || 1;
    return i === steps - 1 ? { ...to } : {
      x: from.x + dx * s - dy / length * curve,
      y: from.y + dy * s + dx / length * curve,
    };
  });
}

export function pngDimensions(base64: unknown): { width: number; height: number } {
  if (typeof base64 !== 'string' || base64.length < 44 || base64.length > 64 * 1024 * 1024)
    throw new GuiError('INVALID_SCREENSHOT', 'Screenshot PNG is empty, truncated or exceeds 48 MiB');
  let bytes: string;
  try { bytes = atob(base64.slice(0, 44)); } catch { throw new GuiError('INVALID_SCREENSHOT', 'Invalid PNG base64 header'); }
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((v, i) => bytes.charCodeAt(i) === v) || bytes.slice(12, 16) !== 'IHDR')
    throw new GuiError('INVALID_SCREENSHOT', 'Screenshot must be a PNG with an IHDR header');
  const uint = (offset: number) => Array.from(bytes.slice(offset, offset + 4)).reduce((v, c) => v * 256 + c.charCodeAt(0), 0);
  const width = uint(16), height = uint(20);
  if (uint(8) !== 13 || width < 1 || height < 1 || width > 32768 || height > 32768)
    throw new GuiError('INVALID_SCREENSHOT', 'Invalid or unsupported PNG dimensions', { width, height });
  return { width, height };
}

export function verifyScreenshotGeometry(image: { width: number; height: number }, viewport: Viewport): void {
  const dpr = finiteRange(viewport.devicePixelRatio, 'devicePixelRatio', 0.1, 16);
  if (Math.abs(image.width - viewport.width * dpr) > 1.1 || Math.abs(image.height - viewport.height * dpr) > 1.1)
    throw new GuiError('INVALID_SCREENSHOT', 'PNG bounds do not match the captured CSS viewport; refusing uncertain coordinates',
      { image, viewport, expectedPixels: { width: viewport.width * dpr, height: viewport.height * dpr } });
}

export function sameViewport(a: Viewport, b: Viewport): boolean {
  return (['width','height','pageX','pageY','scale','devicePixelRatio','contentWidth','contentHeight','zoom'] as const)
    .every(k => a[k] === undefined && b[k] === undefined ||
      typeof a[k] === 'number' && typeof b[k] === 'number' && Math.abs(a[k]! - b[k]!) < 0.01);
}
