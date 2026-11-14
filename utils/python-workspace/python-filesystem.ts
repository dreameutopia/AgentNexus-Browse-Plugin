import type { PyodideInterface } from 'pyodide';
import { chatDatabase } from '@/entrypoints/sidepanel/core/context/chat-database';
import {
  checkWorkspaceLimits, indexWorkspaceEntries, isInternalWorkspaceLink,
  isWorkspacePath, workspaceOutputPaths, workspaceRoot, type WorkspaceEntry, type WorkspaceSnapshot,
} from './paths';
import { saveWorkspace, withWorkspaceLock, type WorkspaceCommitGuard } from './store';

type FS = PyodideInterface['FS'];
type MountedFS = FS & {
  filesystems: { MEMFS: Parameters<FS['mount']>[0] };
  streams: Array<(globalThis.FS.FSStream & { node: globalThis.FS.FSNode }) | null>;
};

export class WorkspaceRuntimeError extends Error {}

function collectWorkspace(fs: FS, root: string, previous: Map<string, WorkspaceEntry>): WorkspaceEntry[] {
  const entries: WorkspaceEntry[] = [];
  const pending = [''];
  let bytes = 0;
  while (pending.length) {
    const folder = pending.pop()!;
    for (const name of fs.readdir(folder ? `${root}/${folder}` : root)) {
      if (name === '.' || name === '..') continue;
      const path = folder ? `${folder}/${name}` : name;
      if (!isWorkspacePath(path)) throw new Error(`Invalid workspace path: ${path}`);
      const absolute = `${root}/${path}`;
      const stat = fs.lstat(absolute);
      if (fs.isLink(stat.mode)) {
        const link = fs.readlink(absolute);
        if (path === 'inputs' || path === 'outputs' || !isInternalWorkspaceLink(root, path, link)) {
          throw new Error(`Symbolic link ${JSON.stringify(path)} leaves the workspace or replaces a reserved directory. Copy the target into a regular file instead.`);
        }
        checkWorkspaceLimits(entries.length + 1, bytes);
        entries.push({ path, blob: null, link });
        continue;
      }
      const isDirectory = fs.isDir(stat.mode);
      if (isDirectory) pending.push(path);
      else if (!fs.isFile(stat.mode) || path === 'inputs' || path === 'outputs') {
        throw new Error(`Unsupported file type at ${JSON.stringify(path)}. Write a regular file or directory instead.`);
      }
      const size = isDirectory ? 0 : stat.size;
      bytes += size;
      checkWorkspaceLimits(entries.length + 1, bytes, size);
      const original = previous.get(path);
      const blob = isDirectory ? null : new Blob([fs.readFile(absolute) as Uint8Array<ArrayBuffer>], { type: original?.blob?.type });
      entries.push({
        path, blob, mode: stat.mode & 0o777, mtime: stat.mtime.getTime(),
        importId: blob ? original?.importId : undefined,
      });
    }
  }
  return entries;
}

type WorkspaceOutcome = { ok: boolean; workspaceOutputs?: string[] };

/** Stage a complete run in MEMFS and release it before any IndexedDB write. */
export async function stagePythonWorkspace<T extends WorkspaceOutcome>(
  fs: FS,
  chatId: string,
  snapshot: WorkspaceSnapshot | undefined,
  run: () => Promise<T>,
  signal?: AbortSignal,
  collect = true,
): Promise<{ outcome: T; entries?: WorkspaceEntry[] }> {
  const root = workspaceRoot(chatId);
  const previous = indexWorkspaceEntries(root, snapshot?.entries ?? []);
  const originalCwd = fs.cwd();
  const mountedFs = fs as MountedFS;
  fs.mkdirTree(root);
  let mounted = false;
  let primaryError: unknown;
  try {
    fs.mount(mountedFs.filesystems.MEMFS, {}, root);
    mounted = true;
    const mount = fs.lookupPath(root, { follow: true }).node.mount;
    fs.mkdirTree(`${root}/inputs`);
    fs.mkdirTree(`${root}/outputs`);
    const restored = [...previous.values()];
    for (const { path, blob, link } of restored) {
      signal?.throwIfAborted();
      const absolute = `${root}/${path}`;
      if (blob || link) fs.mkdirTree(absolute.slice(0, absolute.lastIndexOf('/')));
      else fs.mkdirTree(absolute);
      if (blob) fs.writeFile(absolute, new Uint8Array(await blob.arrayBuffer()));
    }
    // Apply links last so hydration can never write a file through a restored link.
    for (const { path, link } of restored) {
      if (link) fs.symlink(link, `${root}/${path}`);
    }
    for (const { path, link, mtime, mode } of restored.sort((a, b) => b.path.length - a.path.length)) {
      if (link) continue;
      const absolute = `${root}/${path}`;
      if (mtime !== undefined) fs.utime(absolute, mtime, mtime);
      if (mode !== undefined) fs.chmod(absolute, mode);
    }
    signal?.throwIfAborted();
    fs.chdir(root);
    const outcome = await run();
    const open = mountedFs.streams.find(stream => stream?.node?.mount === mount);
    if (open) {
      throw new WorkspaceRuntimeError(
        `A workspace file is still open (fd ${open.fd}). Close files, memory maps, and databases before returning; use with/open or a finally block.` +
        (outcome.ok ? '' : ` Python also reported: ${'errorDetail' in outcome ? String(outcome.errorDetail) : 'execution failed'}`),
      );
    }
    if (!outcome.ok || !collect) return { outcome };
    signal?.throwIfAborted();
    const entries = collectWorkspace(fs, root, previous);
    return { outcome, entries };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      fs.chdir('/');
      if (mounted) fs.unmount(root);
      fs.rmdir(root);
      if (fs.analyzePath(originalCwd).exists) fs.chdir(originalCwd);
    } catch (cleanupError) {
      throw new WorkspaceRuntimeError(
        `Workspace cleanup failed: ${String(cleanupError)}` +
        (primaryError === undefined ? '' : ` (original error: ${String(primaryError)})`),
      );
    }
  }
}

export function withPythonWorkspace<T extends WorkspaceOutcome>(
  fs: FS,
  chatId: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
  authorizeCommit: WorkspaceCommitGuard = commit => commit(),
): Promise<T> {
  return withWorkspaceLock(chatId, async () => {
    const snapshot = await chatDatabase.readWorkspace(chatId, signal);
    const { outcome, entries } = await stagePythonWorkspace(fs, chatId, snapshot, run, signal);
    if (entries) {
      await authorizeCommit(() => saveWorkspace(chatId, snapshot?.revision, entries, signal));
      outcome.workspaceOutputs = workspaceOutputPaths(entries);
    }
    return outcome;
  }, signal);
}
