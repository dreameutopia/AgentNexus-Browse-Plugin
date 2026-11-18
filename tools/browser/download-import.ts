import type { WorkspaceArtifact } from '@/utils/python-workspace/artifact-contract';
import { ArtifactSizeLimitError, readArtifactResponse } from '@/utils/python-workspace/artifact-fetch';
import { truncateWorkspaceName, WorkspaceMissingChatError } from '@/utils/python-workspace/paths';
import { saveWorkspaceOutput } from '@/utils/python-workspace/store';
import { withNamedLock } from '@/utils/shared/async-lock';
import { withDeadline } from '../common/frame-read';

export const DOWNLOAD_IMPORT_LIMIT = 100_000_000;
const PREFIX = 'browser-download-task:';
const PENDING_KEY = PREFIX + 'pending';
const ALARM = 'agentnexus-download-import';
const activeImports = new Map<string, Promise<void>>();
let reconciling = false;

type WorkspaceResult =
  | { workspaceStatus: 'waiting' | 'too_large' | 'permission_required' }
  | { workspaceStatus: 'unavailable'; workspaceCode?: 'DOWNLOAD_RECORD_MISSING' | 'LOCAL_FILE_MISSING' | 'LOCAL_PATH_MISSING' }
  | {
    workspaceStatus: 'failed';
    workspaceCode: 'UNSUPPORTED_LOCAL_PATH' | 'LOCAL_READ_TIMED_OUT' | 'LOCAL_READ_FAILED' |
      'LOCAL_SIZE_CHANGED' | 'WORKSPACE_CHAT_MISSING' | 'WORKSPACE_QUOTA_EXCEEDED' |
      'WORKSPACE_WRITE_TIMED_OUT' | 'WORKSPACE_WRITE_FAILED';
    workspaceError: string;
  }
  | { workspaceStatus: 'imported'; file: WorkspaceArtifact };

export type DownloadImportResult = WorkspaceResult & {
  downloadId: string;
  browserDownloadId: number;
  downloadState: chrome.downloads.DownloadItem['state'] | 'missing';
  filename?: string;
  sizeBytes?: number;
  downloadError?: string;
  danger?: chrome.downloads.DownloadItem['danger'];
  paused?: boolean;
  bytesReceived?: number;
  totalBytes?: number;
  progressPercent?: number;
  canResume?: boolean;
};

interface DownloadImportJob {
  id: string;
  chatId: string;
  browserDownloadId: number;
  startTime: string;
  incognito: boolean;
  revision: number;
  result?: DownloadImportResult;
}

function filenameOf(path: string): string {
  return path.split(/[/\\]/).at(-1) ?? '';
}

/** Only accept absolute local paths from Chrome's completed DownloadItem. */
function downloadFileUrl(path: string): string | undefined {
  const drive = /^[A-Za-z]:[/\\]/.test(path);
  const parts = (drive ? path.replace(/\\/g, '/').slice(3) : path.slice(1)).split('/');
  if ((!drive && !path.startsWith('/')) || parts.some(part => !part || part === '.' || part === '..' || part.includes('\0'))) {
    return;
  }
  return 'file:///' + (drive ? path.slice(0, 2) + '/' : '') + parts.map(encodeURIComponent).join('/');
}

async function loadJob(id: string): Promise<DownloadImportJob | undefined> {
  const key = PREFIX + id;
  return (await chrome.storage.local.get(key))[key];
}

async function syncAlarm(pending: readonly string[]): Promise<void> {
  try {
    if (!chrome.alarms) return;
    if (!pending.length) await chrome.alarms.clear(ALARM);
    else if (!await chrome.alarms.get(ALARM)) {
      await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    }
  } catch (error) {
    console.warn('[DownloadImport] 无法调度已登记下载，将在启动或查询时重试', error);
  }
}

export async function trackDownloadImport(item: chrome.downloads.DownloadItem, chatId: string): Promise<DownloadImportResult> {
  const job = await withNamedLock(ALARM, async () => {
    const bindingKey = PREFIX + 'native:' + item.id;
    const data = await chrome.storage.local.get([bindingKey, PENDING_KEY]);
    const previous = typeof data[bindingKey] === 'string' ? await loadJob(data[bindingKey]) : undefined;
    if (previous && previous.startTime === item.startTime && previous.incognito === item.incognito) {
      if (previous.chatId !== chatId) throw new Error('下载记录已归属于另一个会话');
      return previous;
    }
    const job: DownloadImportJob = {
      id: crypto.randomUUID(), chatId, browserDownloadId: item.id, startTime: item.startTime, incognito: item.incognito, revision: 0,
    };
    const pending = [...(data[PENDING_KEY] ?? []), job.id];
    await syncAlarm(pending);
    await chrome.storage.local.set({ [PREFIX + job.id]: job, [bindingKey]: job.id, [PENDING_KEY]: pending });
    return job;
  });
  if (!job.result) queueReconcile(job.id);
  return job.result ?? snapshot(job, item);
}

