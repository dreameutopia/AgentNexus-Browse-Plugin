/**
 * micropip 安装清单（跨调用 / 跨会话复用的单一事实源）
 *
 * ==================== 问题背景 ====================
 * micropip 安装的包只存在于当前 Pyodide 实例的内存文件系统里：
 * worker 空闲 60s 被回收（python-host WORKER_IDLE_MS）后，新 worker 起来
 * 包就没了——而 wheel 字节其实一直躺在 IndexedDB 缓存里（fetch 拦截层
 * 白名单放行了 files.pythonhosted.org / pypi.org），只是没有任何机制
 * 把「装过什么」记下来并在新实例上重放。
 *
 * ==================== 复用作用域 ====================
 * - 全局复用（默认开启）：清单写 chrome.storage.local —— 一次安装，
 *   所有会话、所有工具调用永久复用，浏览器重启后依然有效（wheel 走本地
 *   缓存，离线可复装）。
 * - 关闭全局复用：清单写 chrome.storage.session —— 仅当前浏览器生命周期
 *   内复用，浏览器关闭后需重新安装。
 * - 切换作用域时双向迁移（并集），保证任何方向的切换都不丢已装记录：
 *   开→关：local ∪→ session（本会话继续可用）；关→开：session ∪→ local。
 *
 * ==================== 复用机制 ====================
 * - 恢复（restore）：每次执行前（清单非空时）探测实例内已装的 pypi 包，
 *   对清单中缺失的条目按**精确 wheel URL** 重放 micropip.install(deps=False)。
 *   依赖闭包已由探测逐条记录（openpyxl + et-xmlfile 各自成条），无需再解析。
 *   wheel 命中 IndexedDB 缓存 → 离线零下载；清单未变化时探测不到缺失即空操作。
 * - 记录（record）：执行后若代码触及 micropip，探测新装的包并入清单。
 *   探测依据 dist-info 的 PYODIDE_SOURCE：'pyodide' = 官方锁文件包（不记），
 *   'pypi' / URL = micropip 装的（记）。
 *
 * ==================== 防御性约定 ====================
 * - 所有 storage 读写永不抛错（形态异常回退默认值）；session 区不可用时
 *   降级 local（data-ref-store 同款策略），保证清单不丢。
 * - 探测 / 恢复失败绝不阻断执行：探测失败返回空，恢复失败聚合为
 *   packageWarning 随结果透出。
 * - 清单条目数封顶 MAX_ENTRIES（按 installedAt 保留最新）；URL 必须是
 *   https:// 且长度受限，防畸形元数据进清单。
 */

import type { PyodideInterface } from 'pyodide';

/** 清单条目：一次 micropip 安装（含依赖闭包中的每个包） */
export interface MicropipPackage {
  /** 规范包名（importlib.metadata 原始名，如 et_xmlfile） */
  name: string;
  version: string;
  /** 精确 wheel URL（恢复首��通道；缺失时降级 name==version） */
  url: string | null;
  /** wheel sha256（PyPI 元数据自带；恢复时供校验参考） */
  sha256: string | null;
  /** 首次记录时间（epoch ms） */
  installedAt: number;
}

/** 对外状态快照（设置 + 当前作用域清单） */
export interface MicropipState {
  globalReuse: boolean;
  packages: MicropipPackage[];
}

const SETTINGS_KEY = 'pyodide_micropip_settings';
const MANIFEST_KEY = 'pyodide_micropip_manifest';
/** 清单容量封顶（防御畸形膨胀；chrome.storage 配额远大于此） */
const MAX_ENTRIES = 500;
const MAX_URL_LENGTH = 2048;

/** 探测代码：收集实例内全部 micropip 安装痕迹（锁文件包 PYODIDE_SOURCE='pyodide' 被排除） */
const PROBE_CODE = `
import json, importlib.metadata as md
out = []
for d in md.distributions():
    try:
        src = d.read_text('PYODIDE_SOURCE')
        if src is None or src == 'pyodide':
            continue
        url = d.read_text('PYODIDE_URL')
        sha = d.read_text('PYODIDE_SHA256')
        out.append({
            'name': (d.name or '').strip(),
            'version': (d.version or '').strip(),
            'url': url.strip() if isinstance(url, str) else None,
            'sha256': sha.strip() if isinstance(sha, str) else None,
        })
    except Exception:
        continue
json.dumps(out)
`;

