import { isWorkspaceOutput, isWorkspaceRelativePath } from './paths';

/** Shared wire contract for persisted chat deliverables; never put file bytes in tool text. */
export interface WorkspaceArtifact {
  path: string;
  name: string;
  marker: string;
  sizeBytes?: number;
  mime?: string;
}

export function workspaceArtifact(path: string, blob?: Blob): WorkspaceArtifact {
  if (!isWorkspaceRelativePath(path) || !isWorkspaceOutput(path)) {
    throw new Error('Deliverables must use a workspace-relative outputs/ path');
  }
  const escaped = path.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return {
    path, name: path.slice(path.lastIndexOf('/') + 1),
    marker: '<workspace-file path="' + escaped + '" />',
    ...(blob ? { sizeBytes: blob.size, mime: blob.type || 'application/octet-stream' } : {}),
  };
}

export function requireWorkspaceChatId(chatId: unknown): string {
  if (typeof chatId !== 'string' || !chatId.trim() || chatId.length > 255) {
    throw new Error('[WORKSPACE_CONTEXT_REQUIRED] 文件产物必须绑定当前会话工作区，请在会话中调用此工具');
  }
  return chatId;
}
