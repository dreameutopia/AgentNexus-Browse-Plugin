/**
 * 备份与存储统计引擎单元测试
 *
 * 覆盖：
 *   1. 备份文件格式：v1（仅配置）/ v2（含数据）解析、校验和、未知分区告警、
 *      未来版本拒绝；
 *   2. 数据分区处理器：采集 → 校验 → 写入（replace / fill）、写入失败时
 *      **分区自身状态不变**（原子性）、chrome 与 localStorage 双写；
 *   3. 编排器：全量校验后零写入、分区写入顺序、跨分区失败时回滚已写分区；
 *   4. 存储统计：未分类键归入「其他」、分类合计恒等于合计、统计失败显示为
 *      失败（-1）而非 0。
 *
 * 运行：node tests/backup/run.mjs   （或 npm run test:backup）
 */

import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  DATA_SECTION_ORDER,
  applyFullBackup,
  buildFullBackup,
  collectStorageReport,
  computeBackupChecksum,
  createDataSectionHandlers,
  parseFullBackup,
  serializeBackup,
  serializeBackupCompact,
  type BackupFile,
  type SectionDeps,
} from '../../entrypoints/sidepanel/utils/backup';
import { ConfigEngine } from '../../entrypoints/sidepanel/utils/config/engine';
import type { LocalStoreLike, StorageAreaLike } from '../../entrypoints/sidepanel/utils/config/types';
import {
  AGENTS_STORAGE_KEY,
  PLANS_STORAGE_KEY,
  SKILLS_STORAGE_KEY,
  SKILL_TOGGLES_STORAGE_KEY,
} from '../../entrypoints/sidepanel/utils/backup/storage-keys';

// ==================== 极简断言 ====================

let passed = 0;
const failures: string[] = [];

function check(cond: boolean, label: string, extra?: unknown): void {
  if (cond) passed++;
  else failures.push(label + (extra !== undefined ? ` => ${JSON.stringify(extra)}` : ''));
}

function eq(actual: unknown, expected: unknown, label: string): void {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    { actual, expected },
  );
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
  failures.push(`${label}（未抛出异常）`);
  return null;
}

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
    for (const [key, value] of Object.entries(items)) {
      this.store.set(key, clone(value));
    }
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) this.store.delete(key);
  }

  async getBytesInUse(keys: string[] | null): Promise<number> {
    const list = keys === null ? [...this.store.keys()] : keys;
    let total = 0;
    for (const key of list) {
      if (this.store.has(key)) total += JSON.stringify(this.store.get(key)).length + key.length;
    }
    return total;
  }

  async getAll(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of this.store) out[key] = clone(value);
    return out;
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
  /** 全量枚举（与生产端口的 entries() 同形） */
  entries(): { key: string; value: string }[] {
    return [...this.map].map(([key, value]) => ({ key, value }));
  }
}

function makeDeps(area = new MemoryArea(), local = new MemoryLocalStore()): SectionDeps & {
  area: MemoryArea;
  localStore: MemoryLocalStore;
} {
  return { area, localStore: local };
}

const sampleSkill = {
  id: '1001',
  identityKey: 'custom:backup-fixture',
  name: 'demo',
  description: '演示技能',
  files: { 'SKILL.md': '# demo' },
  category: 'general',
  tags: [],
  source: 'custom',
  enabled: true,
  updatedAt: 1,
};

const sampleAgent = {
  id: 'demo-agent',
  name: 'demo',
  description: '演示智能体',
  system: '你是演示',
  tools: [],
  category: 'general',
  tags: [],
};

// ==================== 1. 格式层 ====================

