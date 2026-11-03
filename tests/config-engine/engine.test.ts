/**
 * 配置持久化引擎单元测试
 *
 * 覆盖：
 *   1. 稳定序列化 / 校验和（键序无关）
 *   2. 封套编解码（legacy 裸数据、校验和损坏、格式不符、未来 schema）
 *   3. 冗余恢复阶梯 primary → mirror → snapshot → salvage → none + 自愈回填
 *   4. 写入读回校验（撕裂写重试 / 最终失败必抛错）、写队列串行、rev 单调
 *   5. 引擎 localStorage ↔ storage.local 双向对账（回灌 / 回填 / 损坏修复）
 *   6. 备份导出导入（校验和、策略、拒绝非法分区、失败回滚）
 *
 * 运行：node tests/config-engine/run.mjs   （或 npm run test:engine）
 */

import {
  ALL_SECTION_IDS,
  BACKUP_FORMAT,
  ConfigEngine,
  ConfigFrozenError,
  ConfigWriteError,
  ResilientDomain,
  applyBackup,
  buildBackup,
  checksumOf,
  decodeEnvelope,
  encodeEnvelope,
  fillMerge,
  isChannelStateLike,
  parseBackup,
  serializeBackup,
  stableStringify,
  stripSecrets,
  type BackupFile,
  type LocalStoreLike,
  type StorageAreaLike,
} from '../../entrypoints/sidepanel/utils/config';

// ==================== 极简断言 ====================

let passed = 0;
const failures: string[] = [];

function check(cond: boolean, label: string, extra?: unknown): void {
  if (cond) passed++;
  else failures.push(label + (extra !== undefined ? ` => ${JSON.stringify(extra)}` : ''));
}

function eq(actual: unknown, expected: unknown, label: string): void {
  check(stableStringify(actual) === stableStringify(expected), label, { actual, expected });
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function expectThrows(fn: () => Promise<unknown>, label: string): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    passed++;
    return error;
  }
  failures.push(`${label} (未抛出异常)`);
  return null;
}

/** 让 fire-and-forget 的自愈任务跑完 */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 10));

function clone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);
}

// ==================== 内存实现 ====================

class MemoryArea implements StorageAreaLike {
  readonly store = new Map<string, unknown>();
  /** 这些键写入直接抛错（模拟 IO 故障） */
  readonly failKeys = new Set<string>();
  /** 前 N 次 set 整体抛错 */
  failSetTimes = 0;
  /** 这些键写入时被替换成固定值（模拟撕裂写 / 落盘损坏） */
  readonly tornKeys = new Map<string, unknown>();

  async get(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (this.store.has(key)) out[key] = clone(this.store.get(key));
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const key of Object.keys(items)) {
      if (this.failKeys.has(key)) throw new Error(`simulated io failure on ${key}`);
    }
    if (this.failSetTimes > 0) {
      this.failSetTimes--;
      throw new Error('simulated io error');
    }
    for (const [key, value] of Object.entries(items)) {
      this.store.set(key, this.tornKeys.has(key) ? clone(this.tornKeys.get(key)) : clone(value));
    }
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) this.store.delete(key);
  }

  async getBytesInUse(keys: string[]): Promise<number> {
    let total = 0;
    for (const key of keys) {
      if (this.store.has(key)) total += JSON.stringify(this.store.get(key)).length + key.length;
    }
    return total;
  }
}

