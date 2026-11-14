/** Bounded diagnostics for Error, DOMException, thrown objects, and cyclic causes. */
export function errorDetails(error: unknown, limit = 4000): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && current !== undefined && !seen.has(current); depth++) {
    seen.add(current);
    try {
      if (current && typeof current === 'object') {
        const value = current as { name?: unknown; message?: unknown; cause?: unknown };
        const message = typeof value.message === 'string' ? value.message : JSON.stringify(current);
        const name = typeof value.name === 'string' && value.name !== 'Error' ? value.name + ': ' : '';
        parts.push(name + (message || Object.prototype.toString.call(current)));
        current = value.cause;
      } else {
        parts.push(String(current));
        break;
      }
    } catch {
      parts.push('Unserializable error (' + typeof current + ')');
      break;
    }
  }
  return (parts.join(' Caused by: ') || 'Unknown error').slice(0, limit);
}

/** Workspace failures have one domain; tools add their own public namespace at the boundary. */
export class WorkspaceOperationError extends Error {
  constructor(readonly code: string, message: string, cause?: unknown) {
    super(`[WORKSPACE_${code}] ${message}`, cause === undefined ? undefined : { cause });
    this.name = 'WorkspaceOperationError';
  }
}

export function toolErrorDetails(error: unknown, namespace: 'JS' | 'PY'): string {
  // Translate only the error code, never user content embedded in the diagnostic.
  return errorDetails(error).replace(/^(?:WorkspaceOperationError: )?\[WORKSPACE_([A-Z_]+)\]/, `[${namespace}_$1]`);
}