async function testFormat(): Promise<void> {
  // v1：仅配置分区（历史格式）
  const v1: BackupFile = {
    format: BACKUP_FORMAT,
    version: 1,
    appVersion: '0.0.1',
    exportedAt: new Date(0).toISOString(),
    sections: {
      channels: { schema: 1, rev: 1, updatedAt: 1, data: { channels: [] } },
    },
    checksum: computeBackupChecksum(1, {
      channels: { schema: 1, rev: 1, updatedAt: 1, data: { channels: [] } },
    }),
  };
  const parsedV1 = parseFullBackup(serializeBackup(v1));
  check(parsedV1.ok, 'v1 备份可解析', parsedV1.ok ? undefined : parsedV1.errors);
  if (parsedV1.ok) {
    eq(parsedV1.backup.version, 1, 'v1 版本号保留');
    eq(Object.keys(parsedV1.backup.sections), ['channels'], 'v1 分区保留');
  }

  // v2：含数据分区
  const v2: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion: '0.0.1',
    exportedAt: new Date().toISOString(),
    sections: {
      channels: { schema: 1, rev: 1, updatedAt: 1, data: { channels: [] } },
      skills: { schema: 1, rev: 0, updatedAt: 2, data: { custom: [sampleSkill], toggles: {} } },
    },
    checksum: computeBackupChecksum(BACKUP_VERSION, {
      channels: { schema: 1, rev: 1, updatedAt: 1, data: { channels: [] } },
      skills: { schema: 1, rev: 0, updatedAt: 2, data: { custom: [sampleSkill], toggles: {} } },
    }),
  };
  const parsedV2 = parseFullBackup(serializeBackupCompact(v2));
  check(parsedV2.ok, 'v2 备份可解析', parsedV2.ok ? undefined : parsedV2.errors);
  if (parsedV2.ok) {
    eq(Object.keys(parsedV2.backup.sections).sort(), ['channels', 'skills'], 'v2 分区保留');
  }

  // 校验和不匹配
  const tampered = serializeBackupCompact({ ...v2, checksum: 'deadbeef' });
  const bad = parseFullBackup(tampered);
  check(!bad.ok && bad.errors.includes('checksum'), '校验和不匹配被拒绝', bad.ok ? 'parsed' : bad.errors);

  // 未来版本
  const future = parseFullBackup(
    serializeBackupCompact({
      ...v2,
      version: BACKUP_VERSION + 1,
      checksum: computeBackupChecksum(BACKUP_VERSION + 1, v2.sections),
    }),
  );
  check(!future.ok && future.errors.includes('future-version'), '未来版本被拒绝', future.ok ? 'parsed' : future.errors);

  // 未知分区 → 告警但不失败
  const withUnknown = {
    ...v2,
    sections: { ...v2.sections, mystery: { schema: 1, rev: 0, updatedAt: 0, data: { a: 1 } } },
  };
  const unknown = parseFullBackup(
    serializeBackupCompact({
      ...withUnknown,
      checksum: computeBackupChecksum(BACKUP_VERSION, withUnknown.sections),
    }),
  );
  check(unknown.ok, '未知分区不导致解析失败', unknown.ok ? undefined : unknown.errors);
  if (unknown.ok) {
    check(
      unknown.warnings.some(w => w.includes('mystery')),
      '未知分区产生告警',
      unknown.warnings,
    );
  }

  // 非 JSON
  const notJson = parseFullBackup('{oops');
  check(!notJson.ok && notJson.errors.includes('not-json'), '非 JSON 被拒绝');
}

// ==================== 2. 分区处理器 ====================