class MemoryLocalStore implements LocalStoreLike {
  readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const isConfig = (value: unknown): value is Record<string, unknown> => isChannelStateLike(value);
const noSleep = async (): Promise<void> => undefined;

function createDomain(area: StorageAreaLike, key = 'agent_nexus_channels', snapshotCount = 5) {
  return new ResilientDomain<Record<string, unknown>>({
    id: 'channels',
    area,
    key,
    validate: isConfig,
    snapshotCount,
    verifyRetries: 3,
    sleep: noSleep,
  });
}

// ==================== 测试 ====================

async function testChecksum(): Promise<void> {
  eq(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }), '键序无关');
  eq(stableStringify({ a: [1, { x: 1, y: 2 }] }), stableStringify({ a: [1, { y: 2, x: 1 }] }), '嵌套键序无关');
  eq(stableStringify({ a: undefined, b: 1 }), stableStringify({ b: 1 }), 'undefined 字段忽略');
  eq(checksumOf({ k: '中文键值' }), checksumOf({ k: '中文键值' }), '中文校验和稳定');
  check(checksumOf({ a: 1 }) !== checksumOf({ a: 2 }), '校验和区分内容');
  check(/^[0-9a-f]{16}$/.test(checksumOf('x')), '校验和为 16 位十六进制', checksumOf('x'));
}

async function testEnvelope(): Promise<void> {
  const data = { baseUrl: 'https://api.example.com/v1', modelNames: ['m1'] };
  const encoded = encodeEnvelope(data, 7, 12345);
  check(encoded.format === 'agentnexus.config', '封套含格式标记');
  check(encoded.schema >= 1, '封套含 schema 版本');

  const decoded = decodeEnvelope<typeof data>(JSON.parse(JSON.stringify(encoded)));
  check(decoded.ok, '封套往返解码成功');
  if (decoded.ok) {
    eq(decoded.data, data, '封套往返数据一致');
    check(decoded.rev === 7 && decoded.updatedAt === 12345, 'rev/updatedAt 保留');
    check(decoded.legacy === false, '封套数据不标记 legacy');
  }

  const legacy = decodeEnvelope<{ baseUrl: string }>({ baseUrl: 'https://x' });
  check(legacy.ok && legacy.legacy && legacy.schema === 0, '老版本裸数据识别为 legacy');

  const tampered = { ...encoded, checksum: '0'.repeat(16) };
  const bad = decodeEnvelope(tampered);
  check(!bad.ok && bad.reason === 'checksum', '校验和篡改被识别', bad);
  const salvaged = decodeEnvelope(tampered, { allowChecksumMismatch: true });
  check(salvaged.ok, 'allowChecksumMismatch 可抢救读');

  const foreign = decodeEnvelope({ format: 'someone-else', data: {} });
  check(!foreign.ok && foreign.reason === 'foreign', '异格式被拒绝', foreign);

  const future = { ...encoded, schema: 99 };
  const futureDefault = decodeEnvelope(future);
  check(!futureDefault.ok && futureDefault.reason === 'schema-future', '更高 schema 默认拒绝');
  const futureAllowed = decodeEnvelope(future, { allowSchemaFuture: true });
  check(futureAllowed.ok, 'allowSchemaFuture 可读（frozen 保护）');

  const empty = decodeEnvelope(undefined);
  check(!empty.ok && empty.reason === 'empty', '空值被识别');
}