// ==================== 形态校验（防御性：storage 与探测输出都过这道闸） ====================

/** PEP 503 规范化包名（et_xmlfile 与 et-xmlfile 视为同包） */
export function canonicalMicropipName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-');
}

function sanitizePackage(raw: unknown, installedAt: number): MicropipPackage | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Partial<MicropipPackage>;
  if (typeof entry.name !== 'string') return null;
  const name = entry.name.trim();
  if (!name || name.length > 128) return null;
  const version = typeof entry.version === 'string' ? entry.version.trim().slice(0, 64) : '';
  const url =
    typeof entry.url === 'string' &&
    entry.url.startsWith('https://') &&
    entry.url.length <= MAX_URL_LENGTH
      ? entry.url
      : null;
  const sha256 =
    typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(entry.sha256)
      ? entry.sha256.toLowerCase()
      : null;
  const at =
    typeof entry.installedAt === 'number' && Number.isFinite(entry.installedAt) && entry.installedAt > 0
      ? entry.installedAt
      : installedAt;
  return { name, version, url, sha256, installedAt: at };
}

/** 解析探测 JSON（永不对原始输出 trust；坏条目丢弃，整体非数组返回 []） */
export function parseMicropipProbe(json: string, now = Date.now()): MicropipPackage[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: MicropipPackage[] = [];
  for (const item of raw) {
    const entry = sanitizePackage(item, now);
    if (!entry) continue;
    const key = canonicalMicropipName(entry.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** 清洗外部输入的清单（消息通道 / storage 形态防御：坏条目丢弃，容量封顶） */
export function sanitizeMicropipManifest(raw: unknown): MicropipPackage[] {
  if (!Array.isArray(raw)) return [];
  const merged = mergePackages(
    [],
    raw.map(item => sanitizePackage(item, Date.now())).filter((item): item is MicropipPackage => item !== null),
  );
  return merged.slice(0, MAX_ENTRIES);
}

/** 按规范名合并（同名保留 installedAt 更新者），并按容量封顶（保留最新） */
function mergePackages(base: MicropipPackage[], additions: readonly MicropipPackage[]): MicropipPackage[] {
  const map = new Map<string, MicropipPackage>();
  for (const pkg of base) map.set(canonicalMicropipName(pkg.name), pkg);
  for (const pkg of additions) {
    const key = canonicalMicropipName(pkg.name);
    const existing = map.get(key);
    if (!existing || pkg.installedAt >= existing.installedAt) map.set(key, pkg);
  }
  return [...map.values()].sort((a, b) => b.installedAt - a.installedAt).slice(0, MAX_ENTRIES);
}

// ==================== storage（local / session 双区，永不抛错） ====================

async function readSettings(): Promise<boolean> {
  try {
    const container = await chrome.storage.local.get(SETTINGS_KEY);
    const raw = container?.[SETTINGS_KEY];
    // 缺失 / 形态异常一律视为默认开启
    if (!raw || typeof raw !== 'object') return true;
    return (raw as { globalReuse?: unknown }).globalReuse !== false;
  } catch {
    return true;
  }
}

async function writeSettings(globalReuse: boolean): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: { globalReuse, updatedAt: Date.now() } });
}

async function readArea(area: 'local' | 'session'): Promise<MicropipPackage[]> {
  try {
    const store = chrome.storage[area];
    if (!store) return [];
    const container = await store.get(MANIFEST_KEY);
    return sanitizeMicropipManifest(container?.[MANIFEST_KEY]);
  } catch {
    return [];
  }
}

async function writeArea(area: 'local' | 'session', packages: MicropipPackage[]): Promise<void> {
  const store = chrome.storage[area];
  if (!store) return;
  await store.set({ [MANIFEST_KEY]: packages });
}