async function testSectionHandlers(): Promise<void> {
  const deps = makeDeps();
  const handlers = createDataSectionHandlers(deps);
  eq(
    handlers.map(h => h.id),
    [...DATA_SECTION_ORDER],
    '处理器注册表顺序与 DATA_SECTION_ORDER 一致',
  );
  check(
    handlers.filter(h => h.media).map(h => h.id).sort().join(',') === 'capturedFiles,images',
    '媒体门控分区为 images + capturedFiles',
  );

  const skills = handlers.find(h => h.id === 'skills');
  const agents = handlers.find(h => h.id === 'agents');
  check(!!skills && !!agents, '技能 / 智能体处理器存在');
  if (!skills || !agents) return;

  // 空存储 → collect 返回 null（分区不进备份）
  eq(await skills.collect(), null, '空存储的技能分区不产出数据');

  // 有数据 → collect 产出规范载荷
  await deps.area.set({ [SKILLS_STORAGE_KEY]: [sampleSkill] });
  await deps.area.set({ [SKILL_TOGGLES_STORAGE_KEY]: { 'preset-a': false } });
  const collected = (await skills.collect()) as { custom: unknown[]; toggles: Record<string, boolean> };
  eq(collected.custom.length, 1, '技能采集条数正确');
  eq(collected.toggles, { 'preset-a': false }, '技能启停覆盖采集正确');
  check(skills.validate(collected), '合法技能载荷通过校验');
  check(!skills.validate({ custom: 'nope' }), '非法技能载荷被拒绝');
  check(!skills.validate({ custom: [{ name: 'no id' }], toggles: {} }), '缺少 id 的技能被拒绝');
  check(!skills.validate({ custom: [], toggles: { a: 'yes' } }), '非布尔启停值被拒绝');

  // apply(replace) → chrome 权威源 + localStorage 镜像双写
  const outcome = await skills.apply(collected, 'replace');
  check(!('skipped' in outcome), 'replace 策略不跳过');
  const chromeValue = await deps.area.get([SKILLS_STORAGE_KEY]);
  eq((chromeValue[SKILLS_STORAGE_KEY] as unknown[]).length, 1, 'replace 后 chrome 写入技能');
  const localValue = deps.localStore.getItem(SKILLS_STORAGE_KEY);
  eq(localValue, null, 'Skill 仅写入权威存储，不创建重复镜像');

  // apply(fill) → 本机已有数据 → 跳过
  const fillOutcome = await skills.apply(collected, 'fill');
  check('skipped' in fillOutcome, 'fill 策略在本机已有数据时跳过');
  if ('skipped' in fillOutcome) {
    eq(fillOutcome.reason, 'already-configured', '跳过原因正确');
  }

  // apply(fill) → 本机无数据 → 写入
  const emptyDeps = makeDeps();
  const emptySkills = createDataSectionHandlers(emptyDeps).find(h => h.id === 'skills');
  check(!!emptySkills, '空环境下的技能处理器存在');
  if (emptySkills) {
    const emptyOutcome = await emptySkills.apply(collected, 'fill');
    check(!('skipped' in emptyOutcome), 'fill 策略在本机无数据时写入');
    const stored = await emptyDeps.area.get([SKILLS_STORAGE_KEY]);
    eq((stored[SKILLS_STORAGE_KEY] as unknown[]).length, 1, 'fill 写入成功');
  }

  // 写入失败 → 分区自身状态不变（原子性）
  const failDeps = makeDeps();
  await failDeps.area.set({ [SKILLS_STORAGE_KEY]: [sampleSkill] });
  failDeps.area.failKeys.add(SKILLS_STORAGE_KEY);
  const failHandler = createDataSectionHandlers(failDeps).find(h => h.id === 'skills');
  check(!!failHandler, '故障环境下的技能处理器存在');
  if (failHandler) {
    await expectThrows(
      () => failHandler.apply({ custom: [], toggles: {} }, 'replace'),
      '写入失败时抛出错误',
    );
    const after = await failDeps.area.get([SKILLS_STORAGE_KEY]);
    eq((after[SKILLS_STORAGE_KEY] as unknown[]).length, 1, '写入失败后分区状态未变（原子）');
  }

  // 智能体分区
  await deps.area.set({ [AGENTS_STORAGE_KEY]: [sampleAgent] });
  const agentPayload = await agents.collect();
  check(!!agentPayload, '智能体分区采集到数据');
  check(agents.validate(agentPayload), '合法智能体载荷通过校验');
  check(!agents.validate({ custom: [{ name: '缺少 id' }] }), '缺少 id 的智能体被拒绝');

  // 计划分区：载荷形状必须是对象
  const plans = handlers.find(h => h.id === 'plans');
  check(!!plans, '计划处理器存在');
  if (plans) {
    check(!plans.validate({ payload: 123 }), '非对象计划载荷被拒绝');
    await deps.area.set({ [PLANS_STORAGE_KEY]: { v: 1, sessions: {}, dropped: {} } });
    const planPayload = await plans.collect();
    check(!!planPayload, '计划分区采集到数据');
    check(plans.validate(planPayload), '合法计划载荷通过校验');
  }
}

// ==================== 3. 编排器 ====================