async function testDomainRedundancy(): Promise<void> {
  // C1 写入三键 + 读回
  const area = new MemoryArea();
  const domain = createDomain(area);
  const first = { baseUrl: 'https://a.example/v1', modelNames: ['m1'] };
  const saved = await domain.save(first);
  check(saved.verified && saved.attempts === 1 && saved.rev === 1, '首次写入读回校验通过', saved);
  check(area.store.has('agent_nexus_channels'), '主副本已写入');
  check(area.store.has('agent_nexus_channels__mirror'), '镜像已写入');
  check(area.store.has('agent_nexus_channels__snaps'), '快照键已写入');
  eq(
    stableStringify(area.store.get('agent_nexus_channels')),
    stableStringify(area.store.get('agent_nexus_channels__mirror')),
    '主副本与镜像内容一致'
  );

  const loaded = await domain.load();
  check(loaded.source === 'primary', '正常读取来自主副本', loaded.source);
  eq(loaded.data, first, '读取数据与写入一致');

  // C2 快照环累积 + 上限
  await domain.save({ ...first, baseUrl: 'https://b.example/v1' });
  await domain.save({ ...first, baseUrl: 'https://c.example/v1' });
  const snaps = await domain.readSnapshots();
  eq(snaps.length, 2, '快照环记录前两次写入');
  eq(snaps[0].rev, 2, '快照按 rev 降序，最新在前');

  const capped = createDomain(new MemoryArea(), 'agent_nexus_channels', 3);
  for (let i = 1; i <= 6; i++) await capped.save({ baseUrl: `https://${i}` });
  const cappedSnaps = await capped.readSnapshots();
  check(cappedSnaps.length <= 3, '快照环不超上限', cappedSnaps.length);
  eq(cappedSnaps[0].rev, 5, '环内保留最近的写入');

  // C3 主副本损坏 → 镜像恢复 + 自愈回填
  const area3 = new MemoryArea();
  const domain3 = createDomain(area3);
  await domain3.save(first);
  const brokenPrimary = { ...(area3.store.get('agent_nexus_channels') as object), checksum: 'f'.repeat(16) };
  area3.store.set('agent_nexus_channels', brokenPrimary);
  const fromMirror = await domain3.load();
  check(fromMirror.source === 'mirror', '主副本损坏时从镜像恢复', fromMirror.source);
  eq(fromMirror.data, first, '镜像恢复的数据正确');
  await flush();
  const healed = decodeEnvelope<unknown>(area3.store.get('agent_nexus_channels'));
  check(healed.ok, '自愈后主副本可解码', healed);

  // C4 主副本 + 镜像都损坏 → 快照恢复
  const area4 = new MemoryArea();
  const domain4 = createDomain(area4);
  await domain4.save(first);
  await domain4.save({ ...first, modelNames: ['m2'] });
  const key = 'agent_nexus_channels';
  area4.store.set(key, { ...(area4.store.get(key) as object), checksum: 'f'.repeat(16) });
  area4.store.set(`${key}__mirror`, { ...(area4.store.get(`${key}__mirror`) as object), checksum: 'f'.repeat(16) });
  const fromSnapshot = await domain4.load();
  check(fromSnapshot.source === 'snapshot', '双副本损坏时从快照恢复', fromSnapshot.source);
  eq(fromSnapshot.data, first, '快照恢复的是最近一次可用历史值');
  await flush();
  check(
    decodeEnvelope(area4.store.get(key)).ok && decodeEnvelope(area4.store.get(`${key}__mirror`)).ok,
    '快照恢复后主副本与镜像被回填'
  );

  // C5 全部不可读 → none
  const area5 = new MemoryArea();
  area5.store.set('agent_nexus_channels', [1, 2, 3]);
  area5.store.set('agent_nexus_channels__mirror', [1, 2, 3]);
  area5.store.set('agent_nexus_channels__snaps', 'garbage');
  const none = await createDomain(area5).load();
  check(none.source === 'none' && none.data === null, '全部损坏时返回 none 而非抛错', none.source);

  // C6 校验和损坏但结构可用 → 抢救读
  const area6 = new MemoryArea();
  const domain6 = createDomain(area6);
  await domain6.save(first);
  area6.store.set('agent_nexus_channels', {
    ...(area6.store.get('agent_nexus_channels') as object),
    checksum: 'f'.repeat(16),
  });
  area6.store.set('agent_nexus_channels__mirror', 'garbage');
  area6.store.set('agent_nexus_channels__snaps', 'garbage');
  const salvaged = await domain6.load();
  check(salvaged.source === 'salvage', '最后一级抢救读生效', salvaged.source);
  eq(salvaged.data, first, '抢救读取的数据可用');

  // C7 老版本裸数据 → 可读 + 下次写入升级为封套
  const area7 = new MemoryArea();
  area7.store.set('agent_nexus_channels', { baseUrl: 'https://legacy', modelNames: ['old'] });
  const domain7 = createDomain(area7);
  const legacyLoad = await domain7.load();
  check(legacyLoad.source === 'primary', '老版本裸数据可读');
  check(legacyLoad.issues.includes('legacy-raw-format'), '标记 legacy');
  await domain7.save({ baseUrl: 'https://legacy2', modelNames: ['old'] });
  const upgraded = area7.store.get('agent_nexus_channels') as Record<string, unknown>;
  check(upgraded.format === 'agentnexus.config', '下次写入自动升级为封套', upgraded);
}