/**
 * session 区读写（chrome.storage.session，浏览器关闭即清）。
 * 不可用时降级 local：语义上「仅本会话」会放宽为「持久」，但清单不丢——
 * 与 data-ref-store 的降级取向一致（可用性优先于作用域纯度）。
 */
async function readSessionManifest(): Promise<MicropipPackage[]> {
  if (typeof chrome !== 'undefined' && chrome.storage?.session) return readArea('session');
  return readArea('local');
}

async function writeSessionManifest(packages: MicropipPackage[]): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage?.session) {
    await writeArea('session', packages);
    return;
  }
  await writeArea('local', packages);
}

// ==================== 对外 API ====================

/** 读取当前作用域的 micropip 清单（全局开关决定读 local 还是 session） */
export async function readMicropipManifest(): Promise<MicropipPackage[]> {
  const globalReuse = await readSettings();
  return globalReuse ? readArea('local') : readSessionManifest();
}

/** 读取设置（默认开启全局复用） */
export async function getMicropipGlobalReuse(): Promise<boolean> {
  return readSettings();
}

/**
 * 切换全局复用并**双向迁移清单**（不丢数据）：
 * - 开→关：local 并集写入 session（本浏览器会话继续复用既有包）；local 保留
 *   作为持久层——若浏览器随后关闭，session 清空后重新开启全局时记录仍在；
 * - 关→开：session 并集写入 local（本会话新装的包提升为永久复用），随后清空
 *   session——global 态下 session 恒为空，防僵尸副本。
 *
 * 迁移是「并集」，因此删除必须双区同步（见 removeMicropipPackage），
 * 否则任一区残留的已删条目都会在下次切换时复活。
 */
export async function setMicropipGlobalReuse(globalReuse: boolean): Promise<void> {
  const previous = await readSettings();
  if (previous === globalReuse) {
    await writeSettings(globalReuse);
    return;
  }
  if (globalReuse) {
    const [local, session] = await Promise.all([readArea('local'), readSessionManifest()]);
    await writeArea('local', mergePackages(local, session));
    // 清空 session 副本（失败静默：removeMicropipPackage 的双区删除已兜底复活问题）
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.session) {
        await chrome.storage.session.remove(MANIFEST_KEY);
      }
    } catch {
      // 僵尸副本无害，不阻断切换
    }
  } else {
    const [local, session] = await Promise.all([readArea('local'), readSessionManifest()]);
    await writeSessionManifest(mergePackages(session, local));
  }
  await writeSettings(globalReuse);
}

/**
 * 执行后记录新装的 micropip 包（并入当前作用域清单；空输入零开销直接返回）。
 *
 * installedAt 语义：**首次记录时间**——已存在且版本未变的条目保留原时间戳，
 * 只有新包 / 版本变化的包拿新时间戳（探测输出不带时间戳，由这里补齐）。
 * 写入前做无变化短路，避免每次执行都触发 storage 广播。
 */
export async function recordMicropipPackages(packages: readonly MicropipPackage[]): Promise<void> {
  if (!packages.length) return;
  try {
    // 入口清洗：不管调用方是谁（协议消息 / 探测输出），坏条目一律丢弃
    const incoming = packages
      .map(pkg => sanitizePackage(pkg, Date.now()))
      .filter((pkg): pkg is MicropipPackage => pkg !== null);
    if (!incoming.length) return;
    const current = await readMicropipManifest();
    const currentByName = new Map(current.map(pkg => [canonicalMicropipName(pkg.name), pkg]));
    const normalized = incoming.map(pkg => {
      const existing = currentByName.get(canonicalMicropipName(pkg.name));
      // 同名同版本 → 保留首次记录时间；新装 / 升级 → 用探测时间戳
      return existing && existing.version === pkg.version
        ? { ...pkg, installedAt: existing.installedAt }
        : pkg;
    });
    const merged = mergePackages(current, normalized);
    const unchanged =
      merged.length === current.length &&
      merged.every((pkg, index) => {
        const old = current[index];
        return old !== undefined && pkg.name === old.name && pkg.version === old.version && pkg.installedAt === old.installedAt;
      });
    if (unchanged) return;
    const globalReuse = await readSettings();
    if (globalReuse) await writeArea('local', merged);
    else await writeSessionManifest(merged);
  } catch {
    // 记录失败不影响执行本身（下次执行还有机会补记）
  }
}