async function testOrchestrator(): Promise<void> {
  const area = new MemoryArea();
  const local = new MemoryLocalStore();
  const deps = makeDeps(area, local);
  const engine = new ConfigEngine({ area, localStore: local });

  // 预置：配置域 + 技能
  await area.set({ agent_nexus_channels: { channels: [{ id: 'c1' }] } });
  await area.set({ [SKILLS_STORAGE_KEY]: [sampleSkill] });

  const built = await buildFullBackup({ engine, deps, includeSecrets: true, includeMedia: true });
  check(built.sectionIds.includes('channels'), '导出包含配置分区', built.sectionIds);
  check(built.sectionIds.includes('skills'), '导出包含技能分区', built.sectionIds);
  check(
    built.sectionIds.includes('workflows') === false,
    '无数据的分区不进备份',
    built.sectionIds,
  );
  // IndexedDB 在 Node 下不可用 → 相关分区采集失败并记入 issues（不静默）
  check(
    built.issues.length > 0,
    '采集失败的分区被记录为 issue（不静默）',
    built.issues,
  );

  const parsed = parseFullBackup(serializeBackupCompact(built.backup));
  check(parsed.ok, '导出的备份可被解析回来', parsed.ok ? undefined : parsed.errors);

  // 全量校验：任一分区非法 → 零写入
  const invalid = parseFullBackup(
    serializeBackupCompact({
      ...built.backup,
      sections: {
        ...built.backup.sections,
        skills: { schema: 1, rev: 0, updatedAt: 0, data: { custom: 'not-an-array', toggles: {} } },
      },
      checksum: computeBackupChecksum(BACKUP_VERSION, {
        ...built.backup.sections,
        skills: { schema: 1, rev: 0, updatedAt: 0, data: { custom: 'not-an-array', toggles: {} } },
      }),
    }),
  );
  check(invalid.ok, '构造的非法备份可解析（结构合法、内容非法）', invalid.ok ? undefined : invalid.errors);
  if (invalid.ok) {
    const before = area.store.size;
    const report = await applyFullBackup(invalid.backup, 'replace', { engine, deps });
    eq(report.errors.length, 1, '非法分区被拒绝');
    eq(report.applied.length, 0, '非法分区导致零写入');
    eq(area.store.size, before, '零写入：存储未被改动');
  }

  // 正常导入（replace）
  if (parsed.ok) {
    await area.set({ [SKILLS_STORAGE_KEY]: [] });
    const report = await applyFullBackup(parsed.backup, 'replace', { engine, deps });
    check(report.errors.length === 0, '正常导入无错误', report.errors);
    check(report.applied.includes('skills'), '正常导入写入技能分区', report.applied);
    const restored = await area.get([SKILLS_STORAGE_KEY]);
    eq((restored[SKILLS_STORAGE_KEY] as unknown[]).length, 1, '导入后技能恢复');
  }

  // 回滚：配置分区写入成功 → 数据分区写入失败 → 配置分区被还原
  const rollbackArea = new MemoryArea();
  const rollbackLocal = new MemoryLocalStore();
  const rollbackDeps = makeDeps(rollbackArea, rollbackLocal);
  const rollbackEngine = new ConfigEngine({ area: rollbackArea, localStore: rollbackLocal });
  await rollbackArea.set({ agent_nexus_channels: { channels: [{ id: 'c1' }] } });
  await rollbackArea.set({ [SKILLS_STORAGE_KEY]: [sampleSkill] });
  const built2 = await buildFullBackup({ engine: rollbackEngine, deps: rollbackDeps });
  const parsed2 = parseFullBackup(serializeBackupCompact(built2.backup));
  check(parsed2.ok, '回滚场景的备份可解析');
  if (parsed2.ok) {
    check(
      Object.keys(parsed2.backup.sections).includes('skills'),
      '回滚场景的备份含技能分区',
      Object.keys(parsed2.backup.sections),
    );
    const preSection = await rollbackEngine.readSection('channels');
    rollbackArea.failKeys.add(SKILLS_STORAGE_KEY);
    const report = await applyFullBackup(parsed2.backup, 'replace', {
      engine: rollbackEngine,
      deps: rollbackDeps,
    });
    check(report.errors.length > 0, '数据分区失败被记录', report.errors);
    eq(report.applied.length, 0, '失败后已写分区清空');
    check(report.rolledBack, '回滚被标记为成功');
    const postSection = await rollbackEngine.readSection('channels');
    eq(postSection?.data, preSection?.data, '回滚后配置分区还原为导入前状态');
  }
}

// ==================== 4. 存储统计 ====================