async function importOriginal(
  item: chrome.downloads.DownloadItem,
  job: DownloadImportJob,
): Promise<WorkspaceResult> {
  if (item.state !== 'complete') {
    return { workspaceStatus: item.state === 'in_progress' ? 'waiting' : 'unavailable' };
  }
  if (!item.exists) return { workspaceStatus: 'unavailable', workspaceCode: 'LOCAL_FILE_MISSING' };
  if (!item.filename) return { workspaceStatus: 'unavailable', workspaceCode: 'LOCAL_PATH_MISSING' };
  if (item.fileSize >= DOWNLOAD_IMPORT_LIMIT) return { workspaceStatus: 'too_large' };
  const url = downloadFileUrl(item.filename);
  if (!url) return { workspaceStatus: 'failed', workspaceCode: 'UNSUPPORTED_LOCAL_PATH', workspaceError: '保存位置不是支持的本地绝对路径。' };
  if (!await chrome.extension.isAllowedFileSchemeAccess()) return { workspaceStatus: 'permission_required' };

  const readSignal = AbortSignal.timeout(25_000);
  let blob: Blob;
  try {
    const response = await fetch(url, { signal: readSignal });
    blob = await readArtifactResponse(response, DOWNLOAD_IMPORT_LIMIT - 1, readSignal);
  } catch (error) {
    if (error instanceof ArtifactSizeLimitError) return { workspaceStatus: 'too_large' };
    if (readSignal.aborted) {
      return { workspaceStatus: 'failed', workspaceCode: 'LOCAL_READ_TIMED_OUT', workspaceError: '读取本机文件超时，可用同一 ID 续查。' };
    }
    return { workspaceStatus: 'failed', workspaceCode: 'LOCAL_READ_FAILED', workspaceError: '本机文件读取失败，请检查文件是否仍可访问。' };
  }

  if (item.fileSize >= 0 && blob.size !== item.fileSize) {
    return { workspaceStatus: 'failed', workspaceCode: 'LOCAL_SIZE_CHANGED', workspaceError: '本机文件大小与浏览器记录不符，请核对原件。' };
  }
  const name = truncateWorkspaceName(filenameOf(item.filename), '');
  const writeSignal = AbortSignal.timeout(25_000);
  try {
    const file = await saveWorkspaceOutput(job.chatId, 'outputs/' + name, blob, writeSignal, job.id);
    return { workspaceStatus: 'imported', file };
  } catch (error) {
    if (error instanceof WorkspaceMissingChatError) {
      return { workspaceStatus: 'failed', workspaceCode: 'WORKSPACE_CHAT_MISSING', workspaceError: '原会话已不存在。' };
    }
    if (error instanceof Error && (error.name === 'QuotaExceededError' ||
      /^Workspace (?:file limit|total limit|limit is)/.test(error.message))) {
      return { workspaceStatus: 'failed', workspaceCode: 'WORKSPACE_QUOTA_EXCEEDED', workspaceError: '工作区或浏览器存储配额不足。' };
    }
    if (writeSignal.aborted) {
      return { workspaceStatus: 'failed', workspaceCode: 'WORKSPACE_WRITE_TIMED_OUT', workspaceError: '工作区写入超时，可用同一 ID 续查。' };
    }
    return { workspaceStatus: 'failed', workspaceCode: 'WORKSPACE_WRITE_FAILED', workspaceError: '工作区写入失败，可用同一 ID 续查。' };
  }
}

function snapshot(job: DownloadImportJob, item?: chrome.downloads.DownloadItem, workspace?: WorkspaceResult): DownloadImportResult {
  const ids = { downloadId: job.id, browserDownloadId: job.browserDownloadId };
  if (!item) return { ...ids, downloadState: 'missing', workspaceStatus: 'unavailable', workspaceCode: 'DOWNLOAD_RECORD_MISSING' };
  const bytesReceived = item.bytesReceived >= 0 ? item.bytesReceived : undefined;
  const totalBytes = item.totalBytes >= 0 ? item.totalBytes : undefined;
  const progressPercent = item.state === 'complete' ? 100 : bytesReceived !== undefined && totalBytes
    ? Math.min(100, Math.floor(100 * bytesReceived / totalBytes)) : undefined;
  return {
    ...ids,
    downloadState: item.state,
    filename: filenameOf(item.filename) || undefined,
    sizeBytes: item.fileSize >= 0 ? item.fileSize : undefined,
    downloadError: item.error,
    danger: item.danger,
    paused: item.paused,
    canResume: item.canResume,
    bytesReceived,
    totalBytes,
    progressPercent,
    ...(workspace ?? { workspaceStatus: item.state === 'interrupted' ? 'unavailable' : 'waiting' }),
  };
}

