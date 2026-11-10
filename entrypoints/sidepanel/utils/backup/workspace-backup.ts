import type { StoredChatWorkspace } from '@/entrypoints/sidepanel/core/context/chat-database';
import {
  indexWorkspaceEntries, WORKSPACE_MAX_ENTRIES, WORKSPACE_MAX_FILE_BYTES, workspaceRoot, type WorkspaceEntry,
} from '@/utils/python-workspace/paths';
import { base64ToBytes, bytesToBase64 } from './bytes';

// The JSON export holds both the binary files and their expanded base64 in memory.
const MAX_WORKSPACE_BACKUP_BYTES = 64 * 1024 * 1024;
const MAX_BACKUP_ENTRIES = 20_000;

type WorkspaceBackupEntry = Omit<WorkspaceEntry, 'blob' | 'importId'> & { data?: string; mime?: string };
export type WorkspaceBackup = { chatId: string; entries: WorkspaceBackupEntry[] };

export async function encodeWorkspaceBackups(
  workspaces: readonly StoredChatWorkspace[],
  allowed: ReadonlySet<string>,
): Promise<WorkspaceBackup[]> {
  const selected = workspaces.filter(([chatId, snapshot]) => allowed.has(chatId) && snapshot.entries.length > 0);
  let count = 0;
  let bytes = 0;
  for (const [chatId, { entries }] of selected) {
    indexWorkspaceEntries(workspaceRoot(chatId), entries);
    count += entries.length;
    for (const entry of entries) bytes += entry.blob?.size ?? 0;
  }
  if (bytes > MAX_WORKSPACE_BACKUP_BYTES || count > MAX_BACKUP_ENTRIES) {
    throw new Error('Python 工作区超出 JSON 备份上限（64 MiB 或 20,000 个条目）');
  }
  const backup: WorkspaceBackup[] = [];
  for (const [chatId, { entries }] of selected) {
    const stored: WorkspaceBackupEntry[] = [];
    for (const { path, link, mode, mtime, blob } of entries) {
      const entry: WorkspaceBackupEntry = { path, link, mode, mtime };
      if (blob) {
        entry.data = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
        if (entry.data.length !== Math.ceil(blob.size / 3) * 4) {
          throw new Error(`工作区文件编码失败：${JSON.stringify(path)}`);
        }
        entry.mime = blob.type;
      }
      stored.push(entry);
    }
    backup.push({ chatId, entries: stored });
  }
  return backup;
}

/** Validate without materializing large binary payloads. Decode only during apply. */
export function decodeWorkspaceBackups(
  value: unknown,
  allowed: ReadonlySet<string>,
  materialize: boolean,
): StoredChatWorkspace[] {
  if (!Array.isArray(value) || value.length > allowed.size) throw new Error('无效的 Python 工作区备份列表');
  const seen = new Set<string>();
  let totalBytes = 0;
  let totalEntries = 0;
  return value.map((workspace: WorkspaceBackup) => {
    if (!workspace || typeof workspace.chatId !== 'string' || !allowed.has(workspace.chatId) ||
        seen.has(workspace.chatId) || !Array.isArray(workspace.entries) || workspace.entries.length > WORKSPACE_MAX_ENTRIES) {
      throw new Error('Python 工作区备份引用了无效或重复的会话');
    }
    const { chatId } = workspace;
    seen.add(chatId);
    totalEntries += workspace.entries.length;
    if (totalEntries > MAX_BACKUP_ENTRIES) throw new Error('Python 工作区备份条目过多');
    const entries: WorkspaceEntry[] = workspace.entries.map(entry => {
      if (!entry || typeof entry.path !== 'string') throw new Error('无效的 Python 工作区备份条目');
      const { path, link, mode, mtime, data, mime } = entry;
      let blob: Blob | null = null;
      if (data !== undefined) {
        if (typeof data !== 'string' || data.length % 4 !== 0 || data.length > Math.ceil(WORKSPACE_MAX_FILE_BYTES / 3) * 4 ||
            (mime !== undefined && (typeof mime !== 'string' || mime.length > 255))) {
          throw new Error(`无效的工作区文件内容：${JSON.stringify(path)}`);
        }
        const size = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
        totalBytes += size;
        if (size > WORKSPACE_MAX_FILE_BYTES || totalBytes > MAX_WORKSPACE_BACKUP_BYTES ||
            /[^A-Za-z0-9+/]/.test(data.slice(0, data.endsWith('==') ? -2 : data.endsWith('=') ? -1 : undefined))) {
          throw new Error(`无效或超限的工作区文件：${JSON.stringify(path)}`);
        }
        if (materialize) {
          const bytes = base64ToBytes(data);
          if (!bytes || bytes.byteLength !== size) throw new Error(`工作区文件解码失败：${JSON.stringify(path)}`);
          blob = new Blob([bytes.slice().buffer], { type: mime });
        } else {
          blob = new Blob();
        }
      }
      return { path, link, mode, mtime, blob };
    });
    indexWorkspaceEntries(workspaceRoot(chatId), entries);
    return [chatId, { revision: '', entries }];
  });
}