async function testStorageStats(): Promise<void> {
  const area = new MemoryArea();
  const local = new MemoryLocalStore();

  await area.set({ agentNexusCustomSkills: [sampleSkill] });
  await area.set({ 'some_unknown_key': { padding: 'x'.repeat(100) } });
  await area.set({ browserUuid: 'uuid-1234' });
  await local.setItem('agentNexusCustomSkills', JSON.stringify([sampleSkill]));
  await local.setItem('notes-theme', 'dark');
  await local.setItem('unclassified-local', 'y'.repeat(50));

  const report = await collectStorageReport({
    area,
    localStore: local,
    idb: null,
    includeIdb: false,
  });

  const byId = new Map(report.categories.map(c => [c.id, c] as const));
  const skills = byId.get('skills');
  const other = byId.get('other');
  const misc = byId.get('misc');
  check(!!skills && !!other && !!misc, '关键分类存在');

  check(skills!.bytes > 0, '技能分类有占用', skills?.bytes);
  check(other!.bytes > 0, '未分类键计入「其他」', other?.bytes);
  check(misc!.bytes > 0, '杂项分类有占用', misc?.bytes);

  // 分类合计 == 合计（不缺数）
  const sum = report.categories.reduce((acc, c) => acc + Math.max(0, c.bytes), 0);
  eq(sum, report.totalBytes, '分类合计恒等于合计占用');

  // 占比之和约等于 1
  const shareSum = report.categories.reduce((acc, c) => acc + c.share, 0);
  check(Math.abs(shareSum - 1) < 0.02, '占比之和约为 1', shareSum);

  // 子项：技能分类含「自定义技能」
  const skillChildren = skills?.children ?? [];
  check(
    skillChildren.some(c => c.id === 'custom'),
    '技能分类含「自定义技能」子项',
    skillChildren.map(c => c.id),
  );

  // 统计失败 → -1（而不是 0）
  const failed = await collectStorageReport({
    area: null,
    localStore: null,
    idb: null,
    includeIdb: false,
  });
  eq(failed.chromeBytes, -1, '不可用的存储面报为 -1');
  eq(failed.localBytes, -1, '不可用的本地存储报为 -1');
  check(failed.issues.length > 0, '不可用的存储面产生说明', failed.issues);

  // 对话媒体构成：无可用数据时为 -1（而不是伪造 0）
  eq(failed.conversationMedia.textBytes, -1, '对话文字统计失败报为 -1');
  eq(failed.conversationMedia.mediaBytes, -1, '对话媒体统计失败报为 -1');
}

async function testSkillLifecycleBackup(): Promise<void> {
  const area=new MemoryArea(), local=new MemoryLocalStore(), handler=createDataSectionHandlers({area,localStore:local}).find(item=>item.id==='skills')!;
  const lifecycle={agentNexusAgentSkillLinks:{default:['1001']},agentNexusManagedPluginSkills:{ref:{id:'1001',acceptedDigest:'one',pending:{digest:'two'}}},'agentNexusManagedPluginSkills:packages':['plugin'],agentNexusSkillCaptureHidden:true};
  const data={custom:[{...sampleSkill,id:'1001'}],toggles:{'3':false},lifecycle};
  check(handler.validate(data),'Skill lifecycle backup validates');
  const result=await handler.apply(data,'replace');
  eq(await handler.collect(),data,'Skill lifecycle, pending approvals and hidden preference round trip');
  eq((await area.get([SKILL_TOGGLES_STORAGE_KEY]))[SKILL_TOGGLES_STORAGE_KEY],{'3':false},'Restore preserves builtin toggles');
  if ('rollback' in result) await result.rollback?.();
  eq(await handler.collect(),null,'Rollback removes all lifecycle state atomically');
  check(!handler.validate({...data,lifecycle:{unknown:'bad'}}),'Unknown lifecycle backup keys rejected');
}

// ==================== 主流程 ====================

async function main(): Promise<void> {
  await testFormat();
  await testSectionHandlers();
  await testOrchestrator();
  await testStorageStats();
  await testSkillLifecycleBackup();

  console.log(`\n[backup] 通过 ${passed} 项`);
  if (failures.length) {
    console.error(`[backup] 失败 ${failures.length} 项：`);
    for (const item of failures) console.error(`  ✗ ${item}`);
    process.exit(1);
  }
  console.log('[backup] 全部通过');
}

main().catch(error => {
  console.error('[backup] 运行失败:', errText(error));
  process.exit(1);
});