async function getNativeItem(job: DownloadImportJob): Promise<chrome.downloads.DownloadItem | undefined> {
  const [item] = await withDeadline(() => chrome.downloads.search({ id: job.browserDownloadId }), 3000, '查询已登记的浏览器下载');
  if (item?.startTime === job.startTime && item.incognito === job.incognito) return item;
}

async function setResult(job: DownloadImportJob, result?: DownloadImportResult): Promise<void> {
  await withNamedLock(ALARM, async () => {
    const key = PREFIX + job.id;
    const data = await chrome.storage.local.get([PENDING_KEY, key]);
    const current = data[key] as DownloadImportJob | undefined;
    if (!current || current.revision !== job.revision) return;
    const pending = new Set<string>(data[PENDING_KEY] ?? []);
    if (result) pending.delete(job.id);
    else pending.add(job.id);
    const ids = [...pending];
    if (ids.length) await syncAlarm(ids);
    await chrome.storage.local.set({ [key]: { ...current, revision: current.revision + 1, result }, [PENDING_KEY]: ids });
    if (!ids.length) await syncAlarm(ids);
  });
}

function reportTrackingError(error: unknown): void {
  console.warn('[DownloadImport] 已登记任务处理失败', error);
}

function queueReconcile(id: string): Promise<void> {
  const current = activeImports.get(id);
  if (current) return current;
  const pending = (async () => {
    const job = await loadJob(id);
    if (!job || job.result) return;
    const item = await getNativeItem(job);
    if (item?.state === 'in_progress') return;
    const workspace = item?.state === 'complete'
      ? await withNamedLock(ALARM + ':file', () => importOriginal(item, job)) : undefined;
    await setResult(job, snapshot(job, item, workspace));
  })().catch(reportTrackingError).finally(() => activeImports.delete(id));
  activeImports.set(id, pending);
  return pending;
}

export function canRetryDownloadImport(result: DownloadImportResult): boolean {
  return result.workspaceStatus === 'failed' && (
    result.workspaceCode === 'LOCAL_READ_FAILED' ||
    result.workspaceCode === 'LOCAL_READ_TIMED_OUT' ||
    result.workspaceCode === 'WORKSPACE_WRITE_FAILED' ||
    result.workspaceCode === 'WORKSPACE_WRITE_TIMED_OUT' ||
    result.workspaceCode === 'WORKSPACE_QUOTA_EXCEEDED'
  );
}

export async function downloadImportStatus(id: string, chatId: string, retryImport = false): Promise<DownloadImportResult | undefined> {
  const job = await loadJob(id);
  if (!job || job.chatId !== chatId) return;
  const previous = job.result;
  const retryFailedImport = previous && retryImport && canRetryDownloadImport(previous);
  if (previous && !retryFailedImport && previous.workspaceStatus !== 'permission_required' &&
      !(previous.downloadState === 'interrupted' && previous.canResume)) return previous;
  const item = await getNativeItem(job);
  if (previous?.workspaceStatus === 'permission_required') {
    if (item?.state !== 'complete' || !await chrome.extension.isAllowedFileSchemeAccess()) return previous;
    await setResult(job);
  } else if (retryFailedImport) {
    if (!item) return snapshot(job);
    if (item.state !== 'complete') return previous;
    await setResult(job);
  } else if (previous) {
    if (!item || item.state === 'interrupted') return previous;
    await setResult(job);
  }
  if (item?.state !== 'in_progress') void queueReconcile(id);
  return snapshot(job, item);
}

async function refreshTrackingAlarm(): Promise<void> {
  await withNamedLock(ALARM, async () => {
    const data = await chrome.storage.local.get(PENDING_KEY);
    await syncAlarm(data[PENDING_KEY] ?? []);
  });
}

async function reconcilePending(): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    await refreshTrackingAlarm();
    const data = await chrome.storage.local.get(PENDING_KEY);
    const pending: string[] = data[PENDING_KEY] ?? [];
    for (let i = 0; i < pending.length; i += 3) {
      await Promise.all(pending.slice(i, i + 3).map(queueReconcile));
    }
  } finally {
    reconciling = false;
  }
}

/** Wake only for our timer. Every reconciliation addresses a persisted browser download ID. */
export function initDownloadImport(): void {
  if (!chrome.alarms?.onAlarm || !chrome.storage?.local) return;
  const resume = () => { void reconcilePending().catch(reportTrackingError); };
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM) resume();
  });
  chrome.runtime.onStartup.addListener(resume);
  resume();
}
