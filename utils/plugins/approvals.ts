/**
 * 插件工具会话级审批缓存。
 *
 * 只缓存 approvalLevel='session' 的授权，key 由 chatId + pluginKey + digest +
 * epoch 组成：插件更新或重装后 digest/epoch 变化，旧授权自动失效。
 * 存储失败只告警，不影响本次授权判定（内存 Map 仍然生效）。
 */
const TTL_MS = 12 * 60 * 60 * 1000;
const STORAGE_PREFIX = 'plugin-approval:';

/**
 * 存储值携带 pluginKey，而不是从复合 key 里 split 反推：
 * pluginKey 自身就形如 `ed25519:xxx/bilibili`，含冒号，反推必然错位。
 */
interface ApprovalRecord {
  expiresAt: number;
  pluginKey: string;
}

const memory = new Map<string, ApprovalRecord>();

export interface PluginApprovalKey {
  chatId: string;
  pluginKey: string;
  digest: string;
  epoch?: number;
}

function keyOf(input: PluginApprovalKey): string {
  return [
    input.chatId || 'default',
    input.pluginKey,
    input.digest,
    String(input.epoch ?? 0),
  ].join(':');
}

function sessionStorage(): chrome.storage.StorageArea | undefined {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage) return undefined;
    return chrome.storage.session || undefined;
  } catch {
    return undefined;
  }
}

/** 读取并校验存储记录；畸形记录直接忽略（含缺少 pluginKey 的陈旧值） */
function readRecord(value: unknown): ApprovalRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<ApprovalRecord>;
  if (
    typeof record.expiresAt !== 'number' ||
    !Number.isFinite(record.expiresAt) ||
    typeof record.pluginKey !== 'string' ||
    !record.pluginKey
  )
    return null;
  return { expiresAt: record.expiresAt, pluginKey: record.pluginKey };
}

function isValidKey(input: PluginApprovalKey): boolean {
  return Boolean(input.chatId && input.pluginKey && input.digest);
}

export async function hasPluginSessionApproval(
  input: PluginApprovalKey,
): Promise<boolean> {
  if (!isValidKey(input)) return false;
  const key = keyOf(input);
  const now = Date.now();
  const cached = memory.get(key);
  if (cached) {
    if (cached.expiresAt > now) return true;
    memory.delete(key);
  }
  const storage = sessionStorage();
  if (!storage) return false;
  const storageKey = STORAGE_PREFIX + key;
  try {
    const all = await storage.get(storageKey);
    const record = readRecord(all?.[storageKey]);
    if (record && record.expiresAt > now) {
      memory.set(key, record);
      return true;
    }
    // 过期记录留在会话存储里只会持续占用配额，读取时顺手回收。
    if (record) await storage.remove(storageKey).catch(() => undefined);
  } catch (error) {
    console.warn('[Plugins] 读取会话审批缓存失败，按未授权处理', error);
  }
  return false;
}

export async function grantPluginSessionApproval(
  input: PluginApprovalKey,
): Promise<void> {
  if (!isValidKey(input)) {
    console.warn('[Plugins] 会话审批参数不完整，已忽略本次授权');
    return;
  }
  const key = keyOf(input);
  const record: ApprovalRecord = {
    expiresAt: Date.now() + TTL_MS,
    pluginKey: input.pluginKey,
  };
  memory.set(key, record);
  const storage = sessionStorage();
  if (!storage) return;
  try {
    await storage.set({ [STORAGE_PREFIX + key]: record });
  } catch (error) {
    console.warn('[Plugins] 写入会话审批缓存失败，仅本次内存生效', error);
  }
}

export async function revokePluginApprovals(pluginKey?: string): Promise<void> {
  for (const [key, record] of [...memory.entries()]) {
    if (!pluginKey || record.pluginKey === pluginKey) memory.delete(key);
  }
  const storage = sessionStorage();
  if (!storage) return;
  try {
    const all = (await storage.get(null)) ?? {};
    const now = Date.now();
    const stale = Object.keys(all).filter((key) => {
      if (!key.startsWith(STORAGE_PREFIX)) return false;
      const record = readRecord(all[key]);
      // 畸形记录与过期记录一律回收；无参调用 = 撤销全部授权。
      if (!record) return true;
      if (record.expiresAt <= now) return true;
      return pluginKey ? record.pluginKey === pluginKey : true;
    });
    if (stale.length) await storage.remove(stale);
  } catch (error) {
    console.warn('[Plugins] 清理会话审批缓存失败', error);
  }
}