async function testDomainWriteGuard(): Promise<void> {
  // D1 撕裂写 → 重试后必须抛错（绝不静默丢数据）
  const area = new MemoryArea();
  area.tornKeys.set('agent_nexus_channels', { __torn: true });
  const domain = createDomain(area);
  const error = await expectThrows(
    () => domain.save({ baseUrl: 'https://x' }),
    '撕裂写应抛 ConfigWriteError'
  );
  check(error instanceof ConfigWriteError && error.code === 'unverified', '错误码为 unverified', errText(error));

  // D2 非法载荷 → 直接拒绝
  const area2 = new MemoryArea();
  const invalid = await expectThrows(
    () => createDomain(area2).save('not-an-object' as unknown as Record<string, unknown>),
    '非法载荷应抛错'
  );
  check(invalid instanceof ConfigWriteError && invalid.code === 'invalid-payload', '错误码 invalid-payload', errText(invalid));
  check(area2.store.size === 0, '非法载荷不落盘');

  // D3 瞬时 IO 故障 → 重试后成功
  const area3 = new MemoryArea();
  area3.failSetTimes = 2;
  const domain3 = createDomain(area3);
  const retried = await domain3.save({ baseUrl: 'https://retry' });
  check(retried.verified && retried.attempts === 3, '两次失败后第三次成功', retried);

  // D4 并发写入串行、rev 单调
  const domain4 = createDomain(new MemoryArea());
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) => domain4.save({ baseUrl: `https://v${i}` }))
  );
  eq(results.map(r => r.rev), [1, 2, 3, 4, 5], '并发保存 rev 严格递增');
  const finalLoad = await domain4.load();
  eq(finalLoad.data, { baseUrl: 'https://v4' }, '最终值为最后一次写入');
  check(finalLoad.rev === 5, '最终 rev = 5', finalLoad.rev);

  // D5 降级保护：schema 更高 → 只读，写入被拒
  const area5 = new MemoryArea();
  area5.store.set(
    'agent_nexus_channels',
    { ...encodeEnvelope({ baseUrl: 'https://future' }, 9, Date.now()), schema: 99 }
  );
  const domain5 = createDomain(area5);
  const frozenLoad = await domain5.load();
  check(frozenLoad.frozen, '更高 schema 标记为 frozen', frozenLoad);
  const frozenError = await expectThrows(
    () => domain5.save({ baseUrl: 'https://clobber' }),
    '冻结域写入应被拒绝'
  );
  check(frozenError instanceof ConfigFrozenError, '抛出 ConfigFrozenError', errText(frozenError));
}