/**
 * 删除单条复用记录（只影响后续恢复；当前运行时内已装模块不受影响）。
 *
 * **双区同步删除**：作用域切换是「并集」迁移，任何一区残留被删条目都会在
 * 下次切换时复活——因此 local 与 session 两区都按规范名过滤。
 */
export async function removeMicropipPackage(name: string): Promise<void> {
  const key = canonicalMicropipName(name);
  try {
    const [local, session] = await Promise.all([readArea('local'), readSessionManifest()]);
    const filter = (list: MicropipPackage[]) =>
      list.filter(pkg => canonicalMicropipName(pkg.name) !== key);
    const nextLocal = filter(local);
    const nextSession = filter(session);
    if (nextLocal.length !== local.length) await writeArea('local', nextLocal);
    if (nextSession.length !== session.length) await writeSessionManifest(nextSession);
  } catch {
    // 删除失败静默：清单读写本身永不阻断 UI
  }
}

/** 清空清单（两个作用域都清：语义是「忘掉全部 micropip 安装」） */
export async function clearMicropipManifest(strict = false): Promise<void> {
  const clear = async (area: chrome.storage.StorageArea | undefined) => {
    if (area) await area.remove(MANIFEST_KEY);
  };
  const results = await Promise.allSettled([
    clear(globalThis.chrome?.storage?.local),
    clear(globalThis.chrome?.storage?.session),
  ]);
  const errors = results.flatMap(result => result.status === 'rejected' ? [String(result.reason)] : []);
  if (strict && errors.length) throw new Error('Could not clear the micropip manifest: ' + errors.join(' / '));
}

/**
 * 订阅清单状态（settings + manifest 任一变化都推送最新快照）。
 * chrome.storage.onChanged 天然跨上下文——管理中心与侧边栏实时同步。
 * 无扩展 storage 的环境（测试 / 降级）返回 no-op 订阅，不抛错。
 * @returns 取消订阅函数
 */
