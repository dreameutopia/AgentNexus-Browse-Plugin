export const WORKSPACE_ROOT = '/work-space';
export const WORKSPACE_MAX_FILE_BYTES = 128 * 1024 * 1024;
export const WORKSPACE_MAX_BYTES = 256 * 1024 * 1024;
export const WORKSPACE_MAX_ENTRIES = 2048;
const MAX_PATH_BYTES = 1024;
const MAX_NAME_BYTES = 255;
const encoder = new TextEncoder();

export interface WorkspaceEntry {
  path: string;
  /** A null blob represents a directory or, when link is set, a symbolic link. */
  blob: Blob | null;
  link?: string;
  mode?: number;
  mtime?: number;
  importId?: string;
}

export interface WorkspaceSnapshot {
  revision: string;
  entries: WorkspaceEntry[];
}

export class WorkspaceMissingChatError extends Error {
  constructor() {
    super('The chat for this workspace no longer exists');
    this.name = 'WorkspaceMissingChatError';
  }
}

export function isWorkspaceName(name: string): boolean {
  if (!name || name === '.' || name === '..' || name.length > MAX_NAME_BYTES ||
      name.includes('/') || name.includes('\\')) return false;
  return [...name].every(char => {
    const code = char.codePointAt(0)!;
    return code >= 32 && code !== 127 && (code < 0xd800 || code > 0xdfff);
  });
}

export function isWorkspacePath(path: string): boolean {
  return path.length <= MAX_PATH_BYTES && path.split('/').every(isWorkspaceName);
}

export function truncateWorkspaceName(name: string, suffix: string): string {
  let remaining = MAX_NAME_BYTES - encoder.encode(suffix).length;
  let prefix = '';
  for (const char of name) {
    remaining -= encoder.encode(char).length;
    if (remaining < 0) break;
    prefix += char;
  }
  return prefix + suffix;
}

export function isWorkspaceOutput(path: string): boolean {
  return path.startsWith('outputs/') && isWorkspacePath(path);
}

export function workspaceOutputPaths(entries: readonly WorkspaceEntry[]): string[] {
  return entries.filter(entry => entry.blob && isWorkspaceOutput(entry.path)).map(entry => entry.path).sort();
}

export function workspaceRoot(chatId: string): string {
  // Normal chat IDs are preserved. Encode opaque IDs restored from older backups.
  const folder = encodeURIComponent(chatId).replace(/\./g, '%2E');
  if (!isWorkspaceName(folder)) throw new Error('Invalid chat ID for the Python workspace');
  return `${WORKSPACE_ROOT}/${folder}`;
}

/** MEMFS resolves each symlink target lexically before following it. Keep every hop in this mount. */
export function isInternalWorkspaceLink(root: string, path: string, target: string): boolean {
  if (!target || encoder.encode(target).length > MAX_PATH_BYTES) return false;
  if (target.startsWith('/') && target !== root && !target.startsWith(`${root}/`)) return false;
  const parts = target.startsWith('/') ? [] : path.split('/').slice(0, -1);
  const relative = target.startsWith('/') ? target.slice(root.length) : target;
  for (const part of relative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return false;
      parts.pop();
    } else {
      if (!isWorkspaceName(part)) return false;
      parts.push(part);
    }
  }
  return !parts.length || isWorkspacePath(parts.join('/'));
}

export function checkWorkspaceLimits(count: number, bytes: number, fileBytes = 0): void {
  if (fileBytes > WORKSPACE_MAX_FILE_BYTES) throw new Error('Workspace file limit is 128 MiB');
  if (bytes > WORKSPACE_MAX_BYTES) throw new Error('Workspace total limit is 256 MiB');
  if (count > WORKSPACE_MAX_ENTRIES) throw new Error('Workspace limit is 2048 files and folders');
}

/** Validate the complete manifest before hydration or persistence, including parent types. */
export function indexWorkspaceEntries(root: string, entries: readonly WorkspaceEntry[]): Map<string, WorkspaceEntry> {
  const index = new Map<string, WorkspaceEntry>();
  let bytes = 0;
  checkWorkspaceLimits(entries.length, 0);
  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string' || !isWorkspacePath(entry.path) ||
        index.has(entry.path) || (entry.blob !== null && !(entry.blob instanceof Blob)) ||
        (entry.link !== undefined && (entry.blob !== null || typeof entry.link !== 'string' ||
          !isInternalWorkspaceLink(root, entry.path, entry.link))) ||
        (entry.mode !== undefined && (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)) ||
        (entry.mtime !== undefined && !Number.isFinite(entry.mtime)) ||
        (entry.importId !== undefined && (typeof entry.importId !== 'string' || !entry.blob))) {
      throw new Error(`Invalid workspace entry: ${JSON.stringify(entry?.path)}`);
    }
    if ((entry.path === 'inputs' || entry.path === 'outputs') && (entry.blob || entry.link)) {
      throw new Error(`Workspace ${entry.path}/ must be a directory`);
    }
    const size = entry.blob?.size ?? 0;
    bytes += size;
    checkWorkspaceLimits(index.size + 1, bytes, size);
    index.set(entry.path, entry);
  }
  for (const path of index.keys()) {
    for (let slash = path.lastIndexOf('/'); slash >= 0; slash = path.lastIndexOf('/', slash - 1)) {
      const parent = index.get(path.slice(0, slash));
      if (parent?.blob || parent?.link) throw new Error(`Workspace parent is not a directory: ${parent.path}`);
    }
  }
  return index;
}