async function testEngineExternals(): Promise<void> {
  // E1 localStorage 有值 → 回灌引擎
  const area1 = new MemoryArea();
  const ls1 = new MemoryLocalStore();
  ls1.setItem('systemSettings', JSON.stringify({ fontSize: 14 }));
  const engine1 = new ConfigEngine({ area: area1, localStore: ls1 });
  const report1 = await engine1.init();
  check(report1.mirrored.includes('systemSettings'), 'localStorage → 引擎回灌', report1);
  const section1 = await engine1.readSection('systemSettings');
  eq(section1?.data, { fontSize: 14 }, '回灌后的分区数据正确');

  // E2 localStorage 被清空 → 引擎回填（以仍受引擎托管的 systemSettings 域验证；
  //    智能体/技能已迁移至共享存储层 utils/agents、utils/skills，不再经由本引擎）
  const area2 = new MemoryArea();
  const ls2 = new MemoryLocalStore();
  const engine2 = new ConfigEngine({ area: area2, localStore: ls2 });
  await engine2.writeSection('systemSettings', { fontSize: 16 });
  const ls3 = new MemoryLocalStore(); // 模拟清缓存后的新 localStorage
  const engine3 = new ConfigEngine({ area: area2, localStore: ls3 });
  const report3 = await engine3.init();
  check(report3.seeded.includes('systemSettings'), '引擎 → localStorage 回填', report3);
  eq(JSON.parse(ls3.getItem('systemSettings') as string), { fontSize: 16 }, '回填内容一致');

  // E3 localStorage 损坏 → 引擎副本修复
  const area4 = new MemoryArea();
  const ls4 = new MemoryLocalStore();
  const engine4 = new ConfigEngine({ area: area4, localStore: ls4 });
  await engine4.writeSection('systemSettings', { fontSize: 18 });
  ls4.setItem('systemSettings', '{broken-json');
  const engine4b = new ConfigEngine({ area: area4, localStore: ls4 });
  const report4 = await engine4b.init();
  check(report4.issues.some(issue => issue.includes('损坏')), '损坏被记录到 issues', report4.issues);
  const repaired = ls4.getItem('systemSettings');
  check(!!repaired && JSON.parse(repaired as string).fontSize === 18, '损坏的 localStorage 被引擎副本修复', repaired);

  // E4 原生键分区
  const area5 = new MemoryArea();
  const engine5 = new ConfigEngine({ area: area5, localStore: new MemoryLocalStore() });
  check((await engine5.readSection('locale')) === null, '未写入时 locale 分区为空');
  await engine5.writeSection('locale', 'zh-CN');
  eq(area5.store.get('ui_locale'), 'zh-CN', 'locale 原生键保持裸值（不套封套）');
  const badLocale = await expectThrows(() => engine5.writeSection('locale', 'jp-JP'), '非法语言应被拒绝');
  check(!!badLocale && errText(badLocale).includes('failed validation'), '非法分区值被校验拦截', errText(badLocale));
  check(engine5.validateSection('channels', 42) === false, 'validateSection 拒绝非法数据');
  check(engine5.validateSection('channels', { channels: [] }) === true, 'validateSection 接受合法数据');

  // E5 诊断：全新安装不算告警；正常写入后仍健康
  const area6 = new MemoryArea();
  const engine6 = new ConfigEngine({ area: area6, localStore: new MemoryLocalStore() });
  const fresh = await engine6.diagnostics();
  check(fresh.health.healthy && fresh.health.issueCount === 0, '全新安装诊断为健康', fresh.health);
  await engine6.writeSection('channels', { channels: [] });
  const afterSave = await engine6.diagnostics();
  check(afterSave.health.healthy, '正常写入后诊断仍健康', afterSave.domains);
  check(afterSave.domains.some(d => d.id === 'channels' && d.mirrorOk), '镜像副本就位');

  // E6 清空分区
  await engine6.clearSection('channels');
  check((await engine6.readSection('channels')) === null, 'clearSection 后分区为空');
  check(!area6.store.has('agent_nexus_channels'), 'clearSection 清掉主副本');
  check(!area6.store.has('agent_nexus_channels__mirror'), 'clearSection 清掉镜像');
}