export function watchMicropipState(
  listener: (state: MicropipState) => void,
): () => void {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) {
    return () => undefined;
  }
  const handler = (
    changes: Record<string, { newValue?: unknown }>,
    areaName: string,
  ) => {
    if (areaName !== 'local' && areaName !== 'session') return;
    if (!(SETTINGS_KEY in changes) && !(MANIFEST_KEY in changes)) return;
    void (async () => {
      try {
        const [globalReuse, packages] = await Promise.all([readSettings(), readMicropipManifest()]);
        listener({ globalReuse, packages });
      } catch {
        // 快照读取失败不推送（等下次变更重试），绝不让订阅回调抛错
      }
    })();
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

// ==================== 探测 / 恢复（需要 Pyodide 实例） ====================

/**
 * 清单指纹（name@version 排序拼接）：运行时用它判断「本解释器是否已按当前
 * 清单恢复过」——指纹不变则跳过探测（省 ~50ms/次），清单变化（新装 / 版本
 * 升级 / 删除）自动触发重新恢复。
 */
export function micropipManifestKey(manifest: readonly MicropipPackage[]): string {
  return manifest
    .map(pkg => `${canonicalMicropipName(pkg.name)}@${pkg.version}`)
    .sort()
    .join('|');
}

/**
 * 探测实例内 micropip 安装的包（锁文件包被 PYODIDE_SOURCE='pyodide' 过滤）。
 * 失败返回 []——探测是增强信息，绝不阻断执行。
 */
export async function probeMicropipPackages(pyodide: PyodideInterface): Promise<MicropipPackage[]> {
  try {
    const json = await pyodide.runPythonAsync(PROBE_CODE);
    if (typeof json !== 'string') return [];
    return parseMicropipProbe(json);
  } catch {
    return [];
  }
}

export interface MicropipRestoreResult {
  /** 本次恢复（补装）成功的包名 */
  restored: string[];
  /** 恢复失败的可读警告（随 packageWarning 透出，不阻断执行） */
  warnings: string[];
}

function buildRestoreCode(packages: readonly MicropipPackage[]): string {
  // URL 逐条转义后内联为 Python 字符串字面量（URL 已过 https:// + 长度校验，
  // 再做引号/反斜杠转义兜底，杜绝注入面）
  const literals = packages.map(pkg => {
    const source = pkg.url ?? `${pkg.name}==${pkg.version}`;
    return JSON.stringify(source);
  });
  return [
    'import micropip',
    `await micropip.install([${literals.join(', ')}], deps=False)`,
  ].join('\n');
}

/**
 * 恢复清单中的缺失包（幂等，可取消）：
 * 1. 探测已装集合（按规范名比对）；
 * 2. 缺失条目优先按精确 URL 重放（wheel 命中 IndexedDB → 离线可用），
 *    无 URL 的降级 `name==version`（需联网解析，失败记警告）；
 * 3. 逐条隔离失败：单个 wheel 缺失 / 过期不影响其余条目恢复。
 * 清单为空时零开销返回（常见路径不付出探测成本）。
 * @param signal 取消信号：中止后返回已恢复部分 + 取消警告，不抛错
 */
export async function restoreMicropipPackages(
  pyodide: PyodideInterface,
  manifest: readonly MicropipPackage[],
  signal?: AbortSignal,
): Promise<MicropipRestoreResult> {
  const warnings: string[] = [];
  if (!manifest.length) return { restored: [], warnings };
  if (signal?.aborted) return { restored: [], warnings: ['micropip 恢复已取消'] };

  const installed = await probeMicropipPackages(pyodide);
  const installedNames = new Set(installed.map(pkg => canonicalMicropipName(pkg.name)));
  const missing = manifest.filter(pkg => !installedNames.has(canonicalMicropipName(pkg.name)));
  if (!missing.length) return { restored: [], warnings };
  if (signal?.aborted) return { restored: [], warnings: ['micropip 恢复已取消'] };

  // micropip 不在启动恢复名单里（pyodide-runtime 有意过滤），按需加载（wheel 已缓存）
  try {
    await pyodide.loadPackage('micropip');
  } catch (error) {
    warnings.push(`加载 micropip 失败：${error instanceof Error ? error.message : String(error)}`);
    return { restored: [], warnings };
  }

  // 首选：全部缺失条目按 URL 一次装（deps=False —— 依赖闭包已逐条在清单里）
  const withUrl = missing.filter(pkg => pkg.url);
  const withoutUrl = missing.filter(pkg => !pkg.url);
  const restored: string[] = [];

  if (withUrl.length) {
    try {
      await pyodide.runPythonAsync(buildRestoreCode(withUrl));
      restored.push(...withUrl.map(pkg => pkg.name));
    } catch (batchError) {
      // 批量失败降级逐条：隔离单个坏 wheel，尽量多恢复
      const batchMessage = batchError instanceof Error ? batchError.message : String(batchError);
      for (const pkg of withUrl) {
        if (signal?.aborted) {
          warnings.push('micropip 恢复已取消（剩余条目未恢复）');
          break;
        }
        try {
          await pyodide.runPythonAsync(buildRestoreCode([pkg]));
          restored.push(pkg.name);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          warnings.push(`恢复 ${pkg.name} ${pkg.version} 失败：${detail.split('\n').pop() ?? detail}`);
        }
      }
      if (!restored.length && !signal?.aborted) warnings.push(`micropip 批量恢复失败：${batchMessage.split('\n').pop() ?? batchMessage}`);
    }
  }

  // 降级：无 URL 条目按 name==version 解析（需联网；wheel 缓存无法直连命中）
  for (const pkg of withoutUrl) {
    if (signal?.aborted) {
      warnings.push('micropip 恢复已取消（剩余条目未恢复）');
      break;
    }
    try {
      await pyodide.runPythonAsync(buildRestoreCode([pkg]));
      restored.push(pkg.name);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`恢复 ${pkg.name} ${pkg.version} 失败（缺少 wheel URL）：${detail.split('\n').pop() ?? detail}`);
    }
  }

  return { restored, warnings };
}
