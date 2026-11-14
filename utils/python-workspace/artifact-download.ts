import { arrayBufferToBase64 } from '@/utils/shared/base64';
import type { WorkspaceArtifact } from './artifact-contract';

/** Optional browser export is separate from durable workspace persistence. */
export async function downloadWorkspaceArtifact(file: WorkspaceArtifact, blob: Blob): Promise<number> {
  if (typeof document !== 'undefined') {
    const url = URL.createObjectURL(blob);
    try {
      return await chrome.downloads.download({ url, filename: file.name, saveAs: false, conflictAction: 'uniquify' });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }
  if (blob.size > 8 * 1024 * 1024) {
    throw new Error('后台自动下载超过 8MB，请使用回复中的文件卡片下载');
  }
  const url = 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + arrayBufferToBase64(await blob.arrayBuffer());
  return chrome.downloads.download({ url, filename: file.name, saveAs: false, conflictAction: 'uniquify' });
}
