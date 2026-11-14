import { requireWorkspaceChatId, workspaceArtifact, type WorkspaceArtifact } from './artifact-contract';
import { isWorkspaceRelativePath } from './paths';
import { chatDatabase } from '@/entrypoints/sidepanel/core/context/chat-database';
import { withNamedLock } from '@/utils/shared/async-lock';
import { WorkspaceOperationError } from '@/utils/shared/error-details';
import {
  checkWorkspaceLimits, indexWorkspaceEntries, isWorkspaceName, isWorkspaceOutput, truncateWorkspaceName,
  WorkspaceMissingChatError, workspaceRoot, type WorkspaceEntry,
} from './paths';

export async function withWorkspaceLock<T>(chatId: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  requireWorkspaceChatId(chatId);
  return withNamedLock(`agentnexus-workspace:${chatId}`, work, signal);
}

export async function importWorkspaceFiles(
  chatId: string,
  files: readonly { id: string; file: File }[],
): Promise<Map<string, string>> {
  if (!files.length) return new Map();
  return withWorkspaceLock(chatId, () => chatDatabase.updateWorkspace(chatId, current => {
    const entries = new Map((current?.entries ?? []).map(entry => [entry.path, entry]));
    const imported = new Map<string, string>();
    for (const entry of entries.values()) if (entry.importId) imported.set(entry.importId, entry.path);
    const paths = new Map<string, string>();
    let bytes = [...entries.values()].reduce((size, entry) => size + (entry.blob?.size ?? 0), 0);
    const inputs = entries.get('inputs');
    if (inputs?.blob || inputs?.link) throw new Error('Workspace inputs must be a directory');
    if (!inputs) entries.set('inputs', { path: 'inputs', blob: null });
    let changed = false;
    for (const { id, file } of files) {
      const previous = imported.get(id);
      if (previous) {
        paths.set(id, previous);
        continue;
      }
      const name = file.name;
      if (!isWorkspaceName(name)) throw new Error(`Invalid workspace filename: ${JSON.stringify(name)}`);
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 && name.length - dot <= 32 ? name.slice(dot) : '';
      let path = `inputs/${name}`;
      for (let suffix = 2; entries.has(path); suffix++) {
        const label = ` (${suffix})`;
        path = `inputs/${truncateWorkspaceName(stem, label + ext)}`;
      }
      bytes += file.size;
      checkWorkspaceLimits(entries.size + 1, bytes, file.size);
      entries.set(path, { path, blob: file, importId: id, mtime: file.lastModified });
      imported.set(id, path);
      paths.set(id, path);
      changed = true;
    }
    return {
      snapshot: changed ? { revision: crypto.randomUUID(), entries: [...entries.values()] } : undefined,
      result: paths,
    };
  }));
}

export async function saveWorkspace(
  chatId: string,
  expectedRevision: string | undefined,
  entries: WorkspaceEntry[],
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  indexWorkspaceEntries(workspaceRoot(chatId), entries);
  return chatDatabase.updateWorkspace(chatId, current => {
    if (current?.revision !== expectedRevision) {
      throw new WorkspaceOperationError('CONFLICT', 'Workspace changed during the operation. Read the latest files before retrying.');
    }
    return { snapshot: { revision: crypto.randomUUID(), entries }, result: undefined };
  }, signal);
}

export type WorkspaceCommitGuard = (commit: () => Promise<void>) => Promise<void>;

export async function readWorkspaceOutput(chatId: string, path: string): Promise<Blob | null> {
  if (!chatId || !isWorkspaceOutput(path)) return null;
  try {
    const snapshot = await chatDatabase.readWorkspace(chatId);
    const blob = snapshot?.entries.find(entry => entry.path === path)?.blob;
    if (blob != null && !(blob instanceof Blob)) throw new Error('The workspace file has invalid stored data');
    return blob ?? null;
  } catch (error) {
    if (error instanceof WorkspaceMissingChatError) return null;
    throw error;
  }
}

/** Atomically persist a deliverable, preserving earlier files and rejecting linked parents.
 * Independent of Python; the transaction verifies ownership against concurrent chat deletion.
 */
export async function saveWorkspaceOutput(
  chatId: string,
  requestedPath: string,
  blob: Blob,
  signal?: AbortSignal,
): Promise<WorkspaceArtifact> {
  requireWorkspaceChatId(chatId);
  if (!isWorkspaceRelativePath(requestedPath) || !isWorkspaceOutput(requestedPath) || !(blob instanceof Blob)) {
    throw new Error('Invalid workspace output path or contents');
  }
  checkWorkspaceLimits(1, blob.size, blob.size);
  return withWorkspaceLock(chatId, () => chatDatabase.updateWorkspace(chatId, current => {
    const root = workspaceRoot(chatId);
    const entries = indexWorkspaceEntries(root, current?.entries ?? []);
    const slash = requestedPath.lastIndexOf('/');
    const directory = requestedPath.slice(0, slash);
    const name = requestedPath.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 && name.length - dot <= 32 ? name.slice(dot) : '';
    let path = requestedPath;
    for (let suffix = 2; entries.has(path); suffix++) {
      path = directory + '/' + truncateWorkspaceName(stem, ' (' + suffix + ')' + extension);
    }
    for (let end = path.lastIndexOf('/'); end >= 0; end = path.lastIndexOf('/', end - 1)) {
      const parent = path.slice(0, end);
      const existing = entries.get(parent);
      if (existing?.blob || existing?.link) throw new Error('Workspace parent is not a directory: ' + parent);
      if (!existing) entries.set(parent, { path: parent, blob: null });
    }
    entries.set(path, { path, blob, mtime: Date.now() });
    const combined = [...entries.values()];
    indexWorkspaceEntries(root, combined);
    return {
      snapshot: { revision: crypto.randomUUID(), entries: combined },
      result: workspaceArtifact(path, blob),
    };
  }, signal), signal);
}
