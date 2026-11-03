import { cdpSession } from './cdp-session';
import { textCommand, textTab } from './text-runtime';

interface AXNode {
  nameTruncated?: boolean;
  nodeId: string;
  backendDOMNodeId?: number;
  parentId?: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  properties?: { name: string; value: { value?: unknown } }[];
}
interface AXEntry {
  node: AXNode;
  frameId: string;
  loaderId: string;
  ref?: string;
}
interface AXSnapshot {
  tabId: number;
  url: string;
  loaderId: string;
  epoch: number;
  time: number;
  regex: string;
  consumed?: boolean;
  entries: AXEntry[];
  warnings: string[];
  truncated: boolean;
}
const snapshots = new Map<string, AXSnapshot>();
const refs = new Map<string, { snapshotId: string; entry: AXEntry }>();
const LIMIT = 10_000;
function signature(node: AXNode) {
  return JSON.stringify([
    String(node.role?.value || ''),
    String(node.name?.value || ''),
  ]);
}
function normalize(node: AXNode): AXNode {
  const protectedValue = node.properties?.some(
    (p) => p.name === 'protected' && p.value.value === true
  );
  return {
    nodeId: node.nodeId,
    backendDOMNodeId: node.backendDOMNodeId,
    parentId: node.parentId,
    ignored: node.ignored,
    role: { value: String(node.role?.value || '').slice(0, 100) },
    name: { value: String(node.name?.value || '').slice(0, 500) },
    nameTruncated: (node.name?.value?.length || 0) > 500,
    value: {
      value: protectedValue
        ? undefined
        : typeof node.value?.value === 'string'
          ? node.value.value.slice(0, 2000)
          : node.value?.value,
    },
    properties: (node.properties || [])
      .slice(0, 32)
      .map((p) => ({
        name: p.name.slice(0, 100),
        value: {
          value:
            typeof p.value.value === 'string'
              ? p.value.value.slice(0, 500)
              : p.value.value,
        },
      })),
  };
}
function forget(id: string) {
  snapshots.delete(id);
  for (const [ref, entry] of refs)
    if (entry.snapshotId === id) refs.delete(ref);
}
async function tree(tabId: number) {
  return (await textCommand(tabId, 'Page.getFrameTree')).frameTree;
}
function frames(root: any): any[] {
  return [root.frame, ...(root.childFrames || []).flatMap(frames)];
}

