// 打包管理中心「会话管理」预览入口
// （.vue SFC 经 compiler-sfc 编译 + 生产组件路径全链路）
// 产物落在 node_modules/.cache（仓库内缓存目录，天然被 git 忽略），不进版本库
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { parse, compileScript } from '@vue/compiler-sfc';

const root = process.cwd();
const outDir = path.join(root, 'node_modules', '.cache');
fs.mkdirSync(outDir, { recursive: true });

// ── 桩：会话数据面全家桶（六个模块同一实例 + 种子数据） ──
// 预览环境无 chrome.* / IndexedDB：列表、归档、搜索、运行态、删除全部走内存态。
const SESSION_STUB = `
const state = {
  sessions: [],
  messages: new Map(),
  busy: new Set(),
  activeChatId: 'chat_4',
  openResult: 'opened',
  openInvocations: 0,
  deleteInvocations: 0,
  deleted: [],
  deleteNotifications: [],
  renameInvocations: [],
  policy: { autoDelete: true, retentionDays: 30 },
  sweepCalls: 0,
  sweepResult: { deleted: [], skipped: 0, issues: [] },
  changeHandlers: new Set(),
  policyHandlers: new Set(),
};

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = Date.now();

function seed(partial) {
  const session = {
    chatId: 'chat_x', title: '未命名会话', createdAt: now - DAY, updatedAt: now - MIN,
    messageCount: 0, lastMessagePreview: '', agentName: '', skillNames: [], ...partial,
  };
  state.sessions.push(session);
  return session;
}

seed({ chatId: 'chat_1', title: '季度营收分析', updatedAt: now - 3 * MIN, messageCount: 12,
  lastMessagePreview: '请汇总三个渠道的营收数据，并和上季度对比给出增长归因', agentName: '数据助手' });
seed({ chatId: 'chat_2', title: '竞品官网拆解', updatedAt: now - 2 * HOUR, messageCount: 47,
  lastMessagePreview: '把首页、定价页、文档页的信息架构整理成对比表', agentName: '网页调研助手' });
seed({ chatId: 'chat_3', title: 'Python 脚本报错排查', updatedAt: now - 26 * HOUR, messageCount: 5,
  lastMessagePreview: 'pandas 读取 csv 时报 UnicodeDecodeError，怎么定位编码？', agentName: '数据助手' });
seed({ chatId: 'chat_4', title: '周报自动汇总', updatedAt: now - 25 * MIN, messageCount: 89,
  lastMessagePreview: '把本周三条线的进展合成一份周报，控制在 500 字内', agentName: '写作助手' });
seed({ chatId: 'chat_5', title: '旧版接口调研', updatedAt: now - 40 * DAY, archivedAt: now - 35 * DAY,
  messageCount: 23, lastMessagePreview: '调研已完成，结论见正文', agentName: '网页调研助手' });
seed({ chatId: 'chat_6', title: '会议纪要整理', updatedAt: now - 12 * DAY, archivedAt: now - 10 * DAY,
  messageCount: 8, lastMessagePreview: '把录音转写整理成带待办的纪要' });
seed({ chatId: 'chat_7', title: '文案 A/B 测试方案', updatedAt: now - 5 * DAY, archivedAt: now - 3 * DAY,
  messageCount: 16, lastMessagePreview: '两版落地页文案的分流方案与观测指标' });
seed({ chatId: 'chat_8', title: '站点学习：文档站速览', updatedAt: now - 6 * HOUR, messageCount: 31,
  lastMessagePreview: '已抓取文档站目录结构，准备生成技能', kind: 'site-learn' });

state.busy.add('chat_3');
state.messages.set('chat_1', [
  '请汇总三个渠道的营收数据，并和上季度对比给出增长归因',
  '苹果发布会的报道也顺手整理一下，重点看服务业务',
]);
state.messages.set('chat_2', ['把首页、定价页、文档页的信息架构整理成对比表']);
state.messages.set('chat_4', ['把本周三条线的进展合成一份周报，控制在 500 字内']);

function normalizePolicy(value) {
  const source = value ?? {};
  const autoDelete = typeof source.autoDelete === 'boolean' ? source.autoDelete : true;
  const raw = Number(source.retentionDays);
  const retentionDays = Number.isFinite(raw) ? Math.min(3650, Math.max(1, Math.round(raw))) : 30;
  return { autoDelete, retentionDays };
}

function fireChange(reason) {
  for (const handler of [...state.changeHandlers]) handler(reason);
}

function sortList(list, scope) {
  return [...list].sort((a, b) => scope === 'archived'
    ? (b.archivedAt ?? 0) - (a.archivedAt ?? 0)
    : b.updatedAt - a.updatedAt);
}

export const chatDatabase = {
  async listSessions({ scope = 'active', limit = 50, offset = 0 } = {}) {
    const filtered = state.sessions.filter(session =>
      scope === 'all' ? true
        : scope === 'archived' ? session.archivedAt !== undefined
          : session.archivedAt === undefined);
    return sortList(filtered, scope).slice(offset, offset + limit);
  },
  async findContentMatch(chatId, keyword) {
    const needle = String(keyword ?? '').trim().toLowerCase();
    if (!needle) return null;
    const contents = state.messages.get(chatId) ?? [];
    let count = 0;
    let snippet = '';
    for (const content of contents) {
      const at = content.toLowerCase().indexOf(needle);
      if (at >= 0) {
        count++;
        if (!snippet) snippet = content.slice(Math.max(0, at - 12), at + needle.length + 12);
      }
    }
    return count > 0 ? { count, snippet } : null;
  },
};

export function mergeMessagePatch(existing, patch, nowTs = Date.now()) {
  const merged = { ...existing, ...patch, id: existing.id, chatId: existing.chatId, seq: existing.seq, updatedAt: nowTs };
  for (const [key, value] of Object.entries(patch)) if (value === undefined) delete merged[key];
  return merged;
}

export function buildMatchSnippet(content, at, keywordLength) {
  const start = Math.max(0, at - 40);
  const end = Math.min(content.length, at + keywordLength + 40);
  return (start > 0 ? '…' : '') + content.slice(start, end).replace(/\\s+/g, ' ').trim() + (end < content.length ? '…' : '');
}

export const transcriptEngine = {
  async renameSession(chatId, title) {
    const session = state.sessions.find(item => item.chatId === chatId);
    if (!session) return null;
    session.title = title;
    session.updatedAt = Date.now();
    fireChange('renamed');
    return { ...session };
  },
  async archiveSession(chatId) {
    const session = state.sessions.find(item => item.chatId === chatId);
    if (!session) return null;
    session.archivedAt = Date.now();
    fireChange('archived');
    return { ...session };
  },
  async unarchiveSession(chatId) {
    const session = state.sessions.find(item => item.chatId === chatId);
    if (!session) return null;
    delete session.archivedAt;
    fireChange('unarchived');
    return { ...session };
  },
};

export const sessionDeletionEngine = {
  async deleteSession(chatId) {
    state.deleteInvocations++;
    state.sessions = state.sessions.filter(item => item.chatId !== chatId);
    state.messages.delete(chatId);
    state.deleted.push(chatId);
    fireChange('deleted');
    return {
      transcriptDeleted: true, imagesDeleted: 0, filesDeleted: 0,
      learnDraftsDiscarded: 0, activePointerCleared: false, runAborted: false, issues: [],
    };
  },
};

export const SESSION_BRIDGE_MSG = {
  CHANGED: 'agentnexus:session-changed',
  RUNTIME_STATUS: 'agentnexus:session-runtime-status',
  OPEN_IN_SIDEPANEL: 'agentnexus:session-open-in-sidepanel',
  DELETED: 'agentnexus:session-deleted',
};

export function notifySessionsChanged(reason) { fireChange(reason); }
export function notifySessionDeleted() {}
export async function readSidepanelActiveChatId() { return state.activeChatId; }
export async function listBusySessions(chatIds) {
  return new Set(chatIds.filter(id => state.busy.has(id)));
}
export async function requestOpenInSidepanel() {
  state.openInvocations++;
  return state.openResult;
}
export function watchSessionsChanged(handler) {
  state.changeHandlers.add(handler);
  return () => state.changeHandlers.delete(handler);
}
export async function queryWorkerBusySessions() { return []; }
export async function readSidepanelLocalRunningChats() { return []; }
export async function setLocalRunningChat() {}
export const SIDEPANEL_LOCAL_RUNNING_KEY = 'sidepanel.localRunningChats';

export const SESSION_ARCHIVE_POLICY_STORAGE_KEY = 'agentNexusSessionArchivePolicy';
export const SESSION_ARCHIVE_MIN_RETENTION_DAYS = 1;
export const SESSION_ARCHIVE_MAX_RETENTION_DAYS = 3650;
export const DEFAULT_SESSION_ARCHIVE_POLICY = { autoDelete: true, retentionDays: 30 };
export function normalizeSessionArchivePolicy(value) { return normalizePolicy(value); }
export async function loadSessionArchivePolicy() { return { ...state.policy }; }
export async function saveSessionArchivePolicy(patch) {
  state.policy = normalizePolicy({ ...state.policy, ...patch });
  for (const handler of [...state.policyHandlers]) handler({ ...state.policy });
  return { ...state.policy };
}
export function watchSessionArchivePolicy(handler) {
  state.policyHandlers.add(handler);
  return () => state.policyHandlers.delete(handler);
}

export async function sweepExpiredArchivedSessions() {
  state.sweepCalls++;
  return state.sweepResult;
}
`;