async function testBackup(): Promise<void> {
  const area = new MemoryArea();
  const ls = new MemoryLocalStore();
  ls.setItem('systemSettings', JSON.stringify({ fontSize: 16 }));
  const engine = new ConfigEngine({ area, localStore: ls });
  await engine.writeSection('channels', {
    channels: [
      {
        id: 'ch1',
        name: '官方渠道',
        protocol: 'openai',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-secret',
        models: [{ id: 'm1', name: 'gpt-4o', displayName: '', vision: false, enabled: true, contextThreshold: 262144 }],
      },
    ],
  });
  await engine.writeSection('locale', 'en');

  // F1 构建 → 序列化 → 解析往返
  const backup = await buildBackup({ includeSecrets: true, appVersion: '9.9.9-test' }, engine);
  check(backup.checksum.length === 16, '备份带校验和');
  check(backup.version === 1 && backup.format === BACKUP_FORMAT, '备份格式标记正确');
  check(Object.keys(backup.sections).includes('channels'), '包含 channels 分区');
  check(Object.keys(backup.sections).includes('systemSettings'), '包含 localStorage 侧分区');
  check(Object.keys(backup.sections).includes('locale'), '包含 locale 分区');
  const reparsed = parseBackup(serializeBackup(backup));
  check(reparsed.ok, '备份往返解析成功', reparsed.ok ? undefined : reparsed.errors);
  if (reparsed.ok) eq(reparsed.backup.sections, backup.sections, '往返分区数据一致');

  // F2 剥离密钥（渠道密钥嵌在 channels.channels[].apiKey，必须递归剥离）
  const withoutSecrets = await buildBackup({ includeSecrets: false, appVersion: '9.9.9-test' }, engine);
  const secretData = withoutSecrets.sections.channels?.data as { channels: Array<Record<string, unknown>> };
  check(
    !!secretData && secretData.channels[0].apiKey === undefined,
    'includeSecrets=false 时嵌套渠道密钥被剥离',
    secretData,
  );
  const withSecrets = backup.sections.channels?.data as { channels: Array<Record<string, unknown>> };
  check(withSecrets.channels[0].apiKey === 'sk-secret', 'includeSecrets=true 时保留密钥');

  // F3 解析失败分支
  const tampered = JSON.parse(serializeBackup(backup));
  tampered.sections.channels.data.channels[0].baseUrl = 'https://evil';
  const tamperedResult = parseBackup(JSON.stringify(tampered));
  check(!tamperedResult.ok && tamperedResult.errors.includes('checksum'), '篡改内容被校验和拦截', tamperedResult);
  check(!parseBackup('{oops').ok, '非 JSON 被拒绝');
  const wrongFormat = parseBackup(JSON.stringify({ ...backup, format: 'other.backup' }));
  check(!wrongFormat.ok && !wrongFormat.ok && wrongFormat.errors.includes('bad-format'), '异格式被拒绝');
  const futureVersion = parseBackup(JSON.stringify({ ...backup, version: 99 }));
  check(!futureVersion.ok && futureVersion.errors.includes('future-version'), '未来版本被拒绝');

  // F4 覆盖导入 / 补充导入（本机无 channels 分区 → fill 补齐；locale 已有值 → 跳过）
  const targetArea = new MemoryArea();
  const targetLs = new MemoryLocalStore();
  const target = new ConfigEngine({ area: targetArea, localStore: targetLs });
  await target.writeSection('locale', 'zh-CN');

  const fillReport = await applyBackup(backup, 'fill', target);
  check(!fillReport.errors.length, '补充导入无错误', fillReport.errors);
  const filled = (await target.readSection('channels'))?.data as { channels: Array<Record<string, unknown>> };
  check(filled.channels[0].apiKey === 'sk-secret', '补充导入填补了本机空缺的 channels 分区');
  eq(fillReport.skipped.find(s => s.id === 'locale')?.reason, 'already-configured', '非空分区被跳过');

  const replaceReport = await applyBackup(backup, 'replace', target);
  check(replaceReport.applied.includes('channels'), '覆盖导入写入 channels');
  const replaced = (await target.readSection('channels'))?.data as { channels: Array<Record<string, unknown>> };
  eq(replaced.channels[0].name, '官方渠道', '覆盖导入以备份为准');
  eq((await target.readSection('locale'))?.data, 'en', '覆盖导入更新 locale');

  // F5 非法分区 → 写入前整体拒绝
  const untouchedArea = new MemoryArea();
  const untouched = new ConfigEngine({ area: untouchedArea, localStore: new MemoryLocalStore() });
  const invalidBackup: BackupFile = {
    format: BACKUP_FORMAT,
    version: 1,
    appVersion: '',
    exportedAt: '',
    sections: {
      channels: { schema: 1, rev: 1, updatedAt: 1, data: 'not-an-object' },
      locale: { schema: 0, rev: 0, updatedAt: 0, data: 'zh-CN' },
    },
    checksum: 'whatever',
  };
  const invalidReport = await applyBackup(invalidBackup, 'replace', untouched);
  check(invalidReport.errors.length === 1 && invalidReport.errors[0].id === 'channels', '非法分区被拒绝', invalidReport);
  check(invalidReport.applied.length === 0, '存在非法分区时一个字节都不写');
  check(untouchedArea.store.size === 0, '存储区保持原样');

  // F6 中途失败 → 回滚已写分区
  const rollbackArea = new MemoryArea();
  const rollback = new ConfigEngine({ area: rollbackArea, localStore: new MemoryLocalStore() });
  rollbackArea.failKeys.add('ui_locale'); // locale 写入必定失败
  const rollbackReport = await applyBackup(backup, 'replace', rollback);
  check(rollbackReport.errors.some(e => e.id === 'locale'), 'locale 写入失败被记录', rollbackReport.errors);
  check(rollbackReport.rolledBack, '触发回滚', rollbackReport);
  check(!rollbackArea.store.has('agent_nexus_channels'), '已写入的 channels 被回滚清除');

  // F7 未知分区 → 跳过而非失败（前向兼容）
  const forwardSections = { ...backup.sections, futureSection: { schema: 1, rev: 1, updatedAt: 1, data: { a: 1 } } };
  const forwardFile = JSON.stringify({
    ...backup,
    sections: forwardSections,
    checksum: checksumOf({ format: BACKUP_FORMAT, version: backup.version, sections: forwardSections }),
  });
  const forwardParsed = parseBackup(forwardFile);
  check(forwardParsed.ok, '含未知分区的备份可解析', forwardParsed.ok ? undefined : forwardParsed.errors);
  if (forwardParsed.ok) {
    const forwardReport = await applyBackup(forwardParsed.backup, 'replace', new ConfigEngine({
      area: new MemoryArea(),
      localStore: new MemoryLocalStore(),
    }));
    check(
      forwardReport.skipped.some(s => s.reason === 'unknown-section'),
      '未知分区被跳过',
      forwardReport.skipped
    );
    check(forwardReport.errors.length === 0, '未知分区不导致导入失败');
  }

  // F8 分区清单与工具函数（智能体/技能域已迁移至共享存储层，分区数 9 → 7；
  // aiChatConfig 域无任何读写方且系统未部署，随 maxTokens 清理一并移除，7 → 6）
  check(ALL_SECTION_IDS.length === 6, '分区总数为 6', ALL_SECTION_IDS.length);
  eq(
    fillMerge({ a: 'keep', b: '', c: [] }, { a: 'new', b: 'fill', c: ['x'] }),
    { a: 'keep', b: 'fill', c: ['x'] },
    'fillMerge 空即填、非空保留'
  );
  eq(
    stripSecrets({ apiKey: 'sk-1', nested: { apiKey: 'sk-2', ok: 1 } }),
    { nested: { ok: 1 } },
    'stripSecrets 递归剥离密钥'
  );
}

// ==================== 运行 ====================

async function main(): Promise<void> {
  const suites: [string, () => Promise<void>][] = [
    ['checksum/stableStringify', testChecksum],
    ['envelope', testEnvelope],
    ['domain 冗余恢复', testDomainRedundancy],
    ['domain 写入守护', testDomainWriteGuard],
    ['engine 外部对账', testEngineExternals],
    ['backup 导出导入', testBackup],
  ];

  for (const [name, run] of suites) {
    const before = failures.length;
    try {
      await run();
    } catch (error) {
      failures.push(`[${name}] 抛出异常: ${errText(error)}`);
    }
    const delta = failures.length - before;
    console.log(`${delta === 0 ? '✓' : '✗'} ${name}`);
  }

  console.log(`\n通过 ${passed} 项断言，失败 ${failures.length} 项`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  process.exit(failures.length ? 1 : 0);
}

void main();