export async function observeAccessibility(input: {
  page?: number;
  snapshotId?: string;
  regex?: string;
  xpath?: string;
}) {
  if (input.xpath)
    throw new Error('XPath 仅适用于 DOM 视图，辅助功能视图请用 regex');
  const tab = await textTab();
  for (const [id, s] of snapshots)
    if (Date.now() - s.time >= 120_000) forget(id);
  let id = input.snapshotId;
  let snapshot = id ? snapshots.get(id) : undefined;
  const page = input.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1)
    throw new Error('page 必须是正整数');
  if (id && !snapshot)
    throw new Error('STALE_SNAPSHOT：省略 snapshotId，从 page=1 重采');
  if (
    snapshot &&
    input.regex !== undefined &&
    input.regex.trim() !== snapshot.regex
  )
    throw new Error('QUERY_MISMATCH：改变条件时开启新查询');
  if (!snapshot) {
    if (page !== 1) throw new Error('新查询从 page=1 开始；翻页传 snapshotId');
    const regex = (input.regex || '').trim();
    const filter = regex ? new RegExp(regex, 'i') : null;
    // CDP only guarantees stable AXNodeIds after enabling the Accessibility domain.
    await textCommand(tab.id, 'Accessibility.enable');
    const root = await tree(tab.id);
    const entries: AXEntry[] = [],
      warnings: string[] = [];
    let truncated = false;
    for (const frame of frames(root)) {
      if (entries.length >= LIMIT) {
        truncated = true;
        break;
      }
      try {
        const result = await textCommand<{ nodes: AXNode[] }>(
          tab.id,
          'Accessibility.getFullAXTree',
          { frameId: frame.id }
        );
        for (const raw of result.nodes || []) {
          const node = normalize(raw);
          if (node.ignored) continue;
          if (
            filter &&
            !filter.test(
              [
                node.role?.value,
                node.name?.value,
                String(node.value?.value ?? ''),
              ].join(' ')
            )
          )
            continue;
          if (entries.length >= LIMIT) {
            truncated = true;
            break;
          }
          entries.push({ node, frameId: frame.id, loaderId: frame.loaderId });
        }
      } catch (error) {
        warnings.push(
          `frame ${frame.id} 未覆盖：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (!entries.length && warnings.length)
      throw new Error(warnings.join('; '));
    id = 'axs:' + crypto.randomUUID();
    snapshot = {
      tabId: tab.id,
      url: tab.url,
      loaderId: root.frame.loaderId,
      epoch: cdpSession.getEpoch(tab.id),
      time: Date.now(),
      regex,
      entries,
      warnings,
      truncated,
    };
    snapshots.set(id, snapshot);
    entries.forEach((entry, index) => {
      if (!entry.node.backendDOMNodeId || entry.node.nameTruncated) return;
      entry.ref = `ax:${tab.id}:${id}:${index}`;
      refs.set(entry.ref, { snapshotId: id!, entry });
    });
    while (snapshots.size > 8) forget(snapshots.keys().next().value!);
  }
  if (snapshot.consumed) throw new Error('STALE_SNAPSHOT：操作后请重新观察');
  await validateSnapshot(snapshot);
  const delivered = snapshot.entries.slice((page - 1) * 40, page * 40);
  // Refresh each represented frame once; never deliver a removed or repurposed AX node.
  for (const frameId of new Set(delivered.map((e) => e.frameId))) {
    const live = await textCommand<{ nodes: AXNode[] }>(
      tab.id,
      'Accessibility.getFullAXTree',
      { frameId }
    );
    for (const entry of delivered.filter((e) => e.frameId === frameId)) {
      const node = live.nodes?.find(
        (n) =>
          n.nodeId === entry.node.nodeId &&
          n.backendDOMNodeId === entry.node.backendDOMNodeId &&
          !n.ignored
      );
      if (!node || signature(node) !== signature(entry.node))
        throw new Error('STALE_ELEMENTS：辅助功能节点变化，请重采');
      entry.node = normalize(node);
    }
  }
  const totalPages = Math.max(1, Math.ceil(snapshot.entries.length / 40));
  if (page > totalPages)
    throw new Error(`PAGE_OUT_OF_RANGE：共 ${totalPages} 页`);
  return {
    snapshotId: id,
    view: 'accessibility',
    tabId: tab.id,
    url: tab.url,
    page,
    totalPages,
    nextPage: page < totalPages ? page + 1 : null,
    totalElements: snapshot.entries.length,
    coverage: {
      source: 'browser accessibility tree',
      complete: false,
      truncated: snapshot.truncated,
      warnings: snapshot.warnings,
    },
    elements: snapshot.entries.slice((page - 1) * 40, page * 40).map((e) => ({
      elementId: e.ref,
      role: e.node.role?.value,
      name: e.node.name?.value,
      value:
        e.node.role?.value === 'password' ||
        e.node.properties?.some(
          (p) => p.name === 'protected' && p.value.value === true
        )
          ? undefined
          : e.node.value?.value,
      fieldLimits: { name: 500, value: 2000, properties: 32 },
      nameTruncated: e.node.nameTruncated,
      parentId: e.node.parentId,
      nodeId: e.node.nodeId,
      states: Object.fromEntries(
        (e.node.properties || []).map((p) => [p.name, p.value.value])
      ),
      routing: 'AX reference carries frame routing; omit frameId',
    })),
    hint: '辅助功能树不保证包含未加载单元格。有 ElementId 可 focus/keys；无 ElementId 的节点只提供语义信息。写后重新观察；不要把 AX 行号当单元格地址。',
  };
}
async function validateSnapshot(snapshot: AXSnapshot) {
  const tab = await textTab();
  if (
    tab.id !== snapshot.tabId ||
    tab.url !== snapshot.url ||
    Date.now() - snapshot.time >= 120_000 ||
    !cdpSession.hasSession(tab.id) ||
    cdpSession.getEpoch(tab.id) !== snapshot.epoch
  )
    throw new Error('STALE_SNAPSHOT：页面或调试会话变化，请重采');
  const root = await tree(tab.id);
  if (root.frame.loaderId !== snapshot.loaderId)
    throw new Error('STALE_SNAPSHOT：文档已导航，请重采');
  return frames(root);
}
export async function resolveAX(ref: string) {
  const stored = refs.get(ref),
    snapshot = stored ? snapshots.get(stored.snapshotId) : undefined;
  if (!stored || !snapshot)
    throw new Error('STALE_ELEMENT：辅助功能引用已过期，请重采');
  const liveFrames = await validateSnapshot(snapshot);
  if (
    !liveFrames.some(
      (f) =>
        f.id === stored.entry.frameId && f.loaderId === stored.entry.loaderId
    )
  )
    throw new Error('STALE_ELEMENT：目标 frame 已导航');
  const result = await textCommand<{ nodes: AXNode[] }>(
    snapshot.tabId,
    'Accessibility.getPartialAXTree',
    { backendNodeId: stored.entry.node.backendDOMNodeId, fetchRelatives: false }
  );
  const node = result.nodes?.find(
    (n) =>
      n.backendDOMNodeId === stored.entry.node.backendDOMNodeId && !n.ignored
  );
  if (
    !node ||
    signature(node) !== signature(stored.entry.node) ||
    node.properties?.some(
      (p) => p.name === 'disabled' && p.value.value === true
    )
  )
    throw new Error('STALE_ELEMENT：目标语义或可操作状态已改变');
  return {
    tabId: snapshot.tabId,
    backendNodeId: stored.entry.node.backendDOMNodeId!,
  };
}

export function invalidateAXPages(tabId: number) {
  for (const snapshot of snapshots.values())
    if (snapshot.tabId === tabId) snapshot.consumed = true;
}