await build({
  entryPoints: [path.join(root, '.preview/hub-sessions.ts')],
  outfile: path.join(outDir, 'hub-sessions.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  loader: { '.css': 'empty' },
  logLevel: 'info',
  plugins: [
    {
      name: 'vue-sfc',
      setup(api) {
        api.onResolve({ filter: /\.vue$/ }, args => ({ path: path.resolve(args.resolveDir, args.path), namespace: 'vue-sfc' }));
        api.onLoad({ filter: /.*/, namespace: 'vue-sfc' }, args => {
          const { descriptor } = parse(fs.readFileSync(args.path, 'utf8'), { filename: args.path });
          const script = compileScript(descriptor, { id: 'hub-sessions', inlineTemplate: true });
          return { contents: script.content, loader: 'ts', resolveDir: path.dirname(args.path) };
        });
      },
    },
    {
      name: 'preview-stubs',
      setup(api) {
        // 会话数据面全家桶：六个模块 → 同一固定 path（共享同一份内存态）
        api.onResolve({ filter: /core[\\/]context[\\/](chat-database|transcript-engine|session-deletion-engine)$|utils[\\/]sessions[\\/](session-bridge|session-archive-policy|session-archive-sweeper)$/ }, () => ({
          path: 'session-mega-stub',
          namespace: 'preview-stub',
        }));
        api.onLoad({ filter: /^session-mega-stub$/, namespace: 'preview-stub' }, () => ({ contents: SESSION_STUB, loader: 'ts' }));
      },
    },
    {
      name: 'alias-at',
      setup(api) {
        api.onResolve({ filter: /^@\// }, args => {
          const base = path.join(root, args.path.slice(2));
          for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { path: candidate };
          }
          return { path: base };
        });
      },
    },
  ],
});
